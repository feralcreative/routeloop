// The stored diagnostics blob, read leniently.
//
// Two jobs, and the second is the one that matters.
//
// **Lenience.** `$type<>` on a jsonb column is a compile-time claim Postgres
// does not enforce, so a payload written by an older build, truncated in flight,
// or hand-crafted by someone poking at the endpoint all arrive as `unknown`.
// parseDiagnostics must never throw: the owner's queue rendering forty reports
// must not 500 on one malformed row, and a report whose diagnostics are garbage
// is still a report worth reading.
//
// **Redaction on the way in.** A rider submitting a bug from a page whose URL
// carries their ride slug, and a rider whose phone reports a geolocation
// position rather than a permission state, are both privacy incidents that look
// like ordinary fields. The parser is strict about permissions for exactly that
// reason, and the redactor in src/feedback/diagnostics.ts strips query strings
// before anything is written.
import { describe, expect, it } from 'vitest'
import { DIAG_ERRORS_MAX, DIAG_NET_MAX, parseDiagnostics } from '../src/feedback/policy'
import { redactDiagnostics, scrubUrls, stripUrl } from '../src/feedback/diagnostics'

describe('parseDiagnostics: lenience', () => {
  // The whole contract in one line — every one of these is a real thing that
  // reaches a jsonb column, and not one of them may throw.
  it('never throws on anything', () => {
    const hostile: unknown[] = [
      null,
      undefined,
      0,
      '',
      'not an object',
      [],
      [1, 2, 3],
      true,
      { app: 'a string where an object goes' },
      { errors: 'not an array' },
      { errors: [null, 3, 'x', {}] },
      { net: [{}] },
      { device: [1, 2] },
      { permissions: null },
      { app: { version: {} } },
    ]
    for (const raw of hostile) {
      expect(() => parseDiagnostics(raw)).not.toThrow()
      expect(typeof parseDiagnostics(raw)).toBe('object')
    }
  })

  it('returns an empty object for an empty payload', () => {
    expect(parseDiagnostics({})).toEqual({})
    expect(parseDiagnostics(null)).toEqual({})
    expect(parseDiagnostics(undefined)).toEqual({})
  })

  it('keeps the app block when any field is present', () => {
    const out = parseDiagnostics({ app: { pattern: '/m/:slug/roadbook' } })
    expect(out.app).toEqual({ pattern: '/m/:slug/roadbook' })
  })

  it('omits the app block entirely when every field is junk', () => {
    expect(parseDiagnostics({ app: { version: 3, pattern: null, referrer: {} } }).app).toBeUndefined()
  })

  // The normalized pattern is what lets six unrelated-looking reports be
  // recognized as one broken screen. Losing it costs more than losing the URL.
  it('keeps the route pattern alongside the referrer', () => {
    const out = parseDiagnostics({
      app: { version: '2026-08-23-1834PT', pattern: '/build/:slug', referrer: 'https://routeloop.app/rides' },
    })
    expect(out.app?.pattern).toBe('/build/:slug')
    expect(out.app?.version).toBe('2026-08-23-1834PT')
  })
})

describe('parseDiagnostics: flat blocks', () => {
  it('keeps primitives and drops nested values', () => {
    const out = parseDiagnostics({
      device: { os: 'iOS 26', dpr: 3, standalone: true, nested: { a: 1 }, list: [1] },
    })
    expect(out.device).toEqual({ os: 'iOS 26', dpr: 3, standalone: true })
  })

  it('drops a block that ends up empty', () => {
    expect(parseDiagnostics({ device: { nested: { a: 1 } } }).device).toBeUndefined()
    expect(parseDiagnostics({ prefs: {} }).prefs).toBeUndefined()
  })

  it('keeps the map block, which reproduces more than a screenshot would', () => {
    const out = parseDiagnostics({ map: { zoom: 9.5, dayIndex: 2, stopCount: 7, tileErrors: 0 } })
    expect(out.map).toEqual({ zoom: 9.5, dayIndex: 2, stopCount: 7, tileErrors: 0 })
  })

  it('truncates a long string rather than dropping it', () => {
    const out = parseDiagnostics({ device: { ua: 'x'.repeat(5000) } })
    expect(typeof out.device?.ua).toBe('string')
    expect(String(out.device?.ua).length).toBeLessThanOrEqual(300)
  })
})

