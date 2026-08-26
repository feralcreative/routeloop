// Where a bike's photo lives on disk.
//
// In the rider's own storage directory, beside their ride originals and
// thumbnails, and named so it cannot be confused with either. That placement is
// what makes the account purge work for free: `deleteOwnerDir()` removes the
// directory itself rather than files it can name, so a bike photo goes with the
// account without this module being involved.
//
// `bike-7.webp` DELIBERATELY DOES NOT PARSE as a stored ride original.
// `parseStoredName()` matches `<digits>[-<digits>].<ext>[.br]`, so a name
// starting with letters returns null — which is exactly right. It means
// `listOwnerFiles()` skips these, the account archive does not offer a bike
// photo as a route file, and `deleteMapFiles()` leaves them alone when a ride is
// purged. Same arrangement `<id>-thumb.png` already relies on.
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { STORAGE } from '../maps/storage'
import { PROCESSED_EXT } from '../images/process'

/** Absolute path for a bike's photo, or undefined if it would escape the root.
 *  Both components are integers and the extension is a constant, so there is
 *  nothing here for a caller to inject — the check is belt and braces. */
export function bikePhotoPath(ownerId: number, bikeId: number): string | undefined {
  if (!Number.isInteger(ownerId) || ownerId <= 0) return undefined
  if (!Number.isInteger(bikeId) || bikeId <= 0) return undefined
  const path = resolve(STORAGE, String(ownerId), `bike-${bikeId}.${PROCESSED_EXT}`)
  if (path === STORAGE || !path.startsWith(STORAGE + sep)) return undefined
  return path
}

/** 0640, matching every other rider file this app writes. */
export async function writeBikePhoto(ownerId: number, bikeId: number, data: Buffer): Promise<void> {
  const path = bikePhotoPath(ownerId, bikeId)
  if (!path) throw new Error(`refusing to write outside storage root (owner ${ownerId}, bike ${bikeId})`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data, { mode: 0o640 })
}

/** Null rather than throwing when it is not there. A row claiming a photo and a
 *  filesystem that disagrees is a real state after a restore, and the caller's
 *  answer is a 404 rather than a 500. */
export async function readBikePhoto(ownerId: number, bikeId: number): Promise<Buffer | null> {
  const path = bikePhotoPath(ownerId, bikeId)
  if (!path) return null
  return readFile(path).catch(() => null)
}

/** Best-effort, like every other file removal here: a missing file is the state
 *  the caller wanted. */
export async function deleteBikePhoto(ownerId: number, bikeId: number): Promise<void> {
  const path = bikePhotoPath(ownerId, bikeId)
  if (path) await unlink(path).catch(() => {})
}
