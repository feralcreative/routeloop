// Proposing a meeting point, over HTTP.
//
// The whole press is `proposeMeetingPoints()` in src/subgroups/propose.ts, which the
// planning assistant's propose_meeting_points calls too, so the two cannot drift.
// This file's only job is to read the stored ride into the payload shape that
// service takes, and to answer with exactly what the builder's panel reads.
//
// BUILT FROM THE ROWS, NOT FROM loadRidePayload(). That function reads every route's
// points and legs one query at a time and joins the owner's private stop details,
// none of which a meeting point needs; three queries over the ride's active routes
// are what this always ran. Each point carries its stored `dist_from_start_m`, so a
// trackless import's null is still skipped by the fuel walk exactly as before.
//
// WHO MAY ASK is anybody who may edit the ride, the same trust as moving a stop.
//
// A POST rather than a GET although it reads and writes nothing: it is behind
// requireSameOrigin like every other write-shaped call in the builder, and a GET
// would be cached by something.
import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/index'
import { routes as routesTable, points as pointsTable, routeLegs, userProfiles } from '../db/schema'
import { currentUser, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { editableRide } from './builder'
import { clampDivert, fuelRoleOf } from '../subgroups/rendezvous'
import { proposeMeetingPoints, type MeetRide } from '../subgroups/propose'
import { subgroupsOf } from '../subgroups/service'
import { activeRoutes } from '../maps/alts'
import type { Track } from '../maps/kml'
import { groupRange } from '../bikes/group-range'
import { parseTerms } from '../places/ranking'
import { placeListsFor } from '../views/prefs'

export const rendezvousRoutes = new Hono<AuthEnv>()

rendezvousRoutes.post('/api/rides/:id/rendezvous', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  // ANY RIDER WHO MAY EDIT, not only an owner (2026-11-01): the builder shows the
  // button to an edit-level rider, choosing a meeting point is route editing, and
  // nothing in the answer is owner-only. It was the owner-only gate, so they got a 404.
  const ride = await editableRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)

  // HOW MUCH FURTHER OUT OF THEIR WAY THAN NECESSARY A JOINING GROUP MAY BE SENT.
  // THE PRESS WINS, THEN THE RIDER'S PREFERENCE, THEN THE APP'S DEFAULT. The builder
  // sends the dial on every press, seeded from the preference, so the second step is
  // for a client that sends nothing.
  //
  // CLAMPED RATHER THAN REFUSED WITH A 400: the only ways to reach this with a bad
  // value are a typo in a number box and a hand-written request. Anything unparseable
  // comes back undefined, which the proposer treats as "use the default".
  const body = (await c.req.json().catch(() => ({}))) as { maxDivertMi?: unknown }
  const [prof] = await db
    .select({ meetDivertMi: userProfiles.meetDivertMi, power: userProfiles.power, vehicle: userProfiles.vehicle })
    .from(userProfiles)
    .where(eq(userProfiles.userId, user.id))
    .limit(1)
  // THE RIDER'S PLACE LISTS RIDE ALONG AS A NUDGE — see RendezvousOptions. Parsed once
  // and handed to both passes and the road re-rank, so the three cannot disagree.
  const lists = await placeListsFor(c)

  const groups = await subgroupsOf(ride.id)
  // One group has nobody to meet. Answered before any other read.
  if (groups.length < 2) return c.json({ candidates: [], reason: 'one-group' })

  const all = activeRoutes(
    await db.select().from(routesTable).where(eq(routesTable.rideId, ride.id)).orderBy(routesTable.position),
  )
  const routeIds = all.map((d) => d.id)
  if (routeIds.length === 0) return c.json({ candidates: [], reason: 'no-routes' })

  // Every leg and every point in the ride, once each. ONE QUERY rather than one per
  // route: a group's strand includes the shared routes, and the old per-group reads
  // fetched the same route several times.
  const legs = await db
    .select({ routeId: routeLegs.routeId, geometry: routeLegs.geometry, distanceM: routeLegs.distanceM })
    .from(routeLegs)
    .where(inArray(routeLegs.routeId, routeIds))
    .orderBy(routeLegs.position)
  const pts = await db
    .select({
      routeId: pointsTable.routeId,
      lat: pointsTable.lat,
      lng: pointsTable.lng,
      roles: pointsTable.roles,
      distFromStartM: pointsTable.distFromStartM,
    })
    .from(pointsTable)
    .where(inArray(pointsTable.routeId, routeIds))
    .orderBy(pointsTable.position)

  const uidOf = new Map(groups.map((g) => [g.id, g.uid]))
  const input: MeetRide = {
    subgroups: groups.map((g) => ({ uid: g.uid, name: g.name })),
    primarySubgroup: ride.primarySubgroupId ? (uidOf.get(ride.primarySubgroupId) ?? null) : null,
    routes: all.map((r) => ({
      subgroupUid: r.subgroupId ? (uidOf.get(r.subgroupId) ?? null) : null,
      // Already filtered to the active routes above.
      altGroup: null,
      altActive: true,
      points: pts
        .filter((p) => p.routeId === r.id)
        .map((p) => ({ lat: p.lat, lng: p.lng, roles: p.roles, distFromStartM: p.distFromStartM })),
      legs: legs
        .filter((l) => l.routeId === r.id)
        .map((l) => ({ geometry: l.geometry as Track, distanceM: l.distanceM })),
    })),
  }

  const out = await proposeMeetingPoints(input, {
    maxDivertMi: clampDivert(body.maxDivertMi) ?? clampDivert(prof?.meetDivertMi),
    favor: parseTerms(lists.favor),
    avoid: parseTerms(lists.avoid),
    // Read only once the service knows the ride is answerable, as it always was: a
    // refusal costs no roster read. The range is `groupRange()`'s, the SHORTEST tank on
    // the planning roster; NULL MEANS NOTHING IS KNOWN and the check does not run.
    fuel: async () => {
      const range = await groupRange(ride.id, { planning: true })
      return {
        role: fuelRoleOf({
          ridePower: ride.power,
          rideVehicle: ride.vehicle,
          bikeFuel: range.fuelType,
          profilePower: prof?.power,
          profileVehicle: prof?.vehicle,
        }),
        rangeMi: range.miles,
      }
    },
  })
  if (!out.ok) {
    return c.json(
      out.group !== undefined
        ? { candidates: [], reason: out.reason, group: out.group }
        : { candidates: [], reason: out.reason },
    )
  }
  return c.json({ groups: out.groups.map((g) => g.proposal) })
})
