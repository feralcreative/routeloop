// The ride builder's API and page shells. A ride payload is the full graph —
// ride meta + days + stops/POIs + routed legs — saved whole (PUT is a
// full-replace inside one transaction). The builder MVP sent exactly one day;
// the API accepted many from day one, and the builder caught up on 2026-07-30.
import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { mergeDays, storedUidsNeeded, type MergeResult } from '../maps/day-merge'
import { db } from '../db/index'
import {
  rides,
  days as daysTable,
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
import { DAY_COLORS } from '../maps/palette'
import { detailsForViewer } from '../maps/point-details'
import { MAX_ROLES_PER_POINT, ROLES, ROLE_META } from '../maps/roles'
import { twistiness } from '../maps/twist'
import { faqLink, googleMapsLoader, page, panelShell, rideTimeline } from '../views/layout'
import { TRASH_HOLD_DAYS } from '../trash/policy'
import { asset } from '../views/assets'
import { GMAPS_KEY, GMAPS_MAP_ID } from '../config'
import { generateSlug } from '../maps/slug'
import { turnstileEnabled, verifyTurnstile } from '../maps/turnstile'
import { canClone } from '../access/policy'
import { memberOrOwner, seedOwner } from '../members/service'
import {
  canAdminister,
  canEditAsMember,
  canViewAsMember,
  DEFAULT_PERM,
  PERM_LABELS,
  type MemberFields,
} from '../members/policy'
import { subgroupsOf } from '../subgroups/service'
import { grantsFor } from '../access/query'
import { fields, firstIssue } from '../maps/fields'
import { LIVE_RIDE } from '../trash/service'
import {
  MAX_DAYS,
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
 * `rev` RIDES ALONGSIDE THE PAYLOAD RATHER THAN INSIDE IT, and deliberately.
 *
 * `ridePayload` is shared with the native JSON import — a file on disk, which
 * has no opinion about who else is editing — so a concurrency token has no
 * business in that schema. Zod strips unknown keys, so it would be silently
 * dropped there anyway, which is the worst of both: the guard would appear to
 * be wired and would check nothing.
 *
 * Optional, and see drizzle/0024 for why that is not laziness: during the
 * blue/green overlap the OLD builder posts no `rev` at all, and requiring it
 * would refuse every one of those saves.
 */
const revField = z.coerce.number().int().nonnegative().optional()

/** Every day uid the client held when it loaded, and the hash it saw. The WHOLE
 *  set, not a field on each day it still has — a day the rider deleted is absent
 *  from the payload and would carry nothing, and that is precisely the case
 *  mergeDays has to tell apart from a day somebody else added. */
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
  const base = baseField.safeParse((raw as { dayBase?: unknown } | null)?.dayBase)
  return {
    data: parsed.data,
    rev: rev.success ? rev.data : undefined,
    base: base.success ? base.data : undefined,
  }
}

// --- API -------------------------------------------------------------------

const jsonLimit = bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: 'payload too large' }, 413) })

builderRoutes.post('/api/rides', requireActiveApi, requireSameOrigin, jsonLimit, async (c) => {
  const user = currentUser(c)

  // Same bot gate as import: enforced once Turnstile keys are set. The token
  // rides in the X-Turnstile-Token header for JSON requests.
  if (turnstileEnabled()) {
    const token = c.req.header('X-Turnstile-Token') ?? ''
    if (!(await verifyTurnstile(token, c.req.header('CF-Connecting-IP')))) {
      return c.json({ error: 'bot check failed—reload and try again' }, 403)
    }
  }

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
    return ride
  })
  console.log(`[rides] user ${user.id} created ride ${created.id} (${created.stopCount} stops)`)
  return c.json({ id: created.id, slug: created.slug }, 201)
})

