// The database half of the access rule: the two facts canView() needs but
// cannot establish, and the one gate every route that serves a ride goes
// through.
//
// The split is the house one — ./policy.ts is pure and holds the RULE, this
// file holds the QUERIES — the same arrangement as invites/policy.ts vs
// service.ts and stats/shape.ts vs query.ts.
//
// A NOTE ON WHAT IS NOT HERE. The plan for this work called for a second
// implementation of the rule as a drizzle predicate, `visibleToViewer(id)`,
// with EXISTS subqueries, for the queries that filter a list and cannot load
// each row to ask about it. It is not here because it turned out nothing needs
// it: the only two list queries in the app — /explore and the ride grid on a
// public profile — show LISTED rides, and `friends` is deliberately not a
// listed level (see isListed). So the list form is a CONSTANT predicate after
// all, LISTED_RIDE below, derived from the same isListed() the boolean form
// uses rather than re-stating it. That is strictly better than two
// implementations pinned by an agreement test, because there is nothing to
// disagree. If a viewer-dependent list is ever wanted, the EXISTS form is the
// answer and it will need that test.

import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db/index'
import { friendships, rideMembers, rides, users, visibilityEnum, type RideRow } from '../db/schema'
import { LIVE_RIDE } from '../trash/service'
import { areFriends, pairOf } from '../friends/policy'
import { canView, isListed, type ViewGrants, type Viewer } from './policy'

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
