// Friendships, query side. The rules are in ./policy.ts and nothing here
// re-decides one — every write reads the current row, asks policy whether the
// verb is allowed from that state, and refuses otherwise.
//
// WHY EVERY WRITE RE-READS. A rider-facing surface renders a button from a row
// it read a moment ago, and the row can change between the render and the
// press: the other rider accepts, withdraws, or blocks. So the button is a
// hint and the check on submit is the decision. Without that, an Accept
// rendered before a block arrived would accept a friendship the blocker had
// already ended.
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { friendships, users, type FriendshipRow } from '../db/schema'
import { canAccept, canBlock, canRemove, canRequest, canUnblock, friendView, pairOf, type FriendView } from './policy'

/** What every verb hands back. `ok: false` carries the state that refused it,
 *  so a caller can render "already friends" rather than a bare failure — with
 *  the one exception below, which must not. */
export type FriendResult = { ok: true; view: FriendView } | { ok: false; view: FriendView }

/**
 * The row for a pair, or undefined. Goes through pairOf so no caller has to
 * know which of the two ids is in which column.
 */
export async function friendshipBetween(one: number, other: number): Promise<FriendshipRow | undefined> {
  const { riderA, riderB } = pairOf(one, other)
  const [row] = await db
    .select()
    .from(friendships)
    .where(and(eq(friendships.riderA, riderA), eq(friendships.riderB, riderB)))
    .limit(1)
  return row
}

/** The pair's state in the viewer's own terms. What a page renders a button from. */
export async function viewOf(viewerId: number, otherId: number): Promise<FriendView> {
  if (viewerId === otherId) return 'none'
  return friendView(await friendshipBetween(viewerId, otherId), viewerId)
}

/**
 * The same question in bulk, for the roster: one query for up to 200 riders
 * rather than 200 queries.
 *
 * Returns a Map keyed by the OTHER rider's id. Ids missing from it have no row,
 * which friendView reads as 'none' — so a caller reads the map with a default
 * rather than checking for a hit.
 */
export async function viewsOf(viewerId: number, otherIds: number[]): Promise<Map<number, FriendView>> {
  const out = new Map<number, FriendView>()
  if (otherIds.length === 0) return out
  const rows = await db
    .select()
    .from(friendships)
    .where(
      or(
        and(eq(friendships.riderA, viewerId), inArray(friendships.riderB, otherIds)),
        and(eq(friendships.riderB, viewerId), inArray(friendships.riderA, otherIds)),
      ),
    )
  for (const row of rows) {
    out.set(row.riderA === viewerId ? row.riderB : row.riderA, friendView(row, viewerId))
  }
  return out
}

const touch = (id: number, set: Partial<FriendshipRow>) =>
  db
    .update(friendships)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(friendships.id, id))

/**
 * Send a request.
 *
 * THE REFUSAL HERE MUST NOT SAY WHY. If the other rider has blocked this one,
 * `view` comes back 'blocked-by' and the caller has to render the same neutral
 * "could not send" it would render for any other refusal. Telling them is how a
 * block becomes a notification, which is the one thing a block must never be.
 */
export async function requestFriend(viewerId: number, otherId: number): Promise<FriendResult> {
  const view = await viewOf(viewerId, otherId)
  if (!canRequest(view)) return { ok: false, view }
  const pair = pairOf(viewerId, otherId)
  await db.insert(friendships).values({ ...pair, status: 'pending', requestedBy: viewerId })
  return { ok: true, view: 'sent' }
}

/** Accept a request. Only the rider who did not ask can — canAccept refuses
 *  'sent', which is what stops this endpoint being replayed to self-accept. */
export async function acceptFriend(viewerId: number, otherId: number): Promise<FriendResult> {
  const row = await friendshipBetween(viewerId, otherId)
  const view = friendView(row, viewerId)
  if (!row || !canAccept(view)) return { ok: false, view }
  await touch(row.id, { status: 'accepted' })
  return { ok: true, view: 'friends' }
}

/**
 * Withdraw, decline, or unfriend — one operation, because all three are the row
 * going away and the difference is only which button the rider pressed.
 *
 * A blocked pair is refused in both directions: the blocker uses unblock, and
 * the blocked rider cannot delete the row at all or a block would last exactly
 * as long as it took them to press Remove.
 */
