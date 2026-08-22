// A ride's picture of itself: geometry and day colors in, a Google Static Maps
// request out. Pure — no Postgres, no fetch, no environment beyond the key
// handed to the one function that needs it — which is what lets
// test/thumbnail.test.ts assert the URL limit without a database. Same shape of
// module as twist.ts, and it sits here for the same reason.
//
// A Static Maps image and not an SVG drawn from the geometry. Both were
// considered on 2026-08-16 and the SVG was prototyped first — it works, costs
// nothing and themes for free — but a bare squiggle falls flat, and the SKU is
// inside its free tier at beta scale. See item 28 in docs/ROADMAP.md.
import { createHash } from 'node:crypto'
import { activeDays, type AltDay } from './alts'

// The image, in CSS pixels, and the multiplier that makes it sharp on a retina
// card. 320x200 at scale 2 renders 640x400 actual pixels, which is exactly the
// 640 cap on the Essentials tier — going wider silently drops to the cap rather
// than erroring.
//
// `center` and `zoom` are deliberately never sent. Omitting both is what makes
// Static Maps auto-fit the paths, which is the whole requirement: fitted as
// tightly to the route as it can be while still showing all of it. A route's
// bounding box is whatever shape the road took, so the box is fixed and the
// route is fitted inside it.
export const THUMB_WIDTH = 320
export const THUMB_HEIGHT = 200
export const THUMB_SCALE = 2

// Static Maps is GET-only and its URLs are capped at 8192 characters. This is
// the real constraint on the whole design, and the reason simplification below
// targets a POINT BUDGET rather than a distance tolerance: a tolerance chosen to
// look right on a day ride blows the limit on a dense 8-day import, and the
// failure is a 4xx at fetch time rather than anything a test would have seen.
//
// ~330 points encodes to roughly 2 KB, measured against the dev corpus during
// the prototype. The cap below is the hard ceiling; the budget is what we aim
// for, and the headroom between them is where the style and size parameters
// live.
export const URL_MAX_CHARS = 8192
export const POINT_BUDGET = 330

// The line as drawn. Weight 3 reads at 640px wide without turning a switchback
// into a blob; the day color carries the meaning.
const PATH_WEIGHT = 3

// One desaturated style for every theme, not one per theme. Item 20 brings three
// themes across light and dark, and rendering a variant per combination
// multiplies calls by six for terrain that is the same terrain. A style change
// is one URL parameter, so this is cheap to revisit by eye once the themes
// exist.
//
// Also worth knowing: because the style is in the URL, changing it changes every
// hash, so the next sweep regenerates every thumbnail by itself — no migration
// and no backfill script.
const MAP_STYLE = 'feature:all|element:labels|visibility:off'
const MAP_SATURATION = 'feature:all|element:geometry|saturation:-70|lightness:10'

// AltDay rather than a plain `active: boolean`, so the alternate rule is read
// from src/maps/alts.ts rather than restated here. It is not the bare column: a
// day with no group is active whatever `alt_active` says, and `activeDays()` is
// the single source of truth for that. Restating it as `d.altActive` would be a
// second definition that could drift from the one the builder and the save path
// share.
export type ThumbDay = AltDay & {
  /** The day's concatenated leg geometry, `[lng, lat]` like everywhere else. */
  geometry: [number, number][]
  /** `#rrggbb`, from `days.color`. */
  color: string
}

// --- Simplification ---------------------------------------------------------

// Equirectangular scaling for the longitude axis. Douglas-Peucker measures a
// perpendicular distance, and a degree of longitude is a degree of latitude only
// at the equator — without this a north-south road in Alaska simplifies far more
// aggressively than the same road in Ecuador. cos(lat) at the track's midpoint
// is accurate enough for a 320px picture and costs one trig call.
function lngScale(track: [number, number][]): number {
  if (!track.length) return 1
  const mid = track[Math.floor(track.length / 2)]
  return Math.cos((mid[1] * Math.PI) / 180)
}

