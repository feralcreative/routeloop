// The two emails a new signup produces: one to the rider, one to the owner.
//
// Lives here rather than in src/emails/ on purpose. That directory is pure —
// every module in it is a function of its props and nothing else — which is what
// lets test/emails.test.ts import the whole registry with no database and no
// environment. This file reads users, so putting it there would drag a pg Pool
// into the test process for every template.
//
// Both sign-in paths call this one function rather than each doing their own
// sends, because two copies of "is this a new account, and is it the owner"
// would drift the first time one of them changed.
import { eq, sql } from 'drizzle-orm'
import { OWNER_EMAIL } from '../config'
import { db } from '../db/index'
import { users } from '../db/schema'
import { ownerSignupEmail } from '../emails/owner-signup'
import { isOwnerEmail, shouldSendWaitlist } from '../emails/rules'
import { waitlistEmail } from '../emails/waitlist'
import type { Provider, ResolvedUser } from './identity'
import { sendTemplateDetached } from './mailer'

async function pendingCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.status, 'pending'))
  return row?.n ?? 0
}

/**
 * Fires the signup notifications, if this sign-in created an account.
 *
 * Returns void rather than a promise, and never throws: a failure here must not
 * turn a successful sign-in into an error page. The `.catch()` is attached
 * synchronously inside, for the same reason it is inside sendTemplateDetached —
 * an unattached rejection terminates the process under Node's default
 * --unhandled-rejections=throw.
 *
 * MUST be called after the caller's transaction has committed. redeemMagicLink
 * resolves the user inside one, and an SMTP round trip in there would hold a
 * pooled connection open for a network call.
 */
export function notifyNewSignup({ user, created }: ResolvedUser, provider: Provider): void {
  if (!created) return

  // The owner's own first sign-in creates their account too, and mailing
  // yourself that you exist is noise. They also land 'active', so neither
  // message below would be right for them.
  if (isOwnerEmail(user.email, OWNER_EMAIL)) return

  // Both decisions live in emails/rules.ts, where they are pure functions and a
  // table test rather than conditions buried in a side effect. shouldSendWaitlist
  // re-checks the owner, which is redundant at this call site and deliberate:
  // the rule has to be complete on its own or it is not a rule.
  if (shouldSendWaitlist({ created, status: user.status, email: user.email, ownerEmail: OWNER_EMAIL })) {
    sendTemplateDetached(user.email, waitlistEmail, {})
  }

  void (async () => {
    sendTemplateDetached(
      OWNER_EMAIL,
      ownerSignupEmail,
      { email: user.email ?? 'unknown', provider, pendingCount: await pendingCount() },
      {
        // Replying to the alert reaches the rider rather than the app's own
        // no-reply address.
        replyTo: user.email ?? undefined,
        // Keyed on the new rider, NOT on the recipient. Every owner alert goes to
        // the same address, so a recipient-keyed limiter would silently drop
        // legitimate alerts during a signup burst — which is exactly when they
        // matter most.
        limitKey: String(user.id),
      },
    )
  })().catch((err) => {
    console.error('[mail] owner signup alert failed:', err instanceof Error ? err.message : err)
  })
}
