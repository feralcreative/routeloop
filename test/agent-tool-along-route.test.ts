// find_along_route: the assistant's Along the route search.
//
// NO NETWORK. Places is mocked so every search answers from a fixture, and the key
// is a stand-in, so nothing here can bill Google from a laptop that has a real one.
//
// What is pinned: a whole route searched within the budget, a budget-shortened
// search that names the stretches it did not reach (and never reads as "nothing
// there"), a failed request reported the same way, the corridor filter, the
// de-duplication of overlapping circles, the spread across a long list, and that
// cached answers are refunded.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const places = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../src/maps/places', async (orig) => ({
  ...((await orig()) as object),
  searchPlaces: (...args: unknown[]) => places.fn(...args),
}))
vi.mock('../src/config', async (orig) => ({ ...((await orig()) as object), GMAPS_SERVER_KEY: 'test-key' }))

import { ridePayload, type RidePayload } from '../src/maps/ride-graph'
import { METERS_PER_MILE, trackMeters, type Track } from '../src/maps/kml'
import { Budget } from '../src/agent/budget'
import { EditError } from '../src/agent/ride-edit'
import type { AgentContext } from '../src/agent/tools'
import { ALONG_ROUTE_MAX_SEARCHES, findAlongRoute, MAX_ALONG_RESULTS } from '../src/agent/tools/along-route'

const pt = (uid: string, lng: number, lat: number) => ({
  kind: 'stop' as const,
  lat,
  lng,
  name: uid.slice(0, 1).toUpperCase() + ' town',
  address: null,
  description: '',
  roles: [],
  durationMin: null,
  slackMin: null,
  uid,
  details: null,
})

// Due north on the 122nd meridian, 37N to 40N (about 207 miles), in two legs.
// Each leg carries intermediate vertices so a place projects onto a real segment.
const line = (from: number, to: number): [number, number][] => {
  const out: [number, number][] = []
  for (let lat = from; lat <= to + 1e-9; lat += 0.1) out.push([-122, Math.round(lat * 10) / 10])
  return out
}
const legOf = (g: [number, number][]) => ({
  geometry: g,
  distanceM: Math.round(trackMeters(g as Track)),
  durationS: 3600,
  viaPoints: [],
})

function ride(): RidePayload {
  return ridePayload.parse({
    title: 'North run',
    routes: [
      {
        uid: 'routeAAAAAAA',
        title: 'Day one',
        points: [pt('aaaaaaaaaaaa', -122, 37), pt('bbbbbbbbbbbb', -122, 38.5), pt('cccccccccccc', -122, 40)],
        legs: [legOf(line(37, 38.5)), legOf(line(38.5, 40))],
      },
      {
        uid: 'routeBBBBBBB',
        title: 'Undrawn',
        points: [pt('dddddddddddd', -121, 36)],
        legs: [],
      },
    ],
  })
}

const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
  ride: ride(),
  role: 'view',
  snapshot: { kind: 'draft' },
  units: 'mi',
  budget: new Budget(0),
  favor: [],
  avoid: [],
  includeDetails: false,
  changes: [],
  progress: () => {},
  changed: false,
  ...over,
})

/** Runs the tool the way runTool does: the call's ceiling first, then run(). */
async function run(c: AgentContext, input: { route_uid: string; query: string; corridor_mi?: number }) {
  c.budget.beginCall(findAlongRoute.cap.spends)
  return findAlongRoute.run(c, input)
}

const hit = (name: string, lng: number, lat: number, type: string | null = 'gas_station') => ({
  name,
  address: `${name} Rd`,
  lngLat: [lng, lat] as [number, number],
  type,
})

// A degree of longitude at 37.5N is about 88.3 km, so 0.18 is about 9.9 miles off
// the road and 0.73 about 40.
const ON_ROAD = hit('Roadside Gas', -122, 37.5)
const NEAR = hit('Ten Mile Fuel', -121.82, 37.5)
const FAR = hit('Far Away Gas', -121.27, 37.5)
const NORTH = hit('North Gas', -122, 39.5)

beforeEach(() => {
  places.fn.mockReset()
})

