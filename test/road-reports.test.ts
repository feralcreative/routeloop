import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  canWithdraw,
  expiresAtFor,
  fmtMmdd,
  inSeason,
  isLive,
  mmddOf,
  parseReport,
  seasonVerdict,
  TTL_DAYS,
  validMmdd,
} from '../src/road-reports/policy'

const utc = (s: string) => new Date(s + 'T09:00:00Z')

describe('road report rules', () => {
  it('accepts real month-days only, February 29 included', () => {
    expect(validMmdd(1101)).toBe(1101)
    expect(validMmdd('0531')).toBe(531)
    expect(validMmdd(229)).toBe(229)
    expect(validMmdd(230)).toBeNull()
    expect(validMmdd(1301)).toBeNull()
    expect(validMmdd(1100)).toBeNull()
    expect(validMmdd(10.5)).toBeNull()
  })

  it('reads a season that wraps the new year', () => {
    expect(inSeason(1101, 531, 1225)).toBe(true)
    expect(inSeason(1101, 531, 315)).toBe(true)
    expect(inSeason(1101, 531, 704)).toBe(false)
    expect(inSeason(601, 831, 704)).toBe(true)
    expect(inSeason(601, 831, 1225)).toBe(false)
  })

  it('takes a route date from its wall clock, which is carried as UTC', () => {
    expect(mmddOf(new Date('2026-07-04T23:30:00Z'))).toBe(704)
  })

  it('warns a dated route only inside the season, and an undated one always', () => {
    const winter = { start: 1101, end: 531 }
    expect(seasonVerdict(winter, utc('2027-02-10'), null)).toBe('closed')
    expect(seasonVerdict(winter, utc('2027-07-10'), null)).toBeNull()
    expect(seasonVerdict(winter, null, null)).toBe('seasonal')
    // A ride that starts the last day of the season counts.
    expect(seasonVerdict(winter, utc('2027-05-31'), utc('2027-06-01'))).toBe('closed')
  })

  // #447: only the first and last dates were tested, so a closure starting and
  // ending inside a multi-day route read as open.
  it('counts a closure that starts and ends inside the route', () => {
    const fair = { start: 504, end: 506 }
    expect(seasonVerdict(fair, utc('2027-05-01'), utc('2027-05-10'))).toBe('closed')
    expect(seasonVerdict(fair, utc('2027-05-01'), utc('2027-05-03'))).toBeNull()
    expect(seasonVerdict(fair, utc('2027-05-07'), utc('2027-05-10'))).toBeNull()
    // Either end touching the window still counts.
    expect(seasonVerdict(fair, utc('2027-05-01'), utc('2027-05-04'))).toBe('closed')
    expect(seasonVerdict(fair, utc('2027-05-06'), utc('2027-05-10'))).toBe('closed')
  })

  it('reads a season that wraps the new year against a route', () => {
    const holidays = { start: 1220, end: 105 }
    // The route holds the whole season, across the year boundary.
    expect(seasonVerdict(holidays, utc('2026-12-10'), utc('2027-01-20'))).toBe('closed')
    // Inside the season on both sides of the boundary.
    expect(seasonVerdict(holidays, utc('2026-12-26'), utc('2027-01-02'))).toBe('closed')
    // Wholly between two seasons.
    expect(seasonVerdict(holidays, utc('2027-01-06'), utc('2027-12-19'))).toBeNull()
    const winter = { start: 1101, end: 531 }
    expect(seasonVerdict(winter, utc('2027-06-02'), utc('2027-10-30'))).toBeNull()
    expect(seasonVerdict(winter, utc('2027-06-02'), utc('2027-11-01'))).toBe('closed')
  })

  it('reads a route that crosses the new year against a season that does not', () => {
    const from = utc('2026-12-28')
    const to = utc('2027-01-04')
    expect(seasonVerdict({ start: 1231, end: 1231 }, from, to)).toBe('closed')
    expect(seasonVerdict({ start: 101, end: 102 }, from, to)).toBe('closed')
    // Starts before the route and ends inside it.
    expect(seasonVerdict({ start: 1201, end: 1229 }, from, to)).toBe('closed')
    // Starts inside the route and ends after it.
    expect(seasonVerdict({ start: 103, end: 228 }, from, to)).toBe('closed')
    expect(seasonVerdict({ start: 1225, end: 1227 }, from, to)).toBeNull()
    expect(seasonVerdict({ start: 105, end: 110 }, from, to)).toBeNull()
  })

  it('counts every season on a route a year or longer, and reads a backwards span forwards', () => {
    expect(seasonVerdict({ start: 704, end: 705 }, utc('2027-03-01'), utc('2028-03-01'))).toBe('closed')
    // Just short of a year, and it misses both Fourths.
    expect(seasonVerdict({ start: 704, end: 705 }, utc('2027-07-10'), utc('2028-07-01'))).toBeNull()
    expect(seasonVerdict({ start: 504, end: 506 }, utc('2027-05-10'), utc('2027-05-01'))).toBe('closed')
  })

  it('expires by kind, and a seasonal closure never', () => {
    const now = utc('2026-10-02')
    expect(expiresAtFor('hazard', false, now)!.getTime() - now.getTime()).toBe(TTL_DAYS.hazard * 86_400_000)
    expect(expiresAtFor('closure', true, now)).toBeNull()
    expect(isLive({ expiresAt: null }, now)).toBe(true)
    expect(isLive({ expiresAt: utc('2026-10-01') }, now)).toBe(false)
  })

  it('validates a report from the client', () => {
    expect(parseReport({ kind: 'surface', at: [-122.2, 37.8], note: ' gravel ' })).toEqual({
      ok: true,
      value: { kind: 'surface', at: [-122.2, 37.8], note: 'gravel', season: null },
    })
    expect(parseReport({ kind: 'pothole', at: [0, 0] }).ok).toBe(false)
    expect(parseReport({ kind: 'surface', at: [200, 0] }).ok).toBe(false)
    expect(parseReport({ kind: 'surface', at: [0, 0], season: { start: 1101, end: 531 } }).ok).toBe(false)
    expect(parseReport({ kind: 'closure', at: [0, 0], season: { start: 1101, end: 1101 } }).ok).toBe(false)
    expect(parseReport({ kind: 'closure', at: [0, 0], season: { start: 1101, end: 531 } })).toMatchObject({
      ok: true,
      value: { season: { start: 1101, end: 531 } },
    })
    const long = parseReport({ kind: 'hazard', at: [0, 0], note: 'x'.repeat(500) })
    expect(long.ok && long.value.note.length).toBe(400)
  })

  it('lets the reporter or a rider manager withdraw, and nobody else', () => {
    expect(canWithdraw({ reporterId: 1 }, { id: 1 })).toBe(true)
    expect(canWithdraw({ reporterId: 1 }, { id: 2, canManageRiders: true })).toBe(true)
    expect(canWithdraw({ reporterId: 1 }, { id: 2 })).toBe(false)
    expect(canWithdraw({ reporterId: 1 }, null)).toBe(false)
  })

  it('formats a month-day', () => {
    expect(fmtMmdd(1101)).toBe('Nov 1')
    expect(fmtMmdd(531)).toBe('May 31')
  })
})

