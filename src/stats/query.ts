// The dashboard's aggregates.
//
// This file is where the SQL lives and shape.ts is where the judgement lives, so
// nothing here decides anything a rider would notice — it counts, sums and hands
// over. That split is what lets the interesting half be tested with no database,
// exactly as src/survey/score.ts is.
//
// Five queries rather than one. A single statement joining rides to routes to
// points AND legs would multiply rows against each other — every leg once per
// point on the same route — and produce sums that are silently several times too
// large. That class of bug looks like enthusiasm rather than arithmetic, so the
// join fan-out is avoided rather than corrected for.
//
// Every aggregate is scoped by rides.owner_id, which is indexed (idx_owner) and
// is the only ownership concept in the schema; routes, points and legs inherit
// it through the FK chain.
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { points, rides, routeLegs, routes, users } from '../db/schema'
import { ACTIVITY_MONTHS } from './shape'
import type { RawMonth, RawRecords, RawRole, RawStats, RawTotals, RawTwist } from './shape'

/** `count(*)::int` and friends, per the house style in invites/service.ts. */
const int = (frag: ReturnType<typeof sql>) => sql<number>`coalesce(${frag}, 0)::int`
const big = (frag: ReturnType<typeof sql>) => sql<number>`coalesce(${frag}, 0)::bigint`

