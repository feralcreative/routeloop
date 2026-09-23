// The ride builder's API and page shells. A ride payload is the full graph —
// ride meta + routes + stops/POIs + routed legs — saved whole (PUT is a
// full-replace inside one transaction).
import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { mergeRoutes, storedUidsNeeded, type MergeResult } from '../maps/route-merge'
import { publish } from '../live/hub'
import { db } from '../db/index'
import {
  rides,
  routes as routesTable,
  points as pointsTable,
  routeLegs,
  userProfiles,
  type RidePerm,
  type RideRow,
  type UserRow,
} from '../db/schema'
import { currentUser, requireActive, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { METERS_PER_MILE, distFromStartAlongTrack, sanitizeText, trackMeters, type Track } from '../maps/kml'
import { toDurationFormat, type DurationFormat } from '../maps/duration'
import { ROUTE_COLORS } from '../maps/palette'
import { detailsForViewer } from '../maps/point-details'
import { MAX_ROLES_PER_POINT, ROLES, ROLE_META } from '../maps/roles'
import { twistiness } from '../maps/twist'
import { faqLink, googleMapsLoader, page, panelShell, rideTimeline, wordsOf } from '../views/layout'
import { TRASH_HOLD_DAYS } from '../trash/policy'
import { asset } from '../views/assets'
import { esc } from '../views/esc'
import { POWERS, POWER_CHOICES, VEHICLES, VEHICLE_CHOICES, Wd, Wds, aWd, cap, wd } from '../views/vocab'
import { TOUR_HEAD, tourScript } from '../views/tour-assets'
import { GMAPS_KEY, GMAPS_MAP_ID } from '../config'
import { generateSlug } from '../maps/slug'
import { canClone } from '../access/policy'
import { memberOrOwner, seedOwner } from '../members/service'
import { seedMainGroup } from '../subgroups/service'
import {
  canAdminister,
  canEditAsMember,
  canViewAsMember,
  DEFAULT_PERM,
  PERM_LABELS,
  type MemberFields,
} from '../members/policy'
import { subgroupsOf } from '../subgroups/service'
import { clampDivert, DEFAULT_DIVERT_MI, MAX_DIVERT_MI, MIN_DIVERT_MI } from '../subgroups/rendezvous'
import { groupRange, ownRange, type GroupRange } from '../bikes/group-range'
import { grantsFor } from '../access/query'
import { fields, firstIssue } from '../maps/fields'
import { LIVE_RIDE } from '../trash/service'
import {
  MAX_ROUTES,
  MAX_STOPS,
  insertRideGraph,
  normalize,
  ridePayload,
  rideTotals,
  type RidePayload,
} from '../maps/ride-graph'
import { type Units, toUnits } from '../views/units'

export const builderRoutes = new Hono<AuthEnv>()

// A native ride is DB rows, not files — caps bound the rows since byte quota
// does not apply. 8 MB JSON backstop over the structural caps.
const BODY_LIMIT = 8 * 1024 * 1024
/**
 * `rev` RIDES ALONGSIDE THE PAYLOAD RATHER THAN INSIDE IT. `ridePayload` is
 * shared with the native JSON import — a file on disk, which has no opinion
 * about who else is editing — and Zod strips unknown keys, so a token declared
 * there would appear wired and check nothing.
 *
 * Optional, and not laziness: during the blue/green overlap the OLD builder
 * posts no `rev` at all, and requiring it would refuse every one of those saves.
 */
const revField = z.coerce.number().int().nonnegative().optional()

/** Every route uid the client held when it loaded, and the hash it saw. The WHOLE
 *  set, not a field on each route it still has — a route the rider deleted is
 *  absent from the payload and would carry nothing, which is precisely the case
 *  mergeRoutes has to tell apart from a route somebody else added. */
const baseField = z.record(z.string().max(12), z.string().max(32)).optional()

async function parseRideBody(
  c: Context<AuthEnv>,
): Promise<
  { data: RidePayload; rev?: number; base?: Record<string, string>; error?: never } | { data?: never; error: string }
> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return { error: 'invalid JSON body' }
  }
  const parsed = ridePayload.safeParse(raw)
  if (!parsed.success) return { error: firstIssue(parsed.error) }
  normalize(parsed.data)
  const rev = revField.safeParse((raw as { rev?: unknown } | null)?.rev)
  const base = baseField.safeParse((raw as { routeBase?: unknown } | null)?.routeBase)
  return {
    data: parsed.data,
    rev: rev.success ? rev.data : undefined,
    base: base.success ? base.data : undefined,
  }
}

// --- API -------------------------------------------------------------------

const jsonLimit = bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: 'payload too large' }, 413) })

// **THERE IS DELIBERATELY NO TURNSTILE GATE HERE, AND THE ONE THAT USED TO BE
// WAS A LANDMINE** (#132). It checked an `X-Turnstile-Token` header that NOTHING
// SENDS, while `turnstileEnabled()` is one flag over the whole app — so setting
// `TURNSTILE_SECRET_KEY` to arm the upload pipeline would have made "Plan a ride"
// 403 for everybody.
//
// Removed rather than fixed, because Turnstile answers "is this a human" and this
// route already asks harder: `requireActiveApi` means an approved account and
// `requireSameOrigin` means the request came from the site. The import path is the
// one that earns a gate — it opens files strangers hand it — and it keeps its own.
//
// If a bot check is ever wanted here the answer is rate limiting (#16), not a
// widget: a token is single-use and expires in five minutes, so it cannot ride on
// an autosave that fires every three seconds.
builderRoutes.post('/api/rides', requireActiveApi, requireSameOrigin, jsonLimit, async (c) => {
  const user = currentUser(c)

  const body = await parseRideBody(c)
  if (!body.data) return c.json({ error: body.error }, 400)
  const p = body.data

  const created = await db.transaction(async (tx) => {
    const [ride] = await tx
      .insert(rides)
      .values({
        ownerId: user.id,
        slug: generateSlug(),
        title: p.title,
        description: p.description || null,
        visibility: p.visibility,
        source: 'native',
        externalUrl: p.external_url || null,
        ...rideTotals(p),
      })
      .returning()
    await insertRideGraph(tx, ride.id, p)
    // In the SAME transaction as the ride, so a ride never exists with an empty
    // roster — see seedOwner.
    await seedOwner(tx, ride.id, user.id)
    // AND ITS MAIN GROUP, in the same transaction: every ride has at least one group
    // and the builder seeds that one CLIENT-SIDE, so a ride made by any other path
    // arrived with none. It no-ops when the payload already brought one.
    await seedMainGroup(tx, ride.id)
    return ride
  })
  console.log(`[rides] user ${user.id} created ride ${created.id} (${created.stopCount} stops)`)
  return c.json({ id: created.id, slug: created.slug }, 201)
})

