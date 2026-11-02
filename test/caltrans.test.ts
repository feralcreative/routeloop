// The Caltrans CWWP2 reader: the chain-code vocabulary, the two feeds' shapes, the
// Pacific clock, the district boxes, the corridor filter, and the cache. No network:
// fetch is stubbed, and the fixtures are real rows from 2026-11-01 (see
// test/fixtures/caltrans/). Every chain point read R-0 that day, so the fixture's
// statuses were edited to the other codes; the rows are otherwise as published,
// including District 7's row with no coordinates and a longitude for a status.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CACHE_MS,
  CC_CACHE_MS,
  CC_DISTRICTS,
  clearCaltransCache,
  districtsAlong,
  eventsNear,
  feedUrl,
  fetchFeed,
  inCalifornia,
  normalizeChainControls,
  normalizeLaneClosures,
  pacificIso,
  pacificToMs,
  parseChainCode,
} from '../src/maps/official/caltrans'
import type { Track } from '../src/maps/kml'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'caltrans', name), 'utf8'))
const CC = fixture('ccStatusD03.json')
const LCS = fixture('lcsStatusD03.json')
const AT = '2026-11-01T12:00-08:00'

/** Placerville over Echo Summit to Meyers, along US-50, through the fixture's points. */
const US50: Track = [
  [-120.799, 38.7303],
  [-120.71225, 38.73694],
  [-120.470669, 38.774111],
  [-120.167161, 38.789049],
  [-120.14841, 38.79514],
  [-120.12281, 38.81135],
  [-120.02966, 38.81311],
  [-119.99, 38.85],
]

describe('parseChainCode', () => {
  it('reads every code on Caltrans’s chart, and nothing unknown as clear', () => {
    expect(parseChainCode('R-0')).toEqual({ code: 'R-0', class: 'none' })
    expect(parseChainCode('R-1')).toEqual({ code: 'R-1', class: 'chains', level: 1 })
    expect(parseChainCode('R-1 MODIFIED')).toEqual({ code: 'R-1 MODIFIED', class: 'chains', level: 1, modified: true })
    expect(parseChainCode('r-1  modified')).toMatchObject({ class: 'chains', modified: true })
    expect(parseChainCode('R-2')).toMatchObject({ class: 'chains', level: 2 })
    expect(parseChainCode('R-3')).toMatchObject({ class: 'chains', level: 3 })
    expect(parseChainCode('W').class).toBe('watch')
    expect(parseChainCode('VM').class).toBe('metering')
    expect(parseChainCode('ESC').class).toBe('escort')
    expect(parseChainCode('HT').class).toBe('hold')
    for (const c of ['TH', 'TS', 'TTA', 'TTS', 'TTSD', 'MIN', 'MAX']) expect(parseChainCode(c).class).toBe('trucks')
    expect(parseChainCode('RC').class).toBe('closed')
    expect(parseChainCode('Road Closed').class).toBe('closed')
    expect(parseChainCode('ROAD CLOSED').class).toBe('closed')
    expect(parseChainCode('Not Reported').class).toBe('not-reported')
    expect(parseChainCode('').class).toBe('not-reported')
    expect(parseChainCode(undefined).class).toBe('not-reported')
  })

  it('keeps what District 7 actually published in the status field as unknown', () => {
    expect(parseChainCode('-118.1307759')).toEqual({ code: '-118.1307759', class: 'unknown' })
    expect(parseChainCode('R-4').class).toBe('unknown')
  })
})

describe('the Pacific clock', () => {
  it('reads wall clock on both sides of the 2026 DST change', () => {
    expect(new Date(pacificToMs('2026-10-31', '12:00:00')!).toISOString()).toBe('2026-10-31T19:00:00.000Z')
    expect(new Date(pacificToMs('2026-11-01', '12:00:00')!).toISOString()).toBe('2026-11-01T20:00:00.000Z')
    expect(pacificIso(Date.parse('2026-11-07T05:01:00Z'))).toBe('2026-11-06T21:01-08:00')
    expect(pacificIso(Date.parse('2026-10-29T21:00:14Z'))).toBe('2026-10-29T14:00-07:00')
    expect(pacificToMs('Not Reported', '')).toBeNull()
  })
})

