// The trip time model: what is happening at a given moment on a given day.
//
// Ported from a scratch suite that was rewritten three times across the timeline
// sprints. ride-time.js is a plain IIFE that assigns window.TBTime, so it loads
// by evaluating it against a stub global rather than importing.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

type Leg = { durationS: number; distanceM: number }
type Stop = { name?: string; durationMin: number | null }
type Poi = { name?: string; durationMin: number | null; distFromStartMi?: number }
type Route = { startAt: string | null; endAt: string | null; stops: Stop[]; pois?: Poi[]; legs: Leg[] }

let T: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/ride-time.js', 'utf8'))(win)
  T = win.TBTime
})

const leg = (durationS: number, distanceM = 1000): Leg => ({ durationS, distanceM })
const stop = (name: string, durationMin: number | null = null): Stop => ({ name, durationMin })
const at = (iso: string) => new Date(iso).toISOString()

const day = (): Route => ({
  startAt: at('2026-08-01T09:00'),
  endAt: null,
  stops: [stop('Home'), stop('Lunch', 120), stop('Motel')],
  pois: [],
  legs: [leg(3600), leg(1800)],
})

describe('leg duration', () => {
  it('keeps a duration the router returned', () => {
    expect(T.legDurationS(leg(3600))).toBe(3600)
  })

  it('estimates from distance when the router never answered', () => {
    // 40km at the nominal 20 m/s.
    expect(T.legDurationS(leg(0, 40000))).toBe(2000)
  })

  it('leaves a zero-distance leg at zero rather than estimating', () => {
    expect(T.legDurationS(leg(0, 0))).toBe(0)
    expect(T.legIsEstimated(leg(0, 0))).toBe(false)
  })

  it('flags an imported ride, which carries distance and no duration', () => {
    const imported = { durationS: 0, distanceM: 297748 }
    expect(T.legIsEstimated(imported)).toBe(true)
    expect(T.legDurationS(imported)).toBe(Math.round(297748 / 20))
  })
})

describe('elapsed time', () => {
  it('is riding plus every planned stop, not riding alone', () => {
    expect(T.dayElapsedS(day())).toBe(3600 + 7200 + 1800)
  })

  it('splits riding from stopped', () => {
    expect(T.dayRidingS(day())).toBe(5400)
    expect(T.dayStoppedS(day())).toBe(7200)
  })
})

describe('walking a day', () => {
  const walk = (minutes: number) => T.activeAt(day(), minutes * 60)

  it('starts on the first leg', () => {
    expect(walk(0)).toEqual({ legIndex: 0, stopIndex: null, poiIndex: null })
  })

  it('is parked at the stop once the leg is done', () => {
    expect(walk(60)).toEqual({ legIndex: null, stopIndex: 1, poiIndex: null })
    expect(walk(119)).toEqual({ legIndex: null, stopIndex: 1, poiIndex: null })
  })

  it('rides again when the dwell ends', () => {
    expect(walk(180)).toEqual({ legIndex: 1, stopIndex: null, poiIndex: null })
  })

  it('parks at the final stop past the end of the day', () => {
    expect(walk(999)).toEqual({ legIndex: null, stopIndex: 2, poiIndex: null })
  })

  it('reports no leg at all while parked', () => {
    // The whole reason the map highlights nothing at a stop: claiming a leg
    // would put a line where the rider is not.
    expect(walk(90).legIndex).toBeNull()
  })
})

describe('placing a moment across days', () => {
  const day2 = (): Route => ({
    startAt: at('2026-08-02T08:00'),
    endAt: null,
    stops: [stop('Motel'), stop('Home')],
    legs: [leg(3600)],
  })
  const both = () => {
    const a = day()
    const b = day2()
    a.endAt = new Date((T.dayStartS(a) + T.dayElapsedS(a)) * 1000).toISOString()
    b.endAt = new Date((T.dayStartS(b) + T.dayElapsedS(b)) * 1000).toISOString()
    return [a, b]
  }
  const secs = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

  it('finds the right day', () => {
    expect(T.activeAtMoment(both(), secs('2026-08-01T09:30')).dayIndex).toBe(0)
    expect(T.activeAtMoment(both(), secs('2026-08-02T08:30')).dayIndex).toBe(1)
  })

  it('gives the overnight gap to neither day', () => {
    expect(T.activeAtMoment(both(), secs('2026-08-01T20:00'))).toEqual({
      dayIndex: null,
      legIndex: null,
      stopIndex: null,
      poiIndex: null,
    })
  })
})

