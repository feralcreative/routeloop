// Elevation and weather along a route (#23, #24): the server's sampling and date
// window, and the client's lookup by leg and fraction.
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { FORECAST_DAYS, forecastWindow, sampleRoute } from '../src/maps/conditions'
import type { Track } from '../src/maps/kml'

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
