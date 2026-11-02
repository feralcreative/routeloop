// propose_meeting_points: the Groups panel's Find meeting points, for the assistant.
//
// NO NETWORK. Places and Routes are both mocked, and the key is a stand-in, so
// nothing here can bill Google from a laptop that has a real one.
//
// What is pinned: a two-group ride answered with candidates on the main group's
// road, a station preferred and named, the refusals (one group, no road for the
// main group), every billed request charged to the budget, a spent budget making
// no request at all and saying so, and the shared service answering in the shape
// the builder's panel reads.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const places = vi.hoisted(() => ({ fn: vi.fn() }))
const routing = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../src/maps/places', async (orig) => ({
  ...((await orig()) as object),
  searchPlaces: (...args: unknown[]) => places.fn(...args),
}))
vi.mock('../src/routes/routing', async (orig) => ({
  ...((await orig()) as object),
  fetchRouteLeg: (...args: unknown[]) => routing.fn(...args),
  cachedRouteLeg: () => null,
}))
vi.mock('../src/config', async (orig) => ({ ...((await orig()) as object), GMAPS_SERVER_KEY: 'test-key' }))

import { ridePayload, type RidePayload } from '../src/maps/ride-graph'
import { haversineM, trackMeters, type Track } from '../src/maps/kml'
import { Budget } from '../src/agent/budget'
import { DAILY_GOOGLE_CALLS, TURN_LIMITS } from '../src/agent/policy'
import type { AgentContext } from '../src/agent/tools'
import { MEET_MAX_LEGS, MEET_MAX_SEARCHES, proposeMeetingPointsTool } from '../src/agent/tools/meet'
import { proposeMeetingPoints } from '../src/subgroups/propose'

const pt = (uid: string, lng: number, lat: number, name = uid) => ({
  kind: 'stop' as const,
  lat,
  lng,
  name,
  address: null,
  description: '',
  roles: [],
  durationMin: null,
  slackMin: null,
  uid,
  details: null,
})

/** A straight line with a vertex every 0.01 degrees, so the proposer has road to sample. */
function line(a: [number, number], b: [number, number]): Track {
  const n = Math.max(2, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / 0.01))
  const out: Track = []
  for (let i = 0; i <= n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n])
  return out
}

const legOf = (g: Track) => ({ geometry: g, distanceM: Math.round(trackMeters(g)), durationS: 3600, viaPoints: [] })

// The main group rides due north on the 122nd meridian, about 69 miles. The second
// group has only a starting point, about three miles east of the road.
const MAIN_ROAD = line([-122, 37], [-122, 38])
const SAT_START: [number, number] = [-121.95, 37.3]

function ride(over: Partial<{ groups: number; mainDrawn: boolean }> = {}): RidePayload {
  const groups = over.groups ?? 2
  const mainDrawn = over.mainDrawn ?? true
  const subgroups = [
    { uid: 'gmain', name: 'Oakland crew' },
    { uid: 'gsat', name: 'Santa Cruz lot' },
  ].slice(0, groups)
  const routes = [
    {
      uid: 'routeMain001',
      title: 'North',
      subgroupUid: 'gmain',
      points: mainDrawn ? [pt('pmainstart01', -122, 37), pt('pmainend0001', -122, 38)] : [pt('pmainstart01', -122, 37)],
      legs: mainDrawn ? [legOf(MAIN_ROAD)] : [],
    },
  ]
  if (groups > 1)
    routes.push({
      uid: 'routeSat0001',
      title: 'Approach',
      subgroupUid: 'gsat',
      points: [pt('psatstart001', SAT_START[0], SAT_START[1])],
      legs: [],
    })
  return ridePayload.parse({ title: 'Meet-up', subgroups, primarySubgroup: 'gmain', routes })
}

const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
  ride: ride(),
  role: 'edit',
  snapshot: { kind: 'draft' },
  units: 'mi',
  budget: new Budget(0),
  favor: [],
  avoid: [],
  includeDetails: false,
  changes: [],
  progress: () => {},
  changed: false,
  fuel: { rangeM: null, role: 'gas', bindingBike: null, riders: 3, unknown: 3 },
  ...over,
})

/** Runs the tool the way runTool does: the call's ceiling first, then run(). */
async function run(c: AgentContext, input: { max_detour_mi?: number } = {}) {
  c.budget.beginCall(proposeMeetingPointsTool.cap.spends)
  return proposeMeetingPointsTool.run(c, input)
}

const STATION = {
  name: 'Meridian Gas',
  address: '1 Meridian Rd',
  lngLat: [-122.0005, 37.45] as [number, number],
  type: 'gas_station',
}
const GROCER = { name: 'Gas & Groceries', address: '2 Meridian Rd', lngLat: [-122, 37.5], type: 'supermarket' }

beforeEach(() => {
  places.fn.mockReset()
  routing.fn.mockReset()
  places.fn.mockResolvedValue({ ok: true, places: [STATION, GROCER] })
  // Every request answers with a straight road 20% longer than the crow flies.
  routing.fn.mockImplementation(async (a: [number, number], b: [number, number]) => {
    const geometry = line(a, b)
    return {
      ok: true,
      leg: { geometry, distanceM: Math.round(haversineM(a[1], a[0], b[1], b[0]) * 1.2), durationS: 600 },
    }
  })
})

