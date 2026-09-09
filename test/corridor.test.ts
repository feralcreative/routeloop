// How far off the route a place is (#50).
//
// The case this file exists for is the sparse track. nearestVertexIndex() in
// route-shape.js measures to the nearest drawn VERTEX, which is fine on a routed
// line whose vertices are meters apart and badly wrong on a leg that is still
// two points and a straight line — a station sitting ON that line would measure
// as tens of miles off it. Everything here is point-to-SEGMENT for that reason.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

let C: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/corridor.js', 'utf8'))(win)
  C = win.TBCorridor
})

const MI = 1609.344
/** Roughly a degree of latitude in meters, for building fixtures by eye. */
const DEG_LAT_M = 111195

// A due-north line from 37N to 39N on the 122nd meridian — two points, no
// intermediate vertices, which is exactly the shape a leg has before the router
// answers.
const straight: [number, number][] = [
  [-122, 37],
  [-122, 39],
]

const place = (lng: number, lat: number, name = 'X') => ({ lng, lat, name })

describe('distance off the route', () => {
  it('is zero for a place sitting on the line', () => {
    expect(C.offRouteM([-122, 38], straight)).toBeCloseTo(0, 0)
  })

  // THE WHOLE REASON THIS IS NOT nearestVertexIndex. Halfway along a two-point
  // leg is 69 miles from either end and zero miles off the road.
  it('measures to the segment, not to the nearest endpoint', () => {
    const mid = C.offRouteM([-122, 38], straight)
    const toEnd = Math.min(C.offRouteM([-122, 38], [[-122, 37]]), C.offRouteM([-122, 38], [[-122, 39]]))
    expect(mid).toBeLessThan(100)
    expect(toEnd / MI).toBeGreaterThan(60)
  })

  it('measures perpendicular distance from beside the line', () => {
    // A tenth of a degree of longitude at 38N is about 8.8 km.
    const d = C.offRouteM([-121.9, 38], straight)
    expect(d / 1000).toBeGreaterThan(8)
    expect(d / 1000).toBeLessThan(10)
  })

  // Clamped to the segment, so a place beyond the end measures to the end rather
  // than to where the road would have gone had it kept going.
  it('measures to the endpoint from beyond the end of the line', () => {
    const d = C.offRouteM([-122, 40], straight)
    expect(d / DEG_LAT_M).toBeCloseTo(1, 1)
  })

  it('takes the nearest of many segments', () => {
    const dogleg: [number, number][] = [
      [-122, 37],
      [-122, 38],
      [-121, 38],
    ]
    // Sitting on the second segment, far from the first.
    expect(C.offRouteM([-121.5, 38], dogleg)).toBeCloseTo(0, 0)
  })

  it('handles a zero-length segment, which duplicating a point produces', () => {
    const doubled: [number, number][] = [
      [-122, 38],
      [-122, 38],
    ]
    expect(C.offRouteM([-122, 38], doubled)).toBeCloseTo(0, 0)
  })

  // A route with a single point is a real, saveable shape.
  it('measures to the lone point of a one-point track', () => {
    expect(C.offRouteM([-122, 38], [[-122, 38]])).toBeCloseTo(0, 0)
  })

  it('is null when there is no track at all', () => {
    expect(C.offRouteM([-122, 38], [])).toBeNull()
    expect(C.offRouteM([-122, 38], null)).toBeNull()
  })
})

