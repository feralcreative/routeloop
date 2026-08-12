// KMZ: a zip with a KML inside it, which is what Google Earth actually saves
// and therefore what most riders have on disk.
//
// The zip mechanics moved to zip.ts when the naming convention gave the app a
// second reason to open an archive. What stays here is the part that is about
// KMZ rather than about zip, and it is the part that matters:
//
//   * Exactly one entry is read, the first .kml. A KMZ can carry images,
//     overlays and models; none of it is wanted and none of it is touched.
//     This is policy, not a limitation of the reader — readZipEntries would
//     happily return all of them.
//   * The cap is on the *decompressed* size, enforced during inflate rather
//     than trusted from the header. A zip bomb is small on the wire and its
//     declared size is whatever the attacker typed. (zip.ts, readZipEntry.)
//   * Nothing is written to disk here, and no entry name ever reaches the
//     filesystem. The extracted KML goes back to the caller as a string and is
//     stored under the usual integer-id path, so zip-slip has no surface.
import { KML_MAX_BYTES, RouteFileError } from './kml'
import { readZipCentralDirectory, readZipEntry, type ZipReadOptions } from './zip'

// Every message this reader can produce, kept here rather than in zip.ts so a
// rider is told which of their files is the problem in the words they'd expect.
const KMZ_ZIP: ZipReadOptions = {
  label: 'KMZ',
  maxEntryBytes: KML_MAX_BYTES,
  oversize: (max) => `KML inside the KMZ exceeds ${max / (1024 * 1024)} MB`,
  error: (m) => new RouteFileError(m),
}

// Pull the KML out of a KMZ. Returns its text; the caller hands it to
// processKml, which is where every other defense already lives.
export function extractKmlFromKmz(buf: Buffer): string {
  const entries = readZipCentralDirectory(buf, KMZ_ZIP)

  // The KML spec says the main document is the first .kml in the archive, and
  // directory entries are skipped so a folder called "route.kml/" cannot be
  // mistaken for one. Everything else in the archive is ignored outright.
  const main = entries.find((e) => /\.kml$/i.test(e.name) && !e.name.endsWith('/'))
  if (!main) throw new RouteFileError('KMZ file contains no .kml')

  return readZipEntry(buf, main, KMZ_ZIP).toString('utf8')
}
