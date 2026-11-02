// draft_road_report and file_road_report (#455): a draft snaps onto the drawn road or
// is refused, a live duplicate is flagged rather than drafted, and nothing is filed
// without a valid token and confirmed: true. The service is mocked, so nothing reads
// a database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ridePayload, type RidePayload } from '../src/maps/ride-graph'
import { sameReport } from '../src/road-reports/policy'
import type { NearbyReport } from '../src/road-reports/service'

vi.mock('../src/road-reports/service', () => ({ createReport: vi.fn(), liveReportsNear: vi.fn() }))

const service = await import('../src/road-reports/service')
const { _reset } = await import('../src/auth/ratelimit')
const { DRAFT_SNAP_M, FILE_LIMIT, clearReportDrafts, draftFor, fileFor, fileRoadReport, snapOntoRoute } =
  await import('../src/agent/tools/report-road')

const NOW = new Date('2026-11-01T12:00:00Z')

const pt = (uid: string, name: string, lng: number, lat: number) => ({
  uid,
  kind: 'stop' as const,
  name,
  lat,
  lng,
  roles: [],
  durationMin: null,
})

// A road due east along latitude 39.5, drawn, then a second leg still straight.
const ride = (): RidePayload =>
  ridePayload.parse({
    title: 'Lost Coast',
    routes: [
      {
        uid: 'route0000001',
        title: 'Out to Platina',
        points: [
          pt('pointa000001', 'Red Bluff', -122.6, 39.5),
          pt('pointb000001', 'Platina', -122.4, 39.5),
          pt('pointc000001', 'Ranch', -122.2, 39.7),
        ],
        legs: [
          {
            geometry: [
              [-122.6, 39.5],
              [-122.5, 39.5],
              [-122.4, 39.5],
            ],
            distanceM: 17_000,
            durationS: 900,
            viaPoints: [],
          },
          {
            geometry: [
              [-122.4, 39.5],
              [-122.2, 39.7],
            ],
            distanceM: 28_000,
            durationS: 0,
            viaPoints: [],
          },
        ],
      },
    ],
  })

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    ride: ride(),
    rideId: 42,
    userId: 7,
    units: 'mi',
    snapshot: { kind: 'saved', rev: 3, pending: 0 },
    progress: () => {},
    ...over,
  }) as unknown as Parameters<typeof draftFor>[0]

const base = { kind: 'closure' as const, note: 'Closed past Platina for a slide', route_uid: 'route0000001' }

const tokenOf = (text: string) => /Draft token: (\S+)/.exec(text)?.[1] as string

beforeEach(() => {
  vi.mocked(service.liveReportsNear).mockResolvedValue([])
  vi.mocked(service.createReport).mockResolvedValue(99)
})

afterEach(() => {
  vi.clearAllMocks()
  clearReportDrafts()
  _reset()
})

describe('snapOntoRoute', () => {
  it('moves a nearby spot onto the drawn line', () => {
    // About 110 m north of the road.
    const s = snapOntoRoute(ride().routes[0], [-122.45, 39.501])
    expect(s.ok).toBe(true)
    if (!s.ok) return
    expect(s.at).toEqual([-122.45, 39.5])
    expect(s.leg).toBe(0)
    expect(s.movedM).toBeGreaterThan(100)
    expect(s.movedM).toBeLessThan(DRAFT_SNAP_M)
  })

  it('refuses a spot off every road', () => {
    const s = snapOntoRoute(ride().routes[0], [-122.5, 39.55])
    expect(s).toMatchObject({ ok: false, reason: 'off-road' })
  })

  it('refuses a spot nearest a leg still drawn straight', () => {
    const s = snapOntoRoute(ride().routes[0], [-122.3, 39.6])
    expect(s).toMatchObject({ ok: false, reason: 'undrawn', leg: 1 })
  })
})

