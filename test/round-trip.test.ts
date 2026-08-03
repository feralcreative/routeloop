// Fidelity across formats (#35).
//
// The per-format suites test each parser against its own grammar. This one
// tests the thing those cannot: that the formats *agree*. `test/fixtures/`
// holds one ride — the same four stops, the same six-point track — written five
// ways, so a change that quietly shifts one parser's output shows up here as a
// disagreement rather than as a passing test in its own file.
//
// It is also where the axis order is pinned once, in a place that fails loudly.
// Every format in this app stores [lng, lat]; only google.maps disagrees, and
// that conversion lives at the map boundary. A parser that transposed would
// still pass its own suite if the fixture were transposed to match — it cannot
// pass this one, because the other four would disagree with it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { processCsv } from '../src/maps/csv'
import { processGeoJson } from '../src/maps/geojson'
import { extractKmlFromKmz } from '../src/maps/kmz'
import { buildCsv, buildGeoJson, buildGpx, buildKml, type ExportRide } from '../src/maps/export'
import { processGpx, processKml, RouteFileError, trackMeters, type ExtractedRoute, type Track } from '../src/maps/kml'
import { kmzOf } from './helpers/zip'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

const KML = fixture('coast-run.kml')
const GPX = fixture('coast-run.gpx')
const GEOJSON = fixture('coast-run.geojson')
const CSV = fixture('coast-run.csv')

// What the fixture says, independent of any parser. If a test below disagrees
// with this, one of them is wrong and the file is the tiebreaker.
const EXPECTED_STOPS = [
  { name: 'Santa Cruz', roles: ['start'], lat: 36.9741, lng: -122.0308 },
  { name: 'Davenport', roles: ['gas'], lat: 37.0113, lng: -122.1922 },
  { name: 'Pescadero', roles: ['food'], lat: 37.2552, lng: -122.3833 },
  { name: 'Half Moon Bay', roles: ['finish'], lat: 37.4636, lng: -122.4286 },
]

const EXPECTED_TRACK: Track = [
  [-122.0308, 36.9741],
  [-122.1922, 37.0113],
  [-122.2867, 37.105],
  [-122.3878, 37.1819],
  [-122.3833, 37.2552],
  [-122.4286, 37.4636],
]

// `carriesTrack: false` is the documented exception, not an oversight — see the
// note at the top of csv.ts. Listing it in the same table as the others is what
// keeps it a decision rather than a gap nobody noticed.
const FORMATS: Array<{ label: string; carriesTrack: boolean; parse: () => ExtractedRoute }> = [
  { label: 'KML', carriesTrack: true, parse: () => processKml(KML) },
  { label: 'KMZ', carriesTrack: true, parse: () => processKml(extractKmlFromKmz(kmzOf(KML))) },
  { label: 'GPX', carriesTrack: true, parse: () => processGpx(GPX) },
  { label: 'GeoJSON', carriesTrack: true, parse: () => processGeoJson(GEOJSON) },
  { label: 'CSV', carriesTrack: false, parse: () => processCsv(CSV) },
]

describe('every format reads the same ride the same way', () => {
  for (const f of FORMATS) {
    describe(f.label, () => {
      const r = f.parse()

      it('finds the same stops, in the same order, with the same roles', () => {
        expect(r.points.map((p) => ({ name: p.name, roles: p.roles, lat: p.lat, lng: p.lng }))).toEqual(EXPECTED_STOPS)
      })

      it('reads the description on the stop that has one', () => {
        expect(r.points[0].description).toBe('Meet at the wharf.')
      })

      it('discards altitude rather than storing a third component', () => {
        for (const p of r.points) expect(Object.keys(p)).not.toContain('ele')
        for (const pt of r.track) expect(pt).toHaveLength(2)
      })

      if (f.carriesTrack) {
        it('reads the same track, as [lng, lat]', () => {
          expect(r.track).toEqual(EXPECTED_TRACK)
        })

        it('agrees on distance to within a metre', () => {
          expect(Math.abs(r.trackMeters - trackMeters(EXPECTED_TRACK))).toBeLessThan(1)
        })
      } else {
        it('carries no track, which is the format working as intended', () => {
          expect(r.track).toEqual([])
          expect(r.trackMeters).toBe(0)
        })
      }
    })
  }

  // The assertion the per-format suites structurally cannot make.
  it('produces one stop count and one distance across all of them', () => {
    const counts = new Set(FORMATS.map((f) => f.parse().points.length))
    expect(counts).toEqual(new Set([4]))

    const distances = FORMATS.filter((f) => f.carriesTrack).map((f) => Math.round(f.parse().trackMeters))
    expect(new Set(distances).size).toBe(1)
  })
})

