// Elevation (#23) and weather (#24) along a route, both from Open-Meteo: free,
// keyless, and one host for both. Ziad's call, 2026-09-29, over Google Elevation
// and Google Weather, which bill per request on the server key.
//
// SAMPLES ARE ADDRESSED BY LEG AND FRACTION, NEVER BY DISTANCE. The client places
// the rider with `activeAt()`, which answers a leg and a fraction of it, and the
// router's `distanceM` and the geometry's own length disagree by meters on every
// leg — so a sample keyed by distance would drift from the dot it is drawn under.
//
// WEATHER HOURS ARE LOCAL WALL CLOCK (`timezone=auto`), which is exactly what a
// route's `start_at` is: a wall clock at the departure point carried as UTC. The
// two are compared digit for digit and nothing converts either. A route crossing
// a zone line reads the next zone's hours in the next zone's clock, which is the
// honest answer for somebody riding into it.
//
// NEVER THROWS. A failure is an empty answer: this is a picture beside the plan,
// and an outage must not take the timeline with it.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { haversineM, type Track } from './kml'
import { STORAGE } from './storage'

type LngLat = [number, number]

const ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

/** Open-Meteo's per-request coordinate ceiling for elevation. */
const ELEVATION_BATCH = 100
/** Samples per route. Open-Meteo's free tier allows about 600 coordinates a minute
 *  and 10,000 a day, so this is a budget number, not a resolution one. */
export const MAX_ELEVATION_SAMPLES = 80
/** Never closer than this: a grade over less of a 90 m DEM is noise. */
const MIN_ELEVATION_SPACING_M = 500
/** Forecast points per route, and the spacing that fills them. */
export const MAX_WEATHER_SAMPLES = 12
const WEATHER_SPACING_M = 40_000
/** How far out Open-Meteo forecasts. */
export const FORECAST_DAYS = 16

export type Sample = { leg: number; f: number; at: LngLat; d: number }
/** `d` is meters along the route's own geometry, for grade and nothing else. */
export type ElevationPoint = { leg: number; f: number; d: number; e: number }
export type WeatherPoint = {
  leg: number
  f: number
  /** Local wall-clock hours, `YYYY-MM-DDTHH:00`, parallel to the arrays below. */
  time: string[]
  tempC: (number | null)[]
  rainPct: (number | null)[]
  windKmh: (number | null)[]
  code: (number | null)[]
}

/**
 * Points along a route's legs every `spacingM`, capped at `max`, with both ends of
 * every leg always included so a stop is never interpolated across. Pure.
 */
export function sampleRoute(legs: Track[], spacingM: number, max: number): Sample[] {
  const lens = legs.map(legLengths)
  const total = lens.reduce((a, l) => a + (l.length ? l[l.length - 1] : 0), 0)
  if (total <= 0) return []
  const step = Math.max(spacingM, total / max)
  const out: Sample[] = []
  let base = 0
  legs.forEach((g, leg) => {
    const cum = lens[leg]
    const len = cum.length ? cum[cum.length - 1] : 0
    if (g.length < 2 || len <= 0) {
      base += len
      return
    }
    const n = Math.max(1, Math.round(len / step))
    for (let k = 0; k <= n; k++) {
      const f = k / n
      out.push({ leg, f, at: pointAt(g, cum, f * len), d: base + f * len })
    }
    base += len
  })
  return out
}

function legLengths(g: Track): number[] {
  const cum = [0]
  for (let i = 1; i < g.length; i++) cum.push(cum[i - 1] + haversineM(g[i - 1][1], g[i - 1][0], g[i][1], g[i][0]))
  return g.length ? cum : []
}

function pointAt(g: Track, cum: number[], d: number): LngLat {
  for (let i = 1; i < g.length; i++) {
    if (cum[i] >= d) {
      const span = cum[i] - cum[i - 1]
      const t = span > 0 ? (d - cum[i - 1]) / span : 0
      return [g[i - 1][0] + (g[i][0] - g[i - 1][0]) * t, g[i - 1][1] + (g[i][1] - g[i - 1][1]) * t]
    }
  }
  return g[g.length - 1]
}

// --- Elevation --------------------------------------------------------------

// Keyed on ~10 m of coordinate, which the 90 m DEM cannot tell apart anyway, so a
// route edited at one end reuses every sample it did not move. ON DISK, because
// the ground does not change and the free tier's daily allowance is the budget:
// a point is asked for once, ever, not once per deploy. Shared data about the
// ground, nothing about a rider, which is why it may sit under STORAGE where stage
// and prod both write it — atomically, so neither reads the other's half-file.
const elevationCache = new Map<string, number>()
const ELEVATION_CACHE_MAX = 500_000
const CACHE_DIR = join(STORAGE, 'cache')
const CACHE_FILE = join(CACHE_DIR, 'elevation.json')
const ekey = (p: LngLat) => p[0].toFixed(4) + ',' + p[1].toFixed(4)
let loaded: Promise<void> | null = null
let saveTimer: NodeJS.Timeout | null = null

function loadElevationCache(): Promise<void> {
  loaded ??= readFile(CACHE_FILE, 'utf8')
    .then((text) => {
      for (const [k, v] of Object.entries(JSON.parse(text) as Record<string, number>)) elevationCache.set(k, v)
    })
    .catch(() => {})
  return loaded
}

