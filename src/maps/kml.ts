// The security-critical half of the import pipeline (ported from the PHP-era
// spec in _PLANS/multi-tenant-rebuild.md), extended with structured
// extraction: imports produce DB rows (points + track), not just files.
//
// Order of defenses: reject any <!DOCTYPE> before the parser ever runs (kills
// external-entity and billion-laughs outright — route files never need one),
// then parse strictly with @xmldom/xmldom (a pure-JS DOM with no network or
// entity resolution), then sanitize script vectors in <name>/<description>,
// then extract structure server-side so points, roles, and mileage are
// authoritative and unspoofable. The viewer's esc() at render time is the
// second layer of the same defense.
import { DOMParser, XMLSerializer, MIME_TYPE, type Document, type Element } from '@xmldom/xmldom'
import { parseRoleName, type Role } from './roles'

export const KML_MAX_BYTES = 5 * 1024 * 1024 // 5 MB
export const GPX_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
// The archive, compressed. Larger than the KML cap because a legitimate KMZ
// carries overlays and imagery that get skipped; the KML pulled out of it is
// still held to KML_MAX_BYTES, measured after decompression. See kmz.ts.
export const KMZ_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
// A stop list, not a track — 200 stops of text does not reach a megabyte, and
// anything much larger is not a stop list. See csv.ts.
export const CSV_MAX_BYTES = 2 * 1024 * 1024 // 2 MB
// GeoJSON spends more bytes per coordinate than KML does (brackets, commas and
// full precision rather than a packed string), so the same route is a larger
// file. See geojson.ts.
export const GEOJSON_MAX_BYTES = 10 * 1024 * 1024 // 10 MB

// User-caused rejection (bad file), as opposed to a server fault.
export class RouteFileError extends Error {}

// The formats the import pipeline accepts, stated once. The import page builds
// its `accept` attribute and its copy from this, and the upload handler gates
// on it, so the form cannot offer something the server refuses.
export const SUPPORTED_FORMATS = ['kml', 'kmz', 'gpx', 'geojson', 'json', 'csv'] as const
export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number]
export const isSupportedFormat = (ext: string): ext is SupportedFormat =>
  (SUPPORTED_FORMATS as readonly string[]).includes(ext)

// What each one is called, where riders get them, and how big it may be. The
// cap lives here rather than in the handler so that adding a format cannot
// leave it silently sharing another format's limit.
export const FORMAT_INFO: Record<SupportedFormat, { label: string; note: string; maxBytes: number }> = {
  kml: { label: 'KML', note: 'Google Earth, My Maps, most planners', maxBytes: KML_MAX_BYTES },
  kmz: { label: 'KMZ', note: 'Google Earth saves these by default—a zipped KML', maxBytes: KMZ_MAX_BYTES },
  gpx: { label: 'GPX', note: 'Garmin, Wahoo, Strava, Gaia, almost any GPS', maxBytes: GPX_MAX_BYTES },
  geojson: { label: 'GeoJSON', note: 'geojson.io, QGIS, anything mapping-adjacent', maxBytes: GEOJSON_MAX_BYTES },
  // Same parser, different extension. Plenty of tools save GeoJSON as .json and
  // making a rider rename the file to get it accepted would be theatre.
  json: { label: 'JSON', note: 'GeoJSON saved under the plainer extension', maxBytes: GEOJSON_MAX_BYTES },
  csv: { label: 'CSV', note: 'A list of stops from a spreadsheet—no route line', maxBytes: CSV_MAX_BYTES },
}

// A [lng, lat] polyline — the storage/GeoJSON axis order.
export type Track = [number, number][]

export type ExtractedPoint = {
  lat: number
  lng: number
  name: string
  description: string | null
  roles: Role[]
  // Only a format that can actually carry the distinction sets this. KML and
  // GPX cannot — a Placemark and a <wpt> are the same thing whatever we meant
  // by them — so their extractors leave it undefined and every point becomes a
  // stop, which is the behaviour those formats have always had. GeoJSON writes
  // its own properties, so a ride exported and re-imported keeps its POIs.
  kind?: 'stop' | 'poi'
  // Same reasoning as `kind`: only a format that can carry it sets it. Neither
  // KML nor GPX has anywhere to put "we stopped here for 20 minutes".
  durationMin?: number | null
}

export type ExtractedRoute = {
  points: ExtractedPoint[] // Placemark/wpt order—becomes stop order
  track: Track // the longest line in the file, 6-decimal rounded
  trackMeters: number // haversine length of track
}

