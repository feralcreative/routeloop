// The ride graph: the shape the builder saves, the rules it must satisfy, and
// the code that writes it to the database.
//
// Extracted from rides.ts so the importer can reuse it. A native Routeloop JSON
// file is this payload exactly, so importing one is the same validation and the
// same insert the builder's save runs — not a second path that agrees with it
// today and drifts tomorrow. rides.ts already imports from routes/maps.ts, so
// leaving this there and importing it back would have been a cycle.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
// Only the transaction type is needed here; the queries all run on the `tx`
// the caller passes in.
import type { db } from '../db/index'
import { days as daysTable, pointDetails, points as pointsTable, routeLegs, timeAnchorEnum } from '../db/schema'
import { METERS_PER_MILE, sanitizeText, trackMeters, round6, type Track } from './kml'
import { MAX_ROLES_PER_POINT, ROLES } from './roles'
import { twistiness } from './twist'
import { fields } from './fields'
import { activeDays, resolveAltGroups } from './alts'
import { ensureUids } from './uid'
import { reconcileVotes } from '../votes/service'
import { demoteOrphanComments } from '../comments/service'
import { reconcileSubgroups, writeRideAnchors } from '../subgroups/service'

// 31 rather than 30: a month-long ride plus the day you get home.
export const MAX_DAYS = 31

// One cap over both kinds now that a day is one ordered list. It is the old
// MAX_STOPS plus MAX_POIS, so no ride that was legal before this change becomes
// illegal after it — the two caps could each be met independently.
export const MAX_POINTS = 400
// Kept, but the reason changed on 2026-08-24. It used to bound promotion — a day
// of 400 POIs must not become 400 routing anchors and 399 Directions calls — and
// that no longer applies: 400 points are 399 legs whatever their kinds, and
// promoting one is a flag flip that routes nothing. What it still bounds is the
// surfaces that count stops rather than points: rides.stop_count, the roadbook's
// numbered rows, and the Google Maps hand-off.
export const MAX_STOPS = 200
export const MAX_VIAS_PER_LEG = 20
export const MAX_PTS_PER_LEG = 25000
export const MAX_PTS_PER_RIDE = 200000

// --- Payload schema --------------------------------------------------------

const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])

// Up to five {label, url} pairs on a stop — a booking link, a menu, a map. The
// cap is here rather than only in the UI because this schema is also what a
// native JSON import is validated against.
export const MAX_LINKS_PER_POINT = 5

// The private half of a stop. Optional throughout: a payload from a client that
// predates this feature carries no `details` at all, and a stop with nothing
// filled in carries an empty object rather than being a special case.
//
// Every string is trimmed and empty-to-null'd at persist time, so a rider
// clearing a field removes the row's value instead of storing ''.
const detailsSchema = z.object({
  confirmation: z.string().max(120).default(''),
  checkInAt: z.iso.datetime({ offset: true }).nullable().default(null),
  checkOutAt: z.iso.datetime({ offset: true }).nullable().default(null),
  phone: z.string().max(40).default(''),
  address: z.string().max(300).default(''),
  // `fields.external_url` and not a looser string: this value is rendered as an
  // href, so http(s)-only is the rule, and reusing the ride-level one is what
  // stops the two drifting. sanitizeText only removes the COLON from a
  // `javascript:` — enough for prose, not enough for an attribute.
  links: z
    .array(z.object({ label: z.string().max(60).default(''), url: fields.external_url.default('') }))
    .max(MAX_LINKS_PER_POINT)
    .default([]),
  notes: z.string().max(2000).default(''),
})

export type PointDetailsInput = z.infer<typeof detailsSchema>

