// Gallons or liters, as a rider's own choice.
//
// **A THIRD AXIS, NOT A CONSEQUENCE OF THE OTHER TWO.** #270 asks for this to be
// decided rather than inherited, and the reasoning is the same one ./units.ts
// already records about itself: `en-GB` writes 24/08/2026 AND measures road
// distance in miles, so deriving units from a date format would be wrong for the
// riders most likely to notice. Volume is one more step out — a rider can want
// miles and liters, or kilometers and gallons, and both are ordinary.
//
// **`auto` FOLLOWS `units` AND IS THE DEFAULT, WHICH IS NOT THE SAME AS FOLDING
// THE TWO TOGETHER.** Deriving outright would leave a metric rider no way to ask
// for gallons; defaulting means a metric rider never has to ask for liters. The
// override exists, it is just not the thing anybody is made to answer first —
// the same arrangement `motion: system` and `scheme: system` both use.
//
// **US GALLONS, AND THERE IS DELIBERATELY NO IMPERIAL GALLON MEMBER.** They
// differ by about a fifth, so offering both is offering a way to be wrong by 20%
// on a fuel calculation, and a rider who wants the imperial one is far better
// served by liters — which every UK forecourt sells in anyway. If that turns out
// to be wrong it is a fourth member and a migration of nothing, because the
// column stores milliliters.
//
// **WHAT THIS DOES NOT DO IS PICK THE STORAGE UNIT.** `bikes.tank_ml` is
// milliliters for the same reason `bikes.usable_range_m` is meters: a value
// stored in whatever unit somebody typed drifts on every round trip.
// src/bikes/policy.ts owns that boundary; this file owns the label and the
// number a rider reads.

import type { Units } from './units'

export const VOLUME_UNITS = ['auto', 'gallons', 'liters'] as const
export type VolumeUnits = (typeof VOLUME_UNITS)[number]
export const DEFAULT_VOLUME_UNITS: VolumeUnits = 'auto'

/**
 * Coerces anything to a supported value.
 *
 * Same contract as toUnits and toMotion: `undefined` is as common as a value,
 * because a rider with no `user_profiles` row has no answer stored.
 */
export const toVolumeUnits = (v: unknown): VolumeUnits =>
  VOLUME_UNITS.includes(v as VolumeUnits) ? (v as VolumeUnits) : DEFAULT_VOLUME_UNITS

/** What `auto` actually means for this rider. Every formatter below takes the
 *  RESOLVED value, so `auto` exists in exactly one place and no printer has to
 *  know it is possible. */
export type ResolvedVolume = 'gallons' | 'liters'
export const resolveVolume = (v: VolumeUnits, units: Units): ResolvedVolume =>
  v === 'auto' ? (units === 'metric' ? 'liters' : 'gallons') : v

/** Milliliters in one US gallon, and in one liter. Exact by definition — a US
 *  gallon is 231 cubic inches and an inch is 25.4 mm — so this is a conversion
 *  and not an estimate, the same claim METERS_PER_MILE makes. */
export const ML_PER_GALLON = 3785.411784
export const ML_PER_LITER = 1000

/** How much, in the rider's own unit, from a volume in MILLILITERS. */
export const volumeFrom = (ml: number, v: ResolvedVolume): number =>
  ml / (v === 'liters' ? ML_PER_LITER : ML_PER_GALLON)

/** The other direction, for a form. Rounds to a whole milliliter, which is finer
 *  than any tank is known to. */
export const volumeToMl = (n: number, v: ResolvedVolume): number =>
  Math.round(n * (v === 'liters' ? ML_PER_LITER : ML_PER_GALLON))

/** The short label, for a figure that already has a number beside it. */
export const volumeUnit = (v: ResolvedVolume): string => (v === 'liters' ? 'L' : 'gal')

/** The long label, for prose and for a field. */
export const volumeUnitLong = (v: ResolvedVolume, plural = true): string =>
  v === 'liters' ? (plural ? 'liters' : 'liter') : plural ? 'gallons' : 'gallon'

/** The settings page's radio set. The examples are the SAME tank in all three —
 *  a 4.2 gallon Bonneville — which is the question being asked. */
export const VOLUME_CHOICES: { id: VolumeUnits; label: string; example: string }[] = [
  { id: 'auto', label: 'Follow my distances', example: 'gallons with miles, liters with kilometers' },
  { id: 'gallons', label: 'Gallons', example: 'a 4.2 gal tank' },
  { id: 'liters', label: 'Liters', example: 'a 15.9 L tank' },
]
