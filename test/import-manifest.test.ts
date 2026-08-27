// The import review manifest: the rider's corrections, checked against the files
// actually posted.
//
// The rule this file exists to pin is the strict one — one entry per posted
// file, in order, names matching — because the failure it prevents is invisible:
// a manifest applied to the wrong file dates day 2 with day 3's date and nothing
// anywhere raises it.
import { describe, expect, it } from 'vitest'
import { parseWallClock, readManifest } from '../src/maps/manifest'

const json = (v: unknown) => JSON.stringify(v)
const entry = (fileName: string, title?: string | null, startAt?: string | null) => ({ fileName, title, startAt })

describe('parseWallClock', () => {
  it('reads a bare date as midnight UTC', () => {
    const d = parseWallClock('2026-08-24')
    expect(d?.toISOString()).toBe('2026-08-24T00:00:00.000Z')
  })

  it('reads a datetime-local value as the same wall clock in UTC', () => {
    // The whole point: 9am typed is 9am stored, whatever zone the browser is in.
    expect(parseWallClock('2026-08-24T09:00')?.toISOString()).toBe('2026-08-24T09:00:00.000Z')
  })

  it('accepts a space instead of the T', () => {
    expect(parseWallClock('2026-08-24 09:00')?.toISOString()).toBe('2026-08-24T09:00:00.000Z')
  })

  it('trims', () => {
    expect(parseWallClock('  2026-08-24  ')?.toISOString()).toBe('2026-08-24T00:00:00.000Z')
  })

  it('refuses a day that does not exist rather than rolling it forward', () => {
    // Date.UTC(2026, 1, 31) is 3 March. A silently moved day is worse than a
    // refusal the rider can see.
    expect(parseWallClock('2026-02-31')).toBeNull()
    expect(parseWallClock('2026-13-01')).toBeNull()
    expect(parseWallClock('2026-08-32')).toBeNull()
  })

  it('refuses an out-of-range clock', () => {
    expect(parseWallClock('2026-08-24T24:00')).toBeNull()
    expect(parseWallClock('2026-08-24T09:60')).toBeNull()
  })

  it('refuses anything that is not the two shapes an input element posts', () => {
    for (const v of ['', 'today', '24/08/2026', '2026-8-4', '2026-08-24T09:00:00', '2026-08-24T09']) {
      expect(parseWallClock(v), v).toBeNull()
    }
  })

  it('takes a leap day in a leap year and refuses it otherwise', () => {
    expect(parseWallClock('2028-02-29')?.toISOString()).toBe('2028-02-29T00:00:00.000Z')
    expect(parseWallClock('2026-02-29')).toBeNull()
  })
})

describe('readManifest', () => {
  it('reads one entry per file, in order', () => {
    const r = readManifest(json([entry('a.gpx', 'Coast', '2026-08-24'), entry('b.gpx', 'Hills', null)]), [
      'a.gpx',
      'b.gpx',
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entries[0].title).toBe('Coast')
    expect(r.entries[0].startAt?.toISOString()).toBe('2026-08-24T00:00:00.000Z')
    expect(r.entries[1].startAt).toBeNull()
  })

  it('refuses a manifest whose names do not line up with the files', () => {
    // The selection changed after the review. Matching by index alone would
    // apply Coast's date to b.gpx and say nothing.
    const r = readManifest(json([entry('a.gpx'), entry('b.gpx')]), ['b.gpx', 'a.gpx'])
    expect(r.ok).toBe(false)
  })

  it('refuses a manifest of the wrong length', () => {
    expect(readManifest(json([entry('a.gpx')]), ['a.gpx', 'b.gpx']).ok).toBe(false)
    expect(readManifest(json([entry('a.gpx'), entry('b.gpx')]), ['a.gpx']).ok).toBe(false)
  })

  it('refuses an empty manifest, which is not the same as no manifest', () => {
    expect(readManifest(json([]), []).ok).toBe(false)
  })

  it('refuses malformed JSON rather than throwing', () => {
    expect(readManifest('{', ['a.gpx']).ok).toBe(false)
    expect(readManifest('null', ['a.gpx']).ok).toBe(false)
    expect(readManifest(json([{ title: 'no name' }]), ['a.gpx']).ok).toBe(false)
  })

  it('names the file and the value when a date will not parse', () => {
    const r = readManifest(json([entry('a.gpx', null, 'the 24th')]), ['a.gpx'])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('a.gpx')
    expect(r.error).toContain('the 24th')
  })

  it('treats an empty or whitespace title as no title', () => {
    // A rider who cleared the box means the day has no name. Storing "" would
    // put an empty legend on the roadbook.
    const r = readManifest(json([entry('a.gpx', '   ')]), ['a.gpx'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entries[0].title).toBeNull()
  })

  it('takes an absent title and an absent date as null', () => {
    const r = readManifest(json([{ fileName: 'a.gpx' }]), ['a.gpx'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entries[0]).toEqual({ fileName: 'a.gpx', title: null, startAt: null })
  })

  it('gives a zip an entry that carries nothing', () => {
    // The browser cannot read inside an archive, so its row exists only to keep
    // the positions lining up.
    const r = readManifest(json([entry('day-1.gpx', 'Coast'), entry('rest.zip')]), ['day-1.gpx', 'rest.zip'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entries[1]).toEqual({ fileName: 'rest.zip', title: null, startAt: null })
  })

  it('refuses more entries than a ride may have files', () => {
    const many = Array.from({ length: 31 }, (_, i) => entry(`d${i}.gpx`))
    expect(
      readManifest(
        json(many),
        many.map((m) => m.fileName),
      ).ok,
    ).toBe(false)
  })
})
