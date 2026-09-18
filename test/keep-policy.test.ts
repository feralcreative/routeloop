// The rule behind the "On this phone" switch on /rides: which of a rider's
// rides a phone should hold, by when each last changed. Same harness as
// go-progress.test.ts.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

let P: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/keep-policy.js', 'utf8'))(win)
  P = (win as any).TBKeepPolicy
})

const NOW = Date.parse('2026-09-17T20:00:00Z')
const day = (n: number) => new Date(NOW - n * 86400000).toISOString()

describe('the four policies', () => {
  it('are four, in the order the switch shows them, each with a label', () => {
    expect(P.POLICIES).toEqual(['none', 'recent', 'year', 'all'])
    for (const p of P.POLICIES) expect(typeof P.LABELS[p]).toBe('string')
    expect(P.isPolicy('recent')).toBe(true)
    expect(P.isPolicy('everything')).toBe(false)
    expect(P.isPolicy('')).toBe(false)
  })
})

describe('matches', () => {
  it('none holds nothing and all holds everything, whatever the date', () => {
    expect(P.matches('none', day(0), NOW)).toBe(false)
    expect(P.matches('all', day(4000), NOW)).toBe(true)
    expect(P.matches('all', 'garbage', NOW)).toBe(true)
  })

  it('recent is thirty days on the ride’s last change, inclusive', () => {
    expect(P.matches('recent', day(0), NOW)).toBe(true)
    expect(P.matches('recent', day(29), NOW)).toBe(true)
    expect(P.matches('recent', day(30), NOW)).toBe(true)
    expect(P.matches('recent', day(31), NOW)).toBe(false)
  })

  // Dates a day clear of the year boundary, because getFullYear() answers in
  // the machine's zone and a test on the stroke of midnight UTC passes in
  // Berlin and fails in Oakland — the at() trap test/ride-time.test.ts records.
  it('year is the calendar year of the last change', () => {
    expect(P.matches('year', '2026-01-03T12:00:00Z', NOW)).toBe(true)
    expect(P.matches('year', '2025-12-30T12:00:00Z', NOW)).toBe(false)
    expect(P.matches('year', day(200), NOW)).toBe(true)
  })

  it('reads an unparseable date as "not recently changed"', () => {
    expect(P.matches('recent', 'garbage', NOW)).toBe(false)
    expect(P.matches('year', '', NOW)).toBe(false)
  })
})
