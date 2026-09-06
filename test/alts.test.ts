// Alternate routes, and the promise that the browser's copy of the rule agrees
// with the server's.
//
// Three things are being tested and they are not the same thing:
//
//   1. The rule itself — what a group of one becomes, who is elected when
//      nobody claims it, and how group ids are renumbered.
//   2. The numbering, which is what a rider actually reads: a ride whose routes 3
//      and 4 are alternates is a three-route ride with four rows.
//   3. That public/js/alts.js produces identical answers to
//      src/maps/alts.ts. Same arrangement as twist-client.test.ts,
//      filename-client.test.ts and duration.test.ts, and the same instruction
//      if it fails: bring the two implementations back into line rather than
//      loosening the assertion. A disagreement here is a builder showing one
//      mileage while the database stores another, with nothing raised.
//
// rideRollup is tested against the client copy only — it has no server
// counterpart. See the note at the bottom of public/js/alts.js.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  activeRouteCount,
  activeRoutes,
  routeOrdinal,
  routeOrdinals,
  resolveAltGroups,
  type AltRoute,
} from '../src/maps/alts'
import { normalize, rideTotals, ridePayload } from '../src/maps/ride-graph'
import { METERS_PER_MILE, trackMeters } from '../src/maps/kml'

let C: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/alts.js', 'utf8'))(win)
  C = win.TBAlt
})

// Shorthand for a fixture route. `d(null)` is a plain route; `d(0)` is an active
// member of group 0; `d(0, false)` is a losing alternate in it.
const d = (altGroup: number | null, altActive = true): AltRoute => ({ altGroup, altActive })

const shape = (routes: AltRoute[]) =>
  routes.map((x) => `${x.altGroup === null ? '-' : x.altGroup}${x.altActive ? '*' : ''}`)

describe('resolveAltGroups', () => {
  it('leaves a ride with no alternates completely alone', () => {
    const routes = [d(null), d(null), d(null)]
    resolveAltGroups(routes)
    expect(shape(routes)).toEqual(['-*', '-*', '-*'])
  })

  it('forces an ungrouped route active, whatever the flag said', () => {
    const routes = [d(null, false)]
    resolveAltGroups(routes)
    expect(routes[0].altActive).toBe(true)
  })

  it('keeps a real group and its elected member', () => {
    const routes = [d(null), d(3), d(3, false), d(null)]
    resolveAltGroups(routes)
    expect(shape(routes)).toEqual(['-*', '0*', '0', '-*'])
  })

  it('dissolves a group of one back into a plain route', () => {
    // The everyday case: a rider deletes one of a pair of alternates.
    const routes = [d(null), d(7, false)]
    resolveAltGroups(routes)
    expect(shape(routes)).toEqual(['-*', '-*'])
  })

  it('elects the lowest-indexed member when nobody claims it', () => {
    // What happens when the active route of a group is the one deleted.
    const routes = [d(2, false), d(2, false), d(2, false)]
    resolveAltGroups(routes)
    expect(shape(routes)).toEqual(['0*', '0', '0'])
  })

  it('keeps the first of several claimants and clears the rest', () => {
    const routes = [d(1), d(1), d(1)]
    resolveAltGroups(routes)
    expect(shape(routes)).toEqual(['0*', '0', '0'])
  })

  it('renumbers groups densely from zero, in first-appearance order', () => {
    const routes = [d(9), d(9, false), d(4), d(4, false)]
    resolveAltGroups(routes)
    expect(routes.map((x) => x.altGroup)).toEqual([0, 0, 1, 1])
  })

  it('does not let a renumbered id collide with an untouched one', () => {
    // Group 5 is processed first and becomes 0; group 0 is processed second and
    // becomes 1. If the renumbering wrote through the same keyed structure it
    // was reading, these two would merge.
    const routes = [d(5), d(5, false), d(0), d(0, false)]
    resolveAltGroups(routes)
    expect(routes.map((x) => x.altGroup)).toEqual([0, 0, 1, 1])
    expect(shape(routes)).toEqual(['0*', '0', '1*', '1'])
  })

  it('handles a group whose members are not adjacent', () => {
    // Legal in the payload — contiguity is a builder convention, not a rule.
    const routes = [d(0), d(null), d(0, false)]
    resolveAltGroups(routes)
    expect(shape(routes)).toEqual(['0*', '-*', '0'])
  })

  it('is idempotent', () => {
    const routes = [d(4, false), d(4, false), d(null), d(9), d(9, false)]
    resolveAltGroups(routes)
    const once = shape(routes)
    resolveAltGroups(routes)
    expect(shape(routes)).toEqual(once)
  })
})

describe('activeRoutes', () => {
  it('drops the losing alternates and nothing else', () => {
    const routes = [d(null), d(0), d(0, false), d(0, false), d(null)]
    expect(activeRoutes(routes)).toHaveLength(3)
    expect(activeRouteCount(routes)).toBe(3)
  })

  it('counts an ungrouped route even if its flag is stale', () => {
    // activeRoutes has to be right on unresolved input — a caller that has not
    // normalized yet must not silently lose a plain route.
    expect(activeRouteCount([d(null, false)])).toBe(1)
  })

  it('preserves the concrete route type, not just the two fields', () => {
    const routes = [{ altGroup: null, altActive: true, title: 'Route one' }]
    expect(activeRoutes(routes)[0].title).toBe('Route one')
  })
})

