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
//   - ONE WANT PER RIDER, by the composite primary key on feedback_votes.
//     Neither half of the toggle asks first: the withdraw reads the delete's row
//     count and the cast uses onConflictDoNothing and reads what it inserted. A
//     read-then-write would let two taps racing both see "not yet" — verified,
//     because the first version did exactly that and the loser 500'd.
//   - want_count MATCHES THE VOTE ROWS, by writing both inside one transaction.
//     A denormalized count is worth having and is worth exactly nothing if it can
//     drift.
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { feedback, feedbackAttachments, feedbackDiagnostics, feedbackVotes, users } from '../db/schema'
import type { FeedbackKind, FeedbackRow, FeedbackState, FeedbackStatus } from '../db/schema'
import { generateSlug } from '../maps/slug'
import { redactDiagnostics } from './diagnostics'
import { BODY_MAX, KIND_META, SUBMIT_LIMIT, titleFrom } from './policy'
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

export type QueueRow = MineRow & {
  id: number
  area: string | null
  frequency: string | null
  impact: string | null
  context: string | null
  priority: number | null
  ownerNote: string | null
  duplicateOf: number | null
  authorName: string
  authorEmail: string | null
  replyOk: boolean
  shots: number
}

export type QueueFilter = { state?: FeedbackState; kind?: FeedbackKind }

/**
 * The owner's list.
 *
 * Ordered pending-first and then newest, rather than by `createdAt` alone. The
 * queue is a worklist, and a worklist that buries the four things needing a
 * decision under forty that have already had one is a worklist nobody opens
 * twice.
 *
 * The attachment count comes from a correlated subquery rather than a join,
 * because a join would multiply the rows and the count would have to be undone
 * with a GROUP BY over every selected column.
 */
