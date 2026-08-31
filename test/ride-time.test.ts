// The trip time model: what is happening at a given moment on a given day.
//
// Ported from a scratch suite that was rewritten three times across the timeline
// sprints. ride-time.js is a plain IIFE that assigns window.TBTime, so it loads
// by evaluating it against a stub global rather than importing.
//
// ONE DAY SHAPE, as of 2026-08-24: an ordered `points` array with a `kind` on
// each element, and `legs[i]` joining `points[i]` to `points[i+1]`. The module
// used to accept a second shape as well, because ride.json sent `stops` and
// `pois` as two arrays — see the header of ride-time.js for why that stopped
// being possible.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

type Leg = { durationS: number; distanceM: number }
type Point = { kind: 'stop' | 'poi'; name?: string; durationMin: number | null }
type Route = { startAt: string | null; endAt: string | null; points: Point[]; legs: Leg[] }

let T: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/ride-time.js', 'utf8'))(win)
  T = win.TBTime
})

const leg = (durationS: number, distanceM = 1000): Leg => ({ durationS, distanceM })
const stop = (name: string, durationMin: number | null = null): Point => ({ kind: 'stop', name, durationMin })
const poi = (name: string, durationMin: number | null = null): Point => ({ kind: 'poi', name, durationMin })
const at = (iso: string) => new Date(iso).toISOString()

const day = (): Route => ({
  startAt: at('2026-08-01T09:00'),
  endAt: null,
  points: [stop('Home'), stop('Lunch', 120), stop('Motel')],
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
    expect(walk(0)).toEqual({ legIndex: 0, pointIndex: null, legFraction: 0 })
  })

  it('is parked at the point once the leg is done', () => {
    expect(walk(60)).toEqual({ legIndex: null, pointIndex: 1, legFraction: null })
    expect(walk(119)).toEqual({ legIndex: null, pointIndex: 1, legFraction: null })
  })

  it('rides again when the dwell ends', () => {
    expect(walk(180)).toEqual({ legIndex: 1, pointIndex: null, legFraction: 0 })
  })

  it('parks at the final point past the end of the day', () => {
    expect(walk(999)).toEqual({ legIndex: null, pointIndex: 2, legFraction: null })
  })

  // WITHOUT THIS THE DOT CAN ONLY SIT ON A LEG'S ENDS. Leg 0 is an hour long,
  // so half an hour in is halfway along it — which is what puts the rider
  // somewhere on the road rather than jumping them from stop to stop.
  it('reports how far through the leg it is', () => {
    expect(walk(0).legFraction).toBe(0)
    expect(walk(30).legFraction).toBeCloseTo(0.5, 6)
    expect(walk(45).legFraction).toBeCloseTo(0.75, 6)
  })

  // FRACTION OF TIME, NOT OF DISTANCE. Time is the axis the scrubber moves
  // along, so a dot placed by it keeps step with the clock beside it; placing
  // it by distance would have it lag or race on any leg whose speed is not
  // constant, which is every real one.
  it('measures the fraction against the leg’s own duration', () => {
    // Leg 1 is half an hour and starts at minute 180, after the two-hour lunch.
    expect(walk(180).legFraction).toBe(0)
    expect(walk(195).legFraction).toBeCloseTo(0.5, 6)
  })

  it('has no fraction while parked at a point', () => {
    expect(walk(60).legFraction).toBeNull()
    expect(walk(999).legFraction).toBeNull()
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
    points: [stop('Motel'), stop('Home')],
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
      pointIndex: null,
      legFraction: null,
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
    expect(T.rideSpan([{ startAt: null, endAt: null, points: [], legs: [] }])).toBeNull()
  })

  it('does not let an undated day stretch it', () => {
    const d = day()
    d.endAt = new Date((T.dayStartS(d) + T.dayElapsedS(d)) * 1000).toISOString()
    const undated = { startAt: null, endAt: null, points: [stop('X')], legs: [] }
    expect(T.rideSpan([d, undated])).toEqual(T.rideSpan([d]))
  })

  it('falls back to elapsed when a day has a start but no stored end', () => {
    const d = day()
    expect(T.rideSpan([d])!.to).toBe(T.dayStartS(d) + T.dayElapsedS(d))
  })
})

