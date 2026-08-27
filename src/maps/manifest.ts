// The import review manifest: what a rider corrected before committing an
// import.
//
// **THIS IS THE MODULE THAT BREAKS AN INVARIANT ON PURPOSE.** filename.ts says
// of planImport() that "this is the function the drop box previews and the
// import endpoint acts on, so the two cannot disagree about what a folder
// means." That held while the preview was READ-ONLY. #129 makes it editable, and
// the moment a rider can retype a date the server can no longer re-derive it —
// so the corrected values travel with the upload instead. planImport() is still
// the guess and still runs on both sides; this is the rider's answer to it.
//
// Pure, and deliberately so: it is a function of a JSON string plus the list of
// posted filenames, with no database and no File contents, which is what lets
// test/import-manifest.test.ts cover the whole rule.
//
// THE STAGING DECISION BEHIND THE SHAPE. Ziad's call, 2026-08-26: the files stay
// in the browser between the review and the commit. There is no stage id, no
// temp directory, no expiry sweep and no quota accounting for an import nobody
// finished — the page holds the files and posts them once, with this manifest
// beside them in the same multipart body. The cost is stated rather than hidden:
// **a zip cannot be reviewed**, because nothing unzips in the browser, so an
// archive's days are still read on the way in.
import { z } from 'zod'
import { MAX_SOURCE_FILES } from './storage'

/** One reviewed file, as the server uses it. */
export type ReviewEntry = {
  fileName: string
  /**
   * The day's name, as the rider typed it. Null means they typed nothing.
   *
   * NOT "this day has no name" — the review table shows a name only when the
   * FILENAME carried one, because nothing in the browser opens a GPX to read its
   * <trk><name>. So an empty box is an unanswered question, and the caller lets
   * the file's own name win. A typed name outranks everything. See the note in
   * addDays in routes/maps.ts, which is where that precedence lives.
   */
  title: string | null
  /** The day's start, as a wall clock at the departure point carried as UTC.
   *  Null means undated. */
  startAt: Date | null
}

/**
 * A wall clock, from an `<input type="date">` or `<input type="datetime-local">`.
 *
 * PARSED AS UTC, and that is the rule the whole app follows rather than a
 * shortcut here: a day's clock is a wall clock at the departure point, carried
 * as UTC and rendered with `timeZone: 'UTC'` everywhere. A rider in London
 * typing a California ride's 9am start means 9am in California. See
 * public/js/day-clock.js, which is the client half of the same conversion.
 *
 * A bare date is undated-with-a-day rather than midnight-local — it becomes
 * midnight UTC, which is exactly what a filename's bare date already does
 * (parseDate in filename.ts), so a date typed here and a date read off a
 * filename land on the same instant.
 */
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/

export function parseWallClock(value: string): Date | null {
  const m = WALL_CLOCK.exec(value.trim())
  if (!m) return null
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0'].map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi))
  // Round-tripped rather than trusted: Date.UTC rolls 31 February forward to
  // 3 March without complaining, and a silently moved day is worse than a
  // refusal a rider can see.
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null
  return date
}

/**
 * The wire shape. `fileName` rides along beside the position it is already
 * implied by, because the two together are what make this self-checking: an
 * entry has to name the file it lands on, so a manifest built against one
 * selection and posted with another is refused rather than applied to the wrong
 * day. That is the failure this whole feature invites — the rider edits, changes
 * the selection, and the edits silently follow the index.
 */
const entrySchema = z.object({
  fileName: z.string().min(1).max(255),
  // Empty string and absent are the same thing and both mean "no name": a text
  // input a rider cleared posts "", and coercing it to null here is what keeps
  // the server from storing a day called "".
  title: z.string().trim().max(150).nullish(),
  startAt: z.string().trim().max(32).nullish(),
})

export const manifestSchema = z.array(entrySchema).min(1).max(MAX_SOURCE_FILES)

export type ManifestResult = { ok: true; entries: ReviewEntry[] } | { ok: false; error: string }

/**
 * Parse and check a manifest against the names actually posted.
 *
 * ONE ENTRY PER POSTED FILE, IN ORDER, AND THE NAMES MUST MATCH. Strict on
 * purpose, and the alternative is worse in a way that cannot be seen: matching
 * by name alone silently mis-assigns when two folders both hold `day-1.gpx`, and
 * matching by index alone silently mis-assigns when the selection changed after
 * the review. Requiring both means a disagreement is a 400 rather than a ride
 * whose second day is dated with the third day's date.
 *
 * A ZIP GETS AN ENTRY AND THE ENTRY DOES NOTHING. Its expanded files are not in
 * the manifest — the browser never saw them — so they keep everything
 * planImport() derives. The row exists so the positions still line up, and the
 * review table renders it as an archive whose days are read on upload.
 *
 * ORDER IS THE POSTED ORDER, and the caller's job is only to stop re-sorting by
 * day number when a manifest is present. The client rebuilds its own file input
 * in the order the rider dragged, so the two are the same list and the check
 * above is what proves it.
 */
export function readManifest(raw: string, postedNames: string[]): ManifestResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'the import review could not be read—reload and try again' }
  }

  const parsed = manifestSchema.safeParse(json)
  if (!parsed.success) return { ok: false, error: 'the import review could not be read—reload and try again' }
  if (parsed.data.length !== postedNames.length) {
    return { ok: false, error: 'the import review does not match the files posted—reload and try again' }
  }

  const entries: ReviewEntry[] = []
  for (const [i, e] of parsed.data.entries()) {
    if (e.fileName !== postedNames[i]) {
      return { ok: false, error: 'the import review does not match the files posted—reload and try again' }
    }
    let startAt: Date | null = null
    if (e.startAt) {
      startAt = parseWallClock(e.startAt)
      if (!startAt) return { ok: false, error: `${e.fileName}: "${e.startAt}" is not a date` }
    }
    entries.push({ fileName: e.fileName, title: e.title?.trim() || null, startAt })
  }
  return { ok: true, entries }
}
