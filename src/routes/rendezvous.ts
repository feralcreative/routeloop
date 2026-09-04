// Proposing a meeting point, over HTTP.
//
// The whole computation is `src/subgroups/rendezvous.ts`, which is pure and
// calls no router. This file's only job is to work out WHICH trunk and WHICH
// origin to hand it, from a ride that is being edited.
//
// A POST rather than a GET although it reads and writes nothing, and that is
// deliberate: it takes a body, it is behind requireSameOrigin like every other
// write-shaped call in the builder, and a GET would be cached by something.
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db/index'
import { days as daysTable, points as pointsTable, routeLegs } from '../db/schema'
import { currentUser, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { ownRide } from './maps'
import { proposeRendezvous, divertMi, type FuelCandidate } from '../subgroups/rendezvous'
import { subgroupsOf } from '../subgroups/service'
import { trunkDaysFor } from '../subgroups/policy'
import { activeDays } from '../maps/alts'
import type { Track } from '../maps/kml'

export const rendezvousRoutes = new Hono<AuthEnv>()

rendezvousRoutes.post('/api/rides/:id/rendezvous', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)

  const body = (await c.req.json().catch(() => null)) as { group?: unknown } | null
  const wanted = typeof body?.group === 'string' ? body.group : ''
  const groups = await subgroupsOf(ride.id)
  const group = groups.find((g) => g.uid === wanted)
  if (!group) return c.json({ error: 'unknown group' }, 400)

  const all = activeDays(
    await db.select().from(daysTable).where(eq(daysTable.rideId, ride.id)).orderBy(daysTable.position),
  )

  // THE TRUNK IS THE SHARED DAYS, and where there are none it is the days of the
  // group the planner named as the one everybody joins — #239, and the first
  // thing ever to read `rides.trunk_subgroup_id`. The rule is `trunkDaysFor` in
  // ../subgroups/policy.ts, where it is testable with no database; this file
  // only says which ride and which group.
  const { days: trunkDays, reason: noTrunk } = trunkDaysFor(all, group.id, ride.trunkSubgroupId)
  if (noTrunk) return c.json({ candidates: [], reason: noTrunk })

  const trunk: Track = []
  for (const d of trunkDays) {
    const legs = await db
      .select({ geometry: routeLegs.geometry })
      .from(routeLegs)
      .where(eq(routeLegs.dayId, d.id))
      .orderBy(routeLegs.position)
    for (const l of legs) {
      for (const v of l.geometry as Track) {
        // Drop the duplicate vertex at every joint, the same way the viewer's
        // per-day concat does — a repeated point is a zero-length segment that
        // makes the bearing at that vertex undefined.
        const last = trunk[trunk.length - 1]
        if (!last || last[0] !== v[0] || last[1] !== v[1]) trunk.push(v)
      }
    }
  }

  // WHERE THE JOINING GROUP STARTS: the first point of their first day. Not
  // their home addresses — this proposes against the ride as planned, and the
  // rider may not have put anybody in the group yet.
  const ownDays = all.filter((d) => d.subgroupId === group.id)
  if (ownDays.length === 0) return c.json({ candidates: [], reason: 'no-days' })
  const [origin] = await db
    .select({ lat: pointsTable.lat, lng: pointsTable.lng })
    .from(pointsTable)
    .where(eq(pointsTable.dayId, ownDays[0].id))
    .orderBy(pointsTable.position)
    .limit(1)
  if (!origin) return c.json({ candidates: [], reason: 'no-days' })

  // Existing fuel stops anywhere on the trunk, as extra candidates. #67's thumb
  // on the scale: a fuel stop is where a group wants to regather anyway.
  const fuel: FuelCandidate[] = []
  for (const d of trunkDays) {
    const pts = await db
      .select({ lat: pointsTable.lat, lng: pointsTable.lng, roles: pointsTable.roles })
      .from(pointsTable)
      .where(eq(pointsTable.dayId, d.id))
    for (const p of pts) fuel.push({ at: [p.lng, p.lat], roles: p.roles })
  }

  const candidates = proposeRendezvous(trunk, [origin.lng, origin.lat], fuel)
  return c.json({
    candidates: candidates.map((r) => ({
      lng: r.at[0],
      lat: r.at[1],
      // Miles, rounded, because that is the only number a planner should read.
      // `score` is deliberately not sent: it is unitless and putting one in
      // front of somebody invites them to compare two of them.
      divertMi: divertMi(r),
      approachDeg: Math.round(r.approachDeg),
      isFuel: r.isFuel,
      sharedPct: Math.round(r.sharedFraction * 100),
    })),
    reason: candidates.length === 0 ? 'none-viable' : null,
  })
})
