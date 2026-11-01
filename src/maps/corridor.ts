// The corridor arithmetic on the server: public/js/corridor.js, ported, plus the
// two route-shape.js helpers a corridor search needs to place what it finds.
//
// A PORT AND NOT A SHARED FILE, for the reason alts.ts and twist.ts are: the
// browser loads a window IIFE and the server imports a module, and neither can
// read the other's. test/corridor-port.test.ts evals the browser files and holds
// the two copies to the same answers, so a change to one that is not made to the
// other fails there rather than as a planning assistant that searches a different
// corridor from the builder's Along the route.
//
// The reasoning behind every rule here is written down in corridor.js beside the
// original and is not repeated: point to SEGMENT rather than vertex, an
// equirectangular projection, samples derived from the 50 km clamp with the denser
// rule kept as a floor, and a coverage test that has to be shown when it fails.
import { haversineM, type Track } from './kml'

type LngLat = [number, number]

const R = 6371008.8 // IUGG mean radius, matching haversineM in kml.ts and route-shape.js
const RAD = Math.PI / 180

/** What /api/places/search accepts, and the ceiling on what one search can reach. */
export const MAX_RADIUS_M = 50000
export const MIN_RADIUS_M = 500

type Scale = { x: number; y: number }

const scaleAt = (lat: number): Scale => ({ x: R * RAD * Math.cos(lat * RAD), y: R * RAD })

/** Distance from a point to a segment, and where along the segment (0 to 1) the
 *  nearest point is. The browser copy returns the distance alone. */
function toSegment(lng: number, lat: number, a: LngLat, b: LngLat, s: Scale): { d: number; t: number } {
  const px = (lng - a[0]) * s.x
  const py = (lat - a[1]) * s.y
  const vx = (b[0] - a[0]) * s.x
  const vy = (b[1] - a[1]) * s.y
  const len2 = vx * vx + vy * vy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * vx + py * vy) / len2))
  const dx = px - vx * t
  const dy = py - vy * t
  return { d: Math.sqrt(dx * dx + dy * dy), t }
}

/**
 * The segment of the track a place sits nearest: its start vertex, how far off it
 * is, and where along it the place projects.
 *
 * `t` IS THE ONE ADDITION TO THE BROWSER'S ANSWER. The builder only needs the
 * segment, to put a hit between two rows; the assistant also says roughly how far
 * along the route a place is, which needs the fraction. `offM` and `index` are
 * pinned against corridor.js.
 */
export function nearestSegment(lngLat: LngLat, track: Track): { offM: number; index: number; t: number } | null {
  if (!track || !track.length) return null
  const [lng, lat] = lngLat
  const s = scaleAt(lat)
  if (track.length === 1) return { offM: toSegment(lng, lat, track[0], track[0], s).d, index: 0, t: 0 }
  let best = Infinity
  let at = 0
  let bestT = 0
  for (let i = 1; i < track.length; i++) {
    const { d, t } = toSegment(lng, lat, track[i - 1], track[i], s)
    // Strictly less, so a tie takes the EARLIER segment, as the browser's does.
    if (d < best) {
      best = d
      at = i - 1
      bestT = t
    }
  }
  return { offM: best, index: at, t: bestT }
}

/** How far off the route a place is, in meters; null for an empty track. */
export function offRouteM(lngLat: LngLat, track: Track): number | null {
  const hit = nearestSegment(lngLat, track)
  return hit ? hit.offM : null
}

type Positioned = { lngLat?: unknown; lng?: unknown; lat?: unknown }

const finitePair = (lng: unknown, lat: unknown): LngLat | null =>
  typeof lng === 'number' && typeof lat === 'number' && Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null

/** A place's position from either of the app's two spellings, or null. */
export function placeLngLat(p: Positioned | null | undefined): LngLat | null {
  if (!p) return null
  const pair = p.lngLat
  if (Array.isArray(pair) && pair.length >= 2) return finitePair(pair[0], pair[1])
  return finitePair(p.lng, p.lat)
}

export type CorridorHit<T> = { place: T; offRouteM: number | null; atIndex?: number; t?: number }

/**
 * The places inside a corridor of `radiusM` either side of the track, nearest
 * first. An empty track lets everything through, as the browser's does.
 */
