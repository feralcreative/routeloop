// get_conditions: the forecast matched to the route’s own clock, the cold bands,
// and every way an empty answer is said rather than left silent. Nothing here
// reaches the network: the conditions module is mocked, and sunTimes() is tested
// against a stubbed fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ridePayload, type RidePayload } from '../src/maps/ride-graph'
import type { WeatherPoint } from '../src/maps/conditions'

vi.mock('../src/maps/conditions', async (orig) => {
  const actual = await orig<typeof import('../src/maps/conditions')>()
  return { ...actual, routeWeather: vi.fn(), routeElevation: vi.fn(), sunTimes: vi.fn() }
})

const conditions = await import('../src/maps/conditions')
const {
  alignReadings,
  coldBand,
  conditionsFor,
  forecastGap,
  formatConditions,
  routeClock,
  routeEndIso,
  getConditions,
} = await import('../src/agent/tools/conditions')
type ConditionsInput = import('../src/agent/tools/conditions').ConditionsInput

const MI = 1609.344
const NOW = new Date('2026-11-01T12:00:00Z')

const pt = (uid: string, name: string, lng: number, lat: number, durationMin: number | null = null) => ({
  uid,
  kind: 'stop' as const,
  name,
  lat,
  lng,
  roles: [],
  durationMin,
})

function ride(startAt: string | null = '2026-11-03T14:00:00.000Z'): RidePayload {
  return ridePayload.parse({
    title: 'Cold run',
    routes: [
      {
        uid: 'route0000001',
        title: 'Over the hill',
        startAt,
        points: [
          pt('aaaaaaaaaaaa', 'Oakland', -122.27, 37.8),
          pt('bbbbbbbbbbbb', 'Willits', -123.35, 39.41, 30),
          pt('cccccccccccc', 'Garberville', -123.79, 40.1),
        ],
        legs: [
          {
            geometry: [
              [-122.27, 37.8],
              [-123.35, 39.41],
            ],
            distanceM: Math.round(60 * MI),
            durationS: 3600,
            viaPoints: [],
          },
          {
            geometry: [
              [-123.35, 39.41],
              [-123.79, 40.1],
            ],
            distanceM: Math.round(60 * MI),
            durationS: 3600,
            viaPoints: [],
          },
        ],
      },
    ],
  })
}

const PST = -8 * 3600
const MST = -7 * 3600

/** A day of hourly forecast for one spot, every hour the same except where set, on
 *  that spot's own clock (`off`, Pacific unless said). */
function wp(
  leg: number,
  f: number,
  at: Record<string, { t?: number; rain?: number; wind?: number; code?: number }>,
  off: number | null = PST,
) {
  const time = Array.from({ length: 24 }, (_, h) => `2026-11-03T${String(h).padStart(2, '0')}:00`)
  return {
    leg,
    f,
    time,
    tempC: time.map((t) => at[t.slice(11)]?.t ?? 15),
    rainPct: time.map((t) => at[t.slice(11)]?.rain ?? 0),
    windKmh: time.map((t) => at[t.slice(11)]?.wind ?? 10),
    code: time.map((t) => at[t.slice(11)]?.code ?? 0),
    utcOffsetS: off,
  } satisfies WeatherPoint
}

function input(over: Partial<ConditionsInput> = {}): ConditionsInput {
  const r = ride()
  return {
    route: r.routes[0],
    routeNo: 1,
    units: 'mi',
    snapshot: { kind: 'draft' },
    vehicle: 'motorcycle',
    now: NOW,
    gap: null,
    weather: [wp(0, 0, {}), wp(1, 0.5, {})],
    weatherAsked: 2,
    elevation: {
      points: [
        { leg: 0, f: 0, d: 0, e: 10 },
        { leg: 1, f: 1, d: 193_000, e: 1200 },
      ],
      complete: true,
    },
    sun: { sunrise: '2026-11-03T06:40', sunset: '2026-11-03T17:05' },
    ...over,
  }
}

