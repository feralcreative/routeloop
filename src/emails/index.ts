// The registry.
//
// Its only job is to give test/emails.test.ts something to iterate. Every
// template is reachable from here, so the contract tests cover the whole set
// automatically and a new template cannot be added without being tested — the
// failure mode this exists to prevent is the fourth email quietly skipping the
// assertions the first three pass.
// Everything reachable from here is PURE — a function of its props and nothing
// else. That is what lets the tests import the whole registry with no database
// and no environment, so nothing that reads a table belongs in this directory
// (the signup notifications live in src/auth/notify.ts for exactly that reason).
import { approvedEmail } from './approved'
import { inviteEmail } from './invite'
import { magicLinkEmail } from './magic-link'
import { ownerSignupEmail } from './owner-signup'
import { waitlistEmail } from './waitlist'
import type { AnyEmailTemplate } from './types'

export const ALL_EMAILS: readonly AnyEmailTemplate[] = [
  magicLinkEmail,
  waitlistEmail,
  approvedEmail,
  ownerSignupEmail,
  inviteEmail,
]

export { approvedEmail, inviteEmail, magicLinkEmail, ownerSignupEmail, waitlistEmail }
export { renderEmail } from './shell'
export type { EmailTemplate, Rendered } from './types'
