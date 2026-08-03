// Path construction for stored originals.
//
// This is the only place in the app where a filesystem path is built, and the
// only part of it not derived from an integer id is the extension, which comes
// from a closed list. The containment check is belt and braces on top of that.
// A folder import added an index to the name, which is a second number in a
// path — hence these.
import { describe, expect, it } from 'vitest'
import { MAX_SOURCE_FILES, STORAGE, mapFilePath, STORED_EXTS } from '../src/maps/storage'

describe('mapFilePath', () => {
  it('names the first file without an index, as every existing file is named', () => {
    expect(mapFilePath(2, 19, 'kml')).toBe(`${STORAGE}/2/19.kml`)
    expect(mapFilePath(2, 19, 'kml', 0)).toBe(`${STORAGE}/2/19.kml`)
  })

  it('indexes the rest', () => {
    expect(mapFilePath(2, 19, 'gpx', 1)).toBe(`${STORAGE}/2/19-1.gpx`)
    expect(mapFilePath(2, 19, 'gpx', 11)).toBe(`${STORAGE}/2/19-11.gpx`)
  })

  it('stays inside the storage root for every extension', () => {
    for (const ext of STORED_EXTS) {
      expect(mapFilePath(1, 1, ext)?.startsWith(`${STORAGE}/`), ext).toBe(true)
    }
  })

  it('refuses an index outside the range a ride can have', () => {
    expect(mapFilePath(2, 19, 'gpx', -1)).toBeUndefined()
    expect(mapFilePath(2, 19, 'gpx', MAX_SOURCE_FILES)).toBeUndefined()
    expect(mapFilePath(2, 19, 'gpx', 9999)).toBeUndefined()
  })

  // An index is a number, so there is nothing to traverse with — but the check
  // is what makes that a guarantee rather than an observation about today's
  // callers.
  it('refuses a non-integer index rather than coercing it into the name', () => {
    expect(mapFilePath(2, 19, 'gpx', 1.5)).toBeUndefined()
    expect(mapFilePath(2, 19, 'gpx', Number.NaN)).toBeUndefined()
    expect(mapFilePath(2, 19, 'gpx', Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  // Ids reach this from the database as numbers, never from a request, so this
  // is about the guarantee holding if that ever changes.
  it('cannot be walked out of the root by a hostile id', () => {
    for (const path of [
      mapFilePath(-1, 1, 'kml'),
      mapFilePath(1, -1, 'kml'),
      mapFilePath(Number('../..' as unknown as string), 1, 'kml'),
    ]) {
      if (path !== undefined) expect(path.startsWith(`${STORAGE}/`)).toBe(true)
    }
  })
})
