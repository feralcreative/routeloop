// The trip time model: what is happening at a given moment on a given route.
//
// Ported from a scratch suite that was rewritten three times across the timeline
// sprints. ride-time.js is a plain IIFE that assigns window.TBTime, so it loads
// by evaluating it against a stub global rather than importing.
//
// ONE DAY SHAPE, as of 2026-08-24: an ordered `points` array with a `kind` on
// each element, and `legs[i]` joining `points[i]` to `points[i+1]`. The module
// used to accept a second shape as well, because ride.json sent `stops` and
// `pois` as two arrays — see the header of ride-time.js for why that stopped
// being possible.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

type Leg = { durationS: number; distanceM: number }
type Point = { kind: 'stop' | 'poi'; name?: string; durationMin: number | null }
type Route = { startAt: string | null; endAt: string | null; points: Point[]; legs: Leg[] }

let T: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/ride-time.js', 'utf8'))(win)
  T = win.TBTime
})

const leg = (durationS: number, distanceM = 1000): Leg => ({ durationS, distanceM })
const stop = (name: string, durationMin: number | null = null): Point => ({ kind: 'stop', name, durationMin })
const poi = (name: string, durationMin: number | null = null): Point => ({ kind: 'poi', name, durationMin })
const at = (iso: string) => new Date(iso).toISOString()

const route = (): Route => ({
  startAt: at('2026-08-01T09:00'),
  endAt: null,
  points: [stop('Home'), stop('Lunch', 120), stop('Motel')],
  legs: [leg(3600), leg(1800)],
})

describe('leg duration', () => {
  it('keeps a duration the router returned', () => {
    expect(T.legDurationS(leg(3600))).toBe(3600)
  })

  it('estimates from distance when the router never answered', () => {
    // 40km at the nominal 20 m/s.
    expect(T.legDurationS(leg(0, 40000))).toBe(2000)
  })

  it('leaves a zero-distance leg at zero rather than estimating', () => {
    expect(T.legDurationS(leg(0, 0))).toBe(0)
    expect(T.legIsEstimated(leg(0, 0))).toBe(false)
  })

  it('flags an imported ride, which carries distance and no duration', () => {
    const imported = { durationS: 0, distanceM: 297748 }
    expect(T.legIsEstimated(imported)).toBe(true)
    expect(T.legDurationS(imported)).toBe(Math.round(297748 / 20))
  })
})

describe('elapsed time', () => {
  it('is riding plus every planned stop, not riding alone', () => {
    expect(T.routeElapsedS(route())).toBe(3600 + 7200 + 1800)
  })

  it('splits riding from stopped', () => {
    expect(T.routeRidingS(route())).toBe(5400)
    expect(T.routeStoppedS(route())).toBe(7200)
  })
})

describe('walking a route', () => {
  const walk = (minutes: number) => T.activeAt(route(), minutes * 60)

  it('starts on the first leg', () => {
    expect(walk(0)).toEqual({ legIndex: 0, pointIndex: null, legFraction: 0 })
  })

  it('is parked at the point once the leg is done', () => {
    expect(walk(60)).toEqual({ legIndex: null, pointIndex: 1, legFraction: null })
    expect(walk(119)).toEqual({ legIndex: null, pointIndex: 1, legFraction: null })
  })

  it('rides again when the dwell ends', () => {
    expect(walk(180)).toEqual({ legIndex: 1, pointIndex: null, legFraction: 0 })
  })

  it('parks at the final point past the end of the route', () => {
    expect(walk(999)).toEqual({ legIndex: null, pointIndex: 2, legFraction: null })
  })

  // WITHOUT THIS THE DOT CAN ONLY SIT ON A LEG'S ENDS. Leg 0 is an hour long,
  // so half an hour in is halfway along it — which is what puts the rider
  // somewhere on the road rather than jumping them from stop to stop.
  it('reports how far through the leg it is', () => {
    expect(walk(0).legFraction).toBe(0)
    expect(walk(30).legFraction).toBeCloseTo(0.5, 6)
    expect(walk(45).legFraction).toBeCloseTo(0.75, 6)
  })

  // FRACTION OF TIME, NOT OF DISTANCE. Time is the axis the scrubber moves
  // along, so a dot placed by it keeps step with the clock beside it; placing
  // it by distance would have it lag or race on any leg whose speed is not
  // constant, which is every real one.
  it('measures the fraction against the leg’s own duration', () => {
    // Leg 1 is half an hour and starts at minute 180, after the two-hour lunch.
    expect(walk(180).legFraction).toBe(0)
    expect(walk(195).legFraction).toBeCloseTo(0.5, 6)
  })

  it('has no fraction while parked at a point', () => {
    expect(walk(60).legFraction).toBeNull()
    expect(walk(999).legFraction).toBeNull()
  })

  it('reports no leg at all while parked', () => {
    // The whole reason the map highlights nothing at a stop: claiming a leg
    // would put a line where the rider is not.
    expect(walk(90).legIndex).toBeNull()
  })
})

