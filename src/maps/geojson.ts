// GeoJSON import.
//
// The least code of any format, because GeoJSON already agrees with this app
// on the thing every other format argues about: coordinates are `[lng, lat]`,
// which is the storage order and the order `Track` is declared in. Only
// `google.maps` speaks `{lat, lng}`, and that conversion already happens at the
// map boundary. Nothing here swaps anything.
//
// It is also the one format with no XML in it, so the DOCTYPE defense that
// carries the KML path does not apply — JSON has no entities and no external
// references, and `JSON.parse` resolves nothing. What it *can* do is blow the
// stack on deeply nested input, so the parse is guarded.
import {
  RouteFileError,
  round6,
  sanitizeText,
  extracted,
  type ExtractedPoint,
  type ExtractedRoute,
  type Track,
} from './kml'
import { canonicalRole, parseRoleName, MAX_ROLES_PER_POINT, type Role } from './roles'

// Deep nesting is the only structural attack JSON.parse has, and V8 answers it
// with a RangeError rather than a crash. Rejecting early keeps the message
// useful; without this the failure surfaces as a 500.
const MAX_DEPTH = 64

function parseJson(text: string): unknown {
  // Cheap structural depth check before the parser runs, on the same principle
  // as rejecting a DOCTYPE before xmldom sees it: refuse the shape, do not
  // rely on catching what the parser does with it.
  let depth = 0
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[' || ch === '{') {
      if (++depth > MAX_DEPTH) throw new RouteFileError('GeoJSON file is nested too deeply')
    } else if (ch === ']' || ch === '}') depth--
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new RouteFileError('GeoJSON file is not valid JSON')
  }
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

// A GeoJSON position is [lng, lat] with an optional altitude that is discarded,
// the same as KML's third coordinate component.
//
// Out-of-range values are refused rather than corrected. A latitude above 90 is
// almost always a `[lat, lng]` file written by a tool that guessed, and silently
// swapping would turn a loud failure into a route drawn in the wrong hemisphere.
function position(v: unknown, where: string): [number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null
  const lng = Number(v[0])
  const lat = Number(v[1])
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  if (lat < -90 || lat > 90) {
    throw new RouteFileError(
      `GeoJSON ${where} has a latitude of ${lat}, which is out of range—coordinates must be [longitude, latitude]`,
    )
  }
  if (lng < -180 || lng > 180) {
    throw new RouteFileError(`GeoJSON ${where} has a longitude of ${lng}, which is out of range`)
  }
  return [round6(lng), round6(lat)]
}

function lineString(coords: unknown, where: string): Track {
  if (!Array.isArray(coords)) return []
  const out: Track = []
  for (const p of coords) {
    const pos = position(p, where)
    if (pos) out.push(pos)
  }
  return out
}

// Properties are free-form by specification, so the names are taken in the
// order the tools that produce these files actually use them.
const NAME_KEYS = ['name', 'Name', 'title', 'label']
const DESC_KEYS = ['description', 'Description', 'desc', 'notes', 'comment']

// An explicit `roles` array, as this app's own export writes. Anything that is
// not a role this app knows is dropped rather than rejected — a third-party
// file is entitled to its own vocabulary, and the cap is the same one
// parseRoleName enforces so the two paths cannot disagree on the limit.
function rolesFrom(props: Json | undefined): Role[] | null {
  const raw = props?.roles
  if (!Array.isArray(raw)) return null
  const out: Role[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const role = canonicalRole(v)
    if (role && !out.includes(role)) out.push(role)
    if (out.length === MAX_ROLES_PER_POINT) break
  }
  return out.length > 0 ? out : null
}

// Dwell time, which only this app's own export writes. Clamped to whole
// non-negative minutes rather than trusted: a negative or fractional dwell
// would propagate straight into the timeline's arithmetic.
const MAX_DURATION_MIN = 24 * 60

function duration(props: Json | undefined): number | null {
  const raw = props?.durationMin
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const n = Math.round(raw)
  if (n <= 0) return null
  return Math.min(n, MAX_DURATION_MIN)
}

function firstString(props: Json | undefined, keys: string[]): string {
  if (!props) return ''
  for (const k of keys) {
    const v = props[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}

type Collected = { lines: Track[]; points: Array<{ pos: [number, number]; props: Json | undefined }> }

// Walks whatever nesting the file uses. GeometryCollection is recursive by
// specification, so the depth guard above is what keeps this bounded.
function collect(geometry: unknown, props: Json | undefined, into: Collected, depth = 0): void {
  if (!isObj(geometry) || depth > MAX_DEPTH) return
  const type = geometry.type
  const coords = geometry.coordinates

  if (type === 'LineString') {
    // A one-point line is invalid by specification, but it is a real export —
    // a planner that saved before the second point was placed — and KML
    // accepts it as a zero-length track. Formats disagreeing on the same
    // degenerate shape is exactly what the cross-format tests exist to stop,
    // so this keeps it rather than rejecting the whole file.
    const line = lineString(coords, 'LineString')
    if (line.length > 0) into.lines.push(line)
    return
  }

  if (type === 'MultiLineString' || type === 'Polygon') {
    // A Polygon's rings are treated as lines. Nobody rides a polygon, but a
    // route traced as a closed shape in some editors comes out as one, and
    // drawing it is more useful than refusing it.
    if (Array.isArray(coords)) {
      for (const part of coords) {
        const line = lineString(part, String(type))
        if (line.length > 0) into.lines.push(line)
      }
    }
    return
  }

  if (type === 'Point') {
    const pos = position(coords, 'Point')
    if (pos) into.points.push({ pos, props })
    return
  }

  if (type === 'MultiPoint') {
    if (Array.isArray(coords)) {
      for (const p of coords) {
        const pos = position(p, 'MultiPoint')
        if (pos) into.points.push({ pos, props })
      }
    }
    return
  }

  if (type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
    for (const g of geometry.geometries) collect(g, props, into, depth + 1)
  }
}

function collectFeature(node: unknown, into: Collected, depth = 0): void {
  if (!isObj(node) || depth > MAX_DEPTH) return

  if (node.type === 'FeatureCollection') {
    if (Array.isArray(node.features)) {
      for (const f of node.features) collectFeature(f, into, depth + 1)
    }
    return
  }

  if (node.type === 'Feature') {
    collect(node.geometry, isObj(node.properties) ? node.properties : undefined, into)
    return
  }

  // A bare geometry object, which the specification allows as a document root.
  collect(node, undefined, into)
}

export function processGeoJson(text: string): ExtractedRoute {
  const root = parseJson(text)
  if (!isObj(root)) throw new RouteFileError('GeoJSON file has no object at its root')
  if (typeof root.type !== 'string') throw new RouteFileError('GeoJSON file has no "type" at its root')

  const found: Collected = { lines: [], points: [] }
  collectFeature(root, found)

  if (found.lines.length === 0 && found.points.length === 0) {
    throw new RouteFileError('GeoJSON file contains no lines or points')
  }

  // Every line is kept, in the order the document listed them. A file with
  // several is a file with several days far more often than it is one route
  // plus its scenery, and guessing wrong by taking the longest silently threw
  // the rest away.

  const points: ExtractedPoint[] = found.points.map(({ pos, props }) => {
    // Sanitized on the same principle as the KML path: names and descriptions
    // are rider-supplied text that reaches a rendered page, and the extraction
    // layer is where that is made safe rather than at render time alone.
    //
    // The name is parsed for a "GAS/FOOD - " prefix either way, because that is
    // the convention the README documents and other tools' files use it. An
    // explicit `roles` array wins when present — it is what this app's own
    // export writes, and it is unambiguous where the prefix is a guess.
    const { roles: fromName, name } = parseRoleName(sanitizeText(firstString(props, NAME_KEYS)))
    const explicit = rolesFrom(props)
    const description = sanitizeText(firstString(props, DESC_KEYS))
    return {
      lat: pos[1],
      lng: pos[0],
      name,
      description: description || null,
      roles: explicit ?? fromName,
      kind: props?.kind === 'poi' ? ('poi' as const) : ('stop' as const),
      durationMin: duration(props),
    }
  })

  return extracted(
    found.lines.map((track) => ({ track, name: null })),
    points,
  )
}
