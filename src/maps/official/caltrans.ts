// Caltrans's own road data, read from CWWP2 (the Commercial Wholesale Web Portal):
// chain controls and the Lane Closure System, district by district. #442, the first
// official source behind the planning assistant's `get_official_closures`.
//
// THE FEEDS, CONFIRMED 2026-11-01 by fetching every one of them:
//
//   Chain controls  https://cwwp2.dot.ca.gov/data/d{N}/cc/ccStatusD{NN}.json
//                   updated once a minute, published for districts 1, 2, 3, 6, 7,
//                   8, 9, 10, and 11 ONLY. Districts 4, 5, and 12 publish none (the
//                   URL answers 500), which the documentation page agrees with.
//   Lane closures   https://cwwp2.dot.ca.gov/data/d{N}/lcs/lcsStatusD{NN}.json
//                   updated every five minutes, all twelve districts. Every approved
//                   closure planned for the next seven days plus every current one.
//
// Documentation: cwwp2.dot.ca.gov/documentation/cc/cc.htm and lcs/lcs.htm, with the
// status vocabulary at cc/cc-chart.htm and the field list at lcs/lcs-field-description.htm.
// Both feeds are `{ data: [ { cc | lcs: {...} } ] }`, every value a string.
//
// WHAT THE LIVE FEEDS ACTUALLY HELD on 2026-11-01, which is what the parsing is for:
//   - Every coordinate, status, and timestamp is a string; "Not Reported" stands in
//     for a missing coordinate (District 7 had chain points with none).
//   - District 7 published two chain points whose `status` was a LONGITUDE. An
//     unrecognized code is kept as unknown and never read as "no restriction".
//   - "ROAD CLOSED" in capitals (District 10, Ebbetts Pass's winter gate) where the
//     chart says "Road Closed": codes are matched case-insensitively.
//   - District 11's chain file carried bytes that are not UTF-8; the body is read as
//     text, which replaces them, so one place name cannot fail the whole district.
//   - District 7's lane-closure file was 15.6 MB, which is why the timeout matters.
//   - Each night of a recurring closure is its own row (`index` differs, `closureID`
//     is shared), so the tool groups rows by closureID.
//   - The local `recordTime` strings read an hour ahead of their own epochs the day
//     DST ended (16:43 beside an epoch of 15:43 PST). Closure times have epochs and
//     those are used; a chain control's status time has no epoch, so it is read as
//     Pacific wall clock and may be an hour off around a DST change. Stated, not fixed.
//
// NEVER THROWS. A feed that times out (FETCH_TIMEOUT_MS), answers non-200, or does not
// parse is `{ ok: false }` with when it was tried and when it last worked, so the tool
// can say "unknown", never "no closures". Each feed is cached in memory for
// CACHE_MS; a failure is not cached, so the next question tries again.
//
// NO DATABASE. Version one reads on demand; a stored history is a schema change and
// needs its own approval.
import { haversineM, type Track } from '../kml'
import { nearestSegment } from '../corridor'

type LngLat = [number, number]

export const SOURCE = 'Caltrans CWWP2'
export const BASE_URL = 'https://cwwp2.dot.ca.gov/data'
/** How long a feed is trusted before it is fetched again: the lane closures are
 *  published every five minutes, the chain controls every minute. */
export const CACHE_MS = 5 * 60_000
export const CC_CACHE_MS = 60_000
/** How long one feed may take before the answer is "unknown". */
export const FETCH_TIMEOUT_MS = 8_000
/** Districts that publish a chain-control feed (checked 2026-11-01). */
export const CC_DISTRICTS: readonly number[] = [1, 2, 3, 6, 7, 8, 9, 10, 11]
export const DISTRICTS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

export type FeedKind = 'cc' | 'lcs'

export function feedUrl(kind: FeedKind, district: number): string {
  const nn = String(district).padStart(2, '0')
  return kind === 'cc'
    ? `${BASE_URL}/d${district}/cc/ccStatusD${nn}.json`
    : `${BASE_URL}/d${district}/lcs/lcsStatusD${nn}.json`
}

// --- Where each district is ---------------------------------------------------

