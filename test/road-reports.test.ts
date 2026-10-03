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
})
