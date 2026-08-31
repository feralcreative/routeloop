// Cutting one day into two (#49, and #54's mechanic).
//
// The property that matters most is that nothing is lost and nothing is
// invented: every leg the rider drew ends up on exactly one of the two days, and
// no leg is created. A split that re-routed would spend a Routes call per leg
// and could come back with a different road than the one on screen.
//
// The second is that the split point exists on BOTH days — you ride to the hotel
// and you set off from it — with a distinct uid on the copy, because
// `points.uid` is the identity that survives every save and two points sharing
// one collide.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

type Point = { uid: string; kind: 'stop' | 'poi'; lat: number; lng: number; name: string; roles?: string[] }
type Leg = { distanceM: number }
type Day = {
  uid: string
  title: string
  color: string
  startAt: string | null
  endAt: string | null
  altGroup: number | null
  altActive: boolean
  subgroupUid: string | null
  points: Point[]
  legs: Leg[]
}

let S: any
let D: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/day-split.js', 'utf8'))(win)
  new Function('window', readFileSync('public/js/day-distance.js', 'utf8'))(win)
  S = win.TBSplit
  D = win.TBDistance
})

let n = 0
const mint = () => `u${String(++n).padStart(11, '0')}`

const MI = 1609.344
const pt = (name: string, roles: string[] = []): Point => ({
  uid: mint(),
  kind: 'stop',
  lat: 37 + Math.random() * 0.001,
  lng: -122,
  name,
  roles,
})
const leg = (miles: number): Leg => ({ distanceM: miles * MI })

/** Home → 100 → Shell → 90 → Hotel → 80 → Lunch → 70 → End */
const day = (): Day => ({
  uid: 'day000000001',
  title: 'A long one',
  color: '#0000cc',
  startAt: '2026-08-01T09:00:00.000Z',
  endAt: null,
  altGroup: null,
  altActive: true,
  subgroupUid: null,
  points: [pt('Home', ['start']), pt('Shell', ['gas']), pt('Hotel', ['hotel']), pt('Lunch', ['food']), pt('End')],
  legs: [leg(100), leg(90), leg(80), leg(70)],
})

describe('where a day may be cut', () => {
  it('offers every interior point', () => {
    expect(S.splitPoints(day())).toEqual([1, 2, 3])
  })

  // Splitting at either end leaves a day with one point and no legs — a day that
  // goes nowhere, which the API refuses and payload() drops whole.
  it('refuses the first and last point', () => {
    const d = day()
    expect(S.canSplitAt(d, 0)).toBe(false)
    expect(S.canSplitAt(d, d.points.length - 1)).toBe(false)
    expect(S.splitDayAt(d, 0, mint)).toBeNull()
  })

  it('refuses an out-of-range or non-integer index', () => {
    expect(S.canSplitAt(day(), -1)).toBe(false)
    expect(S.canSplitAt(day(), 99)).toBe(false)
    expect(S.canSplitAt(day(), 1.5)).toBe(false)
  })

  it('offers nothing on a day too short to cut', () => {
    const short: Day = { ...day(), points: [pt('A'), pt('B')], legs: [leg(10)] }
    expect(S.splitPoints(short)).toEqual([])
    expect(S.splitIndexAtDistance(short, 5 * MI, D.cumulativeM)).toBeNull()
  })
})

