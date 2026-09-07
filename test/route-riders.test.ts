// Who is on which stretch of road.
//
// The case that motivated the whole model is the last describe: three riders
// join together and ONE of them peels off later. Subgroups could not express it
// — those three share a group and a route carries one group — so if anything in
// here regresses to group-shaped thinking, that test is the one that catches it.
import { describe, expect, it } from 'vitest'
import {
  firstRouteFor,
  groupsOnRoute,
  groupsRiddenAs,
  ridersWhoRodeAs,
  resolveRouteRiders,
  riderJunctions,
  routesForRider,
  type RouteRiderRef,
  type RouteRef,
} from '../src/route-riders/policy'

const routes = (n: number): RouteRef[] => Array.from({ length: n }, (_, i) => ({ uid: `r${i + 1}`, position: i }))

/** Riders on a route, all riding as the MAIN group — which is what null means. */
const on = (routeUid: string, ...riderIds: number[]): RouteRiderRef[] =>
  riderIds.map((riderId) => ({ routeUid, riderId, subgroupId: null }))

/** Riders on a route riding as a named group: a feeder. */
const onAs = (routeUid: string, subgroupId: number, ...riderIds: number[]): RouteRiderRef[] =>
  riderIds.map((riderId) => ({ routeUid, riderId, subgroupId }))

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

// WHO YOU ARE RIDING AS, WHICH IS NOT WHO YOU BELONG TO. Ziad's call,
// 2026-09-06: a VMCSC rider is in VMCSC on their own feeder and in the main group
// from the moment they join it — and VMCSC survives on that feeder route, which
// is what a later split reads back to offer "split off as VMCSC again".
//
// The worked ride: VMCSF (rider 1) rides r1 alone. VMCSC (riders 2 and 3) rides
// r2 as VMCSC. They merge on r3. VMCSLO (rider 4) rides r4 as VMCSLO. Everyone
// is together from r5.
describe('riding as a group', () => {
  const HOME = new Map<number, number | null>([
    [1, null], // VMCSF is the main group
    [2, 10],
    [3, 10], // VMCSC
    [4, 20], // VMCSLO
  ])
  const resolved = resolveRouteRiders(
    routes(5),
    [...on('r1', 1), ...onAs('r2', 10, 2, 3), ...on('r3', 1, 2, 3), ...onAs('r4', 20, 4), ...on('r5', 1, 2, 3, 4)],
    [1, 2, 3, 4],
  )

  it('carries the group forward with the rider, not just their presence', () => {
    // r2 says VMCSC; nothing says otherwise until r3, so an unanswered route in
    // between would still be VMCSC.
    expect(resolved[1].riders).toEqual([
      { id: 2, group: 10 },
      { id: 3, group: 10 },
    ])
  })

  it('puts them in the main group once they merge, and keeps VMCSC on the feeder', () => {
    expect(resolved[2].riders.every((r) => r.group === null)).toBe(true)
    // The feeder still remembers. This is what a split reads back.
    expect(resolved[1].riders.every((r) => r.group === 10)).toBe(true)
  })

  // THE "EVERYONE" LIE, AND THE REASON THE TICKS ARE DERIVED FROM HOME GROUPS.
  // On r3 every rider's STORED group is null, so reading that would tick nothing
  // and the route would read as everybody's — while VMCSLO is still on their
  // approach. Reading each rider's home group says VMCSF and VMCSC and no more.
  it('reports the groups a route carries from home groups, not stored ones', () => {
    expect(groupsOnRoute(resolved[2], HOME)).toEqual([null, 10]) // VMCSF + VMCSC
    expect(groupsOnRoute(resolved[3], HOME)).toEqual([20]) // VMCSLO alone
    expect(groupsOnRoute(resolved[4], HOME)).toEqual([null, 10, 20]) // everyone
  })

  it('remembers every group a rider has ridden as, most recent first', () => {
    expect(groupsRiddenAs(resolved, 2)).toEqual([10])
    expect(groupsRiddenAs(resolved, 4)).toEqual([20])
    // Rider 1 has only ever ridden as the main group, which is not a grouping
    // anybody splits back into.
    expect(groupsRiddenAs(resolved, 1)).toEqual([])
  })

  it('hands the split picker the riders who last rode as a group', () => {
    expect(ridersWhoRodeAs(resolved, 10)).toEqual([2, 3])
    expect(ridersWhoRodeAs(resolved, 20)).toEqual([4])
    expect(ridersWhoRodeAs(resolved, 99)).toEqual([])
  })

  // THE MOST RECENT ANSWER, NOT THE UNION. VMCSC's membership can change between
  // the outward leg and the way home — Ziad's own case is two of them carrying on
  // to Oakland — so "the same lot again" means whoever rode as it LAST.
  it('takes the last grouping when a group has ridden more than once', () => {
    const again = resolveRouteRiders(
      routes(3),
      [...onAs('r1', 10, 2, 3), ...on('r2', 2, 3), ...onAs('r3', 10, 3)],
      [2, 3],
    )
    expect(ridersWhoRodeAs(again, 10)).toEqual([3])
  })
})

