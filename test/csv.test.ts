// CSV import, and the round-trip back out through the exporter.
//
// The parser is hand-written, so the tests that matter are the ones about the
// grammar rather than about days: a quoted comma, a doubled quote, an
// embedded newline, CRLF. Those are what separate a parser from a `split(',')`,
// and "Chevron, Petaluma" is a name a rider will actually type.
import { describe, expect, it } from 'vitest'
import { buildCsv, type ExportRide } from '../src/maps/export'
import { processCsv } from '../src/maps/csv'
import { RouteFileError } from '../src/maps/kml'

const HEAD = 'name,lat,lng'

describe('processCsv', () => {
  it('reads a plain stop list', () => {
    const r = processCsv(`${HEAD}\nSanta Cruz,36.9741,-122.0308\nDavenport,37.0113,-122.1922\n`)
    expect(r.points.map((p) => p.name)).toEqual(['Santa Cruz', 'Davenport'])
    expect(r.points[0]).toMatchObject({ lat: 36.9741, lng: -122.0308 })
  })

  // The whole reason for a real parser rather than a split.
  it('keeps a comma inside a quoted field', () => {
    const r = processCsv(`${HEAD}\n"Chevron, Petaluma",38.2324,-122.6367\n`)
    expect(r.points[0].name).toBe('Chevron, Petaluma')
  })

  it('unescapes a doubled quote', () => {
    const r = processCsv(`${HEAD}\n"The ""Grill""",38.2324,-122.6367\n`)
    expect(r.points[0].name).toBe('The "Grill"')
  })

  it('keeps a newline inside a quoted field', () => {
    const r = processCsv('name,lat,lng,description\nA,38.2,-122.6,"line one\nline two"\n')
    expect(r.points[0].description).toBe('line one\nline two')
  })

  it('reads CRLF line endings, which is what a spreadsheet writes', () => {
    const r = processCsv(`${HEAD}\r\nA,38.2,-122.6\r\nB,38.3,-122.7\r\n`)
    expect(r.points).toHaveLength(2)
  })

  it('reads a file with no trailing newline', () => {
    expect(processCsv(`${HEAD}\nA,38.2,-122.6`).points).toHaveLength(1)
  })

  it('skips a blank line rather than reading it as a stop at 0,0', () => {
    const r = processCsv(`${HEAD}\nA,38.2,-122.6\n\nB,38.3,-122.7\n`)
    expect(r.points).toHaveLength(2)
  })

  it('strips a byte-order mark instead of failing to find the columns', () => {
    const r = processCsv(`﻿${HEAD}\nA,38.2,-122.6\n`)
    expect(r.points).toHaveLength(1)
  })

  // A semicolon file with decimal commas is what a spreadsheet saves in most of
  // Europe. Refusing it would refuse a lot of riders for no reason.
  it('sniffs a semicolon delimiter and a decimal comma', () => {
    const r = processCsv('name;lat;lng\nA;38,2324;-122,6367\n')
    expect(r.points[0]).toMatchObject({ lat: 38.2324, lng: -122.6367 })
  })

  it('sniffs a tab delimiter', () => {
    const r = processCsv('name\tlat\tlng\nA\t38.2\t-122.6\n')
    expect(r.points).toHaveLength(1)
  })

  it('is not fooled into sniffing a delimiter that only appears inside quotes', () => {
    const r = processCsv('"a;b;c;d",lat,lng\nA,38.2,-122.6\n')
    expect(r.points[0]).toMatchObject({ lat: 38.2, lng: -122.6 })
  })

  it('accepts the header spellings other tools use', () => {
    const r = processCsv('Title,Latitude,Longitude,Notes\nA,38.2,-122.6,hello\n')
    expect(r.points[0]).toMatchObject({ name: 'A', lat: 38.2, lng: -122.6, description: 'hello' })
  })

  it('does not care about column order', () => {
    const r = processCsv('lng,name,lat\n-122.6,A,38.2\n')
    expect(r.points[0]).toMatchObject({ name: 'A', lat: 38.2, lng: -122.6 })
  })

  it('reads roles from their own column', () => {
    const r = processCsv('name,lat,lng,roles\nChevron,38.2,-122.6,GAS/FOOD\n')
    expect(r.points[0].roles).toEqual(['gas', 'food'])
  })

  it('still reads the name-prefix convention when there is no roles column', () => {
    const r = processCsv(`${HEAD}\nGAS - Chevron,38.2,-122.6\n`)
    expect(r.points[0]).toMatchObject({ name: 'Chevron', roles: ['gas'] })
  })

  it('reads kind and dwell', () => {
    const r = processCsv('name,lat,lng,kind,durationMin\nA,38.2,-122.6,poi,20\n')
    expect(r.points[0]).toMatchObject({ kind: 'poi', durationMin: 20 })
  })

  it('names an unnamed stop rather than storing an empty label', () => {
    const r = processCsv(`${HEAD}\n,38.2,-122.6\n,38.3,-122.7\n`)
    expect(r.points.map((p) => p.name)).toEqual(['Stop 1', 'Stop 2'])
  })

  it('strips markup out of a name', () => {
    const r = processCsv(`${HEAD}\n<script>alert(1)</script>X,38.2,-122.6\n`)
    expect(r.points[0].name).toBe('alert(1)X')
  })

  // The point of the format: no geometry, and none invented.
  it('returns no track, so twistiness has nothing to measure', () => {
    const r = processCsv(`${HEAD}\nA,38.2,-122.6\nB,38.3,-122.7\n`)
    expect(r.track).toEqual([])
    expect(r.trackMeters).toBe(0)
  })

  it('refuses a file with no latitude or longitude column, and says what it found', () => {
    expect(() => processCsv('name,place,notes\nA,B,C\n')).toThrow(RouteFileError)
    expect(() => processCsv('name,place,notes\nA,B,C\n')).toThrow(/Found: name, place, notes/)
  })

  it('refuses a header-only file', () => {
    expect(() => processCsv(`${HEAD}\n`)).toThrow(/no stops/)
  })

  it('refuses an empty file', () => {
    expect(() => processCsv('   ')).toThrow(/empty/)
  })

  it('refuses a coordinate that is not a number, naming the row', () => {
    expect(() => processCsv(`${HEAD}\nA,north,-122.6\n`)).toThrow(/row 2: "north" is not a latitude/)
  })

  it('refuses an out-of-range latitude', () => {
    expect(() => processCsv(`${HEAD}\nA,138.2,-122.6\n`)).toThrow(/latitude 138.2 is out of range/)
  })

  it('reads a short row as a missing value, naming the row', () => {
    expect(() => processCsv('name,lat,lng\nA,38.2\n')).toThrow(/row 2: "" is not a longitude/)
  })

  it('refuses more stops than a day can hold', () => {
    const rows = Array.from({ length: 250 }, (_, i) => `S${i},38.2,-122.6`).join('\n')
    expect(() => processCsv(`${HEAD}\n${rows}\n`)).toThrow(/more than 200 stops/)
  })
})

