// Rider-reported road conditions (#48) and seasonal closures (#53): the pure half.
// service.ts is the only module that touches road_reports.
//
// A REPORT DECAYS. A washout in March is not news in September, so every report
// carries an expiry from the moment it is made, by kind. The one exception is a
// SEASONAL closure, which describes every year and never expires.
//
// NOTHING HERE REFUSES A ROUTE. A report is a warning beside the plan; the rider
// may know the gravel was paved last week, or be riding in July past a pass that
// shuts in November.

export const REPORT_KINDS = ['surface', 'closure', 'hazard'] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

export const KIND_LABEL: Record<ReportKind, string> = {
  surface: 'Rough or unpaved',
  closure: 'Closed',
  hazard: 'Hazard',
}

/** How long a report stays live, by kind. Surface changes slowly, a hazard fast. */
export const TTL_DAYS: Record<ReportKind, number> = { surface: 180, closure: 60, hazard: 21 }

/** How far from a route's line a report still counts as on it. A rider presses the
 *  road on a map, so this is the slop of a fingertip at a sensible zoom. */
export const REPORT_RADIUS_M = 75

export const MAX_NOTE = 400

export function isKind(v: unknown): v is ReportKind {
  return typeof v === 'string' && (REPORT_KINDS as readonly string[]).includes(v)
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** A month-day as MMDD (1101 is November 1), or null when it is not a real one.
 *  February 29 is allowed: a season names no year. */
export function validMmdd(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n)) return null
  const m = Math.floor(n / 100)
  const d = n % 100
  if (m < 1 || m > 12 || d < 1 || d > DAYS_IN_MONTH[m - 1]) return null
  return n
}

/** Whether a month-day falls inside a season. A season may wrap the new year:
 *  1101–0531 is November through May. */
export function inSeason(start: number, end: number, mmdd: number): boolean {
  return start <= end ? mmdd >= start && mmdd <= end : mmdd >= start || mmdd <= end
}

/** The month-day of a route's clock. start_at is a wall clock carried as UTC
 *  (see route-clock.js), so the UTC fields ARE the rider's date. */
export function mmddOf(d: Date): number {
  return (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}

/** When a new report stops counting. Null for a seasonal closure, which never does. */
export function expiresAtFor(kind: ReportKind, seasonal: boolean, now: Date): Date | null {
  if (seasonal) return null
  return new Date(now.getTime() + TTL_DAYS[kind] * 86_400_000)
}

export type ReportInput = {
  kind: ReportKind
  note: string
  at: [number, number]
  season: { start: number; end: number } | null
}

/** Validates a report from the client, or names why it cannot be one. */
export function parseReport(body: unknown): { ok: true; value: ReportInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  if (!isKind(b.kind)) return { ok: false, error: 'Pick what kind of report this is.' }
  const at = b.at
  if (
    !Array.isArray(at) ||
    at.length !== 2 ||
    !at.every((n) => typeof n === 'number' && Number.isFinite(n)) ||
    Math.abs(at[0]) > 180 ||
    Math.abs(at[1]) > 90
  )
    return { ok: false, error: 'That spot is not on the map.' }
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, MAX_NOTE) : ''
  let season: ReportInput['season'] = null
  if (b.season != null) {
    if (b.kind !== 'closure') return { ok: false, error: 'Only a closure can be seasonal.' }
    const s = b.season as Record<string, unknown>
    const start = validMmdd(s.start)
    const end = validMmdd(s.end)
    if (start == null || end == null) return { ok: false, error: 'Those are not real dates.' }
    if (start === end) return { ok: false, error: 'A season needs two different dates.' }
    season = { start, end }
  }
  return { ok: true, value: { kind: b.kind, note, at: [at[0], at[1]], season } }
}

/** Whether a report counts right now. */
export function isLive(r: { expiresAt: Date | null }, now: Date): boolean {
  return r.expiresAt == null || r.expiresAt.getTime() > now.getTime()
}

/** Who may take a report down: whoever made it, or somebody who manages riders. */
export function canWithdraw(r: { reporterId: number }, viewer: { id: number; canManageRiders?: boolean } | null): boolean {
  return !!viewer && (viewer.id === r.reporterId || !!viewer.canManageRiders)
}

/**
 * What a seasonal closure says about one route. `closed` when the route's date is
 * in season, `seasonal` when the route is undated (the rider should know it shuts),
 * and null when the route is dated outside the season, which is the whole point of
 * #53: a July trip planned in February must not be warned about a closure that
 * will be long gone.
 */
export function seasonVerdict(
  season: { start: number; end: number },
  routeStart: Date | null,
  routeEnd: Date | null,
): 'closed' | 'seasonal' | null {
  if (!routeStart) return 'seasonal'
  const days = [mmddOf(routeStart)]
  if (routeEnd) days.push(mmddOf(routeEnd))
  return days.some((d) => inSeason(season.start, season.end, d)) ? 'closed' : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 1101 as "Nov 1". */
export function fmtMmdd(mmdd: number): string {
  return `${MONTHS[Math.floor(mmdd / 100) - 1]} ${mmdd % 100}`
}