describe('routeOrdinals', () => {
  it('numbers a plain ride 1..N', () => {
    expect(routeOrdinals([d(null), d(null), d(null)])).toEqual(['1', '2', '3'])
  })

  it('gives a losing alternate its group number with a letter', () => {
    // Four rows, three routes.
    const routes = [d(null), d(null), d(0), d(0, false), d(null)]
    expect(routeOrdinals(routes)).toEqual(['1', '2', '3', '3b', '4'])
  })

  it('letters a group of three b then c', () => {
    const routes = [d(null), d(0), d(0, false), d(0, false)]
    expect(routeOrdinals(routes)).toEqual(['1', '2', '2b', '2c'])
  })

  it('numbers off the active member even when it is not first', () => {
    // Promoting an alternate must not renumber the ride, which is the whole
    // reason altActive exists rather than "lowest position wins".
    const routes = [d(null), d(0, false), d(0), d(null)]
    expect(routeOrdinals(routes)).toEqual(['1', '2b', '2', '3'])
  })

  it('does not let an alternate consume a route number', () => {
    const routes = [d(0), d(0, false), d(0, false), d(null)]
    expect(routeOrdinals(routes)).toEqual(['1', '1b', '1c', '2'])
  })

  it('runs past z with a number rather than a second letter', () => {
    const routes = [d(0), ...Array.from({ length: 26 }, () => d(0, false))]
    const out = routeOrdinals(routes)
    expect(out[25]).toBe('1z')
    expect(out[26]).toBe('1z2')
  })

  it('routeOrdinal agrees with routeOrdinals', () => {
    const routes = [d(null), d(0), d(0, false)]
    expect(routes.map((_, i) => routeOrdinal(routes, i))).toEqual(routeOrdinals(routes))
  })
})

// --- The two implementations agree ------------------------------------------

// Every shape the rule has to handle, run through both copies.
const FIXTURES: AltRoute[][] = [
  [],
  [d(null)],
  [d(null, false)],
  [d(null), d(null), d(null)],
  [d(null), d(3), d(3, false), d(null)],
  [d(null), d(7, false)],
  [d(2, false), d(2, false), d(2, false)],
  [d(1), d(1), d(1)],
  [d(9), d(9, false), d(4), d(4, false)],
  [d(5), d(5, false), d(0), d(0, false)],
  [d(0), d(null), d(0, false)],
  [d(0, false), d(0), d(null)],
  [d(0), d(0, false), d(0, false), d(1), d(1, false), d(null), d(2, false)],
]

describe('public/js/alts.js matches src/maps/alts.ts', () => {
  it('resolves every fixture identically', () => {
    for (const fixture of FIXTURES) {
      const mine = fixture.map((x) => ({ ...x }))
      const theirs = fixture.map((x) => ({ ...x }))
      resolveAltGroups(mine)
      C.resolveAltGroups(theirs)
      expect(theirs).toEqual(mine)
    }
  })

  it('numbers every fixture identically', () => {
    for (const fixture of FIXTURES) {
      const routes = fixture.map((x) => ({ ...x }))
      expect(C.routeOrdinals(routes)).toEqual(routeOrdinals(routes))
      expect(C.activeRouteCount(routes)).toEqual(activeRouteCount(routes))
      expect(C.activeRoutes(routes)).toEqual(activeRoutes(routes))
    }
  })

  it('agrees after resolving, not only before', () => {
    for (const fixture of FIXTURES) {
      const routes = fixture.map((x) => ({ ...x }))
      resolveAltGroups(routes)
      expect(C.routeOrdinals(routes)).toEqual(routeOrdinals(routes))
    }
  })
})

// --- rideRollup, client only -------------------------------------------------

const totals = (meters: number, riding: number, dpm: number | null, bestDpm = 0, bestMiles = 0) => ({
  meters,
  riding,
  stopped: 0,
  estimated: false,
  twist: dpm == null ? null : { dpm, bestDpm, bestMiles },
})

