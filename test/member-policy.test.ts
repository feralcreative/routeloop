// Who may do what to a roster.
//
// The rules that matter are the two that say NO to somebody who obviously
// outranks the person they are acting on: an owner cannot RSVP on a rider's
// behalf, and an owner cannot remove themselves. Both are easy to "fix" into a
// bug — the first turns the roster from a record of what people said into a
// record of what the organizer wishes they had said, and the second leaves a
// ride nobody can administer.
import { describe, expect, it } from 'vitest'
import { canInvite, canRemove, canRsvp, canVote, isComing, RSVP_LABELS, type MemberFields } from '../src/members/policy'
import { rsvpEnum } from '../src/db/schema'

const OWNER = 1
const RIDER = 2
const OTHER = 3

const member = (over: Partial<MemberFields> = {}): MemberFields => ({
  riderId: RIDER,
  role: 'rider',
  rsvp: 'invited',
  ...over,
})
const ownerRow = member({ riderId: OWNER, role: 'owner', rsvp: 'going' })

describe('isComing', () => {
  it('counts a maybe, because a maybe is still a bike and a bed', () => {
    expect(isComing(member({ rsvp: 'maybe' }))).toBe(true)
    expect(isComing(member({ rsvp: 'invited' }))).toBe(true)
    expect(isComing(member({ rsvp: 'going' }))).toBe(true)
    expect(isComing(member({ rsvp: 'declined' }))).toBe(false)
  })
})

describe('canInvite', () => {
  it('is the owner only', () => {
    expect(canInvite('owner')).toBe(true)
    expect(canInvite('rider')).toBe(false)
    expect(canInvite(null)).toBe(false)
  })
})

describe('canRemove', () => {
  it('lets the owner remove a rider', () => {
    expect(canRemove(OWNER, 'owner', member())).toBe(true)
  })

  it('lets a rider remove themselves, which is leaving', () => {
    expect(canRemove(RIDER, 'rider', member())).toBe(true)
  })

  it('refuses a rider removing somebody else', () => {
    expect(canRemove(OTHER, 'rider', member())).toBe(false)
  })

  // A ride with no owner has nobody who can invite, resolve or delete it.
  it('refuses the owner removing themselves, even though they outrank everyone', () => {
    expect(canRemove(OWNER, 'owner', ownerRow)).toBe(false)
  })

  it('refuses a non-member entirely', () => {
    expect(canRemove(OTHER, null, member())).toBe(false)
  })
})

describe('canRsvp', () => {
  it('is yours only', () => {
    expect(canRsvp(RIDER, member())).toBe(true)
    expect(canRsvp(OTHER, member())).toBe(false)
  })

  // The one an owner would expect to be allowed, and the roster stops meaning
  // anything the moment it is.
  it('refuses the owner answering for somebody else', () => {
    expect(canRsvp(OWNER, member())).toBe(false)
  })
})

describe('canVote', () => {
  it('is any member and nobody else', () => {
    expect(canVote('owner')).toBe(true)
    expect(canVote('rider')).toBe(true)
    // Never the public share link.
    expect(canVote(null)).toBe(false)
  })

  it('does not depend on the RSVP, so a declined rider keeps their vote', () => {
    expect(canVote('rider')).toBe(true)
  })
})

// A state with no label renders as its identifier to a rider — the same failure
// test/feedback-status-labels.test.ts exists to prevent one enum over.
describe('RSVP_LABELS', () => {
  it('has copy for every member of the enum', () => {
    expect(Object.keys(RSVP_LABELS).sort()).toEqual([...rsvpEnum.enumValues].sort())
    for (const v of Object.values(RSVP_LABELS)) expect(v.length).toBeGreaterThan(0)
  })
})
