// Drag-to-shape arithmetic.
//
// Everything here is an off-by-one waiting to happen, and none of it fails
// loudly: get the leg wrong and the route bends around the wrong corner; get
// the insertion index wrong and the leg doubles back on itself. Both look like
// "the router did something odd" rather than like a bug, which is precisely
// why they belong in a test rather than in a click-through.
//
// Same harness as twist-client.test.ts.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

let S: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/route-shape.js', 'utf8'))(win)
  S = (win as any).TBShape
})

// Three legs laid end to end. Consecutive legs share their joint vertex, which
// is what trackAndSpans produces after dropping the duplicate coordinate where
// one leg's last point meets the next leg's first.
const SPANS = [
  { startIndex: 0, endIndex: 10 },
  { startIndex: 10, endIndex: 25 },
  { startIndex: 25, endIndex: 30 },
]

describe('legAtVertex', () => {
  it('finds the leg a mid-leg vertex belongs to', () => {
    expect(S.legAtVertex(SPANS, 5)).toBe(0)
    expect(S.legAtVertex(SPANS, 18)).toBe(1)
    expect(S.legAtVertex(SPANS, 27)).toBe(2)
  })

  // The interesting case. Vertex 10 is simultaneously the end of leg 0 and the
  // start of leg 1, so the vertex alone cannot answer — the edge does.
  it('resolves a shared joint by which edge was grabbed', () => {
    expect(S.legAtVertex(SPANS, 10, true)).toBe(1) // grabbed the segment leaving 10
    expect(S.legAtVertex(SPANS, 10, false)).toBe(0) // grabbed the segment arriving at 10
    expect(S.legAtVertex(SPANS, 25, true)).toBe(2)
    expect(S.legAtVertex(SPANS, 25, false)).toBe(1)
  })

  it('puts the very first vertex on the first leg either way', () => {
    expect(S.legAtVertex(SPANS, 0, true)).toBe(0)
    expect(S.legAtVertex(SPANS, 0, false)).toBe(0)
  })

  it('puts the very last vertex on the last leg', () => {
    expect(S.legAtVertex(SPANS, 30, true)).toBe(2)
    expect(S.legAtVertex(SPANS, 30, false)).toBe(2)
  })

  // A leg with no geometry gets a null span and takes up no track indices.
  // Skipping it must not shift the legs after it — the returned index has to
  // stay aligned with state.routes[r].legs.
  it('skips a geometry-less leg without shifting the ones after it', () => {
    const withGap = [{ startIndex: 0, endIndex: 10 }, null, { startIndex: 10, endIndex: 25 }]
    expect(S.legAtVertex(withGap, 5)).toBe(0)
    expect(S.legAtVertex(withGap, 18)).toBe(2)
    expect(S.legAtVertex(withGap, 10, true)).toBe(2)
  })

  it('handles a leading geometry-less leg', () => {
    const leading = [null, { startIndex: 0, endIndex: 10 }]
    expect(S.legAtVertex(leading, 4)).toBe(1)
  })

  it('answers null rather than guessing on nonsense input', () => {
    expect(S.legAtVertex(SPANS, -1)).toBe(null)
    expect(S.legAtVertex(SPANS, null)).toBe(null)
    expect(S.legAtVertex([], 3)).toBe(null)
    expect(S.legAtVertex([null, null], 3)).toBe(null)
  })
})

// A track running due east, one point every 0.01 degrees.
const TRACK: [number, number][] = Array.from({ length: 31 }, (_, i) => [-122 + i * 0.01, 37])

describe('nearestVertexIndex', () => {
  it('finds the closest vertex', () => {
    expect(S.nearestVertexIndex(TRACK, [-121.9, 37])).toBe(10)
    expect(S.nearestVertexIndex(TRACK, [-121.848, 37.001])).toBe(15)
  })

  // A switchback can bring two legs within meters of each other, so a via on
  // leg 2 must not match a vertex on leg 1 that happens to be nearer.
  it('searches only inside the range it is given', () => {
    expect(S.nearestVertexIndex(TRACK, [-122, 37], 20, 30)).toBe(20)
    expect(S.nearestVertexIndex(TRACK, [-121.7, 37], 0, 10)).toBe(10)
  })

  it('copes with an empty track and an inverted range', () => {
    expect(S.nearestVertexIndex([], [-122, 37])).toBe(-1)
    expect(S.nearestVertexIndex(TRACK, [-122, 37], 20, 10)).toBe(-1)
  })
})

