// Raw aggregate rows in, everything the dashboard renders out.
//
// Same split as src/survey/score.ts and for the same reason: query.ts holds the
// SQL and cannot be tested here, so every judgment that could be WRONG rather
// than merely absent lives in this file, where vitest can pin it without a
// database.
//
// Three of those judgments are not obvious and each has cost someone a
// afternoon somewhere:
//
//   - Twistiness rolls up DISTANCE-WEIGHTED, never as an average of averages.
//   - A null twistiness is "not measured", never "Straight".
//   - Duration is not reported at all, because the import path never writes it.
//
// The last one is the reason there is no "hours in the saddle" figure on the
// dashboard even though `rides.total_duration_s` exists and looks inviting.
import { ROLE_META, type Role } from '../maps/roles'
import { twistLabel } from '../maps/twist'

const METERS_PER_MILE = 1609.344

/** How many months the activity chart covers. */
export const ACTIVITY_MONTHS = 12

// --- What query.ts hands over ------------------------------------------------

export type RawTotals = {
  rides: number
  days: number
  legs: number
  /** Every dot: stops AND POIs. `rides.stop_count` counts only stops, so it is
   *  deliberately not the source here. */
  points: number
  stops: number
  pois: number
  /** Sum of route_legs.distance_m — the mileage authority, not rides.total_miles. */
  distanceM: number
  /** Shaping points dragged onto the line, summed across every leg. */
  viaPoints: number
  publicRides: number
  unlistedRides: number
  privateRides: number
  views: number
  /** Authoritative: sum(rides.size_bytes), a generated column. Not users.used_bytes. */
  storedBytes: number
  quotaBytes: number
}

/** One row per route that has a measured twistiness, for the weighted rollup. */
export type RawTwist = { dpm: number; distanceM: number }

/** One row per role, already counted by SQL. */
export type RawRole = { role: string; n: number }

/** One row per month that had at least one ride created. */
export type RawMonth = { month: string; n: number }

export type RawRecords = {
  longestDayM: number | null
  biggestRideM: number | null
  biggestRideTitle: string | null
  biggestRideSlug: string | null
  bestTwistDpm: number | null
  mostViewed: number | null
  mostViewedTitle: string | null
  mostViewedSlug: string | null
}

export type RawStats = {
  totals: RawTotals
  twist: RawTwist[]
  roles: RawRole[]
  months: RawMonth[]
  records: RawRecords
}

// --- Formatting --------------------------------------------------------------

export const miles = (m: number): number => m / METERS_PER_MILE

/** Thousands separators, no decimals. Dashboard figures are read, not audited. */
export const fmtMiles = (m: number): string => Math.round(miles(m)).toLocaleString('en-US')

export const fmtCount = (n: number): string => n.toLocaleString('en-US')

/**
 * Bytes as something a person reads.
 *
 * MB with one decimal under a gigabyte, because the quota is 25 MB and a rider
 * near it wants to see 24.3, not 24.
 */
export function fmtBytes(n: number): string {
  const KB = 1024
  const MB = KB * 1024
  if (n < KB) return `${n} B`
  if (n < MB) return `${Math.round(n / KB)} KB`
  if (n < MB * 1024) return `${(n / MB).toFixed(1)} MB`
  return `${(n / (MB * 1024)).toFixed(1)} GB`
}

// --- Twistiness --------------------------------------------------------------

export type TwistRollup = { dpm: number; label: string } | null

/**
 * One twistiness figure across every route that has one.
 *
 * DISTANCE-WEIGHTED. The metric is degrees per mile, so the rollup is the total
 * degrees over the total miles — not the mean of the per-route numbers. Averaging
 * those would let a 30-mile breakfast loop count the same as a 300-mile transit
 * day, which is the exact mistake builder.js:1211-1255 documents on the client.
 *
 * Returns null when nothing has been measured. That is NOT the same as zero:
 * `days.twistiness_dpm` is nullable and a null means no track was long enough
 * to measure, while 0 is a genuine claim that the road is straight. Reporting an
 * unmeasured library as "Straight" would be a lie the rider cannot see through.
 */
