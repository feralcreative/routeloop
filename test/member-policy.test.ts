// Who may do what to a roster.
//
// The rules that matter are the two that say NO to somebody who obviously
// outranks the person they are acting on: an owner cannot RSVP on a rider's
// behalf, and an owner cannot remove themselves. Both are easy to "fix" into a
// bug — the first turns the roster from a record of what people said into a
// record of what the organizer wishes they had said, and the second leaves a
// ride nobody can administer.
import { describe, expect, it } from 'vitest'
import {
  atLeast,
  canAdminister,
  canComment,
  canEditAsMember,
  canInvite,
  canRemove,
  canRsvp,
  canSeePerms,
  canSetPerm,
  canSuggest,
  canViewAsMember,
  canVote,
  DEFAULT_PERM,
  isComing,
  PERM_HELP,
  PERM_LABELS,
  PERM_RANK,
  rankOf,
  RSVP_LABELS,
  type MemberFields,
} from '../src/members/policy'
import { ridePermEnum, rsvpEnum } from '../src/db/schema'

const OWNER = 1
const RIDER = 2
const OTHER = 3

const member = (over: Partial<MemberFields> = {}): MemberFields => ({
  riderId: RIDER,
  role: 'rider',
  perm: DEFAULT_PERM,
  rsvp: 'invited',
  ...over,
})
const ownerRow = member({ riderId: OWNER, role: 'owner', rsvp: 'going' })
const otherOwner = member({ riderId: OTHER, role: 'owner', rsvp: 'going' })

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
    expect(canRemove(OWNER, 'owner', member(), 1)).toBe(true)
  })

  it('lets a rider remove themselves, which is leaving', () => {
    expect(canRemove(RIDER, 'rider', member(), 1)).toBe(true)
  })

  it('refuses a rider removing somebody else', () => {
    expect(canRemove(OTHER, 'rider', member(), 1)).toBe(false)
  })

  // A ride with no owner has nobody who can invite, resolve or delete it.
  it('refuses the last owner removing themselves, even though they outrank everyone', () => {
    expect(canRemove(OWNER, 'owner', ownerRow, 1)).toBe(false)
  })

  it('refuses a non-member entirely', () => {
    expect(canRemove(OTHER, null, member(), 1)).toBe(false)
  })

  // Co-ownership narrows the rule to what it was always protecting: somebody
  // has to be left who can invite, resolve a vote, or delete the ride.
  it('lets an owner step down while another owner remains', () => {
    expect(canRemove(OWNER, 'owner', ownerRow, 2)).toBe(true)
  })

  // The hostile-takeover case. Co-owners hold equal power, so whoever pressed
  // the button first would own the ride and the loser could not undo it.
  it('refuses an owner removing a DIFFERENT owner, however many there are', () => {
    expect(canRemove(OWNER, 'owner', otherOwner, 2)).toBe(false)
    expect(canRemove(OWNER, 'owner', otherOwner, 5)).toBe(false)
  })

  it('still refuses a rider removing an owner', () => {
    expect(canRemove(RIDER, 'rider', ownerRow, 2)).toBe(false)
  })
})

