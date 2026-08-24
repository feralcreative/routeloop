// One ordered list of points, and what a `kind` is allowed to mean.
//
// Ziad's call, 2026-08-23: a point is created as a POI and promoted to a stop
// later, so a day is one ordered array and `kind` is a flag on an element rather
// than a choice of which array to put it in. These pin the rules that survived
// that change and the compatibility that had to be built for the ones that did
// not.
import { describe, expect, it } from 'vitest'
import { MAX_STOPS, normalize, ridePayload, stopsOf } from '../src/maps/ride-graph'
import { NATIVE_FORMAT_VERSION, nativeVersion, upgradeNativeRide, type NativeRide } from '../src/maps/export'

const GEOM = [
  [-122, 37],
  [-122.1, 37.1],
] as Array<[number, number]>

const pt = (over: Record<string, unknown> = {}) => ({
  kind: 'poi' as const,
  lat: 37,
  lng: -122,
  name: 'P',
  description: '',
  roles: [] as never[],
  durationMin: null,
  ...over,
})

const leg = () => ({ geometry: GEOM, distanceM: 1000, durationS: 60, viaPoints: [] })

const rideWith = (points: unknown[], legs = 0) => ({
  title: 'T',
  description: '',
  visibility: 'private' as const,
  external_url: '',
  days: [
    {
      title: '',
      color: '#0000cc',
      startAt: null,
      endAt: null,
      altGroup: null,
      altActive: true,
      points,
      legs: Array.from({ length: legs }, leg),
    },
  ],
})

describe('the shape of a day', () => {
  it('keeps one ordered list, both kinds interleaved as the rider left them', () => {
    const r = ridePayload.parse(
      rideWith([pt({ kind: 'stop', name: 'A' }), pt({ name: 'View' }), pt({ kind: 'stop', name: 'B' })], 2),
    )
    expect(r.days[0].points.map((p) => p.name)).toEqual(['A', 'View', 'B'])
    expect(r.days[0].points.map((p) => p.kind)).toEqual(['stop', 'poi', 'stop'])
  })

  // The baseline type. A payload that says nothing about a point is describing a
  // POI, because that is what every point starts as.
  it('defaults a point with no kind to a POI', () => {
    const r = ridePayload.parse(rideWith([pt({ kind: 'stop' }), { lat: 37, lng: -122 }], 1))
    expect(r.days[0].points[1].kind).toBe('poi')
  })

  // Ziad's call, 2026-08-24: a POI is something you at least ride BY, so it is
  // part of the route and anchors a leg like any other point. Three POIs between
  // two stops are four legs, not one.
  it('counts legs against every point, both kinds', () => {
    const ok = ridePayload.safeParse(
      rideWith([pt({ kind: 'stop' }), pt(), pt(), pt(), pt({ kind: 'stop' })], 4),
    )
    expect(ok.success).toBe(true)
  })

  // The regression that changed the model: a start and one POI drew two dots and
  // no road, because the leg count was measured in stops and there was only one.
  it('gives a day of a stop and a POI a leg between them', () => {
    const ok = ridePayload.safeParse(rideWith([pt({ kind: 'stop' }), pt({ name: 'View' })], 1))
    expect(ok.success).toBe(true)
  })

  it('refuses a day whose legs do not connect its points', () => {
    const bad = ridePayload.safeParse(rideWith([pt({ kind: 'stop' }), pt(), pt({ kind: 'stop' })], 1))
    expect(bad.success).toBe(false)
    if (!bad.success) expect(JSON.stringify(bad.error.issues)).toMatch(/legs must connect/)
  })

  // Still required, and no longer for a routing reason: a day of nothing but POIs
  // draws a complete road now. It is the roadbook's numbered rows, the Maps
  // hand-off and the start/finish roles that need a stop to exist.
  it('refuses a day with no stops at all', () => {
    const bad = ridePayload.safeParse(rideWith([pt(), pt()], 1))
    expect(bad.success).toBe(false)
    if (!bad.success) expect(JSON.stringify(bad.error.issues)).toMatch(/at least one stop/)
  })

  it('caps the stops without capping the POIs at the same number', () => {
    const many = [
      ...Array.from({ length: MAX_STOPS + 1 }, () => pt({ kind: 'stop' })),
      ...Array.from({ length: 5 }, () => pt()),
    ]
    const bad = ridePayload.safeParse(rideWith(many, many.length - 1))
    expect(bad.success).toBe(false)
    if (!bad.success) expect(JSON.stringify(bad.error.issues)).toMatch(/at most 200 stops/)
  })
})

