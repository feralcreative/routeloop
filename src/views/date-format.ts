// How a date and a clock are written down, per rider.
//
// The problem this fixes: five server-rendered surfaces formatted dates with a
// hardcoded `'en-US'`. The BUILDER was always correct, because
// `<input type="datetime-local">` renders in the viewer's own locale — so a rider
// outside the US planned a route in `24/08/2026` and printed a roadbook that said
// `08/24/2026`.
//
// A DISPLAY LAYER ONLY, exactly like src/maps/duration.ts. Nothing here touches
// storage.
//
// THE MEMBERS ARE REAL LOCALE TAGS, and that is the one judgment call worth stating.
// The alternative was an abstract `mdy`/`dmy`/`ymd` enum, which would have fixed the
// digit order and left the rest to be formatted by hand. Passing a real tag to Intl
// means the clock follows too, month and weekday names come from the same source, and
// adding a locale later is one enum member and no formatter changes.
//
// THE CLOCK HAS ITS OWN CONTROL SINCE #270, AND THAT IS STILL TRUE: it is the DEFAULT
// that follows the locale. What the arrangement could not express was an American who
// wants twenty-four-hour time — the only way to get one was en-GB, and 24/08/2026 with
// it. `fmtClock` overrides `hour12` ALONE.
//
// NUMBER GROUPING IS NOT WIRED UP YET, deliberately: all three members are English and
// group identically as 1,234. `fmtNumber` exists for the day a member like `de-DE`
// lands.
//
// THREE MEMBERS, ONE PER DIGIT ORDER, not a catalog of locales:
//
//   en-US  8/24/2026    Monday, August 24    9:05 AM
//   en-GB  24/08/2026   Monday 24 August     09:05
//   en-CA  2026-08-24   Monday, August 24    9:05 a.m.
//
// TRANSLATION IS NOT IN SCOPE. All three members render English words, because the app
// has no i18n framework and a date preference is not one.

import { DEFAULT_CLOCK, hour12For, type Clock } from './clock'

export const DATE_FORMATS = ['en-US', 'en-GB', 'en-CA'] as const
export type DateFormat = (typeof DATE_FORMATS)[number]

export const DEFAULT_DATE_FORMAT: DateFormat = 'en-US'

/**
 * Coerces anything to a supported format.
 *
 * Same contract as toDurationFormat: a rider who has never opened their settings
 * has no `user_profiles` row at all, so this is handed `undefined` as often as it
 * is handed a value, and the answer has to be the column's own default rather
 * than a third state every caller would have to think about.
 */
export const toDateFormat = (v: unknown): DateFormat =>
  DATE_FORMATS.includes(v as DateFormat) ? (v as DateFormat) : DEFAULT_DATE_FORMAT

/** What each choice does to an order, for the tooltip beside the date itself. */
const DATE_FORMAT_ORDERS: { id: DateFormat; order: string; pattern: string }[] = [
  { id: 'en-US', order: 'Month first', pattern: 'MM-DD-YYYY' },
  { id: 'en-GB', order: 'Day first', pattern: 'DD-MM-YYYY' },
  { id: 'en-CA', order: 'Year first', pattern: 'YYYY-MM-DD' },
]

/**
 * The settings page's radio set: TODAY, written each of the three ways, which is the
 * same date in all three because the order is the whole question.
 *
 * **THE LABEL IS THE FORMATTER'S OWN OUTPUT, NOT A HAND-WRITTEN EXAMPLE.** A rider
 * picking a date format wants to see a date, and computing it removes the whole class
 * of drift the old test existed to catch. `tip` carries the order in words.
 *
 * **IT IS A FUNCTION BECAUSE TODAY MOVES.** A module-level constant would be frozen at
 * boot and a long-running container would show the day it started on.
 *
 * **THE DATE IS UTC, like every other date this module prints**, so a rider west of
 * Greenwich late in the evening sees tomorrow's — a sample of a SHAPE rather than a
 * claim about what day it is.
 *
 * THE CLOCK CAME OUT OF THESE ON #270: they read "8/24/2026, 9:05 AM" while the clock
 * was decided here and nowhere else, which became a lie the moment it got its own
 * control. Each setting shows only what it decides.
 */
export const dateFormatChoices = (now: Date = new Date()): { id: DateFormat; label: string; tip: string }[] =>
  DATE_FORMAT_ORDERS.map((o) => ({
    id: o.id,
    label: fmtDateNumeric(now, o.id),
    tip: `${o.order}, as ${o.pattern}`,
  }))

// UTC, EVERYWHERE IN THIS FILE, and it is the CORRECT reading rather than a workaround.
//
// A ROUTE'S CLOCK IS A WALL CLOCK AT THE DEPARTURE POINT: a rider who plans a 9am
// departure means 9am where the bike is, so nothing converts it into anyone's local
// time. The value rides in as though it were UTC — see public/js/route-clock.js, the
// only place that conversion happens — so reading it back as UTC returns the digits
// the rider typed.
//
// Until that call this file rendered UTC over a value the builder had stored in the
// BROWSER's zone, which is why 9am Pacific printed as 4:00 PM.
const UTC = { timeZone: 'UTC' } as const