describe('placing a moment across routes', () => {
  const route2 = (): Route => ({
    startAt: at('2026-08-02T08:00'),
    endAt: null,
    points: [stop('Motel'), stop('Home')],
    legs: [leg(3600)],
  })
  const both = () => {
    const a = route()
    const b = route2()
    a.endAt = new Date((T.routeStartS(a) + T.routeElapsedS(a)) * 1000).toISOString()
    b.endAt = new Date((T.routeStartS(b) + T.routeElapsedS(b)) * 1000).toISOString()
    return [a, b]
  }
  const secs = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

  it('finds the right route', () => {
    expect(T.activeAtMoment(both(), secs('2026-08-01T09:30')).routeIndex).toBe(0)
    expect(T.activeAtMoment(both(), secs('2026-08-02T08:30')).routeIndex).toBe(1)
  })

  it('gives the overnight gap to neither route', () => {
    expect(T.activeAtMoment(both(), secs('2026-08-01T20:00'))).toEqual({
      routeIndex: null,
      legIndex: null,
      pointIndex: null,
      legFraction: null,
    })
  })
})

describe('trip span', () => {
  it('covers a dated route', () => {
    const d = route()
    d.endAt = new Date((T.routeStartS(d) + T.routeElapsedS(d)) * 1000).toISOString()
    expect(T.rideSpan([d])).toEqual({
      from: Math.floor(new Date(at('2026-08-01T09:00')).getTime() / 1000),
      to: Math.floor(new Date(at('2026-08-01T12:30')).getTime() / 1000),
    })
  })

  it('is nothing at all for an undated ride', () => {
    expect(T.rideSpan([{ startAt: null, endAt: null, points: [], legs: [] }])).toBeNull()
  })

  it('does not let an undated route stretch it', () => {
    const d = route()
    d.endAt = new Date((T.routeStartS(d) + T.routeElapsedS(d)) * 1000).toISOString()
    const undated = { startAt: null, endAt: null, points: [stop('X')], legs: [] }
    expect(T.rideSpan([d, undated])).toEqual(T.rideSpan([d]))
  })

  it('falls back to elapsed when a route has a start but no stored end', () => {
    const d = route()
    expect(T.rideSpan([d])!.to).toBe(T.routeStartS(d) + T.routeElapsedS(d))
  })
})

// What the builder's timeline scrubs by default, since #222: a slider stretched
// over a 72-hour ride spends most of its travel on the overnights, and an hour
// of Saturday afternoon comes out too narrow to land on.
describe('route span', () => {
  it('is the route’s own extent', () => {
    const d = route()
    expect(T.routeSpan(d)).toEqual({ from: T.routeStartS(d), to: T.routeEndS(d) })
  })

  it('never reaches past the route it was asked about', () => {
    const d = route()
    const next = { ...route(), startAt: at('2026-08-02T09:00') }
    expect(T.routeSpan(d)).toEqual(T.routeSpan({ ...d }))
    expect(T.routeSpan(d)!.to).toBeLessThan(T.routeStartS(next))
  })

  it('is nothing at all for an undated route', () => {
    expect(T.routeSpan({ startAt: null, endAt: null, points: [stop('X')], legs: [] })).toBeNull()
  })

  // A slider whose min equals its max is a control that cannot move, so the bar
  // hides rather than rendering one — same contract rideSpan has always had.
  it('is nothing for a dated route with nothing in it', () => {
    expect(T.routeSpan({ startAt: at('2026-08-01T09:00'), endAt: null, points: [], legs: [] })).toBeNull()
  })

  it('falls back to elapsed when the route has a start but no stored end', () => {
    const d = route()
    expect(T.routeSpan(d)!.to).toBe(T.routeStartS(d) + T.routeElapsedS(d))
  })

  // THE DELIBERATE DISAGREEMENT WITH rideSpan. A route the rider decided against
  // must not stretch the ride — but a rider who has clicked into that alternate
  // to work on it is looking at exactly that route, and refusing it a span would
  // hide the timeline on the one route they are editing.
  it('gives a losing alternate a span, where the ride span gives it none', () => {
    const ghost = { ...route(), altGroup: 0, altActive: false }
    expect(T.rideSpan([ghost])).toBeNull()
    expect(T.routeSpan(ghost)).toEqual({ from: T.routeStartS(ghost), to: T.routeEndS(ghost) })
  })
})