describe('filtering to the corridor', () => {
  const onLine = place(-122, 38, 'on the road')
  const near = place(-121.95, 38, 'a few miles off')
  const far = place(-121.0, 38, 'way off')

  it('keeps what is inside and drops what is not', () => {
    const got = C.withinCorridor([onLine, near, far], straight, 10 * MI)
    expect(got.map((g: any) => g.place.name)).toEqual(['on the road', 'a few miles off'])
  })

  // The number the rider is deciding on. A list of names that are all "somewhere
  // within twenty miles" has thrown away the thing that ranks them.
  it('annotates each hit with how far off it is', () => {
    const got = C.withinCorridor([near], straight, 10 * MI)
    expect(got[0].offRouteM).toBeGreaterThan(0)
    expect(got[0].offRouteM / MI).toBeLessThan(10)
  })

  // Text Search ranks by its own idea of relevance and prominence, which on this
  // question is close to noise: a busier station eight miles further away is not
  // a better answer to "what can I reach without losing an hour".
  it('sorts by detour rather than keeping Google’s order', () => {
    const got = C.withinCorridor([far, near, onLine], straight, 200 * MI)
    expect(got.map((g: any) => g.place.name)).toEqual(['on the road', 'a few miles off', 'way off'])
  })

  it('takes a place sitting exactly on the corridor edge', () => {
    const d = C.offRouteM([-121.95, 38], straight)
    expect(C.withinCorridor([near], straight, d)).toHaveLength(1)
    expect(C.withinCorridor([near], straight, d - 1)).toHaveLength(0)
  })

  // An empty list reads as "there is no fuel here", which is a different and
  // false claim. With no track there is no corridor to be outside of.
  it('lets everything through on a route with no track yet', () => {
    const got = C.withinCorridor([onLine, far], [], 1 * MI)
    expect(got).toHaveLength(2)
    expect(got[0].offRouteM).toBeNull()
  })

  it('skips a place with no usable position rather than landing it at null island', () => {
    const broken = [{ name: 'no coords' }, { lng: 'x', lat: 38, name: 'bad types' }, onLine]
    expect(C.withinCorridor(broken, straight, 10 * MI).map((g: any) => g.place.name)).toEqual(['on the road'])
  })

  it('is empty for an empty result set', () => {
    expect(C.withinCorridor([], straight, 10 * MI)).toEqual([])
    expect(C.withinCorridor(null, straight, 10 * MI)).toEqual([])
  })
})

// #266. The projection was already being run, to filter the corridor and to
// render each hit’s "· 2.1 mi off" tip, and WHICH segment won was thrown away
// — so every Along the route hit fell through to addPoint()’s append and a
// coffee stop found at mile 40 landed after the hotel at mile 300, doubling the
// road back on itself. nearestSegment() keeps the half that was already free.
//
// The index is a VERTEX of the track that was passed in, which is what
// legAtVertex() reads: spans[i] lines up with legs[i], so the leg a place
// projects onto is the pair of points it belongs between, and no distance is
// compared against anything. Measuring an along-distance and testing it against
// the summed `leg.distanceM` would be the same question asked twice in two
// units — drawn geometry against the router’s road distance.
describe('which stretch of the route a place sits on', () => {
  // Four vertices, three segments, each one degree of latitude.
  const legged: [number, number][] = [
    [-122, 37],
    [-122, 38],
    [-122, 39],
    [-122, 40],
  ]

  it('answers the segment’s leading vertex, not the nearest one', () => {
    // Three quarters of the way up the middle segment: vertex 2 is closer, and
    // the answer is still 1, because 1 is the segment the place is beside.
    expect(C.nearestSegment([-122, 38.75], legged).index).toBe(1)
  })

  it('places a hit on the first segment rather than at the end of the route', () => {
    const hit = C.nearestSegment([-121.98, 37.2], legged)
    expect(hit.index).toBe(0)
    expect(hit.offM / MI).toBeLessThan(2)
  })

  it('reports the same distance offRouteM does, because it is the same walk', () => {
    const at = [-121.95, 38.4] as [number, number]
    expect(C.nearestSegment(at, legged).offM).toBeCloseTo(C.offRouteM(at, legged), 6)
  })

  // A tie is what a place square-on to a vertex produces. Too early in the list
  // is a drag; too late is a road that doubles back.
  it('gives a tie to the earlier segment', () => {
    expect(C.nearestSegment([-121.9, 38], legged).index).toBe(0)
  })

  // Same non-answer offRouteM gives: the distance to the only point there is.
  it('answers index 0 for a route of one point', () => {
    const hit = C.nearestSegment([-122, 38], [[-122, 37]])
    expect(hit.index).toBe(0)
    expect(hit.offM).toBeGreaterThan(0)
  })

  it('is null for a route with no track at all', () => {
    expect(C.nearestSegment([-122, 38], [])).toBeNull()
    expect(C.nearestSegment([-122, 38], null)).toBeNull()
  })

  // The carry-through is what the builder actually reads. A hit that is filtered
  // out cannot place anything, so only survivors are annotated.
  //
  // KEYED BY NAME RATHER THAN BY POSITION, because the list comes back sorted by
  // DETOUR and not in route order — which is the point: the builder reads each
  // hit’s own atIndex, never where it sits in the list. Asserting an ordered
  // array here failed on exactly that, with both indices already correct.
  it('rides along with the detour on every kept hit', () => {
    const got = C.withinCorridor([place(-121.98, 37.2, 'early'), place(-121.98, 39.8, 'late')], legged, 10 * MI)
    const byName = Object.fromEntries(got.map((g: any) => [g.place.name, g.atIndex]))
    expect(byName).toEqual({ early: 0, late: 2 })
  })

  // With no track there is no corridor and no segment either. The builder tests
  // `typeof h.atIndex === "number"` and falls back to appending, which is the
  // behaviour this whole change is careful not to take away.
  it('is undefined on a route with no track, alongside a null detour', () => {
    const got = C.withinCorridor([place(-122, 38, 'anywhere')], [], 1 * MI)
    expect(got[0].offRouteM).toBeNull()
    expect(got[0].atIndex).toBeUndefined()
  })
})

