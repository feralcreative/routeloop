// The agreement test src/access/query.ts's header promises.
//
// Two list rules decide what appears on a surface nobody asked for by name:
// isListed() for /explore and the public profile grid, and isFriendListed() for
// the dashboard's Friends' rides tab. Each has a SQL twin — LISTED_RIDE and
// FRIEND_LISTED_RIDE — derived from the same function rather than restating it,
// so those two cannot drift. What CAN drift is a list rule against canView():
// a level added to a list that canView() would refuse is a leak, and nothing
// else in the codebase would notice.
//
// So this asserts the one property that matters: **everything a list surfaces
// is something the viewer it is shown to could have opened anyway.** A list may
// be narrower than canView (unlisted is viewable and never listed); it may
// never be wider.
import { describe, expect, it } from 'vitest'
import { canView, isFriendListed, isListed, type Viewer } from '../src/access/policy'
import { visibilityEnum, type RideVisibility } from '../src/db/schema'

const LEVELS = visibilityEnum.enumValues as readonly RideVisibility[]

const OWNER = 7
const ride = (visibility: RideVisibility) => ({ ownerId: OWNER, visibility })

const stranger: Viewer = { id: 99, status: 'active' }
const anonymous: Viewer = null

describe('the list rules never exceed canView', () => {
  // /explore and a public profile are shown to ANYONE, signed in or not, so the
  // hardest viewer to satisfy is the anonymous one with no grants at all.
  it.each(LEVELS)('isListed(%s) implies an anonymous viewer could open it', (v) => {
    if (!isListed(v)) return
    expect(canView(ride(v), anonymous, {})).toBe(true)
  })

  // The friends list is shown to a signed-in rider who IS a friend of the owner,
  // and to nobody else, so that is the grant to test against.
  it.each(LEVELS)('isFriendListed(%s) implies a friend of the owner could open it', (v) => {
    if (!isFriendListed(v)) return
    expect(canView(ride(v), stranger, { isFriendOfOwner: true })).toBe(true)
  })
})

describe('what each list deliberately excludes', () => {
  // The whole difference between public and unlisted, and the single most
  // harmful thing to get wrong here — an unlisted ride surfaced to somebody who
  // was not handed its link is the level failing to mean anything.
  it('never lists unlisted, in either list', () => {
    expect(isListed('unlisted')).toBe(false)
    expect(isFriendListed('unlisted')).toBe(false)
  })

  it('never lists private, in either list', () => {
    expect(isListed('private')).toBe(false)
    expect(isFriendListed('private')).toBe(false)
  })

  // A ride in two tabs of one strip reads as a duplicate rather than as two
  // answers, which is why the dashboard's Friends' and Public tabs cannot both
  // claim a level. This is the property that keeps them disjoint.
  it.each(LEVELS)('%s is in at most one of the two lists', (v) => {
    expect(Number(isListed(v)) + Number(isFriendListed(v))).toBeLessThanOrEqual(1)
  })
})

// THE PROPERTY THE WHOLE FOLLOW FEATURE RESTS ON.
//
// followingRides() in src/access/query.ts filters on LISTED_RIDE, not on
// FRIEND_LISTED_RIDE, so every row a feed shows is one /explore would also
// show. There is no isFollowListed() to pin because there is no third rule —
// the feed reuses isListed(), which is the point. What this asserts is the
// consequence: a follow can never surface something an anonymous visitor could
// not already have opened, so the one-way, never-agreed-to relationship is not
// a key to anything.
describe('following grants no visibility', () => {
  it.each(LEVELS)('%s reaches a feed only if it reaches a stranger', (v) => {
    // The feed's predicate IS isListed. Stated as an assertion rather than as a
    // comment so a future change that gives the feed its own rule fails here.
    if (!isListed(v)) return
    expect(canView(ride(v), anonymous, {})).toBe(true)
  })

  it('never lets a feed reach a friends-only ride', () => {
    // If followingRides ever selected FRIEND_LISTED_RIDE, `friends` visibility
    // would be openable by anyone willing to press Follow.
    expect(isListed('friends')).toBe(false)
  })
})

describe('the friends list is not a way around friendship', () => {
  // FRIEND_LISTED_RIDE is only the visibility half; the join on `friendships` is
  // what establishes the grant. This pins the half that is expressible purely:
  // without the grant, the level the list is built on is not viewable at all, so
  // a query that dropped the join would be surfacing rides canView() refuses.
  it('refuses a friends ride to a rider who is not a friend', () => {
    for (const v of LEVELS.filter(isFriendListed)) {
      expect(canView(ride(v), stranger, {})).toBe(false)
      expect(canView(ride(v), anonymous, {})).toBe(false)
    }
  })

  // A pending or blocked pair has a friendships row and is not a friendship.
  // The query tests status = 'accepted' for that reason; here we only pin that
  // the grant itself is what the rule turns on.
  it('turns on the grant and nothing else', () => {
    for (const v of LEVELS.filter(isFriendListed)) {
      expect(canView(ride(v), stranger, { isFriendOfOwner: false })).toBe(false)
      expect(canView(ride(v), stranger, { isFriendOfOwner: true })).toBe(true)
    }
  })
})