// What the builder's timeline scrubs by default, since #222: a slider stretched
// over a 72-hour ride spends most of its travel on the overnights, and an hour
// of Saturday afternoon comes out too narrow to land on.
describe('day span', () => {
  it('is the day’s own extent', () => {
    const d = day()
    expect(T.daySpan(d)).toEqual({ from: T.dayStartS(d), to: T.dayEndS(d) })
  })

  it('never reaches past the day it was asked about', () => {
    const d = day()
    const next = { ...day(), startAt: at('2026-08-02T09:00') }
    expect(T.daySpan(d)).toEqual(T.daySpan({ ...d }))
    expect(T.daySpan(d)!.to).toBeLessThan(T.dayStartS(next))
  })

  it('is nothing at all for an undated day', () => {
    expect(T.daySpan({ startAt: null, endAt: null, points: [stop('X')], legs: [] })).toBeNull()
  })

  // A slider whose min equals its max is a control that cannot move, so the bar
  // hides rather than rendering one — same contract rideSpan has always had.
  it('is nothing for a dated day with nothing in it', () => {
    expect(T.daySpan({ startAt: at('2026-08-01T09:00'), endAt: null, points: [], legs: [] })).toBeNull()
  })

  it('falls back to elapsed when the day has a start but no stored end', () => {
    const d = day()
    expect(T.daySpan(d)!.to).toBe(T.dayStartS(d) + T.dayElapsedS(d))
  })

  // THE DELIBERATE DISAGREEMENT WITH rideSpan. A day the rider decided against
  // must not stretch the ride — but a rider who has clicked into that alternate
  // to work on it is looking at exactly that day, and refusing it a span would
  // hide the timeline on the one day they are editing.
  it('gives a losing alternate a span, where the ride span gives it none', () => {
    const ghost = { ...day(), altGroup: 0, altActive: false }
    expect(T.rideSpan([ghost])).toBeNull()
    expect(T.daySpan(ghost)).toEqual({ from: T.dayStartS(ghost), to: T.dayEndS(ghost) })
  })
})

// Two alternates for the same day cover the same hours. Without the skip the
// timeline puts the rider on both and returns whichever the array lists first.
describe('a losing alternate is not on the schedule', () => {
  const dated = (startIso: string, hours: number): any => ({
    startAt: at(startIso),
    endAt: at(new Date(new Date(startIso).getTime() + hours * 3600e3).toISOString()),
    points: [stop('A'), stop('B')],
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
    expect(T.isLosingAlt(stale)).toBe(false)
  })
})

