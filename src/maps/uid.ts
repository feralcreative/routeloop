// A point's durable identity, generated and validated in one place.
//
// Why a uid exists at all: `PUT /api/rides/:id` deletes and re-inserts every day
// and point on every save — accepted deliberately on 2026-08-15 — so `points.id`
// churns constantly and cannot be referenced across a save. Rich stop details is
// the first feature that needs a point to keep its identity, and this is what it
// keeps instead. See `points.uid` in src/db/schema.ts.
//
// Mirrored by `uid()` in public/js/builder.js, which is what actually mints them
// for new points, and pinned together by test/uid.test.ts. Both have to agree on
// the alphabet and the length or a client-minted uid fails server validation and
// the save 400s.
import { randomBytes } from 'node:crypto'

// Lowercase base36. Twelve characters is ~62 bits, which is far more than a
// per-day uniqueness requirement needs — but the uid also travels in native JSON
// exports, so two riders merging files should not collide either.
//
// No uppercase, deliberately: the uid ends up in URLs and in hand-typed test
// fixtures, and a case-sensitive identifier that looks case-insensitive is a
// bug waiting to happen.
export const UID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
export const UID_LENGTH = 12

// Anchored, and the length is exact rather than a range. A uid is a fixed-width
// token; accepting a short one would let a client mint values that collide more
// easily than the format implies.
const UID_RE = /^[a-z0-9]{12}$/

export function isUid(v: unknown): v is string {
  return typeof v === 'string' && UID_RE.test(v)
}

/**
 * Mints a uid.
 *
 * `randomBytes` rather than `Math.random()`: not because this is a secret — it
 * is not, and nothing is authorized by knowing one — but because the server
 * mints these in a loop when a legacy payload arrives without them, and a
 * seeded or low-entropy PRNG producing a repeat inside one save would violate
 * the per-day unique index and fail the whole request.
 *
 * Rejection sampling on a 256-value byte would bias toward the first 4 symbols
 * (256 % 36 = 4), so bytes ≥ 252 are discarded rather than folded.
 */
export function newUid(): string {
  let out = ''
  while (out.length < UID_LENGTH) {
    for (const b of randomBytes(UID_LENGTH)) {
      if (b >= 252) continue
      out += UID_ALPHABET[b % 36]
      if (out.length === UID_LENGTH) break
    }
  }
  return out
}

/**
 * Fills in any missing or malformed uid across a list, and breaks ties.
 *
 * Three things arrive without usable uids and all three are ordinary rather than
 * hostile: a tab opened before this shipped, a native JSON file written before
 * it, and a ride imported from another app. A duplicate is just as ordinary —
 * duplicating a stop in the builder is one click, and a client that copies the
 * row wholesale copies its uid with it.
 *
 * Repairing rather than rejecting, for the same reason `normalize()` repairs
 * alternate groups instead of refusing them: the payload arrives from an
 * autosave the rider did not press, so a 400 is a save they silently lost.
 */
export function ensureUids<T extends { uid?: string | null }>(items: T[]): Array<T & { uid: string }> {
  const seen = new Set<string>()
  return items.map((item) => {
    let uid = isUid(item.uid) && !seen.has(item.uid) ? item.uid : newUid()
    while (seen.has(uid)) uid = newUid()
    seen.add(uid)
    return { ...item, uid }
  })
}
