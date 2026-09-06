import { describe, expect, it } from 'vitest'
import {
  POINT_BUDGET,
  URL_MAX_CHARS,
  encodePolyline,
  simplifyToBudget,
  thumbnailHash,
  thumbnailRequest,
  thumbnailUrl,
  type ThumbRoute,
} from '../src/maps/thumbnail'

// A synthetic route: `n` points along a sine-wave road, so simplification has real
// curvature to preserve rather than a straight line it can collapse to two
// points and pass every length assertion trivially.
function wavyRoute(n: number, opts: Partial<ThumbRoute> = {}): ThumbRoute {
  const geometry: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const t = i / n
    geometry.push([-122 + t * 3, 38 + Math.sin(t * 120) * 0.35])
  }
  return { geometry, color: '#0000cc', altGroup: null, altActive: true, ...opts }
}

describe('encodePolyline', () => {
  // Google's own documented example for the encoded polyline format. Our input
  // is [lng, lat]; the lat-then-lng swap the format wants happens inside.
  it('matches the reference encoding', () => {
    const track: [number, number][] = [
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]
    expect(encodePolyline(track)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@')
  })

  it('encodes an empty track as an empty string', () => {
    expect(encodePolyline([])).toBe('')
  })
})

describe('simplifyToBudget', () => {
  it('leaves a track already under budget alone', () => {
    const route = wavyRoute(50)
    expect(simplifyToBudget(route.geometry, 330)).toEqual(route.geometry)
  })

  it('lands at or under the budget', () => {
    for (const n of [400, 2_000, 8_473]) {
      const out = simplifyToBudget(wavyRoute(n).geometry, 330)
      expect(out.length).toBeLessThanOrEqual(330)
      // Not a collapse to the endpoints — a budget that is met by throwing the
      // shape away is met wrongly, and this is the assertion that would catch a
      // binary search that always converges on the upper bound.
      expect(out.length).toBeGreaterThan(200)
    }
  })

  it('keeps both endpoints', () => {
    const route = wavyRoute(5_000)
    const out = simplifyToBudget(route.geometry, 100)
    expect(out[0]).toEqual(route.geometry[0])
    expect(out[out.length - 1]).toEqual(route.geometry[route.geometry.length - 1])
  })

  it('degrades to the endpoints rather than throwing on an impossible budget', () => {
    expect(simplifyToBudget(wavyRoute(500).geometry, 1)).toHaveLength(2)
    expect(simplifyToBudget([], 10)).toEqual([])
  })
})

describe('thumbnailRequest', () => {
  // The assertion the whole point-budget design exists for. Static Maps is
  // GET-only with an 8192-character limit, and the failure is a 4xx at fetch
  // time rather than anything visible in testing — so the densest ride the app
  // can hold has to be asserted here.
  it('stays under the URL limit for a dense eight-route import', () => {
    const routes = Array.from({ length: 8 }, () => wavyRoute(8_473))
    const request = thumbnailRequest(routes)!
    expect(request).not.toBeNull()
    const full = thumbnailUrl(request, 'x'.repeat(40))
    expect(full.length).toBeLessThan(URL_MAX_CHARS)
  })

  it('stays under the URL limit for a thirty-day ride', () => {
    const routes = Array.from({ length: 30 }, () => wavyRoute(3_000))
    const full = thumbnailUrl(thumbnailRequest(routes)!, 'x'.repeat(40))
    expect(full.length).toBeLessThan(URL_MAX_CHARS)
  })

  it('draws one path per route', () => {
    const request = thumbnailRequest([wavyRoute(100), wavyRoute(100), wavyRoute(100)])!
    expect(request.match(/[?&]path=/g)).toHaveLength(3)
  })

  it('spends the budget in proportion to each route’s point count', () => {
    // A long route and a short one: the long one should get the larger share, not
    // half each.
    const request = thumbnailRequest([wavyRoute(4_000), wavyRoute(200)])!
    const [longPath, shortPath] = request.split('enc:').slice(1)
    expect(longPath.length).toBeGreaterThan(shortPath.length)
  })

  // Only active routes count, and the module filters rather than trusting the
  // caller — see AGENTS.md on why a new surface has to opt in explicitly.
  it('never draws a losing alternate', () => {
    const both = thumbnailRequest([wavyRoute(100), wavyRoute(100, { altGroup: 0, altActive: false })])!
    const activeOnly = thumbnailRequest([wavyRoute(100)])!
    expect(both).toBe(activeOnly)
    expect(both.match(/[?&]path=/g)).toHaveLength(1)
  })

  it('returns null when there is nothing to draw', () => {
    expect(thumbnailRequest([])).toBeNull()
    expect(thumbnailRequest([wavyRoute(100, { altGroup: 0, altActive: false })])).toBeNull()
    // A ride with stops but no legs is a real state, not a hypothetical.
    expect(thumbnailRequest([{ geometry: [], color: '#0000cc', altGroup: null, altActive: true }])).toBeNull()
    expect(thumbnailRequest([{ geometry: [[-122, 38]], color: '#0000cc', altGroup: null, altActive: true }])).toBeNull()
  })

  it('sends no center or zoom, so Static Maps fits the route itself', () => {
    const request = thumbnailRequest([wavyRoute(100)])!
    expect(request).not.toMatch(/[?&]center=/)
    expect(request).not.toMatch(/[?&]zoom=/)
  })

  it('carries each route’s own color', () => {
    const request = thumbnailRequest([wavyRoute(100, { color: '#ff8800' }), wavyRoute(100, { color: '#00AA55' })])!
    expect(request).toContain('0xff8800ff')
    expect(request).toContain('0x00aa55ff')
  })

  it('falls back to the schema default on an unparseable color', () => {
    const request = thumbnailRequest([wavyRoute(100, { color: 'rebeccapurple' })])!
    expect(request).toContain('0x0000ccff')
  })
})

describe('the key never reaches the stored string', () => {
  // The request is hashed and stored; the key is appended only at fetch time.
  // Both properties matter: a key in the hashed string means a rotation
  // invalidates every thumbnail, and a key in a stored or logged string is how
  // an IP-restricted server key leaks.
  it('builds a request with no key in it', () => {
    const request = thumbnailRequest([wavyRoute(100)])!
    expect(request).not.toContain('key=')
  })

  it('appends the key only in thumbnailUrl', () => {
    const request = thumbnailRequest([wavyRoute(100)])!
    expect(thumbnailUrl(request, 'SECRET')).toContain('key=SECRET')
  })

  it('hashes the same request identically whatever the key is', () => {
    const request = thumbnailRequest([wavyRoute(100)])!
    expect(thumbnailHash(request)).toBe(thumbnailHash(request))
    expect(thumbnailHash(request)).toHaveLength(32)
  })
})

describe('thumbnailHash', () => {
  it('changes when the route moves', () => {
    const a = thumbnailRequest([wavyRoute(100)])!
    const b = thumbnailRequest([wavyRoute(101)])!
    expect(thumbnailHash(a)).not.toBe(thumbnailHash(b))
  })

  it('changes when a route is recolored', () => {
    const a = thumbnailRequest([wavyRoute(100, { color: '#ff8800' })])!
    const b = thumbnailRequest([wavyRoute(100, { color: '#00aa55' })])!
    expect(thumbnailHash(a)).not.toBe(thumbnailHash(b))
  })

  // The point of the hash: the sweep skips a ride whose edit did not move the
  // picture. Title, dwell and visibility are not inputs here at all, so the
  // property to pin is that identical geometry produces an identical hash.
  it('is unchanged by anything outside the picture', () => {
    const routes = [wavyRoute(500), wavyRoute(300, { color: '#ff8800' })]
    expect(thumbnailHash(thumbnailRequest(routes)!)).toBe(thumbnailHash(thumbnailRequest(routes)!))
  })
})

describe('the budget is the documented one', () => {
  it('exports the figures the sweep and the tests share', () => {
    expect(POINT_BUDGET).toBe(330)
    expect(URL_MAX_CHARS).toBe(8192)
  })
})
