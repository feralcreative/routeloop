// The rest of #459's fix tools: split_route cuts a route the way route-split.js does
// and routes nothing; reverse_route redraws every leg or changes nothing;
// choose_alternate flips the active member of a group; add_shaping_point puts a via
// in track order and redraws that one leg or changes nothing.
import { readFileSync } from 'node:fs'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { MAX_ROUTES, MAX_STOPS, ridePayload, type RidePayload } from '../src/maps/ride-graph'
import { Budget } from '../src/agent/budget'
import { EditError, MAX_VIAS_PER_LEG, nextMorningAfter, splitRoute, syncEnds } from '../src/agent/ride-edit'
import type { AgentContext, Tool } from '../src/agent/tools'
import {
  addShapingPoint,
  chooseAlternateTool,
  FIX_TOOLS,
  MAX_PREF_LEGS,
  reverseRouteTool,
  splitRouteTool,
} from '../src/agent/tools/fix'

let SPLIT: any
let CLOCK: any
beforeAll(() => {
  const win: any = {}
  new Function('window', readFileSync('public/js/route-split.js', 'utf8'))(win)
  SPLIT = win.TBSplit
  const cwin: any = {}
  new Function('window', readFileSync('public/js/route-clock.js', 'utf8'))(cwin)
  CLOCK = cwin.TBRouteClock
})

const pt = (uid: string, lng: number, lat: number, roles: string[] = []) => ({
  kind: 'stop' as const,
  lat,
  lng,
  name: uid,
  address: `${uid} St`,
  description: '',
  roles,
  durationMin: null,
  slackMin: null,
  uid,
  details: null,
})

/** A route of `n` points in a line along latitude 37, with real-looking legs. */
function route(uid: string, n: number, extra: Record<string, unknown> = {}) {
  const points = Array.from({ length: n }, (_, i) =>
    pt(
      `${uid.slice(-6)}pt${String(i).padStart(2, '0')}`,
      -122 + i * 0.01,
      37,
      i === 0 ? ['start'] : i === n - 1 ? ['finish'] : [],
    ),
  )
  const legs = points.slice(1).map((b, i) => ({
    geometry: [
      [points[i].lng, points[i].lat],
      [points[i].lng + 0.005, 37.001],
      [b.lng, b.lat],
    ],
    distanceM: 900,
    durationS: 600,
    viaPoints: i === 0 ? [[-121.995, 37.001]] : [],
  }))
  return { uid, title: 'Coast', points, legs, ...extra }
}