describe('trip span', () => {
  it('covers a dated day', () => {
    const d = day()
    d.endAt = new Date((T.dayStartS(d) + T.dayElapsedS(d)) * 1000).toISOString()
    expect(T.rideSpan([d])).toEqual({
      from: Math.floor(new Date(at('2026-08-01T09:00')).getTime() / 1000),
      to: Math.floor(new Date(at('2026-08-01T12:30')).getTime() / 1000),
    })
  })

  it('is nothing at all for an undated ride', () => {
    expect(T.rideSpan([{ startAt: null, endAt: null, stops: [], pois: [], legs: [] }])).toBeNull()
  })

  it('does not let an undated day stretch it', () => {
    const d = day()
    d.endAt = new Date((T.dayStartS(d) + T.dayElapsedS(d)) * 1000).toISOString()
    const undated = { startAt: null, endAt: null, stops: [stop('X')], pois: [], legs: [] }
    expect(T.rideSpan([d, undated])).toEqual(T.rideSpan([d]))
  })

  it('falls back to elapsed when a day has a start but no stored end', () => {
    const d = day()
    expect(T.rideSpan([d])!.to).toBe(T.dayStartS(d) + T.dayElapsedS(d))
  })
})

// Two alternates for the same day cover the same hours. Without the skip the
// timeline puts the rider on both and returns whichever the array lists first.
describe('a losing alternate is not on the schedule', () => {
  const dated = (startIso: string, hours: number): any => ({
    startAt: at(startIso),
    endAt: at(new Date(new Date(startIso).getTime() + hours * 3600e3).toISOString()),
    stops: [stop('A'), stop('B')],
    pois: [],
    legs: [leg(hours * 3600)],
    altGroup: null,
    altActive: true,
  })
  const secs = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

  it('is left out of the ride span', () => {
    const plain = dated('2026-08-01T09:00', 3)
    const ghost = { ...dated('2026-08-01T09:00', 12), altGroup: 0, altActive: false }
    const active = { ...dated('2026-08-01T09:00', 3), altGroup: 0, altActive: true }
    // The 12-hour alternate must not stretch the timeline to midnight.
    expect(T.rideSpan([plain, active, ghost])).toEqual(T.rideSpan([plain, active]))
  })

  it('never becomes the day at a moment', () => {
    const ghost = { ...dated('2026-08-01T09:00', 6), altGroup: 0, altActive: false }
    const active = { ...dated('2026-08-01T09:00', 6), altGroup: 0, altActive: true }
    expect(T.activeAtMoment([ghost, active], secs('2026-08-01T10:00')).dayIndex).toBe(1)
  })

  // THE INDEX TRAP. Skipping inside the module keeps dayIndex an index into the
  // caller's own array; filtering the array before calling would return 1 here
  // and both clients would highlight the wrong day.
  it('returns an index into the unfiltered array', () => {
    const ghost = { ...dated('2026-08-01T09:00', 6), altGroup: 0, altActive: false }
    const active = { ...dated('2026-08-01T09:00', 6), altGroup: 0, altActive: true }
    const later = dated('2026-08-03T09:00', 3)
    const days = [ghost, active, later]
    expect(T.activeAtMoment(days, secs('2026-08-03T10:00')).dayIndex).toBe(2)
    expect(days[T.activeAtMoment(days, secs('2026-08-03T10:00')).dayIndex]).toBe(later)
  })

  it('leaves an ungrouped day alone whatever altActive says', () => {
    const stale = { ...dated('2026-08-01T09:00', 3), altGroup: null, altActive: false }
    expect(T.rideSpan([stale])).not.toBeNull()
    expect(T.isLosingAlternate(stale)).toBe(false)
  })
})

