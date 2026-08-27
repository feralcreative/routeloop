// The follow rules. Pure, so no database — the house split, ./policy.ts vs
// ./service.ts.
import { describe, expect, it } from 'vitest'
import { canFollow, canUnfollow, followView, isFollowable } from '../src/follows/policy'

const base = { viewerId: 1, targetId: 2, blocked: false, already: false }

describe('followView', () => {
  it('is following when a row exists and none when it does not', () => {
    expect(followView({ id: 9 })).toBe('following')
    expect(followView(null)).toBe('none')
    expect(followView(undefined)).toBe('none')
  })
})

describe('canFollow', () => {
  it('allows a plain follow', () => {
    expect(canFollow(base)).toBe(true)
  })

  it('refuses following yourself', () => {
    expect(canFollow({ ...base, targetId: 1 })).toBe(false)
  })

  it('refuses when already following, so a second press is a no-op', () => {
    expect(canFollow({ ...base, already: true })).toBe(false)
  })

  // THE ONE THAT MATTERS. `blocked` is either direction, and the second half is
  // the load-bearing one: a rider who blocked somebody must not be followed by
  // them, or the block leaves the blocked rider watching their feed.
  it('refuses when either rider has blocked the other', () => {
    expect(canFollow({ ...base, blocked: true })).toBe(false)
  })
})

describe('canUnfollow', () => {
  it('needs an existing follow', () => {
    expect(canUnfollow('following')).toBe(true)
    expect(canUnfollow('none')).toBe(false)
  })

  // Deliberately not gated on the block, unlike friends/policy.ts's canRemove,
  // where a BLOCKED rider may not remove the row. Opposite answers because
  // there the row IS the block and here it is not.
  it('does not depend on a block', () => {
    expect(canUnfollow('following')).toBe(true)
  })
})

describe('isFollowable', () => {
  it('takes an active rider who is not leaving', () => {
    expect(isFollowable({ status: 'active', deletionRequestedAt: null })).toBe(true)
  })

  it.each([
    ['pending', null],
    ['blocked', null],
  ] as const)('refuses a %s account', (status, at) => {
    expect(isFollowable({ status, deletionRequestedAt: at })).toBe(false)
  })

  it('refuses a rider who has asked to leave', () => {
    expect(isFollowable({ status: 'active', deletionRequestedAt: new Date() })).toBe(false)
  })
})