describe('propose_meeting_points', () => {
  it('declares ceilings that fit inside one turn', () => {
    expect(proposeMeetingPointsTool.cap).toEqual({
      mutates: false,
      needs: 'edit',
      spends: { search: MEET_MAX_SEARCHES, leg: MEET_MAX_LEGS },
    })
    expect(MEET_MAX_SEARCHES).toBe(6)
    expect(MEET_MAX_LEGS).toBe(18)
    expect(MEET_MAX_SEARCHES).toBeLessThanOrEqual(TURN_LIMITS.placeSearches)
    expect(MEET_MAX_LEGS).toBeLessThanOrEqual(TURN_LIMITS.legRoutings)
  })

  it('answers a two-group ride with candidates on the main road, a station named, and says it only proposes', async () => {
    const out = await run(ctx(), { max_detour_mi: 50 })
    expect(out).toContain('the road of the main group "Oakland crew"')
    expect(out).toContain('Group "Santa Cruz lot" [gsat]:')
    expect(out).toMatch(/ {2}1\. /)
    expect(out).toContain('"Meridian Gas", "1 Meridian Rd" · a gas station, a fuel stop')
    // A supermarket that mentions gas is never offered: stations are matched by type.
    expect(out).not.toContain('Gas & Groceries')
    expect(out).toContain('These are proposals only; nothing was added to the ride.')
    expect(out).toContain('Find meeting points')
    expect(out).toContain('Nobody on the ride has a fuel range on file')
  })

  it('charges every billed request to the budget and stays inside its ceilings', async () => {
    const c = ctx()
    await run(c, { max_detour_mi: 50 })
    expect(places.fn).toHaveBeenCalled()
    expect(routing.fn).toHaveBeenCalled()
    expect(c.budget.searches).toBe(places.fn.mock.calls.length)
    expect(c.budget.legs).toBe(routing.fn.mock.calls.length)
    expect(c.budget.searches).toBeLessThanOrEqual(MEET_MAX_SEARCHES)
    expect(c.budget.legs).toBeLessThanOrEqual(MEET_MAX_LEGS)
  })

  it('refunds a cached answer, because Google was not asked', async () => {
    places.fn.mockResolvedValue({ ok: true, places: [STATION], cached: true })
    const c = ctx()
    await run(c, { max_detour_mi: 50 })
    expect(places.fn).toHaveBeenCalled()
    expect(c.budget.searches).toBe(0)
  })

  it('makes no request on a spent budget and says what it could not look for', async () => {
    const c = ctx({ budget: new Budget(DAILY_GOOGLE_CALLS) })
    const out = await run(c, { max_detour_mi: 50 })
    expect(places.fn).not.toHaveBeenCalled()
    expect(routing.fn).not.toHaveBeenCalled()
    expect(c.budget.googleCalls).toBe(0)
    expect(out).toContain('budget for this turn (or today) ran out')
    expect(out).toContain('Do not')
  })

  it('stops at the call’s own ceiling', async () => {
    const c = ctx()
    c.budget.beginCall({ search: 1, leg: 1 })
    await proposeMeetingPointsTool.run(c, { max_detour_mi: 50 })
    expect(places.fn.mock.calls.length).toBeLessThanOrEqual(1)
    expect(routing.fn.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('refuses a ride with one group, spending nothing', async () => {
    const c = ctx({ ride: ride({ groups: 1 }) })
    const out = await run(c)
    expect(out).toContain('one group, so there is nobody to meet')
    expect(places.fn).not.toHaveBeenCalled()
    expect(routing.fn).not.toHaveBeenCalled()
  })

  it('refuses when the main group has no road drawn, naming the group', async () => {
    const out = await run(ctx({ ride: ride({ mainDrawn: false }) }))
    expect(out).toContain('The main group "Oakland crew" has no road drawn yet')
    expect(places.fn).not.toHaveBeenCalled()
  })

  it('searches for nothing on a pedal ride', async () => {
    const c = ctx({ fuel: { rangeM: null, role: null, bindingBike: null, riders: 3, unknown: 3 } })
    const out = await run(c, { max_detour_mi: 50 })
    expect(places.fn).not.toHaveBeenCalled()
    expect(out).not.toContain('fuel range on file')
  })
})

describe('proposeMeetingPoints, the shared service', () => {
  it('answers in the shape the builder’s panel reads, with no budget', async () => {
    const out = await proposeMeetingPoints(ride(), {
      fuel: async () => ({ role: 'gas' as const, rangeMi: null }),
      maxDivertMi: 50,
      favor: [],
      avoid: [],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.groups).toHaveLength(1)
    const p = out.groups[0].proposal
    expect(Object.keys(p).sort()).toEqual(['candidates', 'group', 'name', 'note', 'reason'])
    expect(p.group).toBe('gsat')
    expect(p.candidates.length).toBeGreaterThan(0)
    expect(Object.keys(p.candidates[0]).sort()).toEqual(
      ['address', 'alongM', 'approach', 'diverts', 'isFuel', 'lat', 'lng', 'name', 'sharedPct', 'worstDivertMi'].sort(),
    )
    expect(out.groups[0].searchLimited).toBe(false)
    expect(out.groups[0].legLimited).toBe(false)
  })

  it('treats an unchosen alternate as absent, the way the panel does', async () => {
    const r = ride()
    r.routes[1].altGroup = 0
    r.routes[1].altActive = false
    r.routes[0].altGroup = 0
    r.routes[0].altActive = true
    const out = await proposeMeetingPoints(r, {
      fuel: async () => ({ role: 'gas' as const, rangeMi: null }),
      maxDivertMi: 50,
      favor: [],
      avoid: [],
    })
    // The satellite's only route is the losing alternate, so nobody is left to join.
    expect(out).toEqual({ ok: false, reason: 'no-routes' })
  })
})
