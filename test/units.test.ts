// Miles or kilometers, and the one conversion that is easy to get backwards.
import { describe, expect, it } from 'vitest'
import {
  METERS_PER_KM,
  METERS_PER_MILE,
  distanceFrom,
  distanceFromMiles,
  distanceUnit,
  distanceUnitLong,
  toUnits,
  twistFrom,
  twistUnit,
} from '../src/views/units'

describe('toUnits', () => {
  it('takes the two members', () => {
    expect(toUnits('imperial')).toBe('imperial')
    expect(toUnits('metric')).toBe('metric')
  })

  // Same contract as toScheme and toDateFormat: a rider with no profile row
  // hands this undefined, and the answer is the column's own default.
  it('falls back to imperial for anything else', () => {
    expect(toUnits(undefined)).toBe('imperial')
    expect(toUnits(null)).toBe('imperial')
    expect(toUnits('furlongs')).toBe('imperial')
    expect(toUnits(7)).toBe('imperial')
  })
})

describe('distanceFrom', () => {
  it('reads meters as miles', () => {
    expect(distanceFrom(METERS_PER_MILE, 'imperial')).toBeCloseTo(1, 10)
    expect(distanceFrom(160934.4, 'imperial')).toBeCloseTo(100, 6)
  })

  it('reads meters as kilometers', () => {
    expect(distanceFrom(METERS_PER_KM, 'metric')).toBeCloseTo(1, 10)
    expect(distanceFrom(100000, 'metric')).toBeCloseTo(100, 10)
  })

  it('makes the same road a bigger number in kilometers', () => {
    const m = 400000
    expect(distanceFrom(m, 'metric')).toBeGreaterThan(distanceFrom(m, 'imperial'))
  })
})

describe('distanceFromMiles', () => {
  // rides.total_miles is a cache in miles; going back through meters would round
  // twice for nothing.
  it('leaves an imperial figure alone', () => {
    expect(distanceFromMiles(248, 'imperial')).toBe(248)
  })

  it('converts miles to kilometers', () => {
    expect(distanceFromMiles(100, 'metric')).toBeCloseTo(160.9344, 4)
  })

  it('agrees with distanceFrom on the same distance', () => {
    const miles = 248
    expect(distanceFromMiles(miles, 'metric')).toBeCloseTo(distanceFrom(miles * METERS_PER_MILE, 'metric'), 6)
  })
})

// THE ONE THAT IS EASY TO GET BACKWARDS, and the reason this file exists.
//
// Twistiness is degrees of heading change PER UNIT OF DISTANCE. A kilometer is
// shorter than a mile, so the same road accumulates FEWER degrees in one — the
// metric figure is smaller. Multiplying instead of dividing makes every metric
// rider's roads read about 1.6x twistier than they are, on a scale whose labels
// ("Very twisty") would move with it, and nothing anywhere would say so.
describe('twistFrom', () => {
  it('leaves an imperial figure alone', () => {
    expect(twistFrom(840, 'imperial')).toBe(840)
  })

  it('makes the same road a SMALLER number per kilometer', () => {
    expect(twistFrom(840, 'metric')).toBeLessThan(840)
    expect(twistFrom(840, 'metric')).toBeCloseTo(522.0, 1)
  })

  it('is the inverse of the distance conversion, which is what makes it a rate', () => {
    const dpm = 600
    // Degrees over a fixed road length must come out the same either way.
    const roadM = 50000
    const imperialTotal = twistFrom(dpm, 'imperial') * distanceFrom(roadM, 'imperial')
    const metricTotal = twistFrom(dpm, 'metric') * distanceFrom(roadM, 'metric')
    expect(metricTotal).toBeCloseTo(imperialTotal, 6)
  })
})

describe('labels', () => {
  it('gives the short unit', () => {
    expect(distanceUnit('imperial')).toBe('mi')
    expect(distanceUnit('metric')).toBe('km')
  })

  it('gives the long unit, singular and plural', () => {
    expect(distanceUnitLong('imperial')).toBe('miles')
    expect(distanceUnitLong('imperial', false)).toBe('mile')
    expect(distanceUnitLong('metric')).toBe('kilometers')
    expect(distanceUnitLong('metric', false)).toBe('kilometer')
  })

  it('gives the twistiness unit', () => {
    expect(twistUnit('imperial')).toBe('°/mi')
    expect(twistUnit('metric')).toBe('°/km')
  })
})
