// The zip writer, and the multi-entry reading the naming convention needs.
//
// The reader's security behavior is already covered end to end by
// test/kmz.test.ts, which drives the same code through extractKmlFromKmz. What
// is asserted here is what that path never exercises: writing an archive other
// software will open, and reading more than one entry out of one.
import { describe, expect, it } from 'vitest'
import { buildExportName, planImport, titleFromSlug } from '../src/maps/filename'
import {
  buildZip,
  entryBaseName,
  isArchiveCruft,
  readZipCentralDirectory,
  readZipEntries,
  type ZipReadAllOptions,
} from '../src/maps/zip'

const MB = 1024 * 1024

const opts = (over: Partial<ZipReadAllOptions> = {}): ZipReadAllOptions => ({
  label: 'Zip',
  maxEntryBytes: 1 * MB,
  maxTotalBytes: 4 * MB,
  maxEntries: 10,
  keep: () => true,
  oversize: (max) => `a file inside the zip exceeds ${max / MB} MB`,
  tooMany: (max) => `too many files — ${max} is the limit`,
  tooLarge: (max) => `the zip decompresses to more than ${max / MB} MB`,
  error: (m) => new Error(m),
  ...over,
})

const body = (s: string) => Buffer.from(s, 'utf8')

describe('buildZip', () => {
  it('round-trips through our own reader', () => {
    const zip = buildZip([
      { name: 'routeloop_r_d01.gpx', body: body('<gpx/>') },
      { name: 'routeloop_r_d02.gpx', body: body('<gpx>two</gpx>') },
    ])
    const out = readZipEntries(zip, opts())
    expect(out.map((e) => e.name)).toEqual(['routeloop_r_d01.gpx', 'routeloop_r_d02.gpx'])
    expect(out[1].data.toString('utf8')).toBe('<gpx>two</gpx>')
  })

  // The CRC-32 check value from the standard: crc32("123456789") is 0xCBF43926.
  // The reader here does not verify CRCs, so nothing else in the suite would
  // catch a wrong one — but macOS Archive Utility and `unzip` both refuse it,
  // which would only be discovered by a rider downloading a broken file.
  it('writes a correct CRC-32', () => {
    const zip = buildZip([{ name: 'a', body: body('123456789') }])
    // Local header: fixed 30 bytes, CRC at offset 14, name is 1 byte.
    expect(zip.readUInt32LE(14)).toBe(0xcbf43926)
    // The central directory copy has to agree, or the two disagree about the file.
    const cd = readZipCentralDirectory(zip, opts())
    expect(cd).toHaveLength(1)
  })

  it('deflates when it wins and stores when it does not', () => {
    const compressible = buildZip([{ name: 'a', body: Buffer.alloc(4096, 0x41) }])
    expect(compressible.readUInt16LE(8)).toBe(8) // DEFLATED

    // One byte cannot survive deflate's block overhead, so storing is smaller.
    const tiny = buildZip([{ name: 'a', body: body('x') }])
    expect(tiny.readUInt16LE(8)).toBe(0) // STORED
    expect(readZipEntries(tiny, opts())[0].data.toString('utf8')).toBe('x')
  })

  it('is deterministic, so an unchanged ride exports identical bytes', () => {
    const files = [{ name: 'a.gpx', body: body('<gpx/>') }]
    expect(buildZip(files).equals(buildZip(files))).toBe(true)
    // And a timestamp is the only thing that changes them.
    expect(buildZip(files).equals(buildZip(files, new Date(Date.UTC(2026, 7, 14))))).toBe(false)
  })

  it('writes an empty archive rather than something unreadable', () => {
    expect(readZipEntries(buildZip([]), opts())).toEqual([])
  })

  // The reader rejects ZIP64 outright, so the writer must never emit it. The
  // 4 GB size guard is not exercised here — faking a Buffer length to reach it
  // just sends zlib off to allocate what the fake claims — so what is asserted
  // is the entry-count limit, which is the same guard reachable for free.
  it('refuses to write more entries than the format can address', () => {
    const files = Array.from({ length: 65536 }, (_, i) => ({ name: `f${i}`, body: Buffer.alloc(0) }))
    expect(() => buildZip(files)).toThrow(/more than 65535 entries/)
    expect(() => buildZip(files.slice(0, 65535))).not.toThrow()
  })
})

describe('entryBaseName', () => {
  it('strips any directory an archive tries to carry', () => {
    expect(entryBaseName('day/one.gpx')).toBe('one.gpx')
    expect(entryBaseName('a\\b\\one.gpx')).toBe('one.gpx')
    expect(entryBaseName('one.gpx')).toBe('one.gpx')
  })

  // Not a path traversal defense on its own — callers write to integer-id paths
  // and never to this — but it is what makes the name safe to *read*.
  it('flattens a traversal to a plain name', () => {
    expect(entryBaseName('../../etc/passwd')).toBe('passwd')
  })
})

describe('isArchiveCruft', () => {
  it('recognises what macOS Compress adds', () => {
    expect(isArchiveCruft('__MACOSX/._routeloop_r_d01.gpx')).toBe(true)
    expect(isArchiveCruft('folder/._routeloop_r_d01.gpx')).toBe(true)
    expect(isArchiveCruft('.DS_Store')).toBe(true)
    expect(isArchiveCruft('routeloop_r_d01.gpx')).toBe(false)
  })
})

