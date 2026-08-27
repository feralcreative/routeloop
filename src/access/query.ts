// The database half of the access rule: the two facts canView() needs but
// cannot establish, and the one gate every route that serves a ride goes
// through.
//
// The split is the house one — ./policy.ts is pure and holds the RULE, this
// file holds the QUERIES — the same arrangement as invites/policy.ts vs
// service.ts and stats/shape.ts vs query.ts.
//
// THE VIEWER-DEPENDENT LIST ARRIVED ON 2026-08-26, and this note used to say it
// had not. It said a second implementation of the rule as a drizzle predicate
// was unnecessary, because the only two list queries in the app — /explore and
// the ride grid on a public profile — showed LISTED rides, which is a CONSTANT
// predicate (LISTED_RIDE below, derived from isListed()). That was true, and it
// ended when the dashboard grew a "Friends' rides" tab: a list whose contents
// depend on who is asking.
//
// The shape it predicted is the shape it took. friendsRides() at the foot of
// this file is the list form, FRIEND_LISTED_RIDE is its constant half derived
// from isFriendListed(), and the membership half is a join on `friendships`.
// The old note also promised the thing that keeps it honest, so:
// **test/access-lists.test.ts is the agreement test**, and it asserts that
// anything either list surfaces is something canView() would allow.

import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import { db } from '../db/index'
import {
  days as daysTable,
  follows,
  friendships,
  rideMembers,
  rides,
  users,
  visibilityEnum,
  type RideRow,
} from '../db/schema'
import { LIVE_RIDE } from '../trash/service'
import { areFriends, pairOf } from '../friends/policy'
import { canView, isFriendListed, isListed, type ViewGrants, type Viewer } from './policy'

/**
 * The levels that appear in a list nobody asked for by name.
 *
 * Derived from isListed() rather than written out as `eq(rides.visibility,
 * 'public')`, so the SQL cannot fall out of step with the boolean — there is
 * one rule and two readings of it, not two rules.
 *
 * inArray, never a JS array interpolated into a tagged `sql` template: drizzle
 * expands an array into a tuple, so a hand-written `= any(...)` over one comes
 * out as `any(($1, $2))`, which is not valid SQL and fails at runtime with no
 * type error and no test failure.
 */
export const LISTED_RIDE = inArray(rides.visibility, visibilityEnum.enumValues.filter(isListed))

/** The ride fields grantsFor() needs. `id` is here and not on ViewableRide
 *  because only the membership lookup wants it — the pure rule never does. */
type GrantSubject = { id: number; ownerId: number; visibility: RideRow['visibility'] }

/**
 * Establish the two facts about this viewer's relationship to this ride.
 *
 * Every early return here is a query NOT run, and they cover the overwhelming
 * majority of requests: an anonymous or unapproved visitor gets nothing, the
 * owner needs nothing, and a public or unlisted ride is viewable without any
 * grant at all. Only a `friends` or `private` ride viewed by a signed-in
 * stranger reaches the database, and then it is two indexed lookups in
 * parallel — idx_ride_member_rider and uq_friendship_pair.
 *
 * The membership lookup runs today knowing it will find nothing: ride_members
 * is schema only until the invite path is built. It is here rather than added
 * later so that switching membership on is a change to the service layer and
 * not a second change to the access rule.
 */
export async function grantsFor(ride: GrantSubject, viewer: Viewer): Promise<ViewGrants> {
  if (!viewer || viewer.status !== 'active') return {}
  if (viewer.id === ride.ownerId) return {}
  if (ride.visibility === 'public' || ride.visibility === 'unlisted') return {}

  const [member, friendship] = await Promise.all([
    db
      .select({ id: rideMembers.id })
      .from(rideMembers)
      .where(and(eq(rideMembers.rideId, ride.id), eq(rideMembers.riderId, viewer.id)))
      .limit(1),
    (async () => {
      const { riderA, riderB } = pairOf(viewer.id, ride.ownerId)
      return db
        .select({ status: friendships.status })
        .from(friendships)
        .where(and(eq(friendships.riderA, riderA), eq(friendships.riderB, riderB)))
        .limit(1)
    })(),
  ])

  return { isMember: member.length > 0, isFriendOfOwner: areFriends(friendship[0]) }
}

/**
 * THE gate. Every route that serves a ride by slug — the viewer, ride.json,
 * every export, the thumbnail, the roadbook, the hand-off page — comes through
 * here, and none of them decides for itself.
 *
 * It replaced three hand-rolled copies of the same four-clause test, one in
 * index.tsx and one each in handoff.tsx and roadbook.tsx. They agreed only
 * because nobody had changed the rule yet.
 *
 * Two things folded in that were previously only in the index.tsx copy, and are
 * improvements rather than incidental:
 *
 *   - A LEAVING OWNER'S RIDES GO DARK. The users join drops every ride whose
 *     owner has hit Delete Me. The roadbook and the hand-off page did not do
 *     this and now do, which is what they should always have done — those pages
 *     ARE the ride, rendered differently, and must not be a way around it.
 *   - LIVE_RIDE, so trashing a ride kills its share link on the spot.
 *
 * Not-found rather than forbidden, at every refusal. A link must not be a way
 * to learn that a ride exists.
 */
