// CSV import: a list of stops, not a route.
//
// This is the narrowest format the app accepts and deliberately so. A CSV has
// no geometry, so a ride imported from one has pins and no line, no mileage and
// no twistiness — those come from routing it in the builder afterwards. Saying
// that plainly is better than inventing a track by joining the stops with
// straight lines, which would report a distance no motorcycle can ride and a
// twistiness of zero for a road that might be the best in the state.
//
// The parser is RFC 4180 rather than `split(',')`, because the fields most
// likely to be quoted are exactly the ones riders type: "Chevron, Petaluma"
// and a description with a comma in it are not edge cases, they are Tuesday.
import { RouteFileError, round6, sanitizeText, type ExtractedPoint, type ExtractedRoute } from './kml'
import { canonicalRole, parseRoleName, MAX_ROLES_PER_POINT, type Role } from './roles'

// Matches the builder's own ceiling (rides.ts), so a CSV cannot create a ride
// the builder would then refuse to save.
const MAX_ROWS = 200
const MAX_DURATION_MIN = 24 * 60

// --- Parsing ---------------------------------------------------------------

// A quoted field may contain the delimiter, a newline, or a doubled quote.
// Everything outside quotes is literal. Both CRLF and LF end a record, and a
// lone CR is treated as one too — some exports from older Mac tools use it.
function parseRows(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    // A trailing newline produces one empty field, which is not a record.
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }

  while (i < text.length) {
    const ch = text[i]

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    if (ch === '"' && field === '') {
      quoted = true
      i++
      continue
    }
    if (ch === delim) {
      endField()
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      endRow()
      if (ch === '\r' && text[i + 1] === '\n') i++
      i++
      continue
    }
    field += ch
    i++
  }

  if (field !== '' || row.length > 0) endRow()
  return rows
}

// Sniffed from the header rather than assumed: a semicolon file is what any
// spreadsheet saves in a locale where the comma is the decimal separator, and
// refusing those would refuse most of Europe.
function sniffDelimiter(firstLine: string): string {
  const counts = [',', ';', '\t', '|'].map((d) => ({
    d,
    // Only count delimiters outside quotes, or a single quoted field
    // containing commas would win the vote on its own.
    n:
      firstLine
        .split('"')
        .filter((_, k) => k % 2 === 0)
        .join('')
        .split(d).length - 1,
  }))
  counts.sort((a, b) => b.n - a.n)
  return counts[0].n > 0 ? counts[0].d : ','
}

// --- Header mapping --------------------------------------------------------

// Compared with punctuation and case removed, so "Latitude", "latitude" and
// "LAT_" are the same column.
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

const COLUMNS = {
  lat: ['lat', 'latitude', 'y'],
  lng: ['lng', 'lon', 'long', 'longitude', 'x'],
  name: ['name', 'title', 'label', 'stop', 'waypoint', 'place'],
  description: ['description', 'desc', 'notes', 'note', 'comment', 'comments'],
  roles: ['roles', 'role', 'type', 'category', 'categories'],
  kind: ['kind'],
  durationMin: ['durationmin', 'duration', 'dwell', 'dwellmin', 'minutes', 'stopminutes'],
} as const

type Column = keyof typeof COLUMNS

function mapHeader(header: string[]): Partial<Record<Column, number>> {
  const found: Partial<Record<Column, number>> = {}
  header.forEach((raw, i) => {
    const key = normalize(raw)
    if (!key) return
    for (const [col, aliases] of Object.entries(COLUMNS) as Array<[Column, readonly string[]]>) {
      // First column wins: a file with both "name" and "title" uses "name",
      // and a duplicate header does not silently shadow the earlier one.
      if (found[col] === undefined && aliases.includes(key)) found[col] = i
    }
  })
  return found
}

// --- Values ----------------------------------------------------------------