export type KmlResult = ExtractedRoute & {
  storedKml: string // sanitized, re-serialized document—what gets written to disk
}

// One strict parse used for both formats. xmldom's default onError only throws
// on fatalError; treat plain errors as fatal too — a route file has no excuse.
function parseXml(text: string, label: string): Document {
  if (/<!DOCTYPE/i.test(text)) {
    throw new RouteFileError(`${label} contains a DOCTYPE declaration, which is not allowed`)
  }
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') throw new RouteFileError(`${label} is not well-formed XML: ${message}`)
    },
  })
  try {
    return parser.parseFromString(text, MIME_TYPE.XML_TEXT)
  } catch (e) {
    if (e instanceof RouteFileError) throw e
    throw new RouteFileError(`${label} is not well-formed XML`)
  }
}

function elements(scope: Document | Element, localName: string): Element[] {
  return Array.from(scope.getElementsByTagNameNS('*', localName))
}

// --- Geometry --------------------------------------------------------------

const EARTH_RADIUS_M = 6371008.8
// ~11 cm, which is finer than any consumer GPS and keeps stored tracks small.
// Exported so every format rounds identically — a format that rounded
// differently would fail the round-trip tests for a reason that had nothing to
// do with the format.
export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

export const METERS_PER_MILE = 1609.344

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a))
}

// Total meters along a [lng,lat] track.
export function trackMeters(track: Track): number {
  let m = 0
  for (let i = 1; i < track.length; i++) {
    m += haversineM(track[i - 1][1], track[i - 1][0], track[i][1], track[i][0])
  }
  return m
}

