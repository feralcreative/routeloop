// public/js/units.js against src/views/units.ts.
//
// Two implementations of the same arithmetic, in two runtimes, and the whole
// point of this file is that they cannot drift. Same arrangement as
// duration.test.ts and filename-client.test.ts.
//
// A disagreement here would not throw anywhere: the builder would print one
// distance and the roadbook another for the same ride, and each would look
// right on its own page.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import * as server from '../src/views/units'

let U: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/units.js', 'utf8'))(win)
  U = (win as any).TBUnits
})

const UNITS = ['imperial', 'metric'] as const

// Meters, chosen to cover a short leg, a long day and a ride-length total, plus
// the degenerate zero.
const METERS = [0, 1, 1000, 1609.344, 42195, 160934.4, 3_300_000]

describe('the two implementations agree', () => {
  it.each(UNITS)('distanceFrom, in %s', (units) => {
    for (const m of METERS) {
      expect(U.distanceFrom(m, units)).toBeCloseTo(server.distanceFrom(m, units), 9)
    }
  })

  it.each(UNITS)('distanceFromMiles, in %s', (units) => {
    for (const mi of [0, 0.4, 1, 73.4, 248, 2082.1]) {
      expect(U.distanceFromMiles(mi, units)).toBeCloseTo(server.distanceFromMiles(mi, units), 9)
    }
  })

  it.each(UNITS)('twistFrom, in %s', (units) => {
    for (const dpm of [0, 120, 522, 840, 2400]) {
      expect(U.twistFrom(dpm, units)).toBeCloseTo(server.twistFrom(dpm, units), 9)
    }
  })

  it.each(UNITS)('the labels, in %s', (units) => {
    expect(U.distanceUnit(units)).toBe(server.distanceUnit(units))
    expect(U.twistUnit(units)).toBe(server.twistUnit(units))
  })

  it('the constants', () => {
    expect(U.METERS_PER_MILE).toBe(server.METERS_PER_MILE)
    expect(U.METERS_PER_KM).toBe(server.METERS_PER_KM)
  })
})

describe('toUnits', () => {
  it('agrees with the server on every input a page can hand it', () => {
    for (const v of ['metric', 'imperial', '', 'METRIC', undefined, null, 0, 'km']) {
      expect(U.toUnits(v)).toBe(server.toUnits(v))
    }
  })
})

// The direction check, stated once in each runtime because it is the one thing
// here that is easy to write backwards and impossible to notice.
describe('the metric twistiness figure is SMALLER', () => {
  it('in both implementations', () => {
    expect(U.twistFrom(840, 'metric')).toBeLessThan(840)
    expect(server.twistFrom(840, 'metric')).toBeLessThan(840)
  })
})