// Two alternates for the same route cover the same hours. Without the skip the
// timeline puts the rider on both and returns whichever the array lists first.
describe('a losing alternate is not on the schedule', () => {
  const dated = (startIso: string, hours: number): any => ({
    startAt: at(startIso),
    endAt: at(new Date(new Date(startIso).getTime() + hours * 3600e3).toISOString()),
    points: [stop('A'), stop('B')],
    legs: [leg(hours * 3600)],
    altGroup: null,
    altActive: true,
  })
  const secs = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

  it('is left out of the ride span', () => {
    const plain = dated('2026-08-01T09:00', 3)
    const ghost = { ...dated('2026-08-01T09:00', 12), altGroup: 0, altActive: false }
    const active = { ...dated('2026-08-01T09:00', 3), altGroup: 0, altActive: true }
    // The 12-hour alternate must not stretch the timeline to midnight.
    expect(T.rideSpan([plain, active, ghost])).toEqual(T.rideSpan([plain, active]))
  })

  it('never becomes the route at a moment', () => {
    const ghost = { ...dated('2026-08-01T09:00', 6), altGroup: 0, altActive: false }
    const active = { ...dated('2026-08-01T09:00', 6), altGroup: 0, altActive: true }
    expect(T.activeAtMoment([ghost, active], secs('2026-08-01T10:00')).routeIndex).toBe(1)
  })

  // THE INDEX TRAP. Skipping inside the module keeps routeIndex an index into the
  // caller's own array; filtering the array before calling would return 1 here
  // and both clients would highlight the wrong route.
  it('returns an index into the unfiltered array', () => {
    const ghost = { ...dated('2026-08-01T09:00', 6), altGroup: 0, altActive: false }
    const active = { ...dated('2026-08-01T09:00', 6), altGroup: 0, altActive: true }
    const later = dated('2026-08-03T09:00', 3)
    const routes = [ghost, active, later]
    expect(T.activeAtMoment(routes, secs('2026-08-03T10:00')).routeIndex).toBe(2)
    expect(routes[T.activeAtMoment(routes, secs('2026-08-03T10:00')).routeIndex]).toBe(later)
  })

  it('leaves an ungrouped route alone whatever altActive says', () => {
    const stale = { ...dated('2026-08-01T09:00', 3), altGroup: null, altActive: false }
    expect(T.rideSpan([stale])).not.toBeNull()
    expect(T.isLosingAlt(stale)).toBe(false)
  })
})