describe('normalizeChainControls', () => {
  const events = normalizeChainControls(CC, 3, AT)

  it('keeps every in-service row, parsed, with its point and status time', () => {
    expect(events).toHaveLength(7)
    const riverton = events.find((e) => e.name === 'Riverton')!
    expect(riverton).toMatchObject({
      source: 'Caltrans',
      district: 3,
      id: '3-ED-50-38.2-W-167',
      kind: 'chain-control',
      chain: { code: 'R-2', class: 'chains', level: 2 },
      route: 'US-50',
      direction: 'West',
      location: { type: 'point', at: [-120.470669, 38.77411] },
      updatedAt: '2026-11-01T10:15-08:00',
      retrievedAt: AT,
    })
  })

  it('drops "Not Reported" coordinates rather than placing the point at zero', () => {
    const bad = events.find((e) => e.district === 7)!
    expect(bad.location).toBeNull()
    expect(bad.chain?.class).toBe('unknown')
  })

  it('survives a body that is not the feed', () => {
    expect(normalizeChainControls(null, 3, AT)).toEqual([])
    expect(normalizeChainControls({ data: 'nope' }, 3, AT)).toEqual([])
    expect(normalizeChainControls({ data: [{}, { cc: null }] }, 3, AT)).toEqual([])
  })
})

describe('normalizeLaneClosures', () => {
  const events = normalizeLaneClosures(LCS, 3, AT)
  const byId = (id: string) => events.find((e) => e.id === id)!

  it('reads a closure as a line with its window from the epochs', () => {
    const e = byId('C50BA-0002-2026-11-01-19:01:00')
    expect(e).toMatchObject({
      kind: 'lane-closure',
      route: 'US-50',
      direction: 'East / West',
      name: '31 Milestone Tract to Forni Tract',
      location: { type: 'line', from: [-120.319471, 38.765872], to: [-120.167161, 38.789049] },
      beginsWall: '2026-11-01T19:01',
      indefinite: false,
      closure: { closureId: 'C50BA', type: 'One-Way Traffic', facility: 'Conventional Hwy', state: 'planned' },
    })
    expect(e.beginsAt).toBe('2026-11-01T19:01-08:00')
  })

  it('reads started, canceled, and full closures', () => {
    expect(byId('C50KB-0002-2026-11-01-18:01:00').closure?.state).toBe('active')
    expect(byId('C50KB-0002-2026-11-01-18:01:00').updatedAt).toBe('2026-11-01T11:05-08:00')
    expect(byId('C50KB-0003-2026-11-02-18:01:00').closure?.state).toBe('canceled')
  })

  it('reads the indefinite end Caltrans writes as 2999-12-31', () => {
    const body = structuredClone(LCS) as { data: { lcs: { closure: { closureTimestamp: Record<string, string> } } }[] }
    Object.assign(body.data[0].lcs.closure.closureTimestamp, {
      closureEndDate: '2999-12-31',
      closureEndTime: '23:59:00',
      closureEndEpoch: '32503708740',
      isClosureEndIndefinite: 'true',
    })
    const e = normalizeLaneClosures(body, 3, AT)[0]
    expect(e.indefinite).toBe(true)
    expect(e.endsAt).toBeNull()
  })
})

describe('where a route is', () => {
  it('knows California from its neighbors', () => {
    expect(inCalifornia([-120.0297, 38.8131])).toBe(true) // Echo Summit
    expect(inCalifornia([-119.26, 37.91])).toBe(true) // Tioga Pass
    expect(inCalifornia([-116.5, 32.6])).toBe(true) // San Diego County
    expect(inCalifornia([-119.81, 39.53])).toBe(false) // Reno
    expect(inCalifornia([-115.14, 36.17])).toBe(false) // Las Vegas
    expect(inCalifornia([-122.68, 45.52])).toBe(false) // Portland
  })

  it('finds the districts a route passes through, and none outside the state', () => {
    expect(districtsAlong(US50)).toEqual([3, 10])
    expect(districtsAlong([[-118.24, 34.05]])).toContain(7) // Los Angeles
    expect(districtsAlong([[-117.87, 33.68]])).toContain(12) // Irvine
    expect(
      districtsAlong([
        [-115.14, 36.17],
        [-119.81, 39.53],
      ]),
    ).toEqual([])
  })

  it('lists the chain-control districts the documentation lists', () => {
    expect(CC_DISTRICTS).toEqual([1, 2, 3, 6, 7, 8, 9, 10, 11])
    expect(feedUrl('cc', 3)).toBe('https://cwwp2.dot.ca.gov/data/d3/cc/ccStatusD03.json')
    expect(feedUrl('lcs', 12)).toBe('https://cwwp2.dot.ca.gov/data/d12/lcs/lcsStatusD12.json')
  })
})

