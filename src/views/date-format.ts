// How a date and a clock are written down, per rider.
//
// The problem this fixes: five server-rendered surfaces formatted dates with a
// hardcoded `'en-US'` — the roadbook's date and clock, the account page, and the
// dashboard's month labels and number grouping. The BUILDER was already correct
// and always has been, because `<input type="datetime-local">` renders in the
// viewer's own locale and hands back an ISO string regardless. So a rider outside
// the US planned a day in `24/08/2026` and printed a roadbook that said
// `08/24/2026` — the same product disagreeing with itself.
//
// A DISPLAY LAYER ONLY, exactly like src/maps/duration.ts, whose shape this
// follows. Nothing here touches storage: `days.start_at` stays a timestamp with
// an offset, `ride.json` stays ISO, and every export is untouched.
//
// THE MEMBERS ARE REAL LOCALE TAGS, and that is the one judgement call worth
// stating. The alternative was an abstract `mdy` / `dmy` / `ymd` enum, which
// would have fixed the digit order and left me formatting by hand. Passing a real
// tag to Intl means:
//
//   - the clock follows too, which an order-only enum cannot do: en-GB is a
//     24-hour locale, so a British rider gets 09:05 rather than 9:05 AM;
//   - month and weekday names come from the same source as the numbers;
//   - number grouping COULD come along, via fmtNumber below;
//   - adding a locale later is one enum member and no formatter changes.
//
// NUMBER GROUPING IS NOT WIRED UP YET, and deliberately. `fmtMiles` and
// `fmtCount` in src/stats/shape.ts still carry a hardcoded 'en-US', because all
// three members shipped here are English and group identically as 1,234 — so
// threading a format through ten call sites in a pure module would change nothing
// anyone can see. `fmtNumber` exists for the day a member like `de-DE` (1.234)
// lands, which is when that churn starts buying something.
//
// THREE MEMBERS, ONE PER DIGIT ORDER, not a catalogue of locales. Verified
// against Intl rather than assumed:
//
//   en-US  8/24/2026    Monday, August 24    9:05 AM
//   en-GB  24/08/2026   Monday 24 August     09:05
//   en-CA  2026-08-24   Monday, August 24    9:05 a.m.
//
// TRANSLATION IS NOT IN SCOPE and this does not pretend otherwise. All three
// members render English words, because the app has no i18n framework and a date
// preference is not one. A rider in Berlin gets their date order and the word
// "August".

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

/** The settings page's radio set. `example` is the same instant in all three. */
export const DATE_FORMAT_CHOICES: { id: DateFormat; label: string; example: string }[] = [
  { id: 'en-US', label: 'Month first', example: '8/24/2026, 9:05 AM' },
  { id: 'en-GB', label: 'Day first', example: '24/08/2026, 09:05' },
  { id: 'en-CA', label: 'Year first (ISO)', example: '2026-08-24, 9:05 a.m.' },
]

// UTC, EVERYWHERE IN THIS FILE, and it is the CORRECT reading rather than a
// workaround — which is what it used to be.
//
// A DAY'S CLOCK IS A WALL CLOCK AT THE DEPARTURE POINT. Ziad's call, 2026-08-24:
// a time is a time is a time at the departure point. A rider who plans a 9am
// departure means 9am where the bike is, whether they planned it from home or
// from London two weeks before flying out — so nothing converts it into anyone's
// local time, ever. The value rides in as though it were UTC (see the header of
// public/js/day-clock.js, which is the only place that conversion happens), so
// reading it back as UTC returns the digits the rider typed.
//
// Until that call this file rendered UTC over a value the builder had stored in
// the BROWSER's zone, which is why 9am Pacific printed as 4:00 PM. The formatters
// did not change; what they are handed did.
const UTC = { timeZone: 'UTC' } as const

/** 8/24/2026 · 24/08/2026 · 2026-08-24 */
export const fmtDateNumeric = (d: Date, f: DateFormat): string => d.toLocaleDateString(f, UTC)

/** Monday, August 24 — the roadbook's day heading. */
export const fmtDateLong = (d: Date, f: DateFormat): string =>
  d.toLocaleDateString(f, { weekday: 'long', month: 'long', day: 'numeric', ...UTC })

/** August 24, 2026 — the account page, where the year matters and the weekday does not. */
export const fmtDateFull = (d: Date, f: DateFormat): string =>
  d.toLocaleDateString(f, { year: 'numeric', month: 'long', day: 'numeric', ...UTC })

/** Aug — the dashboard's month axis. */
export const fmtMonthShort = (d: Date, f: DateFormat): string => d.toLocaleDateString(f, { month: 'short', ...UTC })

/**
 * 9:05 AM · 09:05 · 9:05 a.m. — the clock follows the locale, which is the point.
 *
 * `timeStyle: 'short'` rather than `hour`/`minute` options, and the difference is
 * real: spelling the parts out imposes OUR padding on every locale, so en-GB came
 * out "9:05" where a 24-hour locale pads to "09:05". Handing the whole decision to
 * Intl gets the AM/PM, the separator and the padding each locale actually uses.
 * The roadbook's original used the explicit options, which was invisible while
 * the only locale was en-US.
 */
export const fmtClock = (d: Date, f: DateFormat): string => d.toLocaleTimeString(f, { timeStyle: 'short', ...UTC })

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
  'GB', 'IE', 'AU', 'NZ', 'ZA', 'IN', 'DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'PT', 'BR', 'AR', 'MX', 'CL',
  'PL', 'RU', 'TR', 'GR', 'DK', 'NO', 'FI', 'CZ', 'AT', 'CH', 'ID', 'TH', 'VN', 'PH', 'MY',
])

const YEAR_FIRST_REGIONS = new Set(['CA', 'JP', 'CN', 'KR', 'TW', 'HU', 'LT', 'SE'])