// Ziad's call, 2026-08-24: a POI is something you at least ride BY. It is part of
// the route and anchors a leg like any other point, so its dwell falls on a leg
// boundary and every figure below is arrived at the same way it would be for a
// stop.
//
// WHAT THIS REPLACED, because the machinery was substantial and its absence is
// the point: a POI used to sit BESIDE the route with no place in the sequence, so
// routeSchedule projected each one onto the route's concatenated track, sorted them by
// that distance, and cut the leg a POI landed inside at whatever fraction of the
// way along it sat. Callers had to compute those distances and thread them in as a
// `poiDistsM` argument or every POI reported distance 0 and stacked up at the
// start of the route. All of it is gone.
describe('a POI is on the road', () => {
  const withPoi = (durationMin: number | null): Route => ({
    startAt: at('2026-08-01T09:00'),
    endAt: null,
    points: [stop('Home'), poi('Vista', durationMin), stop('Lunch', 120), stop('Motel')],
    legs: [leg(1800, 20000), leg(1800, 20000), leg(1800, 20000)],
  })

  it('adds its dwell to the route, so the route ends later', () => {
    expect(T.routeElapsedS(withPoi(30))).toBe(T.routeElapsedS(withPoi(null)) + 1800)
  })

  it('costs nothing when you ride past without stopping', () => {
    expect(T.routeStoppedS(withPoi(null))).toBe(7200)
    expect(T.routeStoppedS(withPoi(0))).toBe(7200)
  })

  it('holds between the legs either side of it, never inside one', () => {
    const r = withPoi(30)
    expect(T.activeAt(r, 1799).legIndex).toBe(0)
    expect(T.activeAt(r, 1800)).toEqual({ legIndex: null, pointIndex: 1, legFraction: null })
    expect(T.activeAt(r, 3599)).toEqual({ legIndex: null, pointIndex: 1, legFraction: null })
    // ...and then the NEXT leg, not the rest of the one it interrupted.
    expect(T.activeAt(r, 3600).legIndex).toBe(1)
  })

  it('is placed by its position in the list, not by a distance', () => {
    // The array IS the sequence. A POI at the end of the list is ridden to last
    // whatever its coordinates would have projected to, which is the thing the
    // old distance-sorted walk could not express.
    const late: Route = {
      startAt: at('2026-08-01T09:00'),
      endAt: null,
      points: [stop('Home'), stop('Lunch', 120), stop('Motel'), poi('Vista', 30)],
      legs: [leg(1800), leg(1800), leg(1800)],
    }
    expect(T.activeAt(late, 0).legIndex).toBe(0)
    expect(T.activeAt(late, 1800).pointIndex).toBe(1)
    // Past every leg the route ends AT the POI, because that is where it ends.
    expect(T.activeAt(late, 99999).pointIndex).toBe(3)
  })

  it('gives a route of a stop and one POI a leg to draw', () => {
    // The report that changed the model. Nothing about the schedule was wrong
    // before — there was simply no leg, so there was no road and no riding time.
    const fresh: Route = {
      startAt: at('2026-08-01T09:00'),
      endAt: null,
      points: [stop('Start'), poi('Vista')],
      legs: [leg(1800, 20000)],
    }
    expect(T.routeRidingS(fresh)).toBe(1800)
    expect(T.activeAt(fresh, 0).legIndex).toBe(0)
  })
})

describe('the schedule and the elapsed time cannot disagree', () => {
  // routeElapsedS drives every stored end time and the whole timeline slider,
  // while routeSchedule drives what the map highlights. If they ever diverge the
  // slider would run off the end of the route, so this is the invariant that
  // matters most in this file.
  const cases: Route[] = [
    route(),
    {
      ...route(),
      points: [stop('Home'), poi('V', 45), stop('Lunch', 120), stop('Motel')],
      legs: [leg(3600), leg(900), leg(1800)],
    },
    // A route that OPENS on a POI and closes on one. Legal, and reachable by
    // dragging: nothing says the first point of a route has to stay a stop.
    {
      ...route(),
      points: [poi('V0', 20), stop('Home'), stop('Lunch', 120), stop('Motel'), poi('V1', 20)],
      legs: [leg(600), leg(3600), leg(1800), leg(600)],
    },
    {
      ...route(),
      points: [stop('Home'), poi('V', null), stop('Lunch', 120), stop('Motel')],
      legs: [leg(3600), leg(900), leg(1800)],
    },
    { startAt: null, endAt: null, points: [stop('Only')], legs: [] },
  ]

  it.each(cases.map((c, i) => [i, c] as const))('holds for case %i', (_i, route) => {
    const segs = T.routeSchedule(route)
    const total = segs.length ? segs[segs.length - 1].end : 0
    expect(total).toBeCloseTo(T.routeElapsedS(route), 6)
  })

  it('never emits a gap or an overlap', () => {
    const segs = T.routeSchedule(cases[2])
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBeCloseTo(segs[i - 1].end, 6)
  })
})