export async function loadStats(userId: number): Promise<RawStats> {
  const owned = eq(rides.ownerId, userId)

  const [rideRow] = await db
    .select({
      rides: int(sql`count(*)`),
      // rides.total_miles is a cache and route_legs is the authority, so mileage
      // is not read from here — only the counts and the bytes that only exist
      // at ride level.
      publicRides: int(sql`count(*) filter (where ${rides.visibility} = 'public')`),
      unlistedRides: int(sql`count(*) filter (where ${rides.visibility} = 'unlisted')`),
      privateRides: int(sql`count(*) filter (where ${rides.visibility} = 'private')`),
      views: int(sql`sum(${rides.viewCount})`),
      // A generated column: kml_bytes + gpx_bytes + source_bytes, computed by
      // Postgres and therefore incapable of drifting away from the files.
      storedBytes: big(sql`sum(${rides.sizeBytes})`),
    })
    .from(rides)
    .where(owned)

  const [routeRow] = await db
    .select({
      routes: int(sql`count(*)`),
      // distanceM here is the per-route cache; the leg sum below is the one used
      // for the hero figure. Kept for the longest-day record, where it is the
      // natural grain.
      longestDayM: int(sql`max(${routes.distanceM})`),
    })
    .from(routes)
    .innerJoin(rides, eq(rides.id, routes.rideId))
    .where(owned)

  const [legRow] = await db
    .select({
      legs: int(sql`count(*)`),
      // THE mileage authority. Directions-computed per leg, written on both the
      // builder and the import path, unlike rides.total_duration_s.
      distanceM: big(sql`sum(${routeLegs.distanceM})`),
      // How many times the rider dragged the line onto a road the router did not
      // pick. jsonb array, so its length is the count.
      viaPoints: int(sql`sum(jsonb_array_length(${routeLegs.viaPoints}))`),
    })
    .from(routeLegs)
    .innerJoin(routes, eq(routes.id, routeLegs.routeId))
    .innerJoin(rides, eq(rides.id, routes.rideId))
    .where(owned)

  const [pointRow] = await db
    .select({
      points: int(sql`count(*)`),
      stops: int(sql`count(*) filter (where ${points.kind} = 'stop')`),
      pois: int(sql`count(*) filter (where ${points.kind} = 'poi')`),
    })
    .from(points)
    .innerJoin(routes, eq(routes.id, points.routeId))
    .innerJoin(rides, eq(rides.id, routes.rideId))
    .where(owned)

  // Roles is a waypoint_role[] with up to 4 entries, so unnest gives one row per
  // (point, role) and the counts deliberately sum to more than the point count.
  // shape.ts surfaces that rather than hiding it.
  const roleRows = await db
    .select({ role: sql<string>`unnest(${points.roles})::text`, n: int(sql`count(*)`) })
    .from(points)
    .innerJoin(routes, eq(routes.id, points.routeId))
    .innerJoin(rides, eq(rides.id, routes.rideId))
    .where(owned)
    .groupBy(sql`1`)

  // Nulls filtered HERE rather than in shape.ts, so "no rows" means "nothing
  // measured" and the rollup never has to distinguish a null from a zero.
  const twistRows = await db
    .select({ dpm: sql<number>`${routes.twistinessDpm}::int`, distanceM: sql<number>`${routes.distanceM}::int` })
    .from(routes)
    .innerJoin(rides, eq(rides.id, routes.rideId))
    .where(and(owned, sql`${routes.twistinessDpm} is not null`, sql`${routes.distanceM} > 0`))

  const monthRows = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${rides.createdAt}), 'YYYY-MM')`,
      n: int(sql`count(*)`),
    })
    .from(rides)
    .where(and(owned, sql`${rides.createdAt} >= date_trunc('month', now()) - interval '${sql.raw(String(ACTIVITY_MONTHS - 1))} months'`))
    .groupBy(sql`1`)

  // The two "best ride" records, each one row. Ordered rather than aggregated so
  // the title and slug come along without a second lookup.
  const [biggest] = await db
    .select({
      m: sql<number>`coalesce(sum(${routeLegs.distanceM}), 0)::bigint`,
      title: rides.title,
      slug: rides.slug,
    })
    .from(rides)
    .innerJoin(routes, eq(routes.rideId, rides.id))
    .innerJoin(routeLegs, eq(routeLegs.routeId, routes.id))
    .where(owned)
    .groupBy(rides.id, rides.title, rides.slug)
    .orderBy(sql`1 desc`)
    .limit(1)

  const [mostViewed] = await db
    .select({ n: rides.viewCount, title: rides.title, slug: rides.slug })
    .from(rides)
    .where(owned)
    .orderBy(sql`${rides.viewCount} desc`)
    .limit(1)

  const [bestTwist] = await db
    .select({ dpm: sql<number>`max(${routes.twistinessBestDpm})::int` })
    .from(routes)
    .innerJoin(rides, eq(rides.id, routes.rideId))
    .where(owned)

  const [me] = await db
    .select({ quotaBytes: users.quotaBytes, usedBytes: users.usedBytes })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const totals: RawTotals = {
    rides: rideRow?.rides ?? 0,
    routes: routeRow?.routes ?? 0,
    legs: legRow?.legs ?? 0,
    points: pointRow?.points ?? 0,
    stops: pointRow?.stops ?? 0,
    pois: pointRow?.pois ?? 0,
    distanceM: Number(legRow?.distanceM ?? 0),
    viaPoints: legRow?.viaPoints ?? 0,
    publicRides: rideRow?.publicRides ?? 0,
    unlistedRides: rideRow?.unlistedRides ?? 0,
    privateRides: rideRow?.privateRides ?? 0,
    views: rideRow?.views ?? 0,
    storedBytes: Number(rideRow?.storedBytes ?? 0),
    quotaBytes: me?.quotaBytes ?? 0,
  }

  const records: RawRecords = {
    longestDayM: routeRow?.longestDayM || null,
    biggestRideM: biggest ? Number(biggest.m) : null,
    biggestRideTitle: biggest?.title ?? null,
    biggestRideSlug: biggest?.slug ?? null,
    bestTwistDpm: bestTwist?.dpm ?? null,
    mostViewed: mostViewed?.n ?? null,
    mostViewedTitle: mostViewed?.title ?? null,
    mostViewedSlug: mostViewed?.slug ?? null,
  }

  return {
    totals,
    twist: twistRows as RawTwist[],
    roles: roleRows as RawRole[],
    months: monthRows as RawMonth[],
    records,
  }
}

/** users.used_bytes, read separately so shape.ts can compare it against the
 *  authoritative sum and report drift. */
export async function cachedUsedBytes(userId: number): Promise<number> {
  const [row] = await db.select({ n: users.usedBytes }).from(users).where(eq(users.id, userId)).limit(1)
  return Number(row?.n ?? 0)
}
