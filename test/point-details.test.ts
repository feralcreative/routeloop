import { describe, expect, it } from 'vitest'
import { canSeeDetails, hasDetails, type PointDetailsOut } from '../src/maps/point-details'
import { ensureUids, isUid, newUid, UID_LENGTH } from '../src/maps/uid'
import { ridePayload } from '../src/maps/ride-graph'

const blank: PointDetailsOut = {
  confirmation: '',
  checkInAt: null,
  checkOutAt: null,
  phone: '',
  address: '',
  links: [],
  notes: '',
}

// The privacy boundary for gate codes and confirmation numbers. Everything else
// in this file is mechanics; this describe block is the feature.
describe('canSeeDetails', () => {
  it('lets the owner in', () => {
    expect(canSeeDetails(7, { id: 7 })).toBe(true)
  })

  it('keeps every other signed-in rider out', () => {
    expect(canSeeDetails(7, { id: 8 })).toBe(false)
  })

  it('keeps an anonymous viewer out', () => {
    expect(canSeeDetails(7, null)).toBe(false)
  })

  // A public ride's details are as private as a private ride's. The predicate
  // takes no visibility argument at all, which is what makes that structural
  // rather than a thing to remember — this test fails to compile if that changes.
  it('does not depend on the ride being private', () => {
    expect(canSeeDetails.length).toBe(2)
  })
})

describe('hasDetails', () => {
  it('is false for nothing at all', () => {
    expect(hasDetails(null)).toBe(false)
    expect(hasDetails(undefined)).toBe(false)
    expect(hasDetails(blank)).toBe(false)
  })

  it('is true when any single field is filled', () => {
    expect(hasDetails({ ...blank, confirmation: 'ABC123' })).toBe(true)
    expect(hasDetails({ ...blank, notes: 'gate code 4417' })).toBe(true)
    expect(hasDetails({ ...blank, checkInAt: '2026-09-01T15:00:00Z' })).toBe(true)
    expect(hasDetails({ ...blank, links: [{ label: 'Booking', url: 'https://example.com' }] })).toBe(true)
  })
})

describe('uid', () => {
  it('mints the documented shape', () => {
    for (let i = 0; i < 50; i++) {
      const u = newUid()
      expect(u).toHaveLength(UID_LENGTH)
      expect(isUid(u)).toBe(true)
    }
  })

  it('rejects anything that is not exactly the format', () => {
    expect(isUid('')).toBe(false)
    expect(isUid('short')).toBe(false)
    expect(isUid('a'.repeat(13))).toBe(false)
    expect(isUid('ABCDEFGHIJKL')).toBe(false) // uppercase
    expect(isUid('abcdefghijk-')).toBe(false)
    expect(isUid(null)).toBe(false)
    expect(isUid(42)).toBe(false)
  })

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 2_000 }, () => newUid()))
    expect(seen.size).toBe(2_000)
  })

  // Rejection sampling, not modulo folding: 256 % 36 = 4, so folding a raw byte
  // would over-produce the first four symbols by ~14%. This is the assertion
  // that would catch someone "simplifying" it back.
  it('is not biased toward the start of the alphabet', () => {
    const counts = new Map<string, number>()
    for (let i = 0; i < 500; i++) for (const ch of newUid()) counts.set(ch, (counts.get(ch) ?? 0) + 1)
    const freqs = [...counts.values()]
    const expected = (500 * UID_LENGTH) / 36
    expect(Math.max(...freqs)).toBeLessThan(expected * 1.5)
    expect(Math.min(...freqs)).toBeGreaterThan(expected * 0.5)
  })
})

describe('ensureUids', () => {
  it('keeps a uid that is already good', () => {
    const u = newUid()
    expect(ensureUids([{ uid: u }])[0].uid).toBe(u)
  })

  it('mints one for a payload that has none', () => {
    // An old tab, an old native JSON file, or an import from another app.
    const out = ensureUids<{ uid?: string | null }>([{ uid: null }, { uid: undefined }, {}])
    expect(out.every((o) => isUid(o.uid))).toBe(true)
    expect(new Set(out.map((o) => o.uid)).size).toBe(3)
  })

  it('replaces a malformed one rather than rejecting the save', () => {
    expect(isUid(ensureUids([{ uid: 'NOT A UID' }])[0].uid)).toBe(true)
  })

  // Duplicating a stop in the builder is one click, and a client that copies the
  // row copies its uid. Two points sharing a uid would violate the per-day unique
  // index and 500 the whole save.
  it('breaks a tie so a duplicated stop cannot collide', () => {
    const u = newUid()
    const out = ensureUids([{ uid: u }, { uid: u }, { uid: u }])
    expect(out[0].uid).toBe(u)
    expect(new Set(out.map((o) => o.uid)).size).toBe(3)
  })

  it('preserves the rest of the object', () => {
    expect(ensureUids<{ uid: string | null; name: string }>([{ uid: null, name: 'Bodega' }])[0].name).toBe('Bodega')
  })
})

// The payload contract. These run through the real schema rather than a copy,
// so a field renamed in ride-graph.ts fails here.
describe('the details payload', () => {
  const day = (stop: Record<string, unknown>) => ({
    title: '',
    color: '#0000cc',
    points: [{ kind: 'stop' as const, lat: 38, lng: -122, ...stop }],
    legs: [],
  })
  const parse = (stop: Record<string, unknown>) =>
    ridePayload.safeParse({ title: 'T', description: '', visibility: 'private', days: [day(stop)] })

  it('accepts a stop with no details at all', () => {
    const r = parse({})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.days[0].points[0].details).toBeNull()
  })

  it('accepts a filled-in stop', () => {
    const r = parse({
      details: { confirmation: 'ABC123', notes: 'gate code 4417', links: [{ label: 'Book', url: 'https://ex.com' }] },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.days[0].points[0].details?.confirmation).toBe('ABC123')
  })

  // A link is rendered as an href, so http(s)-only — the same rule the ride's
  // own external_url follows. sanitizeText only strips the colon from
  // `javascript:`, which is enough for prose and not for an attribute.
  it('rejects a javascript: link', () => {
    expect(parse({ details: { links: [{ label: 'x', url: 'javascript:alert(1)' }] } }).success).toBe(false)
  })

  it('rejects a data: link', () => {
    expect(parse({ details: { links: [{ label: 'x', url: 'data:text/html,<script>' }] } }).success).toBe(false)
  })

  it('caps the number of links', () => {
    const links = Array.from({ length: 6 }, (_, i) => ({ label: `${i}`, url: 'https://ex.com' }))
    expect(parse({ details: { links } }).success).toBe(false)
  })

  it('caps the long fields', () => {
    expect(parse({ details: { notes: 'x'.repeat(2001) } }).success).toBe(false)
    expect(parse({ details: { confirmation: 'x'.repeat(121) } }).success).toBe(false)
  })
})
