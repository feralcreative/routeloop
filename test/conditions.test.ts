// Elevation and weather along a route (#23, #24): the server's sampling and date
// window, and the client's lookup by leg and fraction.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FETCH_TIMEOUT_MS,
  FORECAST_DAYS,
  MAX_ELEVATION_SAMPLES,
  MAX_WEATHER_SAMPLES,
  forecastWindow,
  routeElevation,
  routeWeather,
  sampleRoute,
  sunTimes,
  thinSamples,
} from '../src/maps/conditions'
import type { Track } from '../src/maps/kml'

// The elevation cache is written to disk; keep that off the real storage tree.
vi.mock('../src/maps/storage', async (orig) => ({
  ...(await orig<typeof import('../src/maps/storage')>()),
  STORAGE: join(tmpdir(), `routeloop-conditions-test-${process.pid}`),
}))

// ~111 km a degree of latitude, so these legs are 11 km and 22 km.
const leg = (from: number, to: number): Track => [
  [-120, from],
  [-120, to],
]

describe('sampleRoute', () => {
  it('includes both ends of every leg and caps the count', () => {
    const s = sampleRoute([leg(40, 40.1), leg(40.1, 40.3)], 1_000, 10)
    expect(s.length).toBeLessThanOrEqual(10 + 2)
    expect(s[0]).toMatchObject({ leg: 0, f: 0 })
    expect(s.find((x) => x.leg === 0 && x.f === 1)).toBeTruthy()
    expect(s.find((x) => x.leg === 1 && x.f === 0)).toBeTruthy()
    expect(s[s.length - 1]).toMatchObject({ leg: 1, f: 1 })
  })

  it('orders samples along the road with growing distance', () => {
    const s = sampleRoute([leg(40, 40.1), leg(40.1, 40.3)], 2_000, 50)
    for (let i = 1; i < s.length; i++) {
      expect(s[i].leg + s[i].f).toBeGreaterThanOrEqual(s[i - 1].leg + s[i - 1].f)
      expect(s[i].d).toBeGreaterThanOrEqual(s[i - 1].d)
    }
  })

  it('skips a leg with no length and keeps its neighbors addressed by their own index', () => {
    const s = sampleRoute([leg(40, 40.1), [[-120, 40.1], [-120, 40.1]], leg(40.1, 40.2)], 5_000, 20)
    expect(s.some((x) => x.leg === 1)).toBe(false)
    expect(s.some((x) => x.leg === 2)).toBe(true)
  })

  it('has nothing to say about a route with no road', () => {
    expect(sampleRoute([], 1_000, 10)).toEqual([])
  })
})

describe('thinSamples', () => {
  it('holds a route of many legs to the cap, first and last kept, in order', () => {
    const legs: Track[] = Array.from({ length: 399 }, (_, i) => [
      [-120 + i * 0.01, 40],
      [-120 + (i + 1) * 0.01, 40],
    ])
    const all = sampleRoute(legs, 40_000, 12)
    expect(all.length).toBeGreaterThan(700) // both ends of every leg: no cap at all
    const thin = thinSamples(all, 12)
    expect(thin).toHaveLength(12)
    expect(thin[0]).toBe(all[0])
    expect(thin[11]).toBe(all[all.length - 1])
    for (let i = 1; i < thin.length; i++) expect(thin[i].d).toBeGreaterThan(thin[i - 1].d)
    expect(thinSamples(all.slice(0, 5), 12)).toHaveLength(5)
  })
})

describe('Open-Meteo requests', () => {
  const NOW = new Date('2026-11-01T12:00:00Z')
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // A 400-point route in open ocean, so nothing is already cached.
  const route400 = (lat: number): Track[] =>
    Array.from({ length: 399 }, (_, i) => [
      [170 + i * 0.01, lat],
      [170 + (i + 1) * 0.01, lat],
    ])

  it('asks for at most the caps on a 400-point route when thinned', async () => {
    const asked = { elevation: 0, weather: 0 }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = new URL(url)
        const n = u.searchParams.get('latitude')!.split(',').length
        if (u.pathname.endsWith('/elevation')) {
          asked.elevation += n
          return Response.json({ elevation: Array(n).fill(5) })
        }
        asked.weather += n
        const one = { utc_offset_seconds: 43_200, hourly: { time: ['2026-11-03T14:00'], temperature_2m: [10] } }
        return Response.json(n === 1 ? one : Array(n).fill(one))
      }),
    )
    const legs = route400(-10)
    const ele = await routeElevation(legs, { thin: true })
    const wx = await routeWeather(legs, '2026-11-03T14:00:00.000Z', '2026-11-03T18:00:00.000Z', NOW, { thin: true })
    expect(asked.elevation).toBeGreaterThan(0)
    expect(asked.elevation).toBeLessThanOrEqual(MAX_ELEVATION_SAMPLES)
    expect(ele.points.length).toBeLessThanOrEqual(MAX_ELEVATION_SAMPLES)
    expect(asked.weather).toBeGreaterThan(0)
    expect(asked.weather).toBeLessThanOrEqual(MAX_WEATHER_SAMPLES)
    expect(wx.length).toBeLessThanOrEqual(MAX_WEATHER_SAMPLES)
    expect(wx[0].utcOffsetS).toBe(43_200)
  })

  it('gives up on a hung request after the timeout and answers unknown, never clear', async () => {
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => AbortSignal.abort(new DOMException('timed out', 'TimeoutError')))
    // Hangs forever unless its signal aborts, as a stalled Open-Meteo would.
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal
          if (!sig) return
          if (sig.aborted) reject(sig.reason)
          else sig.addEventListener('abort', () => reject(sig.reason))
        }),
    )
    vi.stubGlobal('fetch', hang)
    const legs = route400(-20)
    expect(await routeWeather(legs, '2026-11-03T14:00:00.000Z', null, NOW, { thin: true })).toEqual([])
    expect(await routeElevation(legs, { thin: true })).toEqual({ points: [], complete: false })
    expect(await sunTimes([171, -20], '2026-11-03', NOW)).toBeNull()
    expect(hang).toHaveBeenCalledTimes(3)
    for (const call of hang.mock.calls) expect(call[1]?.signal).toBeDefined()
    expect(timeout).toHaveBeenCalledTimes(3)
    for (const call of timeout.mock.calls) expect(call[0]).toBe(FETCH_TIMEOUT_MS)
    expect(FETCH_TIMEOUT_MS).toBe(8_000)
  })
})

