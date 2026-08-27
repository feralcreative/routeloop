// The route-file naming convention.
//
// Two lossy edges meet in a filename. GPX and KML carry no dates at all, so a
// ride exported as the format every GPS actually reads loses its schedule —
// `days.start_at` survives a round trip through Routeloop JSON and nowhere else. And
// importing a folder is data entry the files already describe: day order comes
// from whatever order the browser lists them in, and the ride name is typed by
// hand every time.
//
//   routeloop_big-sur-run_d02_2026-08-14_lost-coast.gpx
//   \_______/ \__________/ \_/ \________/ \_________/
//    marker      ride      day     date       title
//
// **A filename cannot hold the ride and is not trying to.** Roles, dwell, via
// points, per-day colors and the stop/POI distinction do not fit in one and are
// not going in one — Routeloop JSON stays the lossless format (see export.ts).
// This carries the four fields the lossy formats drop, and nothing else.
//
// Three rules the whole design rests on:
//
// - **Underscores separate fields; hyphens live inside one.** A field never
//   contains an underscore, so a day title with a dash in it cannot split the
//   filename. This is the entire reason the separator is not a hyphen throughout.
// - **The marker is load-bearing, not decoration.** Its presence is what says
//   "this name is structured". Without it `parseExportName` returns null and the
//   caller takes the path it always took — a rider's own `day-2.gpx` is never
//   silently reinterpreted.
// - **Optional fields are identified by shape, not position**, so
//   `routeloop_big-sur-run_d02.gpx` and `routeloop_big-sur-run_2026-08-14.gpx`
//   both parse. Order among those that are present is still fixed.
//
// Deliberately NOT fields: visibility (a file named `public` that publishes a
// ride on import is a footgun with no upside) and timezone (see fmtDate below).

/** The literal first field on every name this app writes. Its presence is the whole signal. */
export const MARKER = 'routeloop'

/**
 * Markers accepted on read, newest first. `tankbag` is the name this app shipped
 * under between 2026-07-29 and 2026-08-11, so every file exported in that window
 * carries it — and the date field is the one thing GPX and KML cannot hold
 * internally. Refusing the old marker would lose day order and dates on
 * re-import, and would do it silently: the files still import, just as one ride
 * in upload order. Write MARKER, read all of these, forever.
 */
const READ_MARKERS = [MARKER, 'tankbag']

/** Cap per text field. Five fields well under any filesystem's 255-byte limit. */
const MAX_FIELD = 60

const DAY_RE = /^d(\d{1,3})$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})(\d{2}))?$/

/** No leading dot. The native extension this app writes. */
export const NATIVE_EXT = 'routeloop.json'

// Native export is `.routeloop.json` — two dots, one extension. Stripping only
// the last part would leave `.routeloop` on the end of the ride field. The
// legacy `.tankbag.json` is listed for the same reason READ_MARKERS exists.
const COMPOUND_EXTS = [NATIVE_EXT, 'tankbag.json']

/**
 * Normalize one field: lowercase, diacritics folded, everything else to hyphens.
 *
 * Lossy on purpose and in one direction only — `slugField('Lost Coast')` is
 * `lost-coast`, and getting `Lost Coast` back out of that is a guess. See
 * titleFromSlug, and note that callers prefer a file's own internal name over
 * anything recovered from its filename.
 */
export function slugField(s: string, max = MAX_FIELD): string {
  return (
    (s ?? '')
      .normalize('NFKD')
      // Combining marks. NFKD above splits "ñ" into "n" plus a combining tilde;
      // dropping the mark folds "Cañón" to "canon" instead of letting the
      // catch-all below turn it into "ca-on". The Unicode property escape is
      // used rather than a literal codepoint range, which is unreadable in
      // source and vulnerable to any tool that normalizes this file.
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, max)
      // The slice can leave a trailing hyphen where it landed mid-word.
      .replace(/-$/, '')
  )
}

/**
 * A slug read back as a title. A guess, and labeled one everywhere it is used:
 * word boundaries and capitalisation were destroyed by slugField and cannot be
 * recovered, so "avenue-of-giants" comes back "Avenue Of Giants". Callers use
 * this only where the file itself offers nothing better.
 */