// The rank lives in code because ride_perm's member order is not its rank and
// cannot be reordered later. Nothing may compare two enum members directly.
describe('the permission ladder', () => {
  it('ranks every member of the enum, and no two share a rank', () => {
    expect(Object.keys(PERM_RANK).sort()).toEqual([...ridePermEnum.enumValues].sort())
    const ranks = Object.values(PERM_RANK)
    expect(new Set(ranks).size).toBe(ranks.length)
  })

  it('orders them view < comment < suggest < edit', () => {
    expect(PERM_RANK.view).toBeLessThan(PERM_RANK.comment)
    expect(PERM_RANK.comment).toBeLessThan(PERM_RANK.suggest)
    expect(PERM_RANK.suggest).toBeLessThan(PERM_RANK.edit)
  })

  it('defaults an invitation to suggest, never to edit', () => {
    expect(DEFAULT_PERM).toBe('suggest')
    expect(canEditAsMember(member({ perm: DEFAULT_PERM }))).toBe(false)
    expect(canSuggest(member({ perm: DEFAULT_PERM }))).toBe(true)
  })

  it('puts a non-member below view, because a share link is not a grant', () => {
    expect(rankOf(null)).toBeLessThan(PERM_RANK.view)
    expect(canViewAsMember(null)).toBe(false)
    expect(canComment(null)).toBe(false)
  })

  // An owner is above the ladder rather than on it, so their perm column is
  // never read — which is what lets it stay at the default while they own the
  // ride, so demoting a co-owner is one column changing and not two.
  it('puts an owner above every rung whatever their own perm says', () => {
    const stubborn = member({ riderId: OWNER, role: 'owner', perm: 'view' })
    expect(canEditAsMember(stubborn)).toBe(true)
    expect(canAdminister(stubborn)).toBe(true)
    expect(rankOf(stubborn)).toBeGreaterThan(PERM_RANK.edit)
  })

  it('is a ladder: each rung carries everything below it', () => {
    expect(canViewAsMember(member({ perm: 'view' }))).toBe(true)
    expect(canComment(member({ perm: 'view' }))).toBe(false)

    expect(canComment(member({ perm: 'comment' }))).toBe(true)
    expect(canSuggest(member({ perm: 'comment' }))).toBe(false)

    expect(canSuggest(member({ perm: 'suggest' }))).toBe(true)
    expect(canEditAsMember(member({ perm: 'suggest' }))).toBe(false)

    expect(canEditAsMember(member({ perm: 'edit' }))).toBe(true)
    expect(canComment(member({ perm: 'edit' }))).toBe(true)
  })

  it('atLeast agrees with the named gates', () => {
    for (const p of ridePermEnum.enumValues) {
      const m = member({ perm: p })
      expect(atLeast(m, 'view')).toBe(canViewAsMember(m))
      expect(atLeast(m, 'comment')).toBe(canComment(m))
      expect(atLeast(m, 'suggest')).toBe(canSuggest(m))
      expect(atLeast(m, 'edit')).toBe(canEditAsMember(m))
    }
  })
})

// Edit is the builder and nothing more. These are the powers it does NOT carry.
describe('canAdminister', () => {
  it('is the owner only, and an edit-level rider never acquires it', () => {
    expect(canAdminister(ownerRow)).toBe(true)
    expect(canAdminister(member({ perm: 'edit' }))).toBe(false)
    expect(canAdminister(null)).toBe(false)
  })
})

describe('canSetPerm', () => {
  it('is the owner only', () => {
    expect(canSetPerm(ownerRow, member())).toBe(true)
    expect(canSetPerm(member({ perm: 'edit' }), member())).toBe(false)
    expect(canSetPerm(null, member())).toBe(false)
  })

  // An owner is not on the ladder, so setting their rung writes a column nobody
  // reads and renders a demotion that did not happen.
  it('refuses to set a rung on an owner', () => {
    expect(canSetPerm(ownerRow, otherOwner)).toBe(false)
  })
})

// Showing a rung publishes a ranking of the riders to the riders. The roster
// answers who is coming; a rung is administration.
describe('canSeePerms', () => {
  it('is the owner only, not the roster', () => {
    expect(canSeePerms(ownerRow)).toBe(true)
    expect(canSeePerms(member({ perm: 'edit' }))).toBe(false)
    expect(canSeePerms(null)).toBe(false)
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

describe('PERM_LABELS and PERM_HELP', () => {
  it('have copy for every rung', () => {
    expect(Object.keys(PERM_LABELS).sort()).toEqual([...ridePermEnum.enumValues].sort())
    expect(Object.keys(PERM_HELP).sort()).toEqual([...ridePermEnum.enumValues].sort())
    for (const v of [...Object.values(PERM_LABELS), ...Object.values(PERM_HELP)]) {
      expect(v.length).toBeGreaterThan(0)
    }
  })
})