// THE LEGACY TAG IS DERIVED, AND A DERIVATION WITH NO OPINION MUST NOT WRITE.
//
// `writeLegacyRouteGroup()` is the query half and cannot be unit tested without a
// database, so what is pinned here is the RULE it implements: a route's riders
// tell you which group it belongs to only when at least one of them carries a
// home group. On a ride where nobody has been assigned one — every ride until
// somebody uses the Riders tab — the answer is "no opinion", not "everybody".
//
// Writing the null anyway erased the tag the payload had set, which untagged
// feeder routes; `startRouteOf()` then fell back to the main group's own route,
// so every joining group got the main group's start as its origin and a ride
// from Oakland to Ensenada proposed all its meeting points in Oakland. Seen on
// stage on 2026-09-06, minutes after deploy.
describe('deriving a route’s group from its riders', () => {
  // The shape writeLegacyRouteGroup() computes before it decides to write.
  const derive = (homeGroups: Array<number | null>): { opinion: boolean; only: number | null } => {
    const groups = new Set(homeGroups)
    if (groups.size === 1 && [...groups][0] === null) return { opinion: false, only: null }
    return { opinion: true, only: groups.size === 1 ? [...groups][0] : null }
  }

  it('has no opinion when nobody carries a home group', () => {
    expect(derive([null, null])).toEqual({ opinion: false, only: null })
    expect(derive([null])).toEqual({ opinion: false, only: null })
  })

  it('names the group when every rider is in the same one', () => {
    expect(derive([10, 10])).toEqual({ opinion: true, only: 10 })
  })

  it('says everybody when several groups share the route', () => {
    // The case the single column cannot express, and the reason the rows are the
    // honest answer: null here reads as "everybody" to strandOf.
    expect(derive([10, 20])).toEqual({ opinion: true, only: null })
    expect(derive([null, 10])).toEqual({ opinion: true, only: null })
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

// A GROUP PEELING OFF, and specifically WHERE its route may sit in the list.
//
// resolveRouteRiders is a linear walk carrying a set forward, so a route's
// position decides what every route after it inherits. That makes placement a
// correctness question rather than a presentation one, which is the whole reason
// this describe exists.
describe('a group splitting off', () => {
  const VMCSC = 10
  const ROSTER = [1, 2, 3]

  // Ride: everybody together, then Main carries on, then more of Main's road,
  // then VMCSC's route home LAST.
  const listed = routes(4)

  // THE TEST THAT CATCHES THE PLACEMENT BUG. With the peel-off route last, the
  // main group's later routes inherit the CONTINUATION's set. Splice it in at r3
  // instead — reading better in the route list — and r4 silently inherits the
  // leavers, in the panel and in every per-rider export, with nothing raised.
  it('leaves the main group’s later routes inheriting the continuation', () => {
    const out = resolveRouteRiders(listed, [...on('r2', 1), ...onAs('r4', VMCSC, 2, 3)], ROSTER)
    expect(out.map((d) => d.riderIds)).toEqual([[1, 2, 3], [1], [1], [2, 3]])
  })

  // The same facts in the wrong order, kept as the counter-example so the rule is
  // not re-litigated by someone who finds the list ugly.
  it('poisons everything after it when the peel-off route is spliced in early', () => {
    const out = resolveRouteRiders(listed, [...on('r2', 1), ...onAs('r3', VMCSC, 2, 3)], ROSTER)
    expect(out[3].riderIds).toEqual([2, 3])
    expect(out[3].explicit).toBe(false)
  })

  // The junction is derived from the set difference, so the split reports itself
  // with no column and no flag — the mirror of a rider joining.
  it('reports the leavers as leaving at the continuation', () => {
    const out = resolveRouteRiders(listed, [...on('r2', 1), ...onAs('r4', VMCSC, 2, 3)], ROSTER)
    expect(riderJunctions(out)).toEqual([
      { position: 1, joined: [], left: [2, 3] },
      { position: 3, joined: [2, 3], left: [1] },
    ])
  })

  // WHAT THE SPLIT PICKER READS BACK. The group stopped applying when it merged,
  // but it survives on the route it rode as itself, which is what lets a later
  // pass offer "split off as VMCSC again" with the right people already ticked.
  it('remembers who rode as the group, for the next split', () => {
    const out = resolveRouteRiders(listed, [...on('r2', 1), ...onAs('r4', VMCSC, 2, 3)], ROSTER)
    expect(ridersWhoRodeAs(out, VMCSC)).toEqual([2, 3])
    expect(groupsRiddenAs(out, 2)).toEqual([VMCSC])
    expect(groupsRiddenAs(out, 1)).toEqual([])
  })

  // A second pass at the same stop: VMCSC peels off, and only one of them comes
  // back for the next leg. The LAST grouping wins, which is what "the same lot
  // again" means when membership has changed since.
  it('takes the last membership when a group rides twice', () => {
    const twice = routes(5)
    const out = resolveRouteRiders(
      twice,
      [...onAs('r2', VMCSC, 2, 3), ...on('r3', 1, 2, 3), ...onAs('r5', VMCSC, 3)],
      ROSTER,
    )
    expect(ridersWhoRodeAs(out, VMCSC)).toEqual([3])
  })

  // A rider who rode as nobody in particular has no group to be offered back.
  it('offers nothing back for a rider who only ever rode as the main group', () => {
    const out = resolveRouteRiders(listed, on('r2', 1, 2, 3), ROSTER)
    expect(ridersWhoRodeAs(out, VMCSC)).toEqual([])
  })
})
