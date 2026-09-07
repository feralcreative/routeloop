// Strands, meets and splits.
//
// The case that carries this file is the MULTI-DAY APPROACH, because it is the
// one the rejected model could not express and the one a reader will assume is
// broken: Seattle takes two routes to reach the meet and San Francisco takes one.
// Those are three consecutive private routes, nobody has met anybody yet, and the
// meet is the shared route after them — ONE meet, involving both.
import { describe, expect, it } from 'vitest'
import {
  activeSubgroupIds,
  hasSubgroups,
  junctions,
  neverConverges,
  startRouteOf,
  strandOf,
  type StrandRoute,
} from '../src/subgroups/policy'

const SEA = 1
const SF = 2
const SAC = 3

/** `null` is the trunk. Positions are assigned densely, which is what the
 *  database guarantees through uq_route_ride_pos. */
const ride = (...subgroups: Array<number | null>): StrandRoute[] =>
  subgroups.map((subgroupId, position) => ({ position, subgroupId }))

describe('strandOf', () => {
  // Seattle: 0, 1 and the trunk at 3. SF: 2 and the trunk. The two lists are
  // different lengths and neither is a prefix of the other, which is the whole
  // point of the model.
  const multiRoute = ride(SEA, SEA, SF, null)

  it('gives a subgroup its own routes plus the shared ones, in order', () => {
    expect(strandOf(multiRoute, SEA).map((d) => d.position)).toEqual([0, 1, 3])
    expect(strandOf(multiRoute, SF).map((d) => d.position)).toEqual([2, 3])
  })

  it('gives a rider in no subgroup the trunk alone', () => {
    expect(strandOf(multiRoute, null).map((d) => d.position)).toEqual([3])
  })

  it('gives an unknown subgroup the trunk rather than nothing', () => {
    // A rider whose subgroup was deleted has subgroup_id null on their member
    // row, but a stale id in a URL must not produce an empty ride.
    expect(strandOf(multiRoute, 999).map((d) => d.position)).toEqual([3])
  })

  it('leaves a ride with no subgroups completely alone', () => {
    const plain = ride(null, null, null)
    expect(strandOf(plain, null)).toHaveLength(3)
    expect(strandOf(plain, SEA)).toHaveLength(3)
  })
})

describe('activeSubgroupIds and hasSubgroups', () => {
  it('lists each subgroup once, in first-appearance order', () => {
    expect(activeSubgroupIds(ride(SF, SEA, SEA, null, SF))).toEqual([SF, SEA])
  })

  it('does not count one subgroup as a converge-and-split ride', () => {
    expect(hasSubgroups(ride(SEA, null))).toBe(false)
    expect(hasSubgroups(ride(SEA, SF, null))).toBe(true)
    expect(hasSubgroups(ride(null, null))).toBe(false)
  })
})

describe('junctions', () => {
  it('finds one meet at the shared route, however many private routes precede it', () => {
    expect(junctions(ride(SEA, SEA, SF, null))).toEqual([{ position: 3, kind: 'meet', subgroupIds: [SEA, SF] }])
  })

  it('finds the split on the way home', () => {
    expect(junctions(ride(SEA, SF, null, SEA, SF))).toEqual([
      { position: 2, kind: 'meet', subgroupIds: [SEA, SF] },
      { position: 3, kind: 'split', subgroupIds: [SEA, SF] },
    ])
  })

  // Converging in stages: SF and Santa Cruz merge, then that pack meets Oakland.
  it('finds a meet at each stage of a staged convergence', () => {
    expect(junctions(ride(SF, SEA, null, SAC, null))).toEqual([
      // Sorted numerically, not by appearance — subgroupIds is a SET of who is
      // involved, and a stable order is what makes it comparable.
      { position: 2, kind: 'meet', subgroupIds: [SEA, SF] },
      { position: 3, kind: 'split', subgroupIds: [SAC] },
      { position: 4, kind: 'meet', subgroupIds: [SAC] },
    ])
  })

  it('finds nothing in a ride with no subgroups', () => {
    expect(junctions(ride(null, null, null))).toEqual([])
  })

  // The ride starts at the meet — Seattle and San Francisco in eastern Oregon,
  // #67's strangers case. There is no trunk before it and no split after.
  it('handles a ride whose first shared route is the meet', () => {
    expect(junctions(ride(SEA, SF, null, null))).toEqual([{ position: 2, kind: 'meet', subgroupIds: [SEA, SF] }])
  })

  it('does not report a meet for a lone subgroup rejoining nothing', () => {
    // One subgroup and a trunk is not a converge, but it IS still a boundary
    // where that group's private stretch ends. Reported, because the timeline
    // has to draw it.
    expect(junctions(ride(SEA, null))).toEqual([{ position: 1, kind: 'meet', subgroupIds: [SEA] }])
  })
})

