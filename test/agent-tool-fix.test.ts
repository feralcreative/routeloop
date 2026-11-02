// The first two fix tools (#459): set_route_preferences redraws every leg of a route
// or changes nothing, refuses a route too long for one call before anything moves,
// and is rolled back when the router cannot finish; set_stop_by_time takes a strict
// 24-hour wall clock or null.
import { beforeEach, describe, expect, it, vi } from 'vitest'

// NEVER THE REAL ROUTER: each test sets what the next routing pass reports, and the
// mock records which legs it was asked to draw.
const routing = vi.hoisted(() => ({
  next: { routed: 0, skipped: 0, failed: 0 },
  calls: [] as { route: number; leg: number }[][],
}))
vi.mock('../src/agent/legs', () => ({
  routeStale: async (_ride: unknown, stale: { route: number; leg: number }[]) => {
    routing.calls.push(stale)
    return routing.next
  },
}))

import { ridePayload, type RidePayload } from '../src/maps/ride-graph'
import { Budget } from '../src/agent/budget'
import { EditError, setStopBy } from '../src/agent/ride-edit'
import type { AgentContext, Tool } from '../src/agent/tools'
import { MAX_PREF_LEGS, setRoutePreferences, setStopByTime } from '../src/agent/tools/fix'
import { TURN_LIMITS } from '../src/agent/policy'

const pt = (uid: string, lng: number, lat: number) => ({
  kind: 'stop' as const,
  lat,
  lng,
  name: uid,
  address: null,
  description: '',
  roles: [],
  durationMin: null,
  slackMin: null,
  uid,
  details: null,
})

/** A route of `n` points in a line, with real-looking legs between them. */
function route(uid: string, n: number) {
  const points = Array.from({ length: n }, (_, i) =>
    pt(`${uid.slice(0, 9)}p${String(i).padStart(2, '0')}`, -122 + i * 0.01, 37),
  )
  const legs = points.slice(1).map((b, i) => ({
    geometry: [
      [points[i].lng, points[i].lat],
      [b.lng, b.lat],
    ],
    distanceM: 900,
    durationS: 60,
    viaPoints: i === 0 ? [[-121.995, 37.001]] : [],
  }))
  return { uid, title: 'Coast', points, legs }
}

function fixture(n = 4): RidePayload {
  return ridePayload.parse({ title: 'Coast run', routes: [route('route0000001', n)] })
}

const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
  ride: fixture(),
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
  ...over,
})

/** Runs a tool the way runTool does: parse, the call's ceiling, then run(), with the
 *  ride restored if it throws. runTool itself is not used because these tools are
 *  wired into TOOLS separately. */
type AnyTool = Pick<Tool, 'schema' | 'cap'> & { run: (c: AgentContext, input: never) => Promise<string> }

async function call(
  c: AgentContext,
  t: AnyTool,
  raw: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const parsed = t.schema.safeParse(raw)
  if (!parsed.success) return { text: parsed.error.issues.map((i) => i.message).join('; '), isError: true }
  const before = structuredClone(c.ride)
  c.budget.beginCall(t.cap.spends)
  try {
    return {
      text: await (t.run as (c: AgentContext, input: unknown) => Promise<string>)(c, parsed.data),
      isError: false,
    }
  } catch (err) {
    c.ride = before
    if (err instanceof EditError) return { text: err.message, isError: true }
    throw err
  }
}

beforeEach(() => {
  routing.next = { routed: 0, skipped: 0, failed: 0 }
  routing.calls = []
})

