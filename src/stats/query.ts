// The dashboard's aggregates.
//
// This file is where the SQL lives and shape.ts is where the judgment lives, so
// nothing here decides anything a rider would notice — it counts, sums and hands
// over. That split is what lets the interesting half be tested with no database,
// exactly as src/survey/score.ts is.
//
// Five queries rather than one. A single statement joining rides to days to
// points AND legs would multiply rows against each other — every leg once per
// point on the same day — and produce sums that are silently several times too
// large. That class of bug looks like enthusiasm rather than arithmetic, so the
// join fan-out is avoided rather than corrected for.
//
// Every aggregate is scoped by rides.owner_id, which is indexed (idx_owner) and
// is the only ownership concept in the schema; days, points and legs inherit
// it through the FK chain.
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { points, rides, routeLegs, days, users } from '../db/schema'
import { NOMINAL_SPEED_MS } from '../maps/ride-time'
import { ACTIVITY_MONTHS } from './shape'
import type { RawGlobal, RawMonth, RawRecords, RawRole, RawStats, RawTotals, RawTwist } from './shape'
import { LIVE_RIDE } from '../trash/service'

/** `count(*)::int` and friends, per the house style in invites/service.ts. */
const int = (frag: ReturnType<typeof sql>) => sql<number>`coalesce(${frag}, 0)::int`
const big = (frag: ReturnType<typeof sql>) => sql<number>`coalesce(${frag}, 0)::bigint`

