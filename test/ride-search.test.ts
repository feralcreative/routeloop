// The export search box, read.
//
// The rule worth pinning is the OR: a month term never removes the title term,
// so "August" finds both the rides ridden in August and the one called August
// Loop. Deciding which was meant is exactly the cleverness that makes a search
// box feel broken.
import { describe, expect, it } from 'vitest'
import { parseRideQuery } from '../src/maps/ride-search'

const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null

describe('parseRideQuery', () => {
  it('reads an empty box as no question at all', () => {
    for (const q of ['', '   ']) {
      expect(parseRideQuery(q)).toEqual({ text: null, from: null, to: null, month: null, loose: false })
    }
  })

  it('takes a bare word as a title term', () => {
    expect(parseRideQuery('coast')).toEqual({ text: 'coast', from: null, to: null, month: null, loose: false })
  })

  it('lowercases and collapses whitespace so the query is stable', () => {
    expect(parseRideQuery('  Big   Sur  ').text).toBe('big sur')
  })

  it('reads a full ISO date as that one day', () => {
    const q = parseRideQuery('2026-08-14')
    expect(iso(q.from)).toBe('2026-08-14')
    // Exclusive, so the range is one `>= from AND < to` with no midnight edge.
    expect(iso(q.to)).toBe('2026-08-15')
    expect(q.text).toBeNull()
  })

  it('reads a year and month as that month', () => {
    const q = parseRideQuery('2026-08')
    expect(iso(q.from)).toBe('2026-08-01')
    expect(iso(q.to)).toBe('2026-09-01')
  })

  it('rolls a December range into the next year rather than to month 13', () => {
    const q = parseRideQuery('2026-12')
    expect(iso(q.to)).toBe('2027-01-01')
  })

  it('reads a bare year as that year', () => {
    const q = parseRideQuery('2026')
    expect(iso(q.from)).toBe('2026-01-01')
    expect(iso(q.to)).toBe('2027-01-01')
  })

  it('reads a month name with a year as that month', () => {
    const q = parseRideQuery('august 2026')
    expect(iso(q.from)).toBe('2026-08-01')
    expect(iso(q.to)).toBe('2026-09-01')
    expect(q.month).toBeNull()
  })

  it('reads a month name alone as every such month, which no range can say', () => {
    const q = parseRideQuery('august')
    expect(q.month).toBe(8)
    expect(q.from).toBeNull()
    // AND it stays a title term, so "August Loop" is still findable — `loose`
    // is what says the two are alternatives rather than both required.
    expect(q.text).toBe('august')
    expect(q.loose).toBe(true)
  })

  it('takes a three-letter prefix as a month', () => {
    expect(parseRideQuery('aug').month).toBe(8)
    expect(parseRideQuery('sep').month).toBe(9)
    expect(parseRideQuery('sept').month).toBe(9)
    expect(parseRideQuery('may').month).toBe(5)
  })

  it('does not take a two-letter word as a month', () => {
    // "ma" would otherwise match March, and a rider typing two letters is still
    // typing a name.
    expect(parseRideQuery('ma').month).toBeNull()
    expect(parseRideQuery('ma').text).toBe('ma')
  })

  it('keeps the rest of the words as a title term beside a date', () => {
    const q = parseRideQuery('coast august 2026')
    expect(q.text).toBe('coast')
    expect(iso(q.from)).toBe('2026-08-01')
    expect(q.loose).toBe(false)
  })

  it('takes only the first month and the first year', () => {
    // "august september" is not a range and pretending otherwise would invent
    // an answer. The second word stays a title term.
    const q = parseRideQuery('august september')
    expect(q.month).toBe(8)
    expect(q.text).toBe('september')
    expect(q.loose).toBe(false)
  })

  it('refuses an impossible month or day and falls back to matching the title', () => {
    expect(parseRideQuery('2026-13').text).toBe('2026-13')
    expect(parseRideQuery('2026-13').from).toBeNull()
    expect(parseRideQuery('2026-08-40').text).toBe('2026-08-40')
  })

  it('does not read a number that is not a plausible year as one', () => {
    expect(parseRideQuery('101').text).toBe('101')
    expect(parseRideQuery('1899').text).toBe('1899')
    expect(parseRideQuery('2126').text).toBe('2126')
  })

  it('builds its ranges in UTC, the zone every day clock in this app is read in', () => {
    // A range built in the server's zone puts a ride on the wrong side of a
    // month boundary for eight hours of every day.
    expect(parseRideQuery('2026-08').from?.toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })
})