// Clone a public ride into the caller's account as a private draft, rebuilt
// through the same insertRideGraph the builder's save uses.
//
// Deliberately dropped: descriptions, on the ride and on every stop — those are
// the author's writing, and stop notes are where "gate code 4417" lives;
// visibility, so a clone lands private whatever the original was; and via points,
// which are shaping for a route the cloner will now edit.
builderRoutes.post('/api/rides/:id/clone', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not found' }, 404)

  const [src] = await db
    .select()
    .from(rides)
    .where(and(eq(rides.id, id), LIVE_RIDE))
    .limit(1)
  // canClone, not `visibility === 'public'` written out: two levels are clonable —
  // public, and friends by a friend — and which they are is src/access/policy.ts's
  // call, shared with the button on the viewer page. A button and a gate that
  // disagree is a Clone that 404s.
  if (!src || !canClone(src, user, await grantsFor(src, user))) {
    return c.json({ error: 'not found' }, 404)
  }

  const srcRoutes = await db
    .select()
    .from(routesTable)
    .where(eq(routesTable.rideId, src.id))
    .orderBy(routesTable.position)

  const payloadRoutes = []
  for (const r of srcRoutes) {
    const pts = await db.select().from(pointsTable).where(eq(pointsTable.routeId, r.id)).orderBy(pointsTable.position)
    const legs = await db.select().from(routeLegs).where(eq(routeLegs.routeId, r.id)).orderBy(routeLegs.position)

    const point = (p: (typeof pts)[number]) => ({
      lat: p.lat,
      lng: p.lng,
      name: p.name,
      // Public, and part of the route being cloned — unlike `details` below,
      // which is the private half and is dropped.
      address: p.address,
      description: '',
      roles: p.roles,
      // A clone gets FRESH identities and NO private details.
      //
      // `details: null` is a privacy boundary: a public ride is clonable by anyone,
      // and its author's confirmation numbers and gate codes are exactly what
      // point_details exists to keep off a stranger's screen.
      //
      // `uid: null` follows — the new ride mints its own, so nothing ties a cloned
      // stop back to the original's details row.
      uid: null,
      details: null,
    })

    payloadRoutes.push({
      // A clone has no subgroups: the cloner is one person taking a copy, and the
      // original's approaches are about people who are not on their ride.
      subgroupUid: null,
      // Fresh, as a cloned point's is: a clone must not inherit the original's votes,
      // and alt_votes is keyed by route uid.
      uid: null,
      title: r.title,
      color: r.color,
      // Times belong to the ride the author planned, not to whenever the cloner
      // rides it. The timeline re-derives from legs and stops either way.
      startAt: null,
      endAt: null,
      // Kept, unlike the times and the via-points above. "Here are two ways to do
      // Thursday" is the thing being cloned, and dropping it would hand the clone a
      // bigger mileage than the original, the losing alternates becoming ordinary
      // routes.
      altGroup: r.altGroup,
      altActive: r.altActive,
      // Kept for the same reason the alternate is: a route the author routed off the
      // interstate becomes a route on it the moment this is dropped, and the clone's
      // mileage would quietly disagree with the original's.
      routePrefs: r.routePrefs,
      // ONE ORDERED LIST, and the read above is already ordered by position. Both kinds
      // carry a duration, so a clone keeps the POI dwell too. slackMin comes across
      // with it: a property of the meeting point, not of who is riding to it.
      points: pts.map((p) => ({ ...point(p), kind: p.kind, durationMin: p.durationMin, slackMin: p.slackMin })),
      legs: legs.map((l) => ({
        geometry: l.geometry,
        distanceM: l.distanceM,
        durationS: l.durationS,
        viaPoints: [],
      })),
    })
  }

  const p: RidePayload = {
    title: src.title,
    description: '',
    visibility: 'private',
    external_url: '',
    // NO SUBGROUPS ON A CLONE, and therefore no anchors either: carrying them over
    // would give the cloner a converge-and-split shape with nobody in any group.
    subgroups: [],
    primarySubgroup: null,
    trunkSubgroup: null,
    stopByMin: null,
    // The vehicle comes across (#321): a clone of a car trip is a car trip. Coerced
    // on read, so a stored value the app no longer knows clones as null.
    vehicle: VEHICLES.includes(src.vehicle as never) ? (src.vehicle as RidePayload['vehicle']) : null,
    power: POWERS.includes(src.power as never) ? (src.power as RidePayload['power']) : null,
    timeAnchor: 'departure',
    routes: payloadRoutes,
  }

  const created = await db.transaction(async (tx) => {
    const [ride] = await tx
      .insert(rides)
      .values({
        ownerId: user.id,
        slug: generateSlug(),
        title: p.title,
        description: null,
        visibility: 'private',
        source: 'native',
        externalUrl: null,
        ...rideTotals(p),
      })
      .returning()
    await insertRideGraph(tx, ride.id, p)
    // The CLONER's roster, not the original's. A clone is a new ride owned by
    // whoever took it, and copying the source's members would put a stranger on
    // a ride they were never invited to.
    await seedOwner(tx, ride.id, user.id)
    // AND ITS MAIN GROUP, in the same transaction: every ride has at least one group
    // and the builder seeds that one CLIENT-SIDE. It no-ops when the payload already
    // brought one.
    await seedMainGroup(tx, ride.id)
    return ride
  })

  console.log(`[rides] user ${user.id} cloned ride ${src.id} -> ${created.id}`)
  return c.json({ id: created.id, slug: created.slug }, 201)
})

// THIS CHURNS EVERY POINT AND ROUTE ID, ON PURPOSE, AND THE BUILDER CALLS IT
// CONSTANTLY: the full replace below deletes the ride's routes — cascading to
// points and legs — and re-inserts them, and the autosave flushes on idle.
//
// That is safe TODAY for exactly one reason: nothing anywhere references a point
// across a save. The client payload carries no ids, the exports rebuild from the
// graph, and the roadbook reads it whole.
//
// **Any feature that needs a point to keep its identity has to fix this first**,
// and the fix is not small: send ids in the payload, diff here, and update in
// place, which rewrites insertRideGraph, ridePayload and loadRidePayload. Do not
// add the reference and hope; the failure is silent and looks like data that
// wandered off.
/**
 * The ride, plus the viewer's own roster row — what all three builder gates ask
 * about now that a ride is editable by somebody who does not own it.
 *
 * NOT `ownRide()`, which filters on `rides.owner_id` and is still correct for
 * every OWNER power. This resolves the ride first and asks the roster second.
 *
 * **The owner's row is synthesized if it is somehow missing** rather than being a
 * second permission rule beside canEditAsMember(). It should never fire, but the
 * cost of the invariant being wrong once is an owner locked out of their own ride.
 */
async function builderRide(
  userId: number,
  idParam: string,
): Promise<{ ride: RideRow; member: MemberFields | null } | undefined> {
  const id = Number(idParam)
  if (!Number.isInteger(id) || id <= 0) return undefined
  const [ride] = await db
    .select()
    .from(rides)
    .where(and(eq(rides.id, id), LIVE_RIDE))
    .limit(1)
  if (!ride) return undefined
  // ONE IMPLEMENTATION, shared with the viewer's builder link — see memberOrOwner.
  // Two copies of the synthesized owner row is how the link starts offering what
  // this gate refuses.
  return { ride, member: await memberOrOwner(ride, userId) }
}

