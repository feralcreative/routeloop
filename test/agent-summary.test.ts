// What the assistant reads about a ride must agree with what the builder shows (#444).
// The builder's clock is public/js/ride-time.js; the summary is src/agent/summary.ts.
// Two copies of one walk drift, so this evaluates the browser file and compares.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { ridePayload, type RidePayload } from '../src/maps/ride-graph'
import { arrivalsS, FALLBACK_MPS, presetOf, rideSummary } from '../src/agent/summary'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let T: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/ride-time.js', 'utf8'))(win)
  T = win.TBTime
})

const MI = 1609.344
const pt = (uid: string, lng: number, lat: number, durationMin: number | null = null) => ({
  uid,
  kind: 'stop' as const,
  name: uid,
  lat,
  lng,
  roles: [],
  durationMin,
})

function ride(opts: { drawn: boolean }): RidePayload {
  const points = [
    pt('aaaaaaaaaaaa', -122.27, 37.8, 20),
    pt('bbbbbbbbbbbb', -122.1, 37.6, 45),
    pt('cccccccccccc', -122.0, 37.0),
  ]
  return ridePayload.parse({
    title: 'Parity',
    routes: [
      {
        uid: 'route0000001',
        title: 'Day',
        startAt: '2027-05-01T09:00:00.000Z',
        points,
        legs: [
          {
            geometry: [
              [-122.27, 37.8],
              [-122.1, 37.6],
            ],
            distanceM: Math.round(30 * MI),
            durationS: 2400,
            viaPoints: [],
          },
          {
            geometry: [
              [-122.1, 37.6],
              [-122.0, 37.0],
            ],
            distanceM: Math.round(44 * MI),
            durationS: opts.drawn ? 3300 : 0,
            viaPoints: [],
          },
        ],
      },
    ],
  })
}

/** "HH:MM" after the given seconds from a 09:00 departure, as the summary prints it. */
const at = (s: number) => {
  const d = new Date(Date.parse('2027-05-01T09:00:00.000Z') + s * 1000)
  return d.toISOString().slice(11, 16)
}

describe('rideSummary agrees with ride-time.js', () => {
  it('uses the builder’s fallback speed for an undrawn leg', () => {
    expect(FALLBACK_MPS).toBe(T.NOMINAL_SPEED_MS)
  })

  for (const drawn of [true, false]) {
    it(`prints every ETA the builder would (${drawn ? 'all legs drawn' : 'one leg undrawn'})`, () => {
      const r = ride({ drawn })
      const summary = rideSummary(r)
      r.routes[0].points.forEach((p, i) => {
        const line = summary.split('\n').find((l) => l.includes(`[${p.uid}]`))!
        expect(line, p.uid ?? undefined).toContain(`ETA 2027-05-01 ${at(T.elapsedToPointS(r.routes[0], i))}`)
      })
    })
  }

  it('gives check_ride the same arrivals the builder computes', () => {
    for (const drawn of [true, false]) {
      const r = ride({ drawn })
      const { s, est } = arrivalsS(r.routes[0])
      r.routes[0].points.forEach((_, i) => expect(s[i]).toBe(T.elapsedToPointS(r.routes[0], i)))
      expect(est).toEqual([false, false, !drawn])
    }
  })

  it('counts the dwell at the first point, as the builder does', () => {
    const line = rideSummary(ride({ drawn: true }))
      .split('\n')
      .find((l) => l.includes('[bbbbbbbbbbbb]'))!
    // 20 minutes at the start, then the 40-minute leg.
    expect(line).toContain('ETA 2027-05-01 10:00')
  })

  it('marks both the distance and the ETA past an undrawn leg, and nothing before it', () => {
    const lines = rideSummary(ride({ drawn: false })).split('\n')
    const of = (uid: string) => lines.find((l) => l.includes(`[${uid}]`))!
    const marks = (l: string) => l.match(/\(est\.\)/g)?.length ?? 0
    expect(marks(of('aaaaaaaaaaaa'))).toBe(0)
    expect(marks(of('bbbbbbbbbbbb'))).toBe(0)
    expect(of('cccccccccccc')).toMatch(/ at [\d.]+ mi \(est\.\) ETA [\d-]+ [\d:]+ \(est\.\)/)
    expect(lines.find((l) => l.startsWith('Route 1'))).toContain('1 leg not drawn yet')
  })

  it('resolves vehicle and power field by field, and says where each came from', () => {
    const both = presetOf({ vehicle: 'bicycle', power: 'pedal' }, { vehicle: 'motorcycle', power: 'gas' })
    expect(rideSummary(ride({ drawn: true }), { preset: both })).toContain(
      'Planned for a bicycle on pedal power (set on this ride). No fuel planning applies',
    )
    const mixed = presetOf({ vehicle: 'car', power: null }, { vehicle: 'motorcycle', power: 'electric' })
    expect(mixed).toMatchObject({ vehicle: 'car', power: 'electric', vehicleFromRide: true, powerFromRide: false })
    expect(rideSummary(ride({ drawn: true }), { preset: mixed })).toContain(
      'Planned for a car on electricity (vehicle set on this ride, power from the rider’s default).',
    )
    const none = presetOf({ vehicle: null, power: null }, null)
    expect(none).toMatchObject({ vehicle: 'motorcycle', power: 'gas', vehicleFromRide: false, powerFromRide: false })
    // A bicycle cannot run on gas, the settings page's own coercion.
    expect(presetOf({ vehicle: 'bicycle', power: null }, { power: 'gas' }).power).toBe('pedal')
  })

  it('gives every route a line of character, naming twistiness only when every leg is drawn', () => {
    const drawn = rideSummary(ride({ drawn: true })).split('\n')
    expect(drawn[drawn.findIndex((l) => l.startsWith('Route 1')) + 1]).toMatch(
      /^ {2}no routing preferences · twistiness: /,
    )
    expect(rideSummary(ride({ drawn: false }))).toContain('twistiness unknown until every leg is drawn')
  })

  it('never prints a leg’s geometry', () => {
    const r = ride({ drawn: true })
    r.routes[0].legs[0].geometry.splice(1, 0, [-122.123457, 37.765432])
    expect(rideSummary(r)).not.toMatch(/122\.12345|37\.76543/)
  })
})