describe('the route’s own clock', () => {
  it('leaves each point after its dwell and ends at the last arrival', () => {
    const { leave, endS } = routeClock(ride().routes[0])
    expect(leave).toEqual([0, 3600 + 1800, 3600 + 1800 + 3600])
    expect(endS).toBe(9000)
    expect(routeEndIso(ride().routes[0])).toBe('2026-11-03T16:30:00.000Z')
    expect(routeEndIso(ride(null).routes[0])).toBeNull()
  })

  it('reads each forecast at the hour the group gets there', () => {
    const { readings, missing } = alignReadings(ride().routes[0], [
      wp(0, 0, { '14:00': { t: 20 } }),
      wp(1, 0.5, { '16:00': { t: 3 } }),
    ])
    expect(missing).toBe(0)
    expect(readings.map((r) => [r.eta, r.tempC])).toEqual([
      ['2026-11-03T14:00', 20],
      ['2026-11-03T16:00', 3],
    ])
  })

  it('reads a spot over a zone line at its own local hour', () => {
    // Departs 14:00 Pacific; the second spot is reached at 16:00 on that clock,
    // which is 17:00 in Mountain time, where its forecast hours are.
    const { readings } = alignReadings(ride().routes[0], [
      wp(0, 0, {}),
      wp(1, 0.5, { '16:00': { t: 20 }, '17:00': { t: 3 } }, MST),
    ])
    expect(readings[1]).toMatchObject({ eta: '2026-11-03T16:00', local: '2026-11-03T17:00', tempC: 3 })
    // With no offset to hand, the two clocks are read digit for digit.
    const { readings: blind } = alignReadings(ride().routes[0], [
      wp(0, 0, {}, null),
      wp(1, 0.5, { '16:00': { t: 20 }, '17:00': { t: 3 } }, MST),
    ])
    expect(blind[1].tempC).toBe(20)
  })

  it('counts a spot whose hour the forecast does not cover as missing, never as fair', () => {
    const late = { ...wp(1, 0.5, {}), time: ['2026-11-04T00:00'] }
    expect(alignReadings(ride().routes[0], [late]).missing).toBe(1)
  })
})

describe('coldBand', () => {
  it('follows the owner’s motorcycle bands in °F', () => {
    expect(coldBand(-1)).toBe('freezing') // 30.2°F
    expect(coldBand(0)).toBe('30s') // 32°F
    expect(coldBand(5)).toBe('40s') // 41°F
    expect(coldBand(12)).toBe('50s') // 53.6°F
    expect(coldBand(16)).toBeNull() // 60.8°F
  })
})

describe('forecastGap', () => {
  it('names why there is no forecast', () => {
    expect(forecastGap(null, null, NOW)).toBe('no-departure')
    expect(forecastGap('2026-10-20T09:00:00.000Z', null, NOW)).toBe('past')
    expect(forecastGap('2026-12-25T09:00:00.000Z', null, NOW)).toBe('beyond')
    expect(forecastGap('2026-11-03T09:00:00.000Z', null, NOW)).toBeNull()
  })
})

