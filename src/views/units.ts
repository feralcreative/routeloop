// Miles or kilometers, as a rider's own choice.
//
// A DISPLAY-TIME CONCERN AND NOTHING ELSE. The storage layer is already mixed
// and stays that way: `route_legs.distance_m` and `days.distance_m` are meters,
// `rides.total_miles` is a mileage cache, `days.twistiness_dpm` is degrees per
// mile. Nothing here migrates — every formatter converts at the point it prints.
//
// **ITS OWN AXIS, NOT DERIVED FROM THE DATE FORMAT**, and #150 asked for that to
// be decided deliberately rather than inherited. date-format.ts stores real
// locale tags so Intl can decide digit order and the 12-vs-24-hour clock
// together, and units look like the obvious sibling — but the two genuinely do
// not correlate. `en-GB` is a locale that writes 24/08/2026 and 16:00 AND
// measures road distance in miles; deriving units from it would hand every
// British rider kilometers they never asked for and give them no way back.
//
// So this is a second preference with a second column. What it deliberately does
// NOT do is invent a locale-shaped mechanism to sit alongside the first one: the
// members are the two systems, because that is the question being asked.
//
// FUEL AND VOLUME ARE NOT HERE, and their absence is deliberate rather than
// unfinished. A bike's range is stored in meters and typed in miles
// (src/bikes/policy.ts), so it follows this axis for free; litres-vs-gallons is a
// third question nothing in the app currently asks, and a member added here for
// it would be a member no formatter reads.

export const UNITS = ['imperial', 'metric'] as const
export type Units = (typeof UNITS)[number]
export const DEFAULT_UNITS: Units = 'imperial'

/**
 * Coerces anything to a supported value.
 *
 * Same contract as the other preference modules: `undefined` is as common as a
 * value, because a rider with no `user_profiles` row has no answer stored.
 */
export const toUnits = (v: unknown): Units => (UNITS.includes(v as Units) ? (v as Units) : DEFAULT_UNITS)

/** Meters in one mile, and in one kilometer. The first mirrors METERS_PER_MILE
 *  in src/bikes/policy.ts — that module owns the boundary for a bike's range and
 *  this one owns it for a displayed distance; both name the same constant rather
 *  than one importing the other's, because they are boundaries in different
 *  directions and a shared constant would suggest a shared conversion. */
export const METERS_PER_MILE = 1609.344
export const METERS_PER_KM = 1000

/** How far, in the rider's own unit, from a distance in METERS. */
export const distanceFrom = (meters: number, units: Units): number =>
  meters / (units === 'metric' ? METERS_PER_KM : METERS_PER_MILE)

/** How far, in the rider's own unit, from a distance already in MILES.
 *
 *  This exists because `rides.total_miles` is a cache in miles and converting it
 *  back to meters first would round twice for no gain. */
export const distanceFromMiles = (miles: number, units: Units): number =>
  units === 'metric' ? (miles * METERS_PER_MILE) / METERS_PER_KM : miles

/** Degrees per mile to degrees per the rider's own unit.
 *
 *  A CONVERSION, NOT A RE-MEASUREMENT. `days.twistiness_dpm` is degrees of
 *  heading change per mile; per kilometer is the same road described in smaller
 *  pieces, so the figure gets SMALLER — dividing by the miles in a km rather than
 *  multiplying. Getting this backwards makes every metric rider's roads look four
 *  times twistier than they are, and nothing would say so. */
export const twistFrom = (dpm: number, units: Units): number =>
  units === 'metric' ? dpm / (METERS_PER_MILE / METERS_PER_KM) : dpm

/** The short label, for a figure that already has a number beside it. */
export const distanceUnit = (units: Units): string => (units === 'metric' ? 'km' : 'mi')

/** The long label, for prose and for a column heading. */
export const distanceUnitLong = (units: Units, plural = true): string =>
  units === 'metric' ? (plural ? 'kilometers' : 'kilometer') : plural ? 'miles' : 'mile'

/** The twistiness unit, which is the distance unit with a degree sign on it. */
export const twistUnit = (units: Units): string => (units === 'metric' ? '°/km' : '°/mi')

/** The settings page's radio set. The examples are the same road in both, which
 *  is the question being asked — not two different roads. */
export const UNITS_CHOICES: { id: Units; label: string; example: string }[] = [
  { id: 'imperial', label: 'Miles', example: '248 mi · 840°/mi' },
  { id: 'metric', label: 'Kilometers', example: '399 km · 522°/km' },
]
