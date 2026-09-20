// ONE NOTIFICATION FOR THE WHOLE BIN, NOT ONE PER RIDE.
//
// Ziad's call, 2026-09-20, after a month of real use: rides started reaching
// the end of their thirty days in numbers, and a warning per ride — which the
// email template had defended as "the correct noise level for something
// irreversible" — turned out to be a shit ton of notifications about one fact.
// The fact is "your bin is about to empty itself"; the rides are its detail.
//
// **THE DIGEST NAMES THE RIDES RATHER THAN COUNTING THEM**, which is the half
// of the old reasoning that survives: "3 rides will be destroyed" is a number a
// rider cannot act on without going and looking, and the names are what make
// them remember whether they meant it. It lists EVERY ride in the bin, soonest
// first, and not only the ones inside the warning window — a rider reading it
// is already looking at their bin, and telling them about three rides when
// five are scheduled is the kind of half-truth that gets one restored and four
// destroyed.
//
// **PURE, SO IT IS TESTABLE.** The sweep hands it the rows and the recipient's
// date format; nothing here reads a table or a clock of its own.
import { fmtDateNumeric, type DateFormat } from '../views/date-format'

export type BinRide = { title: string; purgeAfter: Date }

/** The column widths the digest has to fit, from the notifications table. */
export const TITLE_MAX = 160
export const BODY_MAX = 400

const DAY_MS = 86_400_000

/** Whole days until a purge, never below one: a ride going tomorrow has the
 *  rest of today, and "in 0 days" reads as already gone. */
export const daysUntil = (purgeAfter: Date, now: Date): number =>
  Math.max(1, Math.ceil((purgeAfter.getTime() - now.getTime()) / DAY_MS))

const inDays = (n: number): string => (n === 1 ? 'tomorrow' : `in ${n} days`)

/** One ride's line in the list: its name and the day it goes. */
export type BinLine = { title: string; purgeOn: string; daysLeft: number }

export function binLines(rides: readonly BinRide[], now: Date, format: DateFormat): BinLine[] {
  return [...rides]
    .sort((a, b) => a.purgeAfter.getTime() - b.purgeAfter.getTime())
    .map((r) => ({
      title: r.title,
      purgeOn: fmtDateNumeric(r.purgeAfter, format),
      daysLeft: daysUntil(r.purgeAfter, now),
    }))
}

/**
 * The title and body of the one notification, for a bin holding these rides.
 *
 * A single ride keeps the old shape — its name in the title, because that is
 * still the best sentence for one — and several get a count in the title and
 * the names in the body. **THE BODY IS CUT TO ITS COLUMN BY DROPPING NAMES,
 * NEVER BY CUTTING ONE IN HALF**: a list ending "and 4 more" is honest and a
 * name ending mid-word is not, and the closing sentence always survives the
 * cut because it is the one telling the rider what to do.
 */
export function binDigest(rides: readonly BinRide[], now: Date, format: DateFormat): { title: string; body: string } {
  const lines = binLines(rides, now, format)
  if (lines.length === 0) return { title: '', body: '' }
  const first = lines[0]
  const closing = 'Restore anything you want to keep from your bin.'

  if (lines.length === 1) {
    return {
      title: fit(`${first.title} is deleted for good ${inDays(first.daysLeft)}`, TITLE_MAX),
      body: fit(`Restoring it from your bin before ${first.purgeOn} keeps it.`, BODY_MAX),
    }
  }

  const title = fit(
    `${lines.length} rides in your bin are deleted for good, the first ${inDays(first.daysLeft)}`,
    TITLE_MAX,
  )
  // As many names as fit, then "and N more".
  const named = lines.map((l) => `${l.title} (${l.purgeOn})`)
  let body = ''
  for (let keep = named.length; keep >= 1; keep--) {
    const rest = named.length - keep
    const list = named.slice(0, keep).join(', ') + (rest > 0 ? `, and ${rest} more` : '')
    body = `${list}. ${closing}`
    if (body.length <= BODY_MAX) return { title, body }
  }
  // Even one name overflows: count them instead.
  return { title, body: fit(`${lines.length} rides, the first on ${first.purgeOn}. ${closing}`, BODY_MAX) }
}

/** Hard cap for a title, which has no list to trim: an ellipsis rather than a
 *  column error, on the one field a ride's own name can overflow. */
const fit = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)