describe('formatConditions', () => {
  it('gives the low, the high, the worst rain and wind, elevation and the sun, each cited', () => {
    const text = formatConditions(
      input({
        weather: [wp(0, 0, { '14:00': { t: 20, rain: 30, wind: 40 } }), wp(1, 0.5, { '16:00': { t: 12, rain: 70 } })],
      }),
    )
    expect(text).toContain('low 54°F around 16:00 between “Willits” and “Garberville” (90.0 mi in)')
    expect(text).toContain('high 68°F around 14:00 at “Oakland” (0.0 mi in)')
    expect(text).toContain('brisk')
    expect(text).toContain('Rain: worst chance 70% around 16:00')
    expect(text).toContain('Wind: strongest 25 mph sustained around 14:00')
    expect(text).toMatch(/Elevation: low 33 ft .* high 3,937 ft/)
    expect(text).toContain('sunrise 06:40, sunset 17:05')
    expect(text).toContain('[forecast: Open-Meteo, checked 2026-11-01 12:00 UTC]')
    expect(text).toContain('[computed by Routeloop]')
    expect(text).not.toContain('AFTER SUNSET')
  })

  it('warns hard when the route runs into the evening in the 30s', () => {
    const text = formatConditions(input({ weather: [wp(0, 0, {}), wp(1, 0.5, { '16:00': { t: 2 } })] }))
    expect(text).toContain('in the 30s °F: bearable only for short periods')
    expect(text).toContain('HARD WARNING: the route runs into the evening as it cools, 36°F around 16:00')
  })

  it('calls below freezing not a riding day', () => {
    const text = formatConditions(input({ weather: [wp(0, 0, { '14:00': { t: -3 } })], weatherAsked: 1 }))
    expect(text).toContain('HARD WARNING: the coldest stretch is below freezing: not a riding day')
  })

  it('names snow, ice and storms', () => {
    const text = formatConditions(
      input({ weather: [wp(0, 0, { '14:00': { code: 73 } }), wp(1, 0.5, { '16:00': { code: 95 } })] }),
    )
    expect(text).toContain('WARNING: snow forecast around 14:00')
    expect(text).toContain('WARNING: thunderstorms forecast around 16:00')
  })

  it('speaks Celsius, km/h and meters to a metric rider', () => {
    const text = formatConditions(
      input({ units: 'km', weather: [wp(0, 0, { '14:00': { t: 20, wind: 40 } })], weatherAsked: 1 }),
    )
    expect(text).toContain('high 20°C')
    expect(text).toContain('40 km/h')
    expect(text).toContain('high 1,200 m')
  })

  it('flags an arrival after sunset', () => {
    const text = formatConditions(input({ sun: { sunrise: '2026-11-03T06:40', sunset: '2026-11-03T16:10' } }))
    expect(text).toContain('arrives at 16:30 (departure clock), AFTER SUNSET')
  })

  it('compares a Mountain-time sunset with a Pacific departure on one clock', () => {
    // Arrives 16:30 Pacific, which is 17:30 at the Mountain-time end: after its
    // 17:05 sunset, although the departure clock's digits are before it.
    const crossing = {
      weather: [wp(0, 0, {}), wp(1, 0.5, { '17:00': { t: 2 } }, MST)],
      sun: { sunrise: '2026-11-03T07:40', sunset: '2026-11-03T17:05', utcOffsetS: MST },
    }
    const text = formatConditions(input(crossing))
    expect(text).toContain('arrives at 17:30 local time there (16:30 on the departure clock), AFTER SUNSET')
    expect(text).toContain('36°F around 17:00 local (16:00 departure clock)')
    // The reverse: a Pacific arrival at 16:30 is before a 17:05 Pacific sunset.
    expect(formatConditions(input({ sun: { ...crossing.sun, utcOffsetS: PST } }))).not.toContain('AFTER SUNSET')
  })

  it('never lets an empty answer read as clear', () => {
    const undated = ride(null).routes[0]
    expect(formatConditions(input({ route: undated, gap: 'no-departure', weather: null, sun: null }))).toMatch(
      /Weather: UNKNOWN\. This route has no departure time.*not a clear forecast/,
    )
    expect(formatConditions(input({ gap: 'beyond', weather: null }))).toContain('more than 16 days out')
    expect(formatConditions(input({ gap: 'past', weather: null }))).toContain('has passed')
    expect(formatConditions(input({ weather: [] }))).toContain('Open-Meteo did not answer just now')
    expect(formatConditions(input({ weather: [wp(0, 0, {})], weatherAsked: 3 }))).toContain(
      'Only 1 of 3 spots along the route had a forecast',
    )
    expect(formatConditions(input({ elevation: { points: [], complete: false } }))).toContain('Elevation: UNKNOWN')
    expect(formatConditions(input({ sun: null }))).toContain('unavailable')
  })

  it('says which copy of the ride it describes', () => {
    expect(formatConditions(input())).toContain('builder’s open copy')
    expect(formatConditions(input({ snapshot: { kind: 'saved', rev: 7, pending: 0 } }))).toContain(
      'as saved (revision 7)',
    )
  })
})

