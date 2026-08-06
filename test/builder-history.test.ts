// Undo/redo and draft recovery for the builder.
//
// This exists because the properties it asserts are invisible when they break.
// A snapshot that shares a `roles` array still passes every manual test until
// the day a role toggle silently rewrites history that was taken ten edits
// ago. A restore that reuses route objects works perfectly until a routing
// response that left before an undo lands after it. Neither shows up in a
// click-through; both are one assertion here.
//
// Same harness as twist-client.test.ts: eval the browser file, drive the
// global it exports. No DOM, no map — that is exactly why the logic lives in
// its own file.
import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

type Snap = { meta: Record<string, unknown>; routes: any[] }
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; key(i: number): string | null; length: number }

let H: any
let store: Store & { _map: Map<string, string>; _failOn: null | ((k: string, v: string) => boolean) }

// A localStorage stand-in that can be told to run out of room, so the quota
// path is tested rather than hoped about.
function makeStore() {
  const _map = new Map<string, string>()
  const s: any = {
    _map,
    _failOn: null,
    get length() {
      return _map.size
    },
    key: (i: number) => Array.from(_map.keys())[i] ?? null,
    getItem: (k: string) => (_map.has(k) ? (_map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      if (s._failOn && s._failOn(k, v)) {
        const e: any = new Error('quota')
        e.name = 'QuotaExceededError'
        throw e
      }
      _map.set(k, v)
    },
    removeItem: (k: string) => {
      _map.delete(k)
    },
  }
  return s
}

// Fresh module per test: the draft half reads window.localStorage at call
// time, so the fake has to be in place before the file is evaluated.
function load() {
  store = makeStore()
  const win: Record<string, unknown> = { localStorage: store }
  new Function('window', readFileSync('public/js/builder-history.js', 'utf8'))(win)
  H = (win as any).TBHistory
}

const leg = (pts: number) => ({
  geometry: Array.from({ length: pts }, (_, i) => [-122 + i / 1000, 37] as [number, number]),
  distanceM: 1000,
  durationS: 60,
  viaPoints: [] as [number, number][],
})

function stateOf(): any {
  return {
    // Present on purpose: none of these may survive a snapshot.
    map: { fake: 'map handle' },
    markers: [{ stops: [], pois: [] }],
    rideId: 41,
    saving: false,
    focus: 2,
    moment: 1000,
    addMode: 'poi',
    dirty: true,
    layersReady: true,
    layerCount: 3,
    legSeq: [[1, 2]],
    meta: { title: 'Three days', description: 'd', visibility: 'private', external_url: '' },
    routes: [
      {
        title: 'Day 1',
        color: '#cc0000',
        startAt: '2026-08-01T09:00:00Z',
        endAt: '2026-08-01T17:00:00Z',
        endManual: true,
        stops: [
          { lat: 37, lng: -122, name: 'A', description: '', roles: ['start'], durationMin: null },
          { lat: 38, lng: -121, name: 'B', description: '', roles: ['gas', 'food'], durationMin: 20 },
        ],
        pois: [{ lat: 37.5, lng: -121.5, name: 'View', description: '', roles: ['scenic'], durationMin: null }],
        legs: [leg(500)],
      },
    ],
  }
}

beforeEach(load)

describe('what a snapshot carries', () => {
  it('keeps meta and routes', () => {
    const s = stateOf()
    const snap: Snap = H.snapshot(s)
    expect(snap.meta.title).toBe('Three days')
    expect(snap.routes).toHaveLength(1)
    expect(snap.routes[0].stops.map((x: any) => x.name)).toEqual(['A', 'B'])
  })

  // payload() drops this, so deriving the snapshot from payload() would lose
  // a hand-typed end time on every undo — silently, and only for the rider
  // who bothered to set one.
  it('keeps endManual, which payload() does not carry', () => {
    expect(H.snapshot(stateOf()).routes[0].endManual).toBe(true)
  })

  it('carries no UI state, identity or map handles', () => {
    const snap = H.snapshot(stateOf())
    for (const k of ['map', 'markers', 'rideId', 'saving', 'focus', 'moment', 'addMode', 'dirty', 'legSeq']) {
      expect(snap, `snapshot must not carry ${k}`).not.toHaveProperty(k)
    }
  })
})

describe('what a snapshot copies and what it shares', () => {
  // The memory budget rests on this one identity. Sharing geometry is what
  // makes a 100-step stack ~50 object copies instead of ~19,000 coordinate
  // pairs per step; if this ever becomes a deep copy, a long multi-day ride
  // will eat hundreds of megabytes and nothing will say so.
  it('shares leg geometry by reference, because it is never mutated in place', () => {
    const s = stateOf()
    const snap = H.snapshot(s)
    expect(snap.routes[0].legs[0].geometry).toBe(s.routes[0].legs[0].geometry)
  })

  // Regression: viaPoints was shared by reference because nothing wrote vias.
  // Drag-to-shape splices into it, so an undo of a shaping point put the via
  // back on the map while the geometry correctly reverted — state and markers
  // disagreeing, with no error anywhere.
  it('copies viaPoints, which drag-to-shape splices in place', () => {
    const s = stateOf()
    const snap = H.snapshot(s)
    expect(snap.routes[0].legs[0].viaPoints).not.toBe(s.routes[0].legs[0].viaPoints)
    s.routes[0].legs[0].viaPoints.splice(0, 0, [-122.05, 37.05])
    expect(snap.routes[0].legs[0].viaPoints).toEqual([])
  })

  it('copies the legs array and each leg object, which are mutated in place', () => {
    const s = stateOf()
    const snap = H.snapshot(s)
    expect(snap.routes[0].legs).not.toBe(s.routes[0].legs)
    expect(snap.routes[0].legs[0]).not.toBe(s.routes[0].legs[0])
    // viaPoints is reassigned wholesale on drag; a shared leg object would
    // let that reach into history.
    s.routes[0].legs[0].viaPoints = [[-121.5, 37.5]]
    expect(snap.routes[0].legs[0].viaPoints).toEqual([])
  })

  // The asymmetry that makes this file worth having. geometry is immutable by
  // convention; roles is not — the row UI splices and pushes it in place.
  it('copies roles arrays, which ARE mutated in place', () => {
    const s = stateOf()
    const snap = H.snapshot(s)
    expect(snap.routes[0].stops[1].roles).not.toBe(s.routes[0].stops[1].roles)
    s.routes[0].stops[1].roles.push('hotel')
    expect(snap.routes[0].stops[1].roles).toEqual(['gas', 'food'])
  })

  it('survives every in-place mutation the builder actually performs', () => {
    const s = stateOf()
    const snap = H.snapshot(s)
    // Each of these mirrors a real site in builder.js.
    s.routes[0].stops.reverse() // reverseDay
    s.routes[0].stops[0].lat = 99 // marker dragend
    s.routes[0].stops[0].name = 'typed' // row input
    s.routes[0].pois.splice(0, 1) // deletePoi
    s.routes[0].legs.splice(0, 1) // deleteStop
    s.meta.title = 'renamed' // ride-title input
    expect(snap.routes[0].stops.map((x: any) => x.name)).toEqual(['A', 'B'])
    expect(snap.routes[0].stops[0].lat).toBe(37)
    expect(snap.routes[0].pois).toHaveLength(1)
    expect(snap.routes[0].legs).toHaveLength(1)
    expect(snap.meta.title).toBe('Three days')
  })
})

describe('restore', () => {
  it('puts the snapshot back', () => {
    const s = stateOf()
    const snap = H.snapshot(s)
    s.routes[0].stops.pop()
    s.meta.title = 'wrong'
    H.restore(s, snap)
    expect(s.routes[0].stops).toHaveLength(2)
    expect(s.meta.title).toBe('Three days')
  })

  // The async leg completion guards on `state.routes[r] !== route`. Fresh
  // objects make an in-flight routing response drop itself; handing back the
  // stored reference lets a response that left before the undo land after it,
  // writing a leg the rider already took back.
  it('builds fresh route objects rather than aliasing the snapshot', () => {
    const s = stateOf()
    const snap = H.snapshot(s)
    const beforeRoute = s.routes[0]
    H.restore(s, snap)
    expect(s.routes[0]).not.toBe(beforeRoute)
    expect(s.routes[0]).not.toBe(snap.routes[0])
    expect(s.routes[0].stops[0]).not.toBe(snap.routes[0].stops[0])
  })

  it('can be restored twice without the first restore aliasing the second', () => {
    const s = stateOf()
    const snap = H.snapshot(s)
    H.restore(s, snap)
    s.routes[0].stops[0].name = 'clobbered'
    H.restore(s, snap)
    expect(s.routes[0].stops[0].name).toBe('A')
  })

  it('resets legSeq, so nothing in flight is let through', () => {
    const s = stateOf()
    H.restore(s, H.snapshot(s))
    expect(s.legSeq).toEqual([])
  })

  it('leaves the map handle and markers alone for the renderer to rebuild', () => {
    const s = stateOf()
    const map = s.map
    H.restore(s, H.snapshot(s))
    expect(s.map).toBe(map)
  })
})

describe('the undo stack', () => {
  it('undoes and redoes in order', () => {
    const h = H.createHistory()
    h.push('a', 'add stop')
    h.push('b', 'move stop')
    expect(h.undo('c')?.snap).toBe('b')
    expect(h.undo('b')?.snap).toBe('a')
    expect(h.canUndo()).toBe(false)
    expect(h.redo('a')?.snap).toBe('b')
  })

  it('reports nothing to undo on an untouched ride', () => {
    const h = H.createHistory()
    expect(h.canUndo()).toBe(false)
    expect(h.undo('x')).toBe(null)
    expect(h.redo('x')).toBe(null)
  })

  it('abandons the redo branch once you edit after undoing', () => {
    const h = H.createHistory()
    h.push('a', 'one')
    h.push('b', 'two')
    h.undo('c')
    expect(h.canRedo()).toBe(true)
    h.push('d', 'three')
    expect(h.canRedo()).toBe(false)
  })

  it('drops the oldest step past the cap', () => {
    const h = H.createHistory({ max: 3 })
    for (const x of ['a', 'b', 'c', 'd', 'e']) h.push(x, x)
    expect(h.depth()).toBe(3)
    expect(h.undo('now')?.snap).toBe('e')
  })

  it('defaults to 100 steps', () => {
    expect(H.DEFAULT_MAX).toBe(100)
    const h = H.createHistory()
    for (let i = 0; i < 150; i++) h.push(i, 'edit')
    expect(h.depth()).toBe(100)
  })

  it('names the next step for the button tooltip', () => {
    const h = H.createHistory()
    h.push('a', 'move stop')
    expect(h.undoLabel()).toBe('move stop')
    h.undo('b')
    expect(h.redoLabel()).toBe('move stop')
  })

  // Without this, typing "Bodega Bay" is eleven undo steps and the stack is
  // full of single letters.
  it('folds a run of edits to one field into a single step', () => {
    const h = H.createHistory()
    h.push('a', 'rename', 'name:0:0')
    h.push('b', 'rename', 'name:0:0')
    h.push('c', 'rename', 'name:0:0')
    expect(h.depth()).toBe(1)
  })

  it('starts a new step when the field changes', () => {
    const h = H.createHistory()
    h.push('a', 'rename', 'name:0:0')
    h.push('b', 'rename', 'name:0:1')
    expect(h.depth()).toBe(2)
  })

  it('starts a new step after a blur breaks the run', () => {
    const h = H.createHistory()
    h.push('a', 'rename', 'name:0:0')
    h.breakCoalesce()
    h.push('b', 'rename', 'name:0:0')
    expect(h.depth()).toBe(2)
  })
})

describe('drafts', () => {
  it('round-trips through storage', () => {
    const s = stateOf()
    expect(H.Draft.write(41, s)).toBe(true)
    const back = H.Draft.read(41)
    expect(back.rideId).toBe(41)
    expect(back.meta.title).toBe('Three days')
    expect(back.routes[0].stops.map((x: any) => x.name)).toEqual(['A', 'B'])
  })

  it('keys a never-saved ride separately from a saved one', () => {
    expect(H.Draft.key(null)).toBe('tankbag.builderDraft.new')
    expect(H.Draft.key(41)).toBe('tankbag.builderDraft.41')
    H.Draft.write(null, stateOf())
    H.Draft.write(41, stateOf())
    expect(H.Draft.read(null)).not.toBe(null)
    expect(H.Draft.read(41)).not.toBe(null)
  })

  // The quota decision. Geometry is the bulk of a ride and the router can
  // rebuild it; the stops cannot be rebuilt from anywhere.
  it('stores stops but not leg geometry, and says so', () => {
    H.Draft.write(41, stateOf())
    const back = H.Draft.read(41)
    expect(back.legsStripped).toBe(true)
    expect(back.routes[0].legs[0]).not.toHaveProperty('geometry')
    expect(back.routes[0].legs[0].distanceM).toBe(1000)
  })

  it('is small enough to matter — a 500-point leg does not go to disk', () => {
    const s = stateOf()
    H.Draft.write(41, s)
    const raw = store.getItem('tankbag.builderDraft.41') as string
    // The geometry alone would be several times this.
    expect(raw.length).toBeLessThan(2000)
  })

  it('keeps empty days, which payload() drops', () => {
    const s = stateOf()
    s.routes.push({ title: '', color: '#0000cc', startAt: null, endAt: null, endManual: false, stops: [], pois: [], legs: [] })
    H.Draft.write(41, s)
    expect(H.Draft.read(41).routes).toHaveLength(2)
  })

  it('clears', () => {
    H.Draft.write(41, stateOf())
    H.Draft.clear(41)
    expect(H.Draft.read(41)).toBe(null)
  })

  it('discards a draft written by an older schema rather than guessing', () => {
    store.setItem('tankbag.builderDraft.41', JSON.stringify({ v: 0, savedAt: 1, routes: [] }))
    expect(H.Draft.read(41)).toBe(null)
    expect(store.getItem('tankbag.builderDraft.41')).toBe(null)
  })

  it('discards unparseable junk instead of leaving it in the quota forever', () => {
    store.setItem('tankbag.builderDraft.41', 'not json')
    expect(H.Draft.read(41)).toBe(null)
    expect(store.getItem('tankbag.builderDraft.41')).toBe(null)
  })

  it('prunes to the newest N', () => {
    for (let i = 1; i <= 6; i++) H.Draft.write(i, stateOf(), i * 1000)
    expect(H.Draft.prune(3)).toBe(3)
    expect(H.Draft.list()).toHaveLength(3)
    expect(H.Draft.read(6)).not.toBe(null)
    expect(H.Draft.read(1)).toBe(null)
  })

  it('lists newest first', () => {
    H.Draft.write(1, stateOf(), 1000)
    H.Draft.write(2, stateOf(), 3000)
    H.Draft.write(3, stateOf(), 2000)
    expect(H.Draft.list().map((d: any) => d.rideId)).toEqual([2, 3, 1])
  })

  it('prunes and retries when storage is full', () => {
    for (let i = 1; i <= 5; i++) H.Draft.write(i, stateOf(), i * 1000)
    let first = true
    store._failOn = () => {
      if (first) {
        first = false
        return true
      }
      return false
    }
    expect(H.Draft.write(99, stateOf(), 9000)).toBe(true)
    expect(H.Draft.read(99)).not.toBe(null)
  })

  // A draft the rider believes exists and does not is worse than no draft, so
  // a hard failure has to be reportable rather than swallowed.
  it('reports failure when even pruning cannot make room', () => {
    store._failOn = () => true
    expect(H.Draft.write(41, stateOf())).toBe(false)
  })

  it('degrades to "no draft" when storage throws, rather than taking the builder down', () => {
    const win: Record<string, unknown> = {
      localStorage: {
        get length(): number {
          throw new Error('private mode')
        },
        getItem() {
          throw new Error('private mode')
        },
        setItem() {
          throw new Error('private mode')
        },
        removeItem() {
          throw new Error('private mode')
        },
        key() {
          throw new Error('private mode')
        },
      },
    }
    new Function('window', readFileSync('public/js/builder-history.js', 'utf8'))(win)
    const T = (win as any).TBHistory
    expect(() => T.Draft.read(41)).not.toThrow()
    expect(T.Draft.read(41)).toBe(null)
    expect(T.Draft.write(41, stateOf())).toBe(false)
    expect(T.Draft.list()).toEqual([])
  })

  // A first save turns "new" into a ride id. Without this the orphan offers
  // itself the next time a new ride is started.
  it('adopts the new-ride draft under the id assigned by a first save', () => {
    H.Draft.write(null, stateOf())
    expect(H.Draft.adopt(77)).toBe(true)
    expect(H.Draft.read(null)).toBe(null)
    const moved = H.Draft.read(77)
    expect(moved.rideId).toBe(77)
    expect(moved.meta.title).toBe('Three days')
  })
})