function saveElevationCacheSoon() {
  if (saveTimer) return
  saveTimer = setTimeout(async () => {
    saveTimer = null
    try {
      await mkdir(CACHE_DIR, { recursive: true })
      const tmp = `${CACHE_FILE}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(Object.fromEntries(elevationCache)))
      await rename(tmp, CACHE_FILE)
    } catch (err) {
      console.error('[conditions] elevation cache write failed', err)
    }
  }, 5_000)
  saveTimer.unref()
}

async function elevationsFor(points: LngLat[]): Promise<(number | null)[]> {
  await loadElevationCache()
  const missing = [...new Set(points.map(ekey).filter((k) => !elevationCache.has(k)))]
  for (let i = 0; i < missing.length; i += ELEVATION_BATCH) {
    const batch = missing.slice(i, i + ELEVATION_BATCH)
    const lat = batch.map((k) => k.split(',')[1]).join(',')
    const lng = batch.map((k) => k.split(',')[0]).join(',')
    try {
      const res = await fetch(`${ELEVATION_URL}?latitude=${lat}&longitude=${lng}`)
      if (!res.ok) break
      const body = (await res.json()) as { elevation?: number[] }
      body.elevation?.forEach((e, j) => {
        if (typeof e === 'number' && Number.isFinite(e)) elevationCache.set(batch[j], e)
      })
    } catch {
      break
    }
  }
  while (elevationCache.size > ELEVATION_CACHE_MAX) elevationCache.delete(elevationCache.keys().next().value!)
  if (missing.length) saveElevationCacheSoon()
  return points.map((p) => elevationCache.get(ekey(p)) ?? null)
}

/** `complete` is false when the free tier ran out partway, so the client asks again later. */
export async function routeElevation(legs: Track[]): Promise<{ points: ElevationPoint[]; complete: boolean }> {
  const samples = sampleRoute(legs, MIN_ELEVATION_SPACING_M, MAX_ELEVATION_SAMPLES)
  if (!samples.length) return { points: [], complete: true }
  const ele = await elevationsFor(samples.map((s) => s.at))
  const out: ElevationPoint[] = []
  samples.forEach((s, i) => {
    const e = ele[i]
    if (e != null) out.push({ leg: s.leg, f: round(s.f, 4), d: Math.round(s.d), e: Math.round(e) })
  })
  return { points: out, complete: out.length === samples.length }
}

// --- Weather ----------------------------------------------------------------

type ForecastBody = {
  hourly?: {
    time?: string[]
    temperature_2m?: (number | null)[]
    precipitation_probability?: (number | null)[]
    wind_speed_10m?: (number | null)[]
    weather_code?: (number | null)[]
  }
}

// A forecast moves hourly, so thirty minutes; keyed on ~1 km and the date window.
const weatherCache = new Map<string, { at: number; body: ForecastBody }>()
const WEATHER_TTL_MS = 30 * 60_000
const WEATHER_CACHE_MAX = 5_000
const wkey = (p: LngLat, from: string, to: string) => `${p[0].toFixed(2)},${p[1].toFixed(2)},${from},${to}`

/** The date window a route needs, or null when Open-Meteo has no forecast for it. Pure. */
export function forecastWindow(startIso: string, endIso: string | null, now: Date): { from: string; to: string } | null {
  const from = startIso.slice(0, 10)
  const end = endIso && endIso > startIso ? endIso : startIso
  const to = end.slice(0, 10)
  const today = now.toISOString().slice(0, 10)
  const last = new Date(now.getTime() + (FORECAST_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)
  if (to < today || from > last) return null
  return { from: from < today ? today : from, to: to > last ? last : to }
}

async function forecastsFor(points: LngLat[], from: string, to: string): Promise<(ForecastBody | null)[]> {
  const now = Date.now()
  const need = points.filter((p) => {
    const hit = weatherCache.get(wkey(p, from, to))
    return !hit || now - hit.at > WEATHER_TTL_MS
  })
  if (need.length) {
    const params = new URLSearchParams({
      latitude: need.map((p) => p[1].toFixed(3)).join(','),
      longitude: need.map((p) => p[0].toFixed(3)).join(','),
      hourly: 'temperature_2m,precipitation_probability,wind_speed_10m,weather_code',
      timezone: 'auto',
      start_date: from,
      end_date: to,
    })
    try {
      const res = await fetch(`${FORECAST_URL}?${params}`)
      if (res.ok) {
        const body = (await res.json()) as ForecastBody | ForecastBody[]
        const list = Array.isArray(body) ? body : [body]
        list.forEach((b, i) => weatherCache.set(wkey(need[i], from, to), { at: now, body: b }))
      }
    } catch {
      // An empty answer, as the header says.
    }
    while (weatherCache.size > WEATHER_CACHE_MAX) weatherCache.delete(weatherCache.keys().next().value!)
  }
  return points.map((p) => weatherCache.get(wkey(p, from, to))?.body ?? null)
}

export async function routeWeather(
  legs: Track[],
  startIso: string | null,
  endIso: string | null,
  now = new Date(),
): Promise<WeatherPoint[]> {
  if (!startIso) return []
  const win = forecastWindow(startIso, endIso, now)
  if (!win) return []
  const samples = sampleRoute(legs, WEATHER_SPACING_M, MAX_WEATHER_SAMPLES)
  if (!samples.length) return []
  const bodies = await forecastsFor(
    samples.map((s) => s.at),
    win.from,
    win.to,
  )
  const out: WeatherPoint[] = []
  samples.forEach((s, i) => {
    const h = bodies[i]?.hourly
    if (!h?.time?.length) return
    out.push({
      leg: s.leg,
      f: round(s.f, 4),
      time: h.time,
      tempC: h.temperature_2m ?? [],
      rainPct: h.precipitation_probability ?? [],
      windKmh: h.wind_speed_10m ?? [],
      code: h.weather_code ?? [],
    })
  })
  return out
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp
