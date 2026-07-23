// The security-critical half of the upload pipeline (ported from the PHP-era
// spec in _PLANS/multi-tenant-rebuild.md): XXE-safe XML parsing, server-side
// metadata extraction, and at-rest KML sanitization.
//
// Order of defenses: reject any <!DOCTYPE> before the parser ever runs (kills
// external-entity and billion-laughs outright — route files never need one),
// then parse strictly with @xmldom/xmldom (a pure-JS DOM with no network or
// entity resolution), then extract metadata server-side so waypoint counts and
// mileage are authoritative and unspoofable, then neutralize script vectors in
// <name>/<description> and re-serialize. The viewer's esc() at render time is
// the second layer of the same defense.
import { DOMParser, XMLSerializer, MIME_TYPE, type Document, type Element } from '@xmldom/xmldom'

export const KML_MAX_BYTES = 5 * 1024 * 1024 // 5 MB
export const GPX_MAX_BYTES = 10 * 1024 * 1024 // 10 MB

// User-caused rejection (bad file), as opposed to a server fault.
export class RouteFileError extends Error {}

export type KmlResult = {
  storedKml: string // sanitized, re-serialized document — what gets written to disk
  waypointCount: number
  totalMiles: number // haversine over the longest <coordinates> line, 1 decimal
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

// --- Metadata extraction ---------------------------------------------------

const EARTH_RADIUS_MILES = 3958.7613

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a))
}

// KML coordinates: whitespace-separated "lon,lat[,alt]" tuples.
function parseCoordinates(text: string): Array<[number, number]> {
  const points: Array<[number, number]> = []
  for (const tuple of text.trim().split(/\s+/)) {
    const [lon, lat] = tuple.split(',').map(Number)
    if (Number.isFinite(lon) && Number.isFinite(lat)) points.push([lon, lat])
  }
  return points
}

// The route is the longest <coordinates> line in the file; short ones are
// waypoint Points. Mirrors what the viewer draws.
function extractMetadata(doc: Document): { waypointCount: number; totalMiles: number } {
  // Waypoints, as the viewer counts them: Placemarks containing a <Point>.
  const waypointCount = elements(doc, 'Placemark').filter((pm) => elements(pm, 'Point').length > 0).length

  let route: Array<[number, number]> = []
  for (const el of elements(doc, 'coordinates')) {
    const pts = parseCoordinates(el.textContent ?? '')
    if (pts.length > route.length) route = pts
  }

  let miles = 0
  for (let i = 1; i < route.length; i++) {
    miles += haversineMiles(route[i - 1][1], route[i - 1][0], route[i][1], route[i][0])
  }
  return { waypointCount, totalMiles: Math.round(miles * 10) / 10 }
}

// --- Sanitization ----------------------------------------------------------

// Plain text only: strip tags (looped, so "<<b>b>" cannot reassemble into a
// tag), then defuse URL schemes that execute. textContent has already decoded
// entities and unwrapped CDATA, so nothing hides behind &lt; or <![CDATA[.
function sanitizeText(raw: string): string {
  let s = raw
  let prev: string
  do {
    prev = s
    s = s.replace(/<[^>]*>/g, '')
  } while (s !== prev)
  s = s.replace(/(javascript|vbscript|data)\s*:/gi, '$1')
  return s.trim()
}

// Every <name> and <description> is collapsed to a sanitized text node — the
// only KML content the viewer ever renders into HTML.
function sanitizeDoc(doc: Document): void {
  for (const localName of ['name', 'description']) {
    for (const el of elements(doc, localName)) {
      const clean = sanitizeText(el.textContent ?? '')
      while (el.firstChild) el.removeChild(el.firstChild)
      if (clean) el.appendChild(doc.createTextNode(clean))
    }
  }
}

// --- Entry points ----------------------------------------------------------

export function processKml(text: string): KmlResult {
  const doc = parseXml(text, 'KML file')
  if (doc.documentElement?.localName !== 'kml') {
    throw new RouteFileError('KML file has no <kml> root element')
  }
  if (elements(doc, 'coordinates').length === 0) {
    throw new RouteFileError('KML file contains no coordinates')
  }
  const { waypointCount, totalMiles } = extractMetadata(doc)
  sanitizeDoc(doc)
  return { storedKml: new XMLSerializer().serializeToString(doc), waypointCount, totalMiles }
}

// GPX is stored byte-for-byte (it is only ever a download, never rendered), but
// it must still be a well-formed, DOCTYPE-free GPX document.
export function validateGpx(text: string): void {
  const doc = parseXml(text, 'GPX file')
  if (doc.documentElement?.localName !== 'gpx') {
    throw new RouteFileError('GPX file has no <gpx> root element')
  }
}
