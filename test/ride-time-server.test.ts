// The promise that src/maps/ride-time.ts agrees with public/js/ride-time.js.
//
// Two things are being tested and they are not the same thing:
//
//   1. The rule itself — that a leg with distance and no duration is estimated
//      from distance, that a leg with a duration keeps it, and that a leg with
//      neither is zero rather than a guess.
//   2. That the two implementations produce identical answers, the same
//      arrangement as twist-client.test.ts, duration.test.ts and
//      filename-client.test.ts. **If this fails, bring the two back into line
//      rather than loosening the assertion.**
//
// It matters more here than the file's size suggests. The server copy exists
// only because the dashboard's saddle-time figure sums every leg a rider owns,
// and the whole reason that figure was withheld until 2026-08-24 is that an
// undercount there is silent and flatters. A drift between these two would
// reintroduce exactly that: the builder's timeline saying one thing and the
// lifetime total saying another, with nothing raised.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { NOMINAL_SPEED_MS, legDurationS, legIsEstimated } from '../src/maps/ride-time'

let T: any

beforeAll(() => {
  // Same harness as twist-client.test.ts: eval the browser file, drive the
  // global it exports. ride-time.js expects no DOM.
  const win: any = {}
  new Function('window', readFileSync('public/js/ride-time.js', 'utf8'))(win)
  T = win.TBTime
})

// Every case the rule has to get right, driven through both copies below.
const LEGS = [
  { name: 'measured by the router', durationS: 1800, distanceM: 40000 },
  { name: 'unrouted, so estimated', durationS: 0, distanceM: 40000 },
  { name: 'a whole imported track as one leg', durationS: 0, distanceM: 834594 },
  { name: 'zero-length, two points in one place', durationS: 0, distanceM: 0 },
  { name: 'a negative duration, which is still not a measurement', durationS: -1, distanceM: 5000 },
  { name: 'one metre', durationS: 0, distanceM: 1 },
  { name: 'measured at zero distance', durationS: 60, distanceM: 0 },
]

describe('the rule', () => {
  it('estimates a leg the router never answered for', () => {
    // 40 km at 20 m/s is 2000 seconds.
    expect(legDurationS({ durationS: 0, distanceM: 40000 })).toBe(2000)
  })

  it('keeps a duration the router did give', () => {
    expect(legDurationS({ durationS: 1800, distanceM: 40000 })).toBe(1800)
  })

  it('is zero for a leg with neither, rather than guessing', () => {
    // Two points in the same place get a zero-length leg deliberately —
    // splitDayTrack produces them. A guess here would invent time out of nothing.
    expect(legIsEstimated({ durationS: 0, distanceM: 0 })).toBe(false)
    expect(legDurationS({ durationS: 0, distanceM: 0 })).toBe(0)
  })

  it('treats a negative duration as unmeasured, not as a duration', () => {
    expect(legIsEstimated({ durationS: -1, distanceM: 5000 })).toBe(true)
  })

  it('rounds rather than truncating, so a short leg is not free', () => {
    expect(legDurationS({ durationS: 0, distanceM: 1 })).toBe(0)
    expect(legDurationS({ durationS: 0, distanceM: 11 })).toBe(1)
  })
})

describe('the two copies agree', () => {
  it('uses the same nominal speed', () => {
    expect(NOMINAL_SPEED_MS).toBe(T.NOMINAL_SPEED_MS)
  })

  for (const leg of LEGS) {
    it(`agrees on ${leg.name}`, () => {
      const l = { durationS: leg.durationS, distanceM: leg.distanceM }
      expect(legIsEstimated(l)).toBe(T.legIsEstimated(l))
      expect(legDurationS(l)).toBe(T.legDurationS(l))
    })
  }
})
