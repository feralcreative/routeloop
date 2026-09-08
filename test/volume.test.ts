// Gallons or liters (#270), and the tank capacity that gave the preference
// something to print.
//
// TWO MODULES, TWO DIRECTIONS, AND THAT IS ON PURPOSE. src/views/volume.ts owns
// the value being PRINTED and src/bikes/policy.ts owns the value being WRITTEN;
// they name the same two constants rather than one importing the other's, the
// same arrangement METERS_PER_MILE already has. This file pins that they agree,
// which is the thing a duplicated constant can silently stop doing.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOLUME_UNITS,
  ML_PER_GALLON,
  ML_PER_LITER,
  resolveVolume,
  toVolumeUnits,
  VOLUME_CHOICES,
  VOLUME_UNITS,
  volumeFrom,
  volumeToMl,
  volumeUnit,
  volumeUnitLong,
} from '../src/views/volume'
import {
  ML_PER_GALLON as WRITE_ML_PER_GALLON,
  ML_PER_LITER as WRITE_ML_PER_LITER,
  MAX_TANK_GALLONS,
  MAX_TANK_LITERS,
  MAX_TANK_ML,
  mlToTank,
  tankRefusal,
  tankToMl,
} from '../src/bikes/policy'

describe('toVolumeUnits', () => {
  it('accepts every member and answers anything else with the default', () => {
    for (const v of VOLUME_UNITS) expect(toVolumeUnits(v)).toBe(v)
    expect(toVolumeUnits(undefined)).toBe(DEFAULT_VOLUME_UNITS)
    expect(toVolumeUnits('pints')).toBe(DEFAULT_VOLUME_UNITS)
  })
})

describe('resolveVolume', () => {
  // `auto` FOLLOWS units. That is a sensible default, not a derivation: the two
  // members below it are how a rider says otherwise.
  it('follows the distance unit when set to auto', () => {
    expect(resolveVolume('auto', 'imperial')).toBe('gallons')
    expect(resolveVolume('auto', 'metric')).toBe('liters')
  })

  // THE THIRD-AXIS CLAIM, and the reason this is not folded into `units`: a
  // rider can want miles and liters, or kilometers and gallons, and an explicit
  // answer outranks the distance unit in both directions.
  it('lets a rider want miles and liters, or kilometers and gallons', () => {
    expect(resolveVolume('liters', 'imperial')).toBe('liters')
    expect(resolveVolume('gallons', 'metric')).toBe('gallons')
  })
})

describe('the two conversion boundaries agree', () => {
  it('names the same constants on the read and write sides', () => {
    expect(WRITE_ML_PER_GALLON).toBe(ML_PER_GALLON)
    expect(WRITE_ML_PER_LITER).toBe(ML_PER_LITER)
  })

  it('round-trips a real tank through both directions', () => {
    // A 4.2 gal Bonneville and a 15.9 L equivalent.
    expect(mlToTank(tankToMl(4.2, false), false)).toBe(4.2)
    expect(mlToTank(tankToMl(15.9, true), true)).toBe(15.9)
  })

  // TO THREE DECIMALS AND NOT MORE, because the column stores a WHOLE
  // milliliter — 4.2 gal is 15,898.7 ml and lands on 15,899, so a round trip is
  // out by about 0.00007 gal by construction. Asserting past that would be
  // asserting a precision the storage does not have.
  it('converts and prints the same number', () => {
    const ml = tankToMl(4.2, false)
    expect(volumeFrom(ml, 'gallons')).toBeCloseTo(4.2, 3)
    expect(volumeToMl(4.2, 'gallons')).toBe(ml)
  })
})

// THE MAX_RANGE_MILES TRAP IN A SECOND COSTUME. A form must never advertise a
// maximum the database rejects: 100,000 ml is 26.417 gal, and a form offering
// 26.5 would produce a value past ck_bike_tank and a 500 for entering exactly
// the number the rider was shown.
describe('the advertised maximum is one the database accepts', () => {
  it('converts back inside MAX_TANK_ML from both units', () => {
    expect(tankToMl(MAX_TANK_GALLONS, false)).toBeLessThanOrEqual(MAX_TANK_ML)
    expect(tankToMl(MAX_TANK_LITERS, true)).toBeLessThanOrEqual(MAX_TANK_ML)
  })

  it('floors rather than rounds, so the next step up is genuinely over', () => {
    expect(tankToMl(MAX_TANK_GALLONS + 0.1, false)).toBeGreaterThan(MAX_TANK_ML)
  })
})

describe('labels', () => {
  it('names both units short and long', () => {
    expect(volumeUnit('gallons')).toBe('gal')
    expect(volumeUnit('liters')).toBe('L')
    expect(volumeUnitLong('gallons', false)).toBe('gallon')
    expect(volumeUnitLong('liters')).toBe('liters')
  })

  it('offers every member exactly once', () => {
    expect(VOLUME_CHOICES.map((c) => c.id).sort()).toEqual([...VOLUME_UNITS].sort())
  })
})

// THE GAP THE SCHEMA CANNOT CLOSE, found in the browser rather than by
// reasoning: `bikeInput` validates a typed tank against the LITRE ceiling,
// because it does not know which unit the rider reads in. A gallons rider typing
// 30 therefore passes it, converts to 113,562 ml and violates ck_bike_tank — a
// 500 for a number the form appeared to accept, which is the MAX_RANGE_MILES
// trap arriving from the other direction.
describe('tankRefusal', () => {
  it('accepts an unmeasured tank in either unit', () => {
    expect(tankRefusal(null, false)).toBeNull()
    expect(tankRefusal(null, true)).toBeNull()
  })

  it('accepts every real tank', () => {
    expect(tankRefusal(4.2, false)).toBeNull()
    expect(tankRefusal(15.9, true)).toBeNull()
  })

  it('refuses a gallons figure the schema alone would have let through', () => {
    // 30 is under MAX_TANK_LITERS, so bikeInput passes it.
    expect(tankRefusal(30, false)).toMatch(/gallons/)
    // The same number in liters is legal, which is the whole point of the unit
    // being known here and not in the schema.
    expect(tankRefusal(30, true)).toBeNull()
  })

  it('accepts exactly the maximum it advertises, in both units', () => {
    expect(tankRefusal(MAX_TANK_GALLONS, false)).toBeNull()
    expect(tankRefusal(MAX_TANK_LITERS, true)).toBeNull()
  })
})