describe('snapToTrack', () => {
  // A due-east road along the equator, so degrees and meters stay legible.
  const ROAD = [
    [0, 0],
    [0.01, 0],
    [0.02, 0],
  ]

  it('pulls a point off the road onto the perpendicular foot', () => {
    const hit = S.snapToTrack(ROAD, [0.005, 0.001], 0)
    expect(hit.lngLat).toEqual([0.005, 0])
    expect(hit.segmentIndex).toBe(0)
  })

  it('projects onto a segment rather than snapping to a vertex', () => {
    // The nearest VERTEX is 0.01 away; the nearest point on the road is not.
    const hit = S.snapToTrack(ROAD, [0.0151, 0.0005], 0)
    expect(hit.lngLat).toEqual([0.0151, 0])
    expect(S.nearestVertexIndex(ROAD, [0.0151, 0.0005])).toBe(2)
  })

  it('clamps to the ends rather than running off them', () => {
    expect(S.snapToTrack(ROAD, [-0.5, 0.001], 0).lngLat).toEqual([0, 0])
    expect(S.snapToTrack(ROAD, [0.5, 0.001], 0).lngLat).toEqual([0.02, 0])
  })

  it('leaves a point already on the road where it is', () => {
    const hit = S.snapToTrack(ROAD, [0.015, 0], 0)
    expect(hit.lngLat).toEqual([0.015, 0])
  })

  it('honors the order floor, so two vias cannot swap', () => {
    // Both drops are nearest the FIRST segment, but the second must not be
    // allowed to land behind the first — that is the bow tie.
    const first = S.snapToTrack(ROAD, [0.006, 0.001], 0)
    const second = S.snapToTrack(ROAD, [0.004, 0.001], first.segmentIndex)
    expect(second.lngLat[0]).toBeGreaterThanOrEqual(0.004)
    expect(second.segmentIndex).toBeGreaterThanOrEqual(first.segmentIndex)
  })

  it('survives a duplicated vertex', () => {
    const withDup = [
      [0, 0],
      [0.01, 0],
      [0.01, 0],
      [0.02, 0],
    ]
    expect(S.snapToTrack(withDup, [0.01, 0.001], 0).lngLat).toEqual([0.01, 0])
  })

  it('has nothing to say about a track with fewer than two vertices', () => {
    expect(S.snapToTrack([], [0, 0], 0)).toBe(null)
    expect(S.snapToTrack([[0, 0]], [0, 0], 0)).toBe(null)
  })
})

describe('viaInsertIndex', () => {
  const span = { startIndex: 0, endIndex: 30 }

  it('puts the first via at 0', () => {
    expect(S.viaInsertIndex(TRACK, span, [], 15)).toBe(0)
  })

  // The bug this exists to stop: append a via that belongs in the middle and
  // the leg runs out to the far one, back to the new one, and forward again.
  it('inserts a via dropped between two existing ones in the middle', () => {
    const vias: [number, number][] = [
      [-121.95, 37], // ~vertex 5
      [-121.75, 37], // ~vertex 25
    ]
    expect(S.viaInsertIndex(TRACK, span, vias, 15)).toBe(1)
  })

  it('appends one dropped past every existing via', () => {
    const vias: [number, number][] = [
      [-121.95, 37],
      [-121.85, 37],
    ]
    expect(S.viaInsertIndex(TRACK, span, vias, 28)).toBe(2)
  })

  it('prepends one dropped before every existing via', () => {
    const vias: [number, number][] = [
      [-121.9, 37],
      [-121.8, 37],
    ]
    expect(S.viaInsertIndex(TRACK, span, vias, 2)).toBe(0)
  })

  it('appends when the leg has no geometry to judge position by', () => {
    expect(S.viaInsertIndex(TRACK, null, [[-121.9, 37]], 5)).toBe(1)
  })

  // Insertion has to stay stable as vias accumulate, or the order drifts.
  it('keeps track order across repeated insertions', () => {
    const vias: [number, number][] = []
    for (const at of [20, 5, 12, 28, 1]) {
      const i = S.viaInsertIndex(TRACK, span, vias, at)
      vias.splice(i, 0, TRACK[at])
    }
    const order = vias.map((v) => TRACK.findIndex((t) => t[0] === v[0]))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order).toEqual([1, 5, 12, 20, 28])
  })
})

