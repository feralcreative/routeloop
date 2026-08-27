// The cross-subgroup solve.
//
// Two things carry this file. First, SLACK MUST NOT BEHAVE LIKE DWELL — that is
// the entire reason it is a second column, and a solve that folded them together
// would pass every other test here. Second, the DEFAULT PRIMARY must not be the
// nearest group; #67 says so explicitly and the failure is invisible to the one
// person who would notice it.
import { describe, expect, it } from 'vitest'
import {
  departureSpreadMs,
  longestStrand,
  solveStrands,
  unsociableDepartures,
  type MeetCost,
  type Strand,
} from '../src/subgroups/schedule'

const OAKLAND = 1
const SACRAMENTO = 2

const H = 3600
const MIN = 60_000

/** Oakland is 30 minutes from the meet; Sacramento is 3 hours. The unfair pair
 *  #67 uses to argue for a chosen primary. */
const NEAR: Strand = { subgroupId: OAKLAND, toMeetS: 0.5 * H, fromMeetS: 4 * H }
const FAR: Strand = { subgroupId: SACRAMENTO, toMeetS: 3 * H, fromMeetS: 4 * H }
const both = [NEAR, FAR]

const cost = (over: Partial<MeetCost> = {}): MeetCost => ({ dwellMin: 0, slackMin: 0, ...over })
const at = (iso: string) => new Date(iso).getTime()
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16)
const by = (s: ReturnType<typeof solveStrands>, id: number) => s!.strands.find((x) => x.subgroupId === id)!

describe('the meet anchor', () => {
  it('puts everybody at the meeting point at the named time, whoever is primary', () => {
    const s = solveStrands(both, cost(), 'meet', at('2026-09-05T10:00:00Z'), OAKLAND)!
    expect(clock(by(s, OAKLAND).arriveAt)).toBe('10:00')
    expect(clock(by(s, SACRAMENTO).arriveAt)).toBe('10:00')
    // Oakland is half an hour out, Sacramento three.
    expect(clock(by(s, OAKLAND).departAt)).toBe('09:30')
    expect(clock(by(s, SACRAMENTO).departAt)).toBe('07:00')
  })

  it('ignores the primary group entirely, because the anchor is not per-group', () => {
    const a = solveStrands(both, cost(), 'meet', at('2026-09-05T10:00:00Z'), OAKLAND)!
    const b = solveStrands(both, cost(), 'meet', at('2026-09-05T10:00:00Z'), SACRAMENTO)!
    expect(a).toEqual(b)
  })
})

describe('the departure anchor', () => {
  // This is the pair of numbers #67 asks to be shown beside the choice: the
  // same ride, and which group gets the round number depends entirely on who is
  // primary.
  it('gives the primary group the round number and solves everyone else to it', () => {
    const oak = solveStrands(both, cost(), 'departure', at('2026-09-05T09:00:00Z'), OAKLAND)!
    expect(clock(by(oak, OAKLAND).departAt)).toBe('09:00')
    expect(clock(by(oak, SACRAMENTO).departAt)).toBe('06:30')

    const sac = solveStrands(both, cost(), 'departure', at('2026-09-05T09:00:00Z'), SACRAMENTO)!
    expect(clock(by(sac, SACRAMENTO).departAt)).toBe('09:00')
    expect(clock(by(sac, OAKLAND).departAt)).toBe('11:30')
  })
})

describe('the arrival anchor', () => {
  it("works backwards from the end of the primary group's ride", () => {
    const s = solveStrands(both, cost(), 'arrival', at('2026-09-05T18:00:00Z'), OAKLAND)!
    // Four hours home from the meet, so the group leaves the meet at 14:00.
    expect(clock(s.meetDepartAt)).toBe('14:00')
    expect(clock(by(s, SACRAMENTO).departAt)).toBe('11:00')
  })
})

