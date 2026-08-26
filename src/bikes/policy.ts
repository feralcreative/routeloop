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