/**
 * A BOUNDING BOX PER DISTRICT, DELIBERATELY ROUGH. Drawn from the extent of every
 * chain point and closure endpoint each district published on 2026-11-01, widened by
 * hand to the counties the district chart assigns it (cwwp2.dot.ca.gov/documentation/
 * district-map-county-chart.htm). The boxes overlap, and that is the safe direction:
 * a route near a line costs one extra feed, where a box drawn too tight would miss a
 * district and report its roads as having nothing.
 */
export const DISTRICT_BOXES: Record<number, { s: number; n: number; w: number; e: number }> = {
  1: { s: 38.6, n: 42.05, w: -124.45, e: -122.3 }, // Del Norte, Humboldt, Mendocino, Lake
  2: { s: 39.5, n: 42.05, w: -124.0, e: -119.95 }, // Siskiyou, Shasta, Modoc, Lassen, Trinity, Tehama, Plumas
  3: { s: 38.0, n: 40.3, w: -122.95, e: -119.85 }, // Sacramento Valley to Tahoe
  4: { s: 36.85, n: 38.9, w: -123.6, e: -121.2 }, // the Bay Area
  5: { s: 34.3, n: 37.3, w: -122.3, e: -119.4 }, // Santa Cruz to Santa Barbara
  6: { s: 34.75, n: 37.85, w: -120.95, e: -117.6 }, // Fresno, Kern, Kings, Madera, Tulare
  7: { s: 33.65, n: 35.0, w: -119.6, e: -117.6 }, // Los Angeles, Ventura
  8: { s: 33.4, n: 35.85, w: -117.85, e: -114.1 }, // Riverside, San Bernardino
  9: { s: 34.95, n: 38.75, w: -119.7, e: -115.6 }, // Inyo, Mono, eastern Kern
  10: { s: 36.75, n: 38.95, w: -121.6, e: -119.15 }, // San Joaquin to Tuolumne and Alpine
  11: { s: 32.5, n: 33.55, w: -117.65, e: -114.4 }, // San Diego, Imperial
  12: { s: 33.35, n: 33.97, w: -118.15, e: -117.4 }, // Orange
}

/**
 * California, coarsely: the 42nd parallel, the 120th meridian down to Lake Tahoe,
 * the oblique line to the Colorado River, the river, the Mexican border, and the
 * ocean. Good to a few miles, which is all "is this ride in California" needs; the
 * box alone would put Reno and Las Vegas inside.
 */
const CA_OUTLINE: LngLat[] = [
  [-125.0, 42.0],
  [-120.0, 42.0],
  [-120.0, 39.0],
  [-114.63, 35.0],
  [-114.57, 34.8],
  [-114.13, 34.3],
  [-114.44, 34.0],
  [-114.72, 33.4],
  [-114.72, 32.72],
  [-117.12, 32.53],
  [-125.0, 32.53],
]

