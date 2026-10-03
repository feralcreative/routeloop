// Who may follow whom, as pure functions.
//
// The house split: this file holds the RULES and ./service.ts holds the
// queries, so the rules are testable with no database — the same arrangement as
// friends/policy.ts vs service.ts, members, votes and the rest.
//
// **FOLLOWING AND FRIENDSHIP ARE A LADDER, NOT TWO AXES** (#180, Ziad's call,
// 2026-08-27, built 2026-10-02). Following is the lower rung: you follow someone
// to pay attention to them, alone, and they are not told. Friendship is the upper
// one: a friend request asks for a MUTUAL follow, so two friends follow each
// other. Two riders who merely follow each other are not friends; friendship
// only comes from a request and an accept.
//
// THE IMPLIED FOLLOW IS DERIVED, NEVER STORED. Accepting a request writes no
// follow rows; "does A follow B" is "A has a follow row for B, or they are
// friends". So unfriending touches no follow a rider made on their own, before or
// after, and that row simply survives the friendship. Either rung can be taken
// first: a rider may request friendship without following.
//
// IT IS ABOUT ATTENTION, NOT ACCESS. canView() still does not know `follows`
// exists, and a friend's friends-level rides stay out of the follow feed, which
// shows only what /explore would.
//
// What that leaves is the one thing following DOES have to reason about, which
// is the block — and it is the reason this file exists at all rather than the
// rules living inline in the service.

/** `friends` is following by friendship: no row of the viewer's own, nothing to
 *  undo from the follow control, and the way down is unfriending. */
export type FollowView = 'none' | 'following' | 'friends'

/**
 * What the pair is, in the VIEWER's terms.
 *
 * `row` is the viewer-follows-other row, not either direction — the caller
 * knows which it asked for. There is no equivalent of friendView()'s
 * 'incoming', because being followed is not a state you are in with somebody;
 * it is a fact about them.
 */
export const followView = (row: unknown | null | undefined, friends = false): FollowView =>
  friends ? 'friends' : row ? 'following' : 'none'

/**
 * Whether this rider may follow that one.
 *
 * **A BLOCK IN EITHER DIRECTION REFUSES, AND THE ASYMMETRY OF FOLLOWING IS
 * EXACTLY WHY BOTH HALVES MATTER.** The blocker not wanting to see the blocked
 * rider is the obvious half. The other half is the load-bearing one: a rider
 * who blocked somebody must not be followed by them, or the block leaves the
 * blocked rider still watching their feed — which is the one thing a block is
 * for stopping.
 *
 * Self-follow is refused here as well as by `ck_follow_not_self`. The check
 * constraint is the backstop that cannot be forgotten; this is the one that
 * answers without a round trip and without a 500.
 */
export function canFollow(o: { viewerId: number; targetId: number; blocked: boolean; already: boolean }): boolean {
  if (o.viewerId === o.targetId) return false
  if (o.blocked) return false
  return !o.already
}

/** Whether this rider may stop following that one. Only if they are.
 *
 *  UNFOLLOW IS NOT GATED ON THE BLOCK, and that is deliberate rather than an
 *  oversight: a blocked pair's rows are removed when the block is made, but a
 *  row that survived one somehow must still be removable by the follower. The
 *  mirror of friends/policy.ts, where a BLOCKED rider may not remove the row —
 *  opposite answers, because there the row is the block itself and here it is
 *  not. */
export const canUnfollow = (view: FollowView): boolean => view === 'following'

/** Whether the follow control is shown at all. Beside a friend it is not: they
 *  are followed by being a friend, and unfollowing a friend is not offered. */
export const showsFollowControl = (view: FollowView): boolean => view !== 'friends'

/**
 * Whether a follow may be RECORDED at all, given both riders' standing.
 *
 * A pending or leaving account is not a rider: they cannot be reached, their
 * rides are already dark on every list, and a follow of one is a row that can
 * only ever produce an empty feed. The same predicate `/riders` filters its
 * listing with, stated here so the write agrees with what the page offered.
 */
export const isFollowable = (target: { status: string; deletionRequestedAt: Date | null; isGuide?: boolean }): boolean =>
  target.status === 'active' && target.deletionRequestedAt === null && target.isGuide !== true
