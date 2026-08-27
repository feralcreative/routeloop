// The per-format fidelity matrix (#35).
//
// `round-trip.test.ts` proves the formats AGREE about the ride they can all
// express. This file is the other half of that issue: what each format can and
// cannot carry, field by field, asserted rather than described in a comment.
//
// WHY IT IS A TABLE AND NOT A PILE OF CASES. Every loss here is a decision
// somebody made — a KML `<Placemark>` has nowhere to say "we sat here for
// twenty minutes", a CSV has nowhere to put a track — and a decision nobody
// wrote down is indistinguishable from a bug nobody noticed. Declaring the
// verdict per field per format means adding a format, or teaching one a new
// field, fails here until the table is updated to say so on purpose.
//
// TWO DIRECTIONS, BECAUSE THEY DISAGREE. `writes` is what a third-party tool
// opening the file sees; `reads` is what OUR importer gets back. Per-day color
// is the worked example: KML and GeoJSON both write it, and nothing reads it
// back, because a day's color is the viewer's business rather than the file's.
// Collapsing the two columns would hide that.
//
// THE NATIVE JSON IS NOT IN THIS TABLE, and that is the point of it: it carries
// everything, it is the only format that does, and it is covered by
// `native.test.ts` against the same schema the builder's own save goes through.
// Anything below marked lost is lost only on the lossy path.
import { describe, expect, it } from 'vitest'
import { processCsv } from '../src/maps/csv'
import { processGeoJson } from '../src/maps/geojson'
import { buildCsv, buildGeoJson, buildGpx, buildKml, type ExportRide } from '../src/maps/export'
import { processGpx, processKml, type ExtractedRoute } from '../src/maps/kml'

// One day, every field populated and each with a value distinctive enough to
// grep the serialized file for. A null anywhere would make "the format dropped
// it" and "we never gave it one" the same result.
const RIDE: ExportRide = {
  title: 'Fidelity ride',
  description: 'Ride description.',
  hiddenAlts: 0,
  days: [
    {
      title: 'Named day',
      color: '#cc0000',
      distanceM: 12000,
      durationS: 3600,
      startAt: new Date('2026-08-27T09:00:00Z'),
      endAt: new Date('2026-08-27T17:00:00Z'),
      twistinessDpm: 118,
      twistinessBestDpm: 240,
      track: [
        [-122.0, 37.0],
        [-122.1, 37.1],
        [-122.2, 37.2],
      ],
      points: [
        {
          lat: 37.0,
          lng: -122.0,
          name: 'Alpha',
          description: 'Meet at the wharf.',
          roles: ['start'],
          kind: 'stop',
          durationMin: 15,
          distFromStartM: 0,
        },
        {
          lat: 37.1,
          lng: -122.1,
          name: 'Bravo',
          description: null,
          roles: ['gas'],
          kind: 'poi',
          durationMin: null,
          distFromStartM: 8000,
        },
      ],
    },
  ],
}

type FormatKey = 'GPX' | 'KML' | 'GeoJSON' | 'CSV'

const FORMATS: Array<{ key: FormatKey; file: string; back: ExtractedRoute }> = [
  { key: 'GPX', file: buildGpx(RIDE), back: processGpx(buildGpx(RIDE)) },
  { key: 'KML', file: buildKml(RIDE), back: processKml(buildKml(RIDE)) },
  { key: 'GeoJSON', file: buildGeoJson(RIDE), back: processGeoJson(buildGeoJson(RIDE)) },
  { key: 'CSV', file: buildCsv(RIDE), back: processCsv(buildCsv(RIDE)) },
]

// WHAT "CAME BACK" MEANS, AND WHY IT IS NOT `JSON.stringify(back)`. `processKml`
// returns a `KmlResult`, which carries `storedKml` — the entire sanitized
// document, written to disk as the stored original. Stringifying the result
// whole therefore finds every value the FILE holds and reports KML as carrying
// things nothing reads, which is the opposite of what this file is for. Only
// the four extracted fields are the importer's answer.
const visible = (b: ExtractedRoute): string =>
  JSON.stringify({ points: b.points, tracks: b.tracks, track: b.track, trackMeters: b.trackMeters })

// `true` means the field survives, `false` means it does not. `null` means the
// question does not apply to that format at all — a CSV holds no track, so
// "does the track keep its day name" has no answer rather than a negative one.
type Verdict = boolean | null
type Row = Record<FormatKey, Verdict>