builderRoutes.put('/api/rides/:id', requireActiveApi, requireSameOrigin, jsonLimit, async (c) => {
  const user = currentUser(c)
  const found = await builderRide(user.id, c.req.param('id'))
  // 404 rather than 403 for a rider who may see the ride but not write to it: a 403
  // confirms the ride exists to somebody holding a guessed id.
  if (!found || !canEditAsMember(found.member)) return c.json({ error: 'not found' }, 404)
  const { ride, member } = found
  const isOwner = canAdminister(member)

  const body = await parseRideBody(c)
  if (!body.data) return c.json({ error: body.error }, 400)
  const p = body.data
  const p_rev = body.rev
  const p_base = body.base

  // THE STALE-WRITE CHECK, AND IT HAS TO BE INSIDE THE TRANSACTION. Read-then-write
  // outside one is the race it exists to close: two saves both read rev 7, both find
  // it current, and both write. A missing `rev` means unchecked — see revField.
  const result = await db.transaction(async (tx) => {
    const [cur] = await tx.select({ rev: rides.rev }).from(rides).where(eq(rides.id, ride.id)).for('update')
    if (p_rev !== undefined && cur && cur.rev !== p_rev) return { stale: cur.rev }

    // THE PER-ROUTE MERGE, AND THE ORDER OF THESE THREE STEPS IS THE WHOLE THING.
    // The merged set has to be complete BEFORE insertRideGraph runs, because that
    // function reconciles votes, comments and point details against the uid set of
    // the payload it is given — hand it one rider's partial route list and it deletes
    // the other rider's votes and orphans their comments, silently.
    //
    // The lock above is what makes reading here safe.
    let merge: MergeResult | null = null
    if (p_base !== undefined) {
      const storedRoutes = await tx
        .select({ uid: routesTable.uid, hash: routesTable.contentHash })
        .from(routesTable)
        .where(eq(routesTable.rideId, ride.id))
      merge = mergeRoutes(
        storedRoutes,
        p.routes.map((d) => d.uid ?? ''),
        p_base,
      )
      const needed = storedUidsNeeded(merge)
      if (needed.length > 0) {
        // ONLY ON THE CONFLICT PATH, which is normally never taken. Reusing
        // loadRidePayload rather than writing a second route serializer is
        // deliberate: two of those would drift, and the drift would show up as
        // routes quietly losing fields when they lose a merge.
        //
        // The OWNER's payload, whoever is saving — details are stripped for a
        // non-owner and re-inserting a stripped route would delete them. The
        // non-owner save writes details in `preserve` mode for the same reason.
        const current = (await loadRidePayload(ride, { id: ride.ownerId })) as {
          routes: Array<Record<string, unknown>>
        }
        const byUid = new Map(current.routes.map((d) => [d.uid as string, d]))
        const sent = new Map(p.routes.map((d) => [d.uid ?? '', d]))
        p.routes = merge.decisions
          .map((dec) => (dec.take === 'incoming' ? sent.get(dec.uid) : byUid.get(dec.uid)))
          .filter(Boolean) as typeof p.routes
      } else {
        // Nothing contested. Reorder only, so a route another rider deleted is not
        // resurrected by this save.
        const sent = new Map(p.routes.map((d) => [d.uid ?? '', d]))
        p.routes = merge.decisions.map((dec) => sent.get(dec.uid)).filter(Boolean) as typeof p.routes
      }
    }
    const [written] = await tx
      .update(rides)
      .set({
        rev: sql`${rides.rev} + 1`,
        title: p.title,
        description: p.description || null,
        // VISIBILITY IS AN OWNER POWER AND THIS IS THE GATE. Edit means the
        // builder — routes, points, legs, alts — and not the decision about who
        // gets to see the thing. The field is ignored rather than refused,
        // because the payload is a whole-ride replace sent by an autosave: a
        // 400 here would block every save an editor made over a value they were
        // never shown a control for.
        ...(isOwner ? { visibility: p.visibility } : {}),
        externalUrl: p.external_url || null,
        ...rideTotals(p),
        updatedAt: new Date(),
      })
      .where(eq(rides.id, ride.id))
      // THE NEW REV COMES BACK FROM THE WRITE, never from arithmetic on what
      // this request read at the top. `ride.rev` was loaded before the lock, so
      // computing `+ 1` from it hands the client a number the row may not hold
      // — and the client sends it on the NEXT save, which then 409s against a
      // ride nobody else touched.
      .returning({ rev: rides.rev })
    // Full replace: routes cascade to points and legs.
    await tx.delete(routesTable).where(eq(routesTable.rideId, ride.id))
    // `preserve` for a non-owner — see DetailsMode in ride-graph.ts. Their
    // payload carries no details because they were never sent any, and a
    // reconciling write would read that as the rider clearing every one.
    await insertRideGraph(tx, ride.id, p, isOwner ? 'reconcile' : 'preserve')
    // Read back AFTER the write, so the client's next save is based on what is
    // actually stored rather than on what this request believed it wrote.
    const after = await tx
      .select({ uid: routesTable.uid, hash: routesTable.contentHash })
      .from(routesTable)
      .where(eq(routesTable.rideId, ride.id))
    return { rev: written.rev, merge, after }
  })

  // 409 CARRYING THE CURRENT STATE, so the builder can show what it collided
  // with rather than only that it did. The rider's own work is still in their
  // browser and untouched — nothing was written — which is the whole point of
  // refusing rather than merging at this level.
  if ('stale' in result) {
    return c.json({ error: 'stale', rev: result.stale, ride: await loadRidePayload(ride, isOwner ? user : null) }, 409)
  }
  // TELL THE ROOM WHAT CHANGED. Fire-and-forget and deliberately after the
  // transaction: a live notification is not worth failing a save for, and a
  // publish inside the transaction would announce a write that could still roll
  // back.
  //
  // `by` rather than excluding the saver's connections: a rider can have the
  // ride open in two tabs, and the second one needs telling as much as anybody
  // else. The client ignores events carrying its own rider id.
  publish(ride.id, 'routes', {
    by: user.id,
    rev: result.rev,
    routes: result.after.filter((d) => d.hash !== null).map((d) => ({ uid: d.uid, hash: d.hash })),
  })

  // routeBase goes straight back out so the builder can rebase without a reload:
  // without it the SECOND save of a session is based on hashes the first save
  // invalidated, and every route reads as contested.
  return c.json({
    id: ride.id,
    slug: ride.slug,
    rev: result.rev,
    routeBase: Object.fromEntries(result.after.filter((d) => d.hash !== null).map((d) => [d.uid, d.hash as string])),
    // Named so the rider can be told which of their routes did not land, rather
    // than watching them revert on the next render with no explanation.
    superseded: result.merge?.superseded ?? [],
    adopted: result.merge?.adopted ?? [],
  })
})

// Member load for the builder — the same shape PUT accepts, vias included. The
// gate is `view`, not `edit`: the read-only builder is what a view-, comment- or
// suggest-level rider gets.
// The route behind a change notice, with `view` as the floor for the same reason.
builderRoutes.get('/api/rides/:id/route/:uid', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const found = await builderRide(user.id, c.req.param('id'))
  if (!found || !canViewAsMember(found.member)) return c.json({ error: 'not found' }, 404)
  // detailsForViewer is owner-only and blind to visibility, so a non-owner's copy
  // of this route carries no confirmation numbers — the same boundary the ride GET
  // goes through, reached the same way rather than re-decided here.
  const route = await loadRoutePayload(found.ride, user, c.req.param('uid'))
  if (!route) return c.json({ error: 'not found' }, 404)
  return c.json({ route })
})

builderRoutes.get('/api/rides/:id', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const found = await builderRide(user.id, c.req.param('id'))
  if (!found || !canViewAsMember(found.member)) return c.json({ error: 'not found' }, 404)
  return c.json(await loadRidePayload(found.ride, user))
})

/**
 * ONE ROUTE, for a builder catching up on somebody else's save.
 *
 * A refetch of the whole ride is not viable at editing speed: the body limit is
 * 8 MB, the ceilings are 31 routes and 400 points, and leg geometry dominates, so
 * a save every three seconds would move megabytes per notice, per watcher.
 * Broadcasting the route over SSE has the same problem and would put a rider's
 * stop details into a channel every member is subscribed to.
 *
 * Built by picking out of loadRidePayload rather than by a query of its own: a
 * second route serializer would drift, and the drift would surface as routes
 * quietly losing fields only when they arrive over the live channel.
 */
export async function loadRoutePayload(ride: RideRow, viewer: { id: number } | null, uid: string) {
  const full = (await loadRidePayload(ride, viewer)) as { routes: Array<{ uid?: string }> }
  return full.routes.find((d) => d.uid === uid) ?? null
}