describe('a route with fewer legs than its points imply', () => {
  // THIS WAS A LIVE BUG, and it is the reason the shape is worth a test of its
  // own. routeSchedule walks points and legs together and used to stop dead at the
  // first missing leg. Every imported ride was stored as ONE leg holding the
  // whole track however many points sat on it — so from point 1 onward, every
  // dwell was silently dropped from the route and the timeline ran short by
  // exactly that much. Nothing said so; the slider just ended early.
  //
  // Imports are split into real legs now (src/maps/track-split.ts) and the
  // builder fills any gap on load (fillMissingLegs in builder.js), so the shape
  // should no longer reach here from either direction. This pins the arithmetic
  // for the route one of those paths regresses, because the symptom is a number
  // being quietly too small rather than anything failing.
  const truncated: Route = {
    startAt: at('2026-08-01T09:00'),
    endAt: null,
    points: [stop('Start'), stop('Lunch', 60), stop('Fuel', 30), stop('Motel')],
    legs: [leg(3600, 72000)],
  }

  it('still counts the dwell of points past the last leg', () => {
    const segs = T.routeSchedule(truncated)
    const dwelled = segs.filter((s: { kind: string }) => s.kind === 'point').map((s: { index: number }) => s.index)
    // Lunch is point 1 and Fuel is point 2. Before the fix the walk broke after
    // point 0's leg and Fuel never appeared at all.
    expect(dwelled).toContain(1)
    expect(dwelled).toContain(2)
  })

  it('keeps the schedule and the elapsed time in agreement', () => {
    const segs = T.routeSchedule(truncated)
    const total = segs.length ? segs[segs.length - 1].end : 0
    expect(total).toBeCloseTo(T.routeElapsedS(truncated), 6)
  })
})