// #232. Every test above builds its fixtures as a loose {lng, lat} pair, which
// is a shape the app does not send: `/api/places/search` normalizes a hit to
// {name, address, lngLat, type} and that object goes to withinCorridor()
// untouched. placeLngLat() read only the loose pair, so it returned null for
// every real result, the filter dropped all of them, and ALONG THE DAY answered
// "no gas within 15 mi of this route" on every route of every ride from the moment
// #50 shipped. The arithmetic was right the whole time, which is why it read as
// a radius or a routing problem.
//
// These use the PROXY's shape deliberately. A fixture written to suit the
// helper is what let the defect through in the first place.
describe('the shape the places proxy actually sends', () => {
  /** Exactly what `/api/places/search` returns for one hit. */
  const hit = (lng: number, lat: number, name = 'X') => ({
    name,
    address: '1 Somewhere Rd',
    lngLat: [lng, lat] as [number, number],
    type: 'gas_station',
  })

  it('reads a position out of lngLat', () => {
    expect(C.placeLngLat(hit(-122, 38))).toEqual([-122, 38])
  })

  it('still reads a loose lng/lat pair, which saved places and points use', () => {
    expect(C.placeLngLat({ lng: -122, lat: 38 })).toEqual([-122, 38])
  })

  it('keeps a station sitting on the road instead of dropping every result', () => {
    const onRoad = hit(-122, 38, 'the 76 on the route')
    const wayOff = hit(-121, 38, 'two counties over')
    const got = C.withinCorridor([onRoad, wayOff], straight, 15 * MI)
    expect(got.map((g: any) => g.place.name)).toEqual(['the 76 on the route'])
    expect(got[0].offRouteM).toBeCloseTo(0, 0)
  })

  it('skips a hit whose lngLat is malformed rather than landing it at null island', () => {
    const broken = [
      { name: 'short pair', lngLat: [-122] },
      { name: 'bad types', lngLat: ['x', 38] },
      hit(-122, 38, 'good'),
    ]
    expect(C.withinCorridor(broken, straight, 10 * MI).map((g: any) => g.place.name)).toEqual(['good'])
  })
})