const pointSchema = z.object({
  // THE ONLY THING THAT MAKES A POINT A STOP. Ziad's call, 2026-08-23: a point
  // is created as a POI and promoted later, so the kind is a flag on an element
  // of one ordered list rather than a choice of which list to put it in.
  //
  // Defaults to 'poi' — the baseline type. A payload from an older client, or a
  // native JSON file written before this shipped, is merged into this shape by
  // the reader, which stamps the kind explicitly; nothing relies on the default
  // to classify a legacy point.
  kind: z.enum(['stop', 'poi']).default('poi'),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  name: z.string().max(255).default(''),
  description: z.string().max(2000).default(''),
  roles: z.array(z.enum(ROLES)).max(MAX_ROLES_PER_POINT).default([]),
  durationMin: z.number().int().min(0).max(43200).nullable().default(null), // ≤ 30 days
  // Meaningful on a meeting point and nowhere else, and null is not zero — see
  // points.slack_min in src/db/schema.ts. Optional and defaulted so every native
  // file and every in-flight save from an older tab stays valid.
  slackMin: z.number().int().min(0).max(1440).nullable().default(null),
  // The point's durable identity — see src/maps/uid.ts. Optional in the payload
  // and repaired by ensureUids() rather than rejected: an old tab, an old native
  // JSON file and an import from another app all arrive without one, and a
  // rider who duplicated a stop arrives with two the same.
  uid: z.string().max(12).nullable().default(null),
  details: detailsSchema.nullable().default(null),
})
// A POI carries a duration, the same as a stop, and is routed through the same
// way. `kind` says only whether the rider plans to STOP there — Ziad's call,
// 2026-08-24. It no longer touches the router.
export type PointInput = z.infer<typeof pointSchema>

/**
 * The stops of a day, in order.
 *
 * NOT the leg math any more. Every point anchors a leg as of 2026-08-24, so this
 * survives for the surfaces that care whether a rider means to stop: the
 * `rides.stop_count` cache, the roadbook's numbered rows, the hand-off to Google
 * Maps, and the at-least-one-stop rule below.
 */
export const stopsOf = <T extends { kind: 'stop' | 'poi' }>(points: T[]): T[] =>
  points.filter((pt) => pt.kind === 'stop')

const legSchema = z.object({
  geometry: z.array(lngLat).min(2).max(MAX_PTS_PER_LEG),
  distanceM: z.number().int().min(0),
  durationS: z.number().int().min(0),
  viaPoints: z.array(lngLat).max(MAX_VIAS_PER_LEG).default([]),
})

const daySchema = z
  .object({
    // WHOSE DAY THIS IS, by the subgroup's uid rather than its id — the client
    // mints a subgroup and tags days with it before the server has ever seen
    // one, so an id could not appear here. Null means everyone rides it, which
    // is what every day of every ride that predates #67 carries.
    subgroupUid: z.string().max(12).nullable().default(null),
    // The day's durable identity — see src/maps/uid.ts. Optional and repaired
    // rather than rejected, for exactly the reasons a point's is: an old tab, a
    // native JSON file written before this shipped, and every lossy import
    // arrive without one. ensureUids() settles them per ride below.
    uid: z.string().max(12).nullable().default(null),
    title: z.string().max(150).default(''),
    color: fields.color.default('#0000cc'),
    startAt: z.iso.datetime({ offset: true }).nullable().default(null),
    endAt: z.iso.datetime({ offset: true }).nullable().default(null),
    // ONE ORDERED LIST. The array order IS the rider's order, for both kinds.
    points: z.array(pointSchema).min(1).max(MAX_POINTS),
    legs: z.array(legSchema),
    // ALTERNATES. Both default, which is what keeps every native JSON file a
    // rider already downloaded — and every in-flight save from a tab opened
    // before this shipped — valid without a format-version bump.
    //
    // Bounded to the day cap because the value is a partition key the server
    // renumbers densely anyway (see resolveAltGroups); the bound is only here so
    // a hostile payload cannot write an arbitrary smallint into the column.
    //
    // No .refine() for group validity, deliberately. A refine can only reject,
    // and the shapes it would reject — a group of one, two members briefly
    // claiming active — are exactly what a rider passes through mid-edit while
    // the autosave fires. normalize() repairs them instead.
    altGroup: z
      .number()
      .int()
      .min(0)
      .max(MAX_DAYS - 1)
      .nullable()
      .default(null),
    altActive: z.boolean().default(true),
  })
  // LEGS CONNECT CONSECUTIVE POINTS, both kinds. A POI is something the rider
  // will at least ride BY — it is always part of the route, just not necessarily
  // somewhere they stop — so `legs[i]` joins `points[i]` to `points[i+1]`
  // whatever kind either end is. Ziad's call, 2026-08-24.
  //
  // This used to count in stops, and the consequence was the report that changed
  // it: a new day with a start and one POI drew two dots and no road, because
  // there was nothing the router had been asked to join.
  .refine((r) => r.legs.length === Math.max(0, r.points.length - 1), {
    message: 'legs must connect consecutive points (points - 1 legs)',
  })
  // Still capped, though it no longer bounds the leg array — MAX_POINTS does
  // that. This bounds the roadbook's numbered rows and the hand-off URL.
  .refine((r) => stopsOf(r.points).length <= MAX_STOPS, {
    message: `a day may have at most ${MAX_STOPS} stops`,
  })
  // AT LEAST ONE STOP PER DAY. Note this is no longer about routing: a day of
  // nothing but POIs draws a complete road now, because every point anchors a
  // leg. It survives for the surfaces that count stops rather than points — the
  // roadbook numbers its rows from them, the Google Maps hand-off is built from
  // them, and `start`/`finish` are roles on a stop.
  //
  // The builder upholds it by promoting the first point of every day on the spot,
  // so a rider never meets this message; it is here for a hand-written payload
  // and for a native file from some future client.
  .refine((r) => stopsOf(r.points).length >= 1, {
    message: 'a day needs at least one stop',
  })

