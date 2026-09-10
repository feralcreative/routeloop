// The rules for a rider's Paddock: what a valid bike is, how many they may keep,
// what to call one, and the miles-to-meters boundary.
//
// Pure — no database, no environment, no clock — so test/bikes.test.ts can pin
// every rule with no Postgres. The same rule-from-query split as
// `src/places/policy.ts` vs `service.ts`.
import { z } from 'zod'

// A backstop against a runaway client, not a product limit. A rider with a dozen
// bikes has a collection; one with sixty has a script.
export const MAX_BIKES = 50

/**
 * THE UNIT BOUNDARY. Riders type miles, the column stores meters.
 *
 * Exact, not approximate: a mile IS 1609.344 meters by definition, so this is a
 * conversion rather than an estimate and nothing here is lossy beyond the final
 * rounding to a whole meter.
 *
 * Everything above this line is miles because that is what the form asks for;
 * everything below it is meters because that is what src/db/schema.ts stores and
 * what #150 will convert for a rider who wants kilometers. Keeping the two apart
 * in one named place is what stops a mile leaking into a meters column, which
 * would read as a bike with a 112-mile range that the app thinks can do 180.
 */
export const METERS_PER_MILE = 1609.344

export const milesToMeters = (mi: number): number => Math.round(mi * METERS_PER_MILE)
export const metersToMiles = (m: number): number => Math.round(m / METERS_PER_MILE)

/** The ceiling on the meters column, mirroring ck_bike_range in the schema. */
export const MAX_RANGE_M = 2_000_000

/**
 * The widest range the FORM will accept. About 1,242 miles — comfortably past
 * any production motorcycle, and low enough that a fat-fingered entry cannot
 * poison a fuel-stop calculation downstream.
 *
 * FLOOR, NOT metersToMiles(). That helper rounds, which is right for display and
 * wrong here: 2,000,000 m rounds UP to 1,243 mi, and 1,243 mi converts back to
 * 2,000,415 m — past the database CHECK. The form would have advertised a
 * maximum that Postgres rejects, and the rider would have got a 500 for entering
 * exactly the number they were told was allowed.
 */
export const MAX_RANGE_MILES = Math.floor(MAX_RANGE_M / METERS_PER_MILE)

/**
 * THE OTHER UNIT BOUNDARY, and it is the same arrangement as the one above:
 * riders type gallons or liters, the column stores milliliters.
 *
 * Exact, not approximate — a US gallon is 231 cubic inches and an inch is
 * 25.4 mm by definition — so this converts rather than estimates.
 *
 * NOTE src/views/volume.ts NAMES THESE SAME TWO CONSTANTS RATHER THAN IMPORTING
 * THEM, deliberately, and the reason is the one already recorded for
 * METERS_PER_MILE against src/views/units.ts: this module owns the boundary for
 * a value being WRITTEN and that one owns it for a value being PRINTED. A shared
 * constant would suggest a shared conversion, and the two round in opposite
 * directions.
 */
export const ML_PER_GALLON = 3785.411784
export const ML_PER_LITER = 1000

/** The ceiling on the milliliters column, mirroring ck_bike_tank in the schema.
 *  100 L is comfortably past any production motorcycle. */
export const MAX_TANK_ML = 100_000

/**
 * The widest tank the FORM will accept, in each unit.
 *
 * FLOOR, NOT ROUND, and this is the MAX_RANGE_MILES trap in a second costume:
 * 100,000 ml rounds to 26.4 gal, and 26.4 gal converts back to 99,935 ml, which
 * is fine — but 26.5 would be 100,313 and past the CHECK. Flooring to one
 * decimal keeps every number the form advertises inside what Postgres accepts,
 * so a rider cannot get a 500 for entering exactly the maximum they were shown.
 */
export const MAX_TANK_GALLONS = Math.floor((MAX_TANK_ML / ML_PER_GALLON) * 10) / 10
export const MAX_TANK_LITERS = Math.floor((MAX_TANK_ML / ML_PER_LITER) * 10) / 10

/** Gallons or liters to milliliters. The unit is the rider's RESOLVED
 *  preference, never a value the client posted — a client that lied about it
 *  would store a tank 3.8x out. */
export const tankToMl = (n: number, liters: boolean): number => Math.round(n * (liters ? ML_PER_LITER : ML_PER_GALLON))

/** The other direction, for the form. ONE DECIMAL, because a tank is known to
 *  about a tenth of a gallon and printing 4.234567 claims a precision the
 *  rider's own manual does not have. */
export const mlToTank = (ml: number, liters: boolean): number =>
  Math.round((ml / (liters ? ML_PER_LITER : ML_PER_GALLON)) * 10) / 10

/**
 * Whether a typed tank is legal ONCE THE UNIT IS KNOWN, and the message to say
 * so if not.
 *
 * **THE SCHEMA CANNOT ANSWER THIS AND THAT IS WHY THIS EXISTS.** `bikeInput`
 * does not know which unit the rider reads in, so it validates against the
 * looser of the two — 100, the liter ceiling. A rider on GALLONS could therefore
 * type 30, pass the schema, convert to 113,562 ml and violate `ck_bike_tank`:
 * a 500 for a number the form appeared to accept, which is the MAX_RANGE_MILES
 * trap arriving from the other direction. The tight check has to happen where
 * the unit is, which is the route.
 *
 * Null is always fine — a tank nobody has measured is the ordinary state.
 */
