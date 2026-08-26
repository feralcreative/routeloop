// What the app will accept as an uploaded image, decided from the BYTES.
//
// Pure — no sharp, no filesystem — so test/images.test.ts can pin the security
// boundary with no fixtures beyond a handful of byte arrays. The half that
// actually decodes lives in ./process.ts.
//
// THIS IS A SECURITY BOUNDARY, NOT A FORMAT PREFERENCE. Three rules, and #99
// argued each of them before this file existed:
//
//   1. NEVER TRUST THE EXTENSION OR THE Content-Type. Both are supplied by the
//      client and neither describes the bytes. `sniffImageType` reads the magic
//      number and nothing else.
//   2. RASTER ONLY. NO SVG, EVER. An SVG is a document that can carry script,
//      and an uploaded one served back to a browser is stored XSS. It is refused
//      here by construction rather than by a rule someone has to remember: an
//      SVG is text and matches no magic number below.
//   3. THE SIZE GATE COMES BEFORE ANY DECODE. Decoding is where a malicious
//      image does its work, so a file over the cap is refused without ever being
//      handed to a decoder.

/** Formats accepted on the way IN. Everything is re-encoded to one format on the
 *  way out, so this list is about what we are willing to decode.
 *
 *  PNG AND JPEG ONLY, carried over from #99's decision. Worth knowing what it
 *  costs: an Android phone that hands over a WebP, or an iPhone with HEIC
 *  passthrough, is refused. Widening it is a one-line change here plus a test —
 *  the re-encode downstream makes the extra formats no less safe — but it is a
 *  decision rather than an oversight. */
export const ACCEPTED_TYPES = ['jpeg', 'png'] as const
export type ImageType = (typeof ACCEPTED_TYPES)[number]

/** 1 MB, from #99. It rejects most phone-camera output BEFORE any decode, which
 *  is the point: the cap is a defence, not a storage decision. */
export const MAX_IMAGE_BYTES = 1024 * 1024

/**
 * A ceiling on DECODED pixels, which the byte cap does not give you.
 *
 * A small file can describe an enormous image — a highly compressible 1 MB PNG
 * can decode to hundreds of megapixels and exhaust memory before anything gets
 * a chance to resize it. Bytes bound the input; this bounds the work.
 */
export const MAX_IMAGE_PIXELS = 40_000_000

// Magic numbers, as bytes. Kept as arrays rather than a regex over a string
// because a Buffer is what arrives and turning it into a string to test it is
// how an encoding assumption sneaks in.
const MAGIC: Array<{ type: ImageType; bytes: number[] }> = [
  // JPEG: SOI marker, then the start of any APPn/DQT segment.
  { type: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  // PNG: the 8-byte signature, which deliberately includes CRLF and EOF bytes
  // so a file mangled by a text-mode transfer fails to match.
  { type: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
]

/**
 * What these bytes actually are, or null.
 *
 * Null covers every refusal that is not about size: a GIF, a WebP, a PDF, an
 * SVG, an HTML file named `bike.png`, and an empty upload. The caller does not
 * need them distinguished — the answer to all of them is the same.
 */
export function sniffImageType(data: Uint8Array): ImageType | null {
  for (const { type, bytes } of MAGIC) {
    if (data.length < bytes.length) continue
    let match = true
    for (let i = 0; i < bytes.length; i++) {
      if (data[i] !== bytes[i]) {
        match = false
        break
      }
    }
    if (match) return type
  }
  return null
}

export type UploadRefusal = 'empty' | 'too-large' | 'unsupported'
export type UploadCheck = { ok: true; type: ImageType } | { ok: false; reason: UploadRefusal }

/**
 * Whether these bytes may be decoded at all.
 *
 * Order matters: size is tested BEFORE the sniff, so an oversized file is
 * refused without this function reading into it. The sniff only ever runs on a
 * buffer already known to be small.
 */
export function checkUpload(data: Uint8Array): UploadCheck {
  if (data.length === 0) return { ok: false, reason: 'empty' }
  if (data.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' }
  const type = sniffImageType(data)
  if (!type) return { ok: false, reason: 'unsupported' }
  return { ok: true, type }
}

export const UPLOAD_REFUSAL_MESSAGES: Record<UploadRefusal, string> = {
  empty: 'That file was empty.',
  'too-large': `Images have to be ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB or smaller.`,
  unsupported: 'That has to be a JPEG or a PNG.',
}