export function withinCorridor<T extends Positioned>(places: T[], track: Track, radiusM: number): CorridorHit<T>[] {
  const list = places || []
  if (!track || !track.length) return list.map((p) => ({ place: p, offRouteM: null }))
  const out: CorridorHit<T>[] = []
  for (const p of list) {
    const ll = placeLngLat(p)
    if (!ll) continue
    const hit = nearestSegment(ll, track)
    if (hit == null) continue
    if (hit.offM <= radiusM) out.push({ place: p, offRouteM: hit.offM, atIndex: hit.index, t: hit.t })
  }
  // Array.prototype.sort is stable, as the browser's is, so ties keep Google's order.
  out.sort((a, b) => (a.offRouteM as number) - (b.offRouteM as number))
  return out
}

export type Sample = { atM: number; radiusM: number }

/** Where along a track to search, and how wide. See corridorSamples() in corridor.js. */
export function corridorSamples(totalM: number, corridorM: number, maxSamples: number): Sample[] {
  if (!(totalM > 0) || !(corridorM > 0)) return []
  const cap = maxSamples > 0 ? Math.floor(maxSamples) : 1
  const want = Math.ceil(totalM / (2 * MAX_RADIUS_M))
  const n = Math.max(1, Math.min(cap, Math.max(want, Math.ceil(totalM / (2 * corridorM)))))
  const step = totalM / n
  const radiusM = Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, Math.ceil(step / 2 + corridorM)))
  const out: Sample[] = []
  for (let i = 0; i < n; i++) out.push({ atM: (i + 0.5) * step, radiusM })
  return out
}

/** Whether the samples' circles touch end to end along the whole track. */
export function samplesCoverAll(samples: Sample[], totalM: number): boolean {
  if (!samples || !samples.length || !(totalM > 0)) return false
  const step = totalM / samples.length
  return 2 * samples[0].radiusM >= step
}

// --- From route-shape.js -------------------------------------------------------

/** One leg's vertices in the concatenated track, or null for a leg with no geometry. */
export type Span = { startIndex: number; endIndex: number } | null

/**
 * A route's legs as one track, the joint vertex shared, and where each leg sits in
 * it. trackAndSpans() in builder.js, which is what the builder searches along.
 */
export function trackAndSpans(legs: { geometry: LngLat[] }[]): { track: Track; spans: Span[] } {
  const track: LngLat[] = []
  const spans: Span[] = []
  for (const leg of legs) {
    if (!leg.geometry || leg.geometry.length === 0) {
      spans.push(null)
      continue
    }
    let startIndex = -1
    for (const pt of leg.geometry) {
      const last = track[track.length - 1]
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) track.push(pt)
      if (startIndex < 0) startIndex = track.length - 1
    }
    spans.push({ startIndex, endIndex: track.length - 1 })
  }
  return { track, spans }
}

/** Which leg owns a vertex of the flat track. legAtVertex() in route-shape.js. */
export function legAtVertex(spans: Span[], vertexIndex: number | null, edgeForward: boolean): number | null {
  if (!Array.isArray(spans) || vertexIndex == null || vertexIndex < 0) return null
  let joint: number | null = null
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]
    if (!s) continue
    if (vertexIndex > s.startIndex && vertexIndex < s.endIndex) return i
    if (vertexIndex === s.startIndex) {
      if (edgeForward || joint === null) return i
      return joint
    }
    if (vertexIndex === s.endIndex) joint = i
  }
  return joint
}

const segM = (a: LngLat, b: LngLat) => haversineM(a[1], a[0], b[1], b[0])

/** The point `targetM` along a track, interpolated. pointAtDistance() in route-shape.js. */
export function pointAtDistance(track: Track, targetM: number): LngLat | null {
  if (!track || track.length === 0) return null
  if (track.length === 1 || !(targetM > 0)) return [track[0][0], track[0][1]]
  let acc = 0
  for (let i = 1; i < track.length; i++) {
    const seg = segM(track[i - 1], track[i])
    if (acc + seg >= targetM) {
      const t = seg === 0 ? 0 : (targetM - acc) / seg
      return [
        track[i - 1][0] + (track[i][0] - track[i - 1][0]) * t,
        track[i - 1][1] + (track[i][1] - track[i - 1][1]) * t,
      ]
    }
    acc += seg
  }
  return [track[track.length - 1][0], track[track.length - 1][1]]
}

/** Meters along the track to each vertex: `out[i]` is the distance to `track[i]`. */
export function cumulativeM(track: Track): number[] {
  const out = [0]
  for (let i = 1; i < track.length; i++) out.push(out[i - 1] + segM(track[i - 1], track[i]))
  return out
}