export async function loadRidePayload(ride: RideRow, viewer: { id: number } | null) {
  // NOT owner-only by construction any more. This used to reach detailsForOwner
  // directly, on the grounds that every caller arrived behind `ownRide()` — true
  // until #190 let an `edit`-level member load the same payload, and false in a way
  // that would have handed somebody else's confirmation numbers to every
  // collaborator.
  //
  // detailsForViewer() is the boundary and is owner-only and blind to visibility. A
  // non-owner gets an empty map, which is why a non-owner save writes point_details
  // in `preserve` mode.
  const details = await detailsForViewer(ride.id, ride.ownerId, viewer)
  const routeRows = await db
    .select()
    .from(routesTable)
    .where(eq(routesTable.rideId, ride.id))
    .orderBy(routesTable.position)
  // BY UID, both here and in the payload the client sends back — ids never
  // cross the wire, so `routes[].subgroupUid` needs the map to be resolvable on
  // the way out as well as on the way in.
  const groups = await subgroupsOf(ride.id)
  const uidOf = new Map(groups.map((g) => [g.id, g.uid]))
  const out = {
    id: ride.id,
    slug: ride.slug,
    // OUT AND STRAIGHT BACK ON THE NEXT SAVE, like every uid in this payload, and the
    // same class of failure if it is dropped: the PUT stops checking, silently, and
    // two riders are back to overwriting each other.
    rev: ride.rev,
    source: ride.source,
    title: ride.title,
    description: ride.description ?? '',
    visibility: ride.visibility,
    external_url: ride.externalUrl ?? '',
    subgroups: groups.map((g) => ({ uid: g.uid, name: g.name, color: g.color })),
    primarySubgroup: ride.primarySubgroupId ? (uidOf.get(ride.primarySubgroupId) ?? null) : null,
    trunkSubgroup: ride.trunkSubgroupId ? (uidOf.get(ride.trunkSubgroupId) ?? null) : null,
    stopByMin: ride.stopByMin,
    vehicle: ride.vehicle,
    power: ride.power,
    timeAnchor: ride.timeAnchor,
    routes: [] as unknown[],
  }
  for (const r of routeRows) {
    const pts = await db.select().from(pointsTable).where(eq(pointsTable.routeId, r.id)).orderBy(pointsTable.position)
    const legs = await db.select().from(routeLegs).where(eq(routeLegs.routeId, r.id)).orderBy(routeLegs.position)
    out.routes.push({
      // Out and straight back, like the uid below. Omitting it is how a rider's
      // whole subgroup assignment survives until they reload and is then gone.
      subgroupUid: r.subgroupId ? (uidOf.get(r.subgroupId) ?? null) : null,
      // The route's uid, out and straight back on the next save. Omit it and the save
      // mints a fresh one, uq_route_ride_uid is satisfied, and every vote cast on that
      // alternate is reconciled away as belonging to a route that no longer exists.
      uid: r.uid,
      // VERBATIM FROM THE COLUMN, NEVER RECOMPUTED HERE. routeRevision() runs in one
      // place — the write, in insertRideGraph — and this hands back what it stored.
      // Recomputing would mean the write shape and this read shape had to stay
      // identical forever, and the first drift would make every route conflict with
      // itself on every save, with nothing to point at.
      //
      // Null for a route written before the column existed; mergeRoutes() reads that
      // as unknown and takes the client's version.
      contentHash: r.contentHash,
      title: r.title,
      color: r.color,
      startAt: r.startAt?.toISOString() ?? null,
      endAt: r.endAt?.toISOString() ?? null,
      // Omitting these is how a saved alternate grouping silently disappears on the
      // next page load, with the ride's mileage jumping at the same time. This
      // function names every field it carries; nothing is spread.
      altGroup: r.altGroup,
      altActive: r.altActive,
      // Same rule as the two above: without it the builder would send the next save
      // back with no preference and the router would put the rider straight back on
      // the interstate they asked to avoid, on a save made for some other reason.
      routePrefs: r.routePrefs ?? null,
      // uid and details go out here and are sent straight back by the next save.
      // Omitting either is how a stop's confirmation number silently disappears:
      // without the uid the save mints a new one and orphans the details row, and
      // without the details the reconcile pass reads the stop as cleared.
      // ONE ORDERED LIST, in the rider's own order — the read above is ordered by
      // position, which is set for both kinds.
      points: pts.map((p) => ({
        kind: p.kind,
        lat: p.lat,
        lng: p.lng,
        name: p.name,
        address: p.address,
        description: p.description ?? '',
        roles: p.roles,
        durationMin: p.durationMin,
        slackMin: p.slackMin,
        uid: p.uid,
        details: details.get(p.uid) ?? null,
      })),
      legs: legs.map((l) => ({
        geometry: l.geometry,
        distanceM: l.distanceM,
        durationS: l.durationS,
        viaPoints: l.viaPoints,
      })),
    })
  }
  return out
}

// --- Builder pages ---------------------------------------------------------

// The rider's saved home, but only if they asked for it and it geocoded. Gating
// on the server is deliberate: the edit route below never loads this, so an
// existing ride cannot grow a home stop on every save even if the client logic
// were wrong.
async function homeSeed(userId: number): Promise<{ lat: number; lng: number; label: string } | null> {
  const [p] = await db
    .select({ lat: userProfiles.homeLat, lng: userProfiles.homeLng, label: userProfiles.homeLabel })
    .from(userProfiles)
    .where(and(eq(userProfiles.userId, userId), eq(userProfiles.addHomeToRides, true)))
    .limit(1)
  // "Home" IS A FALLBACK RATHER THAN A STORED DEFAULT, exactly as builderPrefs()
  // treats "Meeting point": a rider who clears the name goes back to it instead of
  // it being written into their profile as though they typed it.
  return p?.lat != null && p?.lng != null ? { lat: p.lat, lng: p.lng, label: p.label?.trim() || 'Home' } : null
}

// Everything the builder needs off the rider's profile that is NOT the home seed,
// in one read — they come off the same row and the alternative was two round trips
// on the app's busiest page.
//
//   publicStart — sent to every builder page rather than only the new-ride one: an
//   existing ride can be made public at any time, and that is when the swap is
//   offered. Unlike homeSeed it is not gated on a preference.
//
//   durationFormat — how the stop duration field reads. Defaulted through
//   toDurationFormat rather than trusted, because a rider with no profile row gets
//   undefined here.
//
//   meetDivertMi — where the Groups tab's detour dial starts (#370), clamped
//   because the column carries no CHECK.
type PublicStart = { lat: number; lng: number; label: string }
type BuilderPrefs = {
  publicStart: PublicStart | null
  durationFormat: DurationFormat
  units: Units
  meetDivertMi: number
}

