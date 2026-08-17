// The send decisions that need a table, kept out of src/emails/.
//
// That directory is pure — every module in it is a function of its props and
// nothing else — which is what lets test/emails.test.ts import the whole
// registry with no database and no environment. This file counts rows, so
// putting it there would drag a pg Pool into the test process for every
// template. Exactly the same arrangement as src/auth/notify.ts, which is the
// precedent.
import { and, eq } from 'drizzle-orm'
import { count } from 'drizzle-orm'
import { OWNER_EMAIL } from '../config'
import { db } from '../db/index'
import { feedback, users } from '../db/schema'
import type { FeedbackRow, FeedbackStatus } from '../db/schema'
import { feedbackStatusEmail } from '../emails/feedback-status'
import { ownerFeedbackEmail } from '../emails/owner-feedback'
import { sendTemplateDetached } from '../auth/mailer'
import { STATUS_META, areaLabel, statusLabel } from './policy'

async function pendingCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(feedback).where(eq(feedback.state, 'pending'))
  return row?.n ?? 0
}

/**
 * Tell the owner a report arrived.
 *
 * Returns void rather than a promise and never throws, for the reason
 * notifyNewSignup carries: a mail failure must not turn a successful submit into
 * an error page, and the whole design of the intake is that a rider's report
 * cannot be lost to something going wrong after they hit send.
 *
 * MUST be called after submitReport's transaction has committed. An SMTP round
 * trip inside it would hold a pooled connection open for a network call, and a
 * mail failure would roll back the report it was announcing.
 */
export function notifyNewReport(report: FeedbackRow, riderName: string): void {
  void (async () => {
    // The count is read here rather than passed in because the caller has no
    // reason to know it and the number is only meaningful at send time.
    const waiting = await pendingCount()
    sendTemplateDetached(
      OWNER_EMAIL,
      ownerFeedbackEmail,
      {
        id: report.id,
        kind: report.kind,
        title: report.title ?? report.body.slice(0, 80),
        body: report.body,
        riderName,
        area: areaLabel(report.area),
        pendingCount: waiting,
      },
      // Keyed by the template rather than the recipient. Every one of these
      // goes to the same address, so a recipient key would drop legitimate
      // alerts during a burst — the same reasoning owner-signup's limitKey
      // carries.
      { limitKey: 'owner-feedback' },
    )
  })().catch((err) => {
    // Attached synchronously, because an unattached rejection terminates the
    // process under Node's default --unhandled-rejections=throw.
    console.warn('[feedback] owner notification failed:', err)
  })
}

/** Whether a report's author has asked to be written to. `reply_ok` defaults
 *  true and a rider can turn it off; nothing outbound to a rider may skip this
 *  check. */
export async function canReplyTo(report: FeedbackRow): Promise<{ ok: boolean; email: string | null }> {
  if (!report.replyOk) return { ok: false, email: null }
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.id, report.authorId)))
    .limit(1)
  return { ok: Boolean(row?.email), email: row?.email ?? null }
}

/**
 * Statuses worth an email, and the reason the set is small.
 *
 * A rider hears from us when something CHANGED FOR THEM, not every time the
 * owner touches a row. `new` is what everything starts as, so mailing it would
 * mean a second message seconds after the confirmation screen; `needs_info` is
 * excluded because its own sub-line says "check your email — we asked a
 * question", which means the question is a real message someone wrote, not this
 * one.
 *
 * The rest are all news: it is fixed, it is planned, it is being worked on, we
 * are not doing it, we could not reproduce it, it works that way on purpose.
 */
const MAILED_STATUSES = new Set<FeedbackStatus>([
  'confirmed',
  'planned',
  'in_progress',
  'shipped',
  'on_list',
  'not_doing',
  'no_repro',
  'by_design',
])

/**
 * Tell a rider what happened to their report.
 *
 * Sends only when the status ACTUALLY CHANGED — the queue's several small forms
 * each POST the whole status field, so saving a private note re-submits the
 * status unchanged, and a naive "the handler ran" trigger would mail the rider
 * every time the owner typed in the note box.
 *
 * Void and never throws, like notifyNewReport: a mail failure must not turn a
 * successful moderation into an error page.
 */
export function notifyStatusChange(report: FeedbackRow, previous: FeedbackStatus): void {
  if (report.status === previous) return
  if (!MAILED_STATUSES.has(report.status)) return

  void (async () => {
    const { ok, email } = await canReplyTo(report)
    if (!ok || !email) return

    sendTemplateDetached(email, feedbackStatusEmail, {
      // Resolved here rather than in the template, so the email never decides
      // whether a thing was fixed or built — STATUS_META and statusLabel are the
      // single source and this is just a caller.
      statusLabel: statusLabel(report.status, report.kind),
      statusSub: STATUS_META[report.status].sub,
      title: report.title ?? report.body.slice(0, 80),
      response: report.publicResponse,
      publicId: report.publicId,
      onBoard: report.state === 'published' && report.kind === 'idea',
    })
  })().catch((err) => {
    console.warn('[feedback] status notification failed:', err)
  })
}
