// Who may write on somebody else's ride, and what happens to a comment whose
// stop is deleted out from under it.
//
// The rule worth the most attention is the last one: an orphaned comment
// DEMOTES to the ride and is never removed. Every other uid-keyed child of a
// ride — point_details, alt_votes — is reconciled away when its uid leaves the
// payload, so the instinct while reading this code is that comments should be
// too. They are words a person wrote, and a save must not delete those.
import { describe, expect, it } from 'vitest'
import {
  canDelete,
  canPost,
  canResolve,
  cleanBody,
  isOpen,
  MAX_COMMENT_LEN,
  orphanedComments,
  type CommentFields,
} from '../src/comments/policy'
import type { MemberFields } from '../src/members/policy'

const AUTHOR = 2
const OWNER = 1
const OTHER = 3

const member = (over: Partial<MemberFields> = {}): MemberFields => ({
  riderId: AUTHOR,
  role: 'rider',
  perm: 'suggest',
  rsvp: 'going',
  ...over,
})
const owner = member({ riderId: OWNER, role: 'owner' })

const comment = (over: Partial<CommentFields> = {}): CommentFields => ({
  id: 10,
  authorId: AUTHOR,
  pointUid: 'abc123',
  resolvedAt: null,
  ...over,
})

describe('canPost', () => {
  it('needs the comment rung', () => {
    expect(canPost(member({ perm: 'view' }))).toBe(false)
    expect(canPost(member({ perm: 'comment' }))).toBe(true)
    expect(canPost(member({ perm: 'edit' }))).toBe(true)
    expect(canPost(owner)).toBe(true)
  })

  // A share link is permission to see a route, not to write on it. A public
  // ride would otherwise be writable by anyone on the internet.
  it('refuses somebody who is not on the roster', () => {
    expect(canPost(null)).toBe(false)
  })
})

describe('canDelete', () => {
  it('is the author', () => {
    expect(canDelete(member(), comment())).toBe(true)
  })

  it('is the owner, on anybody', () => {
    expect(canDelete(owner, comment())).toBe(true)
  })

  // Editing the route is not moderating the people on it — the same line
  // canRsvp draws one level up.
  it('is NOT an edit-level rider on somebody else comment', () => {
    expect(canDelete(member({ riderId: OTHER, perm: 'edit' }), comment())).toBe(false)
  })

  it('is not a stranger', () => {
    expect(canDelete(null, comment())).toBe(false)
    expect(canDelete(member({ riderId: OTHER }), comment())).toBe(false)
  })
})

// Closing is the gentler verb and the reflex is to open it up to anyone who can
// comment. A comment is a question somebody asked, and marking it answered on
// their behalf is speaking for them.
describe('canResolve', () => {
  it('is exactly the same two people as deletion', () => {
    for (const viewer of [null, member(), owner, member({ riderId: OTHER, perm: 'edit' })]) {
      expect(canResolve(viewer, comment())).toBe(canDelete(viewer, comment()))
    }
  })
})

describe('isOpen', () => {
  it('reads the timestamp, which records WHEN and not just whether', () => {
    expect(isOpen(comment())).toBe(true)
    expect(isOpen(comment({ resolvedAt: new Date() }))).toBe(false)
  })
})

describe('cleanBody', () => {
  it('trims, and empty is not a comment', () => {
    expect(cleanBody('  hi  ')).toBe('hi')
    expect(cleanBody('   ')).toBe(null)
    expect(cleanBody('')).toBe(null)
  })

  it('refuses a non-string', () => {
    expect(cleanBody(undefined)).toBe(null)
    expect(cleanBody(42)).toBe(null)
  })

  // Truncating would store half of what somebody wrote and say nothing.
  it('refuses an over-long body rather than cutting it', () => {
    expect(cleanBody('x'.repeat(MAX_COMMENT_LEN))).toHaveLength(MAX_COMMENT_LEN)
    expect(cleanBody('x'.repeat(MAX_COMMENT_LEN + 1))).toBe(null)
  })
})

describe('orphanedComments', () => {
  it('names a comment whose point left the payload', () => {
    const rows = [comment({ id: 1, pointUid: 'gone' }), comment({ id: 2, pointUid: 'here' })]
    expect(orphanedComments(rows, ['here'])).toEqual([1])
  })

  it('leaves ride-level comments alone — there is nothing to demote them to', () => {
    expect(orphanedComments([comment({ id: 1, pointUid: null })], [])).toEqual([])
  })

  it('names nothing when every anchor survives', () => {
    expect(orphanedComments([comment({ pointUid: 'a' })], ['a', 'b'])).toEqual([])
  })

  // The whole point of the rule: a save that deletes every stop demotes every
  // comment and destroys none of them.
  it('demotes ALL of them rather than deleting any, when a save empties the ride', () => {
    const rows = [comment({ id: 1, pointUid: 'a' }), comment({ id: 2, pointUid: 'b' })]
    expect(orphanedComments(rows, [])).toEqual([1, 2])
  })
})
