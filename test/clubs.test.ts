import { describe, expect, it } from 'vitest'
import { canEdit, canLeave, canManageRoster, canRemove, canRequest, cleanName, isPosition } from '../src/clubs/policy'

const managed = { managerId: 1 }
const ownerless = { managerId: null }

describe('clubs: who is in is the manager’s, what it says is everyone’s (#182)', () => {
  it('lets every member edit, and a non-member or a request not', () => {
    expect(canEdit(managed, 2, 'member')).toBe(true)
    expect(canEdit(managed, 1, 'none')).toBe(true)
    expect(canEdit(managed, 3, 'requested')).toBe(false)
    expect(canEdit(managed, 3, 'none')).toBe(false)
  })

  it('gives the roster to the manager alone, and never to a title', () => {
    expect(canManageRoster(managed, 1)).toBe(true)
    expect(canManageRoster(managed, 2)).toBe(false)
    expect(canRemove(managed, 1, 2)).toBe(true)
    expect(canRemove(managed, 1, 1)).toBe(false)
    expect(canRemove(managed, 2, 3)).toBe(false)
  })

  it('admits nobody to an ownerless club, but anyone may still leave it', () => {
    expect(canRequest(ownerless, 2, 'none')).toBe(false)
    expect(canRequest(managed, 2, 'none')).toBe(true)
    expect(canRequest(managed, 2, 'requested')).toBe(false)
    expect(canLeave(ownerless, 2, 'member')).toBe(true)
    expect(canLeave(managed, 2, 'requested')).toBe(true)
    expect(canLeave(managed, 1, 'member')).toBe(false)
    expect(canEdit(ownerless, 2, 'member')).toBe(true)
  })

  it('accepts only the seven positions and cleans names', () => {
    expect(isPosition('road_captain')).toBe(true)
    expect(isPosition('founder')).toBe(false)
    expect(cleanName('  Bay   Area  ', 80)).toBe('Bay Area')
    expect(cleanName('   ', 80)).toBeNull()
  })
})