export async function listQueue(filter: QueueFilter = {}, limit = 200): Promise<QueueRow[]> {
  const where = [
    ...(filter.state ? [eq(feedback.state, filter.state)] : []),
    ...(filter.kind ? [eq(feedback.kind, filter.kind)] : []),
  ]

  return db
    .select({
      id: feedback.id,
      publicId: feedback.publicId,
      kind: feedback.kind,
      state: feedback.state,
      status: feedback.status,
      title: feedback.title,
      body: feedback.body,
      context: feedback.context,
      area: feedback.area,
      frequency: feedback.frequency,
      impact: feedback.impact,
      priority: feedback.priority,
      ownerNote: feedback.ownerNote,
      publicResponse: feedback.publicResponse,
      duplicateOf: feedback.duplicateOf,
      wantCount: feedback.wantCount,
      replyOk: feedback.replyOk,
      createdAt: feedback.createdAt,
      authorName: users.displayName,
      authorEmail: users.email,
      shots: sql<number>`(select count(*)::int from ${feedbackAttachments} where ${feedbackAttachments.feedbackId} = ${feedback.id})`,
    })
    .from(feedback)
    .innerJoin(users, eq(users.id, feedback.authorId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(sql`case when ${feedback.state} = 'pending' then 0 else 1 end`, desc(feedback.createdAt))
    .limit(limit)
}

/** How many reports are sitting at each state, for the queue's filter chips and
 *  the count in the owner's email. One grouped query rather than five. */
export async function queueCounts(): Promise<Record<string, number>> {
  const rows = await db.select({ state: feedback.state, n: count() }).from(feedback).groupBy(feedback.state)
  return Object.fromEntries(rows.map((r) => [r.state, r.n]))
}

export type Moderation = {
  state?: FeedbackState
  status?: FeedbackStatus
  kind?: FeedbackKind
  priority?: number | null
  title?: string
  ownerNote?: string
  publicResponse?: string
  duplicateOf?: number | null
}

/**
 * Apply one moderation decision.
 *
 * Every field is optional and only what is present is written, so the queue's
 * several small forms can all POST here without a field one form does not render
 * blanking a value another form set. That is the specific bug a single wide
 * UPDATE with a full row would cause.
 *
 * `publishedAt` is stamped by this function rather than by the caller, and only
 * on the first publish — re-publishing something already public must not move
 * the date the board sorts and labels by.
 *
 * **Publishing an idea auto-casts the author's want**, in the same transaction.
 * They asked for it, so they want it, and a board where the person who proposed
 * the top idea is not counted among the people who want it reads as broken. It
 * also means a freshly published idea shows 1 rather than 0, which is the
 * difference between "nobody cares" and "one person so far".
 *
 * The insert is guarded by onConflictDoNothing rather than a prior check: the
 * composite primary key on feedback_votes is the real constraint, and an
 * unpublish/republish cycle would otherwise double-count on the second publish.
 * That is also why the count is recomputed from the vote rows here instead of
 * incremented — this is the one write where the denormalized count could
 * plausibly drift, so it is the one that reconciles.
 */
export async function moderate(id: number, m: Moderation): Promise<FeedbackRow | null> {
  const [current] = await db.select().from(feedback).where(eq(feedback.id, id)).limit(1)
  if (!current) return null

  const publishing = m.state === 'published' && current.publishedAt === null
  // The kind as it will be AFTER this call — the owner can reclassify and
  // publish in one go, and reading `current.kind` would miss that.
  const kindAfter = m.kind ?? current.kind
  const autoCast = publishing && KIND_META[kindAfter].wantable

  return db.transaction(async (tx) => {
    if (autoCast) {
      await tx.insert(feedbackVotes).values({ feedbackId: id, userId: current.authorId }).onConflictDoNothing()
    }

    const [row] = await tx
      .update(feedback)
      .set({
        ...(m.state !== undefined && { state: m.state }),
        ...(m.status !== undefined && { status: m.status }),
        ...(m.kind !== undefined && { kind: m.kind }),
        ...(m.priority !== undefined && { priority: m.priority }),
        ...(m.title !== undefined && { title: m.title.trim() || null }),
        ...(m.ownerNote !== undefined && { ownerNote: m.ownerNote.trim() || null }),
        ...(m.publicResponse !== undefined && { publicResponse: m.publicResponse.trim() || null }),
        ...(m.duplicateOf !== undefined && { duplicateOf: m.duplicateOf }),
        ...(publishing && { publishedAt: new Date() }),
        ...(autoCast && {
          wantCount: sql`(select count(*)::int from ${feedbackVotes} where ${feedbackVotes.feedbackId} = ${id})`,
        }),
        updatedAt: new Date(),
      })
      .where(eq(feedback.id, id))
      .returning()

    return row ?? null
  })
}

/** One report by its id, for the moderation handler. The queue addresses rows by
 *  id rather than publicId — it is the owner's surface and the id is what the
 *  duplicate-of field refers to. */
export async function getById(id: number): Promise<FeedbackRow | null> {
  const [row] = await db.select().from(feedback).where(eq(feedback.id, id)).limit(1)
  return row ?? null
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

    // onConflictDoNothing, and the returned row count is what says whether this
    // call actually cast the vote. Without it a genuine double-tap — two
    // requests in flight before the first resolves, or the same rider on two
    // devices — makes the loser violate the primary key and 500. The key is
    // still the guarantee; this just means the redundant request reports the
    // truth instead of an error.
    const inserted = await tx
      .insert(feedbackVotes)
      .values({ feedbackId, userId })
      .onConflictDoNothing()
      .returning({ userId: feedbackVotes.userId })

    if (!inserted.length) {
      // Someone else's identical request won. The vote exists, so report it as
      // cast and read the count rather than incrementing it a second time.
      const [row] = await tx.select({ wantCount: feedback.wantCount }).from(feedback).where(eq(feedback.id, feedbackId))
      return { wanted: true, count: row?.wantCount ?? 0 }
    }

    const [row] = await tx
      .update(feedback)
      .set({ wantCount: sql`${feedback.wantCount} + 1`, updatedAt: new Date() })
      .where(eq(feedback.id, feedbackId))
      .returning({ wantCount: feedback.wantCount })
    return { wanted: true, count: row?.wantCount ?? 0 }
  })
}

export type BoardSort = 'wanted' | 'new' | 'shipped'

export type BoardRow = {
  id: number
  publicId: string
  kind: FeedbackKind
  status: FeedbackStatus
  title: string | null
  body: string
  publicResponse: string | null
  wantCount: number
  authorId: number
  authorName: string
  publishedAt: Date | null
}

const BOARD_COLUMNS = {
  id: feedback.id,
  publicId: feedback.publicId,
  kind: feedback.kind,
  status: feedback.status,
  title: feedback.title,
  body: feedback.body,
  publicResponse: feedback.publicResponse,
  wantCount: feedback.wantCount,
  authorId: feedback.authorId,
  authorName: users.displayName,
  publishedAt: feedback.publishedAt,
}

/**
 * The public board: published ideas only.
 *
 * `state = 'published'` is the whole gate, and it is applied HERE rather than
 * left to the caller. Every other read in this module hands visibility back to
 * `visibleTo` in policy.ts because the caller knows who is asking — but this one
 * answers the same for everybody, so a caller that forgot the filter would put
 * a rider's pending bug on a public page. The one place a query should decide.
 *
 * Bugs are excluded even when published. A published bug is a known-issue
 * banner, not a thing riders vote on; `KIND_META.bug.wantable` says the same
 * and `canWant` enforces it on the write side.
 */
