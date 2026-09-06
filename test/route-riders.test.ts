// Who is on which stretch of road.
//
// The case that motivated the whole model is the last describe: three riders
// join together and ONE of them peels off later. Subgroups could not express it
// — those three share a group and a route carries one group — so if anything in
// here regresses to group-shaped thinking, that test is the one that catches it.
import { describe, expect, it } from 'vitest'
import {
  firstRouteFor,
  resolveRouteRiders,
  riderJunctions,
  routesForRider,
  type RouteRiderRef,
  type RouteRef,
} from '../src/route-riders/policy'

const routes = (n: number): RouteRef[] => Array.from({ length: n }, (_, i) => ({ uid: `r${i + 1}`, position: i }))

const on = (routeUid: string, ...riderIds: number[]): RouteRiderRef[] =>
  riderIds.map((riderId) => ({ routeUid, riderId }))

describe('resolveRouteRiders', () => {
  // The ordinary tour: nine routes, nobody has answered anything.
  it('puts the whole roster on every route when nothing is said', () => {
    const out = resolveRouteRiders(routes(3), [], [7, 3, 9])
    expect(out.map((d) => d.riderIds)).toEqual([
      [3, 7, 9],
      [3, 7, 9],
      [3, 7, 9],
    ])
    expect(out.every((d) => !d.explicit)).toBe(true)
  })

  it('carries a set forward until something says otherwise', () => {
    // Rider 2 joins at route 2 and nothing is said after that.
    const out = resolveRouteRiders(routes(4), on('r2', 1, 2), [1, 2])
    expect(out.map((d) => d.riderIds)).toEqual([
      [1, 2],
      [1, 2],
      [1, 2],
      [1, 2],
    ])
    // Route 1 inherited the roster; route 2 is the only answered one.
    expect(out.map((d) => d.explicit)).toEqual([false, true, false, false])
  })

  // Ziad's own worked example, 2026-09-06: ride to Portland, a friend joins as
  // far as Seattle, they peel off, carry on to Vancouver.
  it('handles a friend joining for the middle of a ride', () => {
    const out = resolveRouteRiders(routes(3), [...on('r1', 1), ...on('r2', 1, 2), ...on('r3', 1)], [1, 2])
    expect(out.map((d) => d.riderIds)).toEqual([[1], [1, 2], [1]])
  })

  it('sorts, so two resolutions of one ride compare equal', () => {
    const a = resolveRouteRiders(routes(1), on('r1', 9, 2, 5), [2, 5, 9])
    expect(a[0].riderIds).toEqual([2, 5, 9])
  })

  it('drops a rider who has left the roster rather than carrying them', () => {
    // Rider 3 was on route 1 and is no longer on the ride. route_riders cascades
    // from rides and users, so the row can outlive a roster removal.
    const out = resolveRouteRiders(routes(2), on('r1', 1, 3), [1, 2])
    expect(out[0].riderIds).toEqual([1])
  })

  it('treats an explicit set emptied by that filter as no answer at all', () => {
    // Every rider named on route 2 has left the ride, so route 2 says nothing
    // and inherits — rather than becoming a route nobody is on, which is not a
    // thing anyone means.
    const out = resolveRouteRiders(routes(2), on('r2', 8, 9), [1, 2])
    expect(out[1].riderIds).toEqual([1, 2])
    expect(out[1].explicit).toBe(false)
  })

  it('ignores rows for a route that is not in the list', () => {
    const out = resolveRouteRiders(routes(1), on('gone', 1), [1, 2])
    expect(out[0].riderIds).toEqual([1, 2])
  })
})

describe('riderJunctions', () => {
  it('finds nothing on a ride everybody rides end to end', () => {
    expect(riderJunctions(resolveRouteRiders(routes(4), [], [1, 2]))).toEqual([])
  })

  it('names the route the change happens at, not the one before it', () => {
    const out = riderJunctions(resolveRouteRiders(routes(3), [...on('r1', 1), ...on('r2', 1, 2)], [1, 2]))
    expect(out).toEqual([{ position: 1, joined: [2], left: [] }])
  })

  it('reports a join and a departure at one boundary as one junction', () => {
    // Rider 2 leaves and rider 3 joins on the same road. That is one moment.
    const out = riderJunctions(resolveRouteRiders(routes(2), [...on('r1', 1, 2), ...on('r2', 1, 3)], [1, 2, 3]))
    expect(out).toEqual([{ position: 1, joined: [3], left: [2] }])
  })

  it('reads a departure as the mirror of a join', () => {
    const out = riderJunctions(
      resolveRouteRiders(routes(3), [...on('r1', 1), ...on('r2', 1, 2), ...on('r3', 1)], [1, 2]),
    )
    expect(out).toEqual([
      { position: 1, joined: [2], left: [] },
      { position: 2, joined: [], left: [2] },
    ])
  })
})

// THE CASE SUBGROUPS COULD NOT HOLD. Three riders join at one meeting point as
// one lot, and one of them leaves further down the road. Under the old model
// those three share a subgroup and a route is tagged with one subgroup, so there
// was no way to say that only rider 4 carries on.
describe('one of three peels off', () => {
  const resolved = resolveRouteRiders(
    routes(4),
    [...on('r1', 1), ...on('r2', 1, 2, 3, 4), ...on('r3', 1, 4)],
    [1, 2, 3, 4],
  )

  it('resolves each stretch to the riders actually on it', () => {
    expect(resolved.map((d) => d.riderIds)).toEqual([[1], [1, 2, 3, 4], [1, 4], [1, 4]])
  })

  it('reports the three joining and then two of them leaving', () => {
    expect(riderJunctions(resolved)).toEqual([
      { position: 1, joined: [2, 3, 4], left: [] },
      { position: 2, joined: [], left: [2, 3] },
    ])
  })

  it('gives each rider their own run, which is what a roadbook is built from', () => {
    expect(routesForRider(resolved, 1).map((d) => d.uid)).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(routesForRider(resolved, 4).map((d) => d.uid)).toEqual(['r2', 'r3', 'r4'])
    expect(routesForRider(resolved, 2).map((d) => d.uid)).toEqual(['r2'])
  })

  it('says where each rider sets off from', () => {
    expect(firstRouteFor(resolved, 1)?.uid).toBe('r1')
    expect(firstRouteFor(resolved, 4)?.uid).toBe('r2')
    expect(firstRouteFor(resolved, 99)).toBe(null)
  })
})