export async function viewableRide(slug: string, viewer: Viewer): Promise<RideRow | undefined> {
  if (!slug) return undefined
  const [row] = await db
    .select({ ride: rides })
    .from(rides)
    .innerJoin(users, and(eq(users.id, rides.ownerId), isNull(users.deletionRequestedAt)))
    .where(and(eq(rides.slug, slug), LIVE_RIDE))
    .limit(1)
  if (!row) return undefined

  const grants = await grantsFor(row.ride, viewer)
  return canView(row.ride, viewer, grants) ? row.ride : undefined
}

/**
 * The levels that appear in the "a friend's rides" list.
 *
 * The viewer-dependent list this file's header said would one day be wanted. The
 * membership half of it is the join in friendsRides() below — this constant is
 * only the visibility half, derived from isFriendListed() so the SQL and the
 * boolean stay two readings of one rule.
 */
export const FRIEND_LISTED_RIDE = inArray(rides.visibility, visibilityEnum.enumValues.filter(isFriendListed))

/** One row of a ride list, with the first day's color for the card's stripe. */
type ListRow = { ride: RideRow; color: string | null }

/**
 * Rides that friends of this viewer have set to `friends`.
 *
 * THE EXISTS FORM THE HEADER PROMISED, and it is a join rather than a subquery
 * because the friendship row is what makes a ride eligible — an inner join both
 * filters and needs no correlation. `friendships` holds ONE row per pair under
 * `rider_a < rider_b`, so there is no near or far column and the match has to
 * test both arrangements. Getting that wrong shows exactly half the rides and
 * looks like a data problem rather than a query one.
 *
 * `status = 'accepted'` and not `areFriends()`, because that helper reads a
 * loaded row and this is the predicate. A pending request must not list
 * anything, and neither must a blocked pair — 'blocked' is a status on the same
 * row, so testing for 'accepted' rules both out at once rather than listing what
 * to exclude.
 *
 * The owner join drops a leaving rider's rides, the same as every other list.
 * The viewer's own rides cannot appear: a rider is never in a friendship with
 * themselves, so no join row exists — stated because it looks like a missing
 * `ne(rides.ownerId, viewerId)` and is not.
 */
export async function friendsRides(viewerId: number, limit: number): Promise<ListRow[]> {
  return db
    .select({ ride: rides, color: daysTable.color })
    .from(rides)
    .innerJoin(users, and(eq(users.id, rides.ownerId), isNull(users.deletionRequestedAt)))
    .innerJoin(
      friendships,
      and(
        eq(friendships.status, 'accepted'),
        or(
          and(eq(friendships.riderA, viewerId), eq(friendships.riderB, rides.ownerId)),
          and(eq(friendships.riderB, viewerId), eq(friendships.riderA, rides.ownerId)),
        ),
      ),
    )
    .leftJoin(daysTable, and(eq(daysTable.rideId, rides.id), eq(daysTable.position, 0)))
    .where(and(FRIEND_LISTED_RIDE, LIVE_RIDE))
    .orderBy(desc(rides.updatedAt))
    .limit(limit)
}

/**
 * Listed rides by anybody other than the viewer.
 *
 * The same rows /explore shows, minus the viewer's own — which are the tab next
 * to this one, and a ride in both reads as a duplicate. Ordered by update rather
 * than by view count, because this strip is "what is happening" and not a
 * leaderboard; /explore is still the place that ranks.
 */
export async function publicRides(viewerId: number, limit: number): Promise<ListRow[]> {
  return db
    .select({ ride: rides, color: daysTable.color })
    .from(rides)
    .innerJoin(users, and(eq(users.id, rides.ownerId), isNull(users.deletionRequestedAt)))
    .leftJoin(daysTable, and(eq(daysTable.rideId, rides.id), eq(daysTable.position, 0)))
    .where(and(LISTED_RIDE, LIVE_RIDE, ne(rides.ownerId, viewerId)))
    .orderBy(desc(rides.updatedAt))
    .limit(limit)
}

/**
 * Public rides by riders this viewer follows. The feed.
 *
 * LISTED_RIDE, not FRIEND_LISTED_RIDE, and that is the whole safety property of
 * this feature: **following grants no visibility.** It is a one-way relationship
 * the other rider never agreed to, so it cannot open anything a stranger could
 * not already open — every row here is one /explore would have shown. What
 * following buys is that the rider no longer has to go looking.
 *
 * If this ever selected `friends` rides, `friends` visibility would be openable
 * by anyone willing to press Follow and the level would mean nothing. See the
 * note on the `follows` table in src/db/schema.ts.
 *
 * The join is one-directional, unlike friendsRides() above: `follows` has a
 * follower and a followee rather than a canonical pair, so there is exactly one
 * arrangement to test and testing both would make the feed reciprocal.
 */
export async function followingRides(viewerId: number, limit: number): Promise<ListRow[]> {
  return db
    .select({ ride: rides, color: daysTable.color })
    .from(rides)
    .innerJoin(users, and(eq(users.id, rides.ownerId), isNull(users.deletionRequestedAt)))
    .innerJoin(follows, and(eq(follows.followerId, viewerId), eq(follows.followeeId, rides.ownerId)))
    .leftJoin(daysTable, and(eq(daysTable.rideId, rides.id), eq(daysTable.position, 0)))
    .where(and(LISTED_RIDE, LIVE_RIDE))
    .orderBy(desc(rides.updatedAt))
    .limit(limit)
}