describe('draft_road_report', () => {
  it('drafts at the snapped spot, writes nothing, and returns a token', async () => {
    const text = await draftFor(ctx(), { ...base, lat: 39.501, lng: -122.45 }, NOW)
    expect(text).toContain('NOTHING HAS BEEN FILED')
    expect(text).toContain('Kind: Closed')
    expect(text).toContain('between “Red Bluff” and “Platina”, at (39.5000, -122.4500)')
    expect(text).toContain('Note: "Closed past Platina for a slide"')
    expect(text).toContain('Counts for 60 days, until 2026-12-31.')
    expect(text).toContain('Nobody is shown who filed it.')
    expect(tokenOf(text)).toBeTruthy()
    expect(service.liveReportsNear).toHaveBeenCalledWith('closure', [-122.45, 39.5], 500, NOW)
    expect(service.createReport).not.toHaveBeenCalled()
  })

  it('takes a point on the route as the spot', async () => {
    const text = await draftFor(ctx(), { ...base, point_uid: 'pointb000001' }, NOW)
    expect(text).toContain('at (39.5000, -122.4000)')
  })

  it('refuses a spot off the road', async () => {
    const text = await draftFor(ctx(), { ...base, lat: 39.55, lng: -122.5 }, NOW)
    expect(text).toContain('not on this route')
    expect(text).not.toContain('Draft token')
  })

  it('refuses a spot on an undrawn leg', async () => {
    const text = await draftFor(ctx(), { ...base, lat: 39.6, lng: -122.3 }, NOW)
    expect(text).toContain('still a straight line')
    expect(text).not.toContain('Draft token')
  })

  it('flags a live duplicate instead of drafting', async () => {
    vi.mocked(service.liveReportsNear).mockResolvedValue([
      {
        id: 5,
        kind: 'closure',
        note: 'Slide at mile 30',
        at: [-122.451, 39.5],
        season: null,
        createdAt: '2026-10-30T10:00:00.000Z',
        expiresAt: '2026-12-29T10:00:00.000Z',
        distanceM: 86,
      },
    ])
    const text = await draftFor(ctx(), { ...base, lat: 39.5, lng: -122.45 }, NOW)
    expect(text).toContain('already 282 ft from that spot')
    expect(text).toContain('"Slide at mile 30"')
    expect(text).not.toContain('Draft token')
  })

  it('carries a season and says it never expires', async () => {
    const text = await draftFor(ctx(), { ...base, lat: 39.5, lng: -122.45, season_start: 1101, season_end: 531 }, NOW)
    expect(text).toContain('Kind: Seasonal closure')
    expect(text).toContain('Closed Nov 1 to May 31 every year; it never expires.')
  })

  it('refuses a season on anything but a closure, through the map’s own validation', async () => {
    const text = await draftFor(
      ctx(),
      { ...base, kind: 'hazard', lat: 39.5, lng: -122.45, season_start: 1101, season_end: 531 },
      NOW,
    )
    expect(text).toContain('Only a closure can be seasonal.')
  })

  it('refuses without a saved ride or a rider', async () => {
    expect(await draftFor(ctx({ rideId: undefined }), { ...base, lat: 39.5, lng: -122.45 }, NOW)).toContain(
      'cannot be drafted',
    )
    expect(await draftFor(ctx({ userId: undefined }), { ...base, lat: 39.5, lng: -122.45 }, NOW)).toContain(
      'cannot be drafted',
    )
  })
})

describe('dedupe and seasons', () => {
  const near = (season: NearbyReport['season']): NearbyReport => ({
    id: 5,
    kind: 'closure',
    note: '',
    at: [-122.45, 39.5],
    season,
    createdAt: '2026-10-30T10:00:00.000Z',
    expiresAt: season ? null : '2026-12-29T10:00:00.000Z',
    distanceM: 20,
  })
  const winter = { start: 1101, end: 531 }

  it('sameReport: temporary vs temporary is the same, seasonal vs temporary is not', () => {
    expect(sameReport({ season: null }, { season: null })).toBe(true)
    expect(sameReport({ season: null }, { season: winter })).toBe(false)
    expect(sameReport({ season: winter }, { season: null })).toBe(false)
  })

  it('sameReport: two seasons are the same only when their windows overlap, wrapping the year', () => {
    expect(sameReport({ season: winter }, { season: { start: 1215, end: 301 } })).toBe(true)
    expect(sameReport({ season: winter }, { season: { start: 401, end: 1201 } })).toBe(true)
    expect(sameReport({ season: winter }, { season: { start: 701, end: 815 } })).toBe(false)
  })

  it('a live winter closure does not block drafting a summer slide', async () => {
    vi.mocked(service.liveReportsNear).mockResolvedValue([near(winter)])
    const text = await draftFor(ctx(), { ...base, lat: 39.5, lng: -122.45 }, NOW)
    expect(text).toContain('Draft token')
  })

  it('a live slide does not block recording the closure that comes every year', async () => {
    vi.mocked(service.liveReportsNear).mockResolvedValue([near(null)])
    const text = await draftFor(ctx(), { ...base, lat: 39.5, lng: -122.45, season_start: 1101, season_end: 531 }, NOW)
    expect(text).toContain('Draft token')
  })

  it('an overlapping seasonal closure is a duplicate; a disjoint one is not', async () => {
    vi.mocked(service.liveReportsNear).mockResolvedValue([near({ start: 1201, end: 401 })])
    const dup = await draftFor(ctx(), { ...base, lat: 39.5, lng: -122.45, season_start: 1101, season_end: 531 }, NOW)
    expect(dup).toContain('already')
    expect(dup).not.toContain('Draft token')
    vi.mocked(service.liveReportsNear).mockResolvedValue([near({ start: 701, end: 815 })])
    const ok = await draftFor(ctx(), { ...base, lat: 39.5, lng: -122.45, season_start: 1101, season_end: 531 }, NOW)
    expect(ok).toContain('Draft token')
  })

  it('skips a non-matching nearer report and still finds a matching one behind it', async () => {
    vi.mocked(service.liveReportsNear).mockResolvedValue([near(winter), { ...near(null), id: 6, distanceM: 300 }])
    const text = await draftFor(ctx(), { ...base, lat: 39.5, lng: -122.45 }, NOW)
    expect(text).toContain('already 984 ft')
  })
})