// The ugly cases, run against every format that can express them. A parser that
// only ever sees well-formed files is a parser nobody has tested.
describe('the shapes that break parsers', () => {
  const xml: Array<{ label: string; parse: (s: string) => ExtractedRoute }> = [
    { label: 'KML', parse: processKml },
    { label: 'KMZ', parse: (s) => processKml(extractKmlFromKmz(kmzOf(s))) },
    { label: 'GPX', parse: processGpx },
  ]

  // The defense that makes XXE structurally impossible rather than merely
  // handled: the document is refused before a parser ever runs. It has to hold
  // for a KML hidden inside a KMZ too, which is the whole reason the KMZ path
  // converges on processKml rather than parsing anything itself.
  it('rejects a DOCTYPE in every XML format, including one inside a KMZ', () => {
    const evil = (root: string) =>
      `<?xml version="1.0"?>\n<!DOCTYPE ${root} [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n` +
      `<${root}><name>&xxe;</name></${root}>`
    for (const f of xml) {
      const doc = evil(f.label === 'GPX' ? 'gpx' : 'kml')
      expect(() => f.parse(doc), f.label).toThrow(RouteFileError)
      expect(() => f.parse(doc), f.label).toThrow(/DOCTYPE/)
    }
  })

  it('strips markup out of a name in every format', () => {
    const nasty = '<script>alert(1)</script>Chevron'
    const cases: Array<[string, ExtractedRoute]> = [
      [
        'KML',
        processKml(
          `<kml><Document><Placemark><name>${nasty}</name>` +
            '<Point><coordinates>-122.0,37.0</coordinates></Point></Placemark></Document></kml>',
        ),
      ],
      ['GPX', processGpx(`<gpx><wpt lat="37.0" lon="-122.0"><name>${nasty}</name></wpt></gpx>`)],
      [
        'GeoJSON',
        processGeoJson(
          JSON.stringify({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-122.0, 37.0] },
            properties: { name: nasty },
          }),
        ),
      ],
      ['CSV', processCsv(`name,lat,lng\n"${nasty}",37.0,-122.0\n`)],
    ]
    for (const [label, r] of cases) expect(r.points[0].name, label).toBe('alert(1)Chevron')
  })

  it('reads waypoints with no track at all', () => {
    const r = processGpx('<gpx><wpt lat="37.0" lon="-122.0"><name>Only stop</name></wpt></gpx>')
    expect(r.points).toHaveLength(1)
    expect(r.track).toEqual([])
    // Zero would be a measurement. There is nothing here to measure.
    expect(r.trackMeters).toBe(0)
  })

  it('reads a track with no waypoints', () => {
    const r = processGpx(
      '<gpx><trk><trkseg><trkpt lat="37.0" lon="-122.0"/><trkpt lat="37.1" lon="-122.1"/></trkseg></trk></gpx>',
    )
    expect(r.points).toEqual([])
    expect(r.track).toHaveLength(2)
  })

  // A multi-day GPX carries one <trk> per day. Reading them as one continuous
  // track invents the geometry between where one day ends and the next begins:
  // on a real 3-day ride that turned 553 miles into 631 and pulled twistiness
  // down from 79/69/53 to 59, because the phantom joins are perfectly straight.
  it('takes the longest track rather than joining separate ones end to end', () => {
    const trk = (pts: Array<[number, number]>) =>
      `<trk><trkseg>${pts.map(([lng, lat]) => `<trkpt lat="${lat}" lon="${lng}"/>`).join('')}</trkseg></trk>`
    const r = processGpx(
      `<gpx>${trk([
        [-122.0, 37.0],
        [-122.1, 37.1],
      ])}${trk([
        [-121.0, 36.0],
        [-121.1, 36.1],
        [-121.2, 36.2],
      ])}</gpx>`,
    )
    expect(r.track).toEqual([
      [-121, 36],
      [-121.1, 36.1],
      [-121.2, 36.2],
    ])
  })

  // But a <trkseg> break inside one <trk> is a recording pause in a single
  // ride, so those are joined. The two cases look alike and are not.
  it('joins segments within one track, because a break there is a pause', () => {
    const r = processGpx(
      '<gpx><trk>' +
        '<trkseg><trkpt lat="37.0" lon="-122.0"/><trkpt lat="37.1" lon="-122.1"/></trkseg>' +
        '<trkseg><trkpt lat="37.2" lon="-122.2"/></trkseg>' +
        '</trk></gpx>',
    )
    expect(r.track).toHaveLength(3)
  })

  it('falls back to route points when a GPX has no track', () => {
    const r = processGpx('<gpx><rte><rtept lat="37.0" lon="-122.0"/><rtept lat="37.1" lon="-122.1"/></rte></gpx>')
    expect(r.track).toHaveLength(2)
  })

  // A degenerate line is a real export: a planner that saved before the second
  // point was placed. It must be a zero-length track, not a crash and not a NaN.
  it('handles a one-point line without producing NaN', () => {
    for (const [label, r] of [
      [
        'KML',
        processKml(
          '<kml><Document><Placemark><LineString><coordinates>-122.0,37.0</coordinates></LineString></Placemark></Document></kml>',
        ),
      ],
      ['GeoJSON', processGeoJson(JSON.stringify({ type: 'LineString', coordinates: [[-122.0, 37.0]] }))],
    ] as Array<[string, ExtractedRoute]>) {
      expect(Number.isNaN(r.trackMeters), label).toBe(false)
      expect(r.trackMeters, label).toBe(0)
    }
  })

  it('handles two identical points without producing NaN', () => {
    const r = processGeoJson(
      JSON.stringify({
        type: 'LineString',
        coordinates: [
          [-122.0, 37.0],
          [-122.0, 37.0],
        ],
      }),
    )
    expect(r.trackMeters).toBe(0)
  })
})