// Turning "between those two rows" back into a coordinate, which is what a
// dragged POI needs. A POI has no stored order — ride-graph.ts writes
// `position: null` for every one — so a drag moves its pin rather than
// reordering anything, and this is the arithmetic that decides where to.
describe('pointAtDistance', () => {
  // A due-east run along the equator, where a degree of longitude is a constant
  // ~111.3km, so the expected distances are checkable by hand.
  const EAST: [number, number][] = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ]
  const DEG_M = 6371008.8 * (Math.PI / 180)

  it('returns the first vertex for zero, negative and nonsense distances', () => {
    expect(S.pointAtDistance(EAST, 0)).toEqual([0, 0])
    expect(S.pointAtDistance(EAST, -5)).toEqual([0, 0])
    expect(S.pointAtDistance(EAST, NaN)).toEqual([0, 0])
  })

  it('lands on a vertex when the distance is exactly one', () => {
    const p = S.pointAtDistance(EAST, DEG_M)
    expect(p[0]).toBeCloseTo(1, 6)
    expect(p[1]).toBeCloseTo(0, 6)
  })

  // The point of the function: a distance that falls between two vertices has
  // to interpolate rather than snap to the nearer one.
  it('interpolates within a segment', () => {
    const p = S.pointAtDistance(EAST, DEG_M * 1.5)
    expect(p[0]).toBeCloseTo(1.5, 4)
  })

  // Dropping a POI below every other row asks for the end of the route, and
  // builder.js passes Infinity to say so.
  it('clamps past the end rather than running off it', () => {
    expect(S.pointAtDistance(EAST, DEG_M * 99)).toEqual([3, 0])
    expect(S.pointAtDistance(EAST, Infinity)).toEqual([3, 0])
  })

  it('handles a track too short to have a length', () => {
    expect(S.pointAtDistance([], 10)).toBe(null)
    expect(S.pointAtDistance(null, 10)).toBe(null)
    expect(S.pointAtDistance([[5, 5]], 10)).toEqual([5, 5])
  })

  // A duplicated vertex is a zero-length segment. Interpolating into one is a
  // divide by zero, and the track concatenation can produce them.
  it('survives a zero-length segment', () => {
    const dup: [number, number][] = [
      [0, 0],
      [0, 0],
      [1, 0],
    ]
    const p = S.pointAtDistance(dup, DEG_M * 0.5)
    expect(p[0]).toBeCloseTo(0.5, 4)
    expect(Number.isFinite(p[0])).toBe(true)
  })

  // It must not hand back a reference into the caller's track — builder.js
  // writes the result straight onto a POI's lat/lng.
  it('never returns the track array itself', () => {
    const p = S.pointAtDistance(EAST, 0)
    expect(p).not.toBe(EAST[0])
  })
})

// The stretch between two distances along a track, for #229's dry stretch —
// the bit of road from where the tank runs out to where the next pump is.
describe('sliceBetween', () => {
  // A due-north line from 37N to 39N, roughly 222km.
  const line: [number, number][] = [
    [-122, 37],
    [-122, 38],
    [-122, 39],
  ]
  const DEG = 111195

  it('interpolates both ends rather than snapping to a vertex', () => {
    const path = S.sliceBetween(line, DEG * 0.25, DEG * 0.75)
    expect(path[0][1]).toBeCloseTo(37.25, 2)
    expect(path[path.length - 1][1]).toBeCloseTo(37.75, 2)
  })

  // Snapping would move a wall by up to one segment, which on a sparse imported
  // track is miles.
  it('keeps the vertices strictly inside the span', () => {
    const path = S.sliceBetween(line, DEG * 0.5, DEG * 1.5)
    expect(path).toHaveLength(3)
    expect(path[1][1]).toBeCloseTo(38, 3)
  })

  it('does not double a vertex sitting exactly on an end', () => {
    const path = S.sliceBetween(line, 0, DEG)
    expect(path).toHaveLength(2)
  })

  it('clamps to the end of the track', () => {
    const path = S.sliceBetween(line, DEG * 1.5, 9e9)
    expect(path[path.length - 1][1]).toBeCloseTo(39, 2)
  })

  // A polyline needs two points; a one-point path renders nothing, so the null
  // keeps that check in one place.
  it('is null when there is nothing to draw', () => {
    expect(S.sliceBetween(line, DEG, DEG)).toBeNull()
    expect(S.sliceBetween(line, DEG, DEG * 0.5)).toBeNull()
    expect(S.sliceBetween(line, null, DEG)).toBeNull()
    expect(S.sliceBetween([[-122, 37]], 0, 100)).toBeNull()
    expect(S.sliceBetween(null, 0, 100)).toBeNull()
  })

  it('never returns a vertex of the track itself', () => {
    const path = S.sliceBetween(line, 0, DEG * 2)
    expect(path[1]).not.toBe(line[1])
  })
})