/** A named set of riders sharing an approach. Ids never appear in a payload —
 *  the client has not seen them and must not have to. */
const subgroupSchema = z.object({
  uid: z.string().max(12),
  name: z.string().trim().min(1).max(80),
  color: fields.color.default('#0066cc'),
})

export const ridePayload = z
  .object({
    title: fields.title,
    description: fields.description.default(''),
    visibility: fields.visibility.default('private'),
    external_url: fields.external_url.default(''),
    // SUBGROUPS ARE RIDE-LEVEL, not day-level, because several days reference
    // one and a rider is assigned to one across the whole ride. Bounded to the
    // day cap for the same reason alt_group is: a hostile payload should not be
    // able to insert an arbitrary number of rows.
    subgroups: z.array(subgroupSchema).max(MAX_DAYS).default([]),
    // Which subgroup's clock is pinned, and whose route is the spine. Two keys
    // although the builder asks once — see rides.primary_subgroup_id.
    primarySubgroup: z.string().max(12).nullable().default(null),
    trunkSubgroup: z.string().max(12).nullable().default(null),
    timeAnchor: z.enum(timeAnchorEnum.enumValues).default('departure'),
    days: z.array(daySchema).min(1).max(MAX_DAYS),
  })
  .refine(
    (p) => p.days.reduce((n, r) => n + r.legs.reduce((m, l) => m + l.geometry.length, 0), 0) <= MAX_PTS_PER_RIDE,
    { message: `ride exceeds ${MAX_PTS_PER_RIDE} track points` },
  )

export type RidePayload = z.infer<typeof ridePayload>

// --- Integrity + persistence ----------------------------------------------

// Normalizes a validated payload in place: rounds coordinates, sanitizes all
// user text, and clamps client-claimed leg distances to reality — Directions
// distances are authoritative in the honest case, but a claimed value that
// deviates > 15 % from the haversine length of the submitted geometry is
// replaced by the haversine value, so spoofing is bounded.
export function normalize(p: RidePayload): void {
  for (const r of p.days) {
    r.title = sanitizeText(r.title)
    for (const s of r.points) {
      s.lat = round6(s.lat)
      s.lng = round6(s.lng)
      s.name = sanitizeText(s.name)
      s.description = sanitizeText(s.description)
    }
    for (const l of r.legs) {
      l.geometry = l.geometry.map(([lng, lat]) => [round6(lng), round6(lat)])
      l.viaPoints = l.viaPoints.map(([lng, lat]) => [round6(lng), round6(lat)])
      const actual = Math.round(trackMeters(l.geometry as Track))
      if (actual > 0 && Math.abs(l.distanceM - actual) > actual * 0.15) l.distanceM = actual
    }
  }
  // Last, and before rideTotals runs: a group of one is dissolved, exactly one
  // member of each surviving group is active, and the ids come out dense. The
  // totals below count active days only, so the election has to have happened
  // by the time they are computed. See src/maps/alts.ts.
  resolveAltGroups(p.days)
}