/**
 * 08-24-2026 · 24-08-2026 · 2026-08-24 — dashes and two digits, in the rider's own
 * order.
 *
 * **THE LOCALE DECIDES THE ORDER AND NOTHING ELSE HERE.** It used to hand the whole
 * decision to Intl, which meant three different separators and three different
 * paddings as well as three orders. The order is the thing a rider chose; reading a
 * column of dates that change shape as well as sequence is harder than one that does
 * not.
 *
 * **THIS IS THE OPPOSITE CALL TO `fmtClock`'s AND BOTH ARE RIGHT.** That one refuses to
 * spell out `hour`/`minute` precisely so the locale keeps its own padding. Here the
 * padding IS the point: two digits always, so the fields line up.
 *
 * **JOINED FROM PARTS RATHER THAN STRING-REPLACING THE SEPARATOR.** A `/` swap works on
 * the three locales shipped today and silently would not on a fourth.
 */
export const fmtDateNumeric = (d: Date, f: DateFormat): string =>
  new Intl.DateTimeFormat(f, { year: 'numeric', month: '2-digit', day: '2-digit', ...UTC })
    .formatToParts(d)
    .filter((p) => p.type !== 'literal')
    .map((p) => p.value)
    .join('-')

/** Monday, August 24 — the roadbook's day heading. */
export const fmtDateLong = (d: Date, f: DateFormat): string =>
  d.toLocaleDateString(f, { weekday: 'long', month: 'long', day: 'numeric', ...UTC })

/** August 24, 2026 — the account page, where the year matters and the weekday does not. */
export const fmtDateFull = (d: Date, f: DateFormat): string =>
  d.toLocaleDateString(f, { year: 'numeric', month: 'long', day: 'numeric', ...UTC })

/** Aug — the dashboard's month axis. */
export const fmtMonthShort = (d: Date, f: DateFormat): string => d.toLocaleDateString(f, { month: 'short', ...UTC })

/**
 * 9:05 AM · 09:05 · 9:05 a.m. — the clock follows the locale unless the rider has said
 * otherwise.
 *
 * `timeStyle: 'short'` rather than `hour`/`minute` options, and the difference is real:
 * spelling the parts out imposes OUR padding on every locale, so en-GB came out "9:05"
 * where a 24-hour locale pads to "09:05".
 *
 * `clock` OVERRIDES `hour12` AND NOTHING ELSE (#270). It defaults to `locale`, which
 * resolves to `undefined` and spreads into the options as a no-op, so a caller that
 * does not pass one gets exactly the string this returned before the preference
 * existed.
 */
export const fmtClock = (d: Date, f: DateFormat, clock: Clock = DEFAULT_CLOCK): string =>
  d.toLocaleTimeString(f, { timeStyle: 'short', hour12: hour12For(clock), ...UTC })

/** 1,234 — grouping, so the dashboard stops hardcoding a separator. */
export const fmtNumber = (n: number, f: DateFormat): string => n.toLocaleString(f)

/**
 * A first guess from the browser's `Accept-Language`, for a rider who has not
 * chosen yet and for the roadbook of a public ride, which has no signed-in user
 * at all.
 *
 * DELIBERATELY CRUDE. The header is a weighted list and this reads only the
 * region off the first tag, because the question being answered is "which of
 * three digit orders", not "what is this person's full locale". Anything
 * unrecognized falls back to the default rather than guessing — a wrong guess is
 * worse than the default, since the default is at least consistent with what the
 * rider has seen so far.
 */
export function fromAcceptLanguage(header: string | undefined | null): DateFormat {
  const first = String(header ?? '')
    .split(',')[0]
    .trim()
  if (!first) return DEFAULT_DATE_FORMAT
  // An exact member wins outright — `en-GB` is both a header value and one of ours.
  const exact = DATE_FORMATS.find((f) => f.toLowerCase() === first.toLowerCase())
  if (exact) return exact
  const region = first.split('-')[1]?.toUpperCase()
  if (!region) return DEFAULT_DATE_FORMAT
  // The regions that use each order, kept short on purpose: this is a first
  // guess a rider can override in one click, not a locale database.
  if (DAY_FIRST_REGIONS.has(region)) return 'en-GB'
  if (YEAR_FIRST_REGIONS.has(region)) return 'en-CA'
  return DEFAULT_DATE_FORMAT
}

// Day-first is the majority of the world; this is not exhaustive and does not
// need to be. Anything absent gets the default and one click to fix it.
const DAY_FIRST_REGIONS = new Set([
  'GB',
  'IE',
  'AU',
  'NZ',
  'ZA',
  'IN',
  'DE',
  'FR',
  'ES',
  'IT',
  'NL',
  'BE',
  'PT',
  'BR',
  'AR',
  'MX',
  'CL',
  'PL',
  'RU',
  'TR',
  'GR',
  'DK',
  'NO',
  'FI',
  'CZ',
  'AT',
  'CH',
  'ID',
  'TH',
  'VN',
  'PH',
  'MY',
])

const YEAR_FIRST_REGIONS = new Set(['CA', 'JP', 'CN', 'KR', 'TW', 'HU', 'LT', 'SE'])