describe('the cut itself', () => {
  it('puts the split point at the end of the first day and the start of the second', () => {
    const r = S.splitDayAt(day(), 2, mint)
    expect(r.first.points.map((p: Point) => p.name)).toEqual(['Home', 'Shell', 'Hotel'])
    expect(r.second.points.map((p: Point) => p.name)).toEqual(['Hotel', 'Lunch', 'End'])
  })

  // NOTHING LOST, NOTHING INVENTED. Four legs in, four legs out, split 2/2.
  it('hands every leg to exactly one side and creates none', () => {
    const d = day()
    const r = S.splitDayAt(d, 2, mint)
    expect(r.first.legs).toHaveLength(2)
    expect(r.second.legs).toHaveLength(2)
    expect(r.first.legs.concat(r.second.legs)).toEqual(d.legs)
  })

  it('leaves each half with one fewer leg than it has points', () => {
    for (const i of [1, 2, 3]) {
      const r = S.splitDayAt(day(), i, mint)
      expect(r.first.legs).toHaveLength(r.first.points.length - 1)
      expect(r.second.legs).toHaveLength(r.second.points.length - 1)
    }
  })

  // THE COLLISION THAT WOULD BE SILENT. points.uid is the identity that survives
  // the delete-and-reinsert of every save; two points sharing one would have the
  // merge, the comments and the point details all pointing at the wrong row.
  it('gives the carried copy a uid of its own', () => {
    const d = day()
    const r = S.splitDayAt(d, 2, mint)
    const original = r.first.points[2]
    const copy = r.second.points[0]
    expect(copy.uid).not.toBe(original.uid)
    expect(copy.name).toBe(original.name)
    expect(copy.lat).toBe(original.lat)
    expect(copy.lng).toBe(original.lng)
  })

  it('gives the new day a uid of its own', () => {
    const d = day()
    const r = S.splitDayAt(d, 2, mint)
    expect(r.first.uid).toBe(d.uid)
    expect(r.second.uid).not.toBe(d.uid)
  })

  // The hotel is recorded once, on the day that rode to it. Duplicating the tag
  // would double-count it everywhere roles are summed — including the fuel math,
  // which would read a copied `gas` as a second refuelling stop.
  it('strips the roles from the carried copy and leaves the original tagged', () => {
    const r = S.splitDayAt(day(), 2, mint)
    expect(r.first.points[2].roles).toEqual(['hotel'])
    expect(r.second.points[0].roles).toEqual([])
  })

  it('carries the copy as a stop, so the new day is never all POIs', () => {
    const d = day()
    d.points[2].kind = 'poi'
    const r = S.splitDayAt(d, 2, mint)
    expect(r.second.points[0].kind).toBe('stop')
  })

  it('does not mutate the day it was given', () => {
    const d = day()
    const before = JSON.parse(JSON.stringify(d))
    S.splitDayAt(d, 2, mint)
    expect(d).toEqual(before)
  })

  it('keeps the ride-level facts on the first half', () => {
    const d = day()
    const r = S.splitDayAt(d, 2, mint)
    expect(r.first.title).toBe(d.title)
    expect(r.first.color).toBe(d.color)
    expect(r.first.startAt).toBe(d.startAt)
  })

  // Two alternates are two answers to the same stretch of road. Cutting one in
  // half leaves a group whose members no longer cover the same ground.
  it('never hands an alt grouping to the new day', () => {
    const d: Day = { ...day(), altGroup: 3, altActive: false }
    const r = S.splitDayAt(d, 2, mint)
    expect(r.second.altGroup).toBeNull()
    expect(r.second.altActive).toBe(true)
  })

  it('leaves the new day undated for the caller to seed', () => {
    const r = S.splitDayAt(day(), 2, mint)
    expect(r.second.startAt).toBeNull()
    expect(r.second.endAt).toBeNull()
  })
})

describe('cutting at a distance', () => {
  // Cumulative: Home 0, Shell 100, Hotel 190, Lunch 270, End 340.
  it('finds the point nearest the target', () => {
    expect(S.splitIndexAtDistance(day(), 190 * MI, D.cumulativeM)).toBe(2)
    expect(S.splitIndexAtDistance(day(), 105 * MI, D.cumulativeM)).toBe(1)
  })

  // NEAREST, NOT FIRST-PAST. Asking for 300 with points at 270 and 340 means
  // 270; first-past hands back a 40-mile overshoot on a number chosen on purpose.
  it('goes back rather than overshooting', () => {
    expect(S.splitIndexAtDistance(day(), 300 * MI, D.cumulativeM)).toBe(3)
    expect(S.splitIndexAtDistance(day(), 200 * MI, D.cumulativeM)).toBe(2)
  })

  it('clamps to a legal cut rather than the true nearest point', () => {
    // 0 is nearest to a target of zero, but it is not a legal split.
    expect(S.splitIndexAtDistance(day(), 0, D.cumulativeM)).toBe(1)
    // And the far end lands on the last interior point, never the final one.
    expect(S.splitIndexAtDistance(day(), 9999 * MI, D.cumulativeM)).toBe(3)
  })

  // A shorter first day is the recoverable mistake — the rider adds to it. The
  // longer one means riding past where they meant to stop.
  it('keeps the earlier point on a tie', () => {
    const d: Day = {
      ...day(),
      points: [pt('A'), pt('B'), pt('C'), pt('D')],
      legs: [leg(100), leg(100), leg(100)],
    }
    // B is at 100 and C at 200; a target of 150 is equidistant.
    expect(S.splitIndexAtDistance(d, 150 * MI, D.cumulativeM)).toBe(1)
  })
})
