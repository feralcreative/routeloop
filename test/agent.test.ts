// The agent's pure half: the edit rules, the summary it reads, and the money.
//
// Every edit is checked against the SAME schema the builder's save uses, because an
// agent turn that produces a payload the PUT rejects is a turn whose work the rider
// silently loses on the next autosave.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ridePayload, type RidePayload } from '../src/maps/ride-graph'
import {
  addPoint,
  addRoute,
  EditError,
  movePoint,
  removePoint,
  replacePoint,
  setDeparture,
  setRoles,
} from '../src/agent/ride-edit'
import { rideSummary } from '../src/agent/summary'
import { costMicros, freeTierAllows, FREE_MONTHLY_MICROS } from '../src/agent/policy'
import { Budget } from '../src/agent/budget'
import { DAILY_GOOGLE_CALLS, TURN_LIMITS } from '../src/agent/policy'

function pt(uid: string, lng: number, lat: number, kind: 'stop' | 'poi' = 'poi') {
  return {
    kind,
    lat,
    lng,
    name: uid,
    address: null,
    description: '',
    roles: [],
    durationMin: null,
    slackMin: null,
    uid,
    details: null,
  }
}

function leg(a: [number, number], b: [number, number], vias: [number, number][] = [], durationS = 600) {
  return { geometry: [a, ...vias, b], distanceM: 10_000, durationS, viaPoints: vias }
}

function fixture(): RidePayload {
  return ridePayload.parse({
    title: 'Coast run',
    routes: [
      {
        uid: 'route0000001',
        title: 'Day one',
        startAt: '2026-11-07T09:00:00.000Z',
        points: [
          pt('aaaaaaaaaaaa', -122.27, 37.8, 'stop'),
          pt('bbbbbbbbbbbb', -122.1, 37.6),
          pt('cccccccccccc', -122.0, 37.0, 'stop'),
        ],
        legs: [
          leg([-122.27, 37.8], [-122.1, 37.6], [[-122.21, 37.71]]),
          leg([-122.1, 37.6], [-122.0, 37.0], [[-122.05, 37.31]]),
        ],
      },
    ],
  })
}

const valid = (ride: RidePayload) => ridePayload.safeParse(ride).success

