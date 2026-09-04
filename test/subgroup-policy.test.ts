// Strands, meets and splits.
//
// The case that carries this file is the MULTI-DAY APPROACH, because it is the
// one the rejected model could not express and the one a reader will assume is
// broken: Seattle takes two days to reach the meet and San Francisco takes one.
// Those are three consecutive private days, nobody has met anybody yet, and the
// meet is the shared day after them — ONE meet, involving both.
import { describe, expect, it } from 'vitest'
import {
  activeSubgroupIds,
  hasSubgroups,
  junctions,
  neverConverges,
  strandOf,
  trunkDaysFor,
  type StrandDay,
} from '../src/subgroups/policy'

const SEA = 1
const SF = 2
const SAC = 3

/** `null` is the trunk. Positions are assigned densely, which is what the
 *  database guarantees through uq_day_ride_pos. */
const ride = (...subgroups: Array<number | null>): StrandDay[] =>
  subgroups.map((subgroupId, position) => ({ position, subgroupId }))

describe('strandOf', () => {
  // Seattle: 0, 1 and the trunk at 3. SF: 2 and the trunk. The two lists are
  // different lengths and neither is a prefix of the other, which is the whole
  // point of the model.
  const multiDay = ride(SEA, SEA, SF, null)

  it('gives a subgroup its own days plus the shared ones, in order', () => {
    expect(strandOf(multiDay, SEA).map((d) => d.position)).toEqual([0, 1, 3])
    expect(strandOf(multiDay, SF).map((d) => d.position)).toEqual([2, 3])
  })

  it('gives a rider in no subgroup the trunk alone', () => {
    expect(strandOf(multiDay, null).map((d) => d.position)).toEqual([3])
  })

  it('gives an unknown subgroup the trunk rather than nothing', () => {
    // A rider whose subgroup was deleted has subgroup_id null on their member
    // row, but a stale id in a URL must not produce an empty ride.
    expect(strandOf(multiDay, 999).map((d) => d.position)).toEqual([3])
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
  it('finds one meet at the shared day, however many private days precede it', () => {
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
  it('handles a ride whose first shared day is the meet', () => {
    expect(junctions(ride(SEA, SF, null, null))).toEqual([{ position: 2, kind: 'meet', subgroupIds: [SEA, SF] }])
  })

  it('does not report a meet for a lone subgroup rejoining nothing', () => {
    // One subgroup and a trunk is not a converge, but it IS still a boundary
    // where that group's private stretch ends. Reported, because the timeline
    // has to draw it.
    expect(junctions(ride(SEA, null))).toEqual([{ position: 1, kind: 'meet', subgroupIds: [SEA] }])
  })
})

describe('neverConverges', () => {
  it('flags two subgroups that never share a day', () => {
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

// #239. The spine a meeting point is proposed on, which is the shared days when
// there are any and the named group's own days when there are not.
describe('trunkDaysFor', () => {
  it('is the shared days whenever the ride has some', () => {
    // And the trunk group is ignored outright when it does — a shared day is
    // road everybody already rides, which is what joining means.
    const days = ride(SEA, SF, null, null)
    expect(trunkDaysFor(days, SF, SEA)).toEqual({
      days: [
        { position: 2, subgroupId: null },
        { position: 3, subgroupId: null },
      ],
      reason: null,
    })
  })

  // THE CASE #239 WAS FILED FOR. Two groups riding to the same destination
  // share no day, because the road they would ride together is the thing being
  // proposed. Before this the route stopped here and told the planner to leave a
  // day on Everyone.
  it('falls back to the trunk group’s own days when nothing is shared', () => {
    expect(trunkDaysFor(ride(SEA, SF), SF, SEA)).toEqual({
      days: [{ position: 0, subgroupId: SEA }],
      reason: null,
    })
  })

  it('asks rather than picking when no trunk group is set', () => {
    // Not "use the longest" and not "use the primary": whose road everybody
    // bends around is the planner's call, the same as primary_subgroup_id.
    expect(trunkDaysFor(ride(SEA, SF), SF, null)).toEqual({ days: [], reason: 'no-trunk-group' })
  })

  it('refuses to propose that a group join itself', () => {
    expect(trunkDaysFor(ride(SEA, SF), SEA, SEA)).toEqual({ days: [], reason: 'is-trunk' })
  })

  it('has nothing to offer when the trunk group has no day', () => {
    // A group named as the spine before anybody planned its route. Its own
    // reason, because the fix is different: plan that group a day.
    expect(trunkDaysFor(ride(SF, SAC), SF, SEA)).toEqual({ days: [], reason: 'no-trunk' })
  })
})
