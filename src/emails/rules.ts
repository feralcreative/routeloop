// When a notification is owed.
//
// These are pure functions, extracted out of the route handlers precisely so
// they can be tested without a database — the rest of the decision lives in SQL,
// which cannot be. The split is deliberate and the two halves do different jobs:
//
//   this file  — the RULE. Readable, enumerable, and asserted as a table in
//                test/email-rules.test.ts.
//   the SQL    — the RACE GUARD. A conditional UPDATE ... RETURNING, so two
//                managers clicking Approve at the same instant cannot both win.
//
// Neither substitutes for the other. The rule alone would double-send under
// concurrency; the SQL alone would be an unreadable statement of policy.
import type { UserStatus } from '../db/schema'

/**
 * Should approving this rider send them the "you're in" email?
 *
 * @param from   the status the account held before this change
 * @param to     the status being written
 * @param approvedEmailAt  when the approval email last went out, or null
 */
export function shouldSendApproval(from: UserStatus, to: UserStatus, approvedEmailAt: Date | null): boolean {
  // Only ever on the way in.
  if (to !== 'active') return false
  // Not a change. /admin renders Approve only for a pending rider, but the POST
  // is reachable directly and a double submit reaches it twice.
  if (from === 'active') return false
  // Already told them once. This is what makes active -> blocked -> active
  // silent: the transition is real, but the news is not new.
  if (approvedEmailAt !== null) return false
  return true
}

/**
 * Is this address the owner's?
 *
 * One definition, because two callers need it and an inline copy in each is how
 * they drift. The `ownerEmail &&` guard is the load-bearing half: an unset
 * OWNER_EMAIL arrives as '' through config's env() helper, and without it a
 * user whose email is also empty would match and be silently skipped.
 */
export function isOwnerEmail(email: string | null, ownerEmail: string): boolean {
  return Boolean(ownerEmail && email && email.toLowerCase() === ownerEmail.toLowerCase())
}

/**
 * Should this sign-in send the "you're on the list" email?
 *
 * Separate from the owner alert on purpose — the owner's own first sign-in
 * produces neither, but for different reasons, and collapsing the two would hide
 * that the waitlist message is skipped because of *status* while the alert is
 * skipped because there is no point telling yourself you exist.
 */
export function shouldSendWaitlist(args: {
  created: boolean
  status: UserStatus
  email: string | null
  ownerEmail: string
}): boolean {
  if (!args.created) return false
  if (!args.email) return false
  if (isOwnerEmail(args.email, args.ownerEmail)) return false
  // Status, not the address: identity.ts already decides who lands pending, and
  // re-deriving that here would be a second copy of the rule.
  return args.status !== 'active'
}
