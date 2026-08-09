// public/js/filename.js against src/maps/filename.ts.
//
// There are two implementations because the drop box has to tell a rider what
// it read out of their filenames before anything is uploaded, and the server
// has no bundler to hand it the TypeScript one. Two implementations of a format
// drift, so this asserts they do not — the same arrangement twist-client.test.ts
// uses on twist.js, and for the same reason.
//
// The file is eval'd rather than imported: it is a browser script that assigns
// to window, which is exactly why it lives outside builder.js.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildExportName, parseExportName, planImport, slugField, splitExt, titleFromSlug } from '../src/maps/filename'

let F: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/filename.js', 'utf8'))(win)
  F = (win as any).TBFilename
})

// Everything the server can write, plus the shapes a rider might hand-edit into
// and the ordinary files that must not be read as structured at all.
const NAMES = [
  'tankbag_big-sur-run_d02_2026-08-14_lost-coast.gpx',
  'tankbag_big-sur-run_d01_2026-08-13T0830_coast-start.kml',
  'tankbag_r_d10_2026-12-01.geojson',
  'tankbag_r_d02.gpx',
  'tankbag_r_2026-08-14.gpx',
  'tankbag_r_lost-coast.csv',
  'tankbag_r.tankbag.json',
  'tankbag_r_d2.gpx',
  'TANKBAG_r_d02.gpx',
  'tankbag_r_d00.gpx',
  'tankbag_r_2026-02-30.gpx',
  'tankbag_r_d01_2026-08-14_a_b.gpx',
  'tankbag_canon-trip_d03_2026-08-14_cote.geojson',
  // Not the convention. Every one of these must parse to null on both sides.
  'day-2.gpx',
  'Big Sur Run.gpx',
  '2026-08-14.gpx',
  'd02_2026-08-14_lost-coast.gpx',
  'tankbag.gpx',
  'my_tankbag_ride.gpx',
  'Track_001.gpx',
]

describe('filename.js agrees with filename.ts', () => {
  it('parses every name identically', () => {
    for (const name of NAMES) {
      const ts = parseExportName(name)
      const js = F.parseExportName(name)
      if (ts === null) {
        expect(js, name).toBeNull()
        continue
      }
      expect(js, name).not.toBeNull()
      expect({ ...js, date: js.date?.toISOString() ?? null }, name).toEqual({
        ...ts,
        date: ts.date?.toISOString() ?? null,
      })
    }
  })

  it('slugs identically, including the cases that are easy to get wrong', () => {
    const inputs = ['Lost Coast', 'Cañón', 'Côte d’Azur', 'day_two_coast', '  --Big   Sur!!  ', '***', '']
    for (const s of inputs) expect(F.slugField(s), s).toBe(slugField(s))
    expect(F.slugField('aaaa bbbb cccc dddd', 10)).toBe(slugField('aaaa bbbb cccc dddd', 10))
  })

  it('recovers titles identically', () => {
    for (const s of ['lost-coast', 'avenue-of-giants', 'a', '']) {
      expect(F.titleFromSlug(s), s).toBe(titleFromSlug(s))
    }
  })

  it('splits extensions identically', () => {
    for (const n of NAMES.concat(['noext', '.hidden', 'a.GPX'])) {
      expect(F.splitExt(n), n).toEqual(splitExt(n))
    }
  })

  it('plans a folder identically', () => {
    const folders = [
      [
        'tankbag_big-sur-run_d03_2026-08-15_avenue-of-giants.gpx',
        'tankbag_big-sur-run_d01_2026-08-13_coast-start.gpx',
        'tankbag_big-sur-run_d02_2026-08-14_lost-coast.gpx',
      ],
      ['tankbag_r_d02.gpx', 'whatever.gpx', 'tankbag_r_d01.gpx'],
      ['tankbag_a_d01.gpx', 'tankbag_b_d02.gpx'],
      ['day-1.gpx', 'day-2.gpx'],
      ['tankbag_r_d02_b.gpx', 'tankbag_r_d02_a.gpx'],
      [],
    ]
    const flat = (p: any) => ({
      ...p,
      files: p.files.map((f: any) => ({ ...f, date: f.date?.toISOString() ?? null })),
    })
    for (const folder of folders) {
      expect(flat(F.planImport(folder)), folder.join()).toEqual(flat(planImport(folder)))
    }
  })

  // The client never builds a name, but every name the server builds has to be
  // one the client can read — that is the whole round trip.
  it('reads back everything the server writes', () => {
    const cases = [
      { ride: 'Big Sur Run', day: 2, date: new Date(Date.UTC(2026, 7, 14)), title: 'Lost Coast', ext: 'gpx' },
      { ride: 'Big Sur Run', day: 12, date: new Date(Date.UTC(2026, 11, 1, 7, 5)), title: 'Rest Day', ext: 'kml' },
      { ride: 'r', day: 1, ext: 'tankbag.json' },
      { ride: 'Solo', ext: 'csv' },
    ]
    for (const c of cases) {
      const name = buildExportName(c)
      const js = F.parseExportName(name)
      expect(js, name).not.toBeNull()
      expect(js.ride).toBe(slugField(c.ride))
      expect(js.day ?? null).toBe(c.day ?? null)
      expect(js.date?.getTime() ?? null).toBe(c.date?.getTime() ?? null)
    }
  })
})
