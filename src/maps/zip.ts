// Zip, both directions.
//
// The reading half was `kmz.ts`'s private internals until the naming convention
// gave the app a second reason to open an archive — a folder of per-day route
// files, exported by this app and dragged back in. It is factored out here
// unchanged rather than duplicated, and kmz.ts still owns the *policy* that made
// it careful: one entry, the first .kml, everything else ignored.
//
// The security properties travel with the reader and are the whole reason this
// is hand-rolled rather than a dependency:
//
//   * The cap is on the DECOMPRESSED size and enforced during inflate, never
//     read from the header. A zip bomb is small on the wire and its declared
//     size is whatever the author typed.
//   * Multi-entry reads carry a running total as well as a per-entry cap.
//     Fifty entries each a byte under the cap is fifty times the cap.
//   * An entry name never reaches the filesystem. Callers store under
//     integer-id paths (storage.ts), and `entryBaseName` below strips any
//     directory an archive tries to carry, so zip-slip has no surface.
//
// The writing half is new, and exists because a multi-day ride wants one file
// per day and a browser can only be handed one. Note test/helpers/zip.ts is a
// *different* writer and deliberately stays: it builds deliberately malformed
// archives for the reader's tests, writes no CRC, and would produce a file that
// macOS Archive Utility refuses.
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

const EOCD_MIN = 22
const CD_FIXED = 46
const LOCAL_FIXED = 30

const STORED = 0
const DEFLATED = 8

const ZIP64_MARKER = 0xffffffff
const MAX_U16 = 0xffff

// --- Reading ---------------------------------------------------------------

export type ZipReadOptions = {
  /** Names the archive in errors: "KMZ" gives "KMZ file is truncated". */
  label: string
  /** Per-entry cap on the decompressed size. */
  maxEntryBytes: number
  /** The sentence for an entry over that cap. Each caller words its own. */
  oversize: (maxBytes: number) => string
  /** Thrown for every failure here, so callers keep their own error type. */
  error: (message: string) => Error
}

export type ZipEntryMeta = {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  encrypted: boolean
}

// The end-of-central-directory record is last, but a zip may carry a trailing
// comment of up to 64 KB, so its position is found by scanning backwards for
// the signature rather than assumed.
function findEocd(buf: Buffer, o: ZipReadOptions): number {
  const earliest = Math.max(0, buf.length - EOCD_MIN - 0xffff)
  for (let i = buf.length - EOCD_MIN; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  throw o.error(`${o.label} file is not a valid archive`)
}

// Central directory only. The local header's sizes are allowed to be zero when
// the data-descriptor flag is set (streamed zips do this), and the central
// directory is the copy that is always populated.
export function readZipCentralDirectory(buf: Buffer, o: ZipReadOptions): ZipEntryMeta[] {
  const eocd = findEocd(buf, o)
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)

  if (cdOffset === ZIP64_MARKER || cdSize === ZIP64_MARKER || count === MAX_U16) {
    throw o.error(`${o.label} file uses the ZIP64 format, which is not supported`)
  }
  if (cdOffset + cdSize > buf.length) throw o.error(`${o.label} file is truncated`)

  const entries: ZipEntryMeta[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + CD_FIXED > cdOffset + cdSize) throw o.error(`${o.label} file is truncated`)
    if (buf.readUInt32LE(p) !== CD_SIG) throw o.error(`${o.label} file is not a valid archive`)

    const flags = buf.readUInt16LE(p + 8)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)

    entries.push({
      // latin1, not utf8: a name here is matched against an extension and then
      // discarded, and decoding it without throwing matters more than decoding
      // it faithfully. It is never used as a path — see entryBaseName.
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

export function readZipEntry(buf: Buffer, entry: ZipEntryMeta, o: ZipReadOptions): Buffer {
  if (entry.encrypted) throw o.error(`${o.label} file is password-protected`)
  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw o.error(`${o.label} file uses an unsupported compression method (${entry.method})`)
  }
  if (entry.compressedSize === ZIP64_MARKER || entry.uncompressedSize === ZIP64_MARKER) {
    throw o.error(`${o.label} file uses the ZIP64 format, which is not supported`)
  }

  // The declared size is a claim, and rejecting on it is only a cheap way to
  // refuse an obvious bomb before spending CPU. The real cap is maxOutputLength
  // below, which stops inflating regardless of what the header said.
  if (entry.uncompressedSize > o.maxEntryBytes) throw o.error(o.oversize(o.maxEntryBytes))

  const lh = entry.localOffset
  if (lh + LOCAL_FIXED > buf.length) throw o.error(`${o.label} file is truncated`)
  if (buf.readUInt32LE(lh) !== LOCAL_SIG) throw o.error(`${o.label} file is not a valid archive`)

  // Name and extra lengths are read from the local header, not the central
  // one: the two are allowed to differ, and only the local copy describes
  // where this entry's data actually starts.
  const start = lh + LOCAL_FIXED + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28)
  const end = start + entry.compressedSize
  if (end > buf.length) throw o.error(`${o.label} file is truncated`)

  const data = buf.subarray(start, end)
  if (entry.method === STORED) {
    if (data.length > o.maxEntryBytes) throw o.error(o.oversize(o.maxEntryBytes))
    return data
  }

  try {
    return inflateRawSync(data, { maxOutputLength: o.maxEntryBytes })
  } catch (e) {
    // ERR_BUFFER_TOO_LARGE is the bomb case and is the rider's problem to fix;
    // anything else here means the deflate stream is corrupt, which is also
    // theirs. Neither is a server fault.
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ERR_BUFFER_TOO_LARGE') throw o.error(o.oversize(o.maxEntryBytes))
    throw o.error(`${o.label} file could not be decompressed`)
  }
}

