// Alternate days, and the promise that the browser's copy of the rule agrees
// with the server's.
//
// Three things are being tested and they are not the same thing:
//
//   1. The rule itself — what a group of one becomes, who is elected when
//      nobody claims it, and how group ids are renumbered.
//   2. The numbering, which is what a rider actually reads: a ride whose days 3
//      and 4 are alternates is a three-day ride with four rows.
//   3. That public/js/alternates.js produces identical answers to
//      src/maps/alternates.ts. Same arrangement as twist-client.test.ts,
//      filename-client.test.ts and duration.test.ts, and the same instruction
//      if it fails: bring the two implementations back into line rather than
//      loosening the assertion. A disagreement here is a builder showing one
//      mileage while the database stores another, with nothing raised.
//
// rideRollup is tested against the client copy only — it has no server
// counterpart. See the note at the bottom of public/js/alternates.js.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  activeDayCount,
  activeDays,
  dayOrdinal,
  dayOrdinals,
  resolveAltGroups,
  type AltDay,
} from '../src/maps/alternates'

let C: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/alternates.js', 'utf8'))(win)
  C = win.TBAlt
})

// Shorthand for a fixture day. `d(null)` is a plain day; `d(0)` is an active
// member of group 0; `d(0, false)` is a losing alternate in it.
const d = (altGroup: number | null, altActive = true): AltDay => ({ altGroup, altActive })

const shape = (days: AltDay[]) => days.map((x) => `${x.altGroup === null ? '-' : x.altGroup}${x.altActive ? '*' : ''}`)

describe('resolveAltGroups', () => {
  it('leaves a ride with no alternates completely alone', () => {
    const days = [d(null), d(null), d(null)]
    resolveAltGroups(days)
    expect(shape(days)).toEqual(['-*', '-*', '-*'])
  })

  it('forces an ungrouped day active, whatever the flag said', () => {
    const days = [d(null, false)]
    resolveAltGroups(days)
    expect(days[0].altActive).toBe(true)
  })

  it('keeps a real group and its elected member', () => {
    const days = [d(null), d(3), d(3, false), d(null)]
    resolveAltGroups(days)
    expect(shape(days)).toEqual(['-*', '0*', '0', '-*'])
  })

  it('dissolves a group of one back into a plain day', () => {
    // The everyday case: a rider deletes one of a pair of alternates.
    const days = [d(null), d(7, false)]
    resolveAltGroups(days)
    expect(shape(days)).toEqual(['-*', '-*'])
  })

  it('elects the lowest-indexed member when nobody claims it', () => {
    // What happens when the active day of a group is the one deleted.
    const days = [d(2, false), d(2, false), d(2, false)]
    resolveAltGroups(days)
    expect(shape(days)).toEqual(['0*', '0', '0'])
  })

  it('keeps the first of several claimants and clears the rest', () => {
    const days = [d(1), d(1), d(1)]
    resolveAltGroups(days)
    expect(shape(days)).toEqual(['0*', '0', '0'])
  })

  it('renumbers groups densely from zero, in first-appearance order', () => {
    const days = [d(9), d(9, false), d(4), d(4, false)]
    resolveAltGroups(days)
    expect(days.map((x) => x.altGroup)).toEqual([0, 0, 1, 1])
  })

  it('does not let a renumbered id collide with an untouched one', () => {
    // Group 5 is processed first and becomes 0; group 0 is processed second and
    // becomes 1. If the renumbering wrote through the same keyed structure it
    // was reading, these two would merge.
    const days = [d(5), d(5, false), d(0), d(0, false)]
    resolveAltGroups(days)
    expect(days.map((x) => x.altGroup)).toEqual([0, 0, 1, 1])
    expect(shape(days)).toEqual(['0*', '0', '1*', '1'])
  })

  it('handles a group whose members are not adjacent', () => {
    // Legal in the payload — contiguity is a builder convention, not a rule.
    const days = [d(0), d(null), d(0, false)]
    resolveAltGroups(days)
    expect(shape(days)).toEqual(['0*', '-*', '0'])
  })

  it('is idempotent', () => {
    const days = [d(4, false), d(4, false), d(null), d(9), d(9, false)]
    resolveAltGroups(days)
    const once = shape(days)
    resolveAltGroups(days)
    expect(shape(days)).toEqual(once)
  })
})

describe('activeDays', () => {
  it('drops the losing alternates and nothing else', () => {
    const days = [d(null), d(0), d(0, false), d(0, false), d(null)]
    expect(activeDays(days)).toHaveLength(3)
    expect(activeDayCount(days)).toBe(3)
  })

  it('counts an ungrouped day even if its flag is stale', () => {
    // activeDays has to be right on unresolved input — a caller that has not
    // normalized yet must not silently lose a plain day.
    expect(activeDayCount([d(null, false)])).toBe(1)
  })

  it('preserves the concrete day type, not just the two fields', () => {
    const days = [{ altGroup: null, altActive: true, title: 'Day one' }]
    expect(activeDays(days)[0].title).toBe('Day one')
  })
})

