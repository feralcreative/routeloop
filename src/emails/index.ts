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
import { accountPurgeSoonEmail } from './account-purge-soon'
import { approvedEmail } from './approved'
import { feedbackStatusEmail } from './feedback-status'
import { friendAcceptedEmail } from './friend-accepted'
import { friendRequestEmail } from './friend-request'
import { inviteEmail } from './invite'
import { magicLinkEmail } from './magic-link'
import { ownerFeedbackEmail } from './owner-feedback'
import { newFollowerEmail } from './new-follower'
import { ownerSignupEmail } from './owner-signup'
import { quotaFullEmail } from './quota-full'
import { releaseEmail } from './release'
import { rideAddedEmail } from './ride-added'
import { rideCommentEmail } from './ride-comment'
import { ridePurgeSoonEmail } from './ride-purge-soon'
import { rideRsvpEmail } from './ride-rsvp'
import { rideSuggestionEmail } from './ride-suggestion'
import { suggestionDecidedEmail } from './suggestion-decided'
import { voteResolvedEmail } from './vote-resolved'
import { waitlistEmail } from './waitlist'
import type { AnyEmailTemplate } from './types'

export const ALL_EMAILS: readonly AnyEmailTemplate[] = [
  magicLinkEmail,
  waitlistEmail,
  approvedEmail,
  ownerSignupEmail,
  ownerFeedbackEmail,
  feedbackStatusEmail,
  inviteEmail,
  friendRequestEmail,
  friendAcceptedEmail,
  // The catalog's own thirteen, minus the three above that predate it. Order
  // follows src/notifications/catalog.ts so the two lists read the same way.
  rideCommentEmail,
  rideSuggestionEmail,
  suggestionDecidedEmail,
  voteResolvedEmail,
  rideAddedEmail,
  rideRsvpEmail,
  newFollowerEmail,
  ridePurgeSoonEmail,
  quotaFullEmail,
  releaseEmail,
  accountPurgeSoonEmail,
]

export {
  accountPurgeSoonEmail,
  approvedEmail,
  feedbackStatusEmail,
  friendAcceptedEmail,
  friendRequestEmail,
  inviteEmail,
  magicLinkEmail,
  ownerFeedbackEmail,
  newFollowerEmail,
  ownerSignupEmail,
  quotaFullEmail,
  releaseEmail,
  rideAddedEmail,
  rideCommentEmail,
  ridePurgeSoonEmail,
  rideRsvpEmail,
  rideSuggestionEmail,
  suggestionDecidedEmail,
  voteResolvedEmail,
  waitlistEmail,
}
export { renderEmail } from './shell'
export type { EmailTemplate, Rendered } from './types'