describe('forecastWindow', () => {
  const now = new Date('2026-09-29T12:00:00Z')

  it('asks for the route’s own dates', () => {
    expect(forecastWindow('2026-10-03T09:00:00.000Z', '2026-10-04T17:00:00.000Z', now)).toEqual({
      from: '2026-10-03',
      to: '2026-10-04',
    })
  })

  it('has no forecast for a route in the past or past the horizon', () => {
    expect(forecastWindow('2026-09-01T09:00:00.000Z', null, now)).toBeNull()
    const beyond = new Date(now.getTime() + FORECAST_DAYS * 86_400_000).toISOString()
    expect(forecastWindow(beyond, null, now)).toBeNull()
  })

  it('clips a route straddling today to what can be forecast', () => {
    expect(forecastWindow('2026-09-28T09:00:00.000Z', '2026-09-30T09:00:00.000Z', now)).toEqual({
      from: '2026-09-29',
      to: '2026-09-30',
    })
  })
})

describe('conditions.js', () => {
  let C: any
  beforeAll(() => {
    const win: Record<string, unknown> = {}
    new Function('window', readFileSync('public/js/conditions.js', 'utf8'))(win)
    C = win.TBConditions
  })

  const samples = [
    { leg: 0, f: 0, d: 0, e: 100 },
    { leg: 0, f: 1, d: 1000, e: 200 },
    { leg: 1, f: 1, d: 2000, e: 150 },
  ]

  it('places a moment on a leg, at a point, and at the end', () => {
    const route = { legs: [{}, {}] }
    expect(C.roadPosition(route, { legIndex: 1, legFraction: 0.5, pointIndex: null })).toEqual({ leg: 1, f: 0.5 })
    expect(C.roadPosition(route, { legIndex: null, pointIndex: 1 })).toEqual({ leg: 1, f: 0 })
    expect(C.roadPosition(route, { legIndex: null, pointIndex: 2 })).toEqual({ leg: 1, f: 1 })
    expect(C.roadPosition({ legs: [] }, { legIndex: null, pointIndex: 0 })).toBeNull()
  })

  it('interpolates elevation and reports the grade of the stretch it is on', () => {
    const mid = C.elevationAt(samples, { leg: 0, f: 0.5 })
    expect(mid.e).toBe(150)
    expect(mid.grade).toBeCloseTo(0.1)
    const down = C.elevationAt(samples, { leg: 1, f: 0.5 })
    expect(down.e).toBe(175)
    expect(down.grade).toBeCloseTo(-0.05)
    expect(C.elevationAt([], { leg: 0, f: 0 })).toBeNull()
  })

  it('reads the forecast hour from the wall-clock digits', () => {
    // 09:40 at the departure point, carried as UTC.
    const m = Date.parse('2026-10-03T09:40:00Z') / 1000
    expect(C.hourKey(m)).toBe('2026-10-03T09:00')
    const points = [
      { leg: 0, f: 0, time: ['2026-10-03T09:00'], tempC: [10], rainPct: [40], windKmh: [5], code: [61] },
      { leg: 1, f: 1, time: ['2026-10-03T09:00'], tempC: [20], rainPct: [0], windKmh: [5], code: [0] },
    ]
    expect(C.weatherAt(points, { leg: 0, f: 0.2 }, m).tempC).toBe(10)
    expect(C.weatherAt(points, { leg: 1, f: 0.9 }, m).tempC).toBe(20)
    expect(C.weatherAt(points, { leg: 0, f: 0 }, m + 7200)).toBeNull()
  })

  it('says the weather in the rider’s units and leaves out what does not matter', () => {
    const w = { tempC: 20, rainPct: 5, windKmh: 10, code: 0 }
    expect(C.fmtWeather(w, 'imperial')).toBe('Clear, 68°F')
    expect(C.fmtWeather({ ...w, rainPct: 60, windKmh: 40, code: 63 }, 'metric')).toBe('Rain, 20°C, 60% rain, wind 40 km/h')
    expect(C.fmtElevation(1000, 'imperial')).toBe('3,281 ft')
    expect(C.fmtGrade(0.064)).toBe('+6%')
    expect(C.fmtGrade(-0.03)).toBe('−3%')
  })
})
