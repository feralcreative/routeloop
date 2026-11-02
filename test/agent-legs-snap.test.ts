// routeStale pulls every routed leg's shaping points onto the road that came back,
// as the builder's snapVias() does, whichever edit carried them there. The router is
// mocked: never a real Google call.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// A road that runs east along latitude 37, then north: the vias given below sit off it.
const ROAD = [
  [-122, 37],
  [-121.95, 37],
  [-121.95, 37.05],
]
const router = vi.hoisted(() => ({ cached: false }))
vi.mock('../src/routes/routing', () => ({
  cachedRouteLeg: () =>
    router.cached ? { geometry: ROAD.map((c) => c.slice()), distanceM: 9000, durationS: 600, viaPoints: [] } : null,
  fetchRouteLeg: async () => ({
    ok: true,
    cached: false,
    leg: { geometry: ROAD.map((c) => c.slice()), distanceM: 9000, durationS: 600, viaPoints: [] },
  }),
}))

import { ridePayload } from '../src/maps/ride-graph'
import { Budget } from '../src/agent/budget'
import { routeStale } from '../src/agent/legs'
import { snapToTrack, snapVias } from '../src/agent/ride-edit'

let SHAPE: any
beforeAll(() => {
  const win: any = {}
  new Function('window', readFileSync('public/js/route-shape.js', 'utf8'))(win)
  SHAPE = win.TBShape
})

const pt = (uid: string, lng: number, lat: number) => ({ kind: 'stop', lat, lng, name: uid, uid })

function ride(vias: number[][]) {
  return ridePayload.parse({
    title: 'Snap',
    routes: [
      {
        uid: 'route0000001',
        points: [pt('a', -122, 37), pt('b', -121.95, 37.05)],
        legs: [
          {
            geometry: [[-122, 37], ...vias, [-121.95, 37.05]],
            distanceM: 9000,
            durationS: 0,
            viaPoints: vias,
          },
        ],
      },
    ],
  })
}

describe('snapToTrack', () => {
  it('matches route-shape.js', () => {
    const tracks = [
      ROAD,
      [
        [-122, 37],
        [-122, 37],
        [-121.9, 37.1],
        [-121.8, 37.05],
      ],
    ]
    const probes = [
      [-121.97, 37.004],
      [-121.951, 37.03],
      [-123, 36],
      [-121.85, 37.2],
      [-121.95, 37],
    ]
    for (const track of tracks)
      for (const p of probes)
        for (const floor of [0, 1, 5]) {
          const js = SHAPE.snapToTrack(track, p, floor)
          expect(snapToTrack(track as never, p as [number, number], floor)).toEqual(js)
        }
  })

  it('snaps in order, each via floored at the one before, as builder.js snapVias does', () => {
    const vias = [
      [-121.97, 37.004],
      [-121.951, 37.03],
    ]
    expect(snapVias(ROAD as never, vias as never)).toEqual([
      [-121.97, 37],
      [-121.95, 37.03],
    ])
    // A via that lies before the one ahead of it on the road is held at that one's segment.
    const back = snapVias(
      ROAD as never,
      [
        [-121.951, 37.03],
        [-121.99, 37.001],
      ] as never,
    )
    expect(back[1]).toEqual(SHAPE.snapToTrack(ROAD, [-121.99, 37.001], 1).lngLat)
    expect(snapVias(ROAD as never, [])).toEqual([])
  })
})

describe('routeStale', () => {
  it.each([false, true])('snaps the vias of a routed leg onto the road (cached: %s)', async (cached) => {
    router.cached = cached
    const r = ride([
      [-121.97, 37.004],
      [-121.951, 37.03],
    ])
    const oldVias = r.routes[0].legs[0].viaPoints
    const out = await routeStale(r, [{ route: 0, leg: 0 }], new Budget(0))
    expect(out).toEqual({ routed: 1, skipped: 0, failed: 0 })
    expect(r.routes[0].legs[0].viaPoints).toEqual([
      [-121.97, 37],
      [-121.95, 37.03],
    ])
    expect(r.routes[0].legs[0].geometry).toEqual(ROAD)
    // The replaced leg's array is not rewritten under it.
    expect(oldVias[0]).toEqual([-121.97, 37.004])
  })

  it('leaves a leg with no vias with none', async () => {
    router.cached = false
    const r = ride([])
    await routeStale(r, [{ route: 0, leg: 0 }], new Budget(0))
    expect(r.routes[0].legs[0].viaPoints).toEqual([])
  })

  it('keeps a leg between two points in the same place straight, asking no router', async () => {
    router.cached = false
    const r = ridePayload.parse({
      title: 'Twin',
      routes: [
        {
          uid: 'route0000001',
          points: [pt('a', -122, 37), pt('b', -122, 37)],
          legs: [
            {
              geometry: [
                [-122, 37],
                [-122, 37],
              ],
              distanceM: 0,
              durationS: 0,
              viaPoints: [],
            },
          ],
        },
      ],
    })
    const budget = new Budget(0)
    const out = await routeStale(r, [{ route: 0, leg: 0 }], budget)
    expect(out).toEqual({ routed: 1, skipped: 0, failed: 0 })
    expect(r.routes[0].legs[0].geometry).toEqual([
      [-122, 37],
      [-122, 37],
    ])
  })
})