// Perpendicular distance from p to the segment ab, in scaled degrees.
function perpDist(p: [number, number], a: [number, number], b: [number, number], kx: number): number {
  const px = (p[0] - a[0]) * kx
  const py = p[1] - a[1]
  const bx = (b[0] - a[0]) * kx
  const by = b[1] - a[1]
  const len2 = bx * bx + by * by
  if (len2 === 0) return Math.hypot(px, py)
  // Clamped so a point beyond either end measures to the endpoint, not to the
  // infinite line — without the clamp a hairpin's tip can measure as close to
  // the chord it doubles back along and be dropped.
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2))
  return Math.hypot(px - t * bx, py - t * by)
}

// Douglas-Peucker, iterative rather than recursive: an 8,473-point day recurses
// deeply enough to be worth not finding out about in production.
function douglasPeucker(track: [number, number][], epsilon: number, kx: number): [number, number][] {
  if (track.length < 3) return track.slice()

  const keep = new Uint8Array(track.length)
  keep[0] = 1
  keep[track.length - 1] = 1

  const stack: Array<[number, number]> = [[0, track.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()!
    let worst = 0
    let index = -1
    for (let i = first + 1; i < last; i++) {
      const d = perpDist(track[i], track[first], track[last], kx)
      if (d > worst) {
        worst = d
        index = i
      }
    }
    if (index !== -1 && worst > epsilon) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }

  const out: [number, number][] = []
  for (let i = 0; i < track.length; i++) if (keep[i]) out.push(track[i])
  return out
}

/**
 * Simplifies to at most `budget` points, by binary-searching the tolerance
 * rather than choosing one.
 *
 * A budget is the thing the URL limit actually constrains, and no fixed
 * tolerance maps onto it: the same epsilon that leaves a 40-mile day at 60
 * points leaves an 8-day import at 4,000. Twenty iterations lands within a point
 * or two of the budget on every track in the dev corpus, and the loop is over
 * tolerances rather than over the track, so the cost is 20 DP passes and not
 * anything quadratic.
 */
export function simplifyToBudget(track: [number, number][], budget: number): [number, number][] {
  if (track.length <= budget) return track.slice()
  if (budget < 2) return track.length ? [track[0], track[track.length - 1]] : []

  const kx = lngScale(track)

  // Upper bound for the search: the track's own extent guarantees a tolerance
  // that collapses it to its two endpoints, so the answer is bracketed.
  let lo = 0
  let hi = 1
  for (const [lng, lat] of track) {
    hi = Math.max(hi, Math.abs(lng - track[0][0]) * kx, Math.abs(lat - track[0][1]))
  }

  let best = douglasPeucker(track, hi, kx)
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    const out = douglasPeucker(track, mid, kx)
    if (out.length > budget) {
      lo = mid
    } else {
      best = out
      hi = mid
    }
  }
  return best
}

// --- Polyline encoding ------------------------------------------------------

// Google's encoded polyline, precision 5 — the format `enc:` takes. Written out
// rather than pulled in as a dependency: it is twenty lines, it is frozen (the
// format cannot change without breaking every URL Google has ever issued), and
// the alternative is a package on the server for one function.
//
// Precision 5 is ~1.1m at the equator. The geometry is stored at 6 decimals
// (~0.11m), so this rounds — which is correct for a 320px picture and is part of
// why the encoded form is small.
function encodeValue(v: number, out: string[]): void {
  let n = v < 0 ? ~(v << 1) : v << 1
  while (n >= 0x20) {
    out.push(String.fromCharCode((0x20 | (n & 0x1f)) + 63))
    n >>= 5
  }
  out.push(String.fromCharCode(n + 63))
}

/** Encodes `[lng, lat]` pairs. Google's format is lat-then-lng; the swap is here. */
export function encodePolyline(track: [number, number][]): string {
  const out: string[] = []
  let prevLat = 0
  let prevLng = 0
  for (const [lng, lat] of track) {
    const y = Math.round(lat * 1e5)
    const x = Math.round(lng * 1e5)
    encodeValue(y - prevLat, out)
    encodeValue(x - prevLng, out)
    prevLat = y
    prevLng = x
  }
  return out.join('')
}

// --- The request -----------------------------------------------------------