describe('readZipEntries', () => {
  // The case that made this necessary: zipping three files in Finder produces
  // six entries, and left in, the ride imports as six days with three of them
  // binary junk.
  it('drops macOS resource forks', () => {
    const zip = buildZip([
      { name: '__MACOSX/._d01.gpx', body: body('junk') },
      { name: 'd01.gpx', body: body('<gpx/>') },
      { name: '.DS_Store', body: body('junk') },
    ])
    expect(readZipEntries(zip, opts()).map((e) => e.name)).toEqual(['d01.gpx'])
  })

  it('drops directory entries and applies the caller filter', () => {
    const zip = buildZip([
      { name: 'day/', body: Buffer.alloc(0) },
      { name: 'day/one.gpx', body: body('<gpx/>') },
      { name: 'readme.txt', body: body('hello') },
    ])
    const out = readZipEntries(zip, opts({ keep: (n) => n.endsWith('.gpx') }))
    expect(out.map((e) => e.name)).toEqual(['one.gpx'])
  })

  it('counts entries after filtering, not before', () => {
    const zip = buildZip([
      { name: 'a.gpx', body: body('<gpx/>') },
      { name: 'b.txt', body: body('x') },
      { name: 'c.txt', body: body('x') },
    ])
    expect(() => readZipEntries(zip, opts({ maxEntries: 1 }))).toThrow(/too many files/)
    expect(readZipEntries(zip, opts({ maxEntries: 1, keep: (n) => n.endsWith('.gpx') }))).toHaveLength(1)
  })

  // Per-entry caps do not bound an archive: fifty entries each a byte under the
  // cap is fifty times the cap.
  it('caps the total across entries, not only each one', () => {
    const each = Buffer.alloc(300 * 1024, 0x41)
    const zip = buildZip([
      { name: 'a.gpx', body: each },
      { name: 'b.gpx', body: each },
      { name: 'c.gpx', body: each },
    ])
    expect(readZipEntries(zip, opts())).toHaveLength(3)
    expect(() => readZipEntries(zip, opts({ maxTotalBytes: 700 * 1024 }))).toThrow(/decompresses to more than/)
  })

  it('still caps each entry on its own', () => {
    const zip = buildZip([{ name: 'a.gpx', body: Buffer.alloc(2 * MB, 0x41) }])
    expect(() => readZipEntries(zip, opts())).toThrow(/exceeds 1 MB/)
  })

  it('reports the caller label in archive errors', () => {
    expect(() => readZipEntries(body('not a zip at all'), opts({ label: 'Route' }))).toThrow(
      /Route file is not a valid archive/,
    )
  })
})

// The point of the whole sprint, asserted end to end across the pure parts: a
// per-day archive this app writes, dragged back in, comes out as the trip it
// left as. Only the database insert is missing, and that is what it is given.
describe('a per-day export round-trips back to a plan', () => {
  const RIDE = 'Big Sur Run'
  const DAYS = [
    { day: 1, date: new Date(Date.UTC(2026, 7, 13)), title: 'Coast Start' },
    { day: 2, date: new Date(Date.UTC(2026, 7, 14, 8, 30)), title: 'Lost Coast' },
    { day: 3, date: new Date(Date.UTC(2026, 7, 15)), title: 'Avenue of Giants' },
  ]

  const archive = () =>
    buildZip(
      // Reversed, because entry order in an archive is whatever wrote it and
      // must not be what the import depends on.
      [...DAYS].reverse().map((d) => ({
        name: buildExportName({ ride: RIDE, day: d.day, date: d.date, title: d.title, ext: 'gpx' }),
        body: body(`<gpx><trk><name>${d.title}</name></trk></gpx>`),
      })),
    )

  it('recovers the trip, the day order and every date', () => {
    const entries = readZipEntries(archive(), opts({ keep: (n) => n.endsWith('.gpx') }))
    const plan = planImport(entries.map((e) => e.name))

    expect(plan.ride).toBe('Big Sur Run')
    expect(plan.allConforming).toBe(true)
    expect(plan.reordered).toBe(true)
    expect(plan.files.map((f) => f.day)).toEqual([1, 2, 3])
    expect(plan.files.map((f) => f.date?.toISOString())).toEqual([
      '2026-08-13T00:00:00.000Z',
      '2026-08-14T08:30:00.000Z',
      '2026-08-15T00:00:00.000Z',
    ])
    // The time on day 2 survived; the other two are bare days, not midnights.
    expect(plan.files.map((f) => f.hasTime)).toEqual([false, true, false])
  })

  // The lossy edge, asserted rather than left to be discovered: a title that
  // went through slugField comes back capitalised by guess. This is why the
  // importer prefers a file's own internal name over its filename.
  it('recovers titles as a guess, which is why the file wins', () => {
    const entries = readZipEntries(archive(), opts({ keep: (n) => n.endsWith('.gpx') }))
    const plan = planImport(entries.map((e) => e.name))
    expect(plan.files.map((f) => (f.title ? titleFromSlug(f.title) : null))).toEqual([
      'Coast Start',
      'Lost Coast',
      'Avenue Of Giants', // not "Avenue of Giants"
    ])
  })
})