// THE PAIR THIS FILE EXISTS TO PIN DOWN, and the honest answer is narrower than
// it looks. In the PLANNED schedule dwell and slack sum: the gap between the
// last asked-for arrival and the onward departure is dwell + slack however it is
// split. Under two of the three anchors, moving a minute from one to the other
// changes nothing this module returns. Under 'meet' they move opposite sides of
// the anchor, which is the one place the split shows in the arithmetic.
//
// What genuinely differs is robustness, which no static plan can express — see
// the MeetCost doc comment.
describe('dwell against slack', () => {
  const base = solveStrands(both, cost(), 'departure', at('2026-09-05T09:00:00Z'), OAKLAND)!

  it('dwell delays the shared departure and moves nobody earlier', () => {
    const s = solveStrands(both, cost({ dwellMin: 30 }), 'departure', at('2026-09-05T09:00:00Z'), OAKLAND)!
    expect(s.meetDepartAt - base.meetDepartAt).toBe(30 * MIN)
    expect(by(s, SACRAMENTO).departAt).toBe(by(base, SACRAMENTO).departAt)
    expect(by(s, OAKLAND).arriveAt).toBe(by(base, OAKLAND).arriveAt)
  })

  // Stated as a test rather than left to be discovered: under this anchor the
  // primary group's departure is nailed down, so the only thing either value
  // can move is the onward schedule, and they move it identically.
  it('is indistinguishable from dwell under the departure anchor', () => {
    const d = solveStrands(both, cost({ dwellMin: 30 }), 'departure', at('2026-09-05T09:00:00Z'), OAKLAND)!
    const k = solveStrands(both, cost({ slackMin: 30 }), 'departure', at('2026-09-05T09:00:00Z'), OAKLAND)!
    expect(k).toEqual(d)
  })

  it('is indistinguishable from dwell under the arrival anchor too', () => {
    const d = solveStrands(both, cost({ dwellMin: 30 }), 'arrival', at('2026-09-05T18:00:00Z'), OAKLAND)!
    const k = solveStrands(both, cost({ slackMin: 30 }), 'arrival', at('2026-09-05T18:00:00Z'), OAKLAND)!
    expect(k).toEqual(d)
  })

  // The one anchor where the split is visible: the named time IS the target
  // arrival, so dwell pushes the departure past it and slack pulls the asked
  // arrivals back from it.
  it('moves opposite sides of the meet anchor', () => {
    const plain = solveStrands(both, cost(), 'meet', at('2026-09-05T10:00:00Z'), null)!
    const dwelt = solveStrands(both, cost({ dwellMin: 30 }), 'meet', at('2026-09-05T10:00:00Z'), null)!
    const slacked = solveStrands(both, cost({ slackMin: 30 }), 'meet', at('2026-09-05T10:00:00Z'), null)!

    expect(clock(dwelt.meetDepartAt)).toBe('10:30')
    expect(by(dwelt, OAKLAND).arriveAt).toBe(by(plain, OAKLAND).arriveAt)

    expect(clock(slacked.meetDepartAt)).toBe('10:00')
    expect(by(slacked, OAKLAND).arriveAt).toBe(by(plain, OAKLAND).arriveAt - 30 * MIN)
  })

  it('leaves the same total gap between the asked arrival and the departure', () => {
    const gap = (c: MeetCost) => {
      const s = solveStrands(both, c, 'meet', at('2026-09-05T10:00:00Z'), null)!
      return s.meetDepartAt - by(s, OAKLAND).arriveAt
    }
    expect(gap(cost({ dwellMin: 35 }))).toBe(35 * MIN)
    expect(gap(cost({ slackMin: 35 }))).toBe(35 * MIN)
    expect(gap(cost({ dwellMin: 15, slackMin: 20 }))).toBe(35 * MIN)
  })

  it('keeps the arrival margin, which is the thing slack buys', () => {
    const s = solveStrands(both, cost({ dwellMin: 15, slackMin: 20 }), 'meet', at('2026-09-05T10:00:00Z'), null)!
    // Asked for 09:40, moving at 10:15: twenty minutes of margin plus fifteen
    // of dwell. A group up to twenty minutes late costs nobody anything.
    expect(clock(by(s, OAKLAND).arriveAt)).toBe('09:40')
    expect(clock(s.meetDepartAt)).toBe('10:15')
  })
})

describe('the default primary', () => {
  // #67: the planner's own group is the one most likely to be nearest the meet,
  // so defaulting to it reproduces the unfair case every time — and the planner
  // does not notice, being the one who rode three miles.
  it('falls back to the LONGEST approach, not the first or the nearest', () => {
    expect(longestStrand(both).subgroupId).toBe(SACRAMENTO)
    expect(longestStrand([FAR, NEAR]).subgroupId).toBe(SACRAMENTO)
  })

  it('uses that fallback when no primary is set', () => {
    const none = solveStrands(both, cost(), 'departure', at('2026-09-05T09:00:00Z'), null)!
    const sac = solveStrands(both, cost(), 'departure', at('2026-09-05T09:00:00Z'), SACRAMENTO)!
    expect(none).toEqual(sac)
  })

  it('uses it for a primary that no longer exists, rather than throwing', () => {
    // A subgroup can be deleted while rides.primary_subgroup_id still names it;
    // the FK is `set null` but a stale id can also arrive from a form.
    const gone = solveStrands(both, cost(), 'departure', at('2026-09-05T09:00:00Z'), 999)!
    expect(gone.strands).toHaveLength(2)
  })
})

describe('what a planner is shown', () => {
  it('measures the spread between the earliest and latest departure', () => {
    const s = solveStrands(both, cost(), 'departure', at('2026-09-05T09:00:00Z'), OAKLAND)!
    expect(departureSpreadMs(s)).toBe(2.5 * 60 * MIN)
  })

  it('names who is being asked to leave before six', () => {
    const s = solveStrands(both, cost(), 'meet', at('2026-09-05T08:00:00Z'), OAKLAND)!
    // Sacramento leaves at 05:00, Oakland at 07:30.
    expect(unsociableDepartures(s)).toEqual([SACRAMENTO])
  })

  // The hour is read in UTC because a day's clock is a wall clock at the
  // departure point carried as UTC. Converting here would be the bug that
  // comment exists to prevent.
  it('reads the hour in UTC rather than in the process zone', () => {
    const s = solveStrands([FAR], cost(), 'departure', at('2026-09-05T05:30:00Z'), SACRAMENTO)!
    expect(unsociableDepartures(s)).toEqual([SACRAMENTO])
  })
})

describe('degenerate rides', () => {
  it('returns null for no strands at all rather than an empty solution', () => {
    expect(solveStrands([], cost(), 'meet', at('2026-09-05T10:00:00Z'), null)).toBeNull()
  })

  it('solves a single strand, which is a ride with no meet in it', () => {
    const s = solveStrands([NEAR], cost(), 'departure', at('2026-09-05T09:00:00Z'), OAKLAND)!
    expect(clock(by(s, OAKLAND).departAt)).toBe('09:00')
    expect(clock(s.endAt)).toBe('13:30')
  })

  it("ends the ride at the slowest way home, not the primary group's", () => {
    const s = solveStrands([NEAR, { ...FAR, fromMeetS: 6 * H }], cost(), 'meet', at('2026-09-05T10:00:00Z'), OAKLAND)!
    expect(clock(s.endAt)).toBe('16:00')
  })
})
