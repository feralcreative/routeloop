// Turning an uploaded image into one this app is willing to store and serve.
//
// The half of the pipeline that decodes. ./policy.ts decides whether these bytes
// may reach here at all, and it has already run by the time anything below does.
//
// EVERY UPLOAD IS RE-ENCODED, WITHOUT EXCEPTION AND WHATEVER ARRIVED. That is
// #99's rule and it is the reason this module exists rather than a `writeFile`.
// Client-side resizing is a convenience for the rider's bandwidth; the bytes
// that reach a server are attacker-controlled regardless of what the page did to
// them, so what gets stored is always something libvips produced from scratch.
// A re-encoded file cannot carry a payload the decoder did not understand.
//
// THE OUTPUT IS WEBP, always, whatever came in. One stored format means one
// Content-Type to serve, one extension on disk, and no branch anywhere that has
// to ask what a file is. It is also markedly smaller than the JPEG a phone
// produces, which matters because these sit in a rider's storage directory.
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { MAX_IMAGE_PIXELS } from './policy'

/** The stored extension and MIME. One format, so both are constants. */
export const PROCESSED_EXT = 'webp'
export const PROCESSED_MIME = 'image/webp'

export type ImageBox = { width: number; height: number }

/**
 * The box a bike photo is fitted inside.
 *
 * LANDSCAPE, AND FIT RATHER THAN CROP. #99 specced a square 500×500 with a
 * circular crop box, and that is right for an avatar — a server-side center crop
 * beheads anyone who uploads a landscape photo, so the rider has to be given the
 * choice. A bike is photographed side-on and there is no equivalent harm in
 * letting it keep its own shape, so this fits within the box instead and the
 * whole crop question does not arise. That is what keeps the crop library #99
 * flags as its open question out of this branch.
 */
export const BIKE_PHOTO_BOX: ImageBox = { width: 1280, height: 960 }

export type ProcessedImage = {
  data: Buffer
  width: number
  height: number
  /** Fingerprint of the OUTPUT bytes, so a changed picture is a changed URL and
   *  the route can serve it immutable. 32 hex characters, matching the column
   *  and the convention rides.thumb_hash already set. */
  hash: string
}

/**
 * Decode, orient, shrink to fit, strip everything, re-encode.
 *
 * `.rotate()` WITH NO ARGUMENT IS LOAD-BEARING AND MUST COME FIRST. It applies
 * whatever EXIF orientation the file carried and then drops the tag. Without it
 * a photo taken sideways on a phone is stored sideways, because sharp does not
 * write metadata to the output by default — so the tag that told a viewer to
 * turn it would be gone while the pixels were still on their side. Rotating
 * first bakes the correction into the pixels, which is the only place it can
 * survive the strip.
 *
 * THE STRIP IS THE DEFAULT, and that is what we want: sharp writes no metadata
 * unless asked, so EXIF — including the GPS coordinates a phone attaches, which
 * would otherwise publish where the photo was taken — does not reach the output.
 * Do not add `.withMetadata()` here without deciding that question again.
 *
 * `withoutEnlargement` so a small photo is stored at its own size rather than
 * being upscaled into a bigger, blurrier file.
 */
export async function processImage(data: Buffer, box: ImageBox): Promise<ProcessedImage> {
  const out = await sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS })
    .rotate()
    .resize({ width: box.width, height: box.height, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true })

  return {
    data: out.data,
    width: out.info.width,
    height: out.info.height,
    hash: createHash('sha256').update(out.data).digest('hex').slice(0, 32),
  }
}
