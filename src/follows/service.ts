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

/** Whether two riders are friends. friendships holds one row per pair under
 *  rider_a < rider_b, so the pair is ordered before it is asked. */
async function friendsBetween(one: number, other: number): Promise<boolean> {
  const [a, b] = one < other ? [one, other] : [other, one]
  const [row] = await db
    .select({ id: friendships.id })
    .from(friendships)
    .where(and(eq(friendships.riderA, a), eq(friendships.riderB, b), eq(friendships.status, 'accepted')))
    .limit(1)
  return Boolean(row)
}

/** The riders this one is friends with, as a subquery of ids. The implied half of
 *  every "who does this rider follow" below (#180). */
const friendIdsOf = (riderId: number) =>
  sql`(select case when ${friendships.riderA} = ${riderId} then ${friendships.riderB} else ${friendships.riderA} end
       from ${friendships}
       where ${friendships.status} = 'accepted' and (${friendships.riderA} = ${riderId} or ${friendships.riderB} = ${riderId}))`

/** Every rider this one follows, by a row of their own or by friendship. */
export const followeeIdsOf = (riderId: number) =>
  sql`(select ${follows.followeeId} from ${follows} where ${follows.followerId} = ${riderId} union ${friendIdsOf(riderId)})`

/** Does the viewer follow this rider? What a page renders a button from. */
export async function followViewOf(viewerId: number, targetId: number): Promise<FollowView> {
  if (viewerId === targetId) return 'none'
  const [[row], friends] = await Promise.all([
    db
      .select({ id: follows.id })
      .from(follows)
      .where(and(eq(follows.followerId, viewerId), eq(follows.followeeId, targetId)))
      .limit(1),
    friendsBetween(viewerId, targetId),
  ])
  return followView(row, friends)
}

/**
 * The same question in bulk, for /riders: one query for up to 200 riders rather
 * than 200 queries. Ids missing from the set are not followed.
 *
 * A Set rather than the Map friends/service.ts returns, because there are two
 * states here and membership IS the answer — a map to a two-member union would
 * be a map to a boolean spelled at length.
 */
export async function followViewsOf(viewerId: number, targetIds: number[]): Promise<Map<number, FollowView>> {
  const out = new Map<number, FollowView>()
  if (targetIds.length === 0) return out
  const [rows, friendRows] = await Promise.all([
    db
      .select({ followeeId: follows.followeeId })
      .from(follows)
      .where(and(eq(follows.followerId, viewerId), inArray(follows.followeeId, targetIds))),
    db
      .select({ a: friendships.riderA, b: friendships.riderB })
      .from(friendships)
      .where(
        and(
          eq(friendships.status, 'accepted'),
          or(
            and(eq(friendships.riderA, viewerId), inArray(friendships.riderB, targetIds)),
            and(eq(friendships.riderB, viewerId), inArray(friendships.riderA, targetIds)),
          ),
        ),
      ),
  ])
  for (const r of rows) out.set(r.followeeId, 'following')
  for (const f of friendRows) out.set(f.a === viewerId ? f.b : f.a, 'friends')
  return out
}

/** Start following. Idempotent at the database through uq_follow_pair, and
 *  checked here first so a second press is a no-op rather than a 500. */
export async function followRider(viewerId: number, targetId: number): Promise<boolean> {
  const [target] = await db
    .select({ status: users.status, deletionRequestedAt: users.deletionRequestedAt, isGuide: users.isGuide })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1)
  if (!target || !isFollowable(target)) return false

  const [blocked, view] = await Promise.all([blockedBetween(viewerId, targetId), followViewOf(viewerId, targetId)])
  // A friend is already followed, by the friendship; there is no row to add.
  if (!canFollow({ viewerId, targetId, blocked, already: view !== 'none' })) return false

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

/** How many riders follow this one, and how many they follow, friends counted
 *  once on each side (#180): friendship is a mutual follow. For a profile. */
export async function followCounts(riderId: number): Promise<{ followers: number; following: number }> {
  const res = await db.execute<{ followers: number; following: number }>(sql`
    select
      (select count(*)::int from (select ${follows.followerId} from ${follows} where ${follows.followeeId} = ${riderId}
         union ${friendIdsOf(riderId)}) f) as followers,
      (select count(*)::int from ${followeeIdsOf(riderId)} g) as following`)
  const row = res.rows[0]
  return { followers: Number(row?.followers ?? 0), following: Number(row?.following ?? 0) }
}

/** Whether this rider follows anybody at all. What the dashboard asks to decide
 *  whether the Following tab has anything to say. */
export async function followsAnyone(viewerId: number): Promise<boolean> {
  const res = await db.execute<{ any: boolean }>(sql`select exists ${followeeIdsOf(viewerId)} as any`)
  return Boolean(res.rows[0]?.any)
}
