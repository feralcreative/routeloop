// A minimal zip writer, matched to the reader in src/maps/kmz.ts: local header,
// data, central directory, EOCD. No zip64, no data descriptors, no extra fields.
//
// It exists so KMZ fixtures are built rather than committed. A binary blob in
// the repo is unreviewable, and the cases worth testing are the malformed ones —
// an archive whose header lies about its own contents is not something `zip`
// will produce for you.
import { deflateRawSync } from 'node:zlib'

export type ZipEntry = { name: string; body: Buffer; store?: boolean }

export type ZipOptions = {
  // Overrides the uncompressed size written into both headers, which is how a
  // bomb is built: tiny on the wire, honest-looking in the header.
  declaredSize?: (e: ZipEntry) => number
  comment?: string
}

export function makeZip(entries: ZipEntry[], opts: ZipOptions = {}): Buffer {
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

// Wraps a KML string as the KMZ a planner would save: the document plus the
// image assets that come with it and which the reader must ignore.
export const kmzOf = (kml: string): Buffer =>
  makeZip([
    { name: 'files/icon.png', body: Buffer.alloc(512, 7) },
    { name: 'doc.kml', body: Buffer.from(kml, 'utf8') },
  ])