export async function removeFriend(viewerId: number, otherId: number): Promise<FriendResult> {
  const row = await friendshipBetween(viewerId, otherId)
  const view = friendView(row, viewerId)
  if (!row || !canRemove(view)) return { ok: false, view }
  await db.delete(friendships).where(eq(friendships.id, row.id))
  return { ok: true, view: 'none' }
}

/**
 * Block. Reachable from nothing at all, which is the point — blocking must not
 * require having been friends first — so this is the one verb that inserts when
 * there is no row and updates when there is.
 */
export async function blockRider(viewerId: number, otherId: number): Promise<FriendResult> {
  const row = await friendshipBetween(viewerId, otherId)
  const view = friendView(row, viewerId)
  if (!canBlock(view)) return { ok: false, view }
  if (row) {
    await touch(row.id, { status: 'blocked', blockedBy: viewerId })
  } else {
    const pair = pairOf(viewerId, otherId)
    await db.insert(friendships).values({ ...pair, status: 'blocked', requestedBy: viewerId, blockedBy: viewerId })
  }
  return { ok: true, view: 'blocked' }
}

/**
 * Unblock, and the pair lands at 'none' rather than back where it was. Restoring
 * a friendship somebody chose to block would be a surprise; asking again is one
 * button.
 */
export async function unblockRider(viewerId: number, otherId: number): Promise<FriendResult> {
  const row = await friendshipBetween(viewerId, otherId)
  const view = friendView(row, viewerId)
  if (!row || !canUnblock(view)) return { ok: false, view }
  await db.delete(friendships).where(eq(friendships.id, row.id))
  return { ok: true, view: 'none' }
}

export type RiderCard = { id: number; displayName: string; username: string }

/**
 * The three lists the friends page renders, in one round trip each.
 *
 * The join is on "whichever column is not the viewer", which is the price of one
 * row per pair — sql`case` rather than two queries UNIONed, because a canonical
 * pair has no near or far column and pretending otherwise is where the mirrored
 * rows come back.
 */
async function listBy(viewerId: number, where: ReturnType<typeof and>): Promise<RiderCard[]> {
  const other = sql<number>`case when ${friendships.riderA} = ${viewerId} then ${friendships.riderB} else ${friendships.riderA} end`
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, username: users.username })
    .from(friendships)
    .innerJoin(users, eq(users.id, other))
    .where(where)
    .orderBy(users.displayName)
  // A rider with no handle has no profile to link to and is not on the roster
  // either, so they cannot be here — but the column is nullable, and narrowing
  // it in the query is what keeps the template from having to.
  return rows.filter((r): r is RiderCard => r.username !== null)
}

const involves = (viewerId: number) => or(eq(friendships.riderA, viewerId), eq(friendships.riderB, viewerId))

export const listFriends = (viewerId: number) =>
  listBy(viewerId, and(involves(viewerId), eq(friendships.status, 'accepted')))

/** Requests waiting on the VIEWER to answer. The badge on the nav counts these. */
export const listIncoming = (viewerId: number) =>
  listBy(viewerId, and(involves(viewerId), eq(friendships.status, 'pending'), ne(friendships.requestedBy, viewerId)))

/** Requests the viewer sent and nobody has answered. Shown so they can withdraw. */
export const listSent = (viewerId: number) =>
  listBy(viewerId, and(involves(viewerId), eq(friendships.status, 'pending'), eq(friendships.requestedBy, viewerId)))

/** Riders the viewer blocked. Only theirs — a rider is never shown who blocked them. */
export const listBlocked = (viewerId: number) =>
  listBy(viewerId, and(involves(viewerId), eq(friendships.status, 'blocked'), eq(friendships.blockedBy, viewerId)))

/**
 * A drizzle predicate that removes both halves of every blocked pair from a
 * query over `users`.
 *
 * This is what makes a block mean something on the roster. Symmetric on
 * purpose: the blocker does not want to see them, and the blocked rider must
 * not be shown who blocked them — a roster that quietly lost one name is a
 * notification.
 */
export const notBlockedWith = (viewerId: number) =>
  sql`not exists (
    select 1 from ${friendships} f
    where f.status = 'blocked'
      and ((f.rider_a = ${viewerId} and f.rider_b = ${users.id})
        or (f.rider_b = ${viewerId} and f.rider_a = ${users.id}))
  )`