// The ride-scope slider's own axis: riding hours with the overnights removed.
//
// rideSpan() is first-departure to last-arrival, so on a nine-route ride most of
// the slider's travel was nights in hotels — the rider spent more of the drag
// in "between routes", with nothing on the map, than on the road.
describe('the compressed ride axis', () => {
  const secs = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)
  const dated = (from: string, to: string): Route => ({
    startAt: at(from),
    endAt: at(to),
    points: [stop('A'), stop('B')],
    legs: [leg(3600)],
  })

  const twoRoutes = () => [dated('2026-08-01T09:00', '2026-08-01T17:00'), dated('2026-08-02T09:00', '2026-08-02T17:00')]

  it('is one segment per route, with the overnight left out', () => {
    const segs = T.rideSegments(twoRoutes())
    expect(segs).toHaveLength(2)
    expect(T.segmentsTotalS(segs)).toBe(16 * 3600)
  })

  // The whole point: the last second of route 1 and the first of route 2 are
  // adjacent on the slider, with the sixteen-hour night consuming none of it.
  it('steps straight from one route’s end to the next route’s start', () => {
    const segs = T.rideSegments(twoRoutes())
    expect(T.momentAtOffset(segs, 8 * 3600 - 1)).toBe(secs('2026-08-01T16:59:59'))
    expect(T.momentAtOffset(segs, 8 * 3600)).toBe(secs('2026-08-02T09:00'))
  })

  // ONE OFFSET, TWO INSTANTS, and the later route wins. The next route's start is a
  // real time the rider typed into its Starts field; the previous route's final
  // second is visually identical to its second-to-last. Taken the other way the
  // round trip breaks, and with the slider's 60-second step every route after the
  // first became unreachable at its own departure time.
  it('gives the shared boundary to the route that is starting', () => {
    const segs = T.rideSegments(twoRoutes())
    expect(T.offsetAtMoment(segs, secs('2026-08-02T09:00'))).toBe(8 * 3600)
    expect(T.momentAtOffset(segs, 8 * 3600)).toBe(secs('2026-08-02T09:00'))
  })

  it('round-trips a moment through the axis', () => {
    const segs = T.rideSegments(twoRoutes())
    for (const iso of ['2026-08-01T09:00', '2026-08-01T13:00', '2026-08-02T09:00', '2026-08-02T16:59']) {
      const m = secs(iso)
      expect(T.momentAtOffset(segs, T.offsetAtMoment(segs, m))).toBe(m)
    }
  })

  // OVERLAPS ARE MERGED, NOT CONCATENATED. Real rides have routes sharing a date
  // — alternates for one Thursday, a subgroup's feeder beside the trunk — and
  // activeAtMoment resolves a moment to the FIRST route covering it. Two slider
  // positions meaning the same instant would resolve to the same route, so the
  // second copy is travel the rider cannot use.
  it('merges routes that share wall-clock hours', () => {
    const segs = T.rideSegments([
      dated('2026-08-01T09:00', '2026-08-01T17:00'),
      dated('2026-08-01T09:00', '2026-08-01T17:00'),
    ])
    expect(segs).toHaveLength(1)
    expect(T.segmentsTotalS(segs)).toBe(8 * 3600)
  })

  it('joins a route that starts exactly when the previous one ends', () => {
    const segs = T.rideSegments([
      dated('2026-08-01T09:00', '2026-08-01T17:00'),
      dated('2026-08-01T17:00', '2026-08-01T21:00'),
    ])
    expect(segs).toHaveLength(1)
    expect(T.segmentsTotalS(segs)).toBe(12 * 3600)
  })

  it('takes the routes in clock order, whatever order they are stored in', () => {
    const [first, second] = twoRoutes()
    const segs = T.rideSegments([second, first])
    expect(segs[0].from).toBe(secs('2026-08-01T09:00'))
  })

  // The ride's length must not include a route the rider decided against —
  // matching rideSpan() rather than routeSpan().
  it('leaves a losing alternate out', () => {
    const [a, b] = twoRoutes()
    const segs = T.rideSegments([a, { ...b, altGroup: 1, altActive: false }])
    expect(segs).toHaveLength(1)
  })

  // A gap has no travel of its own, so rounding forward would jump a rider who
  // has just clicked into the next route back to the previous one's last second.
  it('puts a moment inside an overnight at the start of the gap', () => {
    const segs = T.rideSegments(twoRoutes())
    expect(T.offsetAtMoment(segs, secs('2026-08-01T23:00'))).toBe(8 * 3600)
  })

  it('clamps outside the ride rather than running off either end', () => {
    const segs = T.rideSegments(twoRoutes())
    expect(T.momentAtOffset(segs, -500)).toBe(secs('2026-08-01T09:00'))
    expect(T.momentAtOffset(segs, 9e9)).toBe(secs('2026-08-02T17:00'))
    expect(T.offsetAtMoment(segs, secs('2020-01-01T00:00'))).toBe(0)
    expect(T.offsetAtMoment(segs, secs('2030-01-01T00:00'))).toBe(16 * 3600)
  })

  it('is empty for a ride nobody has dated', () => {
    expect(T.rideSegments([{ startAt: null, endAt: null, points: [stop('A')], legs: [] }])).toEqual([])
    expect(T.segmentsTotalS([])).toBe(0)
    expect(T.momentAtOffset([], 0)).toBeNull()
  })
})

// When a group ARRIVES somewhere, which is what a meeting point is agreed on and
// what the builder syncs sub-group departures against.
describe('elapsedToPointS', () => {
  it('is zero at the point a route departs from', () => {
    expect(T.elapsedToPointS(route(), 0)).toBe(0)
  })

  it('sums the dwell and the riding before it', () => {
    // Home (no dwell) → 3600s → Lunch. Arriving is before Lunch's own 120min.
    expect(T.elapsedToPointS(route(), 1)).toBe(3600)
    // …then Lunch's 7200s of dwell and 1800s more riding to the Motel.
    expect(T.elapsedToPointS(route(), 2)).toBe(3600 + 7200 + 1800)
  })

  // ARRIVING, NOT LEAVING. The dwell at the point itself is somebody's plan for
  // after everyone is there; a group waiting for another group is not waiting
  // for that.
  it('excludes the dwell of the point itself', () => {
    const d = route()
    d.points[1].durationMin = 999
    expect(T.elapsedToPointS(d, 1)).toBe(3600)
  })

  // The invariant that ties it to the rest of the file: arriving at the last
  // point plus that point's own dwell is the whole route.
  it('agrees with routeElapsedS at the end of the route', () => {
    const d = route()
    const last = d.points.length - 1
    expect(T.elapsedToPointS(d, last) + (d.points[last].durationMin || 0) * 60).toBe(T.routeElapsedS(d))
  })

  it('absorbs a missing leg rather than stopping early', () => {
    const d = route()
    d.legs = [leg(3600)] as any
    // The second leg is gone; the dwell after it still counts.
    expect(T.elapsedToPointS(d, 2)).toBe(3600 + 7200)
  })

  it('is null for an index that is not a point', () => {
    // Not 0 — a caller holding a stale index would read that as "they arrive at
    // the moment they set off".
    expect(T.elapsedToPointS(route(), 3)).toBe(null)
    expect(T.elapsedToPointS(route(), -1)).toBe(null)
    expect(T.elapsedToPointS(route(), 1.5)).toBe(null)
  })
})