function fixture(routes = [route('route0000001', 4)]): RidePayload {
  return ridePayload.parse({ title: 'Coast run', routes })
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

type AnyTool = Pick<Tool, 'schema' | 'cap'> & { run: (c: AgentContext, input: never) => Promise<string> }

/** Runs a tool the way runTool does: parse, the call's ceiling, then run(), with the
 *  ride restored if it throws. */
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
    const text = await (t.run as (c: AgentContext, input: unknown) => Promise<string>)(c, parsed.data)
    // runTool's end-time hook.
    if (c.changed) syncEnds(c.ride, before)
    return { text, isError: false }
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

it('exports all six fix tools under distinct names', () => {
  const names = FIX_TOOLS.map((t) => t.name)
  expect(names).toEqual([
    'set_route_preferences',
    'set_stop_by_time',
    'split_route',
    'reverse_route',
    'choose_alternate',
    'add_shaping_point',
  ])
})

describe('split_route', () => {
  it('declares an edit that spends nothing', () => {
    expect(splitRouteTool.cap).toEqual({ mutates: true, destructive: true, needs: 'edit' })
  })

  it('cuts at a point, keeps every leg, and routes nothing', async () => {
    const c = ctx({ ride: fixture([route('route0000001', 5)]) })
    const orig = structuredClone(c.ride.routes[0])
    const out = await call(c, splitRouteTool, { route_uid: 'route0000001', point_uid: '000001pt02' })
    expect(out.isError).toBe(false)
    expect(routing.calls).toEqual([])
    expect(c.changed).toBe(true)
    const [a, b] = c.ride.routes
    expect(c.ride.routes).toHaveLength(2)
    expect(a.uid).toBe('route0000001')
    expect(a.points.map((p) => p.uid)).toEqual(orig.points.slice(0, 3).map((p) => p.uid))
    expect(a.legs).toEqual(orig.legs.slice(0, 2))
    expect(b.legs).toEqual(orig.legs.slice(2))
    expect(b.points.slice(1).map((p) => p.uid)).toEqual(orig.points.slice(3).map((p) => p.uid))
    expect(b.points[0]).toMatchObject({ kind: 'stop', roles: [], name: '000001pt02', lng: orig.points[2].lng })
    expect(b.points[0].uid).not.toBe('000001pt02')
    expect(b.uid).not.toBe(a.uid)
    expect(b.title).toBe('')
    expect(b.color).not.toBe(a.color)
    expect(b.startAt).toBeNull()
    expect(out.text).toContain(b.uid)
    expect(ridePayload.safeParse(c.ride).success).toBe(true)
  })

  it('matches route-split.js on everything route-split.js decides', () => {
    const ride = fixture([route('route0000001', 6)])
    const orig = structuredClone(ride.routes[0])
    let n = 0
    const js = SPLIT.splitRouteAt(orig, 3, () => `js${n++}`)
    splitRoute(ride, 'route0000001', orig.points[3].uid!)
    const [a, b] = ride.routes
    expect(a.points).toEqual(js.first.points)
    expect(a.legs).toEqual(js.first.legs)
    expect(b.legs).toEqual(js.second.legs)
    expect(b.points.slice(1)).toEqual(js.second.points.slice(1))
    const { uid: _a, address: _addr, slackMin: _s, details: _d, ...ours } = b.points[0]
    const { uid: _b, ...theirs } = js.second.points[0]
    expect(ours).toEqual(theirs)
    expect([b.title, b.altGroup, b.altActive, b.startAt, b.endAt]).toEqual([
      js.second.title,
      js.second.altGroup,
      js.second.altActive,
      js.second.startAt,
      js.second.endAt,
    ])
    // Where route-split.js refuses, so does this.
    for (const i of [0, 5]) {
      expect(SPLIT.canSplitAt(orig, i)).toBe(false)
      expect(() => splitRoute(fixture([route('route0000001', 6)]), 'route0000001', orig.points[i].uid!)).toThrow(
        EditError,
      )
    }
  })

  it('starts the new route the morning after the first one ends, as the builder does', async () => {
    // 3 legs of 600 s before the split plus 30 minutes at the second point: 09:00 + 60 min.
    const r = route('route0000001', 5, { startAt: '2026-08-01T09:00:00.000Z', endAt: '2026-08-01T10:10:00.000Z' })
    r.points[1].durationMin = 30 as never
    const c = ctx({ ride: fixture([r]) })
    await call(c, splitRouteTool, { route_uid: 'route0000001', point_uid: '000001pt03' })
    const [a, b] = c.ride.routes
    // The stored end was the derived one, so it is re-derived for the shorter route.
    expect(a.endAt).toBe('2026-08-01T10:00:00.000Z')
    expect(b.startAt).toBe('2026-08-02T08:00:00.000Z')
    // 600 s for the one leg left on the new route.
    expect(b.endAt).toBe('2026-08-02T08:10:00.000Z')
    expect(b.startAt).toBe(CLOCK.nextMorningAfter('2026-08-01T10:00:00.000Z', 8))
  })

  it('keeps an end the rider typed and starts from it', async () => {
    const r = route('route0000001', 5, { startAt: '2026-08-01T09:00:00.000Z', endAt: '2026-08-02T09:30:00.000Z' })
    const c = ctx({ ride: fixture([r]) })
    await call(c, splitRouteTool, { route_uid: 'route0000001', point_uid: '000001pt02' })
    expect(c.ride.routes[0].endAt).toBe('2026-08-02T09:30:00.000Z')
    expect(c.ride.routes[1].startAt).toBe('2026-08-03T08:00:00.000Z')
  })

  it('agrees with route-clock.js about the next morning', () => {
    for (const iso of ['2026-08-01T07:59:00.000Z', '2026-08-01T08:00:00.000Z', '2026-08-01T23:30:00.000Z', null]) {
      expect(nextMorningAfter(iso)).toBe(CLOCK.nextMorningAfter(iso, 8))
    }
  })

  it('refuses the first and last point and a full ride, changing nothing', async () => {
    const c = ctx()
    const before = JSON.stringify(c.ride)
    for (const p of ['000001pt00', '000001pt03']) {
      const out = await call(c, splitRouteTool, { route_uid: 'route0000001', point_uid: p })
      expect(out.isError).toBe(true)
      expect(out.text).toMatch(/first and last/)
    }
    expect(JSON.stringify(c.ride)).toBe(before)

    const full = fixture(Array.from({ length: MAX_ROUTES }, (_, k) => route(`route${String(k).padStart(7, '0')}`, 3)))
    const f = ctx({ ride: full })
    const out = await call(f, splitRouteTool, { route_uid: 'route0000000', point_uid: '000000pt01' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(new RegExp(`${MAX_ROUTES} routes`))
  })

  it('refuses a split whose new route would hold more than MAX_STOPS stops, changing nothing', () => {
    // MAX_STOPS stops, all after two POIs: the copy of the POI split point is one over.
    const r = route('route0000001', MAX_STOPS + 2)
    r.points.forEach((p, i) => {
      ;(p as { kind: string }).kind = i < 2 ? 'poi' : 'stop'
      p.roles = []
    })
    const ride = fixture([r])
    const before = JSON.stringify(ride)
    expect(() => splitRoute(ride, 'route0000001', r.points[1].uid!)).toThrow(new RegExp(`${MAX_STOPS} a route may`))
    expect(JSON.stringify(ride)).toBe(before)
    // At the next point along, a stop, the new route keeps its count.
    splitRoute(ride, 'route0000001', r.points[2].uid!)
    expect(ride.routes[1].points.filter((p) => p.kind === 'stop')).toHaveLength(MAX_STOPS)
    expect(ridePayload.safeParse(ride).success).toBe(true)
  })

  it('keeps a stop on the first route', () => {
    const r = route('route0000001', 4)
    r.points.forEach((p, i) => {
      ;(p as { kind: string }).kind = i === 3 ? 'stop' : 'poi'
      p.roles = []
    })
    const ride = fixture([r])
    splitRoute(ride, 'route0000001', '000001pt02')
    expect(ride.routes[0].points.some((p) => p.kind === 'stop')).toBe(true)
    expect(ridePayload.safeParse(ride).success).toBe(true)
  })

  it('drops the alternate grouping on the new route only', () => {
    const ride = fixture([
      route('route0000001', 4, { altGroup: 0, altActive: true }),
      route('route0000002', 4, { altGroup: 0, altActive: false }),
    ])
    splitRoute(ride, 'route0000001', '000001pt01')
    expect(ride.routes.map((r) => [r.altGroup, r.altActive])).toEqual([
      [0, true],
      [null, true],
      [0, false],
    ])
  })
})

describe('reverse_route', () => {
  it('declares an edit that may spend one turn’s routing allowance', () => {
    expect(reverseRouteTool.cap).toEqual({
      mutates: true,
      destructive: true,
      needs: 'edit',
      spends: { leg: MAX_PREF_LEGS },
    })
  })

  it('reverses the points, swaps start and finish, clears vias, and redraws every leg', async () => {
    const c = ctx()
    const orig = structuredClone(c.ride.routes[0])
    const out = await call(c, reverseRouteTool, { route_uid: 'route0000001' })
    expect(out.isError).toBe(false)
    const r = c.ride.routes[0]
    expect(r.points.map((p) => p.uid)).toEqual(orig.points.map((p) => p.uid).reverse())
    expect(r.points[0].roles).toEqual(['start'])
    expect(r.points[3].roles).toEqual(['finish'])
    expect(r.legs).toHaveLength(3)
    expect(r.legs.every((l) => l.viaPoints.length === 0)).toBe(true)
    expect(r.legs[0].geometry[0]).toEqual([r.points[0].lng, r.points[0].lat])
    expect(routing.calls).toEqual([
      [
        { route: 0, leg: 0 },
        { route: 0, leg: 1 },
        { route: 0, leg: 2 },
      ],
    ])
    expect(out.text).toMatch(/all 3 legs/)
    expect(out.text).toMatch(/cleared 1 shaping point/)
    expect(ridePayload.safeParse(c.ride).success).toBe(true)
  })

  it(`refuses a route of more than ${MAX_PREF_LEGS} legs before anything changes`, async () => {
    const c = ctx({ ride: fixture([route('route0000001', MAX_PREF_LEGS + 2)]) })
    const before = JSON.stringify(c.ride)
    const out = await call(c, reverseRouteTool, { route_uid: 'route0000001' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/builder/)
    expect(routing.calls).toEqual([])
    expect(JSON.stringify(c.ride)).toBe(before)
  })

  it('refuses a route of one point', async () => {
    const c = ctx({ ride: fixture([route('route0000001', 1)]) })
    const out = await call(c, reverseRouteTool, { route_uid: 'route0000001' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/nothing to reverse/)
  })

  it.each([
    [{ routed: 1, skipped: 0, failed: 2 }, /not made/],
    [{ routed: 1, skipped: 2, failed: 0 }, /budget/],
  ])('is refused and rolled back when the redraw cannot finish (%o)', async (next, msg) => {
    routing.next = next
    const c = ctx()
    const before = JSON.stringify(c.ride)
    const out = await call(c, reverseRouteTool, { route_uid: 'route0000001' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(msg)
    expect(JSON.stringify(c.ride)).toBe(before)
  })
})

describe('choose_alternate', () => {
  const alts = () =>
    fixture([
      route('route0000001', 3),
      route('route0000002', 3, { altGroup: 0, altActive: true }),
      route('route0000003', 3, { altGroup: 0, altActive: false }),
    ])

  it('needs edit, as the builder’s own switch does, and spends nothing', () => {
    expect(chooseAlternateTool.cap).toEqual({ mutates: true, destructive: true, needs: 'edit' })
  })

  it('makes the route the one active member of its group, in place', async () => {
    const c = ctx({ ride: alts() })
    const out = await call(c, chooseAlternateTool, { route_uid: 'route0000003' })
    expect(out.isError).toBe(false)
    expect(c.ride.routes.map((r) => [r.uid, r.altGroup, r.altActive])).toEqual([
      ['route0000001', null, true],
      ['route0000002', 0, false],
      ['route0000003', 0, true],
    ])
    expect(c.changed).toBe(true)
    expect(routing.calls).toEqual([])
  })

  it('reports no change for the route already ridden', async () => {
    const c = ctx({ ride: alts() })
    const out = await call(c, chooseAlternateTool, { route_uid: 'route0000002' })
    expect(out.isError).toBe(false)
    expect(out.text).toMatch(/already/)
    expect(c.changed).toBe(false)
  })

  it('refuses a route that is not one of a set of alternatives', async () => {
    const c = ctx({ ride: alts() })
    const before = JSON.stringify(c.ride)
    const out = await call(c, chooseAlternateTool, { route_uid: 'route0000001' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/not one of a set of alternatives/)
    expect(JSON.stringify(c.ride)).toBe(before)
  })
})

describe('add_shaping_point', () => {
  it('declares an edit that may route one leg', () => {
    expect(addShapingPoint.cap).toEqual({ mutates: true, needs: 'edit', spends: { leg: 1 } })
  })

  it('requires a source and refuses any other', async () => {
    const c = ctx()
    const base = { route_uid: 'route0000001', from_point_uid: '000001pt01', lat: 37.002, lng: -121.985 }
    expect((await call(c, addShapingPoint, base)).isError).toBe(true)
    expect((await call(c, addShapingPoint, { ...base, source: 'guess' })).isError).toBe(true)
    expect(routing.calls).toEqual([])
  })

  it('adds a via to the leg leaving the point and redraws only that leg', async () => {
    const c = ctx()
    const out = await call(c, addShapingPoint, {
      route_uid: 'route0000001',
      from_point_uid: '000001pt01',
      lat: 37.0021234567,
      lng: -121.985,
      source: 'search',
    })
    expect(out.isError).toBe(false)
    const { legs, points } = c.ride.routes[0]
    expect(legs[1].viaPoints).toEqual([[-121.985, 37.002123]])
    expect(legs[1].geometry).toEqual([
      [points[1].lng, points[1].lat],
      [-121.985, 37.002123],
      [points[2].lng, points[2].lat],
    ])
    expect(routing.calls).toEqual([[{ route: 0, leg: 1 }]])
    expect(out.text).toMatch(/now has 1/)
    expect(ridePayload.safeParse(c.ride).success).toBe(true)
  })

  it('places the via in order along the leg’s road', async () => {
    const r = route('route0000001', 2)
    // A long leg east with two vias, at a quarter and three quarters of the way.
    r.legs[0].geometry = [
      [-122, 37],
      [-121.9, 37],
    ]
    r.legs[0].viaPoints = [
      [-121.975, 37.001],
      [-121.925, 37.001],
    ]
    const c = ctx({ ride: fixture([r]) })
    await call(c, addShapingPoint, {
      route_uid: 'route0000001',
      from_point_uid: '000001pt00',
      lat: 36.999,
      lng: -121.95,
      source: 'rider',
    })
    expect(c.ride.routes[0].legs[0].viaPoints).toEqual([
      [-121.975, 37.001],
      [-121.95, 36.999],
      [-121.925, 37.001],
    ])
  })

  it('refuses the last point, a full leg, and a duplicate, changing nothing', async () => {
    const c = ctx()
    const before = JSON.stringify(c.ride)
    const last = await call(c, addShapingPoint, {
      route_uid: 'route0000001',
      from_point_uid: '000001pt03',
      lat: 37,
      lng: -121.9,
      source: 'rider',
    })
    expect(last.isError).toBe(true)
    expect(last.text).toMatch(/last point/)
    const dup = await call(c, addShapingPoint, {
      route_uid: 'route0000001',
      from_point_uid: '000001pt00',
      lat: 37.001,
      lng: -121.995,
      source: 'rider',
    })
    expect(dup.isError).toBe(true)
    expect(JSON.stringify(c.ride)).toBe(before)

    const full = route('route0000001', 2)
    full.legs[0].viaPoints = Array.from({ length: MAX_VIAS_PER_LEG }, (_, k) => [-121.999 + k * 0.0001, 37.001])
    const f = ctx({ ride: fixture([full]) })
    const out = await call(f, addShapingPoint, {
      route_uid: 'route0000001',
      from_point_uid: '000001pt00',
      lat: 37.002,
      lng: -121.995,
      source: 'rider',
    })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(new RegExp(`${MAX_VIAS_PER_LEG} shaping points`))
    expect(routing.calls).toEqual([])
  })

  it('is refused and rolled back when the leg cannot be redrawn', async () => {
    routing.next = { routed: 0, skipped: 0, failed: 1 }
    const c = ctx()
    const before = JSON.stringify(c.ride)
    const out = await call(c, addShapingPoint, {
      route_uid: 'route0000001',
      from_point_uid: '000001pt01',
      lat: 37.002,
      lng: -121.985,
      source: 'search',
    })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/not made/)
    expect(JSON.stringify(c.ride)).toBe(before)
  })
})

describe('syncEnds', () => {
  const dated = (endAt: string | null, uid = 'route0000001') =>
    // 3 legs of 600 s: from 09:00 the derived end is 09:30.
    fixture([route(uid, 4, { startAt: '2026-08-01T09:00:00.000Z', endAt })])

  it('re-derives an end that was automatic before the edit', () => {
    const before = dated('2026-08-01T09:30:00.000Z')
    const ride = structuredClone(before)
    ride.routes[0].legs[2].durationS = 1800
    expect(syncEnds(ride, before)).toBe(1)
    expect(ride.routes[0].endAt).toBe('2026-08-01T09:50:00.000Z')
  })

  it('counts a missing end as automatic, and an edit that clears it too', () => {
    const before = dated(null)
    const ride = structuredClone(before)
    syncEnds(ride, before)
    expect(ride.routes[0].endAt).toBe('2026-08-01T09:30:00.000Z')
    const typed = dated('2026-08-01T18:00:00.000Z')
    const cleared = structuredClone(typed)
    cleared.routes[0].endAt = null
    syncEnds(cleared, typed)
    expect(cleared.routes[0].endAt).toBe('2026-08-01T09:30:00.000Z')
  })

  it('keeps an end the rider typed, judged against the route before the edit', () => {
    const before = dated('2026-08-01T18:00:00.000Z')
    const ride = structuredClone(before)
    ride.routes[0].legs[2].durationS = 1800
    expect(syncEnds(ride, before)).toBe(0)
    expect(ride.routes[0].endAt).toBe('2026-08-01T18:00:00.000Z')
  })

  it('leaves an undated route alone, and keeps the end of a route it cannot match', () => {
    const undated = fixture([route('route0000001', 4, { endAt: '2026-08-01T18:00:00.000Z' })])
    const u = structuredClone(undated)
    expect(syncEnds(u, undated)).toBe(0)
    expect(u.routes[0].endAt).toBe('2026-08-01T18:00:00.000Z')
    const nouid = dated('2026-08-01T18:00:00.000Z')
    nouid.routes[0].uid = null
    const n = structuredClone(nouid)
    expect(syncEnds(n, nouid)).toBe(0)
  })

  it('re-derives an automatic end after a redraw changes the riding time', async () => {
    const c = ctx({ ride: dated('2026-08-01T09:30:00.000Z') })
    await call(c, reverseRouteTool, { route_uid: 'route0000001' })
    // Straight placeholders the mock never routed: 3 × round(dist / 20 m/s).
    const legS = c.ride.routes[0].legs.reduce((n, l) => n + Math.round(l.distanceM / 20), 0)
    expect(c.ride.routes[0].endAt).toBe(new Date(Date.UTC(2026, 7, 1, 9) + legS * 1000).toISOString())
  })
})
