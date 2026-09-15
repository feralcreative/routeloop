// The arithmetic behind the on-the-road page (#69): which leg is current,
// which is next, whether a kept copy is behind the ride, and which sentence a
// phone reads under the Send buttons. Same harness as drag-index.test.ts.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

let G: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/go-progress.js', 'utf8'))(win)
  G = (win as any).TBGo
})

const routes = [
  { uid: 'a', parts: 3 },
  { uid: 'b', parts: 1 },
  { uid: 'c', parts: 2 },
]

describe('flatten', () => {
  it('lists every leg in ride order, one entry per part', () => {
    expect(G.flatten(routes)).toEqual([
      { routeUid: 'a', part: 1 },
      { routeUid: 'a', part: 2 },
      { routeUid: 'a', part: 3 },
      { routeUid: 'b', part: 1 },
      { routeUid: 'c', part: 1 },
      { routeUid: 'c', part: 2 },
    ])
  })

  it('skips a route with no legs and tolerates garbage', () => {
    expect(G.flatten([{ uid: 'x', parts: 0 }, null, { parts: 2 }])).toEqual([])
    expect(G.flatten(undefined)).toEqual([])
  })
})

describe('current, done, next', () => {
  // Built inside a hook: describe bodies run before beforeAll does.
  let flat: any[]
  beforeAll(() => {
    flat = G.flatten(routes)
  })

  it('nothing is current until the rider taps a leg, and next is the first', () => {
    for (let i = 0; i < flat.length; i++) expect(G.statusOf(flat, null, 'light', i)).toBe('todo')
    expect(G.advance(flat, null, 'light')).toEqual({ routeUid: 'a', part: 1 })
  })

  it('marks the tapped leg current and everything before it done', () => {
    const state = G.markAt(flat, 3, 'light')
    expect(state).toEqual({ routeUid: 'b', part: 1, density: 'light' })
    expect(flat.map((_: unknown, i: number) => G.statusOf(flat, state, 'light', i))).toEqual([
      'done',
      'done',
      'done',
      'current',
      'todo',
      'todo',
    ])
    expect(G.advance(flat, state, 'light')).toEqual({ routeUid: 'c', part: 1 })
  })

  // Null is the honest answer at the end: the caller says "that was the last
  // one" rather than pointing at a leg that does not exist.
  it('advances to null from the last leg', () => {
    const state = G.markAt(flat, flat.length - 1, 'light')
    expect(G.advance(flat, state, 'light')).toBeNull()
  })

  // Part 3 of 5 at Light is a different piece of road from part 3 of 12 at
  // Tight, so a place recorded at one density must not light a leg at another.
  it('ignores a place recorded at another density', () => {
    const state = G.markAt(flat, 2, 'tight')
    expect(G.statusOf(flat, state, 'light', 2)).toBe('todo')
    expect(G.advance(flat, state, 'light')).toEqual({ routeUid: 'a', part: 1 })
    expect(G.statusOf(flat, state, 'tight', 2)).toBe('current')
  })

  // A route deleted since the place was recorded: the place names nothing, so
  // the list is fresh rather than lit somewhere wrong.
  it('treats a place naming a missing route as no place', () => {
    const state = { routeUid: 'gone', part: 1, density: 'light' }
    expect(G.indexOf(flat, state, 'light')).toBe(-1)
    expect(G.advance(flat, state, 'light')).toEqual({ routeUid: 'a', part: 1 })
  })

  it('is out of range safe', () => {
    expect(G.markAt(flat, -1, 'light')).toBeNull()
    expect(G.markAt(flat, 99, 'light')).toBeNull()
    expect(G.advance([], null, 'light')).toBeNull()
  })
})

describe('the stored record holds one place per density', () => {
  it('keeps the other density when one is written', () => {
    let rec = G.withPlace(null, { routeUid: 'a', part: 2, density: 'light' })
    rec = G.withPlace(rec, { routeUid: 'a', part: 5, density: 'tight' })
    expect(G.placeOf(rec, 'light')).toEqual({ routeUid: 'a', part: 2, density: 'light' })
    expect(G.placeOf(rec, 'tight')).toEqual({ routeUid: 'a', part: 5, density: 'tight' })
    expect(G.placeOf(rec, 'off')).toBeNull()
  })

  it('refuses a malformed place and an unknown density', () => {
    expect(G.placeOf({ light: { routeUid: 3, part: 'x' } }, 'light')).toBeNull()
    expect(G.placeOf('nope', 'light')).toBeNull()
    expect(G.withPlace({}, { routeUid: 'a', part: 1, density: 'bogus' })).toEqual({})
    expect(G.isDensity('light')).toBe(true)
    expect(G.isDensity('medium')).toBe(false)
  })

  it('names the key by slug', () => {
    expect(G.key('coast-run')).toBe('routeloop.go.coast-run')
    expect(G.DENSITY_KEY).toBe('routeloop.go.density')
  })
})

