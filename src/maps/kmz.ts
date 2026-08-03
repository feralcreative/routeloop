// KMZ: a zip with a KML inside it, which is what Google Earth actually saves
// and therefore what most riders have on disk.
//
// This is the first archive the app has ever opened, so it is written as a
// reader rather than pulled in as a dependency — the security properties here
// are the whole job, and they are not ones to delegate to a package whose
// defaults are tuned for extracting build artifacts:
//
//   * Exactly one entry is read, the first .kml. A KMZ can carry images,
//     overlays and models; none of it is wanted and none of it is touched.
//   * The cap is on the *decompressed* size, enforced during inflate rather
//     than trusted from the header. A zip bomb is small on the wire and its
//     declared size is whatever the attacker typed.
//   * Nothing is written to disk here, and no entry name ever reaches the
//     filesystem. The extracted KML goes back to the caller as a string and is
//     stored under the usual integer-id path, so zip-slip has no surface.
//
// Central directory only. The local header's sizes are allowed to be zero when
// the data-descriptor flag is set (streamed zips do this), and the central
// directory is the copy that is always populated.
import { inflateRawSync } from 'node:zlib'
import { KML_MAX_BYTES, RouteFileError } from './kml'

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

const EOCD_MIN = 22
const CD_FIXED = 46
const LOCAL_FIXED = 30

const STORED = 0
const DEFLATED = 8

const ZIP64_MARKER = 0xffffffff

// The end-of-central-directory record is last, but a zip may carry a trailing
// comment of up to 64 KB, so its position is found by scanning backwards for
// the signature rather than assumed.
function findEocd(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - EOCD_MIN - 0xffff)
  for (let i = buf.length - EOCD_MIN; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  throw new RouteFileError('KMZ file is not a valid archive')
}

type Entry = {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  encrypted: boolean
}

function readCentralDirectory(buf: Buffer): Entry[] {
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)

  if (cdOffset === ZIP64_MARKER || cdSize === ZIP64_MARKER || count === 0xffff) {
    throw new RouteFileError('KMZ file uses the ZIP64 format, which is not supported')
  }
  if (cdOffset + cdSize > buf.length) throw new RouteFileError('KMZ file is truncated')

  const entries: Entry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + CD_FIXED > cdOffset + cdSize) throw new RouteFileError('KMZ file is truncated')
    if (buf.readUInt32LE(p) !== CD_SIG) throw new RouteFileError('KMZ file is not a valid archive')

    const flags = buf.readUInt16LE(p + 8)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)

    entries.push({
      // latin1, not utf8: an entry name is only ever compared against a
      // lowercase ".kml" here and is never used as a path, so decoding it
      // faithfully matters less than decoding it without throwing.
      name: buf.toString('latin1', p + CD_FIXED, p + CD_FIXED + nameLen),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      uncompressedSize: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
      encrypted: (flags & 0x1) !== 0,
    })

    p += CD_FIXED + nameLen + extraLen + commentLen
  }
  return entries
}

function readEntry(buf: Buffer, entry: Entry): Buffer {
  if (entry.encrypted) throw new RouteFileError('KMZ file is password-protected')
  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw new RouteFileError(`KMZ file uses an unsupported compression method (${entry.method})`)
  }
  if (entry.compressedSize === ZIP64_MARKER || entry.uncompressedSize === ZIP64_MARKER) {
    throw new RouteFileError('KMZ file uses the ZIP64 format, which is not supported')
  }

  // The declared size is a claim, and rejecting on it is only a cheap way to
  // refuse an obvious bomb before spending CPU. The real cap is maxOutputLength
  // below, which stops inflating regardless of what the header said.
  if (entry.uncompressedSize > KML_MAX_BYTES) {
    throw new RouteFileError(`KML inside the KMZ exceeds ${KML_MAX_BYTES / (1024 * 1024)} MB`)
  }

  const lh = entry.localOffset
  if (lh + LOCAL_FIXED > buf.length) throw new RouteFileError('KMZ file is truncated')
  if (buf.readUInt32LE(lh) !== LOCAL_SIG) throw new RouteFileError('KMZ file is not a valid archive')

  // Name and extra lengths are read from the local header, not the central
  // one: the two are allowed to differ, and only the local copy describes
  // where this entry's data actually starts.
  const start = lh + LOCAL_FIXED + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28)
  const end = start + entry.compressedSize
  if (end > buf.length) throw new RouteFileError('KMZ file is truncated')

  const data = buf.subarray(start, end)
  if (entry.method === STORED) {
    if (data.length > KML_MAX_BYTES) {
      throw new RouteFileError(`KML inside the KMZ exceeds ${KML_MAX_BYTES / (1024 * 1024)} MB`)
    }
    return data
  }

  try {
    return inflateRawSync(data, { maxOutputLength: KML_MAX_BYTES })
  } catch (e) {
    // ERR_BUFFER_TOO_LARGE is the bomb case and is the rider's problem to fix;
    // anything else here means the deflate stream is corrupt, which is also
    // theirs. Neither is a server fault, so both become a RouteFileError.
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new RouteFileError(`KML inside the KMZ exceeds ${KML_MAX_BYTES / (1024 * 1024)} MB`)
    }
    throw new RouteFileError('KMZ file could not be decompressed')
  }
}

// Pull the KML out of a KMZ. Returns its text; the caller hands it to
// processKml, which is where every other defense already lives.
export function extractKmlFromKmz(buf: Buffer): string {
  const entries = readCentralDirectory(buf)

  // The KML spec says the main document is the first .kml in the archive, and
  // directory entries are skipped so a folder called "route.kml/" cannot be
  // mistaken for one. Everything else in the archive is ignored outright.
  const main = entries.find((e) => /\.kml$/i.test(e.name) && !e.name.endsWith('/'))
  if (!main) throw new RouteFileError('KMZ file contains no .kml')

  return readEntry(buf, main).toString('utf8')
}