// payload → export → import. Only the formats this app can currently write;
// KML and GPX generation is still to come and joins this table when it lands.
describe('a ride survives export and re-import', () => {
  const ride: ExportRide = {
    title: 'Coast run',
    description: 'Highway 1 north from Santa Cruz.',
    routes: [
      {
        title: 'Day 1',
        color: '#cc0000',
        distanceM: Math.round(trackMeters(EXPECTED_TRACK)),
        durationS: 0,
        startAt: null,
        endAt: null,
        twistinessDpm: 118,
        twistinessBestDpm: 240,
        track: EXPECTED_TRACK,
        points: EXPECTED_STOPS.map((s, i) => ({
          lat: s.lat,
          lng: s.lng,
          name: s.name,
          description: i === 0 ? 'Meet at the wharf.' : null,
          roles: s.roles as never,
          kind: (i === 2 ? 'poi' : 'stop') as 'stop' | 'poi',
          durationMin: i === 1 ? 15 : null,
          distFromStartM: null,
        })),
      },
    ],
  }

  const writers: Array<{
    label: string
    build: () => string
    parse: (s: string) => ExtractedRoute
    keepsTrack: boolean
    // KML and GPX have nowhere to put a stop/POI distinction or a dwell time —
    // a Placemark and a <wpt> are the same thing whatever we meant by them. The
    // roles survive because the name prefix carries them.
    keepsKindAndDwell: boolean
  }> = [
    {
      label: 'GeoJSON',
      build: () => buildGeoJson(ride),
      parse: processGeoJson,
      keepsTrack: true,
      keepsKindAndDwell: true,
    },
    { label: 'CSV', build: () => buildCsv(ride), parse: processCsv, keepsTrack: false, keepsKindAndDwell: true },
    { label: 'KML', build: () => buildKml(ride), parse: processKml, keepsTrack: true, keepsKindAndDwell: false },
    { label: 'GPX', build: () => buildGpx(ride), parse: processGpx, keepsTrack: true, keepsKindAndDwell: false },
  ]

  for (const w of writers) {
    describe(w.label, () => {
      const back = w.parse(w.build())

      it('keeps the same stops, in the same order, with the same roles', () => {
        expect(back.points.map((p) => ({ name: p.name, roles: p.roles }))).toEqual(
          EXPECTED_STOPS.map((s) => ({ name: s.name, roles: s.roles })),
        )
      })

      it('keeps coordinates to within a metre', () => {
        back.points.forEach((p, i) => {
          // ~0.3 m at this latitude, which is finer than any consumer GPS and
          // is the precision round6 stores.
          expect(Math.abs(p.lat - EXPECTED_STOPS[i].lat)).toBeLessThan(0.00001)
          expect(Math.abs(p.lng - EXPECTED_STOPS[i].lng)).toBeLessThan(0.00001)
        })
      })

      if (w.keepsKindAndDwell) {
        it('keeps the stop/POI distinction and the dwell time', () => {
          expect(back.points.map((p) => p.kind)).toEqual(['stop', 'stop', 'poi', 'stop'])
          expect(back.points.map((p) => p.durationMin)).toEqual([null, 15, null, null])
        })
      } else {
        // Left undefined rather than set to 'stop': the extractor is saying
        // "this format cannot tell you", which the insert path then reads as a
        // stop. A format that guessed would be indistinguishable from one that
        // knew.
        it('says nothing about kind or dwell, which is all the format can say', () => {
          expect(back.points.map((p) => p.kind)).toEqual([undefined, undefined, undefined, undefined])
          expect(back.points.map((p) => p.durationMin ?? null)).toEqual([null, null, null, null])
        })
      }

      it('writes a file this app will read back — no DOCTYPE', () => {
        expect(w.build()).not.toMatch(/<!DOCTYPE/i)
      })

      if (w.keepsTrack) {
        it('keeps the geometry to within a metre', () => {
          expect(back.track).toHaveLength(EXPECTED_TRACK.length)
          expect(Math.abs(back.trackMeters - trackMeters(EXPECTED_TRACK))).toBeLessThan(1)
        })
      } else {
        it('drops the geometry, which the format cannot hold', () => {
          expect(back.track).toEqual([])
        })
      }
    })
  }
})

