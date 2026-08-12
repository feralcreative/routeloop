// The roadbook's arithmetic (#25).
//
// The rendering is a table and does not need a test. The column that does is
// "miles since fuel": it is the number a rider with a 180-mile tank reads to
// find out whether the next leg is a problem, and it is wrong in a way nobody
// would notice until they are standing beside a dry bike.
import { describe, expect, it } from 'vitest'
import { dayRows } from '../src/routes/roadbook'
import type { ExportPoint, ExportDay } from '../src/maps/export'

const MI = 1609.344

const pt = (over: Partial<ExportPoint> & { distFromStartM: number | null }): ExportPoint => ({
  lat: 37,
  lng: -122,
  name: 'Somewhere',
  description: null,
  roles: [],
  kind: 'stop',
  durationMin: null,
  ...over,
})

const day = (points: ExportPoint[], over: Partial<ExportDay> = {}): ExportDay => ({
  title: 'Day 1',
  color: '#0066cc',
  distanceM: 200 * MI,
  durationS: 4 * 3600,
  startAt: null,
  endAt: null,
  twistinessDpm: null,
  twistinessBestDpm: null,
  track: [],
  points,
  ...over,
})

describe('dayRows', () => {
  it('numbers stops and leaves POIs unnumbered', () => {
    const rows = dayRows(
      day([
        pt({ distFromStartM: 0, name: 'A' }),
        pt({ distFromStartM: 10 * MI, name: 'View', kind: 'poi' }),
        pt({ distFromStartM: 20 * MI, name: 'B' }),
      ]),
    )
    expect(rows.map((r) => r.n)).toEqual([1, null, 2])
  })

  it('orders by distance along the route, not by the order given', () => {
    const rows = dayRows(
      day([
        pt({ distFromStartM: 30 * MI, name: 'C' }),
        pt({ distFromStartM: 10 * MI, name: 'A' }),
        pt({ distFromStartM: 20 * MI, name: 'B' }),
      ]),
    )
    expect(rows.map((r) => r.point.name)).toEqual(['A', 'B', 'C'])
  })

  it('measures each leg from the point before it', () => {
    const rows = dayRows(
      day([pt({ distFromStartM: 0 }), pt({ distFromStartM: 40 * MI }), pt({ distFromStartM: 55 * MI })]),
    )
    expect(rows.map((r) => (r.fromPrevM == null ? null : Math.round(r.fromPrevM / MI)))).toEqual([null, 40, 15])
  })

  // The column that earns the sheet its place.
  describe('miles since fuel', () => {
    it('says nothing before the first fuel stop, because there is no answer yet', () => {
      const rows = dayRows(day([pt({ distFromStartM: 0 }), pt({ distFromStartM: 50 * MI })]))
      expect(rows.map((r) => r.sinceFuelM)).toEqual([null, null])
    })

    it('counts from the last gas stop', () => {
      const rows = dayRows(
        day([
          pt({ distFromStartM: 0 }),
          pt({ distFromStartM: 20 * MI, roles: ['gas'] }),
          pt({ distFromStartM: 90 * MI }),
          pt({ distFromStartM: 150 * MI }),
        ]),
      )
      expect(rows.map((r) => (r.sinceFuelM == null ? null : Math.round(r.sinceFuelM / MI)))).toEqual([
        null,
        null, // the first fuel stop: nothing to count from yet
        70,
        130,
      ])
    })

    // The figure is what you arrived on, not what you are leaving with. At a
    // fuel stop that is the distance the last tank actually covered — the
    // number worth printing. Resetting to 0 there would say nothing the word
    // "Gas" in the same row does not already say.
    it('reads as-you-arrive, so a fuel stop shows the tank it just used', () => {
      const rows = dayRows(
        day([
          pt({ distFromStartM: 0, roles: ['gas'] }),
          pt({ distFromStartM: 100 * MI }),
          pt({ distFromStartM: 120 * MI, roles: ['gas'] }),
          pt({ distFromStartM: 160 * MI }),
        ]),
      )
      expect(rows.map((r) => (r.sinceFuelM == null ? null : Math.round(r.sinceFuelM / MI)))).toEqual([
        null, // first stop of the day, and the first fuel: nothing behind it
        100,
        120, // arrived here having run 120 miles since the last fill
        40, // and 40 since this one
      ])
    })

    // An EV rider is asking the same question with a different verb.
    it('treats a charger as fuel', () => {
      const rows = dayRows(day([pt({ distFromStartM: 0, roles: ['charge'] }), pt({ distFromStartM: 60 * MI })]))
      expect(Math.round((rows[1].sinceFuelM ?? 0) / MI)).toBe(60)
    })
  })

  // Imported rides and older seeded POIs have no measured position. Printing
  // "0.0" beside one is a claim about where it is.
  describe('a point with no measured distance', () => {
    const rows = dayRows(
      day([
        pt({ distFromStartM: 0, name: 'A' }),
        pt({ distFromStartM: null, name: 'Unknown', kind: 'poi' }),
        pt({ distFromStartM: 50 * MI, name: 'B' }),
      ]),
    )

    it('sorts last rather than to the start of the day', () => {
      expect(rows.map((r) => r.point.name)).toEqual(['A', 'B', 'Unknown'])
    })

    it('reports nothing rather than zero', () => {
      const unknown = rows[2]
      expect(unknown.atM).toBeNull()
      expect(unknown.fromPrevM).toBeNull()
      expect(unknown.sinceFuelM).toBeNull()
    })

    it('does not disturb the distances of the points that are known', () => {
      expect(Math.round((rows[1].fromPrevM ?? 0) / MI)).toBe(50)
    })
  })

  describe('the clock', () => {
    it('is absent when the day has no start time', () => {
      const rows = dayRows(day([pt({ distFromStartM: 0 }), pt({ distFromStartM: 100 * MI })]))
      expect(rows.every((r) => r.arrive === null)).toBe(true)
    })

    it('advances with distance at the day’s average pace', () => {
      // 200 mi in 4 h, so the 100-mile mark is 2 h in.
      const rows = dayRows(
        day([pt({ distFromStartM: 0 }), pt({ distFromStartM: 100 * MI })], {
          startAt: new Date('2026-08-03T15:00:00Z'),
        }),
      )
      expect(rows[0].arrive?.toISOString()).toBe('2026-08-03T15:00:00.000Z')
      expect(rows[1].arrive?.toISOString()).toBe('2026-08-03T17:00:00.000Z')
    })

    it('adds the time planned at each stop to everything after it', () => {
      const rows = dayRows(
        day(
          [
            pt({ distFromStartM: 0 }),
            pt({ distFromStartM: 100 * MI, durationMin: 30 }),
            pt({ distFromStartM: 200 * MI }),
          ],
          { startAt: new Date('2026-08-03T15:00:00Z') },
        ),
      )
      // 2 h riding, then 30 min stopped, then 2 h riding.
      expect(rows[2].arrive?.toISOString()).toBe('2026-08-03T19:30:00.000Z')
    })

    it('does not divide by zero on a day with no distance', () => {
      const rows = dayRows(
        day([pt({ distFromStartM: 0 })], { distanceM: 0, startAt: new Date('2026-08-03T15:00:00Z') }),
      )
      expect(rows[0].arrive?.toISOString()).toBe('2026-08-03T15:00:00.000Z')
    })
  })
})