export function rollUpTwist(rows: readonly RawTwist[]): TwistRollup {
  let degrees = 0
  let meters = 0
  for (const r of rows) {
    if (r.distanceM <= 0) continue
    degrees += r.dpm * miles(r.distanceM)
    meters += r.distanceM
  }
  if (meters <= 0) return null
  const dpm = Math.round(degrees / miles(meters))
  const label = twistLabel(dpm)
  return label ? { dpm, label } : null
}

// --- The stop histogram ------------------------------------------------------

export type RoleBar = { role: string; label: string; icon: string; n: number; share: number }

/**
 * Roles that describe the shape of a route rather than a choice the rider made.
 *
 * Every ride has a start and an end, so they arrive at the top of the histogram
 * with a count equal to the number of days and push everything interesting
 * into the bottom third. The chart is titled "what you stop for"; nobody stops
 * for the start.
 *
 * `home` is deliberately NOT here — starting a ride from your own door is a real
 * choice and not every ride does it.
 */
const STRUCTURAL_ROLES: ReadonlySet<string> = new Set(['start', 'finish'])

/**
 * Every role that has been used at least once, biggest first.
 *
 * Roles nobody used are dropped rather than rendered as empty bars: seventeen
 * rows of which four have data is a chart about the taxonomy, not about the
 * rider.
 *
 * `share` is against the BIGGEST bar, not the total, because these bars are a
 * magnitude comparison and a share-of-total would make every bar tiny the moment
 * one category dominates — which one always does, since almost every ride has a
 * start and a finish.
 */
export function roleBars(rows: readonly RawRole[]): RoleBar[] {
  const known = rows.filter((r) => r.n > 0 && r.role in ROLE_META && !STRUCTURAL_ROLES.has(r.role))
  const max = known.reduce((m, r) => Math.max(m, r.n), 0)
  return known
    .map((r) => ({
      role: r.role,
      label: ROLE_META[r.role as Role].title,
      icon: ROLE_META[r.role as Role].icon,
      n: r.n,
      share: max === 0 ? 0 : r.n / max,
    }))
    .sort((a, z) => z.n - a.n || a.label.localeCompare(z.label))
}

/**
 * Roles are an array of up to 4 per point, so a stop tagged gas AND food is
 * counted in both bars. The totals therefore exceed the number of points, and a
 * page that does not say so reads as broken arithmetic.
 */
export const roleTotalExceedsPoints = (bars: readonly RoleBar[], points: number): boolean =>
  bars.reduce((n, b) => n + b.n, 0) > points

// --- Activity ----------------------------------------------------------------

export type MonthPoint = { month: string; label: string; n: number }

/**
 * The last N months, every one present, zeroes included.
 *
 * SQL only returns months that had a ride, so a rider who planned in January and
 * again in June would otherwise draw a two-point line with a straight segment
 * across the gap — a chart claiming steady activity through a five-month silence.
 *
 * `now` is a parameter rather than `new Date()` so the test can pin it. Every
 * boundary here is UTC, matching the timestamps the months are grouped from.
 */
export function monthSeries(rows: readonly RawMonth[], now: Date, count = ACTIVITY_MONTHS): MonthPoint[] {
  const byMonth = new Map(rows.map((r) => [r.month, r.n]))
  const out: MonthPoint[] = []
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - i, 1))
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    out.push({
      month: key,
      label: d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
      n: byMonth.get(key) ?? 0,
    })
  }
  return out
}

// --- The whole page ----------------------------------------------------------

export type Tile = { label: string; value: string; hint?: string }

export type Meter = { usedBytes: number; quotaBytes: number; pct: number; used: string; quota: string } | null

export type VisibilitySplit = { key: 'public' | 'unlisted' | 'private'; label: string; n: number; pct: number }[]

export type DashboardStats = {
  hasRides: boolean
  heroMiles: string
  tiles: Tile[]
  meter: Meter
  twist: TwistRollup
  roles: RoleBar[]
  rolesExceedPoints: boolean
  months: MonthPoint[]
  visibility: VisibilitySplit
  records: Tile[]
  /** True when used_bytes disagrees with the authoritative sum. Surfaced quietly;
   *  the cache has no reconciler and this is the first thing able to notice. */
  storageDrift: boolean
}

