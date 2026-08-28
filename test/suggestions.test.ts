// A suggestion is a proposal against a day AS IT WAS.
//
// The rule under the most pressure here is that STALENESS IS DERIVED. Nothing
// sweeps, nothing is invalidated on save, and a day edited and then edited back
// correctly stops being stale — which is the case a stored flag gets wrong and
// the reason this is a fingerprint comparison rather than a column.
import { describe, expect, it } from 'vitest'
import {
  canDecide,
  canPropose,
  canWithdraw,
  dayFingerprint,
  isActionable,
  suggestionState,
  type DayShape,
  type SuggestionFields,
} from '../src/suggestions/policy'
import type { MemberFields } from '../src/members/policy'

const AUTHOR = 2
const OWNER = 1
const OTHER = 3

const member = (over: Partial<MemberFields> = {}): MemberFields => ({
  riderId: AUTHOR,
  role: 'rider',
  perm: 'suggest',
  rsvp: 'going',
  ...over,
})
const owner = member({ riderId: OWNER, role: 'owner' })

const day = (over: Partial<DayShape> = {}): DayShape => ({
  uid: 'day1',
  points: [
    { uid: 'p1', lng: -122.1, lat: 37.5, kind: 'stop' },
    { uid: 'p2', lng: -121.9, lat: 37.8, kind: 'poi' },
  ],
  ...over,
})

const suggestion = (over: Partial<SuggestionFields> = {}): SuggestionFields => ({
  id: 5,
  authorId: AUTHOR,
  dayUid: 'day1',
  baseFingerprint: dayFingerprint(day()),
  resolvedAt: null,
  outcome: null,
  ...over,
})

describe('dayFingerprint', () => {
  it('is stable for the same day', () => {
    expect(dayFingerprint(day())).toBe(dayFingerprint(day()))
  })

  it('changes when a point moves', () => {
    const moved = day({ points: [{ uid: 'p1', lng: -122.2, lat: 37.5, kind: 'stop' }, day().points[1]] })
    expect(dayFingerprint(moved)).not.toBe(dayFingerprint(day()))
  })

  it('changes when points are reordered', () => {
    expect(dayFingerprint(day({ points: [...day().points].reverse() }))).not.toBe(dayFingerprint(day()))
  })

  it('changes when a point is promoted, because that is a thing worth suggesting', () => {
    const promoted = day({ points: [day().points[0], { ...day().points[1], kind: 'stop' }] })
    expect(dayFingerprint(promoted)).not.toBe(dayFingerprint(day()))
  })

  it('changes when a point is added or removed', () => {
    expect(dayFingerprint(day({ points: [day().points[0]] }))).not.toBe(dayFingerprint(day()))
  })

  // Float noise from a re-route must not invalidate every pending suggestion on
  // the owner's next idle autosave.
  it('ignores movement below about a meter', () => {
    const jittered = day({
      points: day().points.map((p) => ({ ...p, lng: p.lng + 0.0000004, lat: p.lat - 0.0000003 })),
    })
    expect(dayFingerprint(jittered)).toBe(dayFingerprint(day()))
  })

  // A rename or a recolor is not something a suggestion is about, and folding
  // either in would make it invalidate proposals it has nothing to do with.
  it('is not affected by anything outside the points', () => {
    expect(dayFingerprint({ ...day(), uid: 'other' })).toBe(dayFingerprint(day()))
  })
})

describe('suggestionState', () => {
  it('is pending while the day still looks the way it did', () => {
    expect(suggestionState(suggestion(), dayFingerprint(day()))).toBe('pending')
  })

  it('is stale once the day has changed', () => {
    const moved = day({ points: [day().points[0]] })
    expect(suggestionState(suggestion(), dayFingerprint(moved))).toBe('stale')
  })

  // Nothing to apply it to.
  it('is stale when the day is gone entirely', () => {
    expect(suggestionState(suggestion(), null)).toBe('stale')
  })

  // The case a stored flag gets wrong, and the reason this is derived.
  it('goes back to pending if the day is edited and then edited BACK', () => {
    const s = suggestion()
    const moved = day({ points: [day().points[0]] })
    expect(suggestionState(s, dayFingerprint(moved))).toBe('stale')
    expect(suggestionState(s, dayFingerprint(day()))).toBe('pending')
  })

  it('reports the outcome once resolved, whatever the day now looks like', () => {
    const done = suggestion({ resolvedAt: new Date(), outcome: 'accepted' })
    expect(suggestionState(done, null)).toBe('accepted')
    expect(suggestionState(done, dayFingerprint(day()))).toBe('accepted')
  })
})

describe('isActionable', () => {
  it('is pending and nothing else', () => {
    expect(isActionable('pending')).toBe(true)
    for (const s of ['stale', 'accepted', 'discarded', 'withdrawn'] as const) {
      expect(isActionable(s)).toBe(false)
    }
  })
})

describe('canPropose', () => {
  it('needs the suggest rung', () => {
    expect(canPropose(member({ perm: 'comment' }))).toBe(false)
    expect(canPropose(member({ perm: 'suggest' }))).toBe(true)
    expect(canPropose(owner)).toBe(true)
    expect(canPropose(null)).toBe(false)
  })
})

// Accepting is deciding whose version of the ride is the ride, which is what
// owning it means. An editor who agrees can simply make the change.
describe('canDecide', () => {
  it('is the owner, and NOT an edit-level rider', () => {
    expect(canDecide(owner)).toBe(true)
    expect(canDecide(member({ perm: 'edit' }))).toBe(false)
    expect(canDecide(null)).toBe(false)
  })
})

describe('canWithdraw', () => {
  it('is the author or an owner, and nobody else', () => {
    expect(canWithdraw(member(), suggestion())).toBe(true)
    expect(canWithdraw(owner, suggestion())).toBe(true)
    expect(canWithdraw(member({ riderId: OTHER, perm: 'edit' }), suggestion())).toBe(false)
    expect(canWithdraw(null, suggestion())).toBe(false)
  })
})