export function tankRefusal(tank: number | null, liters: boolean): string | null {
  if (tank == null) return null
  if (tankToMl(tank, liters) <= MAX_TANK_ML) return null
  const max = liters ? MAX_TANK_LITERS : MAX_TANK_GALLONS
  return `A tank has to be between 0 and ${max} ${liters ? 'liters' : 'gallons'}`
}

// 1885 is the Daimler Reitwagen, which is as early as this can meaningfully go.
// The ceiling is a flat 2100 rather than "this year plus one" on purpose: a
// validation rule that reads the clock is a rule whose tests start failing on a
// date nobody chose, and nothing is protected by refusing a 2027 model year.
const YEAR_MIN = 1885
const YEAR_MAX = 2100

/** Empty string to null, so clearing a field removes the value rather than
 *  storing ''. Same rule the places writer follows — two representations of
 *  "nothing here" means every reader has to test for both. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .default(null)

/**
 * A range the rider left blank is NULL, not zero.
 *
 * Null means nobody has measured this bike; zero would mean a machine that
 * cannot leave the driveway, and every range feature downstream has to be able
 * to tell those apart. An empty form field is the former.
 */
const optionalRange = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'string' ? v.trim() : v))
  .transform((v) => (v === '' || v === null ? null : Number(v)))
  .refine((v) => v === null || (Number.isFinite(v) && v > 0 && v <= MAX_RANGE_MILES), {
    message: `A range has to be between 1 and ${MAX_RANGE_MILES} miles`,
  })
  .nullable()
  .default(null)

export const FUEL_TYPES = ['gas', 'electric'] as const
export type FuelType = (typeof FUEL_TYPES)[number]

export const bikeInput = z.object({
  nickname: optionalText(80),
  make: optionalText(60),
  model: optionalText(80),
  year: z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === 'string' ? v.trim() : v))
    .transform((v) => (v === '' || v === null ? null : Number(v)))
    .refine((v) => v === null || (Number.isInteger(v) && v >= YEAR_MIN && v <= YEAR_MAX), {
      message: `A year has to be between ${YEAR_MIN} and ${YEAR_MAX}`,
    })
    .nullable()
    .default(null),
  fuelType: z.enum(FUEL_TYPES).default('gas'),
  /** Miles. Converted at the boundary — see METERS_PER_MILE. */
  usableRangeMi: optionalRange,
  /** Miles. How far this rider wants to go on this bike before a break. */
  comfortRangeMi: optionalRange,
  /**
   * Tank capacity in the RIDER'S OWN unit, converted at the boundary — see
   * tankToMl. Null when they left it blank, which is most bikes and is a
   * different claim from a tank of zero.
   *
   * VALIDATED AGAINST THE LOOSER OF THE TWO UNITS, because this schema does not
   * know which one the rider reads in and must not refuse a number that is legal
   * in theirs. The tight check happens after conversion, against MAX_TANK_ML,
   * where the unit is known.
   */
  tank: z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === 'string' ? v.trim() : v))
    .transform((v) => (v === '' || v === null ? null : Number(v)))
    .refine((v) => v === null || (Number.isFinite(v) && v > 0 && v <= MAX_TANK_LITERS), {
      message: `A tank has to be between 0 and ${MAX_TANK_LITERS}`,
    })
    .nullable()
    .default(null),
})

export type BikeInput = z.infer<typeof bikeInput>

/** Whether a rider has room for another. */
export const canAddBike = (count: number): boolean => count < MAX_BIKES

export type BikeLabelFields = {
  nickname: string | null
  make: string | null
  model: string | null
  year: number | null
}

/**
 * What to call a bike on a rider-facing surface.
 *
 * FALLS THROUGH RATHER THAN REQUIRING ANY ONE FIELD. A rider who types "the
 * orange one" and nothing else has named their bike well enough; so has one who
 * fills in the make and model and never nicknames it. Every field being optional
 * is what makes adding a bike a ten-second job, and this is the function that
 * makes that cost nothing anywhere else.
 *
 * The nickname wins outright when it is there — it is the name its owner chose,
 * and appending "2019 Triumph Tiger 900" to "Nessie" helps nobody.
 */
export function bikeLabel(bike: BikeLabelFields): string {
  if (bike.nickname) return bike.nickname
  const parts = [bike.year ? String(bike.year) : null, bike.make, bike.model].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'Untitled bike'
}

/**
 * The range a group is limited by, and whose bike it is.
 *
 * The whole point of #52 in one pure function, sitting here rather than waiting
 * for ride membership: a group can only go as far as its smallest tank, and the
 * thing worth surfacing is WHOSE that is — the rider with 120 miles is the one
 * who ends up pushing.
 *
 * Bikes with no measured range are skipped rather than treated as zero. If none
 * of them has a range, the answer is null: unknown, which is honestly different
 * from "this group cannot move".
 */
export function bindingRange<T extends { usableRangeM: number | null }>(bikes: T[]): T | null {
  let worst: T | null = null
  for (const bike of bikes) {
    if (bike.usableRangeM == null) continue
    if (!worst || bike.usableRangeM < worst.usableRangeM!) worst = bike
  }
  return worst
}
