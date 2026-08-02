// The trip time model: what is happening at a given moment on a given day.
//
// Ported from a scratch suite that was rewritten three times across the timeline
// sprints. ride-time.js is a plain IIFE that assigns window.TBTime, so it loads
// by evaluating it against a stub global rather than importing.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

type Leg = { durationS: number; distanceM: number }
type Stop = { name?: string; durationMin: number | null }
type Route = { startAt: string | null; endAt: string | null; stops: Stop[]; legs: Leg[] }

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
    expect(T.routeElapsedS(day())).toBe(3600 + 7200 + 1800)
  })

  it('splits riding from stopped', () => {
    expect(T.routeRidingS(day())).toBe(5400)
    expect(T.routeStoppedS(day())).toBe(7200)
  })
})

describe('walking a day', () => {
  const walk = (minutes: number) => T.activeAt(day(), minutes * 60)

  it('starts on the first leg', () => {
    expect(walk(0)).toEqual({ legIndex: 0, stopIndex: null })
  })

  it('is parked at the stop once the leg is done', () => {
    expect(walk(60)).toEqual({ legIndex: null, stopIndex: 1 })
    expect(walk(119)).toEqual({ legIndex: null, stopIndex: 1 })
  })

  it('rides again when the dwell ends', () => {
    expect(walk(180)).toEqual({ legIndex: 1, stopIndex: null })
  })

  it('parks at the final stop past the end of the day', () => {
    expect(walk(999)).toEqual({ legIndex: null, stopIndex: 2 })
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
    a.endAt = new Date((T.routeStartS(a) + T.routeElapsedS(a)) * 1000).toISOString()
    b.endAt = new Date((T.routeStartS(b) + T.routeElapsedS(b)) * 1000).toISOString()
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
    })
  })
})

describe('trip span', () => {
  it('covers a dated day', () => {
    const d = day()
    d.endAt = new Date((T.routeStartS(d) + T.routeElapsedS(d)) * 1000).toISOString()
    expect(T.tripSpan([d])).toEqual({
      from: Math.floor(new Date(at('2026-08-01T09:00')).getTime() / 1000),
      to: Math.floor(new Date(at('2026-08-01T12:30')).getTime() / 1000),
    })
  })

  it('is nothing at all for an undated ride', () => {
    expect(T.tripSpan([{ startAt: null, endAt: null, stops: [], legs: [] }])).toBeNull()
  })

  it('does not let an undated day stretch it', () => {
    const d = day()
    d.endAt = new Date((T.routeStartS(d) + T.routeElapsedS(d)) * 1000).toISOString()
    const undated = { startAt: null, endAt: null, stops: [stop('X')], legs: [] }
    expect(T.tripSpan([d, undated])).toEqual(T.tripSpan([d]))
  })

  it('falls back to elapsed when a day has a start but no stored end', () => {
    const d = day()
    expect(T.tripSpan([d])!.to).toBe(T.routeStartS(d) + T.routeElapsedS(d))
  })
})
