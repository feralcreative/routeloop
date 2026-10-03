import { describe, expect, it } from 'vitest'
import { canFollow, canUnfollow, followView, showsFollowControl } from '../src/follows/policy'

describe('following and friendship are a ladder (#180)', () => {
  it('reads a friend as followed, whether or not a follow row exists', () => {
    expect(followView(null, true)).toBe('friends')
    expect(followView({ id: 1 }, true)).toBe('friends')
    expect(followView({ id: 1 }, false)).toBe('following')
    expect(followView(null, false)).toBe('none')
  })

  it('offers no follow control and no unfollow beside a friend', () => {
    expect(showsFollowControl('friends')).toBe(false)
    expect(canUnfollow('friends')).toBe(false)
    expect(showsFollowControl('following')).toBe(true)
    expect(canUnfollow('following')).toBe(true)
  })

  it('refuses a follow that a friendship already implies', () => {
    expect(canFollow({ viewerId: 1, targetId: 2, blocked: false, already: true })).toBe(false)
    expect(canFollow({ viewerId: 1, targetId: 2, blocked: false, already: false })).toBe(true)
  })
})
