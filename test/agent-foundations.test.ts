// The agent's foundations (#452, #453): who may call what, what one call may spend,
// which version of a ride an answer is about, what never reaches a model provider,
// and the pending-proposal store the MCP server saves through.
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { ridePayload, type RidePayload } from '../src/maps/ride-graph'
import { Budget } from '../src/agent/budget'
import { rideSummary } from '../src/agent/summary'
import { annotationsOf, mayCall, READS, RIDELESS, runTool, TOOLS, type AgentContext } from '../src/agent/tools'
import {
  clearProposals,
  dropProposal,
  getProposal,
  MAX_COORDS,
  MAX_PER_RIDER,
  MAX_PROPOSALS,
  PROPOSAL_TTL_MS,
  putProposal,
} from '../src/mcp/proposals'

const pt = (uid: string, lng: number, lat: number, kind: 'stop' | 'poi' = 'stop') => ({
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
})

function fixture(): RidePayload {
  return ridePayload.parse({
    title: 'Coast run',
    routes: [
      {
        uid: 'route0000001',
        title: 'Day one',
        startAt: '2026-11-07T09:00:00.000Z',
        points: [pt('aaaaaaaaaaaa', -122.27, 37.8), pt('cccccccccccc', -122.0, 37.0)],
        legs: [
          {
            geometry: [
              [-122.27, 37.8],
              [-122.0, 37.0],
            ],
            distanceM: 10_000,
            durationS: 600,
            viaPoints: [],
          },
        ],
      },
    ],
  })
}

const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
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
  ...over,
})

describe('capabilities', () => {
  it('derive READS and RIDELESS, so neither can disagree with a tool', () => {
    for (const t of TOOLS) {
      expect(READS.has(t.name), t.name).toBe(!t.cap.mutates)
      expect(RIDELESS.has(t.name), t.name).toBe(t.cap.needs === 'none')
    }
  })

  it('give every edit a need of at least edit, and nothing a need of owner yet', () => {
    for (const t of TOOLS) if (t.cap.mutates) expect(mayCall('view', t.cap.needs), t.name).toBe(false)
  })

  it('rank view < edit < owner, with none open to all', () => {
    expect(mayCall('view', 'none')).toBe(true)
    expect(mayCall('view', 'edit')).toBe(false)
    expect(mayCall('edit', 'edit')).toBe(true)
    expect(mayCall('edit', 'owner')).toBe(false)
    expect(mayCall('owner', 'edit')).toBe(true)
  })

  it('call a tool read-only only when it changes nothing and spends nothing', () => {
    expect(annotationsOf({ mutates: false, needs: 'view' })).toEqual({ readOnlyHint: true, openWorldHint: false })
    expect(annotationsOf({ mutates: false, needs: 'view', spends: { search: 1 } })).toEqual({
      readOnlyHint: false,
      openWorldHint: true,
    })
    expect(annotationsOf({ mutates: true, destructive: true, needs: 'edit' })).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    })
  })

  it('refuse an edit from a rider who can only view, and leave the ride alone', async () => {
    const c = ctx({ role: 'view' })
    const before = JSON.stringify(c.ride)
    const out = await runTool(c, 'set_dwell', { route_uid: 'route0000001', point_uid: 'cccccccccccc', minutes: 30 })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/needs edit access/)
    expect(JSON.stringify(c.ride)).toBe(before)
    expect((await runTool(c, 'get_ride', {})).isError).toBe(false)
  })
})