// Ride-level caches derived from the normalized payload.
//
// ACTIVE DAYS ONLY. A ride carrying two alternates for the same stretch would
// otherwise report both — the total is what a rider is going to ride, not the
// sum of everything they considered. Run normalize() first: this trusts that
// exactly one member of each group is flagged active, which is resolveAltGroups'
// job and not this function's.
//
// `stops` is filtered for the same reason and it is easy to miss: rides.stop_count
// feeds the ride cards and the ride list, so a losing alternate's stops would
// inflate a count nobody would think to question.
export function rideTotals(p: RidePayload) {
  let meters = 0
  let seconds = 0
  let stops = 0
  for (const r of activeDays(p.days)) {
    meters += r.legs.reduce((n, l) => n + l.distanceM, 0)
    seconds += r.legs.reduce((n, l) => n + l.durationS, 0)
    // Dwell from BOTH kinds: time spent at a viewpoint is time spent.
    seconds += r.points.reduce((n, pt) => n + (pt.durationMin ?? 0) * 60, 0)
    stops += stopsOf(r.points).length
  }
  return { totalMiles: (meters / METERS_PER_MILE).toFixed(1), totalDurationS: seconds, stopCount: stops }
}

// Inserts the ride graph. Callers run this inside a transaction,
// on a ride that has no days (fresh insert or after a full-replace delete).
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
/**
 * What a save does about `point_details`.
 *
 * `reconcile` is the owner's save and the normal case: the payload is the whole
 * truth, and a detail row whose uid is no longer in it is deleted.
 *
 * **`preserve` IS FOR A SAVE BY SOMEBODY WHO CANNOT SEE THE DETAILS, and it
 * exists to stop a silent, unrecoverable data loss.** An `edit`-level member
 * loads the ride through detailsForViewer(), which hands a non-owner an EMPTY
 * map — correctly, because a confirmation number is not shared by sharing a
 * route. Their save then posts a payload with no details in it, and a
 * reconciling write would read that as "the rider cleared every one of them"
 * and delete the lot. The owner would lose every gate code and reservation on
 * the ride, with nothing raised, because somebody they trusted to move a stop
 * moved one.
 *
 * Under `preserve` nothing in point_details is written or deleted. The cost is
 * that details belonging to a point the editor DELETED linger as orphans until
 * the owner's next save reconciles them — invisible to everyone in the meantime,
 * and the right way round: an orphan is recoverable and a deletion is not.
 */
export type DetailsMode = 'reconcile' | 'preserve'

