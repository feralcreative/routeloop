// The ride graph: the shape the builder saves, the rules it must satisfy, and
// the code that writes it to the database.
//
// Extracted from rides.ts so the importer can reuse it. A native Routeloop JSON
// file is this payload exactly, so importing one is the same validation and the
// same insert the builder's save runs — not a second path that agrees with it
// today and drifts tomorrow. rides.ts already imports from routes/maps.ts, so
// leaving this there and importing it back would have been a cycle.
import { z } from 'zod'
// Only the transaction type is needed here; the queries all run on the `tx`
// the caller passes in.
import type { db } from '../db/index'
import { days as daysTable, points as pointsTable, routeLegs } from '../db/schema'
import { METERS_PER_MILE, distFromStartAlongTrack, sanitizeText, trackMeters, round6, type Track } from './kml'
import { MAX_ROLES_PER_POINT, ROLES } from './roles'
import { twistiness } from './twist'
import { fields } from './fields'
import { activeDays, resolveAltGroups } from './alternates'

// 31 rather than 30: a month-long ride plus the day you get home.
export const MAX_DAYS = 31

export const MAX_STOPS = 200
export const MAX_POIS = 200
export const MAX_VIAS_PER_LEG = 20
export const MAX_PTS_PER_LEG = 25000
export const MAX_PTS_PER_RIDE = 200000

// --- Payload schema --------------------------------------------------------

const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])

const stopSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  name: z.string().max(255).default(''),
  description: z.string().max(2000).default(''),
  roles: z.array(z.enum(ROLES)).max(MAX_ROLES_PER_POINT).default([]),
  durationMin: z.number().int().min(0).max(43200).nullable().default(null), // ≤ 30 days
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
    altGroup: z.number().int().min(0).max(MAX_DAYS - 1).nullable().default(null),
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
  // by the time they are computed. See src/maps/alternates.ts.
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
    const stopRows = r.stops.map((s, i) => ({
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
    }))

    // POIs: projected onto the route's concatenated track (built above).
    const poiDists = distFromStartAlongTrack(track, r.pois)
    const poiRows = r.pois.map((s, i) => ({
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
    }))

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
}