export function shapeStats(raw: RawStats, cachedUsedBytes: number, now: Date): DashboardStats {
  const t = raw.totals
  const hasRides = t.rides > 0

  const tiles: Tile[] = [
    { label: t.rides === 1 ? 'ride' : 'rides', value: fmtCount(t.rides) },
    { label: t.days === 1 ? 'day' : 'days', value: fmtCount(t.days) },
    { label: t.legs === 1 ? 'leg' : 'legs', value: fmtCount(t.legs) },
    {
      label: t.points === 1 ? 'waypoint' : 'waypoints',
      value: fmtCount(t.points),
      // Named because rides.stop_count would give a different, smaller number and
      // someone will eventually wonder why the two disagree.
      hint: `${fmtCount(t.stops)} stops, ${fmtCount(t.pois)} points of interest`,
    },
  ]

  if (t.viaPoints > 0) {
    tiles.push({
      label: t.viaPoints === 1 ? 'road you insisted on' : 'roads you insisted on',
      value: fmtCount(t.viaPoints),
      hint: 'Times you dragged the line onto a road the router did not pick',
    })
  }

  // Hidden entirely at zero. used_bytes counts imported files only, so a rider
  // who works in the builder would otherwise stare at a permanently empty meter.
  const meter: Meter =
    t.storedBytes > 0
      ? {
          usedBytes: t.storedBytes,
          quotaBytes: t.quotaBytes,
          pct: t.quotaBytes > 0 ? Math.min(100, (t.storedBytes / t.quotaBytes) * 100) : 0,
          used: fmtBytes(t.storedBytes),
          quota: fmtBytes(t.quotaBytes),
        }
      : null

  const visTotal = t.publicRides + t.unlistedRides + t.privateRides
  const visibility: VisibilitySplit = (
    [
      { key: 'public', label: 'Public', n: t.publicRides },
      { key: 'unlisted', label: 'Unlisted', n: t.unlistedRides },
      { key: 'private', label: 'Private', n: t.privateRides },
    ] as const
  ).map((v) => ({ ...v, pct: visTotal === 0 ? 0 : (v.n / visTotal) * 100 }))

  const r = raw.records
  const records: Tile[] = []
  if (r.longestDayM != null && r.longestDayM > 0) {
    records.push({ label: 'Longest single day', value: `${fmtMiles(r.longestDayM)} mi` })
  }
  if (r.biggestRideM != null && r.biggestRideM > 0) {
    records.push({
      label: 'Biggest ride',
      value: `${fmtMiles(r.biggestRideM)} mi`,
      hint: r.biggestRideTitle ?? undefined,
    })
  }
  // bestTwistDpm is the best 20-mile stretch any route has, not a sum: "somewhere
  // in your library there are twenty miles like that".
  const bestLabel = twistLabel(r.bestTwistDpm)
  if (r.bestTwistDpm != null && bestLabel) {
    records.push({ label: 'Twistiest 20 miles', value: bestLabel, hint: `${r.bestTwistDpm}°/mi of heading change` })
  }
  if (r.mostViewed != null && r.mostViewed > 0) {
    records.push({
      label: r.mostViewed === 1 ? 'Most opened, once' : `Most opened, ${fmtCount(r.mostViewed)} times`,
      value: r.mostViewedTitle ?? 'a ride',
    })
  }

  return {
    hasRides,
    heroMiles: fmtMiles(t.distanceM),
    tiles,
    meter,
    twist: rollUpTwist(raw.twist),
    roles: roleBars(raw.roles),
    rolesExceedPoints: roleTotalExceedsPoints(roleBars(raw.roles), t.points),
    months: monthSeries(raw.months, now),
    visibility,
    records,
    // Compared, not trusted. storedBytes is a sum over a generated column and
    // cannot drift; used_bytes is a hand-maintained cache with no reconciler.
    storageDrift: cachedUsedBytes !== t.storedBytes,
  }
}
