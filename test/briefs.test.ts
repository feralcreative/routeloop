// The trip brief (#456): how an edit merges, how an old row reads, and the tool
// that keeps it. The database is mocked; the brief's own table is the service's.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/briefs/service', () => ({ briefFor: vi.fn(), updateBrief: vi.fn() }))

import { briefLines, isEmptyBrief, mergeBrief, readBrief } from '../src/briefs/policy'
import { updateBrief } from '../src/briefs/service'
import type { RidePayload } from '../src/maps/ride-graph'
import { Budget } from '../src/agent/budget'
import { annotationsOf, runTool, TOOLS, type AgentContext } from '../src/agent/tools'

describe('the brief', () => {
  it('sets, keeps, and clears fields', () => {
    const a = mergeBrief({}, { pace: 'relaxed', hoursPerDay: 6 })
    expect(a).toEqual({ pace: 'relaxed', hoursPerDay: 6 })
    expect(mergeBrief(a, { gravel: 'none' })).toEqual({ pace: 'relaxed', hoursPerDay: 6, gravel: 'none' })
    expect(mergeBrief(a, { pace: null, notes: '' })).toEqual({ hoursPerDay: 6 })
    expect(mergeBrief(a, { notes: '   ' })).toEqual(a)
  })

  it('refuses a value outside the shape', () => {
    expect(() => mergeBrief({}, { hoursPerDay: 40 })).toThrow()
  })

  it('reads an old row leniently, dropping only what no longer fits', () => {
    expect(readBrief({ pace: 'warp', hoursPerDay: 7, gone: 1 })).toEqual({ hoursPerDay: 7 })
    expect(readBrief(null)).toEqual({})
    expect(isEmptyBrief({})).toBe(true)
  })

  it('reads in the rider’s units', () => {
    expect(briefLines({ dayM: 321_869, gravel: 'none' }, 'mi')).toEqual([
      { label: 'Longest day', value: '200 mi' },
      { label: 'Gravel and dirt', value: 'pavement only' },
    ])
    expect(briefLines({ dayM: 300_000 }, 'km')[0].value).toBe('300 km')
  })
})

const ride = { title: 'Brief', routes: [], subgroups: [] } as unknown as RidePayload
const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
  ride,
  role: 'edit',
  rideId: 7,
  userId: 3,
  snapshot: { kind: 'draft' },
  brief: {},
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

describe('set_trip_brief', () => {
  beforeEach(() => {
    vi.mocked(updateBrief).mockReset()
    vi.mocked(updateBrief).mockImplementation(async (_r, _u, edit) => mergeBrief({}, edit))
  })

  it('saves the merge in meters and reads it back, without touching the ride', async () => {
    const c = ctx()
    const out = await runTool(c, 'set_trip_brief', { longest_day: 200, pace: 'steady', weather: 'no rain' })
    expect(out.isError).toBe(false)
    expect(updateBrief).toHaveBeenCalledWith(7, 3, { dayM: 321_869, pace: 'steady', weather: 'no rain' })
    expect(c.changed).toBe(false)
    expect(out.text).toContain('Longest day: 200 mi')
    expect(out.text).toContain('Weather limits: "no rain"')
  })

  it('needs edit standing', async () => {
    const out = await runTool(ctx({ role: 'view' }), 'set_trip_brief', { pace: 'brisk' })
    expect(out.isError).toBe(true)
    expect(updateBrief).not.toHaveBeenCalled()
  })

  it('says so on a ride with nowhere to keep one', async () => {
    const out = await runTool(ctx({ brief: undefined }), 'set_trip_brief', { pace: 'brisk' })
    expect(out.text).toContain('not saved yet')
    expect(updateBrief).not.toHaveBeenCalled()
  })

  it('is not marked read-only to an MCP client', () => {
    const t = TOOLS.find((x) => x.name === 'set_trip_brief')!
    expect(annotationsOf(t.cap).readOnlyHint).toBe(false)
  })
})
