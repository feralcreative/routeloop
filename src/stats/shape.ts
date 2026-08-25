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
//   - Saddle time is reported, and part of it is an estimate that says so.
//
// THE LAST ONE REVERSED ON 2026-08-24 and the old reasoning is worth keeping,
// because it was right about the danger and wrong about the remedy. There was no
// "hours in the saddle" figure at all, on the grounds that the import path never
// writes a leg duration — so a lifetime total would undercount by however much
// of the library was imported, silently, and in the FLATTERING direction, which
// is the kind of wrong nobody reports. The remedy taken was to estimate the
// missing legs from distance at a nominal speed (src/maps/ride-time.ts), which
// is what both clients already do, rather than to keep the figure off the page.
// `SaddleTime.estimated` is the part that keeps it honest: the total covers
// everything, and the page says when some of it was figured rather than measured.
import { ROLE_META, type Role } from '../maps/roles'
import { roleColor } from '../maps/role-colors'
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
  /** Seconds in the saddle, summed across every leg, with a leg the router never
   *  answered for estimated from its distance — see src/maps/ride-time.ts. */
  durationS: number
  /** How many of those legs were estimated rather than measured. Zero means the
   *  whole figure came from the router; anything else is why the page hedges. */
  estimatedLegs: number
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

/**
 * Average and highest across every rider, for one metric.
 *
 * Both are per-RIDER figures: the average number of rides a rider has, and the
 * most any one of them has — not an average over rides, which would be a
 * different and far less interesting number.
 *
 * Declared here rather than in query.ts because query.ts already imports this
 * file for ACTIVITY_MONTHS and the Raw* types, and the dependency has to run one
 * way. Same reason RawTotals lives here.
 */
export type RawSpread = { avg: number; top: number }