describe('set_route_preferences', () => {
  it('declares an edit that may spend one turn’s routing allowance', () => {
    expect(MAX_PREF_LEGS).toBe(TURN_LIMITS.legRoutings)
    expect(setRoutePreferences.cap).toEqual({
      mutates: true,
      destructive: true,
      needs: 'edit',
      spends: { leg: MAX_PREF_LEGS },
    })
  })

  it('sets the preferences and marks every leg of the route for routing', async () => {
    const c = ctx()
    const out = await call(c, setRoutePreferences, { route_uid: 'route0000001', avoid_highways: true })
    expect(out.isError).toBe(false)
    expect(c.ride.routes[0].routePrefs).toEqual({ avoidHighways: true })
    expect(routing.calls).toEqual([
      [
        { route: 0, leg: 0 },
        { route: 0, leg: 1 },
        { route: 0, leg: 2 },
      ],
    ])
    expect(c.changed).toBe(true)
    expect(out.text).toMatch(/Avoiding highways/)
    expect(out.text).toMatch(/all 3 legs/)
    // The rider's shaping is kept for the router to honor.
    expect(c.ride.routes[0].legs[0].viaPoints).toEqual([[-121.995, 37.001]])
  })

  it('keeps flags it was not given and normalizes all-off to null', async () => {
    const c = ctx()
    c.ride.routes[0].routePrefs = { avoidTolls: true }
    await call(c, setRoutePreferences, { route_uid: 'route0000001', prefer_twisty: true })
    expect(c.ride.routes[0].routePrefs).toEqual({ avoidTolls: true, preferTwisty: true })
    await call(c, setRoutePreferences, { route_uid: 'route0000001', avoid_tolls: false, prefer_twisty: false })
    expect(c.ride.routes[0].routePrefs).toBeNull()
  })

  it('changes nothing and routes nothing when the preferences already hold', async () => {
    const c = ctx()
    const out = await call(c, setRoutePreferences, { route_uid: 'route0000001', avoid_ferries: false })
    expect(out.isError).toBe(false)
    expect(out.text).toMatch(/nothing changed/)
    expect(routing.calls).toEqual([])
    expect(c.changed).toBe(false)
  })

  it(`refuses a route of more than ${MAX_PREF_LEGS} legs before anything changes`, async () => {
    const c = ctx({ ride: fixture(MAX_PREF_LEGS + 2) })
    const before = JSON.stringify(c.ride)
    const out = await call(c, setRoutePreferences, { route_uid: 'route0000001', avoid_tolls: true })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(new RegExp(`${MAX_PREF_LEGS + 1} legs`))
    expect(out.text).toMatch(/builder/)
    expect(routing.calls).toEqual([])
    expect(JSON.stringify(c.ride)).toBe(before)
  })

  it('accepts a route of exactly the limit', async () => {
    const c = ctx({ ride: fixture(MAX_PREF_LEGS + 1) })
    const out = await call(c, setRoutePreferences, { route_uid: 'route0000001', avoid_tolls: true })
    expect(out.isError).toBe(false)
    expect(routing.calls[0]).toHaveLength(MAX_PREF_LEGS)
  })

  it('is refused and rolled back when the router fails', async () => {
    routing.next = { routed: 1, skipped: 0, failed: 2 }
    const c = ctx()
    const before = JSON.stringify(c.ride)
    const out = await call(c, setRoutePreferences, { route_uid: 'route0000001', avoid_highways: true })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/not made/)
    expect(JSON.stringify(c.ride)).toBe(before)
  })

  it('is refused and rolled back when the routing budget runs out', async () => {
    routing.next = { routed: 1, skipped: 2, failed: 0 }
    const c = ctx()
    const before = JSON.stringify(c.ride)
    const out = await call(c, setRoutePreferences, { route_uid: 'route0000001', prefer_twisty: true })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/budget/)
    expect(JSON.stringify(c.ride)).toBe(before)
  })

  it('refuses an unknown route and an unknown flag', async () => {
    const c = ctx()
    expect((await call(c, setRoutePreferences, { route_uid: 'nope', avoid_tolls: true })).isError).toBe(true)
    expect((await call(c, setRoutePreferences, { route_uid: 'route0000001', prefer_scenic: true })).isError).toBe(true)
  })
})

describe('set_stop_by_time', () => {
  it('declares an edit that spends nothing', () => {
    expect(setStopByTime.cap).toEqual({ mutates: true, destructive: true, needs: 'edit' })
  })

  it('sets the stop-by time as minutes from midnight, unconverted', async () => {
    const c = ctx()
    const out = await call(c, setStopByTime, { local_time: '16:30' })
    expect(out.isError).toBe(false)
    expect(c.ride.stopByMin).toBe(16 * 60 + 30)
    expect(out.text).toBe('Stop-by time set to 16:30.')
    expect(c.changed).toBe(true)
    expect(ridePayload.safeParse(c.ride).success).toBe(true)
  })

  it('clears it with null', async () => {
    const c = ctx()
    c.ride.stopByMin = 960
    const out = await call(c, setStopByTime, { local_time: null })
    expect(c.ride.stopByMin).toBeNull()
    expect(out.text).toBe('Stop-by time cleared.')
  })

  it('reports no change when the time is already set', async () => {
    const c = ctx()
    c.ride.stopByMin = 960
    const out = await call(c, setStopByTime, { local_time: '16:00' })
    expect(out.text).toMatch(/already 16:00/)
    expect(c.changed).toBe(false)
  })

  it.each(['4pm', '4:00', '24:00', '16:60', '16:00:00', ' 16:00', '', 'T16:00'])('refuses %j', async (bad) => {
    const c = ctx()
    const out = await call(c, setStopByTime, { local_time: bad })
    expect(out.isError).toBe(true)
    expect(c.ride.stopByMin).toBeNull()
  })

  it('is strict in ride-edit too, for any caller that skips the schema', () => {
    const ride = fixture()
    expect(() => setStopBy(ride, '7:5')).toThrow(EditError)
    setStopBy(ride, '00:00')
    expect(ride.stopByMin).toBe(0)
    setStopBy(ride, '23:59')
    expect(ride.stopByMin).toBe(1439)
  })
})
