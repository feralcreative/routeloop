// How far into the day, and how far since the last fuel stop (#220).
//
// day-distance.js is a plain IIFE that assigns window.TBDistance, so it loads by
// evaluating it against a stub global rather than importing — the same
// arrangement as ride-time.js, twist.js and the other pure client helpers.
//
// The case worth stating up front, because it is the one that looks like a bug:
// a refuelling stop reads ZERO at its own row. Standing at the pump you have
// gone no distance on this tank, and the question the row is answering is how
// far the next one is.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

type Point = { kind: 'stop' | 'poi'; name?: string; roles?: string[] }
type Leg = { distanceM: number }
type Day = { points: Point[]; legs: Leg[] }

let D: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/day-distance.js', 'utf8'))(win)
  D = win.TBDistance
})

const MI = 1609.344
const mi = (n: number) => n * MI

const stop = (name: string, roles: string[] = []): Point => ({ kind: 'stop', name, roles })
const poi = (name: string, roles: string[] = []): Point => ({ kind: 'poi', name, roles })
const leg = (miles: number): Leg => ({ distanceM: mi(miles) })

/** Home → 100mi → Gas → 80mi → Lunch → 60mi → Motel */
const day = (): Day => ({
  points: [stop('Home', ['start']), stop('Shell', ['gas']), stop('Lunch', ['food']), stop('Motel', ['hotel'])],
  legs: [leg(100), leg(80), leg(60)],
})

describe('cumulative distance', () => {
  it('starts at zero and sums the legs before each point', () => {
    expect(D.cumulativeM(day()).map((m: number) => Math.round(m / MI))).toEqual([0, 100, 180, 240])
  })

  it('is always as long as the points array, so a row index indexes it', () => {
    const d = day()
    expect(D.cumulativeM(d)).toHaveLength(d.points.length)
  })

  // A POI is ON the route and anchors a leg. Skipping them would under-report
  // every distance after the first one.
  it('counts a POI like any other point', () => {
    const d: Day = {
      points: [stop('Home'), poi('Overlook'), stop('Motel')],
      legs: [leg(40), leg(60)],
    }
    expect(D.cumulativeM(d).map((m: number) => Math.round(m / MI))).toEqual([0, 40, 100])
  })

  // Mid-edit reality: a stop dropped on the map has no leg until the router
  // answers, and the row still has to render.
  it('treats an unrouted leg as zero rather than breaking the sum', () => {
    const d: Day = {
      points: [stop('A'), stop('B'), stop('C')],
      legs: [{ distanceM: 0 }, leg(50)],
    }
    expect(D.cumulativeM(d).map((m: number) => Math.round(m / MI))).toEqual([0, 0, 50])
  })

  it('survives a day with fewer legs than it needs', () => {
    const d: Day = { points: [stop('A'), stop('B'), stop('C')], legs: [leg(30)] }
    expect(D.cumulativeM(d).map((m: number) => Math.round(m / MI))).toEqual([0, 30, 30])
  })

  it('is empty for a day with no points', () => {
    expect(D.cumulativeM({ points: [], legs: [] })).toEqual([])
    expect(D.totalM({ points: [], legs: [] })).toBe(0)
  })

  it('totals the whole day', () => {
    expect(Math.round(D.totalM(day()) / MI)).toBe(240)
  })
})

describe('distance since the last refuel', () => {
  it('counts from the start of the day until the first fuel stop', () => {
    expect(D.sinceRefuelM(day(), 'gas').map((m: number) => Math.round(m / MI))).toEqual([0, 0, 80, 140])
  })

  // THE READING THAT LOOKS WRONG AND IS NOT. At the pump the tank is full, so
  // the row reads zero rather than the 100 miles that got you there.
  it('resets to zero at the fuel stop itself', () => {
    expect(Math.round(D.sinceRefuelM(day(), 'gas')[1] / MI)).toBe(0)
  })

  it('resets again at every subsequent fuel stop', () => {
    const d: Day = {
      points: [stop('Home'), stop('Shell', ['gas']), stop('Arco', ['gas']), stop('Motel')],
      legs: [leg(100), leg(90), leg(70)],
    }
    expect(D.sinceRefuelM(d, 'gas').map((m: number) => Math.round(m / MI))).toEqual([0, 0, 0, 70])
  })

  it('is just the cumulative distance on a day with no fuel stop at all', () => {
    const d: Day = { points: [stop('A'), stop('B'), stop('C')], legs: [leg(50), leg(60)] }
    expect(D.sinceRefuelM(d, 'gas')).toEqual(D.cumulativeM(d))
  })

  // gas and charge are the same event seen from two kinds of bike. An electric
  // rider passing a Chevron has refuelled nothing.
  it('ignores a gas stop when the bike takes charge, and the reverse', () => {
    const d: Day = {
      points: [stop('Home'), stop('Shell', ['gas']), stop('Supercharger', ['charge']), stop('Motel')],
      legs: [leg(100), leg(50), leg(40)],
    }
    expect(D.sinceRefuelM(d, 'charge').map((m: number) => Math.round(m / MI))).toEqual([0, 100, 0, 40])
    expect(D.sinceRefuelM(d, 'gas').map((m: number) => Math.round(m / MI))).toEqual([0, 0, 50, 90])
  })

  it('counts a fuel stop that also carries other categories', () => {
    const d: Day = {
      points: [stop('Home'), stop('Truck stop', ['gas', 'food']), stop('Motel')],
      legs: [leg(120), leg(60)],
    }
    expect(Math.round(D.sinceRefuelM(d, 'gas')[2] / MI)).toBe(60)
  })

  it('reads a point with no roles at all without throwing', () => {
    const d: Day = { points: [{ kind: 'stop' }, { kind: 'stop' }], legs: [leg(20)] }
    expect(D.sinceRefuelM(d, 'gas').map((m: number) => Math.round(m / MI))).toEqual([0, 20])
  })
})

describe('running dry', () => {
  it('finds the first point past the range', () => {
    // 240 miles total, one fuel stop at 100. The last leg puts 140 on the tank.
    expect(D.firstDryPoint(day(), 'gas', mi(120))).toBe(3)
  })

  it('is null when every gap is inside the range', () => {
    expect(D.firstDryPoint(day(), 'gas', mi(200))).toBeNull()
  })

  // NULL MEANS NOBODY MEASURED IT. A warning built on an invented range is worse
  // than no warning because it looks like one — the same argument null
  // twistiness makes.
  it('is null when no range is known, and never a guess', () => {
    expect(D.firstDryPoint(day(), 'gas', null)).toBeNull()
    expect(D.firstDryPoint(day(), 'gas', undefined)).toBeNull()
  })

  it('treats a zero or negative range as unknown rather than as always dry', () => {
    expect(D.firstDryPoint(day(), 'gas', 0)).toBeNull()
    expect(D.firstDryPoint(day(), 'gas', -1)).toBeNull()
  })

  // A day already wrong at point 2 is wrong at 3 and 4 as well. Flagging all of
  // them turns one problem into a column of red.
  it('reports only the first breach', () => {
    const d: Day = {
      points: [stop('A'), stop('B'), stop('C'), stop('D')],
      legs: [leg(200), leg(200), leg(200)],
    }
    expect(D.firstDryPoint(d, 'gas', mi(150))).toBe(1)
  })

  it('does not flag a point sitting exactly on the range', () => {
    const d: Day = { points: [stop('A'), stop('B')], legs: [leg(150)] }
    expect(D.firstDryPoint(d, 'gas', mi(150))).toBeNull()
  })
})
