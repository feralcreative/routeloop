// The guided tour's guide riders — the pure half.
//
// What can be pinned with no database: that the handles are ones a rider could
// never claim, that the identity the upsert keys on cannot collide with a real
// public id, and which guide's tank binds the group, because the fixture and
// the tour's copy both name that rider.
import { describe, expect, it } from 'vitest'
import { bindingGuide, GUIDES } from '../src/tour/guides'
import { RESERVED_USERNAMES, usernameSchema } from '../src/auth/username'
import { mayInviteWithoutFriendship } from '../src/members/policy'

describe('guide riders', () => {
  it('are three, with handles a rider cannot claim', () => {
    expect(GUIDES).toHaveLength(3)
    for (const g of GUIDES) {
      // Reserved, so the schema refuses it to everybody…
      expect(RESERVED_USERNAMES.has(g.username)).toBe(true)
      expect(usernameSchema.safeParse(g.username).success).toBe(false)
      // …and otherwise well-formed, so the column and the profile route accept it.
      expect(g.username).toMatch(/^[a-zA-Z0-9_]{3,30}$/)
    }
  })

  it('key on a public id no real rider can have', () => {
    // A real public id is `{username}-{YYMMDDTHHMMZ}`; a colon never appears.
    for (const g of GUIDES) expect(g.publicId).toMatch(/^guide:[a-z]+$/)
    expect(new Set(GUIDES.map((g) => g.publicId)).size).toBe(3)
  })

  it('have one short tank, and it is the binding one', () => {
    const b = bindingGuide()
    expect(b.username).toBe('routeloop_guide_diego')
    for (const g of GUIDES) if (g !== b) expect(g.bike.rangeMi).toBeGreaterThan(b.bike.rangeMi)
  })

  it('may be invited with no friendship, and nobody else may', () => {
    expect(mayInviteWithoutFriendship({ isGuide: true })).toBe(true)
    expect(mayInviteWithoutFriendship({ isGuide: false })).toBe(false)
  })
})
