// Friendships, from both sides of a row that has no sides.
//
// The canonical ordering is the thing under test everywhere here: one row per
// pair means every rule has to read `requested_by` or `blocked_by` to work out
// who is who, and getting that backwards produces the two worst outcomes this
// module can have — a request that accepts itself, and a block the blocked
// rider can lift.
import { describe, expect, it } from 'vitest'
import {
  areFriends,
  canAccept,
  canBlock,
  canRemove,
  canRequest,
  canUnblock,
  friendView,
  isBlocked,
  pairOf,
  SelfFriendshipError,
  type FriendshipFields,
  type FriendView,
} from '../src/friends/policy'

const LOW = 7
const HIGH = 42

const row = (over: Partial<FriendshipFields> = {}): FriendshipFields => ({
  riderA: LOW,
  riderB: HIGH,
  status: 'pending',
  requestedBy: LOW,
  blockedBy: null,
  ...over,
})

describe('pairOf', () => {
  it('puts the lower id first whichever way round it is asked', () => {
    expect(pairOf(LOW, HIGH)).toEqual({ riderA: LOW, riderB: HIGH })
    expect(pairOf(HIGH, LOW)).toEqual({ riderA: LOW, riderB: HIGH })
  })

  it('refuses a rider befriending themselves', () => {
    expect(() => pairOf(LOW, LOW)).toThrow(SelfFriendshipError)
  })
})

describe('friendView', () => {
  it('reads no row as no relationship', () => {
    expect(friendView(null, LOW)).toBe('none')
    expect(friendView(undefined, LOW)).toBe('none')
  })

  // The same row, read from each end. This is the whole translation problem in
  // one test.
  it('reads one pending row as sent by one rider and incoming to the other', () => {
    const r = row({ requestedBy: LOW })
    expect(friendView(r, LOW)).toBe('sent')
    expect(friendView(r, HIGH)).toBe('incoming')
  })

  it('does not depend on which column a rider is in', () => {
    const r = row({ requestedBy: HIGH })
    expect(friendView(r, HIGH)).toBe('sent')
    expect(friendView(r, LOW)).toBe('incoming')
  })

  it('reads accepted as friends from both ends', () => {
    const r = row({ status: 'accepted' })
    expect(friendView(r, LOW)).toBe('friends')
    expect(friendView(r, HIGH)).toBe('friends')
  })

  it('tells the blocker from the blocked', () => {
    const r = row({ status: 'blocked', blockedBy: HIGH })
    expect(friendView(r, HIGH)).toBe('blocked')
    expect(friendView(r, LOW)).toBe('blocked-by')
  })

  // A row that should not exist. The defensive answer hands neither rider an
  // Unblock button rather than handing it to both.
  it('reads a blocked row with no blocker as blocked-by for everyone', () => {
    const r = row({ status: 'blocked', blockedBy: null })
    expect(friendView(r, LOW)).toBe('blocked-by')
    expect(friendView(r, HIGH)).toBe('blocked-by')
  })
})

const ALL: FriendView[] = ['none', 'sent', 'incoming', 'friends', 'blocked', 'blocked-by']

// Each transition stated as the full set it permits, so adding a state to
// FriendView without deciding what it permits fails here rather than silently
// defaulting to refused.
const only = (fn: (v: FriendView) => boolean, allowed: FriendView[]) =>
  expect(ALL.filter(fn).sort()).toEqual([...allowed].sort())

describe('transitions', () => {
  it('allows a request only where there is no row', () => only(canRequest, ['none']))

  // The one that matters: 'sent' is refused, so replaying the accept endpoint
  // cannot accept your own request.
  it('allows an accept only by the rider who did not ask', () => only(canAccept, ['incoming']))

  it('folds withdraw, decline and unfriend into one rule, and excludes blocked', () =>
    only(canRemove, ['sent', 'incoming', 'friends']))

  it('allows a block from anywhere that is not already blocked, including from nothing', () =>
    only(canBlock, ['none', 'sent', 'incoming', 'friends']))

  it('allows an unblock only by the blocker', () => only(canUnblock, ['blocked']))
})

describe('grants', () => {
  it('grants the friends level on accepted only', () => {
    expect(areFriends(row({ status: 'accepted' }))).toBe(true)
    // A request in flight grants nothing, or asking would be a way of reading.
    expect(areFriends(row({ status: 'pending' }))).toBe(false)
    expect(areFriends(row({ status: 'blocked' }))).toBe(false)
    expect(areFriends(null)).toBe(false)
  })

  it('reads a block as mutual whichever end asked', () => {
    const r = row({ status: 'blocked', blockedBy: HIGH })
    expect(isBlocked(r)).toBe(true)
    expect(areFriends(r)).toBe(false)
  })
})