describe('eventsNear', () => {
  it('keeps chain points on the line, in order along it, and drops the rest', () => {
    const near = eventsNear(normalizeChainControls(CC, 3, AT), US50)
    expect(near.map((n) => n.event.name)).toEqual([
      'Camino Heights',
      'Riverton',
      'Strawberry',
      'Twin Bridges',
      'Echo Summit (Holding only)',
    ])
    expect(near.every((n) => n.offM <= 1000)).toBe(true)
    for (let i = 1; i < near.length; i++) expect(near[i].alongM).toBeGreaterThanOrEqual(near[i - 1].alongM)
  })

  it('matches a closure by either end, and leaves a different highway out', () => {
    const ids = eventsNear(normalizeLaneClosures(LCS, 3, AT), US50).map((n) => n.event.id)
    expect(ids).toContain('C50BA-0002-2026-11-01-19:01:00')
    expect(ids).toContain('C50KB-0002-2026-11-01-18:01:00')
    expect(ids).not.toContain('C5BB-0001-2026-11-06-21:01:00') // I-5 in Sacramento
  })

  it('catches a route that joins a closed stretch partway along it', () => {
    const closure = normalizeLaneClosures(LCS, 3, AT)[0]
    // A road crossing the middle of the closure's chord, nowhere near either end.
    const mid: Track = [
      [-120.2433, 38.7],
      [-120.2433, 38.85],
    ]
    expect(eventsNear([closure], mid)).toHaveLength(1)
    expect(eventsNear([closure], mid, 100)).toHaveLength(1)
    expect(
      eventsNear(
        [closure],
        [
          [-120.2433, 38.6],
          [-120.2433, 38.65],
        ],
      ),
    ).toHaveLength(0)
  })
})

describe('fetchFeed', () => {
  let clock = Date.parse('2026-11-01T20:00:00Z')
  const now = () => clock
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

  beforeEach(() => {
    clearCaltransCache()
    clock = Date.parse('2026-11-01T20:00:00Z')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('caches chain controls for a minute, the way Caltrans publishes them, and shares one request', async () => {
    const fetchMock = vi.fn(async (_url: string) => ok(CC))
    vi.stubGlobal('fetch', fetchMock)
    const [a, b] = await Promise.all([fetchFeed('cc', 3, now), fetchFeed('cc', 3, now)])
    expect(a.ok && a.events.length).toBe(7)
    expect(b).toBe(a)
    clock += CC_CACHE_MS - 1000
    await fetchFeed('cc', 3, now)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    clock += 2000
    await fetchFeed('cc', 3, now)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('https://cwwp2.dot.ca.gov/data/d3/cc/ccStatusD03.json')
  })

  it('caches lane closures for five minutes', async () => {
    const fetchMock = vi.fn(async (_url: string) => ok(LCS))
    vi.stubGlobal('fetch', fetchMock)
    await fetchFeed('lcs', 3, now)
    clock += CACHE_MS - 1000
    await fetchFeed('lcs', 3, now)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a 200 whose rows are not the feed’s, rather than caching an empty all-clear', async () => {
    const fetchMock = vi.fn(async () => ok({ data: [{}, { other: {} }] }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchFeed('cc', 3, now)).toMatchObject({ ok: false, error: 'an answer that was not the expected feed' })
    await fetchFeed('cc', 3, now)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports a timeout as unknown with when it last worked, and does not cache the failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(LCS)),
    )
    expect((await fetchFeed('lcs', 3, now)).ok).toBe(true)
    clock += CACHE_MS + 1000
    const timeout = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    vi.stubGlobal('fetch', timeout)
    const r = await fetchFeed('lcs', 3, now)
    expect(r).toMatchObject({
      ok: false,
      error: 'timed out after 8 seconds',
      triedAt: '2026-11-01T12:05-08:00',
      lastOkAt: '2026-11-01T12:00-08:00',
    })
    await fetchFeed('lcs', 3, now)
    expect(timeout).toHaveBeenCalledTimes(2)
  })

  it('never throws: a 500, a page that is not JSON, and a refused connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>500</html>', { status: 500 })),
    )
    expect(await fetchFeed('cc', 4, now)).toMatchObject({ ok: false, error: 'HTTP 500', lastOkAt: null })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>oops</html>', { status: 200 })),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await fetchFeed('cc', 1, now)).toMatchObject({ ok: false, error: 'an answer that would not parse' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ nope: true })),
    )
    expect(await fetchFeed('cc', 2, now)).toMatchObject({
      ok: false,
      error: 'an answer that was not the expected feed',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    expect(await fetchFeed('cc', 6, now)).toMatchObject({ ok: false, error: 'no answer' })
  })
})
