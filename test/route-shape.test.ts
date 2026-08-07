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

  // A switchback can bring two legs within metres of each other, so a via on
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