// Clone a public ride into the caller's account as a private draft.
//
// Reads the stored graph and rebuilds it through the same insertRideGraph the
// builder's save uses, so a clone is a first-class native ride rather than a
// second representation that drifts.
//
// Deliberately dropped:
//   - descriptions, on the ride and on every stop. Those are the author's
//     writing, and stop notes are where "gate code 4417, park behind the barn"
//     lives. Copying them hands one rider's private notes to a stranger.
//   - visibility. A clone lands private no matter what the original was; making
//     it public is a decision the new owner takes deliberately.
//   - via points, which are shaping for a route the cloner will now edit.
builderRoutes.post('/api/rides/:id/clone', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not found' }, 404)

  const [src] = await db
    .select()
    .from(rides)
    .where(and(eq(rides.id, id), LIVE_RIDE))
    .limit(1)
  // canClone, not `visibility === 'public'` written out. Two levels are
  // clonable now — public, and friends by a friend — and which they are is
  // src/access/policy.ts's call, shared with the button on the viewer page that
  // offers this endpoint. A button and a gate that disagree is a Clone that
  // 404s, or worse.
  //
  // The `source !== 'native'` half of the old test is gone and stays gone: it
  // was there because an imported ride's graph could not be rebuilt into
  // something the builder would open, which stopped being true when the import
  // started splitting its track into real legs.
  if (!src || !canClone(src, user, await grantsFor(src, user))) {
    return c.json({ error: 'not found' }, 404)
  }

  const srcRoutes = await db.select().from(daysTable).where(eq(daysTable.rideId, src.id)).orderBy(daysTable.position)

  const payloadDays = []
  for (const r of srcRoutes) {
    const pts = await db.select().from(pointsTable).where(eq(pointsTable.dayId, r.id)).orderBy(pointsTable.position)
    const legs = await db.select().from(routeLegs).where(eq(routeLegs.dayId, r.id)).orderBy(routeLegs.position)

    const point = (p: (typeof pts)[number]) => ({
      lat: p.lat,
      lng: p.lng,
      name: p.name,
      description: '',
      roles: p.roles,
      // A clone gets FRESH identities and NO private details, and both halves of
      // that are deliberate.
      //
      // `details: null` is a privacy boundary, not a tidiness choice. A public
      // ride is clonable by anyone, and its author's confirmation numbers, gate
      // codes and phone numbers are exactly what point_details exists to keep
      // off a stranger's screen. Copying them here would hand them over wholesale
      // — the one place a clone could leak what `ride.json` is careful not to.
      //
      // `uid: null` follows from it: the new ride mints its own, so nothing ties
      // a cloned stop back to the original's details row.
      uid: null,
      details: null,
    })

    payloadDays.push({
      // A clone has no subgroups: the cloner is one person taking a copy, and
      // the original's approaches are about people who are not on their ride.
      // The days come across as everyone's, which is what a solo ride is.
      subgroupUid: null,
      // Fresh, exactly as a cloned point's is and for the same reason one level
      // up: a clone must not inherit the original's votes, and alt_votes is
      // keyed by day uid. Null lets insertRideGraph mint one.
      uid: null,
      title: r.title,
      color: r.color,
      // Times belong to the ride the author planned, not to whenever the cloner
      // rides it. The timeline re-derives from legs and stops either way.
      startAt: null,
      endAt: null,
      // Kept, unlike the times and the via-points above. An alternate is part of
      // what the author planned — "here are two ways to do Thursday" is the
      // thing being cloned, not incidental state — and dropping it would both
      // lose that and hand the clone a bigger mileage than the original, because
      // the losing alternates would become ordinary days.
      altGroup: r.altGroup,
      altActive: r.altActive,
      // ONE ORDERED LIST, and the read above is already ordered by position,
      // so the rider's own sequence clones intact. Both kinds carry a duration,
      // so a clone keeps the POI dwell too — dropping it would quietly shorten
      // every cloned day.
      // slackMin comes across with the dwell: it is a property of the meeting
      // point the author planned, not of who is riding to it.
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
    // NO SUBGROUPS ON A CLONE, and therefore no anchors either. A clone is one
    // person taking a copy of a route; the original's approaches are about
    // people who are not on their ride, and carrying them over would give the
    // cloner a converge-and-split shape with nobody in any of the groups.
    subgroups: [],
    primarySubgroup: null,
    trunkSubgroup: null,
    timeAnchor: 'departure',
    days: payloadDays,
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
    return ride
  })

  console.log(`[rides] user ${user.id} cloned ride ${src.id} -> ${created.id}`)
  return c.json({ id: created.id, slug: created.slug }, 201)
})

