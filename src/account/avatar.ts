// Where a rider's uploaded avatar lives on disk, and how it is cut.
//
// Same placement and the same reasoning as src/bikes/photo.ts: in the rider's
// own storage directory, named so it cannot be confused with a ride original.
// `avatar-7.webp` DELIBERATELY DOES NOT PARSE as one — `parseStoredName()`
// matches `<digits>[-<digits>].<ext>[.br]`, so a name starting with letters
// returns null. That is what keeps `listOwnerFiles()`, the account archive and
// `deleteMapFiles()` away from it, while `deleteOwnerDir()` still takes it on
// account purge without this module being involved.
//
// **THIS IS THE FIRST USER-UPLOADED BINARY THE APP SERVES PUBLICLY**, which is
// what makes it a different risk profile from everything above. A stored map
// original is a download behind auth; an avatar is rendered in the nav on every
// page, to anyone. Two consequences the rest of this file exists to enforce:
// nothing is served from a static path, and nothing reaches disk without being
// decoded and re-encoded by us first.
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { STORAGE } from '../maps/storage'
import { MAX_IMAGE_PIXELS } from '../images/policy'
import { PROCESSED_EXT, type ProcessedImage } from '../images/process'

/**
 * The stored size, square.
 *
 * 500, reaffirmed against a 1000 proposal on 2026-08-15. It is rendered at 24px
 * in the nav and a few hundred on a profile, so 500 covers a retina profile
 * picture with room and nothing on the page can use more.
 *
 * STORED SQUARE, DISPLAYED ROUND. `.nav-avatar` already carries
 * `border-radius: 50%`, so nothing circular is ever written to disk — a round
 * image would mean baking a background color into the corners, and the corners
 * would then be wrong on every surface with a different background.
 */
export const AVATAR_SIZE = 500

/**
 * The rider's chosen crop, in the SOURCE image's own pixels.
 *
 * Sent by the browser alongside the file. It is a hint and nothing more: the
 * server clamps it into the image and re-encodes regardless, because browser
 * output is attacker-controlled and a crop rectangle is just another number
 * arriving from outside. The client-side crop box is convenience for the rider,
 * never enforcement.
 */
export type AvatarCrop = { x: number; y: number; size: number }

/**
 * Clamp a requested crop into a square that actually exists inside the image.
 *
 * PURE, AND SEPARATED FROM THE SHARP CALL for the usual reason in this codebase:
 * it is arithmetic with several ways to be off by one, and it is the half that
 * can be tested without decoding an image. test/avatar.test.ts drives it.
 *
 * The order matters. The size is capped to the smaller dimension FIRST, because
 * a crop wider than the image has no valid origin at all — clamping the origin
 * of an oversized square would push it negative and produce an extract sharp
 * refuses. Size, then origin, then a final floor at 1.
 */
export function clampCrop(crop: AvatarCrop | null | undefined, image: { width: number; height: number }): AvatarCrop {
  const bound = Math.max(1, Math.min(image.width, image.height))

  // No crop at all is a CENTER SQUARE, which is what an API client that sends
  // only a file gets. It is the same thing the old server-side center crop did,
  // and it is acceptable here only because the browser normally sends a real
  // one — a center crop is the fallback, not the design.
  if (!crop || !Number.isFinite(crop.size) || crop.size <= 0) {
    return { x: Math.floor((image.width - bound) / 2), y: Math.floor((image.height - bound) / 2), size: bound }
  }

  const size = Math.max(1, Math.min(bound, Math.floor(crop.size)))
  const x = Math.max(0, Math.min(image.width - size, Math.floor(Number.isFinite(crop.x) ? crop.x : 0)))
  const y = Math.max(0, Math.min(image.height - size, Math.floor(Number.isFinite(crop.y) ? crop.y : 0)))
  return { x, y, size }
}

/**
 * Decode, orient, crop to the rider's square, resize to 500, strip, re-encode.
 *
 * `.rotate()` FIRST AND WITH NO ARGUMENT, for the reason processImage() spells
 * out: it bakes the EXIF orientation into the pixels and drops the tag, and
 * sharp writes no metadata to its output — so rotating later would lose the tag
 * while leaving the photo on its side. **It also has to come before the extract**,
 * which is the part unique to this function: a crop rectangle the rider drew on
 * an upright preview means nothing against sideways pixels, so the rotation must
 * already have happened when the extract is applied.
 *
 * The strip is the default and includes the GPS coordinates a phone attaches.
 * An avatar should not publish where it was taken.
 */
export async function processAvatar(data: Buffer, crop: AvatarCrop | null): Promise<ProcessedImage> {
  const upright = sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate()
  // AFTER the rotate, so width and height are the ones the rider saw. Reading
  // them off the input metadata instead would transpose them for every sideways
  // phone photo, and every crop against one would land in the wrong place.
  const meta = await upright.toBuffer({ resolveWithObject: true })
  const box = clampCrop(crop, { width: meta.info.width, height: meta.info.height })

  const out = await sharp(meta.data)
    .extract({ left: box.x, top: box.y, width: box.size, height: box.size })
    .resize({ width: AVATAR_SIZE, height: AVATAR_SIZE, fit: 'cover', withoutEnlargement: false })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true })

  return {
    data: out.data,
    width: out.info.width,
    height: out.info.height,
    hash: createHash('sha256').update(out.data).digest('hex').slice(0, 32),
  }
}

/** Absolute path for a rider's avatar, or undefined if it would escape the root.
 *  The id is an integer and the extension is a constant, so there is nothing
 *  here to inject — the check is belt and braces, same as bikePhotoPath(). */
export function avatarPath(ownerId: number): string | undefined {
  if (!Number.isInteger(ownerId) || ownerId <= 0) return undefined
  const path = resolve(STORAGE, String(ownerId), `avatar.${PROCESSED_EXT}`)
  if (path === STORAGE || !path.startsWith(STORAGE + sep)) return undefined
  return path
}

/** 0640, matching every other rider file this app writes. */
export async function writeAvatar(ownerId: number, data: Buffer): Promise<void> {
  const path = avatarPath(ownerId)
  if (!path) throw new Error(`refusing to write outside storage root (owner ${ownerId})`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data, { mode: 0o640 })
}

/** Null rather than throwing when it is not there — a row claiming an avatar and
 *  a filesystem that disagrees is a real state after a restore, and the caller's
 *  answer is a 404 rather than a 500. */
export async function readAvatar(ownerId: number): Promise<Buffer | null> {
  const path = avatarPath(ownerId)
  if (!path) return null
  return readFile(path).catch(() => null)
}

/** Best-effort: a missing file is the state the caller wanted. */
export async function deleteAvatar(ownerId: number): Promise<void> {
  const path = avatarPath(ownerId)
  if (path) await unlink(path).catch(() => {})
}