describe('file_road_report', () => {
  const draft = async () => tokenOf(await draftFor(ctx(), { ...base, lat: 39.501, lng: -122.45 }, NOW))

  it('files once, as the rider, at the snapped spot, and spends the token', async () => {
    const token = await draft()
    const text = await fileFor(ctx(), { draft_token: token, confirmed: true }, NOW)
    expect(text).toContain('Filed road report 99')
    expect(service.createReport).toHaveBeenCalledTimes(1)
    expect(service.createReport).toHaveBeenCalledWith(
      7,
      { kind: 'closure', note: 'Closed past Platina for a slide', at: [-122.45, 39.5], season: null },
      NOW,
    )
    expect(await fileFor(ctx(), { draft_token: token, confirmed: true }, NOW)).toContain('No such draft')
    expect(service.createReport).toHaveBeenCalledTimes(1)
  })

  it('refuses an unknown token, or one made for another rider or ride', async () => {
    expect(await fileFor(ctx(), { draft_token: 'nope', confirmed: true }, NOW)).toContain('No such draft')
    const token = await draft()
    expect(await fileFor(ctx({ userId: 8 }), { draft_token: token, confirmed: true }, NOW)).toContain('No such draft')
    expect(await fileFor(ctx({ rideId: 43 }), { draft_token: token, confirmed: true }, NOW)).toContain('No such draft')
    expect(service.createReport).not.toHaveBeenCalled()
  })

  it('refuses without confirmed: true, in the schema and in the body', async () => {
    const token = await draft()
    expect(fileRoadReport.schema.safeParse({ draft_token: token, confirmed: false }).success).toBe(false)
    expect(fileRoadReport.schema.safeParse({ draft_token: token }).success).toBe(false)
    expect(await fileFor(ctx(), { draft_token: token, confirmed: false }, NOW)).toContain('Nothing was filed')
    expect(service.createReport).not.toHaveBeenCalled()
  })

  it('refuses an expired draft', async () => {
    const token = await draft()
    const later = new Date(NOW.getTime() + 16 * 60_000)
    expect(await fileFor(ctx(), { draft_token: token, confirmed: true }, later)).toContain('No such draft')
  })

  it('stores the expiry the rider was shown, even when confirmed after midnight', async () => {
    const before = new Date('2026-11-01T23:58:00Z')
    const text = await draftFor(ctx(), { ...base, lat: 39.501, lng: -122.45 }, before)
    expect(text).toContain('until 2026-12-31')
    const after = new Date('2026-11-02T00:03:00Z')
    expect(await fileFor(ctx(), { draft_token: tokenOf(text), confirmed: true }, after)).toContain('Filed road report')
    expect(vi.mocked(service.createReport).mock.calls[0][2]).toEqual(before)
    expect(service.liveReportsNear).toHaveBeenLastCalledWith('closure', [-122.45, 39.5], 500, after)
  })

  it('refuses a duplicate filed since the draft', async () => {
    const token = await draft()
    vi.mocked(service.liveReportsNear).mockResolvedValue([
      {
        id: 5,
        kind: 'closure',
        note: '',
        at: [-122.45, 39.5],
        season: null,
        createdAt: '2026-11-01T11:59:00.000Z',
        expiresAt: null,
        distanceM: 3,
      },
    ])
    expect(await fileFor(ctx(), { draft_token: token, confirmed: true }, NOW)).toContain('already')
    expect(service.createReport).not.toHaveBeenCalled()
  })

  it('rate-limits a rider', async () => {
    for (let i = 0; i < FILE_LIMIT.max; i++) {
      const token = await draft()
      expect(await fileFor(ctx(), { draft_token: token, confirmed: true }, NOW)).toContain('Filed road report')
    }
    const token = await draft()
    expect(await fileFor(ctx(), { draft_token: token, confirmed: true }, NOW)).toContain(
      `more than ${FILE_LIMIT.max} road reports`,
    )
    expect(service.createReport).toHaveBeenCalledTimes(FILE_LIMIT.max)
  })
})