describe('find_along_route', () => {
  it('declares the search ceiling it is built to work within', () => {
    expect(findAlongRoute.cap).toEqual({ mutates: false, needs: 'view', spends: { search: ALONG_ROUTE_MAX_SEARCHES } })
    expect(ALONG_ROUTE_MAX_SEARCHES).toBeLessThanOrEqual(6)
  })

  it('searches the whole route, keeps the corridor, and de-duplicates the overlapping circles', async () => {
    // Every circle returns the same four places: what overlapping circles really do.
    places.fn.mockResolvedValue({ ok: true, places: [ON_ROAD, NEAR, FAR, NORTH] })
    const c = ctx()
    const out = await run(c, { route_uid: 'routeAAAAAAA', query: 'gas station' })

    expect(places.fn).toHaveBeenCalledTimes(6)
    for (const [req, key] of places.fn.mock.calls) {
      expect(key).toBe('test-key')
      expect(req.wide).toBe(true)
      expect(req.query).toBe('gas station')
      expect(req.radiusM).toBeLessThanOrEqual(50_000)
    }
    expect(c.budget.searches).toBe(6)
    expect(out).toContain('Coverage: the whole route was searched.')
    expect(out).not.toContain('PARTIAL')
    expect(out).toContain('3 places in the corridor')
    expect(out).not.toContain('Far Away Gas')
    // Once each, not once per circle.
    expect(out.match(/^\d+\. Roadside Gas,/gm)).toHaveLength(1)
    // In order from the start, with the coordinate format add_stop takes.
    expect(out.indexOf('Roadside Gas')).toBeLessThan(out.indexOf('North Gas'))
    expect(out).toContain('(lat 37.500000, lng -122.000000)')
    expect(out).toMatch(
      /Roadside Gas.*0\.0 mi off the road · about 35 mi along · between “A town” \[aaaaaaaaaaaa\] and “B town” \[bbbbbbbbbbbb\]/,
    )
    expect(out).toMatch(/Ten Mile Fuel.*9\.\d mi off the road/)
    expect(out).toMatch(
      /North Gas.*about 173 mi along · between “B town” \[bbbbbbbbbbbb\] and “C town” \[cccccccccccc\]/,
    )
  })

  it('narrows to the corridor it is given', async () => {
    places.fn.mockResolvedValue({ ok: true, places: [ON_ROAD, NEAR, FAR] })
    const out = await run(ctx(), { route_uid: 'routeAAAAAAA', query: 'gas station', corridor_mi: 5 })
    expect(out).toContain('1 place in the corridor')
    expect(out).toContain('Roadside Gas')
    expect(out).not.toContain('Ten Mile Fuel')
    expect(out).toContain('within 5 mi of the road')
  })

  it('a short budget means fewer, larger searches, and the stretches it missed are named', async () => {
    places.fn.mockResolvedValue({ ok: true, places: [] })
    const c = ctx()
    // Four of the turn's six searches already spent by earlier calls.
    for (let i = 0; i < 4; i++) expect(c.budget.take('search')).toBe(true)
    const out = await run(c, { route_uid: 'routeAAAAAAA', query: 'gas station' })

    expect(places.fn).toHaveBeenCalledTimes(2)
    // Each of the two reaches the proxy's 50 km limit: as wide as a search can go.
    for (const [req] of places.fn.mock.calls) expect(req.radiusM).toBe(50_000)
    expect(c.budget.searches).toBe(6)
    expect(out).toContain('2 searches')
    expect(out).toContain('Coverage: PARTIAL')
    expect(out).toMatch(/Not searched: 0–21 mi, 83–124 mi, 187–207 mi from the start/)
    expect(out).toContain('allowed only 2 searches')
    expect(out).toContain('unknown, not absent')
    // An empty answer on a partial search must not read as an empty road.
    expect(out).toContain('That says nothing about the stretches that were not.')
    expect(out).not.toContain('None found within 15 mi of this route.')
  })

  it('a spent budget searches nothing and says nothing is known', async () => {
    const c = ctx()
    for (let i = 0; i < 6; i++) c.budget.take('search')
    const out = await run(c, { route_uid: 'routeAAAAAAA', query: 'coffee' })
    expect(places.fn).not.toHaveBeenCalled()
    expect(out).toContain('nothing along')
    expect(out).toContain('Nothing is known')
  })

  it('a failed request is a stretch not searched, with the reason', async () => {
    let n = 0
    places.fn.mockImplementation(async () =>
      n++ === 2 ? { ok: false, error: 'unreachable' } : { ok: true, places: [ON_ROAD] },
    )
    const out = await run(ctx(), { route_uid: 'routeAAAAAAA', query: 'gas station' })
    expect(out).toContain('Coverage: PARTIAL')
    expect(out).toContain('1 search failed (Google could not be reached)')
    expect(out).toMatch(/Not searched: \d+–\d+ mi from the start/)
    expect(out).toContain('Roadside Gas')
  })

  it('every request failing is an error about knowledge, not an empty road', async () => {
    places.fn.mockResolvedValue({ ok: false, error: 'blocked' })
    const out = await run(ctx(), { route_uid: 'routeAAAAAAA', query: 'gas station' })
    expect(out).toContain('Every search along')
    expect(out).toContain('the server key is not allowed to use Places')
    expect(out).toContain('Nothing is known')
  })

  it('refunds answers that came from the cache', async () => {
    places.fn.mockResolvedValue({ ok: true, places: [ON_ROAD], cached: true })
    const c = ctx()
    await run(c, { route_uid: 'routeAAAAAAA', query: 'gas station' })
    expect(places.fn).toHaveBeenCalledTimes(6)
    expect(c.budget.searches).toBe(0)
  })

  it('shows at most twelve, spread along the route, and marks the rider’s lists', async () => {
    // Thirty stations, one every 0.1 degree up the road, all within the corridor.
    const many = Array.from({ length: 30 }, (_, i) => hit(`Station ${i}`, -122.01, 37.05 + i * 0.1))
    many[0] = hit('ARCO Station', -122.01, 37.05)
    many[29] = hit('Shell Station', -122.01, 37.05 + 29 * 0.1)
    places.fn.mockResolvedValue({ ok: true, places: many })
    const out = await run(ctx({ favor: ['shell'], avoid: ['arco'] }), {
      route_uid: 'routeAAAAAAA',
      query: 'gas station',
    })
    const listed = out.split('\n').filter((l) => /^\d+\. /.test(l))
    expect(listed).toHaveLength(MAX_ALONG_RESULTS)
    expect(out).toContain(`30 places in the corridor; ${MAX_ALONG_RESULTS} shown`)
    // Spread, not clustered: something from the first and the last stretch.
    const along = listed.map((l) => Number(/about (\d+) mi along/.exec(l)![1]))
    expect(Math.min(...along)).toBeLessThan(40)
    expect(Math.max(...along)).toBeGreaterThan(170)
    expect(along).toEqual([...along].sort((a, b) => a - b))
    expect(out).toMatch(/Shell Station.*\(on the rider’s favor list\)/)
  })

  it('a route with no road searches nothing', async () => {
    const out = await run(ctx(), { route_uid: 'routeBBBBBBB', query: 'gas station' })
    expect(places.fn).not.toHaveBeenCalled()
    expect(out).toContain('no road drawn yet')
  })

  it('an unknown route is a refusal the model can read', async () => {
    await expect(run(ctx(), { route_uid: 'nope', query: 'gas station' })).rejects.toBeInstanceOf(EditError)
  })

  it('never prints the track', async () => {
    places.fn.mockResolvedValue({ ok: true, places: [ON_ROAD] })
    const out = await run(ctx(), { route_uid: 'routeAAAAAAA', query: 'gas station' })
    // Vertices of the drawn line, which no place sits on.
    expect(out).not.toContain('37.100000')
    expect(out).not.toContain('38.300000')
    expect(out.length).toBeLessThan(2000)
  })

  it('validates its input', () => {
    const s = findAlongRoute.schema
    expect(s.safeParse({ route_uid: 'r', query: 'g' }).success).toBe(false)
    expect(s.safeParse({ route_uid: 'r', query: 'gas', corridor_mi: 31 }).success).toBe(false)
    expect(s.safeParse({ route_uid: 'r', query: 'gas', corridor_mi: 0.5 }).success).toBe(false)
    expect(s.safeParse({ route_uid: 'r', query: 'gas', extra: 1 }).success).toBe(false)
    expect(s.safeParse({ route_uid: 'r', query: 'gas', corridor_mi: 30 }).success).toBe(true)
    expect(METERS_PER_MILE).toBeGreaterThan(0)
  })
})
