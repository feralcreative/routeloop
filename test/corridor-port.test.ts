// The server's corridor arithmetic (src/maps/corridor.ts) against the browser's
// (public/js/corridor.js, and the two helpers it borrows from route-shape.js).
//
// The planning assistant's find_along_route and the builder's Along the route
// search must search the same circles and keep the same places, or the assistant
// answers about a corridor the rider cannot see. If this fails, bring the two
// copies back into line rather than loosening the assertion; same arrangement as
// alts.test.ts and twist-client.test.ts.
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as S from '../src/maps/corridor'

let C: any
let Shape: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/corridor.js', 'utf8'))(win)
  new Function('window', readFileSync('public/js/route-shape.js', 'utf8'))(win)
  C = win.TBCorridor
  Shape = win.TBShape
})

const MI = 1609.344

// A bent, uneven track: a sparse straight, a dense wiggle, a duplicated vertex (a
// zero-length segment, which the app makes on purpose), and a long diagonal.
const track: [number, number][] = [
  [-122, 37],
  [-122, 38],
  [-121.99, 38.01],
  [-121.98, 38.0],
  [-121.97, 38.02],
  [-121.97, 38.02],
  [-121.5, 38.6],
  [-120.4, 39.9],
]

const probes: [number, number][] = [
  [-122, 37.5],
  [-121.9, 38],
  [-121.97, 38.02],
  [-121.0, 39.0],
  [-122.5, 36.5],
  [-119.9, 40.4],
  [-121.985, 38.005],
]

describe('server corridor.ts agrees with public/js/corridor.js', () => {
  it('nearestSegment: same segment, same distance', () => {
    for (const p of probes) {
      const a = C.nearestSegment(p, track)
      const b = S.nearestSegment(p, track)!
      expect(b.index).toBe(a.index)
      expect(b.offM).toBeCloseTo(a.offM, 6)
    }
    expect(S.nearestSegment([-122, 37], [])).toBe(C.nearestSegment([-122, 37], []))
    expect(S.nearestSegment([-121.9, 37], [[-122, 37]])!.offM).toBeCloseTo(
      C.nearestSegment([-121.9, 37], [[-122, 37]]).offM,
      6,
    )
  })

  it('offRouteM', () => {
    for (const p of probes) expect(S.offRouteM(p, track)).toBeCloseTo(C.offRouteM(p, track), 6)
    expect(S.offRouteM([-122, 37], [])).toBe(C.offRouteM([-122, 37], []))
  })

  it('withinCorridor: same places, same order, same segment', () => {
    const places = probes.map((p, i) => ({ name: `P${i}`, address: '', lngLat: p, type: null }))
    places.push({ name: 'broken', address: '', lngLat: [NaN, 1] as [number, number], type: null })
    for (const r of [500, 5 * MI, 15 * MI, 60 * MI]) {
      const a = C.withinCorridor(places, track, r)
      const b = S.withinCorridor(places, track, r)
      expect(b.map((h) => h.place.name)).toEqual(a.map((h: any) => h.place.name))
      expect(b.map((h) => h.atIndex)).toEqual(a.map((h: any) => h.atIndex))
      b.forEach((h, i) => expect(h.offRouteM).toBeCloseTo(a[i].offRouteM, 6))
    }
    expect(S.withinCorridor(places, [], 1000).length).toBe(C.withinCorridor(places, [], 1000).length)
  })

  it('placeLngLat reads both spellings and refuses garbage', () => {
    const cases = [
      { lngLat: [-122, 37] },
      { lng: -122, lat: 37 },
      { lngLat: [NaN, 37] },
      { lng: '1', lat: 2 },
      null,
      {},
    ]
    for (const c of cases) expect(S.placeLngLat(c as any)).toEqual(C.placeLngLat(c))
  })

  it('corridorSamples and samplesCoverAll, across lengths, widths and caps', () => {
    for (const totalM of [0, 800, 30 * MI, 120 * MI, 300 * MI, 593 * MI, 1200 * MI]) {
      for (const corridorM of [1 * MI, 15 * MI, 30 * MI]) {
        for (const cap of [0, 1, 2, 6, 12]) {
          const a = C.corridorSamples(totalM, corridorM, cap)
          const b = S.corridorSamples(totalM, corridorM, cap)
          expect(b).toEqual(a)
          expect(S.samplesCoverAll(b, totalM)).toBe(C.samplesCoverAll(a, totalM))
        }
      }
    }
  })
})

describe('server corridor.ts agrees with public/js/route-shape.js', () => {
  it('pointAtDistance', () => {
    for (const m of [-5, 0, 1, 50_000, 111_000, 150_000, 1e9]) {
      const a = Shape.pointAtDistance(track, m)
      const b = S.pointAtDistance(track, m)!
      expect(b[0]).toBeCloseTo(a[0], 9)
      expect(b[1]).toBeCloseTo(a[1], 9)
    }
    expect(S.pointAtDistance([], 5)).toBe(Shape.pointAtDistance([], 5))
  })

  it('legAtVertex, including null spans and joints in both directions', () => {
    const spans: S.Span[] = [
      { startIndex: 0, endIndex: 3 },
      null,
      { startIndex: 3, endIndex: 3 },
      { startIndex: 3, endIndex: 7 },
    ]
    for (let v = -1; v <= 9; v++) {
      for (const fwd of [true, false]) expect(S.legAtVertex(spans, v, fwd)).toBe(Shape.legAtVertex(spans, v, fwd))
    }
    expect(S.legAtVertex(spans, null, true)).toBe(Shape.legAtVertex(spans, null, true))
  })

  it('trackAndSpans shares the joint vertex and skips an empty leg', () => {
    const { track: t, spans } = S.trackAndSpans([
      {
        geometry: [
          [0, 0],
          [0, 1],
        ],
      },
      { geometry: [] },
      {
        geometry: [
          [0, 1],
          [0, 2],
          [0, 3],
        ],
      },
    ])
    expect(t).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ])
    expect(spans).toEqual([{ startIndex: 0, endIndex: 1 }, null, { startIndex: 1, endIndex: 3 }])
  })
})
