// Normalizing a pasted social handle, and the boundary it is NOT.
//
// **THE SECURITY BOUNDARY IS THE COLUMN, NOT THIS FUNCTION.** `user_profiles`
// stores a HANDLE and src/routes/pages.tsx composes
// `https://instagram.com/<handle>` at render time, so the origin is a literal in
// our own source and only the last path segment comes from the rider. A handle
// cannot carry a `javascript:` scheme, which is why there is no allow-list to
// forget — the class of bug is removed rather than defended against.
//
// What this function does is be KIND TO THE PASTE: riders paste whatever is in
// front of them, and a stored `instagram.com/ziad` would compose into
// `https://instagram.com/instagram.com/ziad`. That is a broken link, not a
// vulnerability, and this is the distinction to keep straight if anyone is ever
// tempted to relax the column into holding URLs.
import { describe, expect, it } from 'vitest'

// The same expression as `handle()` in src/routes/profile.tsx. Duplicated rather
// than exported because that closure also calls sanitizeText, which needs the
// request-shaped input this test does not have — the shapes below are what the
// regex has to survive, and they are the part worth pinning.
const handle = (t: string): string | null => {
  if (!t) return null
  const bare = t
    .replace(/^https?:\/\//i, '')
    .split(/[?#]/)[0]
    .split('/')
    .filter(Boolean)
    .pop()
  // Null rather than falling back to `t`: a string that is nothing but
  // separators ("///", "https://") has no handle in it.
  return bare ? bare.replace(/^@+/, '') || null : null
}

describe('a bare handle is left alone', () => {
  it.each(['ziad', 'feralcreative', 'a_b.c-d', '12345'])('%s', (h) => {
    expect(handle(h)).toBe(h)
  })
})

describe('the shapes riders actually paste', () => {
  it('drops a leading @', () => {
    expect(handle('@ziad')).toBe('ziad')
    expect(handle('@@ziad')).toBe('ziad')
  })

  it('takes the handle out of a full URL', () => {
    expect(handle('https://instagram.com/ziad')).toBe('ziad')
    expect(handle('http://www.facebook.com/ziad')).toBe('ziad')
    expect(handle('instagram.com/ziad')).toBe('ziad')
  })

  it('survives a trailing slash', () => {
    expect(handle('https://instagram.com/ziad/')).toBe('ziad')
  })

  it('drops a query string and a fragment', () => {
    expect(handle('https://instagram.com/ziad?hl=en')).toBe('ziad')
    expect(handle('https://instagram.com/ziad#about')).toBe('ziad')
  })

  it('handles the youtube @ form, which carries the @ in the path', () => {
    expect(handle('https://youtube.com/@ziad')).toBe('ziad')
  })

  it('handles a strava athlete id', () => {
    expect(handle('https://strava.com/athletes/12345678')).toBe('12345678')
  })
})

describe('nothing in, nothing out', () => {
  it.each(['', '@', '///', 'https://'])('%s is null', (t) => {
    expect(handle(t)).toBeNull()
  })
})

// NOT A SANITIZER, and these cases say so out loud rather than asserting a
// safety this function does not provide. A hostile value still comes out the
// other side — it is the composed URL that makes it harmless, because the value
// lands in a path segment of an origin we wrote, and encodeURIComponent escapes
// it there.
describe('it does not pretend to sanitize', () => {
  it('a scheme-only string survives, and that is fine', () => {
    // `javascript:alert(1)` has no slash, so it comes back whole...
    expect(handle('javascript:alert(1)')).toBe('javascript:alert(1)')
    // ...and composes to a link that navigates to a 404 on instagram.com,
    // because it is a PATH SEGMENT of a literal origin and is percent-encoded.
    const composed = `https://instagram.com/${encodeURIComponent(handle('javascript:alert(1)') as string)}`
    expect(composed).toBe('https://instagram.com/javascript%3Aalert(1)')
    expect(composed.startsWith('https://instagram.com/')).toBe(true)
  })

  it('cannot escape the origin with a path traversal', () => {
    const composed = `https://instagram.com/${encodeURIComponent(handle('../../evil') as string)}`
    expect(composed).toBe('https://instagram.com/evil')
  })
})
