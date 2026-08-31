// Where the rider is mid-scrub, and what the circle around them reaches to.
//
// The idea this file is really testing is that the RADIUS IS NEVER A RANGE
// NUMBER. It is the straight line to a point we can locate exactly on the
// route — the dry point or the next pump — so the circle makes one true
// statement instead of an approximate one. Everything here is about finding
// that point; the straight line itself is haversineM, which route-shape.js
// already owns and tests.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

type Point = { kind: 'stop' | 'poi'; name?: string; roles?: string[] }
type Leg = { distanceM: number }
type Day = { points: Point[]; legs: Leg[] }

let R: any
let D: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/range-circle.js', 'utf8'))(win)
  new Function('window', readFileSync('public/js/day-distance.js', 'utf8'))(win)
  R = win.TBRange
  D = win.TBDistance
})

const MI = 1609.344
const mi = (n: number) => n * MI
const stop = (name: string, roles: string[] = []): Point => ({ kind: 'stop', name, roles })
const leg = (miles: number): Leg => ({ distanceM: mi(miles) })

/** Home → 100 → Shell(gas) → 80 → Lunch → 60 → Motel. 240 miles. */
const day = (): Day => ({
  points: [stop('Home', ['start']), stop('Shell', ['gas']), stop('Lunch', ['food']), stop('Motel', ['hotel'])],
  legs: [leg(100), leg(80), leg(60)],
})
const cum = (d: Day) => D.cumulativeM(d)
const round = (m: number | null) => (m == null ? null : Math.round(m / MI))

describe('where the rider is', () => {
  it('is the point’s own distance while parked at one', () => {
    const d = day()
    expect(round(R.distanceAtMoment(d, { pointIndex: 2, legIndex: null, legFraction: null }, cum(d)))).toBe(180)
  })

  // The reason legFraction was added at all: without it the dot can only ever
  // sit on one end of a leg, and a two-hour leg would jump.
  it('interpolates along a leg by its fraction', () => {
    const d = day()
    const at = (f: number) => ({ pointIndex: null, legIndex: 1, legFraction: f })
    expect(round(R.distanceAtMoment(d, at(0), cum(d)))).toBe(100)
    expect(round(R.distanceAtMoment(d, at(0.5), cum(d)))).toBe(140)
    expect(round(R.distanceAtMoment(d, at(1), cum(d)))).toBe(180)
  })

  it('clamps a fraction outside 0..1 rather than running off the leg', () => {
    const d = day()
    expect(round(R.distanceAtMoment(d, { pointIndex: null, legIndex: 1, legFraction: 9 }, cum(d)))).toBe(180)
    expect(round(R.distanceAtMoment(d, { pointIndex: null, legIndex: 1, legFraction: -3 }, cum(d)))).toBe(100)
  })

  it('treats a missing fraction as the start of the leg', () => {
    const d = day()
    expect(round(R.distanceAtMoment(d, { pointIndex: null, legIndex: 1, legFraction: null }, cum(d)))).toBe(100)
  })

  // A moment in the overnight gap belongs to no day. Drawing the last known
  // position there would show a rider riding through the night.
  it('is null when the moment is on no day', () => {
    const d = day()
    expect(R.distanceAtMoment(d, { pointIndex: null, legIndex: null, legFraction: null }, cum(d))).toBeNull()
    expect(R.distanceAtMoment(d, null, cum(d))).toBeNull()
  })

  it('is null on a day with no points', () => {
    expect(R.distanceAtMoment({ points: [], legs: [] }, { pointIndex: 0 }, [])).toBeNull()
  })
})