describe('startRouteOf', () => {
  // RIDE 34, WHICH IS WHERE THIS CAME FROM. Two one-point routes left over from
  // before a group seeded its own route are tagged for nobody, so they sort
  // ahead of both satellites' own routes — and `strand[0]` handed each of them the
  // OTHER group's starting point. Both joining groups came back with identical
  // candidates and identical diverts, and the group starting in San Luis Obispo
  // was offered a meeting point north of Santa Cruz.
  const leftovers = ride(SF, null, null, SEA, SAC)

  it('gives a group its OWN first route, not a shared one that sorts before it', () => {
    expect(startRouteOf(leftovers, SEA)?.position).toBe(3)
    expect(startRouteOf(leftovers, SAC)?.position).toBe(4)
  })

  it('gives the main group its own route too', () => {
    expect(startRouteOf(leftovers, SF)?.position).toBe(0)
  })

  it('falls back to the strand for a group with no route of its own', () => {
    // Riding only shared routes: where the shared road starts is the one honest
    // answer, and it is what the old rule returned for everybody.
    expect(startRouteOf(ride(null, null, SF), SEA)?.position).toBe(0)
  })

  it('is null when the group has no routes at all', () => {
    expect(startRouteOf([], SEA)).toBe(null)
  })

  it('agrees with strandOf when a group owns the first route of its strand', () => {
    const simple = ride(SEA, SF, null)
    expect(startRouteOf(simple, SEA)).toBe(strandOf(simple, SEA)[0])
    expect(startRouteOf(simple, SF)).toBe(strandOf(simple, SF)[0])
  })
})

describe('neverConverges', () => {
  it('flags two subgroups that never share a route', () => {
    expect(neverConverges(ride(SEA, SEA, SF))).toBe(true)
  })

  it('does not flag a ride that converges', () => {
    expect(neverConverges(ride(SEA, SF, null))).toBe(false)
  })

  it('does not flag a ride with no subgroups at all', () => {
    expect(neverConverges(ride(null, null))).toBe(false)
    // Nor one subgroup, which cannot converge with anybody by definition.
    expect(neverConverges(ride(SEA, SEA))).toBe(false)
  })
})

// A GROUP PEELING OFF, which is the mirror of a meet and the shape #67's diverge
// half produces. The ride is: everybody together (shared), then the road the rest
// of them carry on down TAGGED WITH MAIN, then the leavers' own route.
//
// Main being tagged at all is new — it is what keeps the continuation out of the
// leavers' strand — and this describe is where the consequences are pinned.
describe('a group splitting off', () => {
  const MAIN = 4
  const VMCSC = 5
  //          0: everybody   1: main carries on   2: VMCSC go home
  const split = ride(null, MAIN, VMCSC)

  // THE ASSERTION THAT ENCODES WHY THE CONTINUATION IS TAGGED. Left shared, it
  // would land in the leavers' strand and hand them the main group's onward road
  // — the ride-34 origin bug and the stage Oakland-to-Ensenada bug in a third
  // costume.
  it('keeps the main group’s onward road out of the leavers’ strand', () => {
    expect(strandOf(split, VMCSC).map((d) => d.position)).toEqual([0, 2])
    expect(strandOf(split, MAIN).map((d) => d.position)).toEqual([0, 1])
  })

  // Derived from route order with no column and no flag, exactly as a meet is: a
  // shared route followed by tagged ones is one split at one boundary, naming
  // everybody who diverges there rather than one junction per group.
  it('derives one split at the boundary, naming both groups', () => {
    expect(junctions(split)).toEqual([{ position: 1, kind: 'split', subgroupIds: [MAIN, VMCSC] }])
  })

  // THE REGRESSION THIS FEATURE CREATES, and the reason startRouteOf grew a
  // parameter. `strand.find(tagged)` assumes the main group is never tagged; once
  // it is, the search returns the CONTINUATION and the ride's real origin at
  // position 0 is never reached.
  it('would give the main group the split stop as its origin without isMain', () => {
    expect(startRouteOf(split, MAIN)?.position).toBe(1)
    expect(startRouteOf(split, MAIN, true)?.position).toBe(0)
  })

  // The leavers keep the ordinary rule: their own route is where they set off
  // from, which for a split is the road away from the stop.
  it('still reads a joining group’s own route as its origin', () => {
    expect(startRouteOf(split, VMCSC)?.position).toBe(2)
  })

  // isMain must change nothing on the ordinary ride, which is every ride that has
  // never split: the main group tags no route, so both readings are strand[0].
  it('changes nothing on a ride that has never split', () => {
    const plain = ride(null, null, SF)
    expect(startRouteOf(plain, SEA, true)).toBe(startRouteOf(plain, SEA))
    expect(startRouteOf(plain, SEA, true)?.position).toBe(0)
  })

  // Pinned rather than assumed: tagging Main means a two-group ride now reports
  // two active subgroups where a shared-continuation version reported one.
  it('counts the main group as a subgroup once it is tagged', () => {
    expect(activeSubgroupIds(split)).toEqual([MAIN, VMCSC])
    expect(hasSubgroups(split)).toBe(true)
    expect(neverConverges(split)).toBe(false)
  })
})