// `#rrggbb` to the `0xRRGGBBff` Static Maps wants. An unparseable color falls
// back to the schema default rather than throwing: a thumbnail is decoration,
// and a ride is not worth failing to draw over a bad hex.
function pathColor(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  return `0x${(m ? m[1] : '0000cc').toLowerCase()}ff`
}

/**
 * Splits the point budget across the days, in proportion to how many points
 * each one actually has.
 *
 * Proportional rather than equal: a ride whose day 1 is a 300-mile slab and
 * whose day 2 is forty miles of switchbacks should not spend half its budget
 * straightening the switchbacks. Every drawn day gets at least 2 points, so a
 * short day is a line rather than nothing.
 */
function shareBudget(counts: number[], budget: number): number[] {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return counts.map(() => 0)
  const floor = 2
  const spare = Math.max(0, budget - floor * counts.length)
  return counts.map((n) => floor + Math.floor((n / total) * spare))
}

/**
 * The Static Maps request for a ride, WITHOUT the API key — path and query only,
 * ready to be hashed and to have a key appended at fetch time.
 *
 * Keyless on purpose, and it is the detail the rest of the design leans on:
 *
 *   - The stored hash stays stable across a key rotation. Hash a URL with the
 *     key in it and rotating the key silently invalidates every thumbnail in the
 *     database and re-fetches the lot.
 *   - Nothing ever stores or logs a string containing GMAPS_SERVER_KEY. That key
 *     is IP-restricted and must never reach a client; a URL in a row, a log line
 *     or an error message is exactly how it would.
 *
 * Returns null when there is nothing to draw — a ride with stops but no legs is
 * a real state, and so is one whose only days are losing alternates. The caller
 * shows the color swatch instead.
 */
export function thumbnailRequest(days: ThumbDay[]): string | null {
  // Losing alternates are excluded here rather than by the caller filtering the
  // array. Only active days count and there is no single place that enforces it
  // — see AGENTS.md — so a new surface has to opt in, and the safest way to opt
  // in is to make it impossible to opt out.
  const drawn = activeDays(days).filter((d) => d.geometry.length >= 2)
  if (!drawn.length) return null

  const budgets = shareBudget(
    drawn.map((d) => d.geometry.length),
    POINT_BUDGET,
  )

  const params = [
    `size=${THUMB_WIDTH}x${THUMB_HEIGHT}`,
    `scale=${THUMB_SCALE}`,
    'maptype=roadmap',
    `style=${encodeURIComponent(MAP_STYLE)}`,
    `style=${encodeURIComponent(MAP_SATURATION)}`,
  ]

  drawn.forEach((day, i) => {
    const simplified = simplifyToBudget(day.geometry, budgets[i])
    const enc = encodePolyline(simplified)
    // `enc:` values are appended raw rather than percent-encoded. The encoded
    // polyline alphabet is printable ASCII including `\` and `?`, and Google
    // documents `enc:` as taking the raw string — encoding it here is a
    // documented way to get an empty map back.
    params.push(`path=${encodeURIComponent(`color:${pathColor(day.color)}|weight:${PATH_WEIGHT}|`)}enc:${enc}`)
  })

  return `/maps/api/staticmap?${params.join('&')}`
}

/** The full URL to fetch. The key is appended here and nowhere else. */
export function thumbnailUrl(request: string, key: string): string {
  return `https://maps.googleapis.com${request}&key=${encodeURIComponent(key)}`
}

/**
 * The stored fingerprint of a request.
 *
 * Everything that changes the picture — the geometry, the day colors, the size,
 * the style — is already in the request string, so an identical request cannot
 * produce a different image. That is what lets the sweep skip a ride whose edit
 * did not move the route: retitling, changing a stop's dwell, flipping
 * visibility and recoloring the legend are all common edits that leave the
 * picture alone.
 *
 * Truncated to 32 hex characters. This is a change detector, not a security
 * boundary — nothing is authenticated by it and nothing is protected if two
 * requests collide, which at 128 bits over one row per ride will not happen.
 */
export function thumbnailHash(request: string): string {
  return createHash('sha256').update(request).digest('hex').slice(0, 32)
}