describe('parseDiagnostics: capped lists', () => {
  it('caps errors and keeps the earliest', () => {
    const errors = Array.from({ length: 60 }, (_, i) => ({ message: `boom ${i}` }))
    const out = parseDiagnostics({ errors })
    expect(out.errors).toHaveLength(DIAG_ERRORS_MAX)
    expect(out.errors?.[0].message).toBe('boom 0')
  })

  it('caps failed requests', () => {
    const net = Array.from({ length: 40 }, (_, i) => ({ path: `/api/x/${i}`, status: 500 }))
    expect(parseDiagnostics({ net })).toHaveProperty('net')
    expect(parseDiagnostics({ net }).net).toHaveLength(DIAG_NET_MAX)
  })

  it('skips an error entry with neither a message nor a stack', () => {
    const out = parseDiagnostics({ errors: [{ at: 1 }, { message: 'real' }, {}] })
    expect(out.errors).toEqual([{ message: 'real' }])
  })

  // A request with no path says nothing at all, and an entry of pure timings is
  // worse than no entry — it looks like data.
  it('skips a request entry with no path', () => {
    const out = parseDiagnostics({
      net: [
        { status: 500, ms: 30 },
        { path: '/api/rides', status: 500 },
      ],
    })
    expect(out.net).toHaveLength(1)
    expect(out.net?.[0].path).toBe('/api/rides')
  })

  it('drops the list key entirely when nothing survives', () => {
    expect(parseDiagnostics({ errors: [{}, null, 'x'] }).errors).toBeUndefined()
    expect(parseDiagnostics({ net: [{}] }).net).toBeUndefined()
  })

  it('keeps a stack long enough to name the file', () => {
    const stack = 'Error: boom\n' + '    at doThing (builder.js:1234:5)\n'.repeat(50)
    const out = parseDiagnostics({ errors: [{ message: 'boom', stack }] })
    expect(out.errors?.[0].stack).toContain('builder.js')
  })
})

describe('parseDiagnostics: permissions are states, never positions', () => {
  it('keeps the three known states', () => {
    const out = parseDiagnostics({ permissions: { geolocation: 'granted', notifications: 'denied' } })
    expect(out.permissions).toEqual({ geolocation: 'granted', notifications: 'denied' })
  })

  // The strict branch, and the only one in the parser. A coordinate pair that
  // somehow survived a write must not survive a read.
  it('drops anything that is not one of the three states', () => {
    const out = parseDiagnostics({
      permissions: { geolocation: '44.0582,-121.3153', camera: 'granted', other: { lat: 1 } },
    })
    expect(out.permissions).toEqual({ camera: 'granted' })
  })

  it('omits the block when nothing is a known state', () => {
    expect(parseDiagnostics({ permissions: { geolocation: '44.05,-121.31' } }).permissions).toBeUndefined()
  })
})

describe('stripUrl', () => {
  it('drops the query string and the fragment', () => {
    expect(stripUrl('https://routeloop.app/m/abc123?share=xyz#day2')).toBe('https://routeloop.app/m/abc123')
  })

  it('handles a relative path', () => {
    expect(stripUrl('/api/rides?owner=4')).toBe('/api/rides')
  })

  // Rare, but legal, and there is no reason for one to survive.
  it('drops credentials in the authority', () => {
    expect(stripUrl('https://user:pass@example.com/x?y=1')).toBe('https://example.com/x')
  })

  // The invariant, not the formatting: whatever a malformed URL comes back as,
  // it must not still be carrying its query string. WHATWG URL is permissive and
  // parses most junk as a path rather than throwing, so the exact output is not
  // worth pinning — the absence of the secret is.
  it('loses the query string even on input it cannot parse cleanly', () => {
    for (const bad of ['::::not a url?secret=1', 'http://?secret=1', '%%%?secret=1', 'a b c?secret=1']) {
      expect(stripUrl(bad)).not.toContain('secret')
    }
  })

  it('is total on junk', () => {
    expect(stripUrl('')).toBe('')
    expect(stripUrl('   ')).toBe('')
  })
})

describe('scrubUrls', () => {
  // The single most likely place a slug leaks. A fetch failure message routinely
  // embeds the whole URL it failed on, and that text goes straight into the
  // error ring buffer.
  it('strips a URL embedded in an error message', () => {
    const out = scrubUrls('Failed to fetch https://routeloop.app/api/rides/9?token=abc while saving')
    expect(out).toContain('https://routeloop.app/api/rides/9')
    expect(out).not.toContain('token=abc')
  })

  it('strips a relative path embedded in text', () => {
    expect(scrubUrls('POST /api/save?slug=Xk9 failed')).toBe('POST /api/save failed')
  })

  it('leaves text with no URL alone', () => {
    expect(scrubUrls('the map went white')).toBe('the map went white')
  })
})

