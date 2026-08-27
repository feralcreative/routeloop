// Who may follow whom, as pure functions.
//
// The house split: this file holds the RULES and ./service.ts holds the
// queries, so the rules are testable with no database — the same arrangement as
// friends/policy.ts vs service.ts, members, votes and the rest.
//
// **A FOLLOW IS NOT A FRIENDSHIP AND THIS FILE IS SHORT BECAUSE OF IT.**
// friends/policy.ts is a state machine — none, sent, incoming, friends,
// blocked, blocked-by — because a friendship is negotiated. A follow is not
// negotiated: it exists or it does not, the follower decides alone, and the
// followee is never asked. So there are two states and no verbs beyond follow
// and unfollow.
//
// What that leaves is the one thing following DOES have to reason about, which
// is the block — and it is the reason this file exists at all rather than the
// rules living inline in the service.

/** The two states. `following` or not; there is nothing in between. */
export type FollowView = 'none' | 'following'

/**
 * What the pair is, in the VIEWER's terms.
 *
 * `row` is the viewer-follows-other row, not either direction — the caller
 * knows which it asked for. There is no equivalent of friendView()'s
 * 'incoming', because being followed is not a state you are in with somebody;
 * it is a fact about them.
 */
export const followView = (row: unknown | null | undefined): FollowView => (row ? 'following' : 'none')

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

/**
 * Whether a follow may be RECORDED at all, given both riders' standing.
 *
 * A pending or leaving account is not a rider: they cannot be reached, their
 * rides are already dark on every list, and a follow of one is a row that can
 * only ever produce an empty feed. The same predicate `/riders` filters its
 * listing with, stated here so the write agrees with what the page offered.
 */
export const isFollowable = (target: { status: string; deletionRequestedAt: Date | null }): boolean =>
  target.status === 'active' && target.deletionRequestedAt === null