describe('a POI you stop at', () => {
  // 40km of leg 0 then 20km of leg 1, so a POI at 20km sits halfway along the
  // first leg — 30 minutes into an hour of riding.
  const withPoi = (durationMin: number | null, mi: number): Route => ({
    startAt: at('2026-08-01T09:00'),
    endAt: null,
    stops: [stop('Home'), stop('Lunch', 120), stop('Motel')],
    pois: [{ name: 'Vista', durationMin, distFromStartMi: mi }],
    legs: [{ durationS: 3600, distanceM: 40000 }, { durationS: 1800, distanceM: 20000 }],
  })
  const MI = 1609.344

  it('adds its dwell to the day, so the day ends later', () => {
    const without = T.dayElapsedS(withPoi(null, 20000 / MI))
    expect(T.dayElapsedS(withPoi(30, 20000 / MI))).toBe(without + 1800)
  })

  it('costs nothing when you ride past without stopping', () => {
    expect(T.dayStoppedS(withPoi(null, 20000 / MI))).toBe(7200)
    expect(T.dayStoppedS(withPoi(0, 20000 / MI))).toBe(7200)
  })

  it('interrupts the leg it falls in, rather than waiting for the next stop', () => {
    const r = withPoi(30, 20000 / MI)
    // Half of leg 0 is 1800s of riding, then the POI holds for 1800s.
    expect(T.activeAt(r, 1799).legIndex).toBe(0)
    expect(T.activeAt(r, 1800)).toEqual({ legIndex: null, stopIndex: null, poiIndex: 0 })
    expect(T.activeAt(r, 3599)).toEqual({ legIndex: null, stopIndex: null, poiIndex: 0 })
    // ...and then the rest of leg 0 resumes.
    expect(T.activeAt(r, 3600).legIndex).toBe(0)
  })

  it('sits where its distance says, not where its array index does', () => {
    const early = withPoi(30, 5000 / MI)
    const late = withPoi(30, 35000 / MI)
    // 1/8 of the way along leg 0 versus 7/8 of the way.
    expect(T.activeAt(early, 500).poiIndex).toBe(0)
    expect(T.activeAt(late, 500).legIndex).toBe(0)
    expect(T.activeAt(late, 3200).poiIndex).toBe(0)
  })

  it('takes its time at the end when it projects past the last leg', () => {
    const r = withPoi(30, 999)
    expect(T.dayElapsedS(r)).toBe(3600 + 1800 + 7200 + 1800)
  })
})

describe('the schedule and the elapsed time cannot disagree', () => {
  // dayElapsedS drives every stored end time and the whole timeline slider,
  // while daySchedule drives what the map highlights. If they ever diverge the
  // slider would run off the end of the day, so this is the invariant that
  // matters most in this file.
  const cases: Route[] = [
    day(),
    { ...day(), pois: [{ durationMin: 45, distFromStartMi: 10 }] },
    { ...day(), pois: [{ durationMin: 20, distFromStartMi: 0 }, { durationMin: 20, distFromStartMi: 99 }] },
    { ...day(), pois: [{ durationMin: null, distFromStartMi: 5 }] },
    { startAt: null, endAt: null, stops: [stop('Only')], pois: [], legs: [] },
  ]

  it.each(cases.map((c, i) => [i, c] as const))('holds for case %i', (_i, day) => {
    const segs = T.daySchedule(day)
    const total = segs.length ? segs[segs.length - 1].end : 0
    expect(total).toBeCloseTo(T.dayElapsedS(day), 6)
  })

  it('never emits a gap or an overlap', () => {
    const segs = T.daySchedule(cases[2])
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBeCloseTo(segs[i - 1].end, 6)
  })
})

describe('a day with fewer legs than its stops imply', () => {
  // THIS WAS A LIVE BUG, and it is the reason the shape is worth a test of its
  // own. daySchedule walks stops and legs together and stops dead at the first
  // missing leg. Every imported ride used to be stored as ONE leg holding the
  // whole track however many stops sat on it — so from stop 1 onward, every
  // dwell was silently dropped from the day and the timeline ran short by
  // exactly that much. Nothing said so; the slider just ended early.
  //
  // Imports are split into real legs now (src/maps/track-split.ts) and the
  // builder fills any gap on load (fillMissingLegs in builder.js), so the shape
  // should no longer reach here from either direction. This pins the arithmetic
  // for the day one of those paths regresses, because the symptom is a number
  // being quietly too small rather than anything failing.
  const truncated: Route = {
    startAt: at('2026-08-01T09:00'),
    endAt: null,
    stops: [stop('Start'), stop('Lunch', 60), stop('Fuel', 30), stop('Motel')],
    pois: [],
    legs: [leg(3600, 72000)],
  }

  it('still counts the dwell of stops past the last leg', () => {
    const segs = T.daySchedule(truncated)
    const dwelled = segs.filter((s: { kind: string }) => s.kind === 'stop').map((s: { index: number }) => s.index)
    // Lunch is stop 1 and Fuel is stop 2. Before the fix the walk broke after
    // stop 0's leg and Fuel never appeared at all.
    expect(dwelled).toContain(1)
    expect(dwelled).toContain(2)
  })

  it('keeps the schedule and the elapsed time in agreement', () => {
    const segs = T.daySchedule(truncated)
    const total = segs.length ? segs[segs.length - 1].end : 0
    expect(total).toBeCloseTo(T.dayElapsedS(truncated), 6)
  })
})
