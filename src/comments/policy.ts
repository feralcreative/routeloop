// What a rider may do about a comment, and what happens to one whose point goes
// away.
//
// Pure — a function of the comment plus who is asking — so test/comments.test.ts
// can pin it with no database. The same rule-from-query split as
// members/policy.ts vs service.ts, and it matters here for the same reason it
// matters there: this file is the whole of who can write on somebody else's
// plan, and an untested boundary is one somebody widens by accident.
import type { MemberFields } from '../members/policy'
import { canAdminister, canComment } from '../members/policy'

/** The longest a comment may be. Well past a paragraph and well short of an
 *  essay — the same job MAX_STOPS does, which is to give a column a bound
 *  rather than to express an opinion about length. Mirrors the varchar in
 *  schema.ts; the two have to agree or a rider gets a 500 for typing. */
export const MAX_COMMENT_LEN = 4000

/** Only the fields the rules read. */
export type CommentFields = {
  id: number
  authorId: number
  pointUid: string | null
  resolvedAt: Date | null
}

/**
 * Whether `viewer` may post a comment on this ride.
 *
 * **ROSTER-ONLY, NEVER LINK-BASED**, which is why this takes a member row and
 * there is deliberately no overload taking a visibility. A share link is
 * permission to SEE a route, not to write on it — the same call the roster page
 * and voting already make. A public ride would otherwise be writable by anybody
 * on the internet, with no moderation anywhere in this app to catch it.
 */
export const canPost = (viewer: MemberFields | null): boolean => canComment(viewer)

/**
 * Whether `viewer` may delete this comment.
 *
 * The author, or an owner. The author because words are theirs to withdraw; an
 * owner because it is their ride and somebody has to be able to remove abuse
 * from it. Note an `edit`-level rider may NOT — editing the route is not
 * moderating the people on it, the same line canRsvp draws one level up.
 */
export function canDelete(viewer: MemberFields | null, comment: CommentFields): boolean {
  if (viewer === null) return false
  return viewer.riderId === comment.authorId || canAdminister(viewer)
}

/**
 * Whether `viewer` may close this comment, or reopen it.
 *
 * Same two people as deletion, and deliberately not wider. Closing is the
 * gentler of the two and the reflex is to let anybody who can comment do it —
 * but a comment is a question somebody asked, and letting a third party mark it
 * answered is letting them speak for the person who asked.
 *
 * Idempotent by omission: closing a closed comment is not refused here, because
 * the caller writes a timestamp rather than toggling a flag.
 */
export const canResolve = (viewer: MemberFields | null, comment: CommentFields): boolean =>
  canDelete(viewer, comment)

/** Whether a comment is still open. `resolved_at` is a timestamp rather than a
 *  boolean so the record says WHEN, which a boolean throws away. */
export const isOpen = (c: CommentFields): boolean => c.resolvedAt === null

/**
 * A comment's body, or null if it is not one.
 *
 * Trimmed, and empty is not a comment. Length is checked against the column's
 * own bound rather than truncated: silently storing half of what somebody wrote
 * is worse than telling them it was too long.
 */
export function cleanBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const body = raw.trim()
  if (body === '' || body.length > MAX_COMMENT_LEN) return null
  return body
}

/**
 * Which of these comments have lost the point they were anchored to.
 *
 * **THE ANSWER IS A DEMOTION, NEVER A DELETION.** Called after every save with
 * the uids the payload still holds; anything anchored to a uid that is gone gets
 * its anchor cleared and stays on the ride. `point_label` is what keeps it
 * readable afterwards, which is why it is written at post time and never
 * updated.
 *
 * Ride-level comments are already unanchored and are not in the answer — there
 * is nothing to demote them to.
 */
export function orphanedComments(comments: CommentFields[], liveUids: Iterable<string>): number[] {
  const live = new Set(liveUids)
  return comments.filter((c) => c.pointUid !== null && !live.has(c.pointUid)).map((c) => c.id)
}