describe('stopsOf', () => {
  it('is the points the rider means to stop at, in order, and nothing else', () => {
    const points = [pt({ kind: 'stop', name: 'A' }), pt({ name: 'X' }), pt({ kind: 'stop', name: 'B' })]
    expect(stopsOf(points).map((p) => p.name)).toEqual(['A', 'B'])
  })
})

// Riders have v2, v3 and v4 files on disk. A backup that will not restore is not
// a backup, which is the whole reason the format carries a version at all.
describe('a native file written before the merge', () => {
  const legacy = (version: number, key: 'routeloop' | 'tankbag' = 'routeloop'): NativeRide =>
    ({
      [key]: version,
      exportedFrom: 'routeloop.app',
      ride: {
        title: 'Old ride',
        description: '',
        visibility: 'private',
        external_url: '',
        days: [
          {
            title: '',
            color: '#0000cc',
            startAt: null,
            endAt: null,
            stops: [
              { lat: 37, lng: -122, name: 'A', description: '', roles: [], durationMin: null },
              { lat: 37.1, lng: -122.1, name: 'B', description: '', roles: [], durationMin: null },
            ],
            pois: [{ lat: 37.05, lng: -122.05, name: 'View', description: '', roles: [], durationMin: 15 }],
            legs: [leg()],
          },
        ],
      },
    }) as unknown as NativeRide

  // Two migrations run over this fixture: the v4 merge into one ordered list, and
  // the v5 re-cut that gives it a leg per pair. Both have to have happened for it
  // to validate, which is what the schema check below is really asserting.
  it('is merged into one ordered list, stops first', () => {
    const upgraded = upgradeNativeRide(legacy(3)) as { days: Array<{ points: Array<{ name: string }> }> }
    expect(upgraded.days[0].points.map((p) => p.name)).toEqual(['A', 'B', 'View'])
  })

  // Appended rather than interleaved, and that is the honest reading: a v3 POI
  // had no stored order, so there is no sequence to recover.
  it('stamps the kinds explicitly rather than letting a stop default to a POI', () => {
    const upgraded = upgradeNativeRide(legacy(3)) as { days: Array<{ points: Array<{ kind: string }> }> }
    expect(upgraded.days[0].points.map((p) => p.kind)).toEqual(['stop', 'stop', 'poi'])
  })

  it('drops the old arrays so the merged list is the only one', () => {
    const upgraded = upgradeNativeRide(legacy(3)) as { days: Array<Record<string, unknown>> }
    expect(upgraded.days[0].stops).toBeUndefined()
    expect(upgraded.days[0].pois).toBeUndefined()
  })

  it('validates against the current schema once upgraded', () => {
    const parsed = ridePayload.safeParse(upgradeNativeRide(legacy(3)))
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      normalize(parsed.data)
      expect(parsed.data.days[0].points).toHaveLength(3)
      expect(parsed.data.days[0].points[2].durationMin).toBe(15)
    }
  })

  it('does the same for the legacy tankbag version key', () => {
    const upgraded = upgradeNativeRide(legacy(2, 'tankbag')) as { days: Array<{ points: unknown[] }> }
    expect(nativeVersion(legacy(2, 'tankbag'))).toBe(2)
    expect(upgraded.days[0].points).toHaveLength(3)
  })

  // A current file must pass through untouched — the merge is keyed on the
  // version, not on the absence of a `points` array, so a v4 day is not re-read.
  it('leaves a current file alone', () => {
    const current = {
      routeloop: NATIVE_FORMAT_VERSION,
      exportedFrom: 'routeloop.app',
      ride: rideWith([pt({ kind: 'stop', name: 'A' }), pt({ name: 'V' })]),
    } as unknown as NativeRide
    const upgraded = upgradeNativeRide(current) as { days: Array<{ points: Array<{ name: string }> }> }
    expect(upgraded.days[0].points.map((p) => p.name)).toEqual(['A', 'V'])
  })
})