describe('MCP server wiring (read as text: importing it pulls in the database)', () => {
  const src = readFileSync('src/mcp/server.ts', 'utf8')

  it('derives every tool annotation from a capability, with no hand-kept table', () => {
    const registered = src.match(/server\.registerTool\(/g)?.length ?? 0
    const derived = src.match(/annotations: annotationsOf\(/g)?.length ?? 0
    expect(registered).toBeGreaterThan(0)
    expect(derived).toBe(registered)
    expect(src).not.toMatch(/const ANNOTATIONS/)
  })

  it('names no other rider to the client', () => {
    expect(src).not.toMatch(/displayName/)
  })

  it('puts every proposal tool behind the lock and an access check', () => {
    for (const name of ['review_changes', 'discard_changes']) {
      const at = src.indexOf(`'${name}',`)
      const body = src.slice(at, src.indexOf('server.registerTool(', at + 1))
      expect(body, name).toMatch(/withEditAccess\(/)
    }
    expect(src).toMatch(/const applyChanges = [^\n]*\n\s*withEditAccess\(/)
  })

  it('never saves from an edit tool: only apply_changes calls saveRide', () => {
    expect(src.match(/await saveRide\(/g)?.length).toBe(1)
    const apply = src.slice(src.indexOf('const applyChanges'))
    expect(apply).toMatch(/await saveRide\(/)
  })
})

describe('per-call ceilings match what each edit redraws', () => {
  const long = (): RidePayload => {
    const points = Array.from({ length: 20 }, (_, i) =>
      pt(`p${String(i).padStart(11, '0')}`, -122 + i * 0.01, 37 + i * 0.01, i % 5 === 0 ? 'stop' : 'poi'),
    )
    return ridePayload.parse({
      title: 'Long',
      routes: [
        {
          uid: 'route0000001',
          title: 'Day',
          points,
          legs: points.slice(1).map((b, i) => ({
            geometry: [
              [points[i].lng, points[i].lat],
              [b.lng, b.lat],
            ],
            distanceM: 1000,
            durationS: 60,
            viaPoints: [],
          })),
        },
      ],
    })
  }

  it('refuses a move whose span is past its ceiling, before anything moves', async () => {
    const c = ctx({ ride: long() })
    const before = JSON.stringify(c.ride)
    const out = await runTool(c, 'move_stop', { route_uid: 'route0000001', point_uid: 'p00000000001', to_index: 18 })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/in steps/)
    expect(JSON.stringify(c.ride)).toBe(before)
  })

  it('lets a short move through', async () => {
    const c = ctx({ ride: long() })
    const out = await runTool(c, 'move_stop', { route_uid: 'route0000001', point_uid: 'p00000000003', to_index: 6 })
    expect(out.isError).toBe(false)
  })
})

describe('per-call budget', () => {
  it('lets a call spend only what its capability declares', () => {
    const b = new Budget(0)
    b.beginCall({ search: 1 })
    expect(b.take('search')).toBe(true)
    expect(b.take('search')).toBe(false)
    expect(b.take('leg')).toBe(false)
    b.beginCall({ leg: 2 })
    expect(b.take('leg')).toBe(true)
    expect(b.take('leg')).toBe(true)
    expect(b.take('leg')).toBe(false)
  })

  it('bounds an MCP call although MCP has no per-turn limit', () => {
    const b = new Budget(0, { perTurn: false })
    b.beginCall({ search: 1 })
    expect(b.take('search')).toBe(true)
    expect(b.take('search')).toBe(false)
  })

  it('gives a refunded call back to the call as well as the turn', () => {
    const b = new Budget(0)
    b.beginCall({ search: 1 })
    expect(b.take('search')).toBe(true)
    b.refund('search')
    expect(b.take('search')).toBe(true)
    expect(b.googleCalls).toBe(1)
  })
})

describe('snapshot line', () => {
  it('says which version of the ride the summary describes', () => {
    const r = fixture()
    expect(rideSummary(r, { snapshot: { kind: 'draft' } })).toContain('open copy, unsaved edits included')
    expect(rideSummary(r, { snapshot: { kind: 'saved', rev: 7, pending: 0 } })).toContain('As saved (revision 7).')
    expect(rideSummary(r, { snapshot: { kind: 'saved', rev: 7, pending: 2 } })).toContain(
      'plus 2 changes you proposed that are not applied yet',
    )
  })
})

describe('privacy', () => {
  // The creator's private notes are disclosed on the privacy page and reach the
  // summary; nothing else from the private stop record may.
  const withDetails = () => {
    const r = fixture()
    r.routes[0].points[1].details = {
      confirmation: 'CONF-9931',
      checkInAt: '2026-11-07T15:00:00.000Z',
      checkOutAt: null,
      phone: '707-555-0199',
      address: '12 Gate Code Lane',
      links: [{ label: 'Booking', url: 'https://example.com/booking/secret' }],
      notes: 'Ask for the room by the creek.',
    }
    return r
  }

  it('keeps every private field but the notes out of the summary, even for the creator', () => {
    const out = rideSummary(withDetails(), { includeDetails: true })
    expect(out).toContain('Ask for the room by the creek.')
    for (const secret of ['CONF-9931', '707-555-0199', '12 Gate Code Lane', 'example.com/booking/secret'])
      expect(out).not.toContain(secret)
  })

  it('keeps the notes out too for anyone but the creator', () => {
    expect(rideSummary(withDetails(), { includeDetails: false })).not.toContain('creek')
  })
})

describe('proposals', () => {
  beforeEach(() => clearProposals())
  const p = (userId: number, rideId: number) => ({
    userId,
    rideId,
    baseRev: 3,
    ride: fixture(),
    changes: ['Dwell time set.'],
    touchedAt: 0,
  })

  it('keeps one per rider per ride', () => {
    putProposal(p(1, 10), 1000)
    putProposal({ ...p(1, 10), changes: ['a', 'b'] }, 1000)
    putProposal(p(2, 10), 1000)
    expect(getProposal(1, 10, 1000)?.changes).toEqual(['a', 'b'])
    expect(getProposal(2, 10, 1000)?.changes).toEqual(['Dwell time set.'])
    dropProposal(1, 10)
    expect(getProposal(1, 10, 1000)).toBeNull()
  })

  it('expires one left untouched past the TTL', () => {
    putProposal(p(1, 10), 0)
    expect(getProposal(1, 10, PROPOSAL_TTL_MS)).not.toBeNull()
    expect(getProposal(1, 10, PROPOSAL_TTL_MS + 1)).toBeNull()
  })

  it('evicts the oldest when full', () => {
    for (let i = 0; i < MAX_PROPOSALS + 1; i++) putProposal(p(i, 1), 1000)
    expect(getProposal(0, 1, 1000)).toBeNull()
    expect(getProposal(MAX_PROPOSALS, 1, 1000)).not.toBeNull()
  })

  it('lets a busy rider evict only their own oldest', () => {
    putProposal(p(9, 1), 1000)
    for (let r = 10; r < 10 + MAX_PER_RIDER + 1; r++) putProposal(p(1, r), 1000)
    expect(getProposal(1, 10, 1000)).toBeNull()
    expect(getProposal(1, 10 + MAX_PER_RIDER, 1000)).not.toBeNull()
    expect(getProposal(9, 1, 1000)).not.toBeNull()
  })

  it('bounds the geometry held, not just the count', () => {
    const big = (userId: number) => {
      const x = p(userId, 1)
      x.ride.routes[0].legs[0].geometry = Array.from({ length: MAX_COORDS / 2 }, () => [-122, 37] as [number, number])
      return x
    }
    putProposal(big(1), 1000)
    putProposal(big(2), 1000)
    putProposal(big(3), 1000)
    expect(getProposal(1, 1, 1000)).toBeNull()
    expect(getProposal(3, 1, 1000)).not.toBeNull()
  })
})
