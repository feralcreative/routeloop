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

describe('plan', () => {
  const never = () => false
  const rides = [
    { slug: 'new', updatedAt: day(2), estBytes: 1_000_000 },
    { slug: 'old', updatedAt: day(200), estBytes: 3_000_000 },
    { slug: 'kept', updatedAt: day(5), estBytes: 500_000 },
  ]

  it('offers what matches and is not kept, with its size, and removes nothing it did not keep', () => {
    const rows = [{ slug: 'kept', via: 'policy' }, { slug: 'old', via: 'hand' }]
    const p = P.plan('recent', rides, rows, NOW, never)
    expect(p.fetch.map((r: any) => r.slug)).toEqual(['new'])
    expect(p.bytes).toBe(1_000_000)
    expect(p.remove).toEqual([])
  })

  it('offers a policy-kept ride outside the window for removal, never a hand-kept one', () => {
    const rows = [{ slug: 'old', via: 'policy' }, { slug: 'kept', via: 'hand' }]
    const p = P.plan('none', rides, rows, NOW, never)
    expect(p.fetch).toEqual([])
    expect(p.remove.map((r: any) => r.slug)).toEqual(['old'])
  })

  it('counts a kept copy the ride has moved on from as a download', () => {
    const rows = [{ slug: 'kept', via: 'policy' }]
    const p = P.plan('recent', rides, rows, NOW, (row: any) => row.slug === 'kept')
    expect(p.fetch.map((r: any) => r.slug).sort()).toEqual(['kept', 'new'])
    expect(p.bytes).toBe(1_500_000)
  })

  it('treats a missing estimate as zero rather than NaN', () => {
    const p = P.plan('all', [{ slug: 'x', updatedAt: day(1) }], [], NOW, never)
    expect(p.bytes).toBe(0)
  })
})
