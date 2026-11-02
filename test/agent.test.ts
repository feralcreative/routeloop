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
import {
  BYO_MODELS,
  costMicros,
  DEFAULT_BYO_MODEL,
  freeTierAllows,
  FREE_MONTHLY_MICROS,
  modelFor,
  pickProvider,
  PROVIDERS,
} from '../src/agent/policy'
import { Budget } from '../src/agent/budget'
import { claimTurn } from '../src/agent/inflight'
import { runTool, type AgentContext } from '../src/agent/tools'
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

  it('a point inserted mid-leg sends each shaping point to the half it lies on (#444)', () => {
    const past = fixture()
    addPoint(past, 'route0000001', { name: 'After the via', lng: -122.15, lat: 37.65 }, { at: 1 })
    expect(past.routes[0].legs.slice(0, 2).map((l) => l.viaPoints)).toEqual([[[-122.21, 37.71]], []])
    const short = fixture()
    addPoint(short, 'route0000001', { name: 'Before the via', lng: -122.24, lat: 37.75 }, { at: 1 })
    expect(short.routes[0].legs.slice(0, 2).map((l) => l.viaPoints)).toEqual([[], [[-122.21, 37.71]]])
    expect(valid(short)).toBe(true)
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

  it('a move clears every leg whose ends moved, as the builder does, even a surviving pair', () => {
    const ride = fixture()
    const stale = movePoint(ride, 'route0000001', 'aaaaaaaaaaaa', 2)
    expect(ride.routes[0].points.map((p) => p.uid)).toEqual(['bbbbbbbbbbbb', 'cccccccccccc', 'aaaaaaaaaaaa'])
    // b-c is the same pair as before, and it is cleared anyway: it is inside the span.
    expect(ride.routes[0].legs.map((l) => l.viaPoints)).toEqual([[], []])
    expect(stale).toEqual([
      { route: 0, leg: 0 },
      { route: 0, leg: 1 },
    ])
    expect(valid(ride)).toBe(true)
  })

  it('a move keeps the road and the vias on legs outside the span', () => {
    const ride = fixture()
    const route = ride.routes[0]
    addPoint(ride, 'route0000001', { name: 'd', lng: -121.9, lat: 36.9 })
    addPoint(ride, 'route0000001', { name: 'e', lng: -121.8, lat: 36.8 })
    route.legs[3] = leg([-121.9, 36.9], [-121.8, 36.8], [[-121.85, 36.85]])
    // a b c d e: move b to index 2, so a c b d e. Legs 0..2 change; leg 3 (d-e) does not.
    const stale = movePoint(ride, 'route0000001', 'bbbbbbbbbbbb', 2)
    expect(stale.map((s) => s.leg)).toEqual([0, 1, 2])
    expect(route.legs[3].viaPoints).toEqual([[-121.85, 36.85]])
    expect(route.legs).toHaveLength(route.points.length - 1)
  })

  it('a move to where the point already is changes nothing', () => {
    const ride = fixture()
    expect(movePoint(ride, 'route0000001', 'bbbbbbbbbbbb', 1)).toEqual([])
    expect(ride.routes[0].legs[0].viaPoints).toEqual([[-122.21, 37.71]])
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

  it('refuses the 401st point and the 201st stop rather than leaving an unsaveable ride', () => {
    const ride = fixture()
    const route = ride.routes[0]
    while (route.points.length < 400) {
      const n = route.points.length
      route.points.push(pt(`p${String(n).padStart(11, '0')}`, -122 + n / 1000, 37, n <= 200 ? 'stop' : 'poi'))
      route.legs.push(leg([-122, 37], [-122, 37]))
    }
    expect(valid(ride)).toBe(true)
    expect(() => addPoint(ride, 'route0000001', { name: 'one more', lng: -121, lat: 37 })).toThrow(EditError)
    route.points.pop()
    route.legs.pop()
    // A refusal leaves the ride exactly as it was, not half-edited.
    const before = JSON.stringify(ride)
    expect(() => addPoint(ride, 'route0000001', { name: 'gas', lng: -121, lat: 37 }, { roles: ['gas'] })).toThrow(
      EditError,
    )
    expect(() => setRoles(ride, 'route0000001', route.points[route.points.length - 1].uid as string, ['food'])).toThrow(
      EditError,
    )
    expect(JSON.stringify(ride)).toBe(before)
    expect(valid(ride)).toBe(true)
  })

  it('refuses a departure that has the right shape but is not a real time', () => {
    const ride = fixture()
    expect(() => setDeparture(ride, 'route0000001', '2026-13-45T09:00')).toThrow(EditError)
    expect(() => setDeparture(ride, 'route0000001', '2026-02-30T09:00')).toThrow(EditError)
    expect(() => setDeparture(ride, 'route0000001', '2026-11-07T25:00')).toThrow(EditError)
    setDeparture(ride, 'route0000001', '2028-02-29T08:30')
    expect(ride.routes[0].startAt).toBe('2028-02-29T08:30:00.000Z')
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
    // Costed as the most expensive model listed, GPT-6 Astra at $10 in.
    expect(costMicros('mystery', { input_tokens: 1_000_000, output_tokens: 0 })).toBe(10_000_000)
  })

  it('prices an OpenAI turn with its cached input apart', () => {
    expect(
      costMicros('gpt-6.1-sol', { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000 }),
    ).toBe(2_000_000 + 1_000_000 + 100_000)
  })

  it('every offered model has a price and every default is offered', () => {
    for (const p of PROVIDERS) {
      expect(BYO_MODELS[p].some((m) => m.id === DEFAULT_BYO_MODEL[p])).toBe(true)
      for (const m of BYO_MODELS[p])
        expect(costMicros(m.id, { input_tokens: 1_000_000, output_tokens: 0 })).toBeLessThanOrEqual(10_000_000)
    }
    // A model priced as WORST because it is missing would also pass the line above
    // for Astra itself, so check a cheap one is not costed at the ceiling.
    expect(costMicros('gpt-6-luna', { input_tokens: 1_000_000, output_tokens: 0 })).toBe(100_000)
  })

  it('accepts a model only from its own provider', () => {
    expect(modelFor('openai', 'gpt-6-luna')).toBe('gpt-6-luna')
    expect(modelFor('openai', 'claude-opus-5-5')).toBe(DEFAULT_BYO_MODEL.openai)
    expect(modelFor('anthropic', 'gpt-6-astra')).toBe(DEFAULT_BYO_MODEL.anthropic)
    expect(modelFor('anthropic', undefined)).toBe(DEFAULT_BYO_MODEL.anthropic)
  })

  it('picks the switched-to key, then the default, then provider order', () => {
    const both = [
      { provider: 'anthropic' as const, isDefault: false },
      { provider: 'openai' as const, isDefault: true },
    ]
    expect(pickProvider([])).toBeNull()
    expect(pickProvider(both)).toBe('openai')
    expect(pickProvider(both, 'anthropic')).toBe('anthropic')
    expect(pickProvider([{ provider: 'openai', isDefault: false }], 'anthropic')).toBe('openai')
    expect(
      pickProvider([
        { provider: 'openai', isDefault: false },
        { provider: 'anthropic', isDefault: false },
      ]),
    ).toBe('anthropic')
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

  it('a cache hit is refunded, and a refund never goes below zero', () => {
    const b = new Budget(0)
    b.take('search')
    b.refund('search')
    b.refund('search')
    expect(b.googleCalls).toBe(0)
    for (let i = 0; i < TURN_LIMITS.placeSearches; i++) expect(b.take('search')).toBe(true)
  })

  it('MCP has no turn, so only the day bounds it', () => {
    const b = new Budget(0, { perTurn: false })
    for (let i = 0; i < TURN_LIMITS.placeSearches + 5; i++) expect(b.take('search')).toBe(true)
    const day = new Budget(DAILY_GOOGLE_CALLS - 1, { perTurn: false })
    expect(day.take('search')).toBe(true)
    expect(day.take('search')).toBe(false)
  })

  it('a turn may spend the smaller of what is left of the rider’s month and the app’s', () => {
    const base = { configured: true, riderSpentMicros: 100_000, globalSpentMicros: 0, globalCeilingMicros: 25_000_000 }
    expect(freeTierAllows(base)).toEqual({ ok: true, remainingMicros: FREE_MONTHLY_MICROS - 100_000 })
    expect(freeTierAllows({ ...base, globalSpentMicros: 25_000_000 - 1_000 })).toEqual({
      ok: true,
      remainingMicros: 1_000,
    })
  })
})

describe('one turn at a time', () => {
  it('refuses a second claim until the first is released, and a double release is harmless', () => {
    const release = claimTurn(41)
    expect(release).not.toBeNull()
    expect(claimTurn(41)).toBeNull()
    expect(claimTurn(42)).not.toBeNull()
    release!()
    release!()
    const again = claimTurn(41)
    expect(again).not.toBeNull()
    again!()
  })
})

describe('runTool', () => {
  const ctx = (): AgentContext => ({
    ride: fixture(),
    role: 'edit',
    snapshot: { kind: 'draft' },
    units: 'mi',
    budget: new Budget(0),
    favor: [],
    avoid: [],
    includeDetails: false,
    changes: [],
    progress: () => {},
    changed: false,
  })

  it('records one change line per edit that landed, and none for a read or a no-op', async () => {
    const c = ctx()
    await runTool(c, 'get_ride', {})
    await runTool(c, 'set_dwell', { route_uid: 'route0000001', point_uid: 'bbbbbbbbbbbb', minutes: 30 })
    await runTool(c, 'move_stop', { route_uid: 'route0000001', point_uid: 'bbbbbbbbbbbb', to_index: 1 })
    expect(c.changes).toEqual(['Dwell time set.'])
    expect(c.changed).toBe(true)
  })

  it('a refused edit leaves the ride and the change list as they were', async () => {
    const c = ctx()
    const before = JSON.stringify(c.ride)
    const out = await runTool(c, 'move_stop', { route_uid: 'route0000001', point_uid: 'bbbbbbbbbbbb', to_index: 9 })
    expect(out.isError).toBe(true)
    expect(JSON.stringify(c.ride)).toBe(before)
    expect(c.changes).toEqual([])
    expect(c.changed).toBe(false)
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

  it('tells an OpenAI key from an Anthropic one', async () => {
    const { looksLikeOpenAIKey } = await import('../src/agent/sealed-key')
    expect(looksLikeOpenAIKey('sk-proj-' + 'a'.repeat(40))).toBe(true)
    expect(looksLikeOpenAIKey('sk-svcacct-' + 'a'.repeat(40))).toBe(true)
    expect(looksLikeOpenAIKey('sk-ant-api03-' + 'a'.repeat(40))).toBe(false)
    expect(looksLikeOpenAIKey('sk-short')).toBe(false)
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

describe('web search sources', () => {
  it('lists each cited source once, and nothing when there are none', async () => {
    const { sourcesLine } = await import('../src/agent/loop')
    expect(sourcesLine([])).toBe('')
    const out = sourcesLine([
      { url: 'https://quickmap.dot.ca.gov/', title: 'Caltrans QuickMap' },
      { url: 'https://quickmap.dot.ca.gov/', title: 'Caltrans QuickMap' },
      { url: 'https://www.nps.gov/yose/planyourvisit/conditions.htm', title: null },
    ])
    expect(out).toBe(
      '\n\nSources:\n- Caltrans QuickMap: https://quickmap.dot.ca.gov/\n- https://www.nps.gov/yose/planyourvisit/conditions.htm',
    )
  })
})