// Cumulative meters from the track start to the vertex nearest each point —
// the server-side port of the legacy viewer's from-start mileage (main.js
// nearest-vertex + path-sum, done once at import instead of per page view).
export function distFromStartAlongTrack(track: Track, pts: Array<{ lat: number; lng: number }>): number[] {
  if (track.length === 0) return pts.map(() => 0)
  // Prefix sums: meters from start to each vertex.
  const prefix = new Array<number>(track.length)
  prefix[0] = 0
  for (let i = 1; i < track.length; i++) {
    prefix[i] = prefix[i - 1] + haversineM(track[i - 1][1], track[i - 1][0], track[i][1], track[i][0])
  }
  return pts.map((p) => {
    let best = 0
    let bestD = Number.POSITIVE_INFINITY
    for (let i = 0; i < track.length; i++) {
      const d = (track[i][1] - p.lat) ** 2 + (track[i][0] - p.lng) ** 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return Math.round(prefix[best])
  })
}

// KML coordinates: whitespace-separated "lon,lat[,alt]" tuples.
function parseCoordinates(text: string): Track {
  const points: Track = []
  for (const tuple of text.trim().split(/\s+/)) {
    const [lon, lat] = tuple.split(',').map(Number)
    if (Number.isFinite(lon) && Number.isFinite(lat)) points.push([round6(lon), round6(lat)])
  }
  return points
}

// --- Sanitization ----------------------------------------------------------

// Plain text only: strip tags (looped, so "<<b>b>" cannot reassemble into a
// tag), then defuse URL schemes that execute. Used at the import boundary and
// on every builder-entered name/description before it reaches the database.
export function sanitizeText(raw: string): string {
  let s = raw
  let prev: string
  do {
    prev = s
    s = s.replace(/<[^>]*>/g, '')
  } while (s !== prev)
  s = s.replace(/(javascript|vbscript|data)\s*:/gi, '$1')
  return s.trim()
}

// Every <name> and <description> is collapsed to a sanitized text node.
// textContent has already decoded entities and unwrapped CDATA, so nothing
// hides behind &lt; or <![CDATA[.
function sanitizeDoc(doc: Document): void {
  for (const localName of ['name', 'description']) {
    for (const el of elements(doc, localName)) {
      const clean = sanitizeText(el.textContent ?? '')
      while (el.firstChild) el.removeChild(el.firstChild)
      if (clean) el.appendChild(doc.createTextNode(clean))
    }
  }
}

// --- KML -------------------------------------------------------------------

// Route track = the longest <coordinates> line in the file; short ones belong
// to point Placemarks. Mirrors what the legacy viewer drew.
function extractKml(doc: Document): ExtractedRoute {
  let track: Track = []
  for (const el of elements(doc, 'coordinates')) {
    const pts = parseCoordinates(el.textContent ?? '')
    if (pts.length > track.length) track = pts
  }

  const points: ExtractedPoint[] = []
  for (const pm of elements(doc, 'Placemark')) {
    const pointEls = elements(pm, 'Point')
    if (pointEls.length === 0) continue
    const coords = parseCoordinates(elements(pointEls[0], 'coordinates')[0]?.textContent ?? '')
    if (coords.length === 0) continue
    const rawName = elements(pm, 'name')[0]?.textContent ?? ''
    const rawDesc = elements(pm, 'description')[0]?.textContent ?? ''
    const { roles, name } = parseRoleName(rawName)
    points.push({
      lat: coords[0][1],
      lng: coords[0][0],
      name,
      description: rawDesc.trim() || null,
      roles,
    })
  }

  return { points, track, trackMeters: trackMeters(track) }
}

export function processKml(text: string): KmlResult {
  const doc = parseXml(text, 'KML file')
  if (doc.documentElement?.localName !== 'kml') {
    throw new RouteFileError('KML file has no <kml> root element')
  }
  if (elements(doc, 'coordinates').length === 0) {
    throw new RouteFileError('KML file contains no coordinates')
  }
  // Sanitize first so the extracted names/descriptions are the clean ones.
  sanitizeDoc(doc)
  const extracted = extractKml(doc)
  return { ...extracted, storedKml: new XMLSerializer().serializeToString(doc) }
}

// --- GPX -------------------------------------------------------------------

// GPX is stored byte-for-byte when it accompanies a KML (it is a download,
// never rendered), but it must be well-formed and DOCTYPE-free.
export function validateGpx(text: string): void {
  const doc = parseXml(text, 'GPX file')
  if (doc.documentElement?.localName !== 'gpx') {
    throw new RouteFileError('GPX file has no <gpx> root element')
  }
}

// Structured extraction for GPX-first imports (wired up when the import UI
// accepts GPX without a KML): track from trkpt in document order (falling
// back to rtept), points from <wpt>.
export function processGpx(text: string): ExtractedRoute {
  const doc = parseXml(text, 'GPX file')
  if (doc.documentElement?.localName !== 'gpx') {
    throw new RouteFileError('GPX file has no <gpx> root element')
  }

  // Points under one parent, in document order.
  const readPts = (parent: Document | Element, localName: string): Track => {
    const out: Track = []
    for (const el of elements(parent, localName)) {
      const lat = Number(el.getAttribute('lat'))
      const lon = Number(el.getAttribute('lon'))
      if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([round6(lon), round6(lat)])
    }
    return out
  }

  // The longest <trk> wins, matching what processKml does with the longest
  // line — but segments *within* a track are joined, because a <trkseg> break
  // is a recording pause in one ride while separate <trk> elements are
  // separate rides.
  //
  // Reading every trkpt in the file as one track is what this used to do, and
  // on a multi-day export it invents the geometry between where one day ends
  // and the next begins. Measured on a real 3-day ride: 553 miles came back as
  // 631, and twistiness fell from 79/69/53 to 59 because the phantom joins are
  // perfectly straight. A number that confident and that wrong is worse than
  // no number.
  const trks = elements(doc, 'trk')
  let track: Track = []
  for (const trk of trks) {
    const t = readPts(trk, 'trkpt')
    if (t.length > track.length) track = t
  }
  // A GPX with loose trkpt and no <trk> wrapper is malformed but readable, and
  // rtept is the fallback for a file that only carries a planned route.
  if (track.length === 0) track = readPts(doc, 'trkpt')
  if (track.length === 0) track = readPts(doc, 'rtept')

  const points: ExtractedPoint[] = []
  for (const wpt of elements(doc, 'wpt')) {
    const lat = Number(wpt.getAttribute('lat'))
    const lon = Number(wpt.getAttribute('lon'))
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const rawName = sanitizeText(elements(wpt, 'name')[0]?.textContent ?? '')
    const rawDesc = sanitizeText(elements(wpt, 'desc')[0]?.textContent ?? '')
    const { roles, name } = parseRoleName(rawName)
    points.push({ lat: round6(lat), lng: round6(lon), name, description: rawDesc || null, roles })
  }

  if (track.length === 0 && points.length === 0) {
    throw new RouteFileError('GPX file contains no track, route, or waypoints')
  }
  return { points, track, trackMeters: trackMeters(track) }
}