// Accepts a decimal comma as well as a point, because that is what a
// semicolon-delimited file from the same locale will contain. Degrees-minutes
// notation is deliberately not accepted — guessing at "37 46.5 N" is how a
// stop ends up in the wrong hemisphere without anyone noticing.
function coord(raw: string, kind: 'latitude' | 'longitude', line: number): number {
  const cleaned = raw.trim().replace(',', '.')
  const n = Number(cleaned)
  if (cleaned === '' || !Number.isFinite(n)) {
    throw new RouteFileError(`CSV row ${line}: "${raw.trim()}" is not a ${kind}`)
  }
  const limit = kind === 'latitude' ? 90 : 180
  if (n < -limit || n > limit) {
    throw new RouteFileError(`CSV row ${line}: ${kind} ${n} is out of range`)
  }
  return round6(n)
}

function rolesFrom(raw: string): Role[] {
  const out: Role[] = []
  for (const token of raw.split(/[/,;|]/)) {
    const role = canonicalRole(token)
    if (role && !out.includes(role)) out.push(role)
    if (out.length === MAX_ROLES_PER_POINT) break
  }
  return out
}

function durationFrom(raw: string): number | null {
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) return null
  const rounded = Math.round(n)
  if (rounded <= 0) return null
  return Math.min(rounded, MAX_DURATION_MIN)
}

// --- Entry point -----------------------------------------------------------

export function processCsv(text: string): ExtractedRoute {
  // A byte-order mark would make the first header cell "﻿name" and every
  // column lookup miss, which presents as "no latitude column" on a file that
  // plainly has one.
  const body = text.replace(/^﻿/, '')
  if (!body.trim()) throw new RouteFileError('CSV file is empty')

  const rows = parseRows(body, sniffDelimiter(body.split(/\r\n|\r|\n/, 1)[0] ?? ''))
  if (rows.length === 0) throw new RouteFileError('CSV file is empty')

  const cols = mapHeader(rows[0])
  if (cols.lat === undefined || cols.lng === undefined) {
    // Naming what was found is the difference between a fixable error and a
    // shrug — the usual cause is a file with no header row at all.
    const seen =
      rows[0]
        .map((h) => h.trim())
        .filter(Boolean)
        .join(', ') || '(nothing)'
    throw new RouteFileError(`CSV file needs a header row with latitude and longitude columns. Found: ${seen}`)
  }

  const points: ExtractedPoint[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    // A short row — fewer cells than the header — reads as empty rather than
    // undefined, so a missing coordinate becomes a message naming the row
    // instead of a crash.
    const cell = (col: Column) => {
      const at = cols[col]
      return at === undefined ? '' : (row[at] ?? '')
    }

    // A blank line in the middle of a file is padding, not a stop at 0,0.
    if (row.every((c) => c.trim() === '')) continue

    // Row numbers are the ones a spreadsheet shows, so the message points at
    // the line the rider is looking at.
    const lineNo = r + 1
    const lat = coord(cell('lat'), 'latitude', lineNo)
    const lng = coord(cell('lng'), 'longitude', lineNo)

    const explicit = rolesFrom(sanitizeText(cell('roles')))
    const { roles: fromName, name } = parseRoleName(sanitizeText(cell('name')))
    const description = sanitizeText(cell('description'))

    points.push({
      lat,
      lng,
      name: name || `Stop ${points.length + 1}`,
      description: description || null,
      roles: explicit.length > 0 ? explicit : fromName,
      kind: normalize(cell('kind')) === 'poi' ? 'poi' : 'stop',
      durationMin: durationFrom(cell('durationMin')),
    })

    if (points.length > MAX_ROWS) {
      throw new RouteFileError(`CSV file has more than ${MAX_ROWS} stops, which is the limit per day`)
    }
  }

  if (points.length === 0) throw new RouteFileError('CSV file has a header but no stops')

  // No geometry, and none invented. See the note at the top of this file.
  return { points, track: [], trackMeters: 0 }
}
