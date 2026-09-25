import { describe, expect, it } from 'vitest'
import {
  canSeePaddock,
  DEFAULT_PROFILE_VISIBILITY,
  profileDepth,
  toProfileVisibility,
} from '../src/profiles/policy'
import { profileVisibilityEnum } from '../src/db/schema'

const OWNER = 7
const rider = { id: 9, status: 'active' }
const pending = { id: 9, status: 'pending' }
const self = { id: OWNER, status: 'active' }

describe('profileDepth', () => {
  it('shows everything to anyone on a public profile', () => {
    expect(profileDepth('public', OWNER, null)).toBe('full')
    expect(profileDepth('public', OWNER, rider)).toBe('full')
  })

  it('shows a members profile only to an active signed-in rider', () => {
    expect(profileDepth('members', OWNER, null)).toBe('minimal')
    expect(profileDepth('members', OWNER, pending)).toBe('minimal')
    expect(profileDepth('members', OWNER, rider)).toBe('full')
  })

  it('shows a hidden profile to nobody but its owner', () => {
    expect(profileDepth('hidden', OWNER, null)).toBe('minimal')
    expect(profileDepth('hidden', OWNER, rider)).toBe('minimal')
    expect(profileDepth('hidden', OWNER, self)).toBe('full')
  })
})

describe('canSeePaddock', () => {
  it('needs both the share switch and a full view', () => {
    expect(canSeePaddock('public', false, OWNER, rider)).toBe(false)
    expect(canSeePaddock('public', true, OWNER, null)).toBe(true)
    expect(canSeePaddock('members', true, OWNER, null)).toBe(false)
    expect(canSeePaddock('hidden', true, OWNER, rider)).toBe(false)
  })

  it('always lets the owner see their own bikes', () => {
    expect(canSeePaddock('hidden', false, OWNER, self)).toBe(true)
  })
})

describe('the stored value', () => {
  it('falls back to the default for anything unreadable', () => {
    expect(toProfileVisibility('everyone')).toBe(DEFAULT_PROFILE_VISIBILITY)
    expect(toProfileVisibility(undefined)).toBe(DEFAULT_PROFILE_VISIBILITY)
    expect(toProfileVisibility('hidden')).toBe('hidden')
  })

  it('matches the enum the column is built from', () => {
    expect(profileVisibilityEnum.enumValues).toEqual(['public', 'members', 'hidden'])
  })
})
