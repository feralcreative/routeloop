/**
 * Compresses stored originals that are still on disk uncompressed.
 *
 *   npx tsx utils/compress-originals.ts --dry-run   # report, change nothing
 *   npx tsx utils/compress-originals.ts             # compress them
 *
 * New imports are written brotli-compressed by writeMapFile(). This is what
 * brings the files already in `storage/` up to the same shape. Take a backup of
 * `storage/` first — this replaces files.
 *
 * IDEMPOTENT AND RESUMABLE, which matters more here than speed: it skips
 * anything already carrying `.br`, so an interrupted run is fixed by running it
 * again. Nothing else has to be true for that to hold — the two spellings are
 * both valid on disk and readMapFile() reads either, so a half-migrated
 * directory is a working directory rather than a broken one. There is no
 * deadline to finish by.
 *
 * VERIFIES BEFORE IT DELETES. Every file is compressed, written under the new
 * name, read back, decompressed, and compared to the original bytes before the
 * original is unlinked. Brotli is not going to lose data, but this is a rider's
 * only copy of the file they uploaded and the check costs one read.
 *
 * `utils/` is not in tsconfig.json, so `npm run typecheck` does not cover this
 * file. Check it by hand — the invocation is in AGENTS.md.
 */
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { compressStored, decompressStored } from '../src/maps/compress'
import { mapFilePath, ownerDirPath, parseStoredName, STORAGE } from '../src/maps/storage'

const dryRun = process.argv.includes('--dry-run')

const fmt = (n: number): string => `${(n / 1024).toFixed(1)} kB`

// One directory per rider, named for the id. Anything else in the storage root
// is not ours and is left alone rather than guessed at.
const owners = (await readdir(STORAGE).catch(() => [] as string[]))
  .map((name) => Number(name))
  .filter((id) => Number.isSafeInteger(id) && id > 0)
  .sort((a, b) => a - b)

let done = 0
let skipped = 0
let failed = 0
let before = 0
let after = 0

for (const ownerId of owners) {
  const dir = ownerDirPath(ownerId)
  if (!dir) continue
  const names = await readdir(dir).catch(() => [] as string[])

  for (const name of names) {
    const parsed = parseStoredName(name)
    // Not one of ours, or already done. A thumbnail (`19-thumb.png`) parses as
    // null and is skipped here, which is right — it is a PNG and already
    // compressed, and re-compressing it would cost bytes rather than save them.
    if (!parsed) continue
    if (parsed.compressed) {
      skipped++
      continue
    }

    const from = mapFilePath(ownerId, parsed.rideId, parsed.ext, parsed.index)
    const to = mapFilePath(ownerId, parsed.rideId, parsed.ext, parsed.index, true)
    if (!from || !to) {
      console.error(`  ! ${name}: refused to build a path, skipping`)
      failed++
      continue
    }

    try {
      const raw = await readFile(from)
      const packed = await compressStored(raw)
      before += raw.length
      after += packed.length

      if (dryRun) {
        console.log(`  ${ownerId}/${name}: ${fmt(raw.length)} → ${fmt(packed.length)}`)
        done++
        continue
      }

      await writeFile(to, packed, { mode: 0o640 })

      // Read back from disk rather than trusting the buffer in hand: the point
      // is to prove the FILE is good before removing the only other copy.
      const check = await decompressStored(await readFile(to))
      if (!check.equals(raw)) throw new Error('round-trip mismatch')

      await unlink(from)
      done++
      console.log(`  ${ownerId}/${name}: ${fmt(raw.length)} → ${fmt(packed.length)}`)
    } catch (err) {
      // The original is untouched on any failure — it is only unlinked after the
      // round-trip check passes — so a failure here costs nothing but a retry.
      console.error(`  ! ${ownerId}/${name} failed:`, err instanceof Error ? err.message : err)
      failed++
      // Clear a partial write so the next run does not skip it as already done.
      if (!dryRun) await unlink(to).catch(() => {})
    }
  }
}

const ratio = after > 0 ? (before / after).toFixed(1) : '—'
console.log(
  `\n${dryRun ? 'Would compress' : 'Compressed'} ${done} file${done === 1 ? '' : 's'}` +
    ` (${fmt(before)} → ${fmt(after)}, ${ratio}x), skipped ${skipped} already done, ${failed} failed.`,
)
process.exit(failed > 0 ? 1 : 0)
