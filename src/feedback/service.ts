// Every query about a report. The rules live in policy.ts and nothing here
// re-decides one.
//
// The split is the house pattern (src/invites/policy.ts vs service.ts,
// src/survey/score.ts vs questions.ts, src/stats/shape.ts vs query.ts) and it is
// load-bearing rather than tidy: vitest.config.ts is deliberately scoped to pure
// logic and CI runs with no Postgres, so a rule that ends up in this file is a
// rule with no test.
//
// Two invariants this file is responsible for, both enforced by the database
// rather than by a check here:
//
//   - ONE WANT PER RIDER, by the composite primary key on feedback_votes. The
//     toggle below reads the delete's row count instead of asking first, so two
//     taps racing cannot both insert.
//   - want_count MATCHES THE VOTE ROWS, by writing both inside one transaction.
//     A denormalized count is worth having and is worth exactly nothing if it can
//     drift.
import { and, count, desc, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { feedback, feedbackAttachments, feedbackDiagnostics, feedbackVotes, users } from '../db/schema'
import type { FeedbackKind, FeedbackRow, FeedbackState, FeedbackStatus } from '../db/schema'
import { generateSlug } from '../maps/slug'
import { redactDiagnostics } from './diagnostics'
import { BODY_MAX, SUBMIT_LIMIT, titleFrom } from './policy'
import { attachmentKey, writeAttachment, type AttachmentExt } from './storage'

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** An image the rider attached, already downscaled and re-encoded by the client
 *  (or not, if their JavaScript was broken — the route validates either way). */
export type IncomingAttachment = {
  ext: AttachmentExt
  mime: string
  data: Buffer
  width?: number
  height?: number
}

export type NewReport = {
  authorId: number
  kind: FeedbackKind
  body: string
  context?: string | null
  area?: string | null
  frequency?: string | null
  impact?: string | null
  replyOk?: boolean
  /** Raw client payload. Redacted here, on the way in, never on the way out. */
  diagnostics?: unknown
  attachments?: IncomingAttachment[]
}

/**
 * Store one report, its diagnostics and its attachments.
 *
 * One transaction, and the ordering inside it is the interesting part: the row
 * is inserted first because the attachment path is built from its id, and the
 * files are written LAST because a filesystem write cannot be rolled back. A
 * failure after the files land leaves orphaned bytes on disk, which the sweep in
 * storage.ts cleans up; a failure the other way round would leave rows pointing
 * at files that do not exist, which every read would then have to defend
 * against.
 */
export async function submitReport(r: NewReport): Promise<FeedbackRow> {
  const body = r.body.trim().slice(0, BODY_MAX)

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(feedback)
      .values({
        publicId: generateSlug(),
        authorId: r.authorId,
        kind: r.kind,
        // Derived, never asked for. The owner can edit it before publishing,
        // which is the only place a title has to be good.
        title: titleFrom(body) || null,
        body,
        context: r.context?.trim() || null,
        area: r.area || null,
        frequency: r.frequency || null,
        impact: r.impact || null,
        replyOk: r.replyOk ?? true,
      })
      .returning()

    // A row always, even when the client sent nothing: "JavaScript never ran" is
    // itself diagnostic, and an absent row is indistinguishable from one we
    // failed to write.
    await tx.insert(feedbackDiagnostics).values({
      feedbackId: row.id,
      payload: redactDiagnostics(r.diagnostics) as Record<string, unknown>,
    })

    const files = r.attachments ?? []
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      await tx.insert(feedbackAttachments).values({
        feedbackId: row.id,
        storageKey: attachmentKey(row.id, i, f.ext),
        mime: f.mime,
        bytes: f.data.byteLength,
        width: f.width ?? null,
        height: f.height ?? null,
      })
    }
    for (let i = 0; i < files.length; i++) {
      await writeAttachment(row.id, i, files[i].ext, files[i].data)
    }

    return row
  })
}

/**
 * How many reports this rider has filed in the last hour.
 *
 * The count, not the verdict — SUBMIT_LIMIT lives in policy.ts and the caller
 * compares. Same division as everywhere else: the number is a rule and the query
 * is a query.
 */
export async function recentReportCount(authorId: number, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 60 * 60 * 1000)
  const [row] = await db
    .select({ n: count() })
    .from(feedback)
    .where(and(eq(feedback.authorId, authorId), gte(feedback.createdAt, since)))
  return row?.n ?? 0
}

export async function isOverSubmitLimit(authorId: number, now: Date): Promise<boolean> {
  return (await recentReportCount(authorId, now)) >= SUBMIT_LIMIT
}