export async function insertRideGraph(
  tx: Tx,
  rideId: number,
  p: RidePayload,
  detailsMode: DetailsMode = 'reconcile',
): Promise<void> {
  // Collected across every day and reconciled once at the end — see
  // writePointDetails below for why this cannot ride along with the points.
  const details: Array<{ uid: string; d: PointDetailsInput }> = []
  const liveUids: string[] = []
  // ONE SETTLE OVER THE WHOLE RIDE, because uq_day_ride_uid is scoped to the
  // ride. Points settle per day for the same reason theirs is scoped per day.
  const daysWithUids = ensureUids(p.days)
  const liveDayUids = daysWithUids.map((d) => d.uid)
  // BEFORE THE DAYS, because days.subgroup_id is resolved through the map this
  // returns and a payload can create a subgroup and tag a day with it in the
  // same save. Reconciled by uid rather than deleted and re-inserted like every
  // other child of a ride, because ride_members.subgroup_id points at these rows
  // — see reconcileSubgroups.
  const subgroupIds = await reconcileSubgroups(tx, rideId, p.subgroups)

  for (let ri = 0; ri < daysWithUids.length; ri++) {
    const r = daysWithUids[ri]
    const legDistM = r.legs.map((l) => l.distanceM)
    const track = r.legs.flatMap((l) => l.geometry) as Track
    const twist = twistiness(track)
    const [day] = await tx
      .insert(daysTable)
      .values({
        rideId,
        position: ri,
        uid: r.uid,
        // An unknown uid lands null — everyone rides it — rather than failing
        // the save. A client naming a subgroup it also deleted in the same
        // payload is describing a coherent intention badly, and refusing an
        // autosave the rider did not press would lose their work.
        subgroupId: r.subgroupUid ? (subgroupIds.get(r.subgroupUid) ?? null) : null,
        title: r.title,
        color: r.color,
        startAt: r.startAt ? new Date(r.startAt) : null,
        endAt: r.endAt ? new Date(r.endAt) : null,
        distanceM: legDistM.reduce((a, b) => a + b, 0),
        durationS: r.legs.reduce((n, l) => n + l.durationS, 0),
        // null rather than 0 for a day with nothing to measure — see schema.ts.
        twistinessDpm: twist?.dpm ?? null,
        twistinessBestDpm: twist?.bestDpm ?? null,
        // Written as normalize() left them. Note distance_m and duration_s above
        // are NOT zeroed for a losing alternate: they describe that day's own
        // legs, which is a true thing about it and what the viewer legend and
        // the roadbook want when they choose to show it. Only the RIDE-level
        // totals exclude it.
        altGroup: r.altGroup,
        altActive: r.altActive,
      })
      .returning()

    // Cumulative distance is the prefix sum of leg distances, and `prefix[i]` is
    // how far into the day `points[i]` sits.
    const prefix: number[] = [0]
    for (const d of legDistM) prefix.push(prefix[prefix.length - 1] + d)
    // One settle over the whole day. The unique index is per day across both
    // kinds, so the lists could never have been settled separately without
    // risking a POI and a stop sharing a uid.
    const withUids = ensureUids(r.points)

    // ONE ALGORITHM FOR BOTH KINDS, where there used to be two. A stop's
    // distance was the prefix sum of the legs before it and a POI's was its
    // projection onto the concatenated track, because a POI sat beside the route
    // and had no leg boundary of its own. Every point has one now, so the prefix
    // is the answer for all of them — and it is the better answer twice over: it
    // is exact rather than nearest-vertex, and it is never null, where a
    // projection is null on a trackless import. Promotion no longer changes a
    // point's stored distance either, which is one fewer thing a flag flip does.
    const pointRows = withUids.map((s, i) => ({
      dayId: day.id,
      kind: s.kind,
      // The rider's order, dense over both kinds.
      position: i,
      lat: s.lat,
      lng: s.lng,
      name: s.name,
      description: s.description || null,
      roles: s.roles,
      durationMin: s.durationMin,
      slackMin: s.slackMin,
      distFromStartM: prefix[Math.min(i, prefix.length - 1)],
      uid: s.uid,
    }))

    for (const s of withUids) {
      liveUids.push(s.uid)
      if (s.details) details.push({ uid: s.uid, d: s.details })
    }

    if (pointRows.length > 0) await tx.insert(pointsTable).values(pointRows)
    if (r.legs.length > 0) {
      await tx.insert(routeLegs).values(
        r.legs.map((l, i) => ({
          dayId: day.id,
          position: i,
          geometry: l.geometry as Track,
          distanceM: l.distanceM,
          durationS: l.durationS,
          viaPoints: l.viaPoints as Track,
        })),
      )
    }
  }

  // AFTER the reconcile, because a payload can create a subgroup and name it
  // primary in the same save — the id does not exist until then.
  await writeRideAnchors(tx, rideId, subgroupIds, p.primarySubgroup, p.trunkSubgroup, p.timeAnchor)
  if (detailsMode === 'reconcile') await writePointDetails(tx, rideId, details, liveUids)
  // THE THIRD RECONCILIATION, AND THE ONE THAT GOES THE OTHER WAY. The two
  // around it DELETE what has lost its uid; this one clears the anchor and keeps
  // the row. A comment is a thing a person said, and a save must not destroy
  // those — see the table's own comment in schema.ts. It runs whoever is saving,
  // owner or editor: a demotion loses nothing, so there is no `preserve` case.
  await demoteOrphanComments(tx, rideId, liveUids)
  // Same reconciliation, one level up. A vote whose day left the payload has to
  // go, or a deleted alternate keeps counting toward a tally forever — the
  // identical trap point_details carries, for the identical reason: alt_votes
  // cascades from `rides`, so a save that deletes every day takes none of them.
  await reconcileVotes(tx, rideId, liveDayUids)
}

