// The native Tankbag format: the one export that loses nothing.
//
// Every other format flattens something and the round-trip tests say so. This
// one has to survive intact, and the way it does that is by being the builder's
// own save payload — so what these assert is mostly that the exported shape is
// exactly what `ridePayload` accepts. A field that drifts out of that schema
// makes the file unimportable, and it would do so silently.
import { describe, expect, it } from 'vitest'
import { NATIVE_FORMAT_VERSION, buildNativeJson, isNativeRide, type NativeRide } from '../src/maps/export'
import { normalize, ridePayload } from '../src/maps/ride-graph'

const ride = {
  title: 'Coast run',
  description: 'Two days.',
  visibility: 'unlisted' as const,
  external_url: 'https://example.com/thread',
  routes: [
    {
      title: 'Day 1',
      color: '#0066cc',
      startAt: '2026-08-03T15:00:00.000Z',
      endAt: '2026-08-03T23:30:00.000Z',
      stops: [
        {
          lat: 36.9741,
          lng: -122.0308,
          name: 'Santa Cruz',
          description: 'Meet at the wharf.',
          roles: ['start' as const],
          durationMin: null,
        },
        {
          lat: 37.4636,
          lng: -122.4286,
          name: 'Half Moon Bay',
          description: '',
          roles: ['gas' as const, 'food' as const],
          durationMin: 45,
        },
      ],
      pois: [
        {
          lat: 37.1819,
          lng: -122.3878,
          name: 'Pigeon Point',
          description: '',
          roles: ['view' as const],
          durationMin: 20,
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

const native: NativeRide = { tankbag: NATIVE_FORMAT_VERSION, exportedFrom: 'tankbag.app', ride }

describe('isNativeRide', () => {
  it('recognises a Tankbag export', () => {
    expect(isNativeRide(JSON.parse(buildNativeJson(native)))).toBe(true)
  })

  // The two share the .json extension, so this is the only thing keeping a
  // GeoJSON from being routed down the native import path.
  it('does not mistake a GeoJSON for one', () => {
    expect(isNativeRide({ type: 'FeatureCollection', features: [] })).toBe(false)
  })

  it('rejects anything without a numeric version', () => {
    for (const v of [null, undefined, 42, 'tankbag', [], {}, { tankbag: 'one' }]) {
      expect(isNativeRide(v), JSON.stringify(v)).toBe(false)
    }
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
    const day = out.routes[0]
    expect(day.title).toBe('Day 1')
    expect(day.color).toBe('#0066cc')
    expect(day.startAt).toBe('2026-08-03T15:00:00.000Z')
    expect(day.endAt).toBe('2026-08-03T23:30:00.000Z')
    expect(day.stops.map((s) => s.name)).toEqual(['Santa Cruz', 'Half Moon Bay'])
    expect(day.stops[1].roles).toEqual(['gas', 'food'])
    expect(day.stops[1].durationMin).toBe(45)
    expect(day.stops[0].description).toBe('Meet at the wharf.')
    // The distinction KML and GPX cannot carry at all.
    expect(day.pois).toHaveLength(1)
    expect(day.pois[0]).toMatchObject({ name: 'Pigeon Point', durationMin: 20, roles: ['view'] })
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

describe('what the importer refuses', () => {
  it('refuses a payload whose legs do not connect its stops', () => {
    const broken = { ...ride, routes: [{ ...ride.routes[0], legs: [] }] }
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
      routes: [
        {
          ...ride.routes[0],
          stops: [{ ...ride.routes[0].stops[0], lat: 991 }, ride.routes[0].stops[1]],
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
      routes: [
        {
          ...ride.routes[0],
          stops: [{ ...ride.routes[0].stops[0], name: '<script>alert(1)</script>Santa Cruz' }, ride.routes[0].stops[1]],
        },
      ],
    }
    const out = ridePayload.parse(nasty)
    normalize(out)
    expect(out.routes[0].stops[0].name).toBe('alert(1)Santa Cruz')
  })
})
