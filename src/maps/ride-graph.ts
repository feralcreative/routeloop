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
import { days as daysTable, pointDetails, points as pointsTable, routeLegs } from '../db/schema'
import { METERS_PER_MILE, distFromStartAlongTrack, sanitizeText, trackMeters, round6, type Track } from './kml'
import { MAX_ROLES_PER_POINT, ROLES } from './roles'
import { twistiness } from './twist'
import { fields } from './fields'
import { activeDays, resolveAltGroups } from './alts'
import { ensureUids } from './uid'

// 31 rather than 30: a month-long ride plus the day you get home.
export const MAX_DAYS = 31

export const MAX_STOPS = 200
export const MAX_POIS = 200
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

const stopSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  name: z.string().max(255).default(''),
  description: z.string().max(2000).default(''),
  roles: z.array(z.enum(ROLES)).max(MAX_ROLES_PER_POINT).default([]),
  durationMin: z.number().int().min(0).max(43200).nullable().default(null), // ≤ 30 days
  // The point's durable identity — see src/maps/uid.ts. Optional in the payload
  // and repaired by ensureUids() rather than rejected: an old tab, an old native
  // JSON file and an import from another app all arrive without one, and a
  // rider who duplicated a stop arrives with two the same.
  uid: z.string().max(12).nullable().default(null),
  details: detailsSchema.nullable().default(null),
})
// A POI carries a duration now, the same as a stop. It is still not a routing
// anchor — the router never sees it and it splits no leg — but a rider who
// spends half an hour at a viewpoint has spent half an hour, and the day's end
// time has to say so.
const poiSchema = stopSchema

const legSchema = z.object({
  geometry: z.array(lngLat).min(2).max(MAX_PTS_PER_LEG),
  distanceM: z.number().int().min(0),
  durationS: z.number().int().min(0),
  viaPoints: z.array(lngLat).max(MAX_VIAS_PER_LEG).default([]),
})

const daySchema = z
  .object({
    title: z.string().max(150).default(''),
    color: fields.color.default('#0000cc'),
    startAt: z.iso.datetime({ offset: true }).nullable().default(null),
    endAt: z.iso.datetime({ offset: true }).nullable().default(null),
    stops: z.array(stopSchema).min(1).max(MAX_STOPS),
    pois: z.array(poiSchema).max(MAX_POIS).default([]),
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
  .refine((r) => r.legs.length === Math.max(0, r.stops.length - 1), {
    message: 'legs must connect consecutive stops (stops - 1 legs)',
  })

export const ridePayload = z
  .object({
    title: fields.title,
    description: fields.description.default(''),
    visibility: fields.visibility.default('private'),
    external_url: fields.external_url.default(''),
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
    for (const s of [...r.stops, ...r.pois]) {
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
    seconds += r.stops.reduce((n, s) => n + (s.durationMin ?? 0) * 60, 0)
    seconds += r.pois.reduce((n, p) => n + (p.durationMin ?? 0) * 60, 0)
    stops += r.stops.length
  }
  return { totalMiles: (meters / METERS_PER_MILE).toFixed(1), totalDurationS: seconds, stopCount: stops }
}

// Inserts the ride graph. Callers run this inside a transaction,
// on a ride that has no days (fresh insert or after a full-replace delete).
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export async function insertRideGraph(tx: Tx, rideId: number, p: RidePayload): Promise<void> {
  // Collected across every day and reconciled once at the end — see
  // writePointDetails below for why this cannot ride along with the points.
  const details: Array<{ uid: string; d: PointDetailsInput }> = []
  const liveUids: string[] = []

  for (let ri = 0; ri < p.days.length; ri++) {
    const r = p.days[ri]
    const legDistM = r.legs.map((l) => l.distanceM)
    // The same concatenation the POI projection below uses, hoisted so the
    // track is walked once for both.
    const track = r.legs.flatMap((l) => l.geometry) as Track
    const twist = twistiness(track)
    const [day] = await tx
      .insert(daysTable)
      .values({
        rideId,
        position: ri,
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

    // Stops: cumulative distance is the prefix sum of leg distances.
    const prefix: number[] = [0]
    for (const d of legDistM) prefix.push(prefix[prefix.length - 1] + d)
    // uids are settled for the day's stops and POIs TOGETHER, because the unique
    // index is per day across both kinds — settling each list separately could
    // hand a POI the same uid as a stop.
    const withUids = ensureUids([...r.stops, ...r.pois])
    const stopsU = withUids.slice(0, r.stops.length)
    const poisU = withUids.slice(r.stops.length)

    const stopRows = stopsU.map((s, i) => ({
      dayId: day.id,
      kind: 'stop' as const,
      position: i,
      lat: s.lat,
      lng: s.lng,
      name: s.name,
      description: s.description || null,
      roles: s.roles,
      durationMin: s.durationMin,
      distFromStartM: prefix[Math.min(i, prefix.length - 1)],
      uid: s.uid,
    }))

    // POIs: projected onto the route's concatenated track (built above).
    const poiDists = distFromStartAlongTrack(track, r.pois)
    const poiRows = poisU.map((s, i) => ({
      dayId: day.id,
      kind: 'poi' as const,
      position: null,
      lat: s.lat,
      lng: s.lng,
      name: s.name,
      description: s.description || null,
      roles: s.roles,
      durationMin: s.durationMin,
      distFromStartM: poiDists[i],
      uid: s.uid,
    }))

    for (const s of withUids) {
      liveUids.push(s.uid)
      if (s.details) details.push({ uid: s.uid, d: s.details })
    }

    const allPoints = [...stopRows, ...poiRows]
    if (allPoints.length > 0) await tx.insert(pointsTable).values(allPoints)
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

  await writePointDetails(tx, rideId, details, liveUids)
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