describe('ride-edit', () => {
  it('appends a POI and leaves one new straight leg', () => {
    const ride = fixture()
    const { point, stale } = addPoint(ride, 'route0000001', { name: 'Santa Cruz', lng: -122.03, lat: 36.97 })
    expect(point.kind).toBe('poi')
    expect(ride.routes[0].legs).toHaveLength(3)
    expect(stale).toEqual([{ route: 0, leg: 2 }])
    expect(ride.routes[0].legs[0].viaPoints).toEqual([[-122.21, 37.71]])
    expect(valid(ride)).toBe(true)
  })

  it('a point given a category arrives as a stop', () => {
    const ride = fixture()
    const { point } = addPoint(
      ride,
      'route0000001',
      { name: 'Shell', lng: -122.05, lat: 37.3 },
      { at: 2, roles: ['gas'] },
    )
    expect(point.kind).toBe('stop')
    expect(ride.routes[0].points[2].uid).toBe(point.uid)
    expect(valid(ride)).toBe(true)
  })

  it('inserting mid-route splits exactly one leg and keeps the other', () => {
    const ride = fixture()
    const { stale } = addPoint(ride, 'route0000001', { name: 'X', lng: -122.15, lat: 37.65 }, { at: 1 })
    expect(stale).toEqual([
      { route: 0, leg: 0 },
      { route: 0, leg: 1 },
    ])
    expect(ride.routes[0].legs[2].viaPoints).toEqual([[-122.05, 37.31]])
  })

  it('removing a middle point carries both legs’ shaping points onto the merged leg', () => {
    const ride = fixture()
    const { stale } = removePoint(ride, 'route0000001', 'bbbbbbbbbbbb')
    expect(ride.routes[0].legs).toHaveLength(1)
    expect(ride.routes[0].legs[0].viaPoints).toEqual([
      [-122.21, 37.71],
      [-122.05, 37.31],
    ])
    expect(stale).toEqual([{ route: 0, leg: 0 }])
    expect(valid(ride)).toBe(true)
  })

  it('removing the last stop promotes a survivor so the route stays saveable', () => {
    const ride = fixture()
    removePoint(ride, 'route0000001', 'aaaaaaaaaaaa')
    removePoint(ride, 'route0000001', 'cccccccccccc')
    expect(ride.routes[0].points.map((p) => p.kind)).toEqual(['stop'])
    expect(valid(ride)).toBe(true)
  })

  it('refuses to empty a route', () => {
    const ride = fixture()
    removePoint(ride, 'route0000001', 'aaaaaaaaaaaa')
    removePoint(ride, 'route0000001', 'bbbbbbbbbbbb')
    expect(() => removePoint(ride, 'route0000001', 'cccccccccccc')).toThrow(EditError)
  })

  it('a move clears the shaping points around it', () => {
    const ride = fixture()
    const stale = movePoint(ride, 'route0000001', 'aaaaaaaaaaaa', 2)
    expect(ride.routes[0].points.map((p) => p.uid)).toEqual(['bbbbbbbbbbbb', 'cccccccccccc', 'aaaaaaaaaaaa'])
    expect(ride.routes[0].legs[0].viaPoints).toEqual([[-122.05, 37.31]])
    expect(ride.routes[0].legs[1].viaPoints).toEqual([])
    expect(stale).toEqual([{ route: 0, leg: 1 }])
  })

  it('replacing a point keeps its uid and re-routes both neighbors', () => {
    const ride = fixture()
    const stale = replacePoint(ride, 'route0000001', 'bbbbbbbbbbbb', { name: 'Elsewhere', lng: -121.9, lat: 37.5 })
    expect(ride.routes[0].points[1].uid).toBe('bbbbbbbbbbbb')
    expect(ride.routes[0].points[1].name).toBe('Elsewhere')
    expect(stale.map((s) => s.leg)).toEqual([0, 1])
  })

  it('will not untag a route’s only stop', () => {
    const ride = fixture()
    setRoles(ride, 'route0000001', 'aaaaaaaaaaaa', [])
    expect(() => setRoles(ride, 'route0000001', 'cccccccccccc', [])).toThrow(EditError)
  })

  it('stores a departure as a wall clock carried as UTC', () => {
    const ride = fixture()
    setDeparture(ride, 'route0000001', '2026-11-08T07:30')
    expect(ride.routes[0].startAt).toBe('2026-11-08T07:30:00.000Z')
    expect(() => setDeparture(ride, 'route0000001', 'tomorrow')).toThrow(EditError)
  })

  it('a new route starts at a stop tagged start, in an unused color', () => {
    const ride = fixture()
    const route = addRoute(ride, 'Day two', { name: 'Santa Cruz', lng: -122.03, lat: 36.97 })
    expect(route.points[0].kind).toBe('stop')
    expect(route.points[0].roles).toEqual(['start'])
    expect(route.color).not.toBe(ride.routes[0].color)
    expect(valid(ride)).toBe(true)
  })

  it('an unknown uid is an EditError, never a crash', () => {
    expect(() => addPoint(fixture(), 'nope', { name: '', lng: 0, lat: 0 })).toThrow(EditError)
  })
})

describe('the vias rule matches the builder', () => {
  it('rejoinSpans in route-shape.js agrees that only a middle removal merges', () => {
    const win: Record<string, any> = {}
    new Function('window', readFileSync('public/js/route-shape.js', 'utf8'))(win)
    expect(win.TBShape.rejoinSpans(3, [1])).toEqual([{ from: 0, to: 1 }])
    expect(win.TBShape.rejoinSpans(3, [0])).toEqual([{ from: 1, to: 1 }])
  })
})

describe('rideSummary', () => {
  it('names every route and point by uid and prints ETAs from the wall clock', () => {
    const s = rideSummary(fixture())
    expect(s).toContain('[route0000001]')
    expect(s).toContain('[bbbbbbbbbbbb]')
    expect(s).toContain('ETA 2026-11-07 09:10')
  })

  it('never contains leg geometry', () => {
    const s = rideSummary(fixture())
    expect(s).not.toContain('-122.21')
    expect(s).not.toContain('37.31')
    expect(s).not.toContain('geometry')
  })
})

