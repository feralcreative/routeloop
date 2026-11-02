// get_official_closures: Caltrans read along the ride’s own line, the vehicle’s
// reading of a chain control, the route’s date, an outage said as unknown, and a
// route outside California. No network: fetch is stubbed with the fixtures in
// test/fixtures/caltrans/, real rows from 2026-11-01 with edited chain statuses.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ridePayload, type RidePayload } from '../src/maps/ride-graph'
import { clearCaltransCache, parseChainCode, type OfficialEvent } from '../src/maps/official/caltrans'
import { chainMeaning, officialClosuresFor, statesOutside } from '../src/agent/tools/official'

const raw = (name: string) => readFileSync(join(__dirname, 'fixtures', 'caltrans', name), 'utf8')
const NOW = new Date('2026-11-01T20:00:00Z') // noon Pacific

type Pt = [string, number, number]
const US50: Pt[] = [
  ['Placerville', -120.799, 38.7303],
  ['Camino', -120.71225, 38.73694],
  ['Riverton', -120.470669, 38.774111],
  ['Kyburz', -120.167161, 38.789049],
  ['Strawberry', -120.14841, 38.79514],
  ['Twin Bridges', -120.12281, 38.81135],
  ['Echo Summit', -120.02966, 38.81311],
  ['Meyers', -119.99, 38.85],
]
const NEVADA: Pt[] = [
  ['Reno', -119.81, 39.53],
  ['Fernley', -119.25, 39.61],
  ['Winnemucca', -117.74, 40.97],
]

function route(uid: string, pts: Pt[], startAt: string | null = null) {
  return {
    uid,
    title: uid,
    startAt,
    points: pts.map(([name, lng, lat], i) => ({
      uid: `${uid.slice(0, 6)}p${i}`,
      kind: 'stop',
      name,
      lng,
      lat,
      roles: [],
    })),
    legs: pts.slice(1).map((p, i) => ({
      geometry: [
        [pts[i][1], pts[i][2]],
        [p[1], p[2]],
      ],
      distanceM: 10_000,
      durationS: 600,
      viaPoints: [],
    })),
  }
}

const ride = (...routes: ReturnType<typeof route>[]): RidePayload => ridePayload.parse({ title: 'Tahoe', routes })

const ctx = (r: RidePayload, vehicle: 'motorcycle' | 'car' | 'bicycle' = 'motorcycle') =>
  ({
    ride: r,
    snapshot: { kind: 'saved', rev: 1, pending: 0 },
    units: 'mi',
    preset: { vehicle, power: 'gas', vehicleFromRide: true, powerFromRide: true },
    progress: () => {},
  }) as unknown as Parameters<typeof officialClosuresFor>[0]

const feeds = vi.fn(async (url: string) => {
  if (url.endsWith('/d3/cc/ccStatusD03.json')) return new Response(raw('ccStatusD03.json'))
  if (url.endsWith('/d3/lcs/lcsStatusD03.json')) return new Response(raw('lcsStatusD03.json'))
  return new Response('{"data":[]}')
})

