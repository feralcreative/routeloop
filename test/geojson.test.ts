// GeoJSON import, and the round-trip back out through the exporter.
//
// The axis order is the thing worth pinning hardest. GeoJSON positions are
// [longitude, latitude] and so is this app's `Track`; only google.maps disagrees.
// A test that merely checked "the point is where I put it" would pass under a
// swap as long as both ends swapped, so these use coordinates where longitude
// and latitude are not interchangeable — a latitude of -122 does not exist.
import { describe, expect, it } from 'vitest'
import { buildGeoJson, type ExportRide } from '../src/maps/export'
import { processGeoJson } from '../src/maps/geojson'
import { RouteFileError } from '../src/maps/kml'

const SF: [number, number] = [-122.4194, 37.7749]
const OAK: [number, number] = [-122.2711, 37.8044]

const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features })
const feature = (geometry: unknown, properties: Record<string, unknown> = {}) => ({
  type: 'Feature',
  geometry,
  properties,
})
const line = (coords: Array<[number, number]>) => ({ type: 'LineString', coordinates: coords })
const point = (c: [number, number]) => ({ type: 'Point', coordinates: c })

describe('processGeoJson', () => {
  it('reads a FeatureCollection of a line and its points', () => {
    const r = processGeoJson(
      fc([feature(line([SF, OAK])), feature(point(SF), { name: 'Start' }), feature(point(OAK), { name: 'End' })]),
    )
    expect(r.track).toEqual([SF, OAK])
    expect(r.points.map((p) => p.name)).toEqual(['Start', 'End'])
    expect(r.trackMeters).toBeGreaterThan(10_000)
  })

  it('keeps [lng, lat] order rather than swapping it', () => {
    const r = processGeoJson(fc([feature(point(SF), { name: 'Start' })]))
    // If anything swapped, lat would be -122.4194 — which is not a latitude.
    expect(r.points[0]).toMatchObject({ lng: -122.4194, lat: 37.7749 })
  })

  it('stores the track as [lng, lat] pairs, matching Track', () => {
    const r = processGeoJson(fc([feature(line([SF, OAK]))]))
    expect(r.track[0][0]).toBeLessThan(-100) // longitude first
    expect(r.track[0][1]).toBeGreaterThan(0) // latitude second
  })

  it('refuses a [lat, lng] file rather than quietly transposing it', () => {
    const swapped = fc([feature(point([37.7749, -122.4194]))])
    expect(() => processGeoJson(swapped)).toThrow(RouteFileError)
    expect(() => processGeoJson(swapped)).toThrow(/\[longitude, latitude\]/)
  })

  it('discards the altitude in a three-element position', () => {
    const r = processGeoJson(fc([feature(line([[-122.4194, 37.7749, 128] as never, OAK]))]))
    expect(r.track[0]).toEqual(SF)
  })

  it('takes the longest line, so scenery does not become the route', () => {
    const long = line([SF, [-122.38, 37.79], [-122.33, 37.8], OAK])
    const r = processGeoJson(fc([feature(line([SF, OAK])), feature(long)]))
    expect(r.track).toHaveLength(4)
  })

  it('accepts a bare geometry as the document root', () => {
    expect(processGeoJson(JSON.stringify(line([SF, OAK]))).track).toEqual([SF, OAK])
  })

  it('accepts a single Feature as the document root', () => {
    expect(processGeoJson(JSON.stringify(feature(line([SF, OAK])))).track).toEqual([SF, OAK])
  })

  it('walks a GeometryCollection', () => {
    const gc = { type: 'GeometryCollection', geometries: [line([SF, OAK]), point(SF)] }
    const r = processGeoJson(fc([feature(gc, { name: 'Both' })]))
    expect(r.track).toEqual([SF, OAK])
    expect(r.points).toHaveLength(1)
  })

  it('splits a MultiLineString into candidate lines', () => {
    const mls = {
      type: 'MultiLineString',
      coordinates: [
        [SF, OAK],
        [SF, [-122.38, 37.79], OAK],
      ],
    }
    expect(processGeoJson(fc([feature(mls)])).track).toHaveLength(3)
  })

  it('draws a Polygon rather than refusing it', () => {
    const poly = { type: 'Polygon', coordinates: [[SF, OAK, [-122.3, 37.9], SF]] }
    expect(processGeoJson(fc([feature(poly)])).track).toHaveLength(4)
  })

  it('expands a MultiPoint into one point each', () => {
    const mp = { type: 'MultiPoint', coordinates: [SF, OAK] }
    expect(processGeoJson(fc([feature(mp, { name: 'Both' })])).points).toHaveLength(2)
  })

  it('parses roles out of the documented name prefix', () => {
    const r = processGeoJson(fc([feature(point(SF), { name: 'GAS/FOOD - Chevron' })]))
    expect(r.points[0]).toMatchObject({ name: 'Chevron', roles: ['gas', 'food'] })
  })

  it('prefers an explicit roles array over the name prefix', () => {
    const r = processGeoJson(fc([feature(point(SF), { name: 'GAS - Chevron', roles: ['hotel'] })]))
    expect(r.points[0]).toMatchObject({ name: 'Chevron', roles: ['hotel'] })
  })

  it('drops role names it does not know instead of rejecting the file', () => {
    const r = processGeoJson(fc([feature(point(SF), { name: 'Somewhere', roles: ['gas', 'unicorn'] })]))
    expect(r.points[0].roles).toEqual(['gas'])
  })

  it('reads a POI as a POI and everything else as a stop', () => {
    const r = processGeoJson(fc([feature(point(SF), { name: 'A', kind: 'poi' }), feature(point(OAK), { name: 'B' })]))
    expect(r.points.map((p) => p.kind)).toEqual(['poi', 'stop'])
  })

  it('falls back through the property names other tools use', () => {
    const r = processGeoJson(fc([feature(point(SF), { title: 'From title', notes: 'From notes' })]))
    expect(r.points[0]).toMatchObject({ name: 'From title', description: 'From notes' })
  })

  it('strips markup out of a name, like every other format does', () => {
    const r = processGeoJson(fc([feature(point(SF), { name: '<script>alert(1)</script>Chevron' })]))
    expect(r.points[0].name).toBe('alert(1)Chevron')
  })

  it('refuses a file with no lines and no points', () => {
    expect(() => processGeoJson(fc([]))).toThrow(/no lines or points/)
  })

  it('refuses invalid JSON', () => {
    expect(() => processGeoJson('{"type":')).toThrow(/not valid JSON/)
  })

  it('refuses a root that is not an object', () => {
    expect(() => processGeoJson('[1,2,3]')).toThrow(/no object at its root/)
  })

  it('refuses a root with no type', () => {
    expect(() => processGeoJson('{"features":[]}')).toThrow(/no "type"/)
  })

  // JSON has no entities and no external references, so there is no DOCTYPE
  // equivalent to reject. Deep nesting is the one structural attack left, and
  // it is refused before JSON.parse sees it rather than caught afterwards.
  it('refuses deeply nested input before the parser runs', () => {
    const bomb = '['.repeat(5000) + ']'.repeat(5000)
    expect(() => processGeoJson(bomb)).toThrow(RouteFileError)
    expect(() => processGeoJson(bomb)).toThrow(/nested too deeply/)
  })

  it('is not fooled by brackets inside a string', () => {
    const r = processGeoJson(fc([feature(point(SF), { name: '[[[[[ not nesting' })]))
    expect(r.points[0].name).toBe('[[[[[ not nesting')
  })
})