// Empty string to null, so clearing a field removes the value rather than
// storing ''. `''` and `null` would otherwise both mean "nothing here" and every
// reader would have to test for both.
const orNull = (v: string): string | null => {
  const t = sanitizeText(v)
  return t === '' ? null : t
}

/**
 * Reconciles a ride's private stop details against the payload just written.
 *
 * This runs AFTER the day loop and outside it, and both matter.
 *
 * `point_details` is keyed by `(ride_id, uid)` and cascades from `rides`, not
 * from `days` — so the `delete(days)` that opens every save does NOT take it
 * with it, which is the whole reason a stop's confirmation number survives a
 * save at all. The flip side is that nothing else cleans it up: a stop the rider
 * deleted leaves its details behind forever unless this removes them. Hence the
 * delete-what-is-no-longer-here pass.
 *
 * A stop with no details at all writes no row rather than a row of nulls, so the
 * table holds only stops a rider actually filled something in for.
 */
async function writePointDetails(
  tx: Tx,
  rideId: number,
  details: Array<{ uid: string; d: PointDetailsInput }>,
  liveUids: string[],
): Promise<void> {
  const rows = details
    .map(({ uid, d }) => ({
      rideId,
      uid,
      confirmation: orNull(d.confirmation),
      checkInAt: d.checkInAt ? new Date(d.checkInAt) : null,
      checkOutAt: d.checkOutAt ? new Date(d.checkOutAt) : null,
      phone: orNull(d.phone),
      address: orNull(d.address),
      // A link with no URL is a label the rider started and abandoned; dropping
      // it here keeps the viewer from rendering an anchor that goes nowhere.
      links: d.links.filter((l) => l.url).map((l) => ({ label: sanitizeText(l.label), url: l.url })),
      notes: orNull(d.notes),
      updatedAt: new Date(),
    }))
    // Everything blank means the rider cleared the last field. Writing the row
    // anyway would leave a stop marked as "has details" forever.
    .filter(
      (r) => r.confirmation || r.checkInAt || r.checkOutAt || r.phone || r.address || r.notes || r.links.length > 0,
    )

  const keep = new Set(rows.map((r) => r.uid))

  // Delete first, then upsert. Two things go in this pass: details for a stop
  // that is gone from the ride, and details for a stop that is still here but
  // whose fields the rider just emptied — the filter above dropped those rows,
  // so `keep` does not contain them and this removes them.
  //
  // inArray and never a raw `= any(...)` over a JS array: drizzle expands an
  // array into a tuple, which is not valid SQL there, and it fails at runtime
  // with no type error. See AGENTS.md.
  const existing = await tx.select({ uid: pointDetails.uid }).from(pointDetails).where(eq(pointDetails.rideId, rideId))
  const doomed = existing.map((r) => r.uid).filter((uid) => !keep.has(uid))
  if (doomed.length > 0) {
    await tx.delete(pointDetails).where(and(eq(pointDetails.rideId, rideId), inArray(pointDetails.uid, doomed)))
  }

  if (rows.length > 0) {
    await tx
      .insert(pointDetails)
      .values(rows)
      .onConflictDoUpdate({
        target: [pointDetails.rideId, pointDetails.uid],
        set: {
          confirmation: sql`excluded.confirmation`,
          checkInAt: sql`excluded.check_in_at`,
          checkOutAt: sql`excluded.check_out_at`,
          phone: sql`excluded.phone`,
          address: sql`excluded.address`,
          links: sql`excluded.links`,
          notes: sql`excluded.notes`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
  }
}
