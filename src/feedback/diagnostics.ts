// What the browser told us, shaped and redacted before it reaches jsonb.
//
// **Nothing reaches the column unredacted.** This module is the only way in, and
// it runs before the row is written — not on read, not in the view. A redaction
// applied at render time is not a redaction; the data is already stored and
// already in a backup.
//
// Pure, and imports nothing from db/. src/feedback/policy.ts owns the SHAPE and
// the lenient read parser; this owns the scrubbing on the way in, and the last
// thing it does is hand the result to parseDiagnostics so the write path and the
// read path cannot disagree about what a valid payload looks like.
//
// Three things this deliberately does NOT collect, each because collecting it is
// a privacy incident that looks like an ordinary field:
//
//   - Coordinates. Geolocation is recorded as a permission STATE and nothing
//     else. A rider filing a bug from a gas stop must not hand us where they
//     stopped.
//   - Query strings and fragments. A ride slug is an unguessable share id, and
//     `?slug=…` in a referrer puts an unlisted ride into a table the owner reads
//     casually. The route PATTERN carries everything diagnostics actually needs.
//   - Anything from localStorage or a cookie. Sizes only, never contents.
import { parseDiagnostics, type Diagnostics } from './policy'

/**
 * A URL with its query string and fragment removed, or the empty string.
 *
 * Handles a relative path as well as an absolute URL, because `referrer` is
 * absolute and `net[].path` may be either. Credentials in the authority are
 * dropped too — rare, but `https://user:pass@host/` is a legal URL and there is
 * no reason for one to survive.
 */
export function stripUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  try {
    // A base is required for a relative path and ignored for an absolute URL.
    const u = new URL(s, 'https://x.invalid')
    const path = u.pathname || '/'
    if (u.origin === 'https://x.invalid' && !/^[a-z][a-z0-9+.-]*:/i.test(s)) return path
    return `${u.protocol}//${u.host}${path}`
  } catch {
    // Not parseable as a URL. Cut at the first delimiter by hand rather than
    // returning it whole — a malformed URL still carries its query string.
    return s.split(/[?#]/)[0]
  }
}

// Anything URL-shaped inside free text: an error message, a stack frame, a
// console.error argument. A fetch failure message routinely embeds the full URL
// it failed on, query string and all, and that text is the single most likely
// place a slug leaks.
const URL_IN_TEXT = /\b((?:https?:\/\/|\/)[^\s'"`)\]]+)/gi

/** Free text with every embedded URL stripped of its query string and fragment. */
export function scrubUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (m) => stripUrl(m) || m)
}

// A route pattern is `/m/:slug/roadbook` — colons and letters, no values. If a
// client sends a concrete URL where the pattern goes, it is not a pattern and
// keeping it would defeat the point of having a separate field.
const PATTERN_OK = /^\/[A-Za-z0-9/:_.-]*$/

/**
 * A latitude/longitude pair in any of the forms a client might send one.
 *
 * Belt and braces on top of the strict permissions branch in parseDiagnostics:
 * this catches a pair that arrived somewhere other than `permissions`, which is
 * the failure mode a whitelist on one key cannot see.
 */
const COORD_PAIR = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/

/** Keys whose values are dropped outright wherever they appear, because there is
 *  no version of them we want. Matched case-insensitively on the whole key. */
const FORBIDDEN_KEYS = new Set([
  'lat',
  'lng',
  'lon',
  'latitude',
  'longitude',
  'coords',
  'coordinates',
  'position',
  'center',
  'email',
  'token',
  'password',
  'cookie',
  'authorization',
  'session',
])

function scrubFlat(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) continue
    if (typeof val === 'string') {
      // A string carrying a coordinate pair is dropped rather than trimmed —
      // there is no partial coordinate worth keeping, and a half-scrubbed one
      // reads as clean.
      if (COORD_PAIR.test(val)) continue
      out[k] = scrubUrls(val)
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      out[k] = val
    }
  }
  return out
}

/**
 * The client payload, ready to store.
 *
 * Total and lenient in the same way parseDiagnostics is, and for a sharper
 * reason: this runs inside the submit transaction. A rider's bug report must not
 * be lost because the diagnostics blob their broken browser produced was itself
 * malformed — that is precisely the browser we most want to hear from.
 */
export function redactDiagnostics(raw: unknown): Diagnostics {
  const src = (raw ?? {}) as Record<string, unknown>
  const staged: Record<string, unknown> = {}

  const app = (src.app ?? {}) as Record<string, unknown>
  if (app && typeof app === 'object' && !Array.isArray(app)) {
    const pattern = typeof app.pattern === 'string' ? app.pattern.split(/[?#]/)[0] : ''
    staged.app = {
      ...(typeof app.version === 'string' && { version: app.version }),
      // A concrete URL sent where the pattern goes is dropped, not stored. The
      // whole value of this field is that it groups six reports into one broken
      // screen, which a URL carrying an id cannot do.
      ...(pattern && PATTERN_OK.test(pattern) && { pattern }),
      ...(typeof app.referrer === 'string' && { referrer: stripUrl(app.referrer) }),
    }
  }

  for (const key of ['device', 'prefs', 'health', 'map'] as const) {
    const block = scrubFlat(src[key])
    if (block) staged[key] = block
  }

  const errors = Array.isArray(src.errors) ? src.errors : []
  staged.errors = errors.map((e) => {
    if (!e || typeof e !== 'object') return e
    const r = e as Record<string, unknown>
    return {
      ...r,
      ...(typeof r.message === 'string' && { message: scrubUrls(r.message) }),
      ...(typeof r.stack === 'string' && { stack: scrubUrls(r.stack) }),
    }
  })

  const net = Array.isArray(src.net) ? src.net : []
  staged.net = net.map((n) => {
    if (!n || typeof n !== 'object') return n
    const r = n as Record<string, unknown>
    return { ...r, ...(typeof r.path === 'string' && { path: stripUrl(r.path) }) }
  })

  // Passed through untouched: parseDiagnostics is strict here and accepts only
  // 'granted' / 'denied' / 'prompt', so a coordinate pair sent under this key
  // cannot survive the call below.
  staged.permissions = src.permissions

  // The single exit. Everything above stages a shape; this decides what a valid
  // payload is, and it is the same function the read path calls.
  return parseDiagnostics(staged)
}
