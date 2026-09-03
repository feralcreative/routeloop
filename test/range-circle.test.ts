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

  // THIS TEST USED TO ASSERT THE BUG. It expected "dry at 150" for a rider ten
  // miles into the day, because dryDistanceM() read only the fill BEHIND them —
  // ignoring that they stop at Shell at 100 and set off again full. Fixed
  // 2026-08-31; the answer is the same before and after that pump because
  // reaching it was never in doubt.
  it('is the same before and after a fill the rider is going to make', () => {
    const d = day()
    // 150-mile tank, Shell at 100: filled there, dry at 250 and the day is 240.
    expect(R.dryDistanceM(d, mi(10), cum(d), 'gas', mi(150))).toBeNull()
    expect(R.dryDistanceM(d, mi(120), cum(d), 'gas', mi(150))).toBeNull()
  })

  it('is measured from a fill the rider cannot reach only if they reach it', () => {
    const d = day()
    // An 80-mile tank cannot get to Shell at 100, so the ride stops at 80 and
    // the pump beyond it changes nothing.
    expect(round(R.dryDistanceM(d, mi(10), cum(d), 'gas', mi(80)))).toBe(80)
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

describe('pumps the rider has not reached yet', () => {
  // THE REPORTED DEFECT, with the real ride's numbers. Home at 0 tagged gas, a
  // station at 108.6, the hotel at 209.7, on a 110-mile tank. dryDistanceM()
  // read only the fill BEHIND the rider, so it answered "dry at 110" — a mile
  // and a half past the pump they stop at — and the route went red from there
  // to the end of a day they finish with nine miles in hand. The day list said
  // "101 mi on this tank" at the hotel the whole time.
  const testRide = (): Day => ({
    points: [stop('Home', ['start', 'home', 'gas']), stop('Hopland', ['gas']), stop('Benbow', ['hotel', 'food'])],
    legs: [leg(108.6), leg(101.1)],
  })

  it('counts a fill the rider has yet to make', () => {
    const d = testRide()
    const c = cum(d)
    for (const at of [0, 50, 108.6, 150, 209]) {
      expect(R.dryDistanceM(d, mi(at), c, 'gas', mi(110))).toBeNull()
      expect(R.dryStretch(d, mi(at), c, 'gas', mi(110))).toBeNull()
    }
  })

  // The ring is the tank they are ON and must still reset at the pump, which is
  // why it is a separate function from the wall.
  it('still resets the ring at that pump', () => {
    const d = testRide()
    const c = cum(d)
    expect(round(R.fuelReachM(d, mi(50), c, 'gas', mi(110)))).toBe(110)
    expect(round(R.fuelReachM(d, mi(120), c, 'gas', mi(110)))).toBe(210)
  })

  // The first pump out of reach is where the ride stops, and the walk must
  // break there rather than skipping on to a later one it cannot get to.
  it('stops at the first pump it cannot reach', () => {
    const d: Day = {
      points: [stop('Home', ['gas']), stop('Far', ['gas']), stop('Further', ['gas']), stop('End')],
      legs: [leg(200), leg(50), leg(50)],
    }
    // 110-mile tank: Far at 200 is out of reach, so dry at 110 despite two
    // pumps sitting beyond it.
    expect(round(R.dryDistanceM(d, 0, cum(d), 'gas', mi(110)))).toBe(110)
  })

  it('chains through several fills it can reach', () => {
    const d: Day = {
      points: [stop('Home', ['gas']), stop('A', ['gas']), stop('B', ['gas']), stop('End')],
      legs: [leg(100), leg(100), leg(100)],
    }
    // Filled at 0, 100 and 200 on a 110-mile tank, so dry at 310 — past the
    // day's 300, which means the day is covered.
    expect(R.dryDistanceM(d, 0, cum(d), 'gas', mi(110))).toBeNull()
  })

  it('ignores a pump the binding bike cannot use when walking forward', () => {
    const d = testRide()
    // An electric bike passes both petrol pumps having refuelled nothing.
    expect(round(R.dryDistanceM(d, 0, cum(d), 'charge', mi(110)))).toBe(110)
  })
})

describe('the stretch that cannot be ridden', () => {
  // 110 miles of range and the pump five miles past empty — the case that was
  // reported. The red runs from the wall to the pump, not from the wall to
  // nowhere.
  it('runs from the wall to the next pump', () => {
    const d: Day = {
      points: [stop('Home', ['start']), stop('Shell', ['gas']), stop('End')],
      legs: [leg(115), leg(60)],
    }
    const c = cum(d)
    const s = R.dryStretch(d, mi(60), c, 'gas', mi(110))
    expect(round(s.from)).toBe(110)
    expect(round(s.to)).toBe(115)
  })

  // They do not make it, and the whole remainder is the part they cannot ride.
  // Stopping at the dry point would say the problem was a point rather than a
  // distance.
  it('runs to the end of the day when no pump follows', () => {
    const d: Day = { points: [stop('Home'), stop('End')], legs: [leg(300)] }
    const s = R.dryStretch(d, 0, cum(d), 'gas', mi(110))
    expect(round(s.from)).toBe(110)
    expect(round(s.to)).toBe(300)
  })

  it('goes when the rider refuels', () => {
    const d: Day = {
      points: [stop('Home', ['start']), stop('Shell', ['gas']), stop('End')],
      legs: [leg(115), leg(60)],
    }
    expect(R.dryStretch(d, mi(115), cum(d), 'gas', mi(110))).toBeNull()
  })

  it('is null on a day the tank covers, and when no range is known', () => {
    const d = day()
    expect(R.dryStretch(d, mi(10), cum(d), 'gas', mi(9999))).toBeNull()
    expect(R.dryStretch(d, mi(10), cum(d), 'gas', null)).toBeNull()
  })
})

describe('every point the tank runs out', () => {
  // ONE WALL PER TANKFUL. #220 is about knowing where fuel stops have to go,
  // and a single marker only ever answers that for the first one — on a
  // 700-mile day a rider needs to see all six, not be told about the first and
  // left to divide.
  it('marks each range interval across a day with no pumps', () => {
    const d: Day = { points: [stop('Benbow'), stop('Vancouver')], legs: [leg(797.7)] }
    expect(R.dryDistancesM(d, 0, cum(d), 'gas', mi(110)).map(round)).toEqual([110, 220, 330, 440, 550, 660, 770])
  })

  // A wall is a notional refuel: the rider has to stop there, so the tank after
  // it starts there. That is what makes the intervals read as "you need fuel
  // roughly here, here and here".
  it('starts each tank from the wall before it', () => {
    const d: Day = { points: [stop('A'), stop('B')], legs: [leg(250)] }
    expect(R.dryDistancesM(d, 0, cum(d), 'gas', mi(100)).map(round)).toEqual([100, 200])
  })

  it('is empty on a day the tank covers', () => {
    const d: Day = {
      points: [stop('Home', ['gas']), stop('Hopland', ['gas']), stop('Benbow')],
      legs: [leg(108.6), leg(101.1)],
    }
    expect(R.dryDistancesM(d, 0, cum(d), 'gas', mi(110))).toEqual([])
  })

  // A real pump resets the count the same way a wall does, so the first wall
  // after one is a full range beyond IT rather than beyond the day's start.
  it('counts from a real pump the rider reaches', () => {
    const d: Day = { points: [stop('A'), stop('Gas', ['gas']), stop('B')], legs: [leg(90), leg(210)] }
    expect(R.dryDistancesM(d, 0, cum(d), 'gas', mi(110)).map(round)).toEqual([200])
  })

  it('never puts a wall past the end of the day', () => {
    const d: Day = { points: [stop('A'), stop('B')], legs: [leg(250)] }
    const total = 250
    for (const w of R.dryDistancesM(d, 0, cum(d), 'gas', mi(100))) {
      expect(w / MI).toBeLessThanOrEqual(total)
    }
  })

  it('is empty when no range is known', () => {
    const d: Day = { points: [stop('A'), stop('B')], legs: [leg(250)] }
    expect(R.dryDistancesM(d, 0, cum(d), 'gas', null)).toEqual([])
    expect(R.dryDistancesM(d, null, cum(d), 'gas', mi(100))).toEqual([])
  })

  // The red stretch and the ring both key off the first one, so the two must
  // not be able to drift apart.
  it('agrees with dryDistanceM on the first wall', () => {
    const d: Day = { points: [stop('A'), stop('B')], legs: [leg(250)] }
    const all = R.dryDistancesM(d, 0, cum(d), 'gas', mi(100))
    expect(R.dryDistanceM(d, 0, cum(d), 'gas', mi(100))).toBe(all[0])
  })
})

// WHAT COLOR THE RING IS, as a function of how much of the tank is gone (#s
// raised 2026-09-02). Green through the first half, amber past it, red from
// three quarters — the ring is the one part of the fuel overlay that reports a
// quantity, where the E markers and the closed stretch report a verdict.
describe('how much of the tank is gone', () => {
  const RANGE_M = 100_000

  // A day with a pump at 40km, so the tank resets there.
  const day = {
    points: [{ roles: [] }, { roles: ['gas'] }, { roles: [] }],
    legs: [{ distanceM: 40_000 }, { distanceM: 120_000 }],
  }
  const cum = [0, 40_000, 160_000]

  it('is null when nothing can say, which is not zero', () => {
    expect(R.tankUsed(day, null, cum, 'gas', RANGE_M)).toBeNull()
    // No bike on file is the common case, not the edge one. Zero would claim a
    // full tank, which is a claim nobody made.
    expect(R.tankUsed(day, 20_000, cum, 'gas', null)).toBeNull()
    expect(R.tankUsed(day, 20_000, cum, 'gas', 0)).toBeNull()
  })

  it('measures from the start of the day before any pump', () => {
    expect(R.tankUsed(day, 25_000, cum, 'gas', RANGE_M)).toBeCloseTo(0.25, 5)
  })

  // THE TANK, NOT THE DAY. A rider who fills at 40km is back to a full tank on
  // the far side of it, however far into the ride they are.
  it('resets at a pump the rider has passed', () => {
    expect(R.tankUsed(day, 40_000, cum, 'gas', RANGE_M)).toBe(0)
    expect(R.tankUsed(day, 90_000, cum, 'gas', RANGE_M)).toBeCloseTo(0.5, 5)
  })

  it('does not count a pump for a bike that does not drink from it', () => {
    // charge and gas are the same event seen from two kinds of machine.
    expect(R.tankUsed(day, 90_000, cum, 'charge', RANGE_M)).toBeCloseTo(0.9, 5)
  })

  it('caps at one rather than reporting a fraction nothing reads', () => {
    expect(R.tankUsed(day, 160_000, cum, 'gas', RANGE_M)).toBe(1)
  })
})

describe('the ring tone', () => {
  it('is green through the first half of the tank', () => {
    expect(R.ringTone(0)).toBe('go')
    expect(R.ringTone(0.25)).toBe('go')
    // THE BOUNDARY GOES TO THE CALMER COLOR: at exactly half a tank the rider
    // has half a tank, which is not yet a thing to worry about.
    expect(R.ringTone(0.5)).toBe('go')
  })

  it('is amber past half and red from three quarters', () => {
    expect(R.ringTone(0.51)).toBe('warning')
    expect(R.ringTone(0.74)).toBe('warning')
    expect(R.ringTone(0.75)).toBe('stop')
    expect(R.ringTone(1)).toBe('stop')
  })

  it('falls back to red when there is no fraction', () => {
    expect(R.ringTone(null)).toBe('stop')
    expect(R.ringTone(undefined)).toBe('stop')
  })
})
