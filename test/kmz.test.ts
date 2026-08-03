// The KMZ reader, which is the first archive this app opens and therefore the
// first place a zip bomb or a zip-slip name could land.
//
// The archives are built here rather than committed as fixtures for one
// reason: the interesting cases are the malformed ones, and a hand-built zip
// is the only way to produce a header that lies about its own contents. That
// is exactly what the decompression cap has to survive.
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { KML_MAX_BYTES, RouteFileError } from '../src/maps/kml'
import { extractKmlFromKmz } from '../src/maps/kmz'

type Entry = { name: string; body: Buffer; store?: boolean }

// A minimal writer, matched to the reader: local header, data, central
// directory, EOCD. No zip64, no data descriptors, no extra fields.
function makeZip(entries: Entry[], opts: { declaredSize?: (e: Entry) => number; comment?: string } = {}) {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const name = Buffer.from(e.name, 'latin1')
    const data = e.store ? e.body : deflateRawSync(e.body)
    const declared = opts.declaredSize ? opts.declaredSize(e) : e.body.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(e.store ? 0 : 8, 8) // compression method
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(declared, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(e.store ? 0 : 8, 10)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(declared, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)

    offset += local.length + name.length + data.length
  }

  const cdBuf = Buffer.concat(central)
  const comment = Buffer.from(opts.comment ?? '', 'latin1')
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(comment.length, 20)

  return Buffer.concat([...parts, cdBuf, eocd, comment])
}

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><name>Start</name><Point><coordinates>-122.4,37.8,0</coordinates></Point></Placemark>
</Document></kml>`

const kmz = (entries: Entry[], opts?: Parameters<typeof makeZip>[1]) => makeZip(entries, opts)
const buf = (s: string) => Buffer.from(s, 'utf8')

describe('extractKmlFromKmz', () => {
  it('pulls the KML out of an ordinary archive', () => {
    expect(extractKmlFromKmz(kmz([{ name: 'doc.kml', body: buf(KML) }]))).toBe(KML)
  })

  it('reads a stored (uncompressed) entry too', () => {
    expect(extractKmlFromKmz(kmz([{ name: 'doc.kml', body: buf(KML), store: true }]))).toBe(KML)
  })

  it('ignores the images and overlays a real KMZ carries', () => {
    const archive = kmz([
      { name: 'files/icon.png', body: Buffer.alloc(2048, 7) },
      { name: 'doc.kml', body: buf(KML) },
      { name: 'files/overlay.jpg', body: Buffer.alloc(4096, 3) },
    ])
    expect(extractKmlFromKmz(archive)).toBe(KML)
  })

  it('finds the EOCD past a trailing archive comment', () => {
    const archive = kmz([{ name: 'doc.kml', body: buf(KML) }], { comment: 'x'.repeat(300) })
    expect(extractKmlFromKmz(archive)).toBe(KML)
  })

  it('takes the first .kml and does not care what it is named', () => {
    const other = KML.replace('Start', 'Second')
    const archive = kmz([
      { name: 'My Route.kml', body: buf(KML) },
      { name: 'doc.kml', body: buf(other) },
    ])
    expect(extractKmlFromKmz(archive)).toBe(KML)
  })

  it('does not mistake a directory named like a KML for one', () => {
    const archive = kmz([
      { name: 'route.kml/', body: Buffer.alloc(0), store: true },
      { name: 'doc.kml', body: buf(KML) },
    ])
    expect(extractKmlFromKmz(archive)).toBe(KML)
  })

  it('refuses an archive with no KML in it', () => {
    const archive = kmz([{ name: 'notes.txt', body: buf('nothing here') }])
    expect(() => extractKmlFromKmz(archive)).toThrow(RouteFileError)
    expect(() => extractKmlFromKmz(archive)).toThrow(/no \.kml/)
  })

  it('refuses something that is not an archive at all', () => {
    expect(() => extractKmlFromKmz(buf(KML))).toThrow(RouteFileError)
  })

  // The one that matters. A zip bomb is small on the wire and its header says
  // whatever the author wanted it to say, so neither the upload size nor the
  // declared size can be the check.
  it('refuses a bomb whose header lies about how big it decompresses to', () => {
    const huge = Buffer.alloc(KML_MAX_BYTES + 1024, 0x41)
    const archive = kmz([{ name: 'doc.kml', body: huge }], { declaredSize: () => 512 })

    // The lie is in place: on the wire this is tiny and it claims to be 512 B.
    expect(archive.length).toBeLessThan(64 * 1024)

    expect(() => extractKmlFromKmz(archive)).toThrow(RouteFileError)
    expect(() => extractKmlFromKmz(archive)).toThrow(/exceeds/)
  })

  it('refuses an oversized entry that is honest about its size', () => {
    const huge = Buffer.alloc(KML_MAX_BYTES + 1024, 0x41)
    expect(() => extractKmlFromKmz(kmz([{ name: 'doc.kml', body: huge }]))).toThrow(/exceeds/)
  })

  it('refuses an oversized stored entry, which never passes through inflate', () => {
    const huge = Buffer.alloc(KML_MAX_BYTES + 1024, 0x41)
    const archive = kmz([{ name: 'doc.kml', body: huge, store: true }], { declaredSize: () => 512 })
    expect(() => extractKmlFromKmz(archive)).toThrow(/exceeds/)
  })

  it('refuses an encrypted entry rather than returning its ciphertext', () => {
    const archive = kmz([{ name: 'doc.kml', body: buf(KML) }])
    // Set the encryption bit in the central directory copy of the flags. The
    // central directory sits cdSize+22 from the end, before the EOCD.
    const cdStart = archive.length - 22 - (46 + 'doc.kml'.length)
    archive.writeUInt16LE(0x1, cdStart + 8)
    expect(() => extractKmlFromKmz(archive)).toThrow(/password-protected/)
  })

  it('refuses a compression method it does not implement', () => {
    const archive = kmz([{ name: 'doc.kml', body: buf(KML) }])
    const cdStart = archive.length - 22 - (46 + 'doc.kml'.length)
    archive.writeUInt16LE(14, cdStart + 10) // LZMA
    expect(() => extractKmlFromKmz(archive)).toThrow(/unsupported compression method/)
  })

  it('refuses a truncated archive rather than reading past the end', () => {
    const archive = kmz([{ name: 'doc.kml', body: buf(KML) }])
    const cdStart = archive.length - 22 - (46 + 'doc.kml'.length)
    archive.writeUInt32LE(archive.length + 5000, cdStart + 20) // compressed size
    expect(() => extractKmlFromKmz(archive)).toThrow(/truncated/)
  })

  it('refuses ZIP64 rather than misreading its 32-bit fields', () => {
    const archive = kmz([{ name: 'doc.kml', body: buf(KML) }])
    archive.writeUInt32LE(0xffffffff, archive.length - 22 + 16) // CD offset
    expect(() => extractKmlFromKmz(archive)).toThrow(/ZIP64/)
  })

  it('refuses a corrupt deflate stream', () => {
    const archive = kmz([{ name: 'doc.kml', body: buf(KML) }])
    // Local header is at 0; data starts after the fixed 30 bytes and the name.
    archive.fill(0xff, 30 + 'doc.kml'.length, 30 + 'doc.kml'.length + 8)
    // Specifically the inflate failure, not one of the header checks upstream
    // of it — otherwise this would pass without ever reaching zlib.
    expect(() => extractKmlFromKmz(archive)).toThrow(/could not be decompressed/)
  })
})