describe('staleness of a kept copy', () => {
  const now = Date.parse('2026-09-14T12:00:00Z')

  it('says how long ago, and whether the ride changed since', () => {
    const kept = { keptAt: '2026-09-11T12:00:00Z', updatedAt: '2026-09-10T00:00:00Z' }
    expect(G.staleness(kept, '2026-09-10T00:00:00Z', now)).toEqual({
      changed: false,
      agoText: 'Kept 3 days ago',
      text: 'Kept 3 days ago',
    })
    const s = G.staleness(kept, '2026-09-13T00:00:00Z', now)
    expect(s.changed).toBe(true)
    expect(s.text).toBe('Kept 3 days ago – the ride has changed since')
  })

  // Offline the rendered page IS the kept copy: nothing newer is known, so
  // it cannot be called stale.
  it('is never stale with no live date', () => {
    const kept = { keptAt: '2026-09-11T12:00:00Z', updatedAt: '2026-09-10T00:00:00Z' }
    expect(G.staleness(kept, null, now).changed).toBe(false)
  })

  it('is null for no kept copy', () => {
    expect(G.staleness(null, null, now)).toBeNull()
    expect(G.staleness({ keptAt: 'garbage' }, null, now)).toBeNull()
  })
})

describe('fmtAgo and fmtBytes', () => {
  it('rounds down to the coarse unit', () => {
    expect(G.fmtAgo(0)).toBe('just now')
    expect(G.fmtAgo(59_000)).toBe('just now')
    expect(G.fmtAgo(60_000)).toBe('1 min ago')
    expect(G.fmtAgo(59 * 60_000)).toBe('59 min ago')
    expect(G.fmtAgo(60 * 60_000)).toBe('1 hour ago')
    expect(G.fmtAgo(23 * 3_600_000)).toBe('23 hours ago')
    expect(G.fmtAgo(24 * 3_600_000)).toBe('1 day ago')
    expect(G.fmtAgo(9 * 86_400_000)).toBe('9 days ago')
    expect(G.fmtAgo(-5)).toBe('just now')
  })

  it('formats sizes a rider can read', () => {
    expect(G.fmtBytes(512)).toBe('512 B')
    expect(G.fmtBytes(820_000)).toBe('820 kB')
    expect(G.fmtBytes(1_400_000)).toBe('1.4 MB')
    expect(G.fmtBytes(2.1e9)).toBe('2.1 GB')
    expect(G.fmtBytes(NaN)).toBe('')
  })
})

describe('the hint under the Send buttons', () => {
  const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
  const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
  const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'
  const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'

  it('sends iOS through the share sheet and tells them about Files', () => {
    expect(G.hintFor(IOS, true)).toBe('ios-share')
    expect(G.hintFor(IPAD, true)).toBe('ios-share')
    expect(G.hintFor(IOS, false)).toBe('ios-download')
    expect(G.HINTS['ios-share']).toMatch(/Save to Files/)
  })

  // Chrome's permitted list has no GPX in it, so on Android the share sheet is
  // never offered whatever canShare says about text.
  it('sends Android to Downloads regardless of share support', () => {
    expect(G.hintFor(ANDROID, true)).toBe('android-download')
    expect(G.hintFor(ANDROID, false)).toBe('android-download')
  })

  it('falls back sensibly on a desktop', () => {
    expect(G.hintFor(DESKTOP, false)).toBe('download')
    expect(G.hintFor(DESKTOP, true)).toBe('share')
    expect(G.hintFor(undefined, false)).toBe('download')
  })

  it('has a sentence for every hint', () => {
    for (const k of ['ios-share', 'ios-download', 'android-download', 'share', 'download']) {
      expect(typeof G.HINTS[k]).toBe('string')
      expect(G.HINTS[k].length).toBeGreaterThan(20)
    }
  })
})
