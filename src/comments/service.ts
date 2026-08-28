// Comments, query side. The rules are in ./policy.ts and nothing here re-decides
// one.
//
// EVERY WRITE RE-READS THE VIEWER'S OWN ROSTER ROW FIRST, the same arrangement
// src/members/service.ts has: a page renders a Delete link from a roster it read
// a moment ago, and the roster can change between the render and the press.
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db/index'
import { rideComments, users, type RideCommentRow } from '../db/schema'
import { membershipOf } from '../members/service'
import { canDelete, canPost, canResolve, cleanBody, orphanedComments, type CommentFields } from './policy'
import type { Tx } from '../maps/ride-graph'

export type CommentView = CommentFields & {
  body: string
  pointLabel: string | null
  createdAt: Date
  authorName: string
  authorHandle: string | null
}

/** Every comment on a ride, oldest first, with its author. One query — a ride's
 *  comments are counted in dozens, so there is nothing here to paginate. */
export async function commentsOn(rideId: number): Promise<CommentView[]> {
  return db
    .select({
      id: rideComments.id,
      authorId: rideComments.authorId,
      pointUid: rideComments.pointUid,
      pointLabel: rideComments.pointLabel,
      body: rideComments.body,
      resolvedAt: rideComments.resolvedAt,
      createdAt: rideComments.createdAt,
      authorName: users.displayName,
      authorHandle: users.username,
    })
    .from(rideComments)
    .innerJoin(users, eq(users.id, rideComments.authorId))
    .where(eq(rideComments.rideId, rideId))
    .orderBy(asc(rideComments.createdAt))
}

export type PostResult = { ok: true; id: number } | { ok: false; reason: 'refused' | 'empty' }

/**
 * Say something about a ride, or about one point on it.
 *
 * `pointLabel` is copied in by the CALLER, from what the point is named right
 * now, and is never updated afterwards. That is what keeps a comment readable
 * once its point is deleted and the anchor is cleared — see the table's own
 * comment in schema.ts. A caller that passes null for a point-level comment is
 * not wrong, only unhelpful later.
 */
export async function postComment(
  rideId: number,
  viewerId: number,
  body: unknown,
  anchor: { pointUid: string | null; pointLabel: string | null },
): Promise<PostResult> {
  const viewer = await membershipOf(rideId, viewerId)
  if (!canPost(viewer)) return { ok: false, reason: 'refused' }
  const text = cleanBody(body)
  if (text === null) return { ok: false, reason: 'empty' }
  const [row] = await db
    .insert(rideComments)
    .values({
      rideId,
      authorId: viewerId,
      pointUid: anchor.pointUid,
      pointLabel: anchor.pointLabel,
      body: text,
    })
    .returning({ id: rideComments.id })
  return { ok: true, id: row.id }
}

/** One comment, as the pure rules want it. Scoped to the ride so a forged id
 *  from another ride resolves to nothing rather than to a row the viewer has
 *  standing over here. */
async function commentRow(rideId: number, id: number): Promise<CommentFields | null> {
  const [row] = await db
    .select({
      id: rideComments.id,
      authorId: rideComments.authorId,
      pointUid: rideComments.pointUid,
      resolvedAt: rideComments.resolvedAt,
    })
    .from(rideComments)
    .where(and(eq(rideComments.rideId, rideId), eq(rideComments.id, id)))
    .limit(1)
  return row ?? null
}

/** Withdraw a comment. The author, or an owner — see canDelete. */
export async function deleteComment(rideId: number, viewerId: number, id: number): Promise<boolean> {
  const [viewer, row] = await Promise.all([membershipOf(rideId, viewerId), commentRow(rideId, id)])
  if (!row || !canDelete(viewer, row)) return false
  await db.delete(rideComments).where(and(eq(rideComments.rideId, rideId), eq(rideComments.id, id)))
  return true
}

/** Close a comment, or reopen it. A timestamp rather than a flag, so the record
 *  says when. */
export async function resolveComment(
  rideId: number,
  viewerId: number,
  id: number,
  open: boolean,
): Promise<boolean> {
  const [viewer, row] = await Promise.all([membershipOf(rideId, viewerId), commentRow(rideId, id)])
  if (!row || !canResolve(viewer, row)) return false
  await db
    .update(rideComments)
    .set({ resolvedAt: open ? null : new Date(), updatedAt: new Date() })
    .where(and(eq(rideComments.rideId, rideId), eq(rideComments.id, id)))
  return true
}

/**
 * Clear the anchor on every comment whose point left the payload.
 *
 * **THIS IS A DEMOTION AND NOT A DELETION, AND THAT IS THE WHOLE POINT OF IT.**
 * Called from insertRideGraph beside reconcileVotes() and writePointDetails(),
 * which both DELETE what has lost its uid — correctly, because those are data
 * about a point. A comment is a thing a person said, so this sets `point_uid`
 * to null and leaves the row where it is. `point_label` was written at post time
 * and still says which stop it was about.
 *
 * Skipping this call does not lose anything, unlike skipping the other two: it
 * strands comments pointing at uids that no longer resolve, which renders as a
 * comment about nothing. Cheap to run, so it runs on every save.
 */
export async function demoteOrphanComments(tx: Tx, rideId: number, liveUids: string[]): Promise<void> {
  const rows = await tx
    .select({
      id: rideComments.id,
      authorId: rideComments.authorId,
      pointUid: rideComments.pointUid,
      resolvedAt: rideComments.resolvedAt,
    })
    .from(rideComments)
    // EVERY comment, not only the open ones. A resolved comment left anchored to
    // a uid that no longer resolves is a comment about nothing, and closing one
    // is not agreeing to lose track of what it was about.
    .where(eq(rideComments.rideId, rideId))
  const doomed = orphanedComments(rows, liveUids)
  if (doomed.length === 0) return
  // inArray and never a raw `= any(...)` over a JS array — drizzle expands an
  // array into a tuple, which is not valid SQL there and fails at runtime with
  // no type error. See AGENTS.md.
  await tx.update(rideComments).set({ pointUid: null }).where(inArray(rideComments.id, doomed))
}

/** How many open comments a ride has, for the count on the builder's control.
 *  Resolved ones are excluded — a badge that never comes down is a badge nobody
 *  reads. */
export async function openCommentCount(rideId: number): Promise<number> {
  const rows = await db
    .select({ id: rideComments.id })
    .from(rideComments)
    .where(and(eq(rideComments.rideId, rideId), isNull(rideComments.resolvedAt)))
  return rows.length
}

export type { RideCommentRow }