export function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// `days.start_at` carries a WALL CLOCK at the departure point, as UTC — see the
// header of public/js/day-clock.js — and the roadbook renders it with
// `timeZone: 'UTC'` for that reason. Formatting a filename any other way would
// let a roadbook and a filename disagree about which day a route is on, so these
// two are UTC for the same reason and must stay matched to it.
//
// No zone in the filename itself, and now none is missing: the digits ARE the
// wall clock. A filename claiming a zone would invent one.
function fmtDate(d: Date): string {
  const iso = d.toISOString()
  const date = iso.slice(0, 10)
  const hhmm = iso.slice(11, 13) + iso.slice(14, 16)
  // Midnight is what an undated-but-scheduled day looks like, and writing
  // `T0000` on every one of them is noise. Any other time is real information.
  return hhmm === '0000' ? date : `${date}T${hhmm}`
}

function parseDate(token: string): { date: Date; hasTime: boolean } | null {
  const m = DATE_RE.exec(token)
  if (!m) return null
  const [, y, mo, d, hh, mm] = m
  const date = new Date(Date.UTC(+y, +mo - 1, +d, hh ? +hh : 0, mm ? +mm : 0))
  // Round-trip check, which is what rejects 2026-02-30 and 2026-13-01 — the
  // Date constructor rolls those over silently rather than failing.
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d) return null
  return { date, hasTime: Boolean(hh) }
}

/** Split `a_b.routeloop.json` into its stem and its full extension. */
export function splitExt(fileName: string): { stem: string; ext: string } {
  const lower = fileName.toLowerCase()
  for (const ext of COMPOUND_EXTS) {
    if (lower.endsWith(`.${ext}`)) return { stem: fileName.slice(0, -(ext.length + 1)), ext }
  }
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return { stem: fileName, ext: '' }
  return { stem: fileName.slice(0, dot), ext: lower.slice(dot + 1) }
}

export type ExportNameParts = {
  ride: string
  /** 1-based, matching the "Day N" a rider sees. Null when the name omits it. */
  day?: number | null
  date?: Date | null
  title?: string | null
  /** No leading dot. `routeloop.json` for the native format. */
  ext: string
}

/**
 * Build a conforming filename. Absent optional fields are skipped rather than
 * written empty, so the result never carries a `__`.
 *
 * The day is written even for a single-day ride: two days titled "Rest Day"
 * slug identically, and `dNN` is the only field keeping such filenames distinct.
 * Zero-padded to two so `d10` sorts after `d09` in any file listing.
 */
export function buildExportName(parts: ExportNameParts): string {
  const fields = [MARKER, slugField(parts.ride) || 'ride']

  if (parts.day != null) fields.push(`d${String(parts.day).padStart(2, '0')}`)
  if (parts.date) fields.push(fmtDate(parts.date))

  const title = parts.title ? slugField(parts.title) : ''
  if (title) fields.push(title)

  return `${fields.join('_')}${parts.ext ? `.${parts.ext}` : ''}`
}

export type ParsedName = {
  ride: string
  day: number | null
  date: Date | null
  /** Whether the date field carried a time, as opposed to a bare day. */
  hasTime: boolean
  title: string | null
  ext: string
}

/**
 * Read a conforming filename. Returns null for anything carrying none of
 * READ_MARKERS, which is the signal to callers that they should do exactly what
 * they did before this convention existed.
 *
 * Forgiving within a marked name, because the likeliest author of a malformed
 * one is a rider renaming a file rather than an attacker: text fields are
 * re-normalized, a single-digit day is accepted even though this writes two,
 * and tokens past the title are folded into it instead of failing the parse.
 * An unparseable date field is left to be read as title text rather than
 * rejecting the name outright.
 */
export function parseExportName(fileName: string): ParsedName | null {
  const { stem, ext } = splitExt(fileName)
  const tokens = stem.split('_')
  if (tokens.length < 2 || !READ_MARKERS.includes(tokens[0].toLowerCase())) return null

  const rest = tokens.slice(1)
  const ride = slugField(rest[0])
  if (!ride) return null

  let i = 1
  let day: number | null = null
  let date: Date | null = null
  let hasTime = false

  const dayMatch = i < rest.length ? DAY_RE.exec(rest[i]) : null
  if (dayMatch) {
    const n = Number(dayMatch[1])
    // `d00` is not a day. Left unconsumed so it reads as title text.
    if (n >= 1) {
      day = n
      i++
    }
  }

  if (i < rest.length) {
    const d = parseDate(rest[i])
    if (d) {
      date = d.date
      hasTime = d.hasTime
      i++
    }
  }

  const title = slugField(rest.slice(i).join('-')) || null

  return { ride, day, date, hasTime, title, ext }
}