describe('buildGeoJson → processGeoJson round-trip', () => {
  const ride: ExportRide = {
    title: 'Bodega weekend',
    description: 'two days',
    routes: [
      {
        title: 'Day 1',
        color: '#cc0000',
        distanceM: 16000,
        durationS: 0,
        startAt: null,
        endAt: null,
        twistinessDpm: 214,
        twistinessBestDpm: 340,
        track: [SF, [-122.38, 37.79], OAK],
        points: [
          {
            lat: 37.7749,
            lng: -122.4194,
            name: 'Chevron',
            description: 'top off',
            roles: ['gas', 'food'],
            kind: 'stop',
            durationMin: 15,
            distFromStartM: 0,
          },
          {
            lat: 37.8044,
            lng: -122.2711,
            name: 'Overlook',
            description: null,
            roles: ['view'],
            kind: 'poi',
            durationMin: 10,
            distFromStartM: 16000,
          },
        ],
      },
    ],
  }

  const out = processGeoJson(buildGeoJson(ride))

  it('returns the same geometry, in the same order', () => {
    expect(out.track).toEqual(ride.routes[0].track)
  })

  // Everything the app models, not just the geometry: roles, the stop/POI
  // distinction and dwell time all survive, which is the reason GeoJSON is the
  // format worth generating rather than KML.
  it('returns the same points, with roles, kind and dwell intact', () => {
    expect(out.points).toEqual([
      {
        lat: 37.7749,
        lng: -122.4194,
        name: 'Chevron',
        description: 'top off',
        roles: ['gas', 'food'],
        kind: 'stop',
        durationMin: 15,
      },
      {
        lat: 37.8044,
        lng: -122.2711,
        name: 'Overlook',
        description: null,
        roles: ['view'],
        kind: 'poi',
        durationMin: 10,
      },
    ])
  })

  it('refuses a nonsense dwell rather than letting it into the timeline', () => {
    const bad = fc([
      feature(point(SF), { name: 'A', durationMin: -30 }),
      feature(point(OAK), { name: 'B', durationMin: 999999 }),
    ])
    expect(processGeoJson(bad).points.map((p) => p.durationMin)).toEqual([null, 1440])
  })

  it('emits valid JSON that other tools can read', () => {
    const parsed = JSON.parse(buildGeoJson(ride))
    expect(parsed.type).toBe('FeatureCollection')
    // One LineString for the day plus one Point per stop.
    expect(parsed.features).toHaveLength(3)
    expect(parsed.features[0].properties.stroke).toBe('#cc0000')
    // The prefixed name is what a tool showing only a label will display.
    expect(parsed.features[1].properties.name).toBe('GAS/FOOD - Chevron')
  })
})