/**
 * The basename of an archive entry, with any directory an archive tried to
 * carry removed. Both separators, because a zip written on Windows uses
 * backslashes and the spec's "no backslashes" rule is widely ignored.
 *
 * This is what makes "../../etc/passwd" harmless: it becomes "passwd", and even
 * that is only ever read for its extension and its day fields — callers write
 * to integer-id paths and never to a name that came out of an archive.
 */
export function entryBaseName(name: string): string {
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return cut === -1 ? name : name.slice(cut + 1)
}

/**
 * True for the entries macOS adds when you right-click and Compress: an
 * `__MACOSX/` tree of `._name` resource forks, one shadowing every real file.
 * Left in, a three-day zip imports as six days, three of them binary junk.
 */
export const isArchiveCruft = (name: string): boolean =>
  name.startsWith('__MACOSX/') || entryBaseName(name).startsWith('._') || entryBaseName(name) === '.DS_Store'

export type ZipReadAllOptions = ZipReadOptions & {
  /** Cap across every entry read, not just each one. */
  maxTotalBytes: number
  maxEntries: number
  /** Called with the basename; false skips the entry entirely. */
  keep: (baseName: string) => boolean
  tooMany: (maxEntries: number) => string
  tooLarge: (maxTotalBytes: number) => string
}

/**
 * Every entry the caller wants, decompressed. Directory entries and archive
 * cruft are dropped before `keep` is consulted, so a caller only ever sees
 * plausible files.
 */
export function readZipEntries(buf: Buffer, o: ZipReadAllOptions): Array<{ name: string; data: Buffer }> {
  const wanted = readZipCentralDirectory(buf, o).filter((e) => {
    if (e.name.endsWith('/')) return false
    if (isArchiveCruft(e.name)) return false
    return o.keep(entryBaseName(e.name))
  })

  if (wanted.length > o.maxEntries) throw o.error(o.tooMany(o.maxEntries))

  const out: Array<{ name: string; data: Buffer }> = []
  let total = 0
  for (const e of wanted) {
    const data = readZipEntry(buf, e, o)
    total += data.length
    // Checked as it accumulates rather than after the loop, so a bomb spread
    // across many entries stops partway instead of being measured once it has
    // already been held in memory.
    if (total > o.maxTotalBytes) throw o.error(o.tooLarge(o.maxTotalBytes))
    out.push({ name: entryBaseName(e.name), data })
  }
  return out
}

// --- Writing ---------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// The zip epoch. DOS timestamps cannot express anything earlier, and using it as
// the default makes an archive a pure function of its contents — which is what
// lets the tests assert on bytes.
const ZIP_EPOCH = new Date(Date.UTC(1980, 0, 1))

// DOS date/time: 7 bits of year-since-1980, 4 of month, 5 of day; 5 of hour,
// 6 of minute, 5 of two-second units. UTC getters for the same reason
// filename.ts uses them — a local reading would make the bytes machine-dependent.
function dosStamp(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getUTCFullYear())
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  }
}

export type ZipFile = { name: string; body: Buffer }

/**
 * A zip a rider's operating system will open.
 *
 * Deflate is tried and kept only when it wins, which for route files is always
 * — a GPX of a day's geometry is thousands of near-identical decimal strings —
 * but a tiny CSV can inflate under deflate's block overhead and is stored instead.
 *
 * No ZIP64, deliberately: the format's 32-bit fields are the reason the reader
 * above can refuse ZIP64 outright, and an app whose largest route file is capped
 * in the low megabytes has no business emitting an archive it would not read
 * back. The guards throw rather than silently writing something unreadable.
 */
export function buildZip(files: ZipFile[], modifiedAt: Date = ZIP_EPOCH): Buffer {
  if (files.length > MAX_U16) throw new Error(`a zip cannot carry more than ${MAX_U16} entries`)

  const { time, date } = dosStamp(modifiedAt)
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const f of files) {
    // Checked before deflating, not after: handing zlib something that claims
    // to be four gigabytes is how you find out the hard way.
    if (f.body.length >= ZIP64_MARKER || offset >= ZIP64_MARKER) {
      throw new Error('zip contents exceed the 32-bit limits this writer supports')
    }

    const name = Buffer.from(f.name, 'utf8')
    const deflated = deflateRawSync(f.body)
    const store = deflated.length >= f.body.length
    const data = store ? f.body : deflated
    const method = store ? STORED : DEFLATED
    const crc = crc32(f.body)

    const local = Buffer.alloc(LOCAL_FIXED)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4) // version needed to extract: 2.0
    local.writeUInt16LE(0x800, 6) // flags: filename is UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(f.body.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, data)

    const cd = Buffer.alloc(CD_FIXED)
    cd.writeUInt32LE(CD_SIG, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0x800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(f.body.length, 24)
    cd.writeUInt16LE(name.length, 28)
    // 0644 in the high two bytes, which is where unzip looks for a mode. Left
    // at zero an extracted file's permissions are whatever the umask says,
    // which on some tools means 000.
    cd.writeUInt32LE(0o644 << 16, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)

    offset += LOCAL_FIXED + name.length + data.length
  }

  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(EOCD_MIN)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...parts, cdBuf, eocd])
}