const field = (
  label: string,
  spec: {
    // What a third-party tool opening the file would find.
    writes: Row
    inFile: (file: string) => boolean
    // What our own importer gets back out.
    reads: Row
    fromFile: (back: ExtractedRoute) => boolean
    why?: string
  },
) =>
  describe(label, () => {
    for (const f of FORMATS) {
      const w = spec.writes[f.key]
      if (w !== null) {
        it(`${f.key} ${w ? 'writes it' : 'does not write it'}`, () => {
          expect(spec.inFile(f.file)).toBe(w)
        })
      }
      const r = spec.reads[f.key]
      if (r !== null) {
        it(`${f.key} ${r ? 'reads it back' : 'does not read it back'}`, () => {
          expect(spec.fromFile(f.back)).toBe(r)
        })
      }
    }
  })

const all = (v: Verdict): Row => ({ GPX: v, KML: v, GeoJSON: v, CSV: v })

// --- The ride ---------------------------------------------------------------

// The ride's own name and description are metadata three of the four formats
// have somewhere to put. None of them are read back, and that is not a gap:
// `ExtractedRoute` describes one file's contents, and the ride a file becomes
// is named by the upload form or by the filename convention. A file cannot
// rename the ride it is being imported into.
field("the ride's title", {
  writes: { GPX: true, KML: true, GeoJSON: true, CSV: false },
  inFile: (s) => s.includes('Fidelity ride'),
  reads: all(false),
  fromFile: (b) => visible(b).includes('Fidelity ride'),
})

field("the ride's description", {
  writes: { GPX: true, KML: true, GeoJSON: true, CSV: false },
  inFile: (s) => s.includes('Ride description.'),
  reads: all(false),
  fromFile: (b) => visible(b).includes('Ride description.'),
})

// --- The day ----------------------------------------------------------------

// The one piece of day-level structure that makes the whole trip: a <trk>
// name, a KML Folder, a GeoJSON feature name. It is what stops a three-day
// export coming back as one flattened day.
field("the day's name", {
  writes: { GPX: true, KML: true, GeoJSON: true, CSV: false },
  inFile: (s) => s.includes('Named day'),
  reads: { GPX: true, KML: true, GeoJSON: true, CSV: null },
  fromFile: (b) => b.tracks.some((t) => t.name === 'Named day'),
})

// Written by two formats and read back by none, on purpose. Color comes from
// the upload form; a day's color is the viewer's business rather than the
// file's. KML reverses the bytes and prefixes alpha (`aabbggrr`), which is why
// it is matched in its own spelling rather than as `cc0000`.
field("the day's color", {
  writes: { GPX: false, KML: true, GeoJSON: true, CSV: false },
  inFile: (s) => /cc0000|ff0000cc/i.test(s),
  reads: all(false),
  fromFile: (b) => /cc0000|ff0000cc/i.test(visible(b)),
})

// NOT ONE OF THE FOUR CARRIES THE DAY'S CLOCK. GPX and KML have nowhere to put
// a schedule, and GeoJSON — which has arbitrary properties and could — does not
// either, so the four agree. This is the fact the filename convention exists to
// work around: `src/maps/filename.ts` puts the date in the NAME, which is why a
// day exported and re-imported keeps its date at all. Making a format carry it
// is a decision, not a fix; see docs/decisions.md before changing this row.
field("the day's start and end times", {
  writes: all(false),
  inFile: (s) => /2026-08-27|T09:00|17:00/.test(s),
  reads: all(false),
  fromFile: (b) => /2026-08-27|T09:00|17:00/.test(visible(b)),
})

// Distance and twistiness are derived numbers, so writing them is a courtesy to
// whatever opens the file and reading them back would be trusting someone
// else's arithmetic over our own. Both are recomputed from the geometry on the
// way in — `trackMeters` for one, `twist.ts` for the other.
field("the day's measured distance", {
  writes: { GPX: false, KML: false, GeoJSON: true, CSV: false },
  inFile: (s) => /"distanceMi":7\.5/.test(s), // 12000 m, in miles
  reads: all(false),
  fromFile: (b) => visible(b).includes('"distanceMi"'),
})

field("the day's twistiness", {
  writes: { GPX: false, KML: false, GeoJSON: true, CSV: false },
  inFile: (s) => /twistinessDpm/.test(s),
  reads: all(false),
  fromFile: (b) => /twistiness/i.test(visible(b)),
})

// --- The points -------------------------------------------------------------

