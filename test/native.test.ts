// The native Routeloop format: the one export that loses nothing.
//
// Every other format flattens something and the round-trip tests say so. This
// one has to survive intact, and the way it does that is by being the builder's
// own save payload — so what these assert is mostly that the exported shape is
// exactly what `ridePayload` accepts. A field that drifts out of that schema
// makes the file unimportable, and it would do so silently.
import { describe, expect, it } from 'vitest'
import {
  NATIVE_FORMAT_VERSION,
  buildNativeJson,
  isNativeRide,
  nativeVersion,
  upgradeNativeRide,
  type NativeRide,
} from '../src/maps/export'
import { normalize, ridePayload } from '../src/maps/ride-graph'

const ride = {
  title: 'Coast run',
  description: 'Two days.',
  visibility: 'unlisted' as const,
  external_url: 'https://example.com/thread',
  days: [
    {
      title: 'Day 1',
      color: '#0066cc',
      startAt: '2026-08-03T15:00:00.000Z',
      endAt: '2026-08-03T23:30:00.000Z',
      // ONE ORDERED LIST, with the POI where the rider put it — between the two
      // stops rather than appended after them, which is the thing the old
      // two-array shape could not say.
      points: [
        {
          kind: 'stop' as const,
          lat: 36.9741,
          lng: -122.0308,
          name: 'Santa Cruz',
          description: 'Meet at the wharf.',
          roles: ['start' as const],
          durationMin: null,
        },
        {
          kind: 'poi' as const,
          lat: 37.1819,
          lng: -122.3878,
          name: 'Pigeon Point',
          description: '',
          roles: ['view' as const],
          durationMin: 20,
        },
        {
          kind: 'stop' as const,
          lat: 37.4636,
          lng: -122.4286,
          name: 'Half Moon Bay',
          description: '',
          roles: ['gas' as const, 'food' as const],
          durationMin: 45,
        },
      ],
      legs: [
        {
          geometry: [
            [-122.0308, 36.9741],
            [-122.2867, 37.105],
            [-122.4286, 37.4636],
          ] as [number, number][],
          distanceM: 61000,
          durationS: 4200,
          viaPoints: [[-122.2867, 37.105]] as [number, number][],
        },
      ],
    },
  ],
}

const native: NativeRide = { routeloop: NATIVE_FORMAT_VERSION, exportedFrom: 'routeloop.app', ride }

/** The same file as a rider downloaded it before 2026-08-11: v2, `tankbag` key. */
const legacyNative: NativeRide = { tankbag: 2, exportedFrom: 'tankbag.app', ride }

describe('isNativeRide', () => {
  it('recognizes a Routeloop export', () => {
    expect(isNativeRide(JSON.parse(buildNativeJson(native)))).toBe(true)
  })

  // The two share the .json extension, so this is the only thing keeping a
  // GeoJSON from being routed down the native import path.
  it('does not mistake a GeoJSON for one', () => {
    expect(isNativeRide({ type: 'FeatureCollection', features: [] })).toBe(false)
  })

  it('rejects anything without a numeric version', () => {
    for (const v of [null, undefined, 42, 'routeloop', [], {}, { routeloop: 'one' }, { tankbag: 'one' }]) {
      expect(isNativeRide(v), JSON.stringify(v)).toBe(false)
    }
  })
})

// The version key was renamed with the product at v3. Every file a rider
// downloaded before that carries the old key, and it is the only lossless copy
// of their ride they hold — so it stays readable, and this is what says so.
describe('the legacy tankbag version key', () => {
  it('is still recognized as a native ride', () => {
    expect(isNativeRide(legacyNative)).toBe(true)
    expect(isNativeRide(JSON.parse(buildNativeJson(legacyNative)))).toBe(true)
  })

  it('reports its version from whichever key carries it', () => {
    expect(nativeVersion(legacyNative)).toBe(2)
    expect(nativeVersion(native)).toBe(NATIVE_FORMAT_VERSION)
    expect(nativeVersion({ tankbag: 1, exportedFrom: 'tankbag.app', ride: {} })).toBe(1)
  })

  it('imports to exactly what the current key imports to', () => {
    expect(upgradeNativeRide(legacyNative)).toEqual(upgradeNativeRide(native))
  })

  // v1 called the array of days `routes`, and a v1 file necessarily carries the
  // old key — so the oldest upgrade path is only reachable through it.
  it('still upgrades a v1 file, which can only have the old key', () => {
    const v1: NativeRide = { tankbag: 1, exportedFrom: 'tankbag.app', ride: { title: 'x', routes: [] } }
    expect(upgradeNativeRide(v1)).toEqual({ title: 'x', days: [] })
  })

  it('is never written back out', () => {
    const written = JSON.parse(buildNativeJson(native))
    expect(written.routeloop).toBe(NATIVE_FORMAT_VERSION)
    expect(written).not.toHaveProperty('tankbag')
  })
})

