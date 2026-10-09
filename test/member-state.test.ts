// The organizer's flow (#428): who is a member, who is only planned with, and what
// Send does with each draft.
//
// The case that matters most is the first: a DRAFT IS NOT A MEMBER. An organizer
// adds the people they expect and nobody is told anything until Send — so a draft
// that could see the ride, RSVP, or be counted as a member is the leak this flow
// exists to prevent.
import { describe, expect, it } from 'vitest'
import {
  canDecline,
  canRsvp,
  isLiveMember,
  isPlanned,
  sendPlanFor,
  STATE_LABELS,
  type MemberFields,
} from '../src/members/policy'
import { memberStateEnum, type MemberState } from '../src/db/schema'

const row = (state?: MemberState, role: 'owner' | 'rider' = 'rider'): MemberFields => ({
  riderId: 7,
  role,
  perm: 'suggest',
  rsvp: 'invited',
  ...(state ? { state } : {}),
})

describe('isLiveMember', () => {
  it('is true for an invited row, and for a row that predates the state column', () => {
    expect(isLiveMember(row('invited'))).toBe(true)
    expect(isLiveMember(row())).toBe(true)
  })

  it('is false for every other state, and for nobody', () => {
    for (const s of ['draft', 'pending_friend', 'pending_signup', 'declined'] as const) {
      expect(isLiveMember(row(s))).toBe(false)
    }
    expect(isLiveMember(null)).toBe(false)
  })
})

describe('isPlanned', () => {
  it('plans with everybody but a declined invitation', () => {
    for (const s of memberStateEnum.enumValues) expect(isPlanned(row(s))).toBe(s !== 'declined')
  })
})

describe('STATE_LABELS', () => {
  it('labels every state, so none renders as its identifier', () => {
    for (const s of memberStateEnum.enumValues) expect(STATE_LABELS[s]).toMatch(/^[A-Z]/)
  })
})

describe('sendPlanFor', () => {
  const base = { state: 'draft' as MemberState, placeholder: false, email: null, isFriend: false, isGuide: false }

  it('adds a friend straight onto the ride', () => {
    expect(sendPlanFor({ ...base, isFriend: true })).toBe('invite')
  })

  it('sends somebody on Routeloop who is not a friend a friend request first', () => {
    expect(sendPlanFor(base)).toBe('friend-request')
  })

  it('adds a guide rider without a friendship, which a guide cannot have', () => {
    expect(sendPlanFor({ ...base, isGuide: true })).toBe('invite')
  })

  it('emails a placeholder its link, and holds one back that has no address', () => {
    expect(sendPlanFor({ ...base, placeholder: true, email: 'sam@example.com' })).toBe('email')
    expect(sendPlanFor({ ...base, placeholder: true })).toBe('needs-email')
  })

  it('does nothing with a row that has already gone out', () => {
    for (const s of ['pending_friend', 'pending_signup', 'invited', 'declined'] as const) {
      expect(sendPlanFor({ ...base, state: s, isFriend: true })).toBe('skip')
    }
  })
})

describe('canRsvp and canDecline', () => {
  it('lets a member answer and decline for themselves', () => {
    expect(canRsvp(7, row('invited'))).toBe(true)
    expect(canDecline(7, row('invited'))).toBe(true)
  })

  it('refuses a draft both, because nobody has asked them anything', () => {
    expect(canRsvp(7, row('draft'))).toBe(false)
    expect(canDecline(7, row('draft'))).toBe(false)
  })

  it('never lets somebody decline for somebody else, or an owner decline their own ride', () => {
    expect(canDecline(8, row('invited'))).toBe(false)
    expect(canDecline(7, row('invited', 'owner'))).toBe(false)
  })

  it('does not let a declined invitation be declined again', () => {
    expect(canDecline(7, row('declined'))).toBe(false)
  })
})