describe('redactDiagnostics', () => {
  it('strips the query string from the referrer', () => {
    const out = redactDiagnostics({ app: { referrer: 'https://routeloop.app/rides?filter=mine#top' } })
    expect(out.app?.referrer).toBe('https://routeloop.app/rides')
  })

  // The pattern's whole value is grouping six reports into one broken screen,
  // which a URL carrying an id cannot do. A concrete URL sent here is dropped
  // rather than stored, so the field never lies about what it is.
  it('drops a concrete URL sent where the route pattern goes', () => {
    expect(redactDiagnostics({ app: { pattern: 'https://routeloop.app/m/abc' } }).app?.pattern).toBeUndefined()
    expect(redactDiagnostics({ app: { pattern: '/m/:slug' } }).app?.pattern).toBe('/m/:slug')
  })

  it('strips a query string off a pattern before checking it', () => {
    expect(redactDiagnostics({ app: { pattern: '/build/:slug?day=2' } }).app?.pattern).toBe('/build/:slug')
  })

  it('strips URLs out of error messages and stacks', () => {
    const out = redactDiagnostics({
      errors: [{ message: 'boom at /api/rides?slug=Xk9', stack: 'at fetch (/js/builder.js?v=3:12:1)' }],
    })
    expect(out.errors?.[0].message).not.toContain('Xk9')
    expect(out.errors?.[0].stack).not.toContain('v=3')
    expect(out.errors?.[0].stack).toContain('builder.js')
  })

  it('strips the query string from a recorded request path', () => {
    const out = redactDiagnostics({ net: [{ path: '/api/maps/Xk9abc/save?force=1', status: 500 }] })
    expect(out.net?.[0].path).toBe('/api/maps/Xk9abc/save')
  })

  // The belt-and-braces pass. The strict permissions branch in parseDiagnostics
  // only guards one key; this catches a pair that arrived somewhere else, which
  // is the failure a whitelist on one key cannot see.
  it('drops a coordinate pair wherever it appears', () => {
    const out = redactDiagnostics({ device: { lastFix: '44.0582,-121.3153', os: 'iOS 26' } })
    expect(out.device).toEqual({ os: 'iOS 26' })
  })

  it('drops forbidden keys outright', () => {
    const out = redactDiagnostics({
      map: { lat: 44.05, lng: -121.31, center: 'x', zoom: 9, dayIndex: 1 },
      device: { email: 'a@b.c', token: 'secret', os: 'iOS 26' },
    })
    expect(out.map).toEqual({ zoom: 9, dayIndex: 1 })
    expect(out.device).toEqual({ os: 'iOS 26' })
  })

  it('keeps a geolocation permission state but never a position', () => {
    expect(redactDiagnostics({ permissions: { geolocation: 'granted' } }).permissions).toEqual({
      geolocation: 'granted',
    })
    expect(redactDiagnostics({ permissions: { geolocation: '44.05,-121.31' } }).permissions).toBeUndefined()
  })

  // This runs inside the submit transaction. A rider's report must not be lost
  // because the blob their broken browser produced was itself broken — that is
  // precisely the browser we most want to hear from.
  it('never throws, whatever it is handed', () => {
    for (const raw of [null, undefined, 0, '', 'string', [], { app: 5 }, { errors: 'no' }, { net: {} }]) {
      expect(() => redactDiagnostics(raw)).not.toThrow()
    }
  })

  it('produces something parseDiagnostics accepts unchanged', () => {
    const once = redactDiagnostics({ app: { pattern: '/build' }, device: { os: 'iOS' } })
    expect(parseDiagnostics(once)).toEqual(once)
  })
})

describe('parseDiagnostics: truncation', () => {
  // The realistic failure: the POST was cut off mid-blob, so the payload is a
  // valid object with half its keys. It must come back as half a diagnostic
  // rather than as nothing.
  it('reads a payload missing most of its keys', () => {
    const out = parseDiagnostics({ app: { pattern: '/build' }, errors: [{ message: 'boom' }] })
    expect(out.app?.pattern).toBe('/build')
    expect(out.errors).toHaveLength(1)
    expect(out.device).toBeUndefined()
    expect(out.net).toBeUndefined()
  })
})
