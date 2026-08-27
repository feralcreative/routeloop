// Following, query side. The rules are in ./policy.ts and nothing here
// re-decides one.
//
// EVERY WRITE RE-READS, the same discipline friends/service.ts keeps and for
// the same reason: a page renders a Follow button from a row it read a moment
// ago, and the standing can change between the render and the press — the other
// rider blocks you, or deletes their account.
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { follows, friendships, users } from '../db/schema'
import { canFollow, canUnfollow, followView, isFollowable, type FollowView } from './policy'

/** Whether either rider has blocked the other. One query, both directions —
 *  `friendships` holds one row per pair, so a block is a status on it whichever
 *  way round the pair was created. */
async function blockedBetween(one: number, other: number): Promise<boolean> {
  const [row] = await db
    .select({ id: friendships.id })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, 'blocked'),
        or(
          and(eq(friendships.riderA, one), eq(friendships.riderB, other)),
          and(eq(friendships.riderB, one), eq(friendships.riderA, other)),
        ),
      ),
    )
    .limit(1)
  return Boolean(row)
}

/** Does the viewer follow this rider? What a page renders a button from. */
export async function followViewOf(viewerId: number, targetId: number): Promise<FollowView> {
  if (viewerId === targetId) return 'none'
  const [row] = await db
    .select({ id: follows.id })
    .from(follows)
    .where(and(eq(follows.followerId, viewerId), eq(follows.followeeId, targetId)))
    .limit(1)
  return followView(row)
}

/**
 * The same question in bulk, for /riders: one query for up to 200 riders rather
 * than 200 queries. Ids missing from the set are not followed.
 *
 * A Set rather than the Map friends/service.ts returns, because there are two
 * states here and membership IS the answer — a map to a two-member union would
 * be a map to a boolean spelled at length.
 */
export async function followingSet(viewerId: number, targetIds: number[]): Promise<Set<number>> {
  if (targetIds.length === 0) return new Set()
  const rows = await db
    .select({ followeeId: follows.followeeId })
    .from(follows)
    .where(and(eq(follows.followerId, viewerId), inArray(follows.followeeId, targetIds)))
  return new Set(rows.map((r) => r.followeeId))
}

/** Start following. Idempotent at the database through uq_follow_pair, and
 *  checked here first so a second press is a no-op rather than a 500. */
export async function followRider(viewerId: number, targetId: number): Promise<boolean> {
  const [target] = await db
    .select({ status: users.status, deletionRequestedAt: users.deletionRequestedAt })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1)
  if (!target || !isFollowable(target)) return false

  const [blocked, view] = await Promise.all([blockedBetween(viewerId, targetId), followViewOf(viewerId, targetId)])
  if (!canFollow({ viewerId, targetId, blocked, already: view === 'following' })) return false

  await db.insert(follows).values({ followerId: viewerId, followeeId: targetId }).onConflictDoNothing()
  return true
}

/** Stop following. */
export async function unfollowRider(viewerId: number, targetId: number): Promise<boolean> {
  const view = await followViewOf(viewerId, targetId)
  if (!canUnfollow(view)) return false
  await db.delete(follows).where(and(eq(follows.followerId, viewerId), eq(follows.followeeId, targetId)))
  return true
}

/**
 * Tear down both directions of a follow between two riders.
 *
 * **CALLED WHEN A BLOCK IS MADE, and skipping it defeats the block.** A block
 * that left the rows standing would leave the blocked rider still watching the
 * blocker's feed — which is the one thing a block exists to stop — and the
 * blocker still watching theirs. Both rows go, because a block is not a
 * direction.
 *
 * Idempotent, and it deletes rather than refusing: there is nothing to report,
 * and a block must not fail because a follow did not exist.
 */
export async function dropFollowsBetween(one: number, other: number): Promise<void> {
  await db
    .delete(follows)
    .where(
      or(
        and(eq(follows.followerId, one), eq(follows.followeeId, other)),
        and(eq(follows.followerId, other), eq(follows.followeeId, one)),
      ),
    )
}

/** How many riders follow this one, and how many they follow. For a profile. */
export async function followCounts(riderId: number): Promise<{ followers: number; following: number }> {
  const [row] = await db
    .select({
      followers: sql<number>`count(*) filter (where ${follows.followeeId} = ${riderId})::int`,
      following: sql<number>`count(*) filter (where ${follows.followerId} = ${riderId})::int`,
    })
    .from(follows)
    .where(or(eq(follows.followeeId, riderId), eq(follows.followerId, riderId)))
  return { followers: row?.followers ?? 0, following: row?.following ?? 0 }
}

/** Whether this rider follows anybody at all. What the dashboard asks to decide
 *  whether the Following tab has anything to say. */
export async function followsAnyone(viewerId: number): Promise<boolean> {
  const [row] = await db.select({ id: follows.id }).from(follows).where(eq(follows.followerId, viewerId)).limit(1)
  return Boolean(row)
}