export type PlannedFile = {
  fileName: string
  /** Position as supplied, before any reordering. */
  index: number
  day: number | null
  date: Date | null
  /** Whether the date field carried a time. A bare day is not midnight, it is undated. */
  hasTime: boolean
  title: string | null
  ext: string
  /** Whether this name carried the marker at all. */
  conforming: boolean
}

export type ImportPlan = {
  /** The ride title, recovered from the shared ride field. Null if nothing conformed. */
  ride: string | null
  files: PlannedFile[]
  /** True only when every file carried the marker. */
  allConforming: boolean
  /** True when the files were reordered by their day fields rather than left as supplied. */
  reordered: boolean
  /** True when conforming files disagree about which ride they belong to. */
  rideConflict: boolean
}

/**
 * Turn a list of dropped filenames into everything the importer would otherwise
 * ask a rider to type. This is the function the drop box previews and the
 * import endpoint acts on, so the two cannot disagree about what a folder means.
 *
 * **THAT LAST CLAUSE STOPPED BEING THE WHOLE STORY ON 2026-08-26.** It held while
 * the preview was read-only. The review table (#129) makes it editable, and the
 * moment a rider can retype a date the server cannot re-derive it — so the
 * corrections travel with the upload as a manifest, and this stays the GUESS both
 * sides start from rather than the last word either of them has. See
 * maps/manifest.ts, which is the rider's answer to what this returns.
 *
 * Ordering is the part worth stating: files are sorted by their day field only
 * when **every** file has one. A partial set has no defensible order — sorting
 * it would interleave numbered and unnumbered days by an invented rule — so the
 * supplied order stands, which is what the importer did before this existed.
 */
export function planImport(fileNames: string[]): ImportPlan {
  const files: PlannedFile[] = fileNames.map((fileName, index) => {
    const p = parseExportName(fileName)
    return {
      fileName,
      index,
      day: p?.day ?? null,
      date: p?.date ?? null,
      hasTime: p?.hasTime ?? false,
      title: p?.title ?? null,
      ext: p?.ext ?? splitExt(fileName).ext,
      conforming: p !== null,
    }
  })

  const parsed = fileNames.map(parseExportName)
  const rides = parsed.filter((p): p is ParsedName => p !== null).map((p) => p.ride)
  const ride = rides.length > 0 ? titleFromSlug(rides[0]) : null
  const rideConflict = rides.some((r) => r !== rides[0])

  const everyDay = files.length > 0 && files.every((f) => f.day != null)
  if (everyDay) {
    // Stable on ties: two files claiming d02 keep the order they arrived in
    // rather than swapping unpredictably.
    files.sort((a, b) => a.day! - b.day! || a.index - b.index)
  }

  return {
    ride,
    files,
    allConforming: files.length > 0 && files.every((f) => f.conforming),
    reordered: everyDay && files.some((f, n) => f.index !== n),
    rideConflict,
  }
}

/**
 * Make a name unique against the ones already used, by numbering it.
 *
 * TWO FILES IN A ZIP CANNOT SHARE A NAME, and this convention hands out the same
 * one to two rides with the same title, the same start date and the same format
 * — which the export cart (#131) made reachable, since it puts several rides in
 * one archive. It is rare and it is SILENT: most extractors keep the last entry
 * and drop the rest, so a rider gets four files out of five and no message.
 *
 * The suffix goes before the extension, and the extension here is everything
 * from the FIRST dot — `routeloop.json` is one extension, not `.json` after a
 * name ending in `routeloop`. Numbering after it would produce
 * `ride.routeloop.json-2`, which is not a JSON file to anything that looks at
 * names.
 *
 * Mutates `used`, because every caller wants exactly that: the set is the record
 * of what has been handed out, and a caller that had to add the result itself is
 * a caller that can forget to.
 */
export function uniqueName(used: Set<string>, name: string): string {
  const claim = (n: string) => (used.add(n), n)
  if (!used.has(name)) return claim(name)

  const dot = name.indexOf('.')
  const base = dot < 0 ? name : name.slice(0, dot)
  const ext = dot < 0 ? '' : name.slice(dot)
  let n = 2
  while (used.has(`${base}-${n}${ext}`)) n++
  return claim(`${base}-${n}${ext}`)
}