describe('fuel left in the tank', () => {
  // THE RING IS THE TANK. 300 miles of range, 120 miles in, on a day whose only
  // pump is at 100 — so the last fill was 100 and 20 miles have been burned.
  it('is the range minus the miles since the last fill', () => {
    const d = day()
    expect(round(R.remainingM(d, mi(120), cum(d), 'gas', mi(300)))).toBe(280)
  })

  // The whole point of the ring on a day with nothing planned: it shrinks
  // steadily and is gone exactly at the binding bike's max range.
  it('shrinks steadily and reaches zero at max range with no fuel stop planned', () => {
    const d: Day = {
      points: [stop('Home'), stop('Nowhere'), stop('End')],
      legs: [leg(100), leg(140)],
    }
    const at = (m: number) => round(R.remainingM(d, mi(m), cum(d), 'gas', mi(150)))
    expect(at(0)).toBe(150)
    expect(at(50)).toBe(100)
    expect(at(100)).toBe(50)
    expect(at(150)).toBe(0)
  })

  it('refills to the whole range at a fuel stop', () => {
    const d = day()
    expect(round(R.remainingM(d, mi(99), cum(d), 'gas', mi(150)))).toBe(51)
    expect(round(R.remainingM(d, mi(100), cum(d), 'gas', mi(150)))).toBe(150)
  })

  // Past dry the rider is not carrying negative fuel. The ring is simply gone.
  it('clamps at zero rather than going negative', () => {
    const d = day()
    expect(R.remainingM(d, mi(230), cum(d), 'gas', mi(50))).toBe(0)
  })

  // gas and charge are the same event on two kinds of machine. An electric
  // rider passing a Chevron has refuelled nothing.
  it('ignores a pump the binding bike cannot use', () => {
    const d = day()
    expect(round(R.remainingM(d, mi(120), cum(d), 'charge', mi(300)))).toBe(180)
  })

  // NULL IS NOT ZERO, and collapsing them would eventually make one a number.
  // Zero means the tank is empty; null means nobody measured it.
  it('is null when no range is known, never zero', () => {
    const d = day()
    expect(R.remainingM(d, mi(20), cum(d), 'gas', null)).toBeNull()
    expect(R.remainingM(d, mi(20), cum(d), 'gas', 0)).toBeNull()
    expect(R.remainingM(d, mi(20), cum(d), 'gas', -5)).toBeNull()
    expect(R.remainingM(d, null, cum(d), 'gas', mi(120))).toBeNull()
  })
})

describe('where the tank runs dry', () => {
  it('is the last fill plus the range', () => {
    const d = day()
    expect(round(R.dryDistanceM(d, mi(120), cum(d), 'gas', mi(120)))).toBe(220)
  })

  it('is null when the day ends before the tank does', () => {
    const d = day()
    expect(R.dryDistanceM(d, mi(120), cum(d), 'gas', mi(300))).toBeNull()
  })

  it('moves forward with each fill the rider passes', () => {
    const d = day()
    // Before Shell: dry at 150 on a 150-mile tank.
    expect(round(R.dryDistanceM(d, mi(10), cum(d), 'gas', mi(150)))).toBe(150)
    // After Shell, filled at 100: dry at 250, past the day's 240.
    expect(R.dryDistanceM(d, mi(120), cum(d), 'gas', mi(150))).toBeNull()
  })

  // It is a fact about the day, not about where the rider is. Dropping it once
  // passed made the map go quiet at exactly the moment the plan was worst.
  it('stays put once the rider is past it', () => {
    const d = day()
    expect(round(R.dryDistanceM(d, mi(200), cum(d), 'gas', mi(120)))).toBe(220)
  })

  it('is null when no range is known', () => {
    const d = day()
    expect(R.dryDistanceM(d, mi(20), cum(d), 'gas', null)).toBeNull()
  })
})

describe('the last fill', () => {
  it('is the start of the day before any pump', () => {
    const d = day()
    expect(R.lastFillM(d, mi(50), cum(d), 'gas')).toBe(0)
  })

  // Standing at the pump the tank is full, matching the reading sinceRefuelM()
  // gives that row in the day list.
  it('counts a pump the rider is standing on', () => {
    const d = day()
    expect(round(R.lastFillM(d, mi(100), cum(d), 'gas'))).toBe(100)
  })
})

describe('which points refuel', () => {
  it('reads the role off the point', () => {
    expect(R.isRefuel(stop('S', ['gas']), 'gas')).toBe(true)
    expect(R.isRefuel(stop('S', ['gas', 'food']), 'gas')).toBe(true)
    expect(R.isRefuel(stop('S', ['food']), 'gas')).toBe(false)
    expect(R.isRefuel(stop('S'), 'gas')).toBe(false)
    expect(R.isRefuel(null, 'gas')).toBe(false)
    expect(R.isRefuel(stop('S', ['gas']), null)).toBe(false)
  })
})
