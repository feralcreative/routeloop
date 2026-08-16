// How a stop's dwell time is written down, and read back.
//
// Storage does not change and this file does not touch it: `points.duration_min`
// is minutes, an integer, everywhere — in the database, in `ride.json`, in every
// export. This is a display layer over that one number, and that is the whole
// reason issue #96 is small. The roadbook, the timeline and the six export
// formats are untouched by anything here.
//
// WHY IT NEEDED WRITING AT ALL. The builder's duration field was raw minutes in
// a `type="number"`, and raw minutes stop being readable somewhere around an
// hour. The roadbook had already found this and fixed it locally — see the
// comment on fmtDuration() in src/routes/roadbook.tsx, which records an
// overnight camp stop printing "658m". The builder never got the same treatment,
// so the same stop was 658 in the panel and "10h 58m" on the printout.
//
// THREE FORMATS, NOT ONE, because the argument for each is real and they do not
// settle it between them:
//
//   'hours'   — 1.5. Ziad's default. It sorts, it does arithmetic in your head,
//               and it matches how riders talk about a day. The cost is
//               granularity: one decimal hour is six minutes, so a 20-minute gas
//               stop reads 0.3 and a 25-minute one reads 0.4. That is a real
//               loss and it is why the other two exist.
//   'hm'      — 1h 30m. Exact to the minute and the same shape the roadbook
//               prints, which is the one place a rider sees these numbers
//               outside the builder. hoursMinutes() below is what both use.
//   'minutes' — 90. What the field has always been. Exact, unreadable past an
//               hour, and the right answer for someone entering a lot of short
//               stops.
//
// PARSING IS THE HALF WITH THE BUGS, so the rule is stated once here: an
// explicit unit always wins, and a bare number is read in the format's own unit.
// "90" is ninety minutes under 'hm' and 'minutes' and ninety HOURS under
// 'hours', which sounds alarming until you notice that under 'hours' the field
// is showing "1.5" and a rider typing there means hours. Anyone who means
// minutes can type "90m" in any format and be understood.

export const DURATION_FORMATS = ['hours', 'hm', 'minutes'] as const
export type DurationFormat = (typeof DURATION_FORMATS)[number]

export const DEFAULT_DURATION_FORMAT: DurationFormat = 'hours'

// Thirty days, and it MUST match `.max(43200)` on durationMin in the ride-graph
// schema. The field used to be `type="number" max="43200"` and carried this
// implicitly; it is a text input now, so the ceiling moved into the parser or it
// would not exist at all. Over the limit clamps rather than refuses — the rider
// sees "720h 0m" appear when they leave the field, which says what happened,
// where letting it through means the whole ride's next autosave 400s on a field
// nothing points at.
export const MAX_DURATION_MIN = 43200

// Widened on purpose: this reads values that came off a form or out of a column,
// neither of which the type system has actually checked.
export function isDurationFormat(v: unknown): v is DurationFormat {
  return typeof v === 'string' && (DURATION_FORMATS as readonly string[]).includes(v)
}

export function toDurationFormat(v: unknown): DurationFormat {
  return isDurationFormat(v) ? v : DEFAULT_DURATION_FORMAT
}

// "4h 20m", or "35m" under the hour. The roadbook's fmtDuration() is this plus
// its own rule about zero, and public/js/duration.js is this again in the
// browser; test/duration.test.ts holds all three together.
//
// Minutes rather than seconds because that is what a stop stores. The roadbook
// works in seconds and divides on the way in.
export function hoursMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// One decimal, and the trailing zero is kept: "2.0" rather than "2".
//
// It looks like noise on a round number and it is not. The field is an editable
// heading of sorts — a column of them, one per stop — and a mixture of "2" and
// "1.5" down that column reads as two different units. Holding the decimal place
// makes the column scannable, which is most of what this format is for.
export function decimalHours(minutes: number): string {
  return (Math.max(0, minutes) / 60).toFixed(1)
}