// A ring of points at a fixed distance, for #229's fuel ring — drawn as a
// polyline because google.maps.Circle has no dash support at all, so a dotted
// edge cannot be a Circle.
describe('circlePath', () => {
  const center: [number, number] = [-122, 38]

  it('puts every point exactly the radius away', () => {
    for (const r of [1000, 50_000, 200_000]) {
      const ds = S.circlePath(center, r).map((p: [number, number]) => S.haversineM(center, p))
      expect(Math.min(...ds)).toBeCloseTo(r, 0)
      expect(Math.max(...ds)).toBeCloseTo(r, 0)
    }
  })

  // Geodesic, not a flat ellipse: a degree of longitude is half a degree of
  // latitude at 60N, and a ring built by adding degrees would be an oval.
  it('stays a true ring at high latitude', () => {
    const arctic: [number, number] = [-122, 68]
    const ds = S.circlePath(arctic, 100_000).map((p: [number, number]) => S.haversineM(arctic, p))
    expect(Math.max(...ds) - Math.min(...ds)).toBeLessThan(1)
  })

  it('closes itself so the caller does not have to', () => {
    const p = S.circlePath(center, 10_000)
    expect(p[0][0]).toBeCloseTo(p[p.length - 1][0], 9)
    expect(p[0][1]).toBeCloseTo(p[p.length - 1][1], 9)
  })

  it('takes a step count and defaults to a smooth one', () => {
    expect(S.circlePath(center, 10_000)).toHaveLength(73)
    expect(S.circlePath(center, 10_000, 8)).toHaveLength(9)
  })

  it('is null when there is no ring to draw', () => {
    expect(S.circlePath(center, 0)).toBeNull()
    expect(S.circlePath(center, -5)).toBeNull()
    expect(S.circlePath(null, 100)).toBeNull()
  })
})

// Re-joining a route after points are removed.
//
// This is the arithmetic that decides whether a rider's hand-drawn shaping
// points survive a delete. Getting it wrong is silent both ways: too wide a
// span throws away a leg nothing touched (and pays the router to redraw it),
// too narrow a one drops the vias of a leg that was swallowed.
describe('rejoinSpans', () => {
  it('leaves an untouched route as one span per leg', () => {
    expect(S.rejoinSpans(4, [])).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 1 },
      { from: 2, to: 2 },
    ])
  })

  // Removing point 2 of 0..3 merges legs 1 and 2 into one and leaves leg 0 alone.
  it('merges the two legs either side of a removed point', () => {
    expect(S.rejoinSpans(4, [2])).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 2 },
    ])
  })

  // The ends are not a merge: there is only ever one leg to lose.
  it('drops one leg at either end of the route', () => {
    expect(S.rejoinSpans(4, [0])).toEqual([
      { from: 1, to: 1 },
      { from: 2, to: 2 },
    ])
    expect(S.rejoinSpans(4, [3])).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 1 },
    ])
  })

  it('swallows every leg across a run of removed points', () => {
    expect(S.rejoinSpans(6, [1, 2, 3])).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 4 },
    ])
  })

  it('takes the removals in any order, and repeated', () => {
    expect(S.rejoinSpans(6, [3, 1, 3, 2])).toEqual(S.rejoinSpans(6, [1, 2, 3]))
  })

  it('has no spans when fewer than two points survive', () => {
    expect(S.rejoinSpans(3, [0, 1])).toEqual([])
    expect(S.rejoinSpans(3, [0, 1, 2])).toEqual([])
    expect(S.rejoinSpans(1, [])).toEqual([])
    expect(S.rejoinSpans(0, [])).toEqual([])
  })
})