describe('policy', () => {
  it('prices Haiku and rounds up', () => {
    expect(costMicros('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 0 })).toBe(100_000)
    expect(costMicros('claude-haiku-5-5', { input_tokens: 1, output_tokens: 0 })).toBe(1)
  })

  it('an unknown model is never free', () => {
    expect(costMicros('mystery', { input_tokens: 1_000_000, output_tokens: 0 })).toBe(4_000_000)
  })

  it('stops at the rider cap and the global cap', () => {
    const base = { configured: true, riderSpentMicros: 0, globalSpentMicros: 0, globalCeilingMicros: 25_000_000 }
    expect(freeTierAllows(base).ok).toBe(true)
    expect(freeTierAllows({ ...base, riderSpentMicros: FREE_MONTHLY_MICROS })).toEqual({
      ok: false,
      reason: 'rider-cap',
    })
    expect(freeTierAllows({ ...base, globalSpentMicros: 25_000_000 })).toEqual({ ok: false, reason: 'global-cap' })
    expect(freeTierAllows({ ...base, globalCeilingMicros: 0 })).toEqual({ ok: false, reason: 'off' })
    expect(freeTierAllows({ ...base, configured: false })).toEqual({ ok: false, reason: 'off' })
  })

  it('the Google budget stops at the turn limit and at the day', () => {
    const b = new Budget(0)
    for (let i = 0; i < TURN_LIMITS.placeSearches; i++) expect(b.take('search')).toBe(true)
    expect(b.take('search')).toBe(false)
    const day = new Budget(DAILY_GOOGLE_CALLS - 1)
    expect(day.take('leg')).toBe(true)
    expect(day.take('leg')).toBe(false)
  })
})

describe('sealed keys', () => {
  it('round-trips, and a tampered row or wrong master opens to null', async () => {
    const { seal, open, masterKey, looksLikeAnthropicKey } = await import('../src/agent/sealed-key')
    const { randomBytes } = await import('node:crypto')
    const master = masterKey(randomBytes(32).toString('base64'))!
    const key = 'sk-ant-api03-' + 'x'.repeat(40) + 'WXYZ'
    const s = seal(key, master)
    expect(s.last4).toBe('WXYZ')
    expect(s.ciphertext).not.toContain('sk-ant')
    expect(open(s, master)).toBe(key)
    const flipped = Buffer.from(s.ciphertext, 'base64')
    flipped[0] ^= 1
    expect(open({ ...s, ciphertext: flipped.toString('base64') }, master)).toBeNull()
    expect(open(s, masterKey(randomBytes(32).toString('base64'))!)).toBeNull()
    expect(masterKey('short')).toBeNull()
    expect(looksLikeAnthropicKey(key)).toBe(true)
    expect(looksLikeAnthropicKey('sk-proj-abc')).toBe(false)
  })
})

describe('oauth policy', () => {
  it('accepts https and loopback redirects only', async () => {
    const { validRedirectUri } = await import('../src/oauth/policy')
    expect(validRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(validRedirectUri('http://localhost:6274/oauth/callback')).toBe(true)
    expect(validRedirectUri('http://127.0.0.1:33418/cb')).toBe(true)
    expect(validRedirectUri('http://evil.example/cb')).toBe(false)
    expect(validRedirectUri('https://a.example/cb#frag')).toBe(false)
    expect(validRedirectUri('https://user:pw@a.example/cb')).toBe(false)
    expect(validRedirectUri('myapp://cb')).toBe(false)
  })

  it('S256 matches the RFC 7636 example', async () => {
    const { s256, validVerifier } = await import('../src/oauth/policy')
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(validVerifier(verifier)).toBe(true)
    expect(s256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('keeps the state on the way back', async () => {
    const { redirectWith } = await import('../src/oauth/policy')
    expect(redirectWith('https://a.example/cb?x=1', { code: 'c', state: 's' })).toBe(
      'https://a.example/cb?x=1&code=c&state=s',
    )
  })
})