// Ziad's call, 2026-08-24: a POI is something you at least ride BY. It is part of
// the route and anchors a leg like any other point, so its dwell falls on a leg
// boundary and every figure below is arrived at the same way it would be for a
// stop.
//
// WHAT THIS REPLACED, because the machinery was substantial and its absence is
// the point: a POI used to sit BESIDE the route with no place in the sequence, so
// daySchedule projected each one onto the day's concatenated track, sorted them by
// that distance, and cut the leg a POI landed inside at whatever fraction of the
// way along it sat. Callers had to compute those distances and thread them in as a
// `poiDistsM` argument or every POI reported distance 0 and stacked up at the
// start of the day. All of it is gone.
describe('a POI is on the road', () => {
  const withPoi = (durationMin: number | null): Route => ({
    startAt: at('2026-08-01T09:00'),
    endAt: null,
    points: [stop('Home'), poi('Vista', durationMin), stop('Lunch', 120), stop('Motel')],
    legs: [leg(1800, 20000), leg(1800, 20000), leg(1800, 20000)],
  })

  it('adds its dwell to the day, so the day ends later', () => {
    expect(T.dayElapsedS(withPoi(30))).toBe(T.dayElapsedS(withPoi(null)) + 1800)
  })

  it('costs nothing when you ride past without stopping', () => {
    expect(T.dayStoppedS(withPoi(null))).toBe(7200)
    expect(T.dayStoppedS(withPoi(0))).toBe(7200)
  })

  it('holds between the legs either side of it, never inside one', () => {
    const r = withPoi(30)
    expect(T.activeAt(r, 1799).legIndex).toBe(0)
    expect(T.activeAt(r, 1800)).toEqual({ legIndex: null, pointIndex: 1, legFraction: null })
    expect(T.activeAt(r, 3599)).toEqual({ legIndex: null, pointIndex: 1, legFraction: null })
    // ...and then the NEXT leg, not the rest of the one it interrupted.
    expect(T.activeAt(r, 3600).legIndex).toBe(1)
  })

  it('is placed by its position in the list, not by a distance', () => {
    // The array IS the sequence. A POI at the end of the list is ridden to last
    // whatever its coordinates would have projected to, which is the thing the
    // old distance-sorted walk could not express.
    const late: Route = {
      startAt: at('2026-08-01T09:00'),
      endAt: null,
      points: [stop('Home'), stop('Lunch', 120), stop('Motel'), poi('Vista', 30)],
      legs: [leg(1800), leg(1800), leg(1800)],
    }
    expect(T.activeAt(late, 0).legIndex).toBe(0)
    expect(T.activeAt(late, 1800).pointIndex).toBe(1)
    // Past every leg the day ends AT the POI, because that is where it ends.
    expect(T.activeAt(late, 99999).pointIndex).toBe(3)
  })

  it('gives a day of a stop and one POI a leg to draw', () => {
    // The report that changed the model. Nothing about the schedule was wrong
    // before — there was simply no leg, so there was no road and no riding time.
    const fresh: Route = {
      startAt: at('2026-08-01T09:00'),
      endAt: null,
      points: [stop('Start'), poi('Vista')],
      legs: [leg(1800, 20000)],
    }
    expect(T.dayRidingS(fresh)).toBe(1800)
    expect(T.activeAt(fresh, 0).legIndex).toBe(0)
  })
})

describe('the schedule and the elapsed time cannot disagree', () => {
  // dayElapsedS drives every stored end time and the whole timeline slider,
  // while daySchedule drives what the map highlights. If they ever diverge the
  // slider would run off the end of the day, so this is the invariant that
  // matters most in this file.
  const cases: Route[] = [
    day(),
    {
      ...day(),
      points: [stop('Home'), poi('V', 45), stop('Lunch', 120), stop('Motel')],
      legs: [leg(3600), leg(900), leg(1800)],
    },
    // A day that OPENS on a POI and closes on one. Legal, and reachable by
    // dragging: nothing says the first point of a day has to stay a stop.
    {
      ...day(),
      points: [poi('V0', 20), stop('Home'), stop('Lunch', 120), stop('Motel'), poi('V1', 20)],
      legs: [leg(600), leg(3600), leg(1800), leg(600)],
    },
    {
      ...day(),
      points: [stop('Home'), poi('V', null), stop('Lunch', 120), stop('Motel')],
      legs: [leg(3600), leg(900), leg(1800)],
    },
    { startAt: null, endAt: null, points: [stop('Only')], legs: [] },
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

describe('a day with fewer legs than its points imply', () => {
  // THIS WAS A LIVE BUG, and it is the reason the shape is worth a test of its
  // own. daySchedule walks points and legs together and used to stop dead at the
  // first missing leg. Every imported ride was stored as ONE leg holding the
  // whole track however many points sat on it — so from point 1 onward, every
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
    points: [stop('Start'), stop('Lunch', 60), stop('Fuel', 30), stop('Motel')],
    legs: [leg(3600, 72000)],
  }

  it('still counts the dwell of points past the last leg', () => {
    const segs = T.daySchedule(truncated)
    const dwelled = segs.filter((s: { kind: string }) => s.kind === 'point').map((s: { index: number }) => s.index)
    // Lunch is point 1 and Fuel is point 2. Before the fix the walk broke after
    // point 0's leg and Fuel never appeared at all.
    expect(dwelled).toContain(1)
    expect(dwelled).toContain(2)
  })

  it('keeps the schedule and the elapsed time in agreement', () => {
    const segs = T.daySchedule(truncated)
    const total = segs.length ? segs[segs.length - 1].end : 0
    expect(total).toBeCloseTo(T.dayElapsedS(truncated), 6)
  })
})