async function builderPrefs(userId: number): Promise<BuilderPrefs> {
  const [p] = await db
    .select({
      lat: userProfiles.startLat,
      lng: userProfiles.startLng,
      label: userProfiles.startLabel,
      durationFormat: userProfiles.durationFormat,
      units: userProfiles.units,
      meetDivertMi: userProfiles.meetDivertMi,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
  return {
    publicStart:
      p?.lat == null || p?.lng == null ? null : { lat: p.lat, lng: p.lng, label: p.label?.trim() || 'Meeting point' },
    durationFormat: toDurationFormat(p?.durationFormat),
    units: toUnits(p?.units),
    meetDivertMi: clampDivert(p?.meetDivertMi) ?? DEFAULT_DIVERT_MI,
  }
}

builderRoutes.get('/builder', requireActive, async (c) => {
  const user = currentUser(c)
  // ownRange, not groupRange: a ride that does not exist has no roster to ask.
  // See the note on ownRange for why the two are deliberately separate.
  const [home, prefs, range] = await Promise.all([homeSeed(user.id), builderPrefs(user.id), ownRange(user.id)])
  return c.html(builderHtml(null, user, home, prefs, null, undefined, range, null))
})

builderRoutes.get('/builder/:id', requireActive, async (c) => {
  const user = currentUser(c)
  const found = await builderRide(user.id, c.req.param('id'))
  // `view` is the floor, not `edit`. A member below `edit` gets the SAME PAGE with
  // its writes turned off rather than a redirect to the viewer: comments and
  // suggestions both hang off the row list and the stop details.
  if (!found || !canViewAsMember(found.member)) return c.text('Not found', 404)
  const { ride, member } = found
  const [prefs, range] = await Promise.all([builderPrefs(user.id), groupRange(ride.id)])
  return c.html(
    builderHtml(
      ride.id,
      user,
      null,
      prefs,
      ride.slug,
      {
        canEdit: canEditAsMember(member),
        isOwner: canAdminister(member),
        // A rider always knows their OWN rung — it is what the banner says. It
        // is everyone else's that is the owner's business; see canSeePerms.
        perm: member?.role === 'owner' ? null : (member?.perm ?? null),
      },
      range,
      { vehicle: ride.vehicle, power: ride.power },
    ),
  )
})

/** What the page needs to know about the viewer's standing on this ride. The
 *  new-ride page has no ride and therefore no roster, so it is always the owner
 *  of what it is about to create. */
type BuilderStanding = {
  canEdit: boolean
  isOwner: boolean
  /** The viewer's own rung, or null for an owner, who is not on the ladder. */
  perm: RidePerm | null
}

const OWNS_IT: BuilderStanding = { canEdit: true, isOwner: true, perm: null }

function builderHtml(
  rideId: number | null,
  user: UserRow,
  home: { lat: number; lng: number; label: string } | null,
  prefs: BuilderPrefs,
  // The ride's slug, for the roster link. Null on a new ride, which has no
  // roster to link to — and no ride, so nothing to be on.
  slug: string | null = null,
  standing: BuilderStanding = OWNS_IT,
  // Null-ranged by default so a caller that has not worked it out yet renders a
  // page with no fuel warning, rather than one claiming a range of zero.
  range: GroupRange = { miles: null, riderName: null, bikeLabel: null, unknown: 0, riders: 0, fuelType: null },
  // The ride's own vehicle and power (#321), for the words on this page and the two
  // selects in the ride band. Null on either means unset — the rider's own default.
  vehicle: { vehicle: string | null; power: string | null } | null = null,
): string {
  // The route slider is a focus control, not a navigation one: every route stays
  // drawn on the map at all times. Seeing the whole ride on one map is the product.
  // Three bands, each naming the scope of what it holds: the ride, the route across
  // all its routes, and the one route being edited. Before this the panel was a flat
  // run of divs and nothing said whether a control changed one route or the whole
  // ride.
  //
  // THE RIDE TIMELINE IS NO LONGER IN HERE — it is a bar across the bottom edge of
  // the map, see rideTimeline(). The two are not the same control: the scrubber
  // picks which route you are EDITING and belongs beside the edit controls, the
  // timeline moves through what you are LOOKING AT and belongs over the map (#93).
  //
  // THERE IS NO SAVE BUTTON, and no Discard either — the builder autosaves on idle.
  // What is left in .builder-actions is undo, redo, a status readout and the link to
  // the public page.
  //
  // Two details in that row are load-bearing, both serving the rule that nothing in
  // the panel changes size as its value changes:
  //
  //   #save-status is aria-hidden and #save-announce below it is the live region. A
  //   polite region on the readout would say "Unsaved changes, Saving, Saved" aloud
  //   three times a minute; it speaks only for an error or a blocked save.
  //
  //   #view-link ships from first paint and is revealed by the first successful
  //   save, using visibility rather than the hidden attribute — an element that
  //   appeared would shove the status beside it.
  // THREE TABS, and the ride's own fields above them: the route list, the subgroup
  // editor and the roster in one column pushed the route you were editing below the
  // fold.
  //
  // WHAT IS ABOVE THE STRIP BELONGS TO THE RIDE, not to any tab: the description and
  // the visibility select. Inside Routes they would read as being about the route,
  // which visibility in particular is not.
  //
  // DELETE IS BELOW THE PANELS, not above the strip and not in any tab: a
  // destructive control wants distance from the rows a pointer lives in.
  //
  // The strip is buttons with role="tab", not links and not a <details> each. Links
  // would need a URL per tab and the builder has one page with unsaved state in it;
  // three disclosures would let a rider open all three. Roving tabindex, arrow keys
  // and aria-selected are wired by initTabs().
  // The words for this page (#321): the ride's own pair over the rider's default.
  const words = wordsOf({ user, ride: vehicle })

  const tabs = `        <div class="panel-tabs" role="tablist" aria-label="Builder sections">
          <button type="button" class="panel-tab is-active" role="tab" id="tab-routes"
                  aria-controls="panel-routes" aria-selected="true">${Wds(words, 'route')}</button>
          <button type="button" class="panel-tab" role="tab" id="tab-groups"
                  aria-controls="panel-groups" aria-selected="false" tabindex="-1">Groups <span class="tab-count" id="sg-count"></span></button>
          <button type="button" class="panel-tab" role="tab" id="tab-riders"
                  aria-controls="panel-riders" aria-selected="false" tabindex="-1">${Wds(words, 'person')} <span class="tab-count" id="riders-count"></span></button>
        </div>`

  // ROUTES. Everything that was in the panel about the road: the route list, the
  // select-mode action bar, and + Route.
  //
  // THE SEARCH BOX THAT WAS ONCE HERE IS GONE, and its absence is the point. One
  // field above the route list had to guess which route a searched address belonged
  // to, and it guessed "whichever you touched last". Every route now ends in its own
  // search row, which knows its route and says so; the results dropdown is created
  // once on demand and moved to whichever row is asking.
  //
  // EVERY ROUTE, ALL THE TIME. This was one #route-band showing whichever route a
  // slider had selected; renderRoutes() fills #route-list with one .route-section
  // per route instead. A fixed-height drawer has room to show the whole ride.
  //
  // The per-route controls are CLASSES, not ids — there are N of each — and every
  // section and row carries data-route. Touching anything inside a section makes
  // that route active first, so editIndex() resolves to it.
  const routesTab = `        <div class="panel-tabpanel is-active" role="tabpanel" id="panel-routes" aria-labelledby="tab-routes" tabindex="0">
          <div class="tab-actions">
            ${faqLink('waypoint-poi-stop', 'the difference between a stop and a POI')}
            <button type="button" class="route-add" id="route-add" data-tip="route-add" title="Add ${aWd(words, 'route')}">+ ${Wd(words, 'route')}</button>
          </div>

          <!-- Select mode’s action bar, filled by renderSelectBar() in builder.js
               and hidden whenever state.select is null. It sits above the route
               list rather than floating over it so it cannot cover the very rows
               being ticked. -->
          <div class="select-bar" id="select-bar" hidden></div>

          <div class="route-list" id="route-list" data-duration-format="${prefs.durationFormat}"></div>
          <p class="route-empty-hint" id="route-empty-hint" hidden>No routes yet.</p>
        </div>`

  // GROUPS (#67). A named set of riders sharing an approach; a route belongs to one
  // or to nobody, and nobody means everyone rides it.
  //
  // THIS WAS A COLLAPSED <details> AND IS NOW A TAB BODY. The disclosure existed so
  // a solo ride would not pay a line of panel for a feature about groups — a tab
  // costs that line whatever is inside it, so what renderSubgroups() writes when
  // there are none is a sentence explaining what a group is for.
  const groupsTab = `        <div class="panel-tabpanel" role="tabpanel" id="panel-groups" aria-labelledby="tab-groups" tabindex="0" hidden>
          <div id="sg-body"></div>
          <div class="tab-actions">
            <button type="button" class="btn btn-sm btn-quiet" id="sg-add">Add a group</button>
          </div>
          <!-- THE MEETING-POINT BUTTON IS STATIC MARKUP AND SITS BELOW .tab-actions,
               which is the only way to get "Add a group" above it: the group rows and
               this button used to be one innerHTML in #sg-body, so nothing could be
               placed between them. Ziad’s call, 2026-09-05. Being static also means
               #sg-meet-out is no longer destroyed by renderSubgroups(), so a proposal
               survives a re-render by not being rebuilt at all—state.meet is still
               what it is drawn from, because taking one point re-renders the rows.
               Hidden until the ride has a second group: one group has nobody to meet. -->
          <div class="sg-meet-row" id="sg-meet-row" hidden>
            <button type="button" class="btn btn-sm sg-meet" id="sg-meet-all">Find meeting points</button>
            <!-- THE DETOUR DIAL. It sits BESIDE the button rather than in ride
                 preferences because a planner who gets three answers too far off
                 their road has to be able to say so without leaving the panel.
                 Session state per press, SEEDED FROM THE RIDER’S PREFERENCE
                 since 2026-09-19 (#370): the number is what a rider is willing
                 to ask of a feeder in general, so it starts where they set it on
                 /settings and is still theirs to move for this press. A
                 ride-level column was rejected on 2026-09-06 and still is—the
                 planner re-asks the moment the road changes. What the number
                 MEANS also changed with #370: how much further out of their way
                 than the cheapest possible meet a group may be sent, not an
                 absolute cap, so the label says "extra". -->
            <label class="sg-divert" for="sg-divert">
              <span>up to</span>
              <input type="number" id="sg-divert" min="${MIN_DIVERT_MI}" max="${MAX_DIVERT_MI}" step="5" value="${prefs.meetDivertMi}" inputmode="numeric" />
              <span>mi extra detour</span>
            </label>
          </div>
          <div class="sg-meet-out" id="sg-meet-out"></div>
        </div>`

  // RIDERS. Who is coming, what they are bringing, and which approach they are on.
  //
  // NOT A SECOND ROSTER PAGE. The two verbs that work in here are the two about the
  // PLAN: assigning a rider to a subgroup, and taking somebody off the ride. RSVP,
  // bike, invite and the vote are statements BY a rider and stay on /m/:slug/riders.
  //
  // EMPTY UNTIL THE RIDE HAS BEEN SAVED ONCE, because until then there is no ride
  // row and so no roster. The autosave makes that a few seconds, which is why the
  // placeholder says "once it saves".
  const ridersTab = `        <div class="panel-tabpanel" role="tabpanel" id="panel-riders" aria-labelledby="tab-riders" tabindex="0" hidden>
          <div id="riders-body"></div>
        </div>`

  // WHAT THIS RIDER MAY DO, said once at the top of the panel, and only for somebody
  // who is not the owner: a line saying you own your own ride is one every rider
  // reads once and then stops seeing, which is how a banner that DOES matter gets
  // missed. It names the rider's OWN rung and nobody else's.
  const standingBanner = standing.isOwner
    ? ''
    : `        <div class="builder-standing">
          <strong>${standing.canEdit ? `You can edit this ${wd(words, 'journey')}` : PERM_LABELS[standing.perm ?? DEFAULT_PERM]}</strong>
          <span>${
            standing.canEdit
              ? 'It belongs to someone else, so sharing, the roster and deleting stay&nbsp;theirs.'
              : `You are looking at someone else&rsquo;s ${wd(words, 'journey')}. Nothing you do here is&nbsp;saved.`
          }</span>
        </div>
`

  const contents = `${standingBanner}        <div class="panel-band panel-band--ride">
          <textarea id="ride-description" name="description" maxlength="2000" placeholder="Description (optional)" rows="2"></textarea>
${
  // VISIBILITY IS AN OWNER CONTROL and is not rendered for anybody else — the
  // PUT ignores the field from a non-owner, and a select that silently does
  // nothing is worse than no select. The description above it stays, because
  // editing the ride's own text is part of editing the ride.
  standing.isOwner
    ? `          <div class="meta-row">
            <select id="ride-visibility" name="visibility" data-tip="ride-visibility" title="Visibility">
              <option value="private" selected>Private</option>
              <option value="friends">Friends</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>${faqLink('visibility', 'private, friends, unlisted and public')}
          </div>
          <div class="meta-row meta-row--vehicle">
            <label for="ride-vehicle">For</label>
            <select id="ride-vehicle" name="vehicle" data-tip="ride-vehicle" title="What this ride is for">
              <option value="">${esc(`My default (${cap(VEHICLE_CHOICES.find((v) => v.id === words.vehicle_)?.label ?? '')})`)}</option>
              ${VEHICLE_CHOICES.map((v) => `<option value="${v.id}">${esc(v.label)}</option>`).join('')}
            </select>
            <select id="ride-power" name="power" data-tip="ride-power" title="What it runs on">
              <option value="">${esc(`My default (${cap(POWER_CHOICES.find((p) => p.id === words.power_)?.label ?? '')})`)}</option>
              ${POWER_CHOICES.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}
            </select>
          </div>
          <div class="meta-row meta-row--stopby">
            <label for="ride-stop-by">Start looking for a bed at</label>
            <input id="ride-stop-by" name="stopBy" type="time" step="900" data-tip="ride-stop-by" title="When to start looking for somewhere to stay">
            <button type="button" id="ride-stop-by-clear" class="btn btn-sm btn-quiet" hidden>Clear</button>
          </div>`
    : ''
}
        </div>

${tabs}

${routesTab}

${groupsTab}

${ridersTab}
${
  // COMMENTS ARE RIDE-LEVEL AND SIT BELOW THE TABS, not in a fourth one.
  //
  // The panel being THREE tabs is a recorded decision (2026-08-26) and a fourth
  // would undo it, so this goes where the other ride-level things go — with the
  // description, the visibility select and Delete. It holds BOTH anchors: a
  // comment on the ride, and every comment on a point, each labeled with the
  // stop it belongs to. The row menu's "Comment on this stop" is what anchors a
  // new one; this is where they are all read.
  //
  // Only on a saved ride, like Delete. A comment needs a ride id to hang off,
  // and the autosave makes that a few seconds.
  rideId
    ? `        <div class="builder-suggestions" id="builder-suggestions">
          <h3 class="comments-head">
            Suggestions <span class="comments-count" id="suggestions-count" hidden></span>
          </h3>
          <div id="suggestions-body"></div>
        </div>
        <div class="builder-comments" id="builder-comments">
          <h3 class="comments-head">
            Comments <span class="comments-count" id="comments-count" hidden></span>
          </h3>
          <div id="comments-body"></div>
        </div>`
    : ''
}
${
  // EXPORT SITS BELOW THE TABS FOR THE SAME REASON COMMENTS DO: it is a
  // ride-level action and the panel being THREE tabs is a recorded decision, so
  // a fourth tab is not available and was not wanted. It is a <details> rather
  // than nine links in the flow, because it is an errand a rider runs
  // occasionally and the panel is where they work continuously.
  //
  // EVERY ENDPOINT ALREADY EXISTED AND WAS ALREADY GATED. #172 was UI only:
  // /api/public/maps/:slug/{gpx,kml,geojson,csv}, the native JSON, and the
  // per-route zips all sit behind getViewable(), so a private ride's own owner
  // could already download it by typing the URL. The export cart on /import is
  // a multi-ride picker built for batches, not for the ride you have open.
  //
  // NOT GATED ON `edit`. Anyone who can open this builder can already reach
  // these URLs, and the read-only builder is what a view-, comment- or
  // suggest-level rider gets. A control that hid what the address bar offers
  // would be theater.
  //
  // `?dl` is what turns each one into a download rather than a render; the
  // filename comes from src/maps/filename.ts server-side.
  //
  // The hrefs are filled in by the FIRST SAVE on a new ride, exactly as the
  // View link is — see showViewLink() in builder.js. A ride with no slug has
  // nothing to export yet, so the block renders hidden and reveals itself the
  // moment there is something behind it.
  `        <details class="builder-export" id="builder-export"${slug ? '' : ' hidden'}>
          <summary>Export this ${wd(words, 'journey')}</summary>
          <div class="builder-export-body">
            <p class="field-hint">
              An imported ride hands back the file you uploaded until you edit it here; after that it is built from
              your&nbsp;ride.
            </p>
            <ul class="builder-export-list">
              ${
                // Labeled explicitly rather than by uppercasing the path segment,
                // which produced "GEOJSON".
                (
                  [
                    ['gpx', 'GPX'],
                    ['kml', 'KML'],
                    ['geojson', 'GeoJSON'],
                    ['csv', 'CSV'],
                  ] as const
                )
                  .map(
                    ([f, label]) =>
                      `<li><a data-export="${f}" href="${slug ? `/api/public/maps/${encodeURIComponent(slug)}/${f}?dl` : '#'}">${label}</a>` +
                      ` <a class="export-zip" data-export="zip/${f}" href="${slug ? `/api/public/maps/${encodeURIComponent(slug)}/zip/${f}` : '#'}">one file per route</a></li>`,
                  )
                  .join('\n              ')
              }
              <li>
                <a data-export="routeloop.json" href="${slug ? `/api/public/maps/${encodeURIComponent(slug)}/routeloop.json?dl` : '#'}">Routeloop JSON</a>
                <span class="field-hint">Everything, including what the other four cannot carry.</span>
              </li>
            </ul>
          </div>
        </details>`
}
${
  // ONLY ON AN EXISTING RIDE. A ride that has never been saved has nothing to
  // delete — closing the tab already discards it — and a Delete button on a
  // blank builder is an offer to destroy something that does not exist.
  //
  // BELOW ALL THREE PANELS. It is ride-level like the description and the
  // visibility select, but unlike those two it does not go above the tab strip:
  // both of those rows are ones a rider's pointer lives in while building, and a
  // destructive control wants distance from anything pressed by reflex. The end
  // of the panel is where a rider goes deliberately.
  // ...AND ONLY FOR AN OWNER. Deleting is one of the three powers `edit` does
  // not carry, along with visibility and the roster.
  rideId && standing.isOwner
    ? `        <div class="builder-danger">
          <button type="button" id="ride-delete" class="linkbtn">Delete this ${wd(words, 'journey')}</button>
          <span class="builder-danger-note">Moves it to the recycle bin for ${TRASH_HOLD_DAYS} days.</span>
        </div>`
    : ''
}

        <span id="save-announce" class="visually-hidden" role="status" aria-live="polite"></span>
        <div id="recover-bar" class="tb-banner is-recover" hidden>
          <span id="recover-text"></span>
          <button id="recover-yes" class="linkbtn" type="button">Restore</button>
          <button id="recover-no" class="linkbtn" type="button">Discard</button>
        </div>`

  // THE RIDE'S NAME IS THE HEADING. It used to say "Edit ride" on the most prominent
  // line in the panel and put the actual name in an input below it, and on a new
  // ride there was no heading at all.
  //
  // The input IS the heading rather than something a pencil reveals: a reveal would
  // be a second mode and a layout jump. The field is styled as the heading, carries
  // no border until hovered or focused, and shows the pencil as an affordance.
  //
  // IT IS A TEXTAREA, NOT A TEXT INPUT, and that is the only way to have it wrap: an
  // <input> will ellipsize a long name but never break one onto a second line.
  //
  // Being a textarea costs three things, all handled in builder.js: Enter has to be
  // swallowed, pasted newlines flattened, and the height set from scrollHeight on
  // every edit. `rows="1"` is the floor fitTitle() grows from; the two-line ceiling
  // is a max-height in _builder.scss.
  const titleHtml = `<textarea id="ride-title" name="title" maxlength="150" rows="1" wrap="soft"
             placeholder="${rideId ? 'Untitled ride' : `Plan ${aWd(words, 'journey')}`}" autocomplete="off" spellcheck="false"
             aria-label="${Wd(words, 'journey')} name" data-tip="ride-name" title="${Wd(words, 'journey')} name—click to edit"></textarea>
          <div class="totals" id="totals"></div>`

  // PINNED TO THE DRAWER'S BOTTOM EDGE, not scrolled with the route list. It was
  // `position: sticky; bottom: 0` inside .panel-contents-wrapper, so it sat above
  // the scrollbar and shifted with the list's own padding. As the drawer's footer it
  // is a sibling of the scroller and cannot move.
  const builderActions = `<div class="builder-actions">
          <!-- TWO DRAWN FILES, not one mirrored with scaleX(-1), which is what
               this was until 2026-08-16. The argument for mirroring was that a
               second file is a second chance for the arrowheads to land at
               different angles—but icon-redo.svg is drawn as a true reflection
               of icon-undo.svg (compare the two paths: the same numbers at
               500 − x), so the risk it guarded against is not present, and a
               real file beats a transform that has to be remembered.

               They are .tb-inline-icon rather than <img>, so hydrateIcons() in
               builder.js inlines the SVG and its fill="currentColor" can take
               the button’s color—including the 0.35 opacity of the disabled
               state. An <img> cannot inherit color and would stay black while
               the button grayed out around it. -->
          <button id="undo" class="btn-icon" type="button" disabled data-tip="undo" title="Nothing to undo" aria-label="Undo"><span class="tb-inline-icon" data-icon="icon-undo.svg"></span></button>
          <button id="redo" class="btn-icon" type="button" disabled data-tip="redo" title="Nothing to redo" aria-label="Redo"><span class="tb-inline-icon" data-icon="icon-redo.svg"></span></button>
          <span id="save-status" class="save-status" data-state="new" aria-hidden="true">
            <span class="save-dot"></span>
            <span class="save-text">Not saved yet</span>
          </span>
          <!-- #233. THE WAY BACK INTO A DISMISSED ERROR, and a real button
               rather than a click handler on the readout above—that span is
               aria-hidden, so a keyboard could never reach it and a screen
               reader would never announce it. Hidden until something has gone
               wrong; builder.js unhides it, because the readout can only ever
               show the first few words of a message. -->
          <button type="button" id="save-detail" class="save-detail" hidden>Details</button>
          <!-- WHO ELSE IS IN THIS RIDE. Server-rendered empty and hidden: the
               list only ever arrives over the live channel, and a rider with no
               channel—a dropped connection, a draining container, JavaScript
               that failed to reach the endpoint—must see nothing rather than
               an empty strip that looks broken. aria-live is polite because
               somebody arriving is worth knowing about and never worth
               interrupting whatever the rider is doing. -->
          <span id="live-presence" class="live-presence" role="status" aria-live="polite" hidden></span>
          <a id="view-link" class="view-link is-empty" href="#" target="_blank" rel="noopener">View</a>
        </div>`

  return page({
    title: rideId ? `Edit ${wd(words, 'journey')}` : `Plan ${aWd(words, 'journey')}`,
    user,
    words,
    ride: vehicle,
    variant: 'map',
    bodyClass: 'builder-page',
    navKey: 'builder',
    // The floating way into the intake. 'planning' matches areaFromPath() in
    // src/feedback/policy.ts, which is what the account-menu path infers.
    feedbackArea: 'planning',
    noscript: `JavaScript is required to plan ${aWd(words, 'journey')}.`,
    body: `  <div id="map"></div>\n\n  ${panelShell({
      titleHtml,
      extraClass: 'builder-panel',
      contents,
      footer: builderActions,
      // THE FOOTER IS THE ACTION BAR. The route scrubber lived here for about an hour on 2026-08-16,
      // pinned to the drawer's bottom edge so it could not be shoved around by
      // the route band it selected. Showing every route at once removed the thing it
      // selected between, so the control went with it.
      //
      // The rail keeps a dot per route, but as a jump-to rather than a picker:
      // clicking one scrolls that route's section into view and makes it active.
      rail: `<div class="rail-routes" id="rail-routes"></div>`,
    })}\n\n  ${rideTimeline({ scopeToggle: true, words })}`,
    tb: {
      gmapsKey: GMAPS_KEY,
      mapId: GMAPS_MAP_ID,
      roles: ROLE_META,
      routeColors: ROUTE_COLORS,
      rideId,
      // For the Riders tab's link to the roster page. Null on a new ride, which has no
      // slug yet — showViewLink() fills it in on the first successful save.
      slug,
      home,
      publicStart: prefs.publicStart,
      durationFormat: prefs.durationFormat,
      units: prefs.units,
      // Where the detour dial starts — the same number the input above is
      // rendered with, so state and the box agree before anybody touches it.
      maxDivertMi: prefs.meetDivertMi,
      // WHAT THIS RIDER MAY DO, and it is a hint rather than the gate. The
      // server refuses a write from a rider below `edit` whatever the page
      // believes — see the PUT — and this is here so the page does not offer an
      // action that would then be refused, and does not autosave into a 404.
      canEdit: standing.canEdit,
      isOwner: standing.isOwner,
      perm: standing.perm,
      // The viewer's own id, so the live channel can tell its own events and its
      // own presence row apart from everybody else's without a second request.
      // Not a secret: it is this rider's id, told to this rider.
      riderId: user.id,
      // WHAT THE DAY HAS TO BE PLANNED AROUND (#220), and it is the GROUP's
      // binding range rather than the planner's own bike. A fuel plan built on
      // a 220-mile tank strands the rider who brought 120 — #52's whole point,
      // and groupRange() has answered it for the roster page since that shipped.
      // The builder is where it was missing.
      //
      // `miles` is null when nothing on the ride has a range on file, and every
      // reader must render NOTHING rather than a zero: a fuel warning built on
      // an invented number is worse than no warning because it looks like one.
      range,
    },
    // SortableJS drives drag-to-reorder on the stop list. Pinned to an exact
    // version with an SRI hash and crossorigin, so jsdelivr serving anything but
    // the 1.15.7 bytes gets refused rather than executed. MIT, 45KB, and the
    // version is 2026-02-11 rather than the stale release it is often assumed to
    // be. Approved as a dependency 2026-08-15.
    //
    // `defer` scripts run in document order, so this is loaded ahead of
    // builder.js and window.Sortable exists by the time initDragToReorder()
    // looks for it. **If the CDN fails, the builder still works** — that
    // function checks for the global and returns quietly, and every row's menu
    // carries Move up / Move down regardless. Those are also the keyboard path,
    // because a drag handle is not one.
    //
    // SHEPHERD.JS DRIVES THE GUIDED TOUR (#133), the second CDN script on this
    // page and the second approved dependency. Ziad's call, 2026-09-10, over a
    // hand-rolled spotlight: the three waiting steps are hand-written either
    // way, so what the library buys is the positioning — flip, shift,
    // scroll-into-view, the focus trap — which is where hand-rolled tours go
    // wrong. MIT, 46KB.
    //
    // **IT IS LOADED AS A MODULE THROUGH A PRELOAD, AND THAT PAIR IS WHAT KEEPS
    // SRI.** Shepherd 12+ ships ESM only and cdnjs stops hosting its JS at 11,
    // so it comes from jsdelivr, which already serves SortableJS. An `import`
    // specifier cannot carry an integrity hash; a `<link rel="modulepreload">`
    // can, and the browser serves the later import from that verified entry —
    // so the bytes are still checked and a tampered file is still refused.
    // tour.js reads the preload's own href and `import()`s it after load, so
    // the URL is written once and the import can never name a different file
    // from the one that was verified.
    //
    // **A DYNAMIC IMPORT FROM A CLASSIC SCRIPT, NOT AN INLINE MODULE, AND THE
    // DIFFERENCE IS WHETHER THE BUILDER WAITS.** Module scripts are deferred and
    // execute in document order with every other deferred script — so an inline
    // `<script type="module">` placed above builder.js would hold builder.js,
    // and DOMContentLoaded with it, until jsdelivr had answered. A tour must
    // never be on the path to the builder drawing. `import()` from tour.js,
    // the last script on the page, is off that path entirely.
    //
    // **IF THE CDN FAILS, THE TOUR IS ABSENT AND THE BUILDER IS UNTOUCHED**:
    // the import rejects, boot() is never called, and Take the tour in the menu
    // is a plain link that reloads and tries again. The stylesheet is
    // Shepherd's own, pinned the same way, and style/_tour.scss re-themes it
    // onto this palette's tokens on top.
    // The two <link>s go in the head — a stylesheet at the end of the body is a
    // late repaint, and a preload is pointless after the parser is done. Note
    // they still land AFTER main.min.css, so style/_tour.scss has to outrank
    // Shepherd's own rules by specificity rather than by order.
    // Spelled once in views/tour-assets.ts, because the tour follows the
    // rider onto four other pages that carry the same pair while it runs.
    head: TOUR_HEAD,
    scripts: `${googleMapsLoader(GMAPS_KEY)}
  <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.7/Sortable.min.js" integrity="sha384-DgmC6Xe2bSN2WjTDXzWYbUbxyhNP+NNkGDR/g78pCXV7E7rcVTGxVg0uIVCUUcBc" crossorigin="anonymous" defer></script>
  <script src="${asset('/js/tabs.js')}" defer></script>
  <script src="${asset('/js/map-common.js')}" defer></script>
  <script src="${asset('/js/ride-time.js')}" defer></script>
  <script src="${asset('/js/duration.js')}" defer></script>
  <script src="${asset('/js/twist.js')}" defer></script>
  <script src="${asset('/js/builder-history.js')}" defer></script>
  <script src="${asset('/js/route-shape.js')}" defer></script>
  <script src="${asset('/js/route-ink.js')}" defer></script>
  <script src="${asset('/js/drag-index.js')}" defer></script>
  <script src="${asset('/js/alts.js')}" defer></script>
  <script src="${asset('/js/place-query.js')}" defer></script>
  <script src="${asset('/js/route-clock.js')}" defer></script>
  <script src="${asset('/js/route-distance.js')}" defer></script>
  <script src="${asset('/js/route-split.js')}" defer></script>
  <script src="${asset('/js/corridor.js')}" defer></script>
  <script src="${asset('/js/range-circle.js')}" defer></script>
  <script src="${asset('/js/builder.js')}" defer></script>
  ${tourScript()}`,
  })
}