// THIS CHURNS EVERY POINT AND DAY ID, ON PURPOSE, AND THE BUILDER NOW CALLS IT
// CONSTANTLY. Decided 2026-08-15 while planning autosave (#89): the full replace
// below deletes the ride's days — cascading to points and legs — and re-inserts
// them, so `points.id` and `days.id` are different rows after every save. The
// builder used to save when a rider pressed a button, perhaps a dozen times in a
// session; it now flushes on idle, which is two orders of magnitude more often.
//
// That is still safe TODAY for exactly one reason: nothing anywhere references a
// point across a save. The client payload carries no ids, the exports rebuild
// from the graph, and the roadbook reads it whole.
//
// It stops being safe the moment anything does — rich stop details (#15), a
// comment on a stop, a photo attached to one. **Any feature that needs a point
// to keep its identity has to fix this first**, and the fix is not small: send
// ids in the payload, diff here, and update in place, which rewrites
// insertRideGraph, ridePayload and loadRidePayload — the path the native JSON
// import shares. Do not add the reference and hope; the failure is silent and
// looks like data that wandered off.
/**
 * The ride, plus the viewer's own roster row — what all three builder gates ask
 * about now that a ride is editable by somebody who does not own it.
 *
 * NOT `ownRide()`, which filters on `rides.owner_id` and is still correct for
 * every OWNER power: delete, clone, visibility, the roster. This one resolves the
 * ride first and asks the roster second, and the caller decides which rung it
 * needs.
 *
 * **The owner's row is synthesized if it is somehow missing** rather than being
 * a second permission rule beside canEditAsMember(). seedOwner() runs inside the
 * transaction that inserts every ride and drizzle/0015 backfilled the rest, so
 * this should never fire — but the cost of the invariant being wrong once is an
 * owner locked out of their own ride, and repairing the INPUT keeps there being
 * exactly one answer to "who may edit this".
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
  // ONE IMPLEMENTATION, shared with the viewer's builder link — see
  // memberOrOwner. The synthesized owner row used to live here; two copies of it
  // is how the link starts offering what this gate refuses.
  return { ride, member: await memberOrOwner(ride, userId) }
}

builderRoutes.put('/api/rides/:id', requireActiveApi, requireSameOrigin, jsonLimit, async (c) => {
  const user = currentUser(c)
  const found = await builderRide(user.id, c.req.param('id'))
  // 404 rather than 403 for a rider who may see the ride but not write to it.
  // A 403 confirms the ride exists to somebody holding a guessed id, and this
  // endpoint is reachable by anyone signed in.
  if (!found || !canEditAsMember(found.member)) return c.json({ error: 'not found' }, 404)
  const { ride, member } = found
  const isOwner = canAdminister(member)

  const body = await parseRideBody(c)
  if (!body.data) return c.json({ error: body.error }, 400)
  const p = body.data
  const p_rev = body.rev
  const p_base = body.base

  // THE STALE-WRITE CHECK, AND IT HAS TO BE INSIDE THE TRANSACTION.
  //
  // Read-then-write outside one is the race it exists to close: two saves both
  // read rev 7, both find it current, and both write. `for update` on the row
  // makes the second wait for the first to commit and then see rev 8.
  //
  // A missing `rev` means unchecked — see revField. That is the expand/contract
  // half of this, not an oversight.
  const result = await db.transaction(async (tx) => {
    const [cur] = await tx.select({ rev: rides.rev }).from(rides).where(eq(rides.id, ride.id)).for('update')
    if (p_rev !== undefined && cur && cur.rev !== p_rev) return { stale: cur.rev }

    // THE PER-DAY MERGE, AND THE ORDER OF THESE THREE STEPS IS THE WHOLE THING.
    //
    // The merged set has to be complete BEFORE insertRideGraph runs, because
    // that function reconciles votes, comments and point details against the uid
    // set of the payload it is given — reconcileVotes, demoteOrphanComments and
    // writePointDetails all do. Hand it one rider's partial day list and it
    // deletes the other rider's votes and orphans their comments, silently,
    // with nothing raised anywhere.
    //
    // The lock above is what makes reading here safe: no second save can land
    // between this select and the write below.
    let merge: MergeResult | null = null
    if (p_base !== undefined) {
      const storedDays = await tx
        .select({ uid: daysTable.uid, hash: daysTable.contentHash })
        .from(daysTable)
        .where(eq(daysTable.rideId, ride.id))
      merge = mergeDays(
        storedDays,
        p.days.map((d) => d.uid ?? ''),
        p_base,
      )
      const needed = storedUidsNeeded(merge)
      if (needed.length > 0) {
        // ONLY ON THE CONFLICT PATH, which is normally never taken. Reusing
        // loadRidePayload rather than writing a second day serializer is
        // deliberate: two of those would drift, and the drift would show up as
        // days quietly losing fields when they lose a merge.
        //
        // The OWNER's payload, whoever is saving — details are stripped for a
        // non-owner and re-inserting a stripped day would delete them. The
        // non-owner save writes details in `preserve` mode for the same reason.
        const current = (await loadRidePayload(ride, { id: ride.ownerId })) as {
          days: Array<Record<string, unknown>>
        }
        const byUid = new Map(current.days.map((d) => [d.uid as string, d]))
        const sent = new Map(p.days.map((d) => [d.uid ?? '', d]))
        p.days = merge.decisions
          .map((dec) => (dec.take === 'incoming' ? sent.get(dec.uid) : byUid.get(dec.uid)))
          .filter(Boolean) as typeof p.days
      } else {
        // Nothing contested. Reorder only, so a day another rider deleted is not
        // resurrected by this save.
        const sent = new Map(p.days.map((d) => [d.uid ?? '', d]))
        p.days = merge.decisions.map((dec) => sent.get(dec.uid)).filter(Boolean) as typeof p.days
      }
    }
    const [written] = await tx
      .update(rides)
      .set({
        rev: sql`${rides.rev} + 1`,
        title: p.title,
        description: p.description || null,
        // VISIBILITY IS AN OWNER POWER AND THIS IS THE GATE. Edit means the
        // builder — days, points, legs, alts — and not the decision about who
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
    await tx.delete(daysTable).where(eq(daysTable.rideId, ride.id))
    // `preserve` for a non-owner — see DetailsMode in ride-graph.ts. Their
    // payload carries no details because they were never sent any, and a
    // reconciling write would read that as the rider clearing every one.
    await insertRideGraph(tx, ride.id, p, isOwner ? 'reconcile' : 'preserve')
    // Read back AFTER the write, so the client's next save is based on what is
    // actually stored rather than on what this request believed it wrote.
    const after = await tx
      .select({ uid: daysTable.uid, hash: daysTable.contentHash })
      .from(daysTable)
      .where(eq(daysTable.rideId, ride.id))
    return { rev: written.rev, merge, after }
  })

  // 409 CARRYING THE CURRENT STATE, so the builder can show what it collided
  // with rather than only that it did. The rider's own work is still in their
  // browser and untouched — nothing was written — which is the whole point of
  // refusing rather than merging at this level.
  if ('stale' in result) {
    return c.json({ error: 'stale', rev: result.stale, ride: await loadRidePayload(ride, isOwner ? user : null) }, 409)
  }
  // dayBase goes straight back out so the builder can rebase without a reload.
  // Without it the SECOND save of a session is based on hashes the first save
  // invalidated, and every day reads as contested.
  return c.json({
    id: ride.id,
    slug: ride.slug,
    rev: result.rev,
    dayBase: Object.fromEntries(result.after.filter((d) => d.hash !== null).map((d) => [d.uid, d.hash as string])),
    // Named so the rider can be told which of their days did not land, rather
    // than watching them revert on the next render with no explanation.
    superseded: result.merge?.superseded ?? [],
    adopted: result.merge?.adopted ?? [],
  })
})

// Member load for the builder — the same shape PUT accepts, vias included.
//
// The gate is `view`, not `edit`: the read-only builder is what a view-, comment-
// or suggest-level rider gets, and it loads through here like any other.
builderRoutes.get('/api/rides/:id', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const found = await builderRide(user.id, c.req.param('id'))
  if (!found || !canViewAsMember(found.member)) return c.json({ error: 'not found' }, 404)
  return c.json(await loadRidePayload(found.ride, user))
})

export async function loadRidePayload(ride: RideRow, viewer: { id: number } | null) {
  // NOT owner-only by construction any more. This used to reach detailsForOwner
  // directly, on the grounds that every caller arrived behind `ownRide()` — true
  // until #190 let an `edit`-level member load the same payload, and false in a
  // way that would have handed somebody else's confirmation numbers and gate
  // codes to every collaborator on the ride.
  //
  // detailsForViewer() is the boundary and it is owner-only and deliberately
  // blind to visibility. A non-owner gets an empty map, which is why a non-owner
  // save writes point_details in `preserve` mode — see the PUT above.
  const details = await detailsForViewer(ride.id, ride.ownerId, viewer)
  const dayRows = await db.select().from(daysTable).where(eq(daysTable.rideId, ride.id)).orderBy(daysTable.position)
  // BY UID, both here and in the payload the client sends back — ids never
  // cross the wire, so `days[].subgroupUid` needs the map to be resolvable on
  // the way out as well as on the way in.
  const groups = await subgroupsOf(ride.id)
  const uidOf = new Map(groups.map((g) => [g.id, g.uid]))
  const out = {
    id: ride.id,
    slug: ride.slug,
    // OUT AND STRAIGHT BACK ON THE NEXT SAVE, like every uid in this payload,
    // and the same class of failure if it is dropped: the PUT stops checking,
    // silently, and two riders are back to overwriting each other with nothing
    // raised on either screen.
    rev: ride.rev,
    source: ride.source,
    title: ride.title,
    description: ride.description ?? '',
    visibility: ride.visibility,
    external_url: ride.externalUrl ?? '',
    subgroups: groups.map((g) => ({ uid: g.uid, name: g.name, color: g.color })),
    primarySubgroup: ride.primarySubgroupId ? (uidOf.get(ride.primarySubgroupId) ?? null) : null,
    trunkSubgroup: ride.trunkSubgroupId ? (uidOf.get(ride.trunkSubgroupId) ?? null) : null,
    timeAnchor: ride.timeAnchor,
    days: [] as unknown[],
  }
  for (const r of dayRows) {
    const pts = await db.select().from(pointsTable).where(eq(pointsTable.dayId, r.id)).orderBy(pointsTable.position)
    const legs = await db.select().from(routeLegs).where(eq(routeLegs.dayId, r.id)).orderBy(routeLegs.position)
    out.days.push({
      // Out and straight back, like the uid below. Omitting it is how a rider's
      // whole subgroup assignment survives until they reload and is then gone.
      subgroupUid: r.subgroupId ? (uidOf.get(r.subgroupId) ?? null) : null,
      // The day's uid, out and straight back on the next save — exactly what
      // the point comment below says about a stop's, and the same failure if it
      // is omitted: the save mints a fresh one, uq_day_ride_uid is satisfied,
      // and every vote cast on that alternate is reconciled away as belonging
      // to a day that no longer exists. Nothing would raise anything.
      uid: r.uid,
      // VERBATIM FROM THE COLUMN, NEVER RECOMPUTED HERE. dayRevision() runs in
      // exactly one place — the write, in insertRideGraph — and this hands back
      // what it stored. Recomputing would mean the write shape and this read
      // shape had to stay identical field for field forever, and the first time
      // they drifted every day would conflict with itself on every save, on
      // rides nobody else had touched, with nothing to point at.
      //
      // Null for a day written before the column existed. mergeDays() reads that
      // as unknown and takes the client's version, which is what these rides did
      // before any of this.
      contentHash: r.contentHash,
      title: r.title,
      color: r.color,
      startAt: r.startAt?.toISOString() ?? null,
      endAt: r.endAt?.toISOString() ?? null,
      // Omitting these is how a saved alternate grouping silently disappears on
      // the next page load — the same trap the durationMin comment below names,
      // and worse here because the ride's mileage would jump at the same time.
      // This function names every field it carries; nothing is spread.
      altGroup: r.altGroup,
      altActive: r.altActive,
      // uid and details go out here and are sent straight back by the next
      // save. Omitting either is how a stop's confirmation number silently
      // disappears: without the uid the save mints a new one and orphans the
      // details row, and without the details the reconcile pass reads the stop
      // as cleared and deletes it.
      // ONE ORDERED LIST, in the rider's own order — the read above is ordered
      // by position, which is now set for both kinds. The two arms this
      // replaced were field-for-field identical apart from the filter, which is
      // the clearest sign the split was never carrying its weight.
      points: pts.map((p) => ({
        kind: p.kind,
        lat: p.lat,
        lng: p.lng,
        name: p.name,
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
// on the server rather than in builder.js is deliberate: the edit route below
// never loads this, so an existing ride cannot grow a home stop on every save
// even if the client logic were wrong.
async function homeSeed(userId: number): Promise<{ lat: number; lng: number } | null> {
  const [p] = await db
    .select({ lat: userProfiles.homeLat, lng: userProfiles.homeLng })
    .from(userProfiles)
    .where(and(eq(userProfiles.userId, userId), eq(userProfiles.addHomeToRides, true)))
    .limit(1)
  return p?.lat != null && p?.lng != null ? { lat: p.lat, lng: p.lng } : null
}

// Everything the builder needs off the rider's profile that is NOT the home
// seed, in one read. Two things travel together here because they come off the
// same row and the alternative was two round trips on the app's busiest page;
// they are otherwise unrelated and the comments below are per field.
//
//   publicStart — the public starting point, sent to every builder page rather
//   than only the new-ride one: an existing ride can be made public at any time,
//   and that is exactly when the swap is offered. Unlike homeSeed it is not
//   gated on a preference — it is not seeding anything, only standing by in case
//   a home-started ride is about to be shared.
//
//   durationFormat — how the stop duration field reads. Defaulted through
//   toDurationFormat rather than trusted, because a rider with no profile row at
//   all gets undefined here and every reader has to agree on what that means.
type PublicStart = { lat: number; lng: number; label: string }
type BuilderPrefs = { publicStart: PublicStart | null; durationFormat: DurationFormat; units: Units }

async function builderPrefs(userId: number): Promise<BuilderPrefs> {
  const [p] = await db
    .select({
      lat: userProfiles.startLat,
      lng: userProfiles.startLng,
      label: userProfiles.startLabel,
      durationFormat: userProfiles.durationFormat,
      units: userProfiles.units,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
  return {
    publicStart:
      p?.lat == null || p?.lng == null ? null : { lat: p.lat, lng: p.lng, label: p.label?.trim() || 'Meeting point' },
    durationFormat: toDurationFormat(p?.durationFormat),
    units: toUnits(p?.units),
  }
}

builderRoutes.get('/builder', requireActive, async (c) => {
  const user = currentUser(c)
  const [home, prefs] = await Promise.all([homeSeed(user.id), builderPrefs(user.id)])
  return c.html(builderHtml(null, user, home, prefs))
})

builderRoutes.get('/builder/:id', requireActive, async (c) => {
  const user = currentUser(c)
  const found = await builderRide(user.id, c.req.param('id'))
  // `view` is the floor, not `edit`. A member below `edit` gets the SAME PAGE
  // with its writes turned off rather than a redirect to the viewer: comments
  // and suggestions both hang off the row list and the stop details, so the
  // viewer is a dead end and the redirect would only have to be built twice.
  if (!found || !canViewAsMember(found.member)) return c.text('Not found', 404)
  const { ride, member } = found
  return c.html(
    builderHtml(ride.id, user, null, await builderPrefs(user.id), ride.slug, {
      canEdit: canEditAsMember(member),
      isOwner: canAdminister(member),
      // A rider always knows their OWN rung — it is what the banner says. It is
      // everyone else's that is the owner's business; see canSeePerms.
      perm: member?.role === 'owner' ? null : (member?.perm ?? null),
    }),
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
  home: { lat: number; lng: number } | null,
  prefs: BuilderPrefs,
  // The ride's slug, for the roster link. Null on a new ride, which has no
  // roster to link to — and no ride, so nothing to be on.
  slug: string | null = null,
  standing: BuilderStanding = OWNS_IT,
): string {
  // The day slider is a focus control, not a navigation one: every day stays
  // drawn on the map at all times and the slider only changes which one is
  // emphasized. Seeing the whole ride on one map is the product.
  // Three bands, each naming the scope of what it holds: the ride, the day
  // across all its days, and the one day being edited. Before this the panel was
  // a flat run of divs and nothing said whether a given control changed one day
  // or the whole ride — the day scrubber sat next to the day's own color
  // picker, and the ride timeline sat between two day-level blocks.
  //
  // THE RIDE TIMELINE IS NO LONGER IN HERE. It moved to a bar across the bottom
  // edge of the map on 2026-08-15 — see rideTimeline() in src/views/layout.tsx
  // and .map-timeline in style/_map.scss. What is left in the second ride band is
  // the day scrubber alone, and the two are not the same control: the scrubber
  // picks which day you are EDITING and belongs beside the edit controls, the
  // timeline moves through what you are LOOKING AT and belongs over the map.
  // That split is what issue #93 asked for.
  //
  // THERE IS NO SAVE BUTTON, and no Discard either. The builder autosaves on
  // idle — see the autosave block in public/js/builder.js for the timing and for
  // the two conditions that hold a flush. What is left in .builder-actions is
  // undo, redo, a status readout and the link to the public page.
  //
  // Two details in that row are load-bearing rather than cosmetic, both serving
  // the rule that nothing in the panel changes size as its value changes:
  //
  //   #save-status is aria-hidden and #save-announce below it is the live
  //   region. A polite region on the readout itself would say "Unsaved changes,
  //   Saving, Saved" aloud on every edit burst — three announcements a minute
  //   for something a sighted rider takes in peripherally. The live region
  //   speaks only for an error or a blocked save, which are the states that
  //   need acting on. Its width is fixed in _builder.scss for the same reason.
  //
  //   #view-link ships from first paint and is revealed by the first successful
  //   save, using visibility rather than the hidden attribute. An element that
  //   appeared would shove the status beside it, which is the exact jump this
  //   whole epic is about.
  // THREE TABS, and the ride's own fields above them. Adding riders and groups
  // to a panel that was already the densest surface in the app turned it into a
  // scroll: the day list, the subgroup editor and a link to the roster all
  // stacked in one column, with the day you were editing pushed below the fold
  // by a feature about people. Splitting it means only one of the three is ever
  // paying for vertical space.
  //
  // WHAT IS ABOVE THE STRIP BELONGS TO THE RIDE, not to any tab: the description
  // and the visibility select. Putting them inside Routes would have said they
  // were about the route, which visibility in particular is not — it is the
  // single most consequential control in the panel and it governs the whole
  // package. They cost every tab a couple of lines, which is the trade.
  //
  // DELETE IS BELOW THE PANELS, not above the strip with the other two ride-level
  // controls and not in any tab. Same reasoning it has always had: a destructive
  // control wants distance from the rows a pointer lives in, and directly under
  // the ride's name is the least distance available.
  //
  // The strip is buttons with role="tab", not links and not a <details> each.
  // Links would need a URL per tab and the builder has one page with unsaved
  // state in it; three disclosures would let a rider open all three and be back
  // where they started. Roving tabindex, arrow keys and aria-selected are wired
  // by initTabs() in builder.js — nothing here is decorative.
  const tabs = `        <div class="panel-tabs" role="tablist" aria-label="Builder sections">
          <button type="button" class="panel-tab is-active" role="tab" id="tab-routes"
                  aria-controls="panel-routes" aria-selected="true">Routes</button>
          <button type="button" class="panel-tab" role="tab" id="tab-groups"
                  aria-controls="panel-groups" aria-selected="false" tabindex="-1">Groups <span class="tab-count" id="sg-count"></span></button>
          <button type="button" class="panel-tab" role="tab" id="tab-riders"
                  aria-controls="panel-riders" aria-selected="false" tabindex="-1">Riders <span class="tab-count" id="riders-count"></span></button>
        </div>`

  // ROUTES. Everything that was in the panel about the road: the day list, the
  // select-mode action bar, and + Day.
  //
  // THE SEARCH BOX THAT WAS ONCE HERE IS GONE, and its absence is the point.
  // One field above the day list had to guess which day a searched address
  // belonged to, and it guessed "whichever you touched last" — invisible until
  // it is wrong, which is the moment you scroll to day 4, type an address and
  // watch it land on day 2.
  //
  // Every day now ends in its own search row, built by addRowHtml() in
  // builder.js, which knows its day and says so. The results dropdown is created
  // once on demand and moved to whichever row is asking; it is not in this
  // markup because no row owns it.
  //
  // EVERY DAY, ALL THE TIME. This was one #day-band showing whichever day a
  // slider at the bottom of the drawer had selected; the slider is gone and
  // renderDays() in builder.js fills #day-list with one .day-section per day
  // instead. A fixed-height drawer has room to show the whole ride, so hiding
  // all but one of its days was a constraint of the old floating panel rather
  // than a decision.
  //
  // The per-day controls are CLASSES, not ids—there are N of each—and every
  // section and row carries data-day. wireDays() delegates on the container and
  // reads that attribute, which is also what keeps the existing edit handlers
  // correct: touching anything inside a section makes that day active first, so
  // editIndex() resolves to it.
  const routesTab = `        <div class="panel-tabpanel is-active" role="tabpanel" id="panel-routes" aria-labelledby="tab-routes" tabindex="0">
          <div class="tab-actions">
            ${faqLink('waypoint-poi-stop', 'the difference between a stop and a POI')}
            <button type="button" class="day-add" id="day-add" title="Add a day">+ Day</button>
          </div>

          <!-- Select mode's action bar, filled by renderSelectBar() in builder.js
               and hidden whenever state.select is null. It sits above the day
               list rather than floating over it so it cannot cover the very rows
               being ticked. -->
          <div class="select-bar" id="select-bar" hidden></div>

          <div class="day-list" id="day-list" data-duration-format="${prefs.durationFormat}"></div>
          <p class="day-empty-hint" id="day-empty-hint" hidden>No days yet.</p>
        </div>`

  // GROUPS (#67). A named set of riders sharing an approach; a day belongs to
  // one or to nobody, and nobody means everyone rides it.
  //
  // THIS WAS A COLLAPSED <details> AND IS NOW A TAB BODY. The disclosure existed
  // so a solo ride would not pay a line of panel for a feature about groups —
  // a tab costs that line whatever is inside it, so the argument has moved: what
  // renderSubgroups() writes when there are none is a sentence explaining what a
  // group is for, which is a better use of a tab nobody opened than an empty
  // box. The count in the strip is what a solo rider reads instead, and it is
  // empty until there is something to count.
  const groupsTab = `        <div class="panel-tabpanel" role="tabpanel" id="panel-groups" aria-labelledby="tab-groups" tabindex="0" hidden>
          <div id="sg-body"></div>
          <div class="tab-actions">
            <button type="button" class="btn btn-sm btn-quiet" id="sg-add">Add a group</button>
          </div>
        </div>`

  // RIDERS. Who is coming, what they are bringing, and which approach they are
  // on — filled by renderRiders() in builder.js from /api/rides/:id/riders.
  //
  // NOT A SECOND ROSTER PAGE. The two verbs that work in here are the two that
  // are about the PLAN: assigning a rider to a subgroup, and taking somebody off
  // the ride. RSVP, bike, invite and the vote are statements by a rider rather
  // than decisions by the planner, and they stay on /m/:slug/riders, which is
  // also the only rider surface a non-owner can reach at all. See the header of
  // src/routes/roster.tsx.
  //
  // EMPTY UNTIL THE RIDE HAS BEEN SAVED ONCE, because until then there is no
  // ride row and so no roster — seedOwner() runs inside the transaction that
  // inserts the ride, so the moment there IS one it has the owner on it and this
  // is never empty again. The autosave makes that a few seconds on a new ride,
  // which is why the placeholder says "once it saves" rather than asking the
  // rider to do something.
  const ridersTab = `        <div class="panel-tabpanel" role="tabpanel" id="panel-riders" aria-labelledby="tab-riders" tabindex="0" hidden>
          <div id="riders-body"></div>
        </div>`

  // WHAT THIS RIDER MAY DO, said once at the top of the panel.
  //
  // Only for somebody who is not the owner. An owner does not need telling they
  // own the ride, and a line saying so on every builder load is a line every
  // rider reads once and then stops seeing — which is how a banner that DOES
  // matter gets missed.
  //
  // It names the rider's OWN rung and nobody else's. A rung is administration
  // and belongs to the owner; see canSeePerms in src/members/policy.ts.
  const standingBanner = standing.isOwner
    ? ''
    : `        <div class="builder-standing">
          <strong>${standing.canEdit ? 'You can edit this ride' : PERM_LABELS[standing.perm ?? DEFAULT_PERM]}</strong>
          <span>${
            standing.canEdit
              ? 'It belongs to someone else, so sharing, the roster and deleting stay&nbsp;theirs.'
              : 'You are looking at someone else&rsquo;s ride. Nothing you do here is&nbsp;saved.'
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
            <select id="ride-visibility" name="visibility" title="Visibility">
              <option value="private" selected>Private</option>
              <option value="friends">Friends</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>${faqLink('visibility', 'private, friends, unlisted and public')}
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
  // per-day zips all sit behind getViewable(), so a private ride's own owner
  // could already download it by typing the URL. The export cart on /import is
  // a multi-ride picker built for batches, not for the ride you have open.
  //
  // NOT GATED ON `edit`. Anyone who can open this builder can already reach
  // these URLs, and the read-only builder is what a view-, comment- or
  // suggest-level rider gets. A control that hid what the address bar offers
  // would be theatre.
  //
  // `?dl` is what turns each one into a download rather than a render; the
  // filename comes from src/maps/filename.ts server-side.
  //
  // The hrefs are filled in by the FIRST SAVE on a new ride, exactly as the
  // View link is — see showViewLink() in builder.js. A ride with no slug has
  // nothing to export yet, so the block renders hidden and reveals itself the
  // moment there is something behind it.
  `        <details class="builder-export" id="builder-export"${slug ? '' : ' hidden'}>
          <summary>Export this ride</summary>
          <div class="builder-export-body">
            <p class="field-hint">
              An imported ride hands back the file you uploaded until you edit it here; after that it is built from
              your&nbsp;ride.
            </p>
            <ul class="builder-export-list">
              ${
                // Labeled explicitly rather than by uppercasing the path
                // segment: that produced "GEOJSON", which is not how the format
                // writes its own name and reads as shouting beside GPX.
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
                      ` <a class="export-zip" data-export="zip/${f}" href="${slug ? `/api/public/maps/${encodeURIComponent(slug)}/zip/${f}` : '#'}">one file per day</a></li>`,
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
          <button type="button" id="ride-delete" class="linkbtn">Delete this ride</button>
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

  // THE RIDE'S NAME IS THE HEADING. It used to say "Edit ride" on the most
  // prominent line in the panel and put the actual name in an input below it,
  // spending the largest type in the app on a label the rider already knew — and
  // on a new ride there was no heading at all, so a collapsed panel showed
  // nothing. The viewer has always titled itself with the ride's name; this is
  // the builder catching up, with the difference that its copy is editable.
  //
  // The input IS the heading rather than something a pencil reveals. A reveal
  // would be a second mode and a layout jump, which is the exact thing item 16
  // exists to remove; instead the field is styled as the heading, carries no
  // border until it is hovered or focused, and shows the pencil as an affordance.
  // Nothing moves when it is edited.
  //
  // The summary line follows it, out of the band below both sliders where it
  // used to sit. Both are outside .panel-contents-wrapper, so they stay put while
  // the stop list scrolls — renderTotals() writes #totals by id and did not care
  // that it moved.
  //
  // IT IS A TEXTAREA, NOT A TEXT INPUT, and that is the only way to have it wrap.
  // An <input> is a single-line replaced element by definition: it will ellipsize
  // a long name but it will never break one onto a second line, so a rider naming
  // a ride "Big Sur and back the inland way" saw about half of it. The heading
  // came down 25% at the same time and now runs to two lines before it truncates.
  //
  // Being a textarea costs three things, all handled in builder.js: Enter has to
  // be swallowed or it puts a newline in a ride's name, pasted newlines have to be
  // flattened, and the height has to be set from scrollHeight on every edit since
  // a textarea does not size itself. `rows="1"` is the floor that fitTitle()
  // grows from; the two-line ceiling is a max-height in _builder.scss.
  const titleHtml = `<textarea id="ride-title" name="title" maxlength="150" rows="1" wrap="soft"
             placeholder="${rideId ? 'Untitled ride' : 'Plan a ride'}" autocomplete="off" spellcheck="false"
             aria-label="Ride name" title="Ride name—click to edit"></textarea>
          <div class="totals" id="totals"></div>`

  // PINNED TO THE DRAWER'S BOTTOM EDGE, not scrolled with the day list.
  // It was `position: sticky; bottom: 0` inside .panel-contents-wrapper, which
  // is close but not the same thing: a sticky element still belongs to the
  // scroller, so it sat above the scrollbar and shifted with the list's own
  // padding. As the drawer's footer it is a sibling of the scroller and cannot
  // move at all.
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
               the button's color—including the 0.35 opacity of the disabled
               state. An <img> cannot inherit color and would stay black while
               the button grayed out around it. -->
          <button id="undo" class="btn-icon" type="button" disabled title="Nothing to undo" aria-label="Undo"><span class="tb-inline-icon" data-icon="icon-undo.svg"></span></button>
          <button id="redo" class="btn-icon" type="button" disabled title="Nothing to redo" aria-label="Redo"><span class="tb-inline-icon" data-icon="icon-redo.svg"></span></button>
          <span id="save-status" class="save-status" data-state="new" aria-hidden="true">
            <span class="save-dot"></span>
            <span class="save-text">Not saved yet</span>
          </span>
          <a id="view-link" class="view-link is-empty" href="#" target="_blank" rel="noopener">View</a>
        </div>`

  return page({
    title: rideId ? 'Edit ride' : 'Plan a ride',
    user,
    variant: 'map',
    bodyClass: 'builder-page',
    navKey: 'builder',
    // The floating way into the intake. 'planning' matches areaFromPath() in
    // src/feedback/policy.ts, which is what the account-menu path infers.
    feedbackArea: 'planning',
    noscript: 'JavaScript is required to plan a ride.',
    body: `  <div id="map"></div>\n\n  ${panelShell({
      titleHtml,
      extraClass: 'builder-panel',
      contents,
      footer: builderActions,
      // THE FOOTER IS THE ACTION BAR. The day scrubber lived here for about an hour on 2026-08-16,
      // pinned to the drawer's bottom edge so it could not be shoved around by
      // the day band it selected. Showing every day at once removed the thing it
      // selected between, so the control went with it.
      //
      // The rail keeps a dot per day, but as a jump-to rather than a picker:
      // clicking one scrolls that day's section into view and makes it active.
      rail: `<div class="rail-days" id="rail-days"></div>`,
    })}\n\n  ${rideTimeline()}`,
    tb: {
      gmapsKey: GMAPS_KEY,
      mapId: GMAPS_MAP_ID,
      roles: ROLE_META,
      dayColors: DAY_COLORS,
      rideId,
      // For the Riders tab's link to the roster page. Null on a new ride, which
      // has no slug yet — showViewLink() in builder.js fills it in on the first
      // successful save, the same moment the View link is revealed.
      slug,
      home,
      publicStart: prefs.publicStart,
      durationFormat: prefs.durationFormat,
      units: prefs.units,
      // WHAT THIS RIDER MAY DO, and it is a hint rather than the gate. The
      // server refuses a write from a rider below `edit` whatever the page
      // believes — see the PUT — and this is here so the page does not offer an
      // action that would then be refused, and does not autosave into a 404.
      canEdit: standing.canEdit,
      isOwner: standing.isOwner,
      perm: standing.perm,
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
    scripts: `${googleMapsLoader(GMAPS_KEY)}
  <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.7/Sortable.min.js" integrity="sha384-DgmC6Xe2bSN2WjTDXzWYbUbxyhNP+NNkGDR/g78pCXV7E7rcVTGxVg0uIVCUUcBc" crossorigin="anonymous" defer></script>
  <script src="${asset('/js/tabs.js')}" defer></script>
  <script src="${asset('/js/map-common.js')}" defer></script>
  <script src="${asset('/js/ride-time.js')}" defer></script>
  <script src="${asset('/js/duration.js')}" defer></script>
  <script src="${asset('/js/twist.js')}" defer></script>
  <script src="${asset('/js/builder-history.js')}" defer></script>
  <script src="${asset('/js/route-shape.js')}" defer></script>
  <script src="${asset('/js/drag-index.js')}" defer></script>
  <script src="${asset('/js/alts.js')}" defer></script>
  <script src="${asset('/js/place-query.js')}" defer></script>
  <script src="${asset('/js/day-clock.js')}" defer></script>
  <script src="${asset('/js/builder.js')}" defer></script>`,
  })
}
