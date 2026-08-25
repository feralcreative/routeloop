// A day's clock is a WALL CLOCK AT THE DEPARTURE POINT, and this is the test
// that says so in a way a click-through cannot.
//
// The bug it exists to prevent shipped twice. The builder wrote a day's start by
// attaching the BROWSER's offset (`new Date("2026-08-24T09:00").toISOString()`),
// so a 9am departure planned in California was stored as 16:00 and the printed
// roadbook — which renders in UTC — said 4:00 PM. The same mistake, in the other
// direction, was live in the stop-details editor: it wrote with the offset and
// read back by slicing the ISO string, so a 3pm check-in reloaded as 10pm. Both
// are invisible to anyone testing at UTC+0, and both are one assertion here.
//
// So every assertion below is written as "the digits that go in are the digits
// that come out", and the suite forces the process into a non-UTC zone to prove
// it. A test run at UTC+0 would pass against the very code this replaced.
//
// Same harness as builder-history.test.ts and twist-client.test.ts: eval the
// browser file, drive the global it exports. No DOM, no map.
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

let C: any

// A ZONE THAT IS NOT UTC, and one with daylight saving, because the whole point
// is that neither can move a value. Set here rather than in vitest.config.ts so
// no other suite inherits it, and verified rather than assumed: Node re-reads
// `TZ` on assignment, so every Date built after this line is Pacific — including
// on CI, which runs at UTC and would otherwise let the old code pass.
const priorTz = process.env.TZ

beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles'
  const win: any = {}
  new Function('window', readFileSync('public/js/day-clock.js', 'utf8'))(win)
  C = win.TBDayClock
})

afterAll(() => {
  if (priorTz === undefined) delete process.env.TZ
  else process.env.TZ = priorTz
})

describe('isoToInput', () => {
  it('returns the digits the rider typed, not the browsers reading of them', () => {
    expect(C.isoToInput('2026-08-24T09:00:00.000Z')).toBe('2026-08-24T09:00')
  })

  it('does not shift a time across midnight, which is where an offset shows first', () => {
    expect(C.isoToInput('2026-08-24T00:30:00.000Z')).toBe('2026-08-24T00:30')
    expect(C.isoToInput('2026-08-24T23:45:00.000Z')).toBe('2026-08-24T23:45')
  })

  it('pads every field to the width the input requires', () => {
    expect(C.isoToInput('2026-01-05T07:05:00.000Z')).toBe('2026-01-05T07:05')
  })

  it('is empty for nothing and for garbage, never NaN in a field', () => {
    expect(C.isoToInput(null)).toBe('')
    expect(C.isoToInput('')).toBe('')
    expect(C.isoToInput('not a date')).toBe('')
  })
})

describe('inputToIso', () => {
  it('carries the wall clock as UTC rather than attaching an offset', () => {
    expect(C.inputToIso('2026-08-24T09:00')).toBe('2026-08-24T09:00:00.000Z')
  })

  it('drops seconds a browser volunteers — the field resolves to a minute', () => {
    expect(C.inputToIso('2026-08-24T09:00:30')).toBe('2026-08-24T09:00:00.000Z')
  })

  it('refuses a date that does not exist rather than rolling it over', () => {
    expect(C.inputToIso('2026-02-30T09:00')).toBe(null)
    expect(C.inputToIso('2026-13-01T09:00')).toBe(null)
    expect(C.inputToIso('2026-08-24T25:00')).toBe(null)
  })

  it('is null for nothing and for garbage', () => {
    expect(C.inputToIso('')).toBe(null)
    expect(C.inputToIso(null)).toBe(null)
    expect(C.inputToIso('tomorrow morning')).toBe(null)
  })
})

describe('round trip', () => {
  // The property that matters more than any single case: whatever a rider types
  // survives a save and a reload unchanged, in any zone, on any date.
  const cases = [
    '2026-01-01T00:00',
    '2026-03-08T02:30', // inside the US spring-forward gap — a local-zone
    '2026-03-08T03:30', // conversion moves one of these and not the other
    '2026-11-01T01:30', // the fall-back hour, which happens twice locally
    '2026-06-15T12:00',
    '2026-08-24T09:00',
    '2026-12-31T23:59',
  ]
  for (const v of cases) {
    it(`survives ${v}`, () => {
      expect(C.isoToInput(C.inputToIso(v))).toBe(v)
    })
  }
})

describe('nextMorningAfter', () => {
  it('is the same days morning when the day ended before it', () => {
    expect(C.nextMorningAfter('2026-08-24T02:00:00.000Z', 8)).toBe('2026-08-24T08:00:00.000Z')
  })

  it('is the next mornings when the day ended after it', () => {
    expect(C.nextMorningAfter('2026-08-24T19:30:00.000Z', 8)).toBe('2026-08-25T08:00:00.000Z')
  })

  it('is strictly after — a day ending exactly at the hour rolls forward', () => {
    expect(C.nextMorningAfter('2026-08-24T08:00:00.000Z', 8)).toBe('2026-08-25T08:00:00.000Z')
  })

  it('crosses a spring-forward date without gaining or losing an hour', () => {
    // 8am exists on both sides of this in UTC. It does not in America/Los_Angeles,
    // which is exactly why this file never touches the local getters.
    expect(C.nextMorningAfter('2026-03-07T19:00:00.000Z', 8)).toBe('2026-03-08T08:00:00.000Z')
  })

  it('crosses a month and a year boundary', () => {
    expect(C.nextMorningAfter('2026-08-31T19:00:00.000Z', 8)).toBe('2026-09-01T08:00:00.000Z')
    expect(C.nextMorningAfter('2026-12-31T19:00:00.000Z', 8)).toBe('2027-01-01T08:00:00.000Z')
  })

  it('is null for nothing and for garbage', () => {
    expect(C.nextMorningAfter(null, 8)).toBe(null)
    expect(C.nextMorningAfter('not a date', 8)).toBe(null)
  })
})

describe('the process is not running at UTC', () => {
  // If this ever fails, every assertion above has stopped proving anything: the
  // code this file replaced passes the whole suite at UTC+0. Fix the zone, do
  // not delete the check.
  it('has a non-zero offset, so a local-zone conversion would be visible', () => {
    expect(new Date('2026-08-24T09:00:00.000Z').getTimezoneOffset()).not.toBe(0)
  })
})