describe('rideRollup', () => {
  it('sums the routes it is given', () => {
    const r = C.rideRollup([totals(1000, 60, null), totals(2000, 120, null)])
    expect(r.meters).toBe(3000)
    expect(r.riding).toBe(180)
  })

  it('marks the ride estimated if any route is', () => {
    const a = totals(1000, 60, null)
    const b = { ...totals(1000, 60, null), estimated: true }
    expect(C.rideRollup([a, b]).estimated).toBe(true)
    expect(C.rideRollup([a, a]).estimated).toBe(false)
  })

  it('weights twistiness by distance, not by route', () => {
    // A 1-mile lane at 300°/mi beside a 99-mile slab at 0 is not a 150°/mi ride.
    const M = C.METERS_PER_MILE
    const r = C.rideRollup([totals(1 * M, 5, 300), totals(99 * M, 300, 0)])
    expect(r.twist.dpm).toBe(3)
  })

  it('takes the best stretch from whichever route has it, and its miles with it', () => {
    const r = C.rideRollup([totals(1000, 60, 100, 120, 8), totals(1000, 60, 100, 260, 21)])
    expect(r.twist.bestDpm).toBe(260)
    expect(r.twist.bestMiles).toBe(21)
  })

  it('reports no twistiness rather than zero when nothing measured any', () => {
    // null is not zero — null means nothing measured it, 0 means the road is
    // straight. A ride of untracked routes must not claim to be straight.
    expect(C.rideRollup([totals(1000, 60, null)]).twist).toBeNull()
    expect(C.rideRollup([]).twist).toBeNull()
  })

  it('excludes a losing alternate, because the caller filtered it out', () => {
    // The filter is activeRoutes, not rideRollup — this pins the pairing the
    // builder relies on rather than the arithmetic.
    const routes = [
      { altGroup: null, altActive: true, t: totals(1000, 60, null) },
      { altGroup: 0, altActive: true, t: totals(2000, 120, null) },
      { altGroup: 0, altActive: false, t: totals(9000, 900, null) },
    ]
    const r = C.rideRollup(C.activeRoutes(routes).map((x: any) => x.t))
    expect(r.meters).toBe(3000)
  })
})

// --- rideTotals, the server's copy ------------------------------------------

// This function writes rides.total_miles, rides.total_duration_s and
// rides.stop_count on every save, every clone and every native import, and it
// had no test of its own until alternates gave it a decision to make. The
// numbers below are the stored caches the ride cards, the ride list and the
// account archive all read back without recomputing.
describe('rideTotals', () => {
  // A leg's claimed distance has to match its geometry or normalize() replaces
  // it — the anti-spoofing clamp fires at 15% deviation. So the fixture derives
  // the claim from the geometry rather than asserting round numbers against a
  // made-up line, and the expectations are computed the same way.
  const GEOM: Array<[number, number]> = [
    [-122, 37],
    [-122, 37.01],
  ]
  const LEG_M = Math.round(trackMeters(GEOM))
  const LEG_S = 600
  const miles = (m: number) => (m / METERS_PER_MILE).toFixed(1)

  const route = (legs: number, opts: Partial<{ altGroup: number; altActive: boolean; dwellMin: number }> = {}) => ({
    title: '',
    color: '#0000cc',
    startAt: null,
    endAt: null,
    altGroup: opts.altGroup ?? null,
    altActive: opts.altActive ?? true,
    points: Array.from({ length: legs + 1 }, (_, i) => ({
      kind: 'stop' as const,
      lat: 37 + i / 100,
      lng: -122,
      name: `Stop ${i}`,
      description: '',
      roles: [] as never[],
      durationMin: i === 0 ? (opts.dwellMin ?? null) : null,
    })),
    legs: Array.from({ length: legs }, () => ({
      geometry: GEOM,
      distanceM: LEG_M,
      durationS: LEG_S,
      viaPoints: [] as never[],
    })),
  })

  const parse = (routes: unknown[]) => {
    const p = ridePayload.parse({ title: 'x', routes })
    normalize(p)
    return p
  }

  it('sums a plain ride', () => {
    const p = parse([route(1), route(1)])
    expect(rideTotals(p).totalMiles).toBe(miles(2 * LEG_M))
    expect(rideTotals(p).stopCount).toBe(4)
  })

  it('counts only the active member of a group', () => {
    // The whole point of the feature: a rider weighing two ways to do route 2
    // should see the ride's mileage for one of them, not for both.
    const p = parse([
      route(1),
      route(1, { altGroup: 0, altActive: true }),
      route(10, { altGroup: 0, altActive: false }),
    ])
    expect(rideTotals(p).totalMiles).toBe(miles(2 * LEG_M))
  })

  it('leaves stop_count out of the alternate too', () => {
    // Easy to miss, and it feeds the ride cards and the ride list — a count
    // nobody would think to question.
    const p = parse([route(1), route(8, { altGroup: 0, altActive: false }), route(1, { altGroup: 0, altActive: true })])
    expect(rideTotals(p).stopCount).toBe(4)
  })

  it('counts a dissolved group, because normalize made it a plain route again', () => {
    // A lone flagged route is not an alternate. If rideTotals read the flag
    // without normalize having run, this ride would report zero miles.
    const p = parse([route(1, { altGroup: 0, altActive: false })])
    expect(rideTotals(p).totalMiles).toBe(miles(LEG_M))
  })

  it('counts dwell time from active routes only', () => {
    const p = parse([
      route(1, { dwellMin: 30 }),
      route(1, { altGroup: 0, altActive: true }),
      route(1, { altGroup: 0, altActive: false, dwellMin: 600 }),
    ])
    // Two active routes of riding, and only the 30 minutes stopped on route 1.
    expect(rideTotals(p).totalDurationS).toBe(2 * LEG_S + 30 * 60)
  })
})