// What is knowingly given up, asserted so it stays a decision. These are the
// two places a ride does not survive a round trip, and both are properties of
// the import side rather than of any format. When either is fixed these fail,
// which is the point — a limitation nobody has written down is just a bug that
// has not been noticed yet.
describe('the fidelity that is knowingly lost', () => {
  const twoDays: ExportRide = {
    title: 'Two days',
    description: null,
    routes: [
      {
        title: 'Day 1',
        color: '#cc0000',
        distanceM: 1000,
        durationS: 0,
        startAt: null,
        endAt: null,
        twistinessDpm: null,
        twistinessBestDpm: null,
        // Deliberately the shorter of the two.
        track: [
          [-122.0, 37.0],
          [-122.1, 37.1],
        ],
        points: [
          {
            lat: 37.0,
            lng: -122.0,
            name: 'A',
            description: null,
            roles: [],
            kind: 'stop',
            durationMin: null,
            distFromStartM: null,
          },
        ],
      },
      {
        title: 'Day 2',
        color: '#0000cc',
        distanceM: 2000,
        durationS: 0,
        startAt: null,
        endAt: null,
        twistinessDpm: null,
        twistinessBestDpm: null,
        track: [
          [-122.2, 37.2],
          [-122.3, 37.3],
          [-122.4, 37.4],
        ],
        points: [
          {
            lat: 37.2,
            lng: -122.2,
            name: 'B',
            description: null,
            roles: [],
            kind: 'stop',
            durationMin: null,
            distFromStartM: null,
          },
        ],
      },
    ],
  }

  // The import pipeline builds exactly one route, so a multi-day ride comes
  // back flattened: every stop survives, but the days do not, and only the
  // longest line becomes the track. Confirmed against a real 3-day ride, where
  // 6293 track points came back as 2553.
  it('flattens a multi-day ride to one day, keeping every stop', () => {
    const back = processGeoJson(buildGeoJson(twoDays))
    expect(back.points.map((p) => p.name)).toEqual(['A', 'B'])
    expect(back.track).toEqual([
      [-122.2, 37.2],
      [-122.3, 37.3],
      [-122.4, 37.4],
    ])
  })

  // Per-day colour and title live on the route row, and the importer takes
  // neither — colour comes from the upload form, and the day has no name.
  it('does not carry per-day colour or title back in', () => {
    const written = JSON.parse(buildGeoJson(twoDays))
    // Both are written, so the loss is on the import side and a third-party
    // tool still sees them.
    expect(written.features[0].properties.stroke).toBe('#cc0000')
    expect(written.features[0].properties.name).toBe('Day 1')
    // ExtractedRoute has nowhere to put either.
    const back: ExtractedRoute = processGeoJson(buildGeoJson(twoDays))
    expect(Object.keys(back)).toEqual(['points', 'track', 'trackMeters'])
  })
})