function insidePolygon([x, y]: LngLat, poly: LngLat[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export const inCalifornia = (p: LngLat): boolean => insidePolygon(p, CA_OUTLINE)

/** About two kilometers, so a road along a box's edge still counts. */
const BOX_PAD = 0.02

/** The districts a track passes through, in district order. Every vertex is tested;
 *  a route of a few thousand vertices against twelve boxes is nothing. */
export function districtsAlong(track: Track): number[] {
  const hit = new Set<number>()
  for (const p of track) {
    if (!inCalifornia(p)) continue
    for (const d of DISTRICTS) {
      const b = DISTRICT_BOXES[d]
      if (p[1] >= b.s - BOX_PAD && p[1] <= b.n + BOX_PAD && p[0] >= b.w - BOX_PAD && p[0] <= b.e + BOX_PAD) hit.add(d)
    }
  }
  return [...hit].sort((a, b) => a - b)
}

// --- Chain-control codes ------------------------------------------------------

/**
 * What a chain-control status means, parsed rather than flattened. The vocabulary is
 * Caltrans's chart (cc-chart.htm, 2026-11-01): R-0 through R-3, R-1 MODIFIED, the
 * truck-only Donner Summit codes, VM, ESC, HT, W, RC and "Road Closed", and "Not
 * Reported". Anything else is `unknown`, never `none`.
 */
export type ChainClass =
  /** R-0: no chain controls in effect. */
  | 'none'
  /** R-1, R-1 MODIFIED, R-2, R-3: chains or traction devices required. */
  | 'chains'
  /** W: no restriction, watch for snow on the pavement. */
  | 'watch'
  /** VM: traffic metered at the chain check point. */
  | 'metering'
  /** ESC: the CHP is escorting all traffic for weather. */
  | 'escort'
  /** HT: all traffic held at the check point. */
  | 'hold'
  /** TH, TS, TTA, TTS, TTSD, MIN, MAX: restrictions on trucks only. */
  | 'trucks'
  /** RC, Road Closed: closed to traffic. */
  | 'closed'
  /** Not Reported. */
  | 'not-reported'
  /** Anything the chart does not list. */
  | 'unknown'

export type ChainCode = {
  /** The code as published, trimmed and upper-cased. */
  code: string
  class: ChainClass
  /** R-1, R-2, R-3. */
  level?: 1 | 2 | 3
  /** R-1 MODIFIED: trucks and vehicles pulling trailers only. */
  modified?: boolean
}

const TRUCK_CODES = new Set(['TH', 'TS', 'TTA', 'TTS', 'TTSD', 'MIN', 'MAX'])

export function parseChainCode(raw: unknown): ChainCode {
  const code = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').toUpperCase() : ''
  const chains = /^R\s*-?\s*([0-3])(\s+MODIFIED)?$/.exec(code)
  if (chains) {
    const n = Number(chains[1])
    if (n === 0) return { code, class: 'none' }
    return { code, class: 'chains', level: n as 1 | 2 | 3, ...(chains[2] ? { modified: true } : {}) }
  }
  if (code === 'W') return { code, class: 'watch' }
  if (code === 'VM') return { code, class: 'metering' }
  if (code === 'ESC') return { code, class: 'escort' }
  if (code === 'HT') return { code, class: 'hold' }
  if (TRUCK_CODES.has(code)) return { code, class: 'trucks' }
  if (code === 'RC' || code === 'ROAD CLOSED') return { code, class: 'closed' }
  if (code === 'NOT REPORTED' || code === '') return { code: code || 'NOT REPORTED', class: 'not-reported' }
  return { code, class: 'unknown' }
}

// --- Pacific time ---------------------------------------------------------------

const PACIFIC = 'America/Los_Angeles'
const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function pacificFields(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const f: Record<string, number> = {}
  for (const p of parts.formatToParts(new Date(ms))) if (p.type !== 'literal') f[p.type] = Number(p.value)
  return { y: f.year, mo: f.month, d: f.day, h: f.hour, mi: f.minute, s: f.second }
}

/** Minutes Pacific time runs ahead of UTC at an instant (negative: -480 or -420). */
function pacificOffsetMin(ms: number): number {
  const f = pacificFields(ms)
  return Math.round((Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s) - ms) / 60_000)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** An instant as Pacific wall clock with its offset, to the minute:
 *  `2026-11-06T21:01-08:00`. */
export function pacificIso(ms: number): string {
  const f = pacificFields(ms)
  const off = pacificOffsetMin(ms)
  const sign = off < 0 ? '-' : '+'
  const a = Math.abs(off)
  return `${f.y}-${pad(f.mo)}-${pad(f.d)}T${pad(f.h)}:${pad(f.mi)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

/** An instant as Pacific wall clock with no zone, `2026-11-06T21:01`: the same kind
 *  of value as a route's `start_at`, so the two compare digit for digit. */
export const pacificWall = (ms: number): string => pacificIso(ms).slice(0, 16)

/** Pacific wall-clock date and time strings to an instant, or null. */
export function pacificToMs(date: unknown, time: unknown): number | null {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const t = typeof time === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(time) ? time : '00:00:00'
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi, s = 0] = t.split(':').map(Number)
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  if (!Number.isFinite(asUtc)) return null
  // Two passes, so a time just after a DST change lands on the right offset.
  const first = asUtc - pacificOffsetMin(asUtc) * 60_000
  return asUtc - pacificOffsetMin(first) * 60_000
}

/** An epoch string in seconds to an instant, falling back to the wall clock. */
function instant(epoch: unknown, date: unknown, time: unknown): number | null {
  if (typeof epoch === 'string' && /^\d{9,11}$/.test(epoch)) return Number(epoch) * 1000
  return pacificToMs(date, time)
}

// --- Events -------------------------------------------------------------------

export type EventLocation = { type: 'point'; at: LngLat } | { type: 'line'; from: LngLat; to: LngLat }

export type ClosureState = 'planned' | 'active' | 'ended' | 'canceled'

export type OfficialEvent = {
  source: 'Caltrans'
  district: number
  /** Caltrans's own id: the chain point's `index`, or the closure row's `index`. */
  id: string
  kind: 'chain-control' | 'closure' | 'lane-closure'
  /** Chain controls only. */
  chain?: ChainCode
  /** Caltrans's own words for a chain status. Data, never instructions. */
  description?: string
  /** Lane closures only. */
  closure?: {
    /** Rows of one closure share this; each night is its own row. */
    closureId: string
    type: string
    facility: string
    work: string
    lanesClosed: string
    totalLanes: string
    delay: string
    state: ClosureState
  }
  /** "SR-89", "US-50", "I-5". */
  route: string | null
  direction: string | null
  /** Where Caltrans says it is: "Luther Pass", or "Bedford Ave to Sly Park Rd". */
  name: string
  nearby: string | null
  location: EventLocation | null
  /** Closures: when it is scheduled to start and end. Chain controls carry neither. */
  beginsAt: string | null
  endsAt: string | null
  /** Pacific wall clock of the same, for comparing with a route's own clock. */
  beginsWall: string | null
  endsWall: string | null
  indefinite: boolean
  /** When the closure was requested. */
  publishedAt: string | null
  /** When the status last changed: a chain point's status time, or a closure's
   *  start, end, or cancellation report. */
  updatedAt: string | null
  /** When Routeloop fetched the feed. */
  retrievedAt: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const orNull = (v: unknown): string | null => str(v) || null
const isTrue = (v: unknown): boolean => str(v).toLowerCase() === 'true'

function lngLat(lng: unknown, lat: unknown): LngLat | null {
  const x = Number(str(lng))
  const y = Number(str(lat))
  if (!str(lng) || !str(lat) || !Number.isFinite(x) || !Number.isFinite(y)) return null
  if (Math.abs(x) > 180 || Math.abs(y) > 90 || (x === 0 && y === 0)) return null
  return [x, y]
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})

function rows(body: unknown, key: 'cc' | 'lcs'): Obj[] {
  const data = obj(body).data
  if (!Array.isArray(data)) return []
  return data.map((r) => obj(obj(r)[key])).filter((r) => Object.keys(r).length > 0)
}

const isoOrNull = (ms: number | null): string | null => (ms == null ? null : pacificIso(ms))

/** A chain-control feed's rows as events. Rows with no usable data are dropped. */
export function normalizeChainControls(body: unknown, district: number, retrievedAt: string): OfficialEvent[] {
  const out: OfficialEvent[] = []
  for (const r of rows(body, 'cc')) {
    if (str(r.inService).toLowerCase() === 'false') continue
    const loc = obj(r.location)
    const status = obj(r.statusData)
    const ts = obj(status.statusTimestamp)
    const at = lngLat(loc.longitude, loc.latitude)
    out.push({
      source: 'Caltrans',
      district: Number(str(loc.district)) || district,
      id: str(r.index) || `${district}-cc-${out.length}`,
      kind: 'chain-control',
      chain: parseChainCode(status.status),
      description: str(status.statusDescription) || undefined,
      route: orNull(loc.route),
      direction: orNull(loc.direction),
      name: str(loc.locationName) || 'an unnamed chain-control point',
      nearby: orNull(loc.nearbyPlace) === 'Not Reported' ? null : orNull(loc.nearbyPlace),
      location: at ? { type: 'point', at } : null,
      beginsAt: null,
      endsAt: null,
      beginsWall: null,
      endsWall: null,
      indefinite: false,
      publishedAt: null,
      updatedAt: isoOrNull(pacificToMs(ts.statusDate, ts.statusTime)),
      retrievedAt,
    })
  }
  return out
}

/** A lane-closure feed's rows as events. */
export function normalizeLaneClosures(body: unknown, district: number, retrievedAt: string): OfficialEvent[] {
  const out: OfficialEvent[] = []
  for (const r of rows(body, 'lcs')) {
    const loc = obj(r.location)
    const b = obj(loc.begin)
    const e = obj(loc.end)
    const c = obj(r.closure)
    const t = obj(c.closureTimestamp)
    const from = lngLat(b.beginLongitude, b.beginLatitude)
    const to = lngLat(e.endLongitude, e.endLatitude)
    const location: EventLocation | null =
      from && to && (from[0] !== to[0] || from[1] !== to[1])
        ? { type: 'line', from, to }
        : from || to
          ? { type: 'point', at: (from ?? to) as LngLat }
          : null
    const stamp = (k: '1097' | '1098' | '1022') => {
      const w = obj(c[`code${k}`])
      if (!isTrue(w[`isCode${k}`])) return null
      const s = obj(w[`code${k}Timestamp`])
      return instant(s[`code${k}Epoch`], s[`code${k}Date`], s[`code${k}Time`]) ?? Number.NaN
    }
    const started = stamp('1097')
    const ended = stamp('1098')
    const canceled = stamp('1022')
    const state: ClosureState =
      canceled != null ? 'canceled' : ended != null ? 'ended' : started != null ? 'active' : 'planned'
    const updated = [started, ended, canceled].filter((v): v is number => v != null && Number.isFinite(v))
    const indefinite = isTrue(t.isClosureEndIndefinite) || str(t.closureEndDate).startsWith('2999')
    const begins = instant(t.closureStartEpoch, t.closureStartDate, t.closureStartTime)
    const ends = indefinite ? null : instant(t.closureEndEpoch, t.closureEndDate, t.closureEndTime)
    const type = str(c.typeOfClosure) || 'Unspecified'
    const bName = str(b.beginLocationName) || str(b.beginFreeFormDescription)
    const eName = str(e.endLocationName) || str(e.endFreeFormDescription)
    out.push({
      source: 'Caltrans',
      district: Number(str(b.beginDistrict)) || district,
      id: str(r.index) || `${district}-lcs-${out.length}`,
      kind: type.toLowerCase() === 'full' ? 'closure' : 'lane-closure',
      closure: {
        closureId: str(c.closureID),
        type,
        facility: str(c.facility),
        work: str(c.typeOfWork),
        lanesClosed: str(c.lanesClosed),
        totalLanes: str(c.totalExistingLanes),
        delay: str(c.estimatedDelay),
        state,
      },
      route: orNull(b.beginRoute) ?? orNull(e.endRoute),
      direction: orNull(loc.travelFlowDirection),
      name: bName && eName && bName !== eName ? `${bName} to ${eName}` : bName || eName || 'an unnamed location',
      nearby: orNull(b.beginNearbyPlace) === 'Not Reported' ? null : orNull(b.beginNearbyPlace),
      location,
      beginsAt: isoOrNull(begins),
      endsAt: isoOrNull(ends),
      beginsWall: begins == null ? null : pacificWall(begins),
      endsWall: ends == null ? null : pacificWall(ends),
      indefinite,
      publishedAt: isoOrNull(instant(t.closureRequestEpoch, t.closureRequestDate, t.closureRequestTime)),
      updatedAt: updated.length ? pacificIso(Math.max(...updated)) : null,
      retrievedAt,
    })
  }
  return out
}

// --- Fetching, cached ------------------------------------------------------------

export type FeedResult =
  | { ok: true; kind: FeedKind; district: number; events: OfficialEvent[]; retrievedAt: string }
  | {
      ok: false
      kind: FeedKind
      district: number
      /** Why, in words a rider can read: "timed out after 8 seconds", "HTTP 500". */
      error: string
      triedAt: string
      /** When this feed last answered, this process's lifetime only. */
      lastOkAt: string | null
    }

type Cached = { at: number; result: Extract<FeedResult, { ok: true }> }
const cache = new Map<string, Cached>()
const lastOk = new Map<string, string>()
const inFlight = new Map<string, Promise<FeedResult>>()

/** Tests only: forget every cached feed. */
export function clearCaltransCache(): void {
  cache.clear()
  lastOk.clear()
  inFlight.clear()
}

async function load(kind: FeedKind, district: number, now: () => number): Promise<FeedResult> {
  const url = feedUrl(kind, district)
  const triedAt = pacificIso(now())
  const fail = (error: string): FeedResult => ({
    ok: false,
    kind,
    district,
    error,
    triedAt,
    lastOkAt: lastOk.get(url) ?? null,
  })
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return fail(`HTTP ${res.status}`)
    // As text first: one district's file has carried bytes that are not UTF-8.
    const body: unknown = JSON.parse(await res.text())
    const rows = obj(body).data
    if (!Array.isArray(rows)) return fail('an answer that was not the expected feed')
    // A 200 whose rows are not the feed's rows must not cache as an empty, all-clear
    // district: at least one row has to carry the record the feed is named for.
    if (rows.length && !rows.some((r) => typeof obj(r)[kind] === 'object' && obj(r)[kind] !== null))
      return fail('an answer that was not the expected feed')
    const retrievedAt = pacificIso(now())
    const events =
      kind === 'cc'
        ? normalizeChainControls(body, district, retrievedAt)
        : normalizeLaneClosures(body, district, retrievedAt)
    const result = { ok: true as const, kind, district, events, retrievedAt }
    cache.set(url, { at: now(), result })
    lastOk.set(url, retrievedAt)
    return result
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'TimeoutError' || name === 'AbortError')
      return fail(`timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`)
    console.error(`[caltrans] ${url} failed:`, err instanceof Error ? err.stack : err)
    return fail(err instanceof SyntaxError ? 'an answer that would not parse' : 'no answer')
  }
}

/**
 * One district's feed, from the cache when it is under CACHE_MS old. Concurrent
 * callers share one request. Never throws.
 */
export async function fetchFeed(kind: FeedKind, district: number, now: () => number = Date.now): Promise<FeedResult> {
  const url = feedUrl(kind, district)
  const hit = cache.get(url)
  if (hit && now() - hit.at < (kind === 'cc' ? CC_CACHE_MS : CACHE_MS)) return hit.result
  const pending = inFlight.get(url)
  if (pending) return pending
  const p = load(kind, district, now).finally(() => inFlight.delete(url))
  inFlight.set(url, p)
  return p
}

// --- Near the route --------------------------------------------------------------

/** How far off the drawn line an event may sit and still count as on it. */
export const NEAR_ROUTE_M = 1000

export type EventNear = {
  event: OfficialEvent
  /** Meters from the route's line. */
  offM: number
  /** Meters along the route to where it first comes near. */
  alongM: number
}

/** Cumulative meters at each vertex of a track. */
function cumulative(track: Track): number[] {
  const out = [0]
  for (let i = 1; i < track.length; i++)
    out.push(out[i - 1] + haversineM(track[i - 1][1], track[i - 1][0], track[i][1], track[i][0]))
  return out
}

/** Points along a closure's chord, about every kilometer, ends included. The
 *  straight line between a closure's ends does not follow a winding highway, which
 *  is why the ends are tested first and the chord only fills in for a route that
 *  joins the closed stretch partway along it. */
function chord(from: LngLat, to: LngLat): LngLat[] {
  const len = haversineM(from[1], from[0], to[1], to[0])
  const n = Math.min(60, Math.max(1, Math.ceil(len / 1000)))
  const out: LngLat[] = []
  for (let i = 0; i <= n; i++) out.push([from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n])
  return out
}

/**
 * The events within `radiusM` of a track, in order along it. An event with no
 * location cannot be placed and is left out; the caller counts those.
 */
export function eventsNear(events: OfficialEvent[], track: Track, radiusM = NEAR_ROUTE_M): EventNear[] {
  if (track.length === 0) return []
  const cum = cumulative(track)
  const out: EventNear[] = []
  for (const event of events) {
    const loc = event.location
    if (!loc) continue
    const probes = loc.type === 'point' ? [loc.at] : chord(loc.from, loc.to)
    let offM = Infinity
    let alongM = Infinity
    for (const p of probes) {
      const hit = nearestSegment(p, track)
      if (!hit || hit.offM > radiusM) continue
      const i = hit.index
      const seg = i + 1 < cum.length ? cum[i + 1] - cum[i] : 0
      offM = Math.min(offM, hit.offM)
      alongM = Math.min(alongM, cum[i] + seg * hit.t)
    }
    if (Number.isFinite(offM)) out.push({ event, offM, alongM })
  }
  out.sort((a, b) => a.alongM - b.alongM)
  return out
}
