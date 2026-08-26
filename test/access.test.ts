// The visibility table, exhaustively.
//
// Exhaustive rather than illustrative on purpose: this is the rule that decides
// who can read a rider's ride, the four levels times five viewer kinds is
// twenty cases, and twenty cases is small enough that there is no excuse for
// spot-checking. A leak here is not a bug report, it is a rider's private ride
// on somebody else's screen.
//
// The cases that matter most are the ones that are true only because of a
// grant — a friend seeing 'friends', a member seeing 'private' — because those
// are the two answers that were "no" for every viewer before this landed.
import { describe, expect, it } from 'vitest'
import { canClone, canView, isListed, isSharedCacheable, type ViewableRide, type Viewer } from '../src/access/policy'
import type { RideVisibility } from '../src/db/schema'

const OWNER = 1
const FRIEND = 2
const STRANGER = 3

const ride = (visibility: RideVisibility): ViewableRide => ({ ownerId: OWNER, visibility })

const anon: Viewer = null
const owner: Viewer = { id: OWNER, status: 'active' }
const friend: Viewer = { id: FRIEND, status: 'active' }
const stranger: Viewer = { id: STRANGER, status: 'active' }
const pending: Viewer = { id: STRANGER, status: 'pending' }

const LEVELS: RideVisibility[] = ['public', 'unlisted', 'friends', 'private']

describe('canView', () => {
  it('lets the owner see every level', () => {
    for (const v of LEVELS) expect(canView(ride(v), owner)).toBe(true)
  })

  it('lets anyone at all see public and unlisted', () => {
    for (const v of ['public', 'unlisted'] as const) {
      expect(canView(ride(v), anon)).toBe(true)
      expect(canView(ride(v), stranger)).toBe(true)
      expect(canView(ride(v), pending)).toBe(true)
    }
  })

  it('refuses friends and private to a stranger and to anonymous', () => {
    for (const v of ['friends', 'private'] as const) {
      expect(canView(ride(v), anon)).toBe(false)
      expect(canView(ride(v), stranger)).toBe(false)
    }
  })

  it('opens friends to a friend of the owner and nothing else', () => {
    expect(canView(ride('friends'), friend, { isFriendOfOwner: true })).toBe(true)
    // The grant is specific to `friends`. It does not reach private.
    expect(canView(ride('private'), friend, { isFriendOfOwner: true })).toBe(false)
  })

  it('opens every level to a member, private included', () => {
    for (const v of LEVELS) expect(canView(ride(v), stranger, { isMember: true })).toBe(true)
  })

  // The whole reason isRider() exists. A rider who has signed in but has not
  // been approved must not collect grants — and the grant is the only thing
  // that would have let them past, so this is the case that would leak.
  it('gives a pending or blocked rider no grant', () => {
    expect(canView(ride('friends'), { id: FRIEND, status: 'pending' }, { isFriendOfOwner: true })).toBe(false)
    expect(canView(ride('private'), { id: STRANGER, status: 'blocked' }, { isMember: true })).toBe(false)
  })

  // Today's behavior, stated as a test: with no grants supplied, the four-level
  // helper answers exactly what the three hand-rolled copies of this gate
  // answered before it replaced them. This is what makes the sweep reviewable.
  it('behaves exactly as the old gate did when no grants are passed', () => {
    for (const v of LEVELS) {
      const old = v === 'public' || v === 'unlisted'
      expect(canView(ride(v), stranger)).toBe(old)
      expect(canView(ride(v), anon)).toBe(old)
    }
  })
})

describe('isListed', () => {
  it('lists public and nothing else', () => {
    expect(isListed('public')).toBe(true)
    // Unlisted is the level whose entire meaning is this line.
    expect(isListed('unlisted')).toBe(false)
    expect(isListed('friends')).toBe(false)
    expect(isListed('private')).toBe(false)
  })
})

describe('isSharedCacheable', () => {
  it('allows a shared cache for public only', () => {
    expect(isSharedCacheable('public')).toBe(true)
    for (const v of ['unlisted', 'friends', 'private'] as const) expect(isSharedCacheable(v)).toBe(false)
  })
})

describe('canClone', () => {
  it('lets a signed-in rider clone a public ride', () => {
    expect(canClone(ride('public'), stranger)).toBe(true)
  })

  it('refuses anonymous and unapproved riders', () => {
    expect(canClone(ride('public'), anon)).toBe(false)
    expect(canClone(ride('public'), pending)).toBe(false)
  })

  it('refuses the owner their own ride, who has Edit instead', () => {
    expect(canClone(ride('public'), owner)).toBe(false)
  })

  it('lets a friend clone a friends-visible ride', () => {
    expect(canClone(ride('friends'), friend, { isFriendOfOwner: true })).toBe(true)
    expect(canClone(ride('friends'), stranger)).toBe(false)
  })

  // The deliberate asymmetry: viewable is not clonable. Handing someone a link
  // is not handing them a copy.
  it('refuses a clone of an unlisted ride the viewer can see', () => {
    expect(canView(ride('unlisted'), stranger)).toBe(true)
    expect(canClone(ride('unlisted'), stranger)).toBe(false)
  })

  it('refuses a clone of a private ride even to a member who can see it', () => {
    expect(canView(ride('private'), stranger, { isMember: true })).toBe(true)
    expect(canClone(ride('private'), stranger, { isMember: true })).toBe(false)
  })
})
