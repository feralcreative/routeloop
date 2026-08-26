// Stored originals are kept brotli-compressed on disk.
//
// WHY BROTLI AND NOT GZIP. Measured on a real 8-day GPX import in `storage/`:
// 834,594 B raw, 115,046 B at gzip -9, 59,895 B at brotli q11 — 7.3x against
// 13.9x. Both codecs are in Node core, so the better ratio costs nothing but the
// compression time, and that is paid once at import rather than on every read.
// An imported GPX is the most compressible thing this app stores.
//
// WHY THE `.br` SUFFIX IS NOT OPTIONAL. Gzip has magic bytes (1f 8b) and could
// therefore be sniffed out of a file still called `50-6.gpx`. **Brotli has no
// magic number at all** — there is no reliable way to look at a byte stream and
// say whether it is brotli or the XML it compresses. So the name has to carry
// it, which also means a half-migrated directory can be read at a glance.
//
// QUOTA ACCOUNTING IS UNAFFECTED AND MUST STAY THAT WAY. `kml_bytes`,
// `gpx_bytes` and `source_bytes` keep meaning the size of the original AS THE
// RIDER UPLOADED IT — an allowance must not depend on how well someone's file
// happened to compress. The consequence to state rather than treat as a bug:
// `rides.size_bytes` no longer describes bytes on disk. "How much disk are we
// using" is a `du`, not a query, and there is deliberately no second column.
//
// ASYNC, NOT THE SYNC VARIANTS. Brotli at quality 11 takes a few hundred
// milliseconds on a megabyte, and every compression here happens inside a
// request. brotliCompressSync would block the event loop for the whole import.
import { promisify } from 'node:util'
import { brotliCompress, brotliDecompress, constants } from 'node:zlib'

const compress = promisify(brotliCompress)
const decompress = promisify(brotliDecompress)

/** The suffix appended to a stored original's name. */
export const BR_EXT = '.br'

/**
 * A ceiling on what one file may decompress to.
 *
 * These are files this app wrote, not attacker-supplied archives, so this is not
 * the defence that `src/maps/zip.ts` needs on the way in — it is a guard against
 * a corrupt or hand-edited file turning a download into an out-of-memory. Set
 * from the import body limit rather than invented: nothing larger than that
 * could have been stored in the first place.
 */
export const MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024

/**
 * Compresses a stored original.
 *
 * SIZE_HINT is passed because brotli uses it to pick its window, and getting it
 * right is worth a few percent on exactly the file sizes this app deals in.
 */
export async function compressStored(data: Buffer): Promise<Buffer> {
  return compress(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  })
}

/** Decompresses one, refusing anything that claims to expand past the cap. */
export async function decompressStored(data: Buffer): Promise<Buffer> {
  return decompress(data, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
}