field("a point's name", {
  writes: all(true),
  inFile: (s) => s.includes('Alpha') && s.includes('Bravo'),
  reads: all(true),
  fromFile: (b) => b.points.map((p) => p.name).join() === 'Alpha,Bravo',
})

// Every format carries roles, but only two of them carry roles as DATA. KML and
// GPX have a name and a description and nowhere else, so the role travels as
// the `[Start] Alpha` name prefix that `parseRoleName` reads back. GeoJSON
// writes both spellings and CSV gives roles their own column.
field("a point's roles", {
  writes: all(true),
  inFile: (s) => /start/i.test(s) && /gas/i.test(s),
  reads: all(true),
  fromFile: (b) => JSON.stringify(b.points.map((p) => p.roles)) === '[["start"],["gas"]]',
})

field("a point's description", {
  writes: all(true),
  inFile: (s) => s.includes('Meet at the wharf.'),
  reads: all(true),
  fromFile: (b) => b.points[0].description === 'Meet at the wharf.',
})

// THE HEADLINE LOSS. A `<wpt>` and a `<Placemark>` are the same thing whatever
// we meant by them, so KML and GPX leave `kind` undefined rather than guessing
// `stop` — a format that guessed would be indistinguishable from one that knew,
// and the insert path is what decides an unanswered kind is a stop.
field("a point's stop/POI kind", {
  writes: { GPX: false, KML: false, GeoJSON: true, CSV: true },
  inFile: (s) => /\bpoi\b/.test(s),
  reads: { GPX: false, KML: false, GeoJSON: true, CSV: true },
  fromFile: (b) => b.points.map((p) => p.kind).join() === 'stop,poi',
})

// Same reasoning, same two formats: neither KML nor GPX has anywhere to say how
// long a rider means to be somewhere.
field("a point's dwell time", {
  writes: { GPX: false, KML: false, GeoJSON: true, CSV: true },
  // The VALUE, not the column: a CSV header names `durationMin` whether or not
  // any row filled it in, so matching the name would pass on an empty column.
  inFile: (s) => /"durationMin":15|,15,/.test(s),
  reads: { GPX: false, KML: false, GeoJSON: true, CSV: true },
  fromFile: (b) => b.points[0].durationMin === 15,
})

// Written for a reader, never read back. `dist_from_start_m` is the prefix sum
// of the legs before a point and is recomputed from the ride's own geometry on
// save, so a number out of a file would be a second opinion about a value we
// derive — and on a trackless import there is nothing to check it against.
field("a point's distance from the start", {
  writes: { GPX: false, KML: false, GeoJSON: true, CSV: true },
  // Same trap as the dwell column above: the value, not the header.
  inFile: (s) => /"distFromStartMi":5|,5\r?$/m.test(s), // 8000 m, in miles
  reads: all(false),
  fromFile: (b) => /distFromStart/i.test(visible(b)),
})

// --- The geometry -----------------------------------------------------------

// The CSV row is the one loss in this file that is structural rather than a
// choice about a field: there is no column shape that holds a few thousand
// shaping points, and writing a straight line between the stops and calling it
// a route would be worse than saying nothing.
field('the shaping points that make the route a route', {
  writes: { GPX: true, KML: true, GeoJSON: true, CSV: false },
  inFile: (s) => s.includes('-122.2') && s.includes('37.2'),
  reads: { GPX: true, KML: true, GeoJSON: true, CSV: false },
  fromFile: (b) => b.track.length === 3,
})

// The claim the whole matrix rests on: a format is lossy in the ways declared
// above and in no others that anybody has found. Read as a summary, not as an
// assertion of its own — every cell in it is tested individually.
describe('the matrix as a whole', () => {
  it('has exactly four lossy formats, and the native JSON is not one of them', () => {
    expect(FORMATS.map((f) => f.key)).toEqual(['GPX', 'KML', 'GeoJSON', 'CSV'])
  })

  it('loses the most through CSV and the least through GeoJSON', () => {
    // Point count is the floor every format clears; what separates them is
    // whether the geometry and the kind came with it.
    const carried = (f: (typeof FORMATS)[number]) =>
      [f.back.points.length === 2, f.back.track.length === 3, f.back.points[1].kind === 'poi'].filter(Boolean).length
    const byKey = Object.fromEntries(FORMATS.map((f) => [f.key, carried(f)]))
    expect(byKey.GeoJSON).toBe(3)
    expect(byKey.GPX).toBe(2)
    expect(byKey.KML).toBe(2)
    expect(byKey.CSV).toBe(2)
  })
})
