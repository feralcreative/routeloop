// Twelve- or twenty-four-hour time, as a rider's own choice.
//
// **THIS REVERSES A RECORDED CALL, NARROWLY AND ON PURPOSE.** Ziad's call,
// 2026-09-07, closing half of #270. `date_format` stores real BCP-47 tags rather
// than an abstract mdy/dmy/ymd precisely so Intl decides the digit order, the
// padding, the separator and the clock TOGETHER — and `fmtClock` asks for
// `timeStyle: 'short'` rather than spelling out `hour`/`minute` because spelling
// them out imposed OUR padding on every locale. Both of those still hold, and
// nothing here undoes either.
//
// What could not be expressed under that arrangement is an American who wants
// twenty-four-hour time. The only way to give them one was `en-GB`, which also
// hands them 24/08/2026 — a date order they did not ask for and probably cannot
// read at a glance. That is a real rider, so the clock gets its own axis.
//
// **`hour12` ALONE IS THE OVERRIDE, AND THAT NARROWNESS IS THE WHOLE DESIGN.**
// `timeStyle: 'short'` stays, so Intl still decides the padding, the separator
// and whether the marker reads "AM" or "a.m." — a rider asking for a 12-hour
// clock on `en-CA` gets "9:05 a.m." and not an Americanized string. The one bit
// being taken away from the locale is the one the rider explicitly answered.
//
// **THREE MEMBERS AND NOT A BOOLEAN**, the same shape as `motion` and `scheme`.
// `locale` means "whatever my date format implies", which is what the app did
// before this existed and what every rider who never opens the control keeps.
// A two-state toggle would have to pick a side for all of them.

export const CLOCKS = ['locale', 'h12', 'h24'] as const
export type Clock = (typeof CLOCKS)[number]
export const DEFAULT_CLOCK: Clock = 'locale'

/**
 * Coerces anything to a supported value.
 *
 * Same contract as toMotion and toDateFormat: a rider with no `user_profiles`
 * row hands this `undefined` as often as a value, and the answer is the column's
 * own default rather than a third state every caller has to interpret.
 */
export const toClock = (v: unknown): Clock => (CLOCKS.includes(v as Clock) ? (v as Clock) : DEFAULT_CLOCK)

/**
 * The `hour12` to hand Intl, or undefined to leave the decision with the locale.
 *
 * UNDEFINED RATHER THAN A FALLBACK BOOLEAN, so it spreads into an options object
 * as a no-op — `{ timeStyle: 'short', hour12: undefined }` is byte-identical in
 * output to `{ timeStyle: 'short' }`, which is what keeps `locale` meaning
 * exactly what the app did before this file existed. The same rule
 * `clampDivert()` follows for an unusable number.
 */
export const hour12For = (clock: Clock): boolean | undefined =>
  clock === 'h12' ? true : clock === 'h24' ? false : undefined

/**
 * What to stamp on <html>, or null to stamp nothing.
 *
 * `locale` stamps nothing for the same reason `motion: system` does not: the
 * absence IS the state, and the client reads the date format beside it to work
 * the answer out. A stamped `data-clock="locale"` would be a value every reader
 * then has to special-case.
 */
export const clockAttr = (c: Clock): string | null => (c === 'locale' ? null : c)

/** The settings page's radio set. The examples are the SAME instant in all
 *  three, which is the question being asked. */
export const CLOCK_CHOICES: { id: Clock; label: string; example: string }[] = [
  { id: 'locale', label: 'Follow my date format', example: '9:05 AM or 09:05' },
  { id: 'h12', label: '12-hour', example: '9:05 AM' },
  { id: 'h24', label: '24-hour', example: '09:05' },
]