export type MineRow = {
  publicId: string
  kind: FeedbackKind
  state: FeedbackState
  status: FeedbackStatus
  title: string | null
  body: string
  publicResponse: string | null
  wantCount: number
  createdAt: Date
}

/** A rider's own reports, newest first. Every state — this is the one surface
 *  where a rider sees their own declined and duplicate rows, which is the point
 *  of having told them. */
export async function listMine(authorId: number, limit = 100): Promise<MineRow[]> {
  return db
    .select({
      publicId: feedback.publicId,
      kind: feedback.kind,
      state: feedback.state,
      status: feedback.status,
      title: feedback.title,
      body: feedback.body,
      publicResponse: feedback.publicResponse,
      wantCount: feedback.wantCount,
      createdAt: feedback.createdAt,
    })
    .from(feedback)
    .where(eq(feedback.authorId, authorId))
    .orderBy(desc(feedback.createdAt))
    .limit(limit)
}

export type ReportDetail = {
  report: FeedbackRow
  author: { displayName: string; email: string | null }
  attachments: { storageKey: string; mime: string; width: number | null; height: number | null }[]
}

/**
 * One report by its public id, with no visibility check.
 *
 * The check is `visibleTo` in policy.ts and the CALLER runs it, because the
 * caller is the only thing that knows who is asking. Deliberately not folded in
 * here: a query that quietly filters is a query whose filter nobody can test
 * without a database.
 */
export async function getByPublicId(publicId: string): Promise<ReportDetail | null> {
  const [row] = await db.select().from(feedback).where(eq(feedback.publicId, publicId)).limit(1)
  if (!row) return null

  const [author] = await db
    .select({ displayName: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.id, row.authorId))
    .limit(1)

  const files = await db
    .select({
      storageKey: feedbackAttachments.storageKey,
      mime: feedbackAttachments.mime,
      width: feedbackAttachments.width,
      height: feedbackAttachments.height,
    })
    .from(feedbackAttachments)
    .where(eq(feedbackAttachments.feedbackId, row.id))
    .orderBy(feedbackAttachments.id)

  return {
    report: row,
    author: author ?? { displayName: 'A rider', email: null },
    attachments: files,
  }
}

/** The stored diagnostics for one report, unparsed. The caller runs
 *  parseDiagnostics — same reasoning as getByPublicId not running visibleTo. */
export async function getDiagnostics(feedbackId: number): Promise<unknown> {
  const [row] = await db
    .select({ payload: feedbackDiagnostics.payload })
    .from(feedbackDiagnostics)
    .where(eq(feedbackDiagnostics.feedbackId, feedbackId))
    .limit(1)
  return row?.payload ?? null
}

/**
 * Cast or withdraw one rider's want, and keep the count honest.
 *
 * The delete runs first and its row count is the answer to "did they already
 * want this" — asking first would be a read followed by a write, and two taps
 * racing would both see "no" and one would 500 on the primary key.
 *
 * Returns the count as stored, so the caller never has to guess what the client
 * should now render.
 */
export async function toggleWant(feedbackId: number, userId: number): Promise<{ wanted: boolean; count: number }> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(feedbackVotes)
      .where(and(eq(feedbackVotes.feedbackId, feedbackId), eq(feedbackVotes.userId, userId)))
      .returning({ userId: feedbackVotes.userId })

    if (removed.length) {
      const [row] = await tx
        .update(feedback)
        // Clamped, so a count that has already drifted cannot go negative and
        // render as "-1 riders want this".
        .set({ wantCount: sql`greatest(0, ${feedback.wantCount} - 1)`, updatedAt: new Date() })
        .where(eq(feedback.id, feedbackId))
        .returning({ wantCount: feedback.wantCount })
      return { wanted: false, count: row?.wantCount ?? 0 }
    }

    await tx.insert(feedbackVotes).values({ feedbackId, userId })
    const [row] = await tx
      .update(feedback)
      .set({ wantCount: sql`${feedback.wantCount} + 1`, updatedAt: new Date() })
      .where(eq(feedback.id, feedbackId))
      .returning({ wantCount: feedback.wantCount })
    return { wanted: true, count: row?.wantCount ?? 0 }
  })
}

/** Which of these reports this rider has already wanted, so the board can render
 *  every button in its right state from one query rather than N. */
export async function wantedBy(userId: number, feedbackIds: number[]): Promise<Set<number>> {
  if (!feedbackIds.length) return new Set()
  const rows = await db
    .select({ feedbackId: feedbackVotes.feedbackId })
    .from(feedbackVotes)
    .where(and(eq(feedbackVotes.userId, userId), sql`${feedbackVotes.feedbackId} = any(${feedbackIds})`))
  return new Set(rows.map((r) => r.feedbackId))
}
