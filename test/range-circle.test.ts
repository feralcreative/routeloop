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

describe('what the circle reaches to', () => {
  // 300 miles of range, filled at mile 100. Dry at 400, past the day's 240, and
  // there is no pump after Shell — so nothing to point at and nothing wrong.
  it('is nothing when the day ends before the tank does', () => {
    const d = day()
    expect(R.fuelTargetAt(d, mi(120), cum(d), 'gas', mi(300))).toBeNull()
  })

  // 120 miles of range, filled at 100, so dry at 220 — inside the day, and no
  // pump before it. This is the warning.
  it('is the dry point when the tank runs out first', () => {
    const d = day()
    const t = R.fuelTargetAt(d, mi(120), cum(d), 'gas', mi(120))
    expect(t.kind).toBe('dry')
    expect(round(t.distM)).toBe(220)
  })

  it('is the next pump when one comes first', () => {
    const d = day()
    const t = R.fuelTargetAt(d, mi(20), cum(d), 'gas', mi(300))
    expect(t.kind).toBe('fuel')
    expect(round(t.distM)).toBe(100)
  })

  // A zero-radius circle says nothing, and the question standing at a pump is
  // what comes after it.
  it('looks past a pump the rider is standing on', () => {
    const d: Day = {
      points: [stop('Home'), stop('Shell', ['gas']), stop('Arco', ['gas']), stop('End')],
      legs: [leg(100), leg(90), leg(70)],
    }
    const t = R.fuelTargetAt(d, mi(100), cum(d), 'gas', mi(300))
    expect(t.kind).toBe('fuel')
    expect(round(t.distM)).toBe(190)
  })

  // The tank refills at every pump passed, so the dry point moves forward with
  // the rider rather than being fixed from the start of the day.
  it('measures dry from the last pump passed, not from the day’s start', () => {
    const d = day()
    // Before Shell: dry at 150 with a 150-mile tank.
    expect(round(R.fuelTargetAt(d, mi(10), cum(d), 'gas', mi(150)).distM)).toBe(100)
    // After Shell: filled at 100, so dry at 250 — past the day.
    expect(R.fuelTargetAt(d, mi(120), cum(d), 'gas', mi(150))).toBeNull()
  })

  // gas and charge are the same event on two kinds of machine. An electric
  // rider passing a Chevron has refuelled nothing, so their dry point is
  // measured from the start of the day.
  it('ignores a pump the binding bike cannot use', () => {
    const d = day()
    const t = R.fuelTargetAt(d, mi(120), cum(d), 'charge', mi(150))
    expect(t.kind).toBe('dry')
    expect(round(t.distM)).toBe(150)
  })

  it('prefers the pump when it and the dry point coincide', () => {
    const d = day()
    // Filled at 0, 100 miles of range, dry exactly at Shell.
    expect(R.fuelTargetAt(d, mi(10), cum(d), 'gas', mi(100)).kind).toBe('fuel')
  })

  // NULL IS NOT A DEFAULT. A circle drawn for a bike with no range on file
  // implies somebody checked the rider could make it. Nobody did.
  it('is nothing when no range is known', () => {
    const d = day()
    expect(R.fuelTargetAt(d, mi(20), cum(d), 'gas', null)).toBeNull()
    expect(R.fuelTargetAt(d, mi(20), cum(d), 'gas', 0)).toBeNull()
    expect(R.fuelTargetAt(d, mi(20), cum(d), 'gas', -5)).toBeNull()
  })

  it('is nothing when there is no position to measure from', () => {
    const d = day()
    expect(R.fuelTargetAt(d, null, cum(d), 'gas', mi(120))).toBeNull()
  })

  // THE DEFECT THIS REPLACED A WRONG TEST FOR. An earlier version dropped a dry
  // point once the rider was past it, on the reasoning that a target behind you
  // is not a target. Measured on ride 15 — a 259-mile day on a 120-mile tank —
  // the warning showed for the first 46% of the day and then vanished, so the
  // map went quiet at exactly the moment the plan was worst.
  it('keeps pointing at the dry point after the rider passes it', () => {
    const d = day()
    const t = R.fuelTargetAt(d, mi(200), cum(d), 'gas', mi(120))
    expect(t.kind).toBe('dry')
    expect(round(t.distM)).toBe(220)
  })

  // Looks backwards and is not: a station the rider cannot reach on this tank
  // is not the answer to anything. Where they ran out is.
  it('prefers a dry point behind the rider to a pump they cannot reach', () => {
    const d: Day = {
      points: [stop('Home'), stop('Nowhere'), stop('Arco', ['gas']), stop('End')],
      legs: [leg(100), leg(80), leg(60)],
    }
    // 50 miles of range and no fill: dry at 50, the pump at 180, rider at 120.
    const t = R.fuelTargetAt(d, mi(120), cum(d), 'gas', mi(50))
    expect(t.kind).toBe('dry')
    expect(round(t.distM)).toBe(50)
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