describe('the exported shape is what the importer accepts', () => {
  // The assertion that matters. Export and import are the same schema, so a
  // field added to one and not the other fails here rather than on a rider's
  // backup a month later.
  it('validates against ridePayload with nothing dropped', () => {
    const parsed = ridePayload.safeParse(JSON.parse(buildNativeJson(native)).ride)
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('keeps every field through parse and normalize', () => {
    const out = ridePayload.parse(JSON.parse(buildNativeJson(native)).ride)
    normalize(out)
    const day = out.days[0]
    expect(day.title).toBe('Day 1')
    expect(day.color).toBe('#0066cc')
    expect(day.startAt).toBe('2026-08-03T15:00:00.000Z')
    expect(day.endAt).toBe('2026-08-03T23:30:00.000Z')
    // Order preserved across the whole list, both kinds — the POI sits between
    // the two stops because that is where it was written.
    expect(day.points.map((s) => s.name)).toEqual(['Santa Cruz', 'Pigeon Point', 'Half Moon Bay'])
    expect(day.points.map((s) => s.kind)).toEqual(['stop', 'poi', 'stop'])
    expect(day.points[2].roles).toEqual(['gas', 'food'])
    expect(day.points[2].durationMin).toBe(45)
    expect(day.points[0].description).toBe('Meet at the wharf.')
    // The distinction KML and GPX cannot carry at all.
    expect(day.points[1]).toMatchObject({ name: 'Pigeon Point', durationMin: 20, roles: ['view'] })
    // Legs, not a flattened track — the leg boundaries are where the stops are.
    expect(day.legs[0].geometry).toHaveLength(3)
    expect(day.legs[0].durationS).toBe(4200)
    expect(day.legs[0].viaPoints).toEqual([[-122.2867, 37.105]])
    expect(out.external_url).toBe('https://example.com/thread')
  })

  it('is compact JSON, since nothing reads it by eye', () => {
    expect(buildNativeJson(native)).not.toContain('\n')
  })
})

// The lossless format has to stay lossless as fields are added to it, and an
// alternate grouping is the field most expensive to lose: a rider who reimports
// their own backup would get their alternates back as ordinary days, silently,
// with the ride's mileage doubling to match.
describe('alternates survive the native format', () => {
  const grouped = {
    ...ride,
    days: [
      { ...ride.days[0], altGroup: 0, altActive: true },
      { ...ride.days[0], altGroup: 0, altActive: false },
    ],
  }

  it('carries both fields through parse and normalize', () => {
    const out = ridePayload.parse(grouped)
    normalize(out)
    expect(out.days.map((r) => [r.altGroup, r.altActive])).toEqual([
      [0, true],
      [0, false],
    ])
  })

  it('defaults a file written before the feature to a plain, active day', () => {
    // Every native JSON a rider already holds omits these keys. It must import
    // as an ordinary ride rather than failing validation — which is the whole
    // reason both fields are .default()ed and NATIVE_FORMAT_VERSION did not move.
    const out = ridePayload.parse(ride)
    normalize(out)
    expect(out.days.every((r) => r.altGroup === null && r.altActive)).toBe(true)
    expect(nativeVersion(native)).toBe(NATIVE_FORMAT_VERSION)
  })

  it('repairs a group of one instead of refusing it', () => {
    // The shape an autosave sees the instant a rider deletes one of a pair.
    const out = ridePayload.parse({ ...ride, days: [{ ...ride.days[0], altGroup: 0, altActive: false }] })
    normalize(out)
    expect(out.days[0]).toMatchObject({ altGroup: null, altActive: true })
  })

  it('refuses a group id outside the day cap', () => {
    const bad = { ...ride, days: [{ ...ride.days[0], altGroup: 9999 }] }
    expect(ridePayload.safeParse(bad).success).toBe(false)
  })
})

describe('what the importer refuses', () => {
  it('refuses a payload whose legs do not connect its stops', () => {
    const broken = { ...ride, days: [{ ...ride.days[0], legs: [] }] }
    const parsed = ridePayload.safeParse(broken)
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/legs must connect/)
  })

  it('refuses a javascript: external_url, the same as every other entry point', () => {
    const bad = { ...ride, external_url: 'javascript:alert(1)' }
    expect(ridePayload.safeParse(bad).success).toBe(false)
  })

  it('refuses a coordinate outside the world', () => {
    const bad = {
      ...ride,
      days: [
        {
          ...ride.days[0],
          points: [{ ...ride.days[0].points[0], lat: 991 }, ride.days[0].points[1], ride.days[0].points[2]],
        },
      ],
    }
    expect(ridePayload.safeParse(bad).success).toBe(false)
  })

  // Text arrives sanitized on every other path; a hand-edited backup is the one
  // place it might not, so normalize has to be what makes it safe.
  it('strips markup out of names on the way in', () => {
    const nasty = {
      ...ride,
      days: [
        {
          ...ride.days[0],
          points: [
            { ...ride.days[0].points[0], name: '<script>alert(1)</script>Santa Cruz' },
            ride.days[0].points[1],
            ride.days[0].points[2],
          ],
        },
      ],
    }
    const out = ridePayload.parse(nasty)
    normalize(out)
    expect(out.days[0].points[0].name).toBe('alert(1)Santa Cruz')
  })
})
