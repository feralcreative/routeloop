// When a notification is owed, as a table.
//
// These rules are cheap to state and expensive to get wrong in either
// direction: a false negative leaves a rider waiting for an email that never
// comes, and a false positive mails someone "you're approved!" every time they
// are reinstated. Both are invisible in review, which is what this is for.
//
// The concurrency half of the guard is the conditional UPDATE in
// routes/admin.tsx and is deliberately NOT tested here — it needs a database.
// This covers the policy; the SQL covers the race.
import { describe, expect, it } from 'vitest'
import { isOwnerEmail, shouldSendApproval, shouldSendWaitlist } from '../src/emails/rules'

const NEVER = null
const ALREADY = new Date('2026-08-01T00:00:00Z')

describe('shouldSendApproval', () => {
  const cases: [string, Parameters<typeof shouldSendApproval>, boolean][] = [
    ['the normal approval', ['pending', 'active', NEVER], true],
    ['a rider blocked before ever being approved', ['blocked', 'active', NEVER], true],
    ['reinstating someone already told once', ['blocked', 'active', ALREADY], false],
    ['approving someone already active', ['active', 'active', NEVER], false],
    ['blocking', ['active', 'blocked', NEVER], false],
    ['blocking a pending rider', ['pending', 'blocked', NEVER], false],
    ['blocking someone already told', ['active', 'blocked', ALREADY], false],
  ]

  for (const [name, args, expected] of cases) {
    it(`${expected ? 'sends' : 'stays quiet'}: ${name}`, () => {
      expect(shouldSendApproval(...args)).toBe(expected)
    })
  }

  // The whole reason approved_email_at exists rather than relying on the status
  // transition alone. Worth its own named test so a future simplification that
  // drops the column fails with an explanation attached.
  it('does not re-send across an active -> blocked -> active cycle', () => {
    expect(shouldSendApproval('pending', 'active', NEVER)).toBe(true)
    // ...email sent, approvedEmailAt stamped, rider later blocked and reinstated
    expect(shouldSendApproval('blocked', 'active', ALREADY)).toBe(false)
  })
})

describe('isOwnerEmail', () => {
  it('matches', () => expect(isOwnerEmail('me@example.com', 'me@example.com')).toBe(true))
  it('matches regardless of case', () => expect(isOwnerEmail('ME@Example.com', 'me@example.com')).toBe(true))
  it('does not match a different address', () => expect(isOwnerEmail('x@example.com', 'me@example.com')).toBe(false))
  it('handles a null address', () => expect(isOwnerEmail(null, 'me@example.com')).toBe(false))

  // The guard that matters. OWNER_EMAIL arrives as '' when unset (config's env()
  // helper), and a bare equality check would then match any account whose email
  // is also empty and silently skip its notifications.
  it('never matches when the owner address is unset', () => {
    expect(isOwnerEmail('', '')).toBe(false)
    expect(isOwnerEmail(null, '')).toBe(false)
    expect(isOwnerEmail('anyone@example.com', '')).toBe(false)
  })
})

describe('shouldSendWaitlist', () => {
  const base = { created: true, status: 'pending' as const, email: 'rider@example.com', ownerEmail: 'me@example.com' }

  it('sends to a brand-new pending rider', () => {
    expect(shouldSendWaitlist(base)).toBe(true)
  })

  // The one that matters most: a rider who signed up with Google and later adds
  // a magic link resolves to an existing account, and must not be welcomed twice.
  it('stays quiet when the account already existed', () => {
    expect(shouldSendWaitlist({ ...base, created: false })).toBe(false)
  })

  it('stays quiet for an account that is already active', () => {
    expect(shouldSendWaitlist({ ...base, status: 'active' })).toBe(false)
  })

  it('stays quiet for the owner', () => {
    expect(shouldSendWaitlist({ ...base, email: 'me@example.com' })).toBe(false)
  })

  it('matches the owner regardless of case', () => {
    expect(shouldSendWaitlist({ ...base, email: 'ME@Example.com' })).toBe(false)
  })

  // users.email is nullable.
  it('stays quiet with no address to send to', () => {
    expect(shouldSendWaitlist({ ...base, email: null })).toBe(false)
  })

  // An unset OWNER_EMAIL arrives as '' through config's env() helper. It must
  // not match every address, which is what a bare equality check would do for a
  // rider whose email is also somehow empty.
  it('does not treat an unset owner address as a match', () => {
    expect(shouldSendWaitlist({ ...base, ownerEmail: '' })).toBe(true)
  })
})