export async function loadStats(userId: number): Promise<RawStats> {
  // LIVE_RIDE folded in here rather than at the sixteen call sites below, for
  // the same reason `counts` exists: every aggregate on this page already
  // narrows by owner, so narrowing by owner AND not-in-the-bin is one predicate
  // and cannot be half-applied. A trashed ride is not a ride the rider has
  // planned, so it belongs in no total, no record and no month on this page.
  const owned = and(eq(rides.ownerId, userId), LIVE_RIDE)

  // ALTERNATES. A day that lost is a road the rider decided against, so it must
  // not add to a distance, a duration or a record — this dashboard is a claim
  // about what they have planned to ride, and it is the broadest-scoped consumer
  // in the app: every ride they own, all the way back.
  //
  // A predicate on the days join rather than a column or a new query, because
  // every aggregate below already joins through days to reach rides.owner_id.
  // Cheap, and it cannot be forgotten in a query that does not join days —
  // there are none that also count distance.
  //
  // NOT applied to the point and role counts further down, and that asymmetry is
  // deliberate rather than an oversight: the rider really did plan those stops
  // and pick those roles. A stop count is a record of the work; a mileage is a
  // claim about a road. Only the second one becomes a lie when the day is not
  // ridden.
  const counts = and(owned, eq(days.altActive, true))

  const [rideRow] = await db
    .select({
      rides: int(sql`count(*)`),
      // rides.total_miles is a cache and route_legs is the authority, so mileage
      // is not read from here — only the counts and the bytes that only exist
      // at ride level.
      // FOUR COUNTS, NOT THREE. A level missing from this list is a ride
      // missing from the split entirely — the chart's total is the sum of these
      // and nothing checks it against `rides`, so the bars would quietly add up
      // to less than the library and no page would say so.
      publicRides: int(sql`count(*) filter (where ${rides.visibility} = 'public')`),
      unlistedRides: int(sql`count(*) filter (where ${rides.visibility} = 'unlisted')`),
      friendsRides: int(sql`count(*) filter (where ${rides.visibility} = 'friends')`),
      privateRides: int(sql`count(*) filter (where ${rides.visibility} = 'private')`),
      views: int(sql`sum(${rides.viewCount})`),
      // A generated column: kml_bytes + gpx_bytes + source_bytes, computed by
      // Postgres and therefore incapable of drifting away from the files.
      storedBytes: big(sql`sum(${rides.sizeBytes})`),
    })
    .from(rides)
    .where(owned)

  const [dayRow] = await db
    .select({
      days: int(sql`count(*)`),
    })
    .from(days)
    .innerJoin(rides, eq(rides.id, days.rideId))
    // A ride of three days plus two alternates is a three-day ride.
    .where(counts)

  const [legRow] = await db
    .select({
      legs: int(sql`count(*)`),
      // THE mileage authority. Directions-computed per leg, written on both the
      // builder and the import path, unlike rides.total_duration_s.
      distanceM: big(sql`sum(${routeLegs.distanceM})`),
      // How many times the rider dragged the line onto a road the router did not
      // pick. jsonb array, so its length is the count.
      viaPoints: int(sql`sum(jsonb_array_length(${routeLegs.viaPoints}))`),
      // SADDLE TIME, with the same estimate the two clients apply — see
      // src/maps/ride-time.ts. A leg with distance and no duration never came
      // back from the router, which is every leg of every imported ride, so
      // summing duration_s alone would report the builder's rides and count the
      // rest as zero. That is the undercount this figure was withheld over until
      // 2026-08-24.
      //
      // NOMINAL_SPEED_MS is BOUND rather than written into the string, so there
      // is one number and it lives in the TypeScript module the clients are
      // pinned against. A literal here would be a fourth copy nothing checks.
      durationS: big(
        sql`sum(case
              when ${routeLegs.durationS} <= 0 and ${routeLegs.distanceM} > 0
                then round(${routeLegs.distanceM}::numeric / ${NOMINAL_SPEED_MS})
              else ${routeLegs.durationS}
            end)`,
      ),
      // How much of that figure is a guess rather than a measurement, so the
      // page can say so instead of implying the whole total was measured.
      estimatedLegs: int(sql`count(*) filter (where ${routeLegs.durationS} <= 0 and ${routeLegs.distanceM} > 0)`),
    })
    .from(routeLegs)
    .innerJoin(days, eq(days.id, routeLegs.dayId))
    .innerJoin(rides, eq(rides.id, days.rideId))
    // The hero mileage figure. This is the one that would be visibly wrong.
    .where(counts)

  const [pointRow] = await db
    .select({
      points: int(sql`count(*)`),
      stops: int(sql`count(*) filter (where ${points.kind} = 'stop')`),
      pois: int(sql`count(*) filter (where ${points.kind} = 'poi')`),
    })
    .from(points)
    .innerJoin(days, eq(days.id, points.dayId))
    .innerJoin(rides, eq(rides.id, days.rideId))
    .where(owned)

  // Roles is a waypoint_role[] with up to 4 entries, so unnest gives one row per
  // (point, role) and the counts deliberately sum to more than the point count.
  // shape.ts surfaces that rather than hiding it.
  const roleRows = await db
    .select({ role: sql<string>`unnest(${points.roles})::text`, n: int(sql`count(*)`) })
    .from(points)
    .innerJoin(days, eq(days.id, points.dayId))
    .innerJoin(rides, eq(rides.id, days.rideId))
    .where(owned)
    .groupBy(sql`1`)

  // Nulls filtered HERE rather than in shape.ts, so "no rows" means "nothing
  // measured" and the rollup never has to distinguish a null from a zero.
  const twistRows = await db
    .select({ dpm: sql<number>`${days.twistinessDpm}::int`, distanceM: sql<number>`${days.distanceM}::int` })
    .from(days)
    .innerJoin(rides, eq(rides.id, days.rideId))
    // Distance-weighted in shape.ts, so a losing alternate would not merely be
    // counted — it would drag the mean toward whatever its own roads were like.
    .where(and(counts, sql`${days.twistinessDpm} is not null`, sql`${days.distanceM} > 0`))

  const monthRows = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${rides.createdAt}), 'YYYY-MM')`,
      n: int(sql`count(*)`),
    })
    .from(rides)
    .where(
      and(
        owned,
        sql`${rides.createdAt} >= date_trunc('month', now()) - interval '${sql.raw(String(ACTIVITY_MONTHS - 1))} months'`,
      ),
    )
    .groupBy(sql`1`)

  // ALL FOUR records, each one row. Ordered rather than aggregated so the title,
  // the slug and the thumbnail hash come along without a second lookup.
  //
  // Two of these were `max()` until 2026-08-26 and gave a figure with no way
  // back to the road it was set on. Now that every record shows the map of the
  // ride that holds it, an aggregate cannot answer the question — so the longest
  // day and the twistiest stretch moved to the shape the two "best ride" records
  // always had. The figures are identical: `order by x desc limit 1` reads the
  // same row `max(x)` measures.
  const [longestDay] = await db
    .select({
      // The per-day cache, which is the natural grain for this record; the leg
      // sum further up is the one behind the hero figure.
      m: days.distanceM,
      title: rides.title,
      slug: rides.slug,
      thumbHash: rides.thumbHash,
    })
    .from(days)
    .innerJoin(rides, eq(rides.id, days.rideId))
    // Both figures: a ride of three days plus two alternates is a three-day
    // ride, and a losing alternate that happens to be the longest would claim
    // the record for a road nobody rides.
    .where(counts)
    .orderBy(sql`${days.distanceM} desc`)
    .limit(1)

  const [biggest] = await db
    .select({
      m: sql<number>`coalesce(sum(${routeLegs.distanceM}), 0)::bigint`,
      title: rides.title,
      slug: rides.slug,
      thumbHash: rides.thumbHash,
    })
    .from(rides)
    .innerJoin(days, eq(days.rideId, rides.id))
    .innerJoin(routeLegs, eq(routeLegs.dayId, days.id))
    .where(counts)
    .groupBy(rides.id, rides.title, rides.slug, rides.thumbHash)
    .orderBy(sql`1 desc`)
    .limit(1)

  const [mostViewed] = await db
    .select({ n: rides.viewCount, title: rides.title, slug: rides.slug, thumbHash: rides.thumbHash })
    .from(rides)
    .where(owned)
    .orderBy(sql`${rides.viewCount} desc`)
    .limit(1)

  // "The best twenty miles you have planned" should not be a road the rider
  // looked at and rejected.
  //
  // `is not null` in the predicate rather than `nulls last` alone: this row is
  // read for its slug as well as its figure, so a library with nothing measured
  // has to come back as no row rather than as a ride with a null dpm.
  const [bestTwist] = await db
    .select({
      dpm: sql<number>`${days.twistinessBestDpm}::int`,
      slug: rides.slug,
      thumbHash: rides.thumbHash,
    })
    .from(days)
    .innerJoin(rides, eq(rides.id, days.rideId))
    .where(and(counts, sql`${days.twistinessBestDpm} is not null`))
    .orderBy(sql`${days.twistinessBestDpm} desc`)
    .limit(1)

  const [me] = await db
    .select({ quotaBytes: users.quotaBytes, usedBytes: users.usedBytes })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const totals: RawTotals = {
    rides: rideRow?.rides ?? 0,
    days: dayRow?.days ?? 0,
    legs: legRow?.legs ?? 0,
    points: pointRow?.points ?? 0,
    stops: pointRow?.stops ?? 0,
    pois: pointRow?.pois ?? 0,
    distanceM: Number(legRow?.distanceM ?? 0),
    viaPoints: legRow?.viaPoints ?? 0,
    durationS: Number(legRow?.durationS ?? 0),
    estimatedLegs: legRow?.estimatedLegs ?? 0,
    publicRides: rideRow?.publicRides ?? 0,
    unlistedRides: rideRow?.unlistedRides ?? 0,
    friendsRides: rideRow?.friendsRides ?? 0,
    privateRides: rideRow?.privateRides ?? 0,
    views: rideRow?.views ?? 0,
    storedBytes: Number(rideRow?.storedBytes ?? 0),
    quotaBytes: me?.quotaBytes ?? 0,
  }

  const records: RawRecords = {
    // `|| null` and not `?? null`: distance_m is NOT NULL and defaults to 0, so
    // the longest day of a library with no legs is a real row reading zero, and
    // shape.ts treats a zero record as one nobody has set.
    longestDayM: longestDay?.m || null,
    longestDayTitle: longestDay?.title ?? null,
    longestDaySlug: longestDay?.slug ?? null,
    longestDayThumb: longestDay?.thumbHash ?? null,
    biggestRideM: biggest ? Number(biggest.m) : null,
    biggestRideTitle: biggest?.title ?? null,
    biggestRideSlug: biggest?.slug ?? null,
    biggestRideThumb: biggest?.thumbHash ?? null,
    bestTwistDpm: bestTwist?.dpm ?? null,
    bestTwistSlug: bestTwist?.slug ?? null,
    bestTwistThumb: bestTwist?.thumbHash ?? null,
    mostViewed: mostViewed?.n ?? null,
    mostViewedTitle: mostViewed?.title ?? null,
    mostViewedSlug: mostViewed?.slug ?? null,
    mostViewedThumb: mostViewed?.thumbHash ?? null,
  }

  return {
    totals,
    twist: twistRows as RawTwist[],
    roles: roleRows as RawRole[],
    months: monthRows as RawMonth[],
    records,
  }
}

// --- The comparison columns --------------------------------------------------

/**
 * The pool the average and the top are taken over, and the two decisions in it.
 *
 * **Every rider and every ride, private included.** Decided 2026-08-16 and
 * load-bearing: no opt-in preference, no visibility filter, no minimum cohort
 * size. This is a private beta among friends and the columns carry no names.
 * Widening or narrowing the pool later changes every number on the page, so it
 * is not to be revisited quietly.
 *
 * **The cohort is defined ONCE, as the riders who own at least one ride**, and
 * every metric is measured over that same set. `users` holds real outside signups
 * sitting at `status = 'pending'` who have never opened the app; counting them
 * would drag every average toward zero and make the column say nothing except how
 * many people signed up and did not start. "The average rider has 4 rides" is a
 * claim about riders, not about accounts.
 *
 * **ONE COHORT, NOT FOUR, and the first attempt got this wrong.** Grouping each
 * metric by owner_id independently looks equivalent and is not: a rider whose only
 * day is a losing alternate produces no row in the days query at all, so they fall
 * out of that metric's denominator while staying in the rides one. Measured rather
 * than reasoned about — marking a single day inactive in the dev corpus moved the
 * days average from 13 to 19, UPWARD, because the rider it belonged to vanished
 * from the average instead of counting as the zero they actually have. Four
 * metrics on four different denominators are four numbers a rider cannot compare
 * across a row of tiles. Each metric is now LEFT JOINed onto the cohort and
 * coalesced to 0, so a rider with none of something counts as having none of it.
 *
 * FOUR QUERIES, NOT ONE, and the file header explains why at length: joining
 * rides to days to points AND legs multiplies rows against each other and
 * produces sums several times too large, in a way that looks like enthusiasm
 * rather than arithmetic. A per-user rollup CTE feeding an aggregate has exactly
 * the same hazard — the fan-out happens inside the CTE instead of outside it.
 *
 * THE FILTER ASYMMETRY IS REPRODUCED DELIBERATELY. `rides` and `points` are
 * scoped by ownership alone; `days` and `legs` also require `days.alt_active`.
 * That is the same split loadStats() makes, and the reasoning at the top of this
 * file applies unchanged: a stop a rider planned is work they did, a mile on a
 * day they decided against is not a road they will ride. Getting this wrong here
 * would put a rider's own figure and the average on different definitions, so
 * the comparison would silently be between two different questions. Verified by
 * flipping a day to inactive and watching the filtered and unfiltered figures
 * diverge — with no losing alternates in the corpus the two are identical and a
 * missing filter would look exactly like a working one.
 */
export async function loadGlobalStats(): Promise<RawGlobal> {
  // Every rider who owns a ride, left-joined to one metric's per-rider count.
  // `coalesce(m.n, 0)` is the whole point: a rider with none of this thing counts
  // as a zero rather than disappearing from the average.
  const spread = (metric: ReturnType<typeof sql>) =>
    db
      .execute<{ avg: string | null; top: string | null }>(
        sql`select avg(coalesce(m.n, 0)) as avg, max(coalesce(m.n, 0)) as top
              from (select distinct owner_id from rides) c
              left join (${metric}) m on m.owner_id = c.owner_id`,
      )
      .then((r: any) => {
        const row = r.rows?.[0]
        return { avg: Number(row?.avg ?? 0), top: Number(row?.top ?? 0) }
      })

  const [rideSpread, daySpread, legSpread, pointSpread] = await Promise.all([
    spread(sql`select owner_id, count(*)::int as n from rides group by owner_id`),
    spread(sql`
      select r.owner_id, count(*)::int as n
        from days d join rides r on r.id = d.ride_id
       where d.alt_active
       group by r.owner_id`),
    spread(sql`
      select r.owner_id, count(*)::int as n
        from route_legs l
        join days d on d.id = l.day_id
        join rides r on r.id = d.ride_id
       where d.alt_active
       group by r.owner_id`),
    spread(sql`
      select r.owner_id, count(*)::int as n
        from points p
        join days d on d.id = p.day_id
        join rides r on r.id = d.ride_id
       group by r.owner_id`),
  ])

  return { rides: rideSpread, days: daySpread, legs: legSpread, points: pointSpread }
}

/**
 * The same figures, computed at most once a minute for the whole process.
 *
 * WORTH CACHING BECAUSE THEY DO NOT VARY BY VIEWER. Avg and top are identical
 * for every rider looking at the page and they move slowly — a new ride shifts
 * an average across the whole cohort by very little. One computation therefore
 * serves every request, and four aggregate queries per dashboard render becomes
 * four per minute.
 *
 * THE APP'S FIRST TTL CACHE, and `cachedUsedBytes` below is NOT a precedent for
 * it despite the name: that reads a denormalized column, which is a different
 * thing entirely.
 *
 * IN-PROCESS AND THEREFORE PER-REPLICA. Two replicas do the work twice and can
 * briefly disagree by one ride. That is acceptable **because this is decoration**
 * — nobody acts on it, and a stale average is indistinguishable from a fresh one
 * to the person reading it. It would not be acceptable for anything a rider makes
 * a decision from, and this comment is here so the next thing that wants a cache
 * has to make that argument on its own.
 *
 * A cold cache costs one round of queries, so a restart is not a thundering herd
 * waiting to happen — the first request pays and every other one that minute
 * does not.
 */
const GLOBAL_TTL_MS = 60_000
let globalCache: { at: number; value: RawGlobal } | null = null

export async function cachedGlobalStats(now = Date.now()): Promise<RawGlobal> {
  if (globalCache && now - globalCache.at < GLOBAL_TTL_MS) return globalCache.value
  const value = await loadGlobalStats()
  globalCache = { at: now, value }
  return value
}

/** users.used_bytes, read separately so shape.ts can compare it against the
 *  authoritative sum and report drift. */
export async function cachedUsedBytes(userId: number): Promise<number> {
  const [row] = await db.select({ n: users.usedBytes }).from(users).where(eq(users.id, userId)).limit(1)
  return Number(row?.n ?? 0)
}