describe('buildCsv → processCsv round-trip', () => {
  const ride: ExportRide = {
    title: 'Bodega weekend',
    description: null,
    days: [
      {
        title: 'Day 1',
        color: '#cc0000',
        distanceM: 16000,
        durationS: 0,
        startAt: null,
        endAt: null,
        twistinessDpm: 214,
        twistinessBestDpm: 340,
        track: [
          [-122.4194, 37.7749],
          [-122.2711, 37.8044],
        ],
        points: [
          {
            lat: 37.7749,
            lng: -122.4194,
            name: 'Chevron, Petaluma',
            description: 'top off\nbefore the hills',
            roles: ['gas', 'food'],
            kind: 'stop',
            durationMin: 15,
            distFromStartM: 0,
          },
          {
            lat: 37.8044,
            lng: -122.2711,
            name: 'The "Overlook"',
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

  const out = processCsv(buildCsv(ride))

  it('survives the names that break a naive parser', () => {
    expect(out.points.map((p) => p.name)).toEqual(['Chevron, Petaluma', 'The "Overlook"'])
  })

  it('keeps roles, kind, dwell and description', () => {
    expect(out.points).toEqual([
      {
        lat: 37.7749,
        lng: -122.4194,
        name: 'Chevron, Petaluma',
        description: 'top off\nbefore the hills',
        roles: ['gas', 'food'],
        kind: 'stop',
        durationMin: 15,
      },
      {
        lat: 37.8044,
        lng: -122.2711,
        name: 'The "Overlook"',
        description: null,
        roles: ['view'],
        kind: 'poi',
        durationMin: 10,
      },
    ])
  })

  it('loses the track, which is the format working as intended', () => {
    expect(out.track).toEqual([])
  })

  it('writes a header a spreadsheet can read', () => {
    expect(buildCsv(ride).split('\r\n')[0]).toBe('day,kind,name,lat,lng,roles,durationMin,description,distFromStartMi')
  })
})