export function formatDuration(minutes: number | null | undefined, format: DurationFormat): string {
  // Null is not zero. A blank field means "rode past without stopping", which is
  // the common case for a POI and a perfectly ordinary answer for a stop; zero
  // would claim someone stopped for no time at all.
  if (minutes == null || !Number.isFinite(minutes)) return ''
  if (format === 'hm') return hoursMinutes(minutes)
  if (format === 'minutes') return String(Math.max(0, Math.round(minutes)))
  return decimalHours(minutes)
}

// Everything the parser will take, in every format. Order matters: the compound
// forms have to be tried before the bare ones or "1h 30m" matches the "1h" rule
// and silently loses the minutes.
const COMPOUND = /^(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?\s*(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?$/i
const CLOCK = /^(\d+):([0-5]?\d)$/
const HOURS_ONLY = /^(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?$/i
const MINUTES_ONLY = /^(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?$/i
const BARE = /^(\d+(?:\.\d+)?)$/

// Text back to stored minutes, or null for "nothing here".
//
// Null and 0 are different answers and both are reachable: an empty field is
// null ("did not stop"), and a typed "0" is 0 ("stopped for no time", which is
// what a rider means when they clear a dwell but keep the stop). Anything
// unparseable is also null rather than 0 — refusing to guess is the point, and a
// typo must not silently become a real duration.
export function parseDuration(text: string, format: DurationFormat): number | null {
  const s = String(text ?? '').trim()
  if (s === '') return null

  const round = (n: number) =>
    Number.isFinite(n) ? Math.min(MAX_DURATION_MIN, Math.max(0, Math.round(n))) : null

  const compound = COMPOUND.exec(s)
  if (compound) return round(Number(compound[1]) * 60 + Number(compound[2]))

  // 1:30. Deliberately hours:minutes rather than minutes:seconds — seconds are
  // not stored and nobody schedules a stop to one.
  const clock = CLOCK.exec(s)
  if (clock) return round(Number(clock[1]) * 60 + Number(clock[2]))

  const hours = HOURS_ONLY.exec(s)
  if (hours) return round(Number(hours[1]) * 60)

  const mins = MINUTES_ONLY.exec(s)
  if (mins) return round(Number(mins[1]))

  const bare = BARE.exec(s)
  if (bare) return round(format === 'hours' ? Number(bare[1]) * 60 : Number(bare[1]))

  return null
}

// What the field should say when it is empty, and what its tooltip should call
// the unit. Both belong beside the format rather than in the markup, or the
// three go out of step the first time a fourth format is added.
export function durationPlaceholder(format: DurationFormat): string {
  if (format === 'hm') return '0h 0m'
  if (format === 'minutes') return 'min'
  return 'hrs'
}

export function durationUnitName(format: DurationFormat): string {
  if (format === 'hm') return 'hours and minutes'
  if (format === 'minutes') return 'minutes'
  return 'hours'
}

// Drives the phone keyboard. 'hm' has to accept letters and a space, so it gets
// the full keyboard; the other two are numeric fields that happen to be typed
// into a text input, because one input type across all three formats is one code
// path instead of three.
export function durationInputMode(format: DurationFormat): string {
  if (format === 'hm') return 'text'
  if (format === 'minutes') return 'numeric'
  return 'decimal'
}

// For the Settings page: the label and a worked example per format. Ninety
// minutes is the example everywhere because it is the value that looks different
// in all three, which is the entire question being asked.
export const DURATION_FORMAT_CHOICES: { id: DurationFormat; label: string; example: string }[] = [
  { id: 'hours', label: 'Hours', example: formatDuration(90, 'hours') },
  { id: 'hm', label: 'Hours and minutes', example: formatDuration(90, 'hm') },
  { id: 'minutes', label: 'Minutes', example: formatDuration(90, 'minutes') },
]