beforeEach(() => {
  clearCaltransCache()
  vi.stubGlobal('fetch', feeds)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('chainMeaning', () => {
  const ev = (code: string) => ({ chain: parseChainCode(code) }) as OfficialEvent
  it('a chain requirement grounds a motorcycle and a bicycle, and a car follows the code', () => {
    for (const code of ['R-1', 'R-1 MODIFIED', 'R-2', 'R-3']) {
      expect(chainMeaning(ev(code), 'motorcycle')).toContain('a motorcycle does not go')
      expect(chainMeaning(ev(code), 'bicycle')).toContain('not a road to ride a bicycle on')
      expect(chainMeaning(ev(code), 'car')).toContain('A car follows the code.')
    }
    expect(chainMeaning(ev('R-3'), 'car')).toContain('all vehicles, no exceptions')
  })
  it('never reads an unknown or unreported status as clear', () => {
    expect(chainMeaning(ev('-118.1307759'), 'motorcycle')).toContain('unknown, not clear')
    expect(chainMeaning(ev('Not Reported'), 'car')).toContain('unknown, not clear')
    expect(chainMeaning(ev('W'), 'motorcycle')).toContain('snow possible on the road')
    // Winter at the chain check point grounds two wheels, whatever the cars are told.
    for (const code of ['VM', 'TH', 'TTA'])
      expect(chainMeaning(ev(code), 'motorcycle'), code).toContain('a motorcycle does not go')
    expect(chainMeaning(ev('VM'), 'car')).not.toContain('does not go')
    expect(chainMeaning(ev('ROAD CLOSED'), 'car')).toBe('closed to traffic.')
  })
})

describe('get_official_closures', () => {
  it('fetches only the districts the route passes through, and lists what is on its line', async () => {
    const text = await officialClosuresFor(ctx(ride(route('routeus50001', US50))), undefined, NOW)
    const urls = feeds.mock.calls.map((c) => c[0]).sort()
    expect(urls).toEqual([
      'https://cwwp2.dot.ca.gov/data/d10/cc/ccStatusD10.json',
      'https://cwwp2.dot.ca.gov/data/d10/lcs/lcsStatusD10.json',
      'https://cwwp2.dot.ca.gov/data/d3/cc/ccStatusD03.json',
      'https://cwwp2.dot.ca.gov/data/d3/lcs/lcsStatusD03.json',
    ])
    expect(text).toContain('Caltrans districts read: 3, 10.')
    expect(text).toContain('R-2 at “Riverton” (US-50 westbound)')
    expect(text).toContain('a motorcycle does not go over this until it clears')
    expect(text).toContain('[official: Caltrans CWWP2, as of 2026-11-01T10:15-08:00, checked 2026-11-01T12:00-08:00]')
    expect(text).toContain('R-1 MODIFIED at “Twin Bridges”')
    expect(text).toContain('VM at “Echo Summit (Holding only)”')
    expect(text).toContain('No chain controls in effect (R-0) at 1 point: “Camino Heights” (US-50)')
    expect(text).not.toContain('Luther Pass') // eight kilometers off the line
    expect(text).toContain('“31 Milestone Tract to Forni Tract”')
    expect(text).toContain('(in place now)')
    expect(text).not.toContain('25th Ave') // I-5 in Sacramento
    expect(text).not.toContain('C50KB-0003') // canceled
    expect(text).toContain('1 Caltrans item in these districts had no coordinates')
    expect(text).not.toContain('UNKNOWN')
  })

  it('says a route with an undrawn leg was only partly checked', async () => {
    const r = route('routeus50001', US50)
    r.legs[0].durationS = 0
    const text = await officialClosuresFor(ctx(ride(r)), undefined, NOW)
    expect(text).toContain('INCOMPLETE: 1 leg is not drawn yet')
  })

  it('says once, and only once, that nothing listed is not proof a road is open', async () => {
    const text = await officialClosuresFor(
      ctx(ride(route('routeus50001', US50), route('routeus50002', US50))),
      undefined,
      NOW,
    )
    expect(text.match(/None of this proves a road is open/g)).toHaveLength(1)
  })

  it('reads a chain control for a car as the code', async () => {
    const text = await officialClosuresFor(ctx(ride(route('routeus50001', US50)), 'car'), undefined, NOW)
    expect(text).toContain('planned for a car')
    expect(text).toContain('A car follows the code.')
    expect(text).not.toContain('does not go')
  })

  it('narrows closures to the route’s own date, and says a future date is current conditions', async () => {
    const text = await officialClosuresFor(
      ctx(ride(route('routeus50001', US50, '2026-11-03T08:00:00.000Z'))),
      undefined,
      NOW,
    )
    expect(text).toContain('Closures scheduled on this route’s date, 2026-11-03')
    expect(text).toContain('not a forecast for this route’s date, 2026-11-03')
    // Milestone to Forni runs the night of the 2nd into the 3rd; the Bedford Ave
    // closure is the night of the 1st only in the fixture.
    expect(text).toContain('“31 Milestone Tract to Forni Tract”')
    expect(text).not.toContain('Bedford Ave to Sly Park Rd')
    expect(text).toMatch(/1 more closure on this line falls? outside this route’s date/)
  })

  it('says a date beyond the feed’s week is not published yet', async () => {
    const text = await officialClosuresFor(
      ctx(ride(route('routeus50001', US50, '2026-12-20T08:00:00.000Z'))),
      undefined,
      NOW,
    )
    expect(text).toContain('beyond the roughly 7 days Caltrans lists closures ahead')
    expect(text).not.toContain('None listed')
  })

  it('says an outage is unknown with when it was last checked, never “no closures”', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      }),
    )
    const text = await officialClosuresFor(ctx(ride(route('routeus50001', US50))), undefined, NOW)
    expect(text).toContain(
      'UNKNOWN: Lane closures for Caltrans District 3 could not be read (timed out after 8 seconds, tried 2026-11-01 12:00 PT); not read successfully since this server started. That is unknown, not “no closures”.',
    )
    expect(text).toContain('UNKNOWN: Chain controls for Caltrans District 10')
    expect(text).not.toContain('None listed')
    expect(text).not.toContain('No chain-control point sits')
  })

  it('names the last good read when a feed that answered stops answering', async () => {
    await officialClosuresFor(ctx(ride(route('routeus50001', US50))), undefined, NOW)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 503 })),
    )
    const later = new Date(NOW.getTime() + 6 * 60_000)
    const text = await officialClosuresFor(ctx(ride(route('routeus50001', US50))), undefined, later)
    expect(text).toContain('(HTTP 503, tried 2026-11-01 12:06 PT); last checked successfully at 2026-11-01 12:00 PT.')
  })

  it('outside California, fetches nothing and names the state’s own page', async () => {
    const text = await officialClosuresFor(ctx(ride(route('routenevada1', NEVADA))), undefined, NOW)
    expect(feeds).not.toHaveBeenCalled()
    expect(text).toContain('This route does not enter California')
    expect(text).toContain('Nevada: NVroads (nvroads.com)')
    expect(text).toContain('None of this proves a road is open')
  })

  it('names every neighbor a route touches, and a generic page for anywhere else', () => {
    expect(statesOutside([[-122.68, 45.52]]).states.map((s) => s.name)).toEqual(['Oregon']) // Portland
    // Vancouver, Washington, sits where the two boxes overlap: both are named.
    expect(statesOutside([[-122.66, 45.64]]).states.map((s) => s.name)).toEqual(['Oregon', 'Washington'])
    expect(statesOutside([[-105.0, 39.74]]).states.map((s) => s.name)).toEqual(['Colorado'])
    expect(statesOutside([[-97.74, 30.27]])).toEqual({ states: [], unlisted: true })
    expect(statesOutside([[-120.0297, 38.8131]])).toEqual({ states: [], unlisted: false })
  })

  it('reads one route by uid, and refuses one that is not there', async () => {
    const r = ride(route('routeus50001', US50), route('routenevada1', NEVADA))
    const text = await officialClosuresFor(ctx(r), 'routenevada1', NOW)
    expect(text).toContain('Route 2 [routenevada1]')
    expect(text).not.toContain('Route 1 [')
    expect(await officialClosuresFor(ctx(r), 'nope', NOW)).toBe('No route with uid nope.')
  })
})
