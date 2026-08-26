// What a friendship is, from either rider's side.
//
// Pure — a function of one row plus who is looking — so it is testable under
// the house rule that governs test/. The queries live in ./service.ts, the same
// split as invites/policy.ts vs service.ts.
//
// THE HARD PART IS THAT THE ROW HAS NO SIDES. There is one row per pair under
// a canonical ordering (`rider_a < rider_b`, enforced by ck_friendship_order in
// the schema), which is what makes "are these two friends" a single lookup that
// cannot disagree with itself. The cost is that the columns no longer say who
// asked or who blocked — `requested_by` and `blocked_by` carry that — and every
// rider-facing surface has to translate the row into the viewer's own terms
// before it can render a button. That translation is friendView(), and it is
// the reason this module exists rather than the rules living in a route.

import type { FriendshipRow } from '../db/schema'

/** A rider cannot befriend themselves, and pairOf() is where that is caught. */
export class SelfFriendshipError extends Error {
  constructor() {
    super('A rider cannot befriend themselves')
    this.name = 'SelfFriendshipError'
  }
}

/**
 * The canonical ordering. Every read and every write goes through this, so no
 * caller ever has to remember which of two ids goes in which column.
 *
 * Throws rather than returning null on a self-pair: there is no sensible row to
 * write, the database would refuse it anyway (the check constraint is `<`, not
 * `<=`), and a caller that silently did nothing would leave a Add Friend button
 * that appears to work.
 */
export function pairOf(one: number, other: number): { riderA: number; riderB: number } {
  if (one === other) throw new SelfFriendshipError()
  return one < other ? { riderA: one, riderB: other } : { riderA: other, riderB: one }
}

/**
 * The state of a friendship AS THE VIEWER SEES IT. Six values, and the pairs
 * are deliberately not collapsed:
 *
 *   'none'          no row, or a row that has been withdrawn
 *   'sent'          the viewer asked and is waiting
 *   'incoming'      the other rider asked; the viewer has Accept and Decline
 *   'friends'       accepted, both ways
 *   'blocked'       the viewer blocked them and may undo it
 *   'blocked-by'    they blocked the viewer, who may not undo it and is not told
 *
 * 'sent' and 'incoming' are one status in the database and two states here
 * because they render as completely different things. 'blocked' and
 * 'blocked-by' likewise: only one of the two riders can lift a block, and a row
 * that could not tell them apart is exactly what blocked_by exists to prevent.
 */
export type FriendView = 'none' | 'sent' | 'incoming' | 'friends' | 'blocked' | 'blocked-by'

/** Only the fields the rules read, so a test does not have to build a whole row. */
export type FriendshipFields = Pick<FriendshipRow, 'riderA' | 'riderB' | 'status' | 'requestedBy' | 'blockedBy'>

/** Narrower still, for the two rules that only ask WHETHER — a grant lookup
 *  selects one column and should not have to fetch four more to be read. */
export type FriendStatusOnly = Pick<FriendshipRow, 'status'>

export function friendView(row: FriendshipFields | null | undefined, viewerId: number): FriendView {
  if (!row) return 'none'
  switch (row.status) {
    case 'accepted':
      return 'friends'
    case 'pending':
      return row.requestedBy === viewerId ? 'sent' : 'incoming'
    case 'blocked':
      // A row stamped 'blocked' with nobody named as the blocker should not
      // exist. Reading it as 'blocked-by' is the defensive answer: it lets
      // neither rider act on a half-written row, which is better than handing
      // both of them an Unblock button. Same reading trashState() gives a row
      // with deleted_at set but no purge_after.
      return row.blockedBy === viewerId ? 'blocked' : 'blocked-by'
  }
}

/**
 * Whether the viewer may send a request. True only from 'none' — everything
 * else already has a row, and a second request would either be a duplicate the
 * unique index refuses or a way to nag someone who blocked you.
 *
 * Note that 'blocked-by' is refused here and the CALLER must not say why. The
 * rider is told the request could not be sent, not that they are blocked;
 * telling them is how a block becomes a notification.
 */
export const canRequest = (view: FriendView): boolean => view === 'none'

/** Only the rider who did not ask can accept. 'sent' is refused, which is what
 *  stops a request being self-accepted by replaying the accept endpoint. */
export const canAccept = (view: FriendView): boolean => view === 'incoming'

/**
 * Withdrawing a request you sent, declining one you received, and unfriending
 * are ONE operation on the row — the row goes away — and one rule here.
 *
 * Blocked is excluded on purpose in both directions. The blocker must use
 * unblock, so that lifting a block is a deliberate act rather than a side
 * effect of a Remove button; the blocked rider must not be able to delete the
 * row at all, or a block would last exactly as long as it took them to press it.
 */
export const canRemove = (view: FriendView): boolean => view === 'sent' || view === 'incoming' || view === 'friends'

/**
 * Blocking is reachable from every state except one already blocked by the
 * other rider — including 'none', because the whole point of a block is that it
 * does not require a prior relationship. Blocking from 'none' writes a row
 * where there was none.
 */
export const canBlock = (view: FriendView): boolean => view !== 'blocked' && view !== 'blocked-by'

/** Only the blocker, and it returns the pair to 'none' rather than to whatever
 *  they were before. Restoring a friendship somebody blocked would be a
 *  surprise; asking again is one button. */
export const canUnblock = (view: FriendView): boolean => view === 'blocked'

/**
 * Whether this row grants the `friends` visibility level.
 *
 * ACCEPTED ONLY. A pending request grants nothing, which is the point — if it
 * did, "add friend" would be a way to read a stranger's friends-only rides
 * while they had not yet answered.
 */
export const areFriends = (row: FriendStatusOnly | null | undefined): boolean => row?.status === 'accepted'

/**
 * Whether the two riders may interact at all: appear in each other's roster
 * search, be invited onto a ride, be shown as a friend of a friend.
 *
 * A block is symmetric for this purpose even though only one of them chose it.
 */
export const isBlocked = (row: FriendStatusOnly | null | undefined): boolean => row?.status === 'blocked'