describe('road-season.js agrees with the server', () => {
  const win: Record<string, any> = {}
  new Function('window', readFileSync('public/js/road-season.js', 'utf8'))(win)
  const S = win.TBRoadSeason

  it('on every season boundary pair it is likely to meet', () => {
    const days = [101, 228, 229, 301, 531, 601, 704, 831, 1031, 1101, 1225, 1231]
    for (const a of days) for (const b of days) for (const d of days) expect(S.inSeason(a, b, d)).toBe(inSeason(a, b, d))
  })

  it('on verdicts and labels', () => {
    const s = { start: 1101, end: 531 }
    for (const d of ['2027-01-15', '2027-06-15', '2027-11-01'])
      expect(S.seasonVerdict(s, utc(d), null)).toBe(seasonVerdict(s, utc(d), null))
    expect(S.seasonVerdict(s, null, null)).toBe('seasonal')
    expect(S.fmtMmdd(1225)).toBe(fmtMmdd(1225))
    expect(S.mmddFromInput('2027-11-01')).toBe(1101)
    expect(S.mmddFromInput('')).toBeNull()
  })

  // #447: the span test, over seasons that do and do not wrap and spans that do and
  // do not cross the new year, backwards, and longer than a year.
  it('on a route span against every season', () => {
    const marks = [101, 105, 228, 229, 301, 504, 506, 531, 601, 704, 1101, 1220, 1231]
    const dates = [
      '2027-01-01',
      '2027-01-04',
      '2027-02-28',
      '2027-05-01',
      '2027-05-05',
      '2027-05-10',
      '2027-07-04',
      '2027-12-20',
      '2027-12-31',
      '2028-01-03',
      '2028-02-29',
      '2028-05-05',
    ]
    let n = 0
    for (const start of marks)
      for (const end of marks) {
        if (start === end) continue
        const s = { start, end }
        for (const a of dates)
          for (const b of dates) {
            expect(S.seasonVerdict(s, utc(a), utc(b)), `${start}-${end} ${a}..${b}`).toBe(
              seasonVerdict(s, utc(a), utc(b)),
            )
            n++
          }
      }
    expect(n).toBe(13 * 12 * 12 * 12)
  })
})

// An independent check on the span test: walk every day of the route and ask
// inSeason of each. Slow and obviously right, which is the point.
describe('seasonVerdict matches a day-by-day walk', () => {
  const walk = (s: { start: number; end: number }, a: Date, b: Date) => {
    const [from, to] = a <= b ? [a, b] : [b, a]
    for (let t = from.getTime(); t <= to.getTime(); t += 86_400_000) {
      if (inSeason(s.start, s.end, mmddOf(new Date(t)))) return 'closed'
    }
    return null
  }
  it('on spans up to two years against seasons that do and do not wrap', () => {
    const seasons = [
      { start: 504, end: 506 },
      { start: 1101, end: 531 },
      { start: 1220, end: 105 },
      { start: 229, end: 301 },
      { start: 1231, end: 101 },
    ]
    const base = utc('2026-11-15').getTime()
    for (const s of seasons)
      for (let i = 0; i < 400; i += 7)
        for (const len of [0, 1, 3, 9, 30, 120, 300, 364, 365, 366, 700]) {
          const a = new Date(base + i * 86_400_000)
          const b = new Date(a.getTime() + len * 86_400_000)
          expect(seasonVerdict(s, a, b), `${s.start}-${s.end} ${a.toISOString()} +${len}`).toBe(walk(s, a, b))
        }
  })
})