export type RawGlobal = {
  rides: RawSpread
  days: RawSpread
  legs: RawSpread
  points: RawSpread
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
 * An average count, for the comparison column beside a rider's own figure.
 *
 * ONE DECIMAL, AND ONLY WHEN IT SAYS SOMETHING. "6.7 rides" is a real difference
 * from 6; "13.0 days" is 13 with a decorative zero on it. Rounding everything to
 * a whole number instead would be worse in the other direction — in a cohort this
 * small the averages are single digits, and "7" against a rider's own "7" reads
 * as a tie when they are actually ahead.
 *
 * Rounds before testing for a fraction, so 12.98 prints as 13 rather than as
 * "13.0".
 */
export function fmtAvg(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? fmtCount(r) : r.toFixed(1)
}

/**
 * A lifetime total of riding time, as hours.
 *
 * HOURS AND NOTHING SMALLER, unlike the roadbook's `fmtDuration`, which prints
 * "4h 20m" for a single day. A minute is real information about one day and
 * noise across a hundred — "312h 47m" invites a precision the underlying figure
 * does not have, since some unknown share of it is estimated from distance.
 *
 * Deliberately not routed through src/maps/duration.ts either. That module
 * formats a rider's own typed dwell in whichever of three formats they picked,
 * and this is a derived aggregate rather than a value they entered.
 */
export const fmtHours = (seconds: number): string => fmtCount(Math.round(seconds / 3600))

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

export type RoleBar = {
  role: string
  label: string
  icon: string
  /** The categorical hue, from src/maps/role-colors.ts. Null for a role that is
   *  in ROLE_META but has no color, which is a taxonomy bug rather than a state
   *  the page should paper over — see roleColor(). */
  color: string | null
  n: number
  share: number
}

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
      color: roleColor(r.role),
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

/**
 * One KPI tile: the rider's own figure, and optionally what everyone else has.
 *
 * `spread` is absent rather than zeroed when there is nothing to compare against
 * — the "roads you insisted on" tile has no global equivalent, and a tile
 * claiming an average of 0 would be making a measurement it never took.
 */
export type Tile = {
  label: string
  value: string
  hint?: string
  spread?: { avg: string; top: string }
}

export type Meter = { usedBytes: number; quotaBytes: number; pct: number; used: string; quota: string } | null

/**
 * One entry in "Your records" — the most celebratory block on the page, which
 * for a long time looked like the least (#136).
 *
 * NOT `Tile`, and the split is what the treatment needed. A tile is a count with
 * a cohort comparison under it; a record is a single figure that should be read
 * from across the room, and the two want opposite type sizes. Sharing the type
 * meant sharing `value: string` — one pre-formatted "482 mi" — which is exactly
 * what stopped the numeral being set large and the unit small.
 *
 * `numeric` is the field doing the work. Two of the four records are figures and
 * two are words: "Twistiest 20 miles" is a label like "Serpentine" and "Most
 * opened" is a ride's title, and either one set at the numeral's size would be a
 * headline running off the card. It also gates the count-up in dashboard.js,
 * which has nothing to count on a word.
 *
 * `kind` is the one identifier the view needs and it drives two things — which
 * mark is drawn (`icon-record-<kind>.svg`) and which accent the card takes. One
 * field rather than an icon name beside a color name, so a fifth record cannot
 * arrive with a mark and no accent. Four fixed kinds, no logic; the records are
 * a closed set.
 */
export type RecordKind = 'distance' | 'ride' | 'twist' | 'views'

export type RecordTile = {
  label: string
  value: string
  /** Set apart from `value` so the numeral takes the large size and the unit does
   *  not. Absent when the value is a word, which has no unit to split off. */
  unit?: string
  hint?: string
  kind: RecordKind
  numeric: boolean
}

export type VisibilitySplit = { key: 'public' | 'unlisted' | 'private'; label: string; n: number; pct: number }[]

/**
 * Time in the saddle, and how much of it is a guess.
 *
 * `estimated` is not decoration: a rider whose library is all imports has a
 * figure derived entirely from distance at a nominal speed, and one who plans
 * everything in the builder has a figure the router measured. The same number
 * means different things and the page has to say which.
 *
 * Null when there is no riding time at all, so a rider with rides but no legs
 * gets nothing rather than a confident zero.
 */
export type SaddleTime = { hours: string; estimated: boolean; note: string } | null

export type DashboardStats = {
  hasRides: boolean
  heroMiles: string
  saddle: SaddleTime
  tiles: Tile[]
  meter: Meter
  twist: TwistRollup
  roles: RoleBar[]
  rolesExceedPoints: boolean
  months: MonthPoint[]
  visibility: VisibilitySplit
  records: RecordTile[]
  /** True when used_bytes disagrees with the authoritative sum. Surfaced quietly.
   *  src/account/quota-sweep.ts repairs the tally on a timer as of 2026-08-24, so
   *  this is no longer the only thing that can notice — it is the one that can say
   *  which rider and which page. */
  storageDrift: boolean
}

/**
 * `global` is optional so a caller with nothing to compare against still works.
 * The comparison columns are decoration: a dashboard that renders without them
 * is a worse page, not a broken one, and this signature says so rather than
 * making every call site invent a zeroed spread.
 */
export function shapeStats(
  raw: RawStats,
  cachedUsedBytes: number,
  now: Date,
  global?: RawGlobal,
): DashboardStats {
  const t = raw.totals
  const hasRides = t.rides > 0

  // Absent rather than zeroed when there is no cohort figure — see the Tile type.
  const spread = (s: RawSpread | undefined) => (s ? { avg: fmtAvg(s.avg), top: fmtCount(s.top) } : undefined)

  const tiles: Tile[] = [
    { label: t.rides === 1 ? 'ride' : 'rides', value: fmtCount(t.rides), spread: spread(global?.rides) },
    { label: t.days === 1 ? 'day' : 'days', value: fmtCount(t.days), spread: spread(global?.days) },
    // LEGS IS ON THIS LIST KNOWINGLY. A leg is an internal artifact, one per pair
    // of consecutive points, and it is not a unit any rider thinks in. It was put
    // in the scope deliberately on 2026-08-16 rather than by omission, so it is
    // not to be quietly dropped as a cleanup.
    { label: t.legs === 1 ? 'leg' : 'legs', value: fmtCount(t.legs), spread: spread(global?.legs) },
    {
      label: t.points === 1 ? 'waypoint' : 'waypoints',
      value: fmtCount(t.points),
      // Named because rides.stop_count would give a different, smaller number and
      // someone will eventually wonder why the two disagree.
      hint: `${fmtCount(t.stops)} stops, ${fmtCount(t.pois)} points of interest`,
      spread: spread(global?.points),
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
  const records: RecordTile[] = []
  if (r.longestDayM != null && r.longestDayM > 0) {
    records.push({ label: 'Longest single day', value: fmtMiles(r.longestDayM), unit: 'mi', kind: 'distance', numeric: true })
  }
  if (r.biggestRideM != null && r.biggestRideM > 0) {
    records.push({
      label: 'Biggest ride',
      value: fmtMiles(r.biggestRideM),
      unit: 'mi',
      hint: r.biggestRideTitle ?? undefined,
      kind: 'ride',
      numeric: true,
    })
  }
  // bestTwistDpm is the best 20-mile stretch any route has, not a sum: "somewhere
  // in your library there are twenty miles like that".
  //
  // The value is a WORD — twistLabel returns "Serpentine", not a number — so this
  // one takes the text treatment and the degrees-per-mile figure stays in the
  // hint, where it already was. Putting the number in `value` instead would read
  // as a better record than the label it replaced, and it is the same fact.
  const bestLabel = twistLabel(r.bestTwistDpm)
  if (r.bestTwistDpm != null && bestLabel) {
    records.push({
      label: 'Twistiest 20 miles',
      value: bestLabel,
      hint: `${r.bestTwistDpm}°/mi of heading change`,
      kind: 'twist',
      numeric: false,
    })
  }
  // The count lives in the LABEL here and the ride's title is the value, which is
  // backwards from the other three and is deliberate: the record is which ride,
  // and the number is how the record was won. #136 was explicitly a visual pass
  // with no copy changes, so this stayed as it reads today.
  if (r.mostViewed != null && r.mostViewed > 0) {
    records.push({
      label: r.mostViewed === 1 ? 'Most opened, once' : `Most opened, ${fmtCount(r.mostViewed)} times`,
      value: r.mostViewedTitle ?? 'a ride',
      kind: 'views',
      numeric: false,
    })
  }

  // WITHHELD UNTIL 2026-08-24, and the reason it is here now is that the
  // undercount was fixed rather than accepted. The objection was real: the
  // import path never writes a leg duration, so summing duration_s alone
  // reported the builder's rides and counted every imported one as zero —
  // silently, and in the flattering direction, which is the failure mode nobody
  // catches. query.ts now applies the same distance-based estimate both clients
  // apply, so the total covers the whole library.
  //
  // What it costs is that some of the figure is a guess, and `estimated` is how
  // the page admits that rather than hiding it.
  const saddle: SaddleTime =
    t.durationS > 0
      ? {
          hours: fmtHours(t.durationS),
          estimated: t.estimatedLegs > 0,
          note:
            t.estimatedLegs > 0
              ? 'Part estimated: an imported ride carries no timings, so those legs are figured from distance.'
              : 'Measured by the router, leg by leg.',
        }
      : null

  return {
    hasRides,
    heroMiles: fmtMiles(t.distanceM),
    saddle,
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
