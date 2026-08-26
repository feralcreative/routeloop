// The rules for the Paddock.
//
// Two things here are worth more than the rest. The unit boundary, because a
// mile that reaches the meters column reads as a bike with 180 miles of range
// that the app believes can do 290 — wrong in the direction that strands
// somebody. And the null handling, because "nobody has measured this bike" and
// "this bike cannot leave the driveway" have to stay different answers all the
// way down to the fuel-stop math.
import { describe, expect, it } from 'vitest'
import {
  bikeInput,
  bikeLabel,
  bindingRange,
  canAddBike,
  MAX_BIKES,
  MAX_RANGE_M,
  MAX_RANGE_MILES,
  metersToMiles,
  METERS_PER_MILE,
  milesToMeters,
} from '../src/bikes/policy'

describe('the unit boundary', () => {
  it('uses the exact definition of a mile', () => {
    expect(METERS_PER_MILE).toBe(1609.344)
    expect(milesToMeters(1)).toBe(1609)
  })

  it('round-trips the ranges a motorcycle actually has', () => {
    for (const mi of [80, 120, 150, 180, 220, 300, 400]) {
      expect(metersToMiles(milesToMeters(mi)), `${mi} mi`).toBe(mi)
    }
  })

  // The form must never advertise a maximum the database rejects. It did:
  // metersToMiles rounds, so the cap came out one mile too high and converted
  // back past ck_bike_range — a 500 for entering the allowed number.
  it('caps the form at what the column will actually accept', () => {
    expect(milesToMeters(MAX_RANGE_MILES)).toBeLessThanOrEqual(MAX_RANGE_M)
    expect(milesToMeters(MAX_RANGE_MILES + 1)).toBeGreaterThan(MAX_RANGE_M)
  })
})

describe('bikeInput', () => {
  const parse = (over: Record<string, unknown> = {}) => bikeInput.safeParse(over)

  it('accepts a bike with nothing but a nickname', () => {
    const r = parse({ nickname: 'the orange one' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toMatchObject({ nickname: 'the orange one', make: null, usableRangeMi: null })
  })

  it('defaults an unstated fuel type to gas', () => {
    const r = parse({})
    expect(r.success && r.data.fuelType).toBe('gas')
  })

  // The form posts strings. A blank field is "not measured", not zero.
  it('turns an empty range field into null rather than zero', () => {
    const r = parse({ usableRangeMi: '', comfortRangeMi: '' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.usableRangeMi).toBeNull()
      expect(r.data.comfortRangeMi).toBeNull()
    }
  })

  it('reads a range typed as a string', () => {
    const r = parse({ usableRangeMi: '180' })
    expect(r.success && r.data.usableRangeMi).toBe(180)
  })

  it('refuses a zero or negative range, which is not the same as blank', () => {
    expect(parse({ usableRangeMi: 0 }).success).toBe(false)
    expect(parse({ usableRangeMi: -5 }).success).toBe(false)
  })

  it('refuses a range past the column check', () => {
    expect(parse({ usableRangeMi: MAX_RANGE_MILES }).success).toBe(true)
    expect(parse({ usableRangeMi: MAX_RANGE_MILES + 1 }).success).toBe(false)
  })

  it('empties a whitespace-only text field to null', () => {
    const r = parse({ nickname: '   ', make: '  ' })
    expect(r.success).toBe(true)
    if (r.success) expect([r.data.nickname, r.data.make]).toEqual([null, null])
  })

  it('refuses a year outside the range a motorcycle can have', () => {
    expect(parse({ year: 1884 }).success).toBe(false)
    expect(parse({ year: 1885 }).success).toBe(true)
    expect(parse({ year: 2101 }).success).toBe(false)
    expect(parse({ year: 2026.5 }).success).toBe(false)
  })

  it('refuses an unknown fuel type', () => {
    expect(parse({ fuelType: 'diesel' }).success).toBe(false)
  })
})

describe('bikeLabel', () => {
  const b = (over: Partial<Parameters<typeof bikeLabel>[0]> = {}) => ({
    nickname: null,
    make: null,
    model: null,
    year: null,
    ...over,
  })

  it('prefers the name its owner chose, alone', () => {
    expect(bikeLabel(b({ nickname: 'Nessie', make: 'Triumph', model: 'Tiger 900', year: 2019 }))).toBe('Nessie')
  })

  it('falls through to year, make and model', () => {
    expect(bikeLabel(b({ make: 'Triumph', model: 'Tiger 900', year: 2019 }))).toBe('2019 Triumph Tiger 900')
  })

  it('skips whichever of those is missing rather than leaving a gap', () => {
    expect(bikeLabel(b({ make: 'Triumph', model: 'Tiger 900' }))).toBe('Triumph Tiger 900')
    expect(bikeLabel(b({ year: 2019, model: 'Tiger 900' }))).toBe('2019 Tiger 900')
    expect(bikeLabel(b({ make: 'Triumph' }))).toBe('Triumph')
  })

  it('never returns an empty string', () => {
    expect(bikeLabel(b())).toBe('Untitled bike')
  })
})

describe('canAddBike', () => {
  it('stops at the limit', () => {
    expect(canAddBike(0)).toBe(true)
    expect(canAddBike(MAX_BIKES - 1)).toBe(true)
    expect(canAddBike(MAX_BIKES)).toBe(false)
  })
})

describe('bindingRange', () => {
  const bike = (id: number, usableRangeM: number | null) => ({ id, usableRangeM })

  it('is the smallest measured range in the group', () => {
    const found = bindingRange([bike(1, milesToMeters(220)), bike(2, milesToMeters(120)), bike(3, milesToMeters(180))])
    expect(found?.id).toBe(2)
  })

  // The distinction the whole null rule exists for: an unmeasured bike must not
  // silently become the binding one at zero miles.
  it('skips a bike nobody has measured', () => {
    const found = bindingRange([bike(1, null), bike(2, milesToMeters(180))])
    expect(found?.id).toBe(2)
  })

  it('is null when nothing in the group has been measured', () => {
    expect(bindingRange([bike(1, null), bike(2, null)])).toBeNull()
    expect(bindingRange([])).toBeNull()
  })
})
