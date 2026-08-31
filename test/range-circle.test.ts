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

describe('how far the fuel reaches', () => {
  // THE DEFECT THIS EXISTS FOR. Reported from a test ride with the pump set a
  // few miles past empty: the ring shrank to nothing, the rider rode through
  // the pump, and it never came back. The refuel was detected the whole time —
  // the new dry point simply landed past the end of the day, so there was
  // nothing left to point at and the ring was drawn from that.
  it('comes back after a refuel whose tank then outlasts the day', () => {
    const d: Day = {
      points: [stop('Home', ['start']), stop('Shell', ['gas']), stop('End')],
      legs: [leg(105), leg(45)],
    }
    const c = cum(d)
    // Before the pump: the ring reaches the dry point at 100.
    expect(round(R.fuelReachM(d, mi(50), c, 'gas', mi(100)))).toBe(100)
    // Past it: 105 + 100 is beyond the day, so it reaches the day's end.
    expect(round(R.fuelReachM(d, mi(110), c, 'gas', mi(100)))).toBe(150)
    // ...and there is no wall, because the rider does not run out.
    expect(R.dryDistanceM(d, mi(110), c, 'gas', mi(100))).toBeNull()
  })

  it('is the dry point when the tank runs out first', () => {
    const d = day()
    expect(round(R.fuelReachM(d, mi(120), cum(d), 'gas', mi(120)))).toBe(220)
  })

  it('never reaches past the end of the day', () => {
    const d = day()
    expect(round(R.fuelReachM(d, mi(10), cum(d), 'gas', mi(9999)))).toBe(240)
  })

  it('is null when no range is known', () => {
    const d = day()
    expect(R.fuelReachM(d, mi(20), cum(d), 'gas', null)).toBeNull()
    expect(R.fuelReachM(d, null, cum(d), 'gas', mi(120))).toBeNull()
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