describe('conditionsFor', () => {
  const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in tests')))
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy)
    vi.mocked(conditions.routeWeather).mockResolvedValue([wp(0, 0, { '14:00': { t: 20 } })])
    vi.mocked(conditions.routeElevation).mockResolvedValue({ points: [{ leg: 0, f: 0, d: 0, e: 10 }], complete: true })
    vi.mocked(conditions.sunTimes).mockResolvedValue({ sunrise: '2026-11-03T06:40', sunset: '2026-11-03T17:05' })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const ctx = (r: RidePayload) =>
    ({ ride: r, units: 'mi', snapshot: { kind: 'draft' }, progress: () => {} }) as unknown as Parameters<
      typeof conditionsFor
    >[0]

  it('samples the ride it holds, on its own dates, at the route’s end', async () => {
    const text = await conditionsFor(ctx(ride()), 'route0000001', NOW)
    const [legs, start, end, now] = vi.mocked(conditions.routeWeather).mock.calls[0]
    expect(legs).toHaveLength(2)
    expect(start).toBe('2026-11-03T14:00:00.000Z')
    expect(end).toBe('2026-11-03T16:30:00.000Z')
    expect(now).toBe(NOW)
    // Thinned to the hard caps, which the map's own endpoint does not ask for.
    expect(vi.mocked(conditions.routeWeather).mock.calls[0][4]).toEqual({ thin: true })
    expect(vi.mocked(conditions.routeElevation).mock.calls[0][1]).toEqual({ thin: true })
    expect(vi.mocked(conditions.sunTimes).mock.calls[0]).toEqual([[-123.79, 40.1], '2026-11-03', NOW])
    expect(text).toContain('high 68°F')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('asks no forecast for an undated route and says so', async () => {
    const text = await conditionsFor(ctx(ride(null)), 'route0000001', NOW)
    expect(conditions.routeWeather).not.toHaveBeenCalled()
    expect(conditions.sunTimes).not.toHaveBeenCalled()
    expect(text).toContain('Weather: UNKNOWN')
  })

  it('refuses a route it does not hold', async () => {
    expect(await conditionsFor(ctx(ride()), 'nope', NOW)).toBe('No route with uid nope.')
  })

  it('is a read anyone on the ride may call', () => {
    expect(getConditions.cap).toEqual({ mutates: false, needs: 'view' })
    expect(getConditions.schema.safeParse({ route_uid: 'x', extra: 1 }).success).toBe(false)
  })
})

describe('sunTimes', () => {
  const real = vi.importActual<typeof import('../src/maps/conditions')>('../src/maps/conditions')
  afterEach(() => vi.unstubAllGlobals())

  it('reads the daily sunrise and sunset in local time', async () => {
    const fetchSpy = vi.fn(async (_url: string) =>
      Response.json({
        utc_offset_seconds: -28_800,
        daily: { sunrise: ['2026-11-03T06:41'], sunset: ['2026-11-03T17:04'] },
      }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const { sunTimes } = await real
    expect(await sunTimes([-121.11, 38.22], '2026-11-03', NOW)).toEqual({
      sunrise: '2026-11-03T06:41',
      sunset: '2026-11-03T17:04',
      utcOffsetS: -28_800,
    })
    const url = new URL(fetchSpy.mock.calls[0][0])
    expect(url.searchParams.get('daily')).toBe('sunrise,sunset')
    expect(url.searchParams.get('timezone')).toBe('auto')
  })

  it('answers null, never throws, on failure or outside the forecast', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('down')))
    vi.stubGlobal('fetch', fetchSpy)
    const { sunTimes } = await real
    expect(await sunTimes([-100.5, 30.5], '2026-11-04', NOW)).toBeNull()
    expect(await sunTimes([-100.5, 30.5], '2027-03-01', NOW)).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