export async function listBoard(sort: BoardSort = 'wanted', limit = 100): Promise<BoardRow[]> {
  const order =
    sort === 'new'
      ? [desc(feedback.publishedAt)]
      : sort === 'shipped'
        ? [desc(feedback.updatedAt)]
        : // Newest breaks a tie, so two ideas on one want do not swap places
          // between renders — a list that reorders itself on refresh reads as
          // broken even when the data is right.
          [desc(feedback.wantCount), desc(feedback.publishedAt)]

  return db
    .select(BOARD_COLUMNS)
    .from(feedback)
    .innerJoin(users, eq(users.id, feedback.authorId))
    .where(and(eq(feedback.state, 'published'), eq(feedback.kind, 'idea')))
    .orderBy(...order)
    .limit(limit)
}

/**
 * What has shipped lately, for the strip at the top of the board.
 *
 * **This strip is permanent, not decoration.** It is the proof that sending
 * something works, and it is what earns the next report — a board that only
 * ever shows a growing list of requests reads as a suggestion box nobody empties.
 */
export async function listShipped(limit = 5): Promise<BoardRow[]> {
  return db
    .select(BOARD_COLUMNS)
    .from(feedback)
    .innerJoin(users, eq(users.id, feedback.authorId))
    .where(and(eq(feedback.state, 'published'), eq(feedback.status, 'shipped')))
    .orderBy(desc(feedback.updatedAt))
    .limit(limit)
}

/**
 * Fold one report into another: transfer its wants, then mark it a duplicate.
 *
 * **The wants are deduplicated BY RIDER, and that is the whole difficulty.** A
 * rider who wanted the original and also wanted the duplicate is one rider who
 * wants the thing, not two — and a naive transfer would inflate the top of the
 * board by exactly the number of people enthusiastic enough to have voted twice,
 * which is the worst possible set to double-count.
 *
 * `INSERT ... SELECT ... ON CONFLICT DO NOTHING` does it in one statement: the
 * composite primary key on feedback_votes IS the dedupe, so there is no
 * rider-set arithmetic in application code that could be subtly wrong. The
 * counts are then recomputed from the rows rather than adjusted arithmetically,
 * because "how many rows are there" cannot drift and "add the ones that were
 * new" can.
 *
 * The duplicate keeps its own vote rows. They are inert — a duplicate is not on
 * the board and cannot be wanted — and keeping them is what makes the merge
 * reversible if it turns out to have been wrong.
 */
export async function mergeDuplicate(duplicateId: number, originalId: number): Promise<FeedbackRow | null> {
  // A report cannot be a duplicate of itself; the self-referencing foreign key
  // would accept it and every reader would then have a cycle.
  if (duplicateId === originalId) return null

  return db.transaction(async (tx) => {
    const [original] = await tx.select().from(feedback).where(eq(feedback.id, originalId)).limit(1)
    if (!original) return null

    await tx.execute(sql`
      insert into ${feedbackVotes} (feedback_id, user_id, created_at)
      select ${originalId}, ${feedbackVotes.userId}, ${feedbackVotes.createdAt}
      from ${feedbackVotes}
      where ${feedbackVotes.feedbackId} = ${duplicateId}
      on conflict do nothing
    `)

    const recount = (id: number) =>
      sql`(select count(*)::int from ${feedbackVotes} where ${feedbackVotes.feedbackId} = ${id})`

    await tx
      .update(feedback)
      .set({ wantCount: recount(originalId), updatedAt: new Date() })
      .where(eq(feedback.id, originalId))

    const [dup] = await tx
      .update(feedback)
      .set({
        state: 'duplicate',
        duplicateOf: originalId,
        wantCount: recount(duplicateId),
        updatedAt: new Date(),
      })
      .where(eq(feedback.id, duplicateId))
      .returning()

    return dup ?? null
  })
}

/** Which of these reports this rider has already wanted, so the board can render
 *  every button in its right state from one query rather than N. */
export async function wantedBy(userId: number, feedbackIds: number[]): Promise<Set<number>> {
  if (!feedbackIds.length) return new Set()
  // `inArray`, not a hand-written `= any(...)`. Interpolating a JS array into a
  // sql`` template expands it to a tuple — `any(($2, $3, $4))` — which is not
  // valid SQL and fails at runtime with no type error to warn you. Caught on the
  // first real render of the board.
  const rows = await db
    .select({ feedbackId: feedbackVotes.feedbackId })
    .from(feedbackVotes)
    .where(and(eq(feedbackVotes.userId, userId), inArray(feedbackVotes.feedbackId, feedbackIds)))
  return new Set(rows.map((r) => r.feedbackId))
}