// "I like to stop by four" — turning a time of route into a place on the road, so
// the builder can mark where the rider will be and search for a bed around it.
//
// THESE BUILD THEIR OWN START TIMES WITH AN EXPLICIT `Z`, and the shared `at()`
// above deliberately is not used. `new Date('2026-08-01T09:00')` has no zone, so
// it parses in the MACHINE's — the fixture stores 16:00Z on a Pacific laptop and
// 08:00Z in Berlin. Every other test in this file measures durations, which that
// cannot affect; these are the first to read a clock, and they would pass or
// fail by geography. A route's start is a wall clock CARRIED as UTC, so a test
// about wall clocks has to say UTC.
const utcDay = (iso: string): Route => ({ ...route(), startAt: `${iso}.000Z` })

describe('offsetAtClock', () => {
  it('counts forward from the route’s own departure', () => {
    // 09:00 to 16:00 is seven hours, and no zone is consulted to say so.
    expect(T.offsetAtClock(utcDay('2026-08-01T09:00:00'), 16 * 60)).toBe(7 * 3600)
  })

  it('wraps to tomorrow when the time has already passed', () => {
    // A route setting off at 09:00 reaches 08:00 twenty-three hours later, not an
    // hour ago. The caller rejects it by length; it is not a special case here.
    expect(T.offsetAtClock(utcDay('2026-08-01T09:00:00'), 8 * 60)).toBe(23 * 3600)
  })

  it('is zero at the departure time itself', () => {
    expect(T.offsetAtClock(utcDay('2026-08-01T09:00:00'), 9 * 60)).toBe(0)
  })

  it('has nothing to count from on an undated route', () => {
    const d = utcDay('2026-08-01T09:00:00')
    d.startAt = null
    // Not 0 — that would read as "at the moment they set off".
    expect(T.offsetAtClock(d, 16 * 60)).toBe(null)
    expect(T.offsetAtClock(utcDay('2026-08-01T09:00:00'), Number.NaN)).toBe(null)
  })

  // The clock is read in UTC because a route's start IS a wall clock carried as
  // UTC. A machine in another zone must get the same answer, which is the whole
  // point of the rule — so this asserts against a stored time whose UTC reading
  // and local reading differ.
  it('reads the departure as a wall clock, not in the browser’s zone', () => {
    const d = utcDay('2026-08-01T23:30:00')
    // 23:30 to 04:00 is four and a half hours by the clock on the bike.
    expect(T.offsetAtClock(d, 4 * 60)).toBe(4.5 * 3600)
  })
})

describe('clockMoment', () => {
  // The fixture route runs 09:00 to 12:30 — an hour of riding, two hours of lunch,
  // half an hour more.
  it('places the rider on the road at that time', () => {
    const got = T.clockMoment(utcDay('2026-08-01T09:00:00'), 11 * 60)
    expect(got).not.toBe(null)
    expect(got.offsetS).toBe(2 * 3600)
    // Two hours in is the middle of the two-hour lunch, so the rider is AT a
    // point rather than on a leg — which activeAt reports as such.
    expect(got.at.pointIndex).toBe(1)
  })

  // THE COMMON ANSWER, AND NOT A FAILURE. A route that finishes at 12:30 never
  // reaches four, and pinning the marker to its last point would put "look for a
  // bed here" on the place the rider already arrived at.
  it('is null when the route ends before that time', () => {
    expect(T.clockMoment(utcDay('2026-08-01T09:00:00'), 16 * 60)).toBe(null)
  })

  it('is null on an undated route', () => {
    const d = utcDay('2026-08-01T09:00:00')
    d.startAt = null
    expect(T.clockMoment(d, 16 * 60)).toBe(null)
  })
})
