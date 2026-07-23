// Unguessable public share ids. 22 base62 chars ≈ 131 bits of entropy — the
// slug being unguessable is what makes 'unlisted' visibility meaningful.
// Rejection sampling keeps the distribution uniform (62 does not divide 256).
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const LIMIT = 248 // largest multiple of 62 ≤ 256

export function generateSlug(length = 22): string {
  let out = ''
  while (out.length < length) {
    const bytes = new Uint8Array(length * 2)
    crypto.getRandomValues(bytes)
    for (const b of bytes) {
      if (b < LIMIT) out += ALPHABET[b % 62]
      if (out.length === length) break
    }
  }
  return out
}