describe('dayOrdinals', () => {
  it('numbers a plain ride 1..N', () => {
    expect(dayOrdinals([d(null), d(null), d(null)])).toEqual(['1', '2', '3'])
  })

  it('gives a losing alternate its group number with a letter', () => {
    // Four rows, three days.
    const days = [d(null), d(null), d(0), d(0, false), d(null)]
    expect(dayOrdinals(days)).toEqual(['1', '2', '3', '3b', '4'])
  })

  it('letters a group of three b then c', () => {
    const days = [d(null), d(0), d(0, false), d(0, false)]
    expect(dayOrdinals(days)).toEqual(['1', '2', '2b', '2c'])
  })

  it('numbers off the active member even when it is not first', () => {
    // Promoting an alternate must not renumber the ride, which is the whole
    // reason altActive exists rather than "lowest position wins".
    const days = [d(null), d(0, false), d(0), d(null)]
    expect(dayOrdinals(days)).toEqual(['1', '2b', '2', '3'])
  })

  it('does not let an alternate consume a day number', () => {
    const days = [d(0), d(0, false), d(0, false), d(null)]
    expect(dayOrdinals(days)).toEqual(['1', '1b', '1c', '2'])
  })

  it('runs past z with a number rather than a second letter', () => {
    const days = [d(0), ...Array.from({ length: 26 }, () => d(0, false))]
    const out = dayOrdinals(days)
    expect(out[25]).toBe('1z')
    expect(out[26]).toBe('1z2')
  })

  it('dayOrdinal agrees with dayOrdinals', () => {
    const days = [d(null), d(0), d(0, false)]
    expect(days.map((_, i) => dayOrdinal(days, i))).toEqual(dayOrdinals(days))
  })
})

// --- The two implementations agree ------------------------------------------

// Every shape the rule has to handle, run through both copies.
const FIXTURES: AltDay[][] = [
  [],
  [d(null)],
  [d(null, false)],
  [d(null), d(null), d(null)],
  [d(null), d(3), d(3, false), d(null)],
  [d(null), d(7, false)],
  [d(2, false), d(2, false), d(2, false)],
  [d(1), d(1), d(1)],
  [d(9), d(9, false), d(4), d(4, false)],
  [d(5), d(5, false), d(0), d(0, false)],
  [d(0), d(null), d(0, false)],
  [d(0, false), d(0), d(null)],
  [d(0), d(0, false), d(0, false), d(1), d(1, false), d(null), d(2, false)],
]

describe('public/js/alternates.js matches src/maps/alternates.ts', () => {
  it('resolves every fixture identically', () => {
    for (const fixture of FIXTURES) {
      const mine = fixture.map((x) => ({ ...x }))
      const theirs = fixture.map((x) => ({ ...x }))
      resolveAltGroups(mine)
      C.resolveAltGroups(theirs)
      expect(theirs).toEqual(mine)
    }
  })

  it('numbers every fixture identically', () => {
    for (const fixture of FIXTURES) {
      const days = fixture.map((x) => ({ ...x }))
      expect(C.dayOrdinals(days)).toEqual(dayOrdinals(days))
      expect(C.activeDayCount(days)).toEqual(activeDayCount(days))
      expect(C.activeDays(days)).toEqual(activeDays(days))
    }
  })

  it('agrees after resolving, not only before', () => {
    for (const fixture of FIXTURES) {
      const days = fixture.map((x) => ({ ...x }))
      resolveAltGroups(days)
      expect(C.dayOrdinals(days)).toEqual(dayOrdinals(days))
    }
  })
})

// --- rideRollup, client only -------------------------------------------------

const totals = (meters: number, riding: number, dpm: number | null, bestDpm = 0, bestMiles = 0) => ({
  meters,
  riding,
  stopped: 0,
  estimated: false,
  twist: dpm == null ? null : { dpm, bestDpm, bestMiles },
})

describe('rideRollup', () => {
  it('sums the days it is given', () => {
    const r = C.rideRollup([totals(1000, 60, null), totals(2000, 120, null)])
    expect(r.meters).toBe(3000)
    expect(r.riding).toBe(180)
  })

  it('marks the ride estimated if any day is', () => {
    const a = totals(1000, 60, null)
    const b = { ...totals(1000, 60, null), estimated: true }
    expect(C.rideRollup([a, b]).estimated).toBe(true)
    expect(C.rideRollup([a, a]).estimated).toBe(false)
  })

  it('weights twistiness by distance, not by day', () => {
    // A 1-mile lane at 300°/mi beside a 99-mile slab at 0 is not a 150°/mi ride.
    const M = C.METERS_PER_MILE
    const r = C.rideRollup([totals(1 * M, 5, 300), totals(99 * M, 300, 0)])
    expect(r.twist.dpm).toBe(3)
  })

  it('takes the best stretch from whichever day has it, and its miles with it', () => {
    const r = C.rideRollup([totals(1000, 60, 100, 120, 8), totals(1000, 60, 100, 260, 21)])
    expect(r.twist.bestDpm).toBe(260)
    expect(r.twist.bestMiles).toBe(21)
  })

  it('reports no twistiness rather than zero when nothing measured any', () => {
    // null is not zero — null means nothing measured it, 0 means the road is
    // straight. A ride of untracked days must not claim to be straight.
    expect(C.rideRollup([totals(1000, 60, null)]).twist).toBeNull()
    expect(C.rideRollup([]).twist).toBeNull()
  })

  it('excludes a losing alternate, because the caller filtered it out', () => {
    // The filter is activeDays, not rideRollup — this pins the pairing the
    // builder relies on rather than the arithmetic.
    const days = [
      { altGroup: null, altActive: true, t: totals(1000, 60, null) },
      { altGroup: 0, altActive: true, t: totals(2000, 120, null) },
      { altGroup: 0, altActive: false, t: totals(9000, 900, null) },
    ]
    const r = C.rideRollup(C.activeDays(days).map((x: any) => x.t))
    expect(r.meters).toBe(3000)
  })
})