// Where along a route the corridor searches run (#232). Each sample is a BILLED
// Text Search, so the count is a money number and the spacing is what decides
// whether a station on the road is ever offered at all.
describe('sampling a route for corridor searches', () => {
  const CORRIDOR_M = 15 * MI
  const CAP = 6
  const samples = (totalM: number, cap = CAP) => C.corridorSamples(totalM, CORRIDOR_M, cap)

  it('asks once on a route shorter than the corridor is wide', () => {
    const got = samples(10 * MI)
    expect(got).toHaveLength(1)
    // Centered, so a short route is searched from its middle rather than its start.
    expect(got[0].atM).toBeCloseTo(5 * MI, 0)
  })

  // A 300-mile route is the #232 report: one call at the midpoint left the whole
  // route uncovered but the two counties around Willows.
  it('spreads across a long route instead of clustering at the midpoint', () => {
    const got = samples(300 * MI)
    expect(got).toHaveLength(CAP)
    expect(got[0].atM).toBeCloseTo(25 * MI, 0)
    expect(got[CAP - 1].atM).toBeCloseTo(275 * MI, 0)
  })

  it('never spends more than the cap, however long the route', () => {
    expect(samples(3000 * MI)).toHaveLength(CAP)
    expect(samples(300 * MI, 3)).toHaveLength(3)
    expect(samples(300 * MI, 1)).toHaveLength(1)
  })

  // THE PROPERTY THAT MAKES COVERAGE REAL, and it holds up to the point where
  // the cap binds: consecutive samples overlap, so no gap as wide as the
  // corridor sits between them with nothing searching it. Six samples spaced by
  // the corridor's 30-mile diameter covers 180 miles.
  it('places every sample within its own radius of its neighbor, up to the cap', () => {
    ;[40, 120, 180].forEach((mi) => {
      const got = samples(mi * MI)
      for (let i = 1; i < got.length; i++) {
        expect(got[i].atM - got[i - 1].atM).toBeLessThanOrEqual(got[i].radiusM)
      }
      expect(got[0].atM).toBeLessThanOrEqual(got[0].radiusM)
      expect(mi * MI - got[got.length - 1].atM).toBeLessThanOrEqual(got[got.length - 1].radiusM)
    })
  })

  // PAST THE CAP THE COVERAGE THINS, AND THAT IS THE DESIGN RATHER THAN A BUG.
  // The spend is fixed at six calls, so a 300-mile route spaces them 50 miles
  // apart while the proxy clamps a bias radius at 50km — the samples stop
  // overlapping and stretches between them are searched only as far as Google's
  // own ranking reaches. The alternative is a bill proportional to the length of
  // the route, which was the decision made on 2026-09-02.
  //
  // It degrades rather than failing: locationBias REORDERS and never restricts,
  // so a sample can still answer with a station outside its circle, and the
  // 15-mile filter is what decides either way. Asserted so that raising the cap
  // is a deliberate change to a recorded trade-off rather than a silent one.
  it('thins rather than overlapping once the cap binds', () => {
    const got = samples(300 * MI)
    expect(got).toHaveLength(CAP)
    expect(got[1].atM - got[0].atM).toBeGreaterThan(got[0].radiusM)
    // The clamp is what does it: the ideal radius here would be about 40 miles.
    expect(got[0].radiusM).toBe(50000)
  })

  // The proxy rejects anything outside 500m–50km outright, so a sample built
  // past either end is a 400 rather than a wide search.
  it('keeps every radius inside what the places proxy accepts', () => {
    ;[0.2, 5, 60, 300, 900, 5000].forEach((mi) => {
      samples(mi * MI).forEach((sp: any) => {
        expect(sp.radiusM).toBeGreaterThanOrEqual(500)
        expect(sp.radiusM).toBeLessThanOrEqual(50000)
      })
    })
  })

  // THE DEFECT THIS RULE EXISTS FOR, reported from a real 593-mile ride: six
  // samples 99 miles apart with a radius clamped from 95 miles down to 31 left
  // 37-mile holes, so "gas between Burbank and Anaheim" — the whole of the Los
  // Angeles basin — came back empty. The radius CANNOT grow past the 50 km the
  // proxy accepts, so the COUNT has to grow instead.
  it('adds samples so the circles still touch on a long route', () => {
    const CAP12 = 12
    for (const miles of [200, 300, 450, 593, 745]) {
      const got = samples(miles * MI, CAP12)
      const step = (miles * MI) / got.length
      expect(2 * got[0].radiusM).toBeGreaterThanOrEqual(step)
      expect(C.samplesCoverAll(got, miles * MI)).toBe(true)
    }
  })

  it('spends fewer searches on a short route than the cap allows', () => {
    // The count is derived, not always spent: a 40-mile route needs two circles,
    // not twelve. Cheaper than the fixed six this replaced.
    expect(samples(40 * MI, 12).length).toBeLessThan(6)
  })

  // AND SAYS SO WHEN IT STILL CANNOT. Past the cap the circles stop touching
  // again, and a partly searched route that finds nothing is indistinguishable
  // from a road with no fuel on it — which is the wrong conclusion to leave a
  // rider to draw.
  it('reports partial coverage when even the cap cannot close the gaps', () => {
    const long = 1200 * MI
    const got = samples(long, 12)
    expect(got).toHaveLength(12)
    expect(C.samplesCoverAll(got, long)).toBe(false)
  })

  it('asks nothing of a route with no distance', () => {
    expect(samples(0)).toEqual([])
    expect(samples(-1)).toEqual([])
    expect(C.corridorSamples(100 * MI, 0, CAP)).toEqual([])
  })
})
