// Who may see a ride, and who may take a copy of one.
//
// THIS IS THE ONLY PLACE THE VISIBILITY TABLE IS WRITTEN DOWN. Before this
// module the same four-clause test — public, or unlisted, or the owner —
// existed in three hand-rolled copies (getViewable in src/index.tsx, and its
// own copy in each of handoff.tsx and roadbook.tsx), plus two list queries that
// tested `visibility = 'public'` directly. Three copies of a rule agreed only
// because nobody had changed it yet; adding a fourth level is exactly the
// change that would have made them disagree, and a disagreement here is a leak.
//
// Pure — a function of an already-loaded ride plus the viewer plus the two
// facts that need a database to establish — so it is testable under the house
// rule that governs test/. The queries live in ./query.ts, the same split as
// invites/policy.ts vs service.ts and stats/shape.ts vs query.ts.
//
// The two forms are NOT interchangeable and both are needed:
//
//   canView()        — a boolean over one loaded ride. What a route asks.
//   visibleToViewer() in ./query.ts — a drizzle predicate with EXISTS
//                      subqueries, for the queries that filter a LIST and
//                      cannot load each row to ask about it.
//
// They have to agree. The `deleted_at` sweep was easy because its predicate was
// a CONSTANT (`isNull(rides.deletedAt)`) that every path could share; this one
// depends on the viewer, so a shared constant cannot carry it and two
// implementations is the price. Same arrangement src/maps/alts.ts has with
// public/js/alts.js, and the same obligation to keep them pinned together.

import type { RideVisibility } from '../db/schema'

/**
 * The facts about the viewer's relationship to this ride that cannot be read
 * off the ride row — each one costs a query, so a caller establishes them once
 * and hands them in rather than this module reaching for a database.
 *
 * Both default to false and a caller that has not looked simply gets today's
 * behavior, which is what makes the sweep reviewable: the diff that adds the
 * levels and the diff that changes who can see what are separate.
 */
export type ViewGrants = {
  /**
   * The viewer has a row in `ride_members` for this ride.
   *
   * SCHEMA ONLY as of 2026-08-26 — the invite path that would create such a row
   * is cut, so nothing in the app can set this true yet. It is wired here
   * anyway so that switching membership on is a change to the service layer and
   * not a second change to the access rule.
   */
  isMember?: boolean
  /** The viewer and the ride's owner have an `accepted` friendship. */
  isFriendOfOwner?: boolean
}

/** Only the fields the rules read, so a test does not have to build a whole row. */
export type ViewableRide = {
  ownerId: number
  visibility: RideVisibility
}

/** Only the fields the rules read. `status` matters because a blocked or
 *  pending rider is not a viewer, whatever else is true of them. */
export type Viewer = {
  id: number
  status: string
} | null

/**
 * A viewer who is signed in but not yet approved — or has been blocked — is
 * treated as anonymous rather than as themselves. They can still follow a
 * public or unlisted link, which is what an anonymous browser can do, and they
 * get no grant that depends on being a rider in good standing.
 *
 * Note what this deliberately does NOT do: it does not refuse them their own
 * rides. A pending rider cannot reach /builder at all (requireActive), so the
 * case is theoretical, and answering 404 on a rider's own ride is a worse
 * failure than showing it to them.
 */
const isRider = (v: Viewer): v is { id: number; status: string } => v !== null && v.status === 'active'

/**
 * The whole rule. Read it as a table:
 *
 *   | visibility | anonymous | any rider | friend of owner | member | owner |
 *   | ---------- | --------- | --------- | --------------- | ------ | ----- |
 *   | public     | yes       | yes       | yes             | yes    | yes   |
 *   | unlisted   | yes       | yes       | yes             | yes    | yes   |
 *   | friends    | no        | no        | YES             | yes    | yes   |
 *   | private    | no        | no        | no              | YES    | yes   |
 *
 * `public` and `unlisted` keep their exact previous meanings — both are "anyone
 * holding the link", and the difference between them is whether the ride is
 * LISTED, which is isListed()'s job and not this one.
 *
 * `private` gaining "and members" is a SUPERSET of what it meant, and no ride
 * has members, so no existing row changed meaning the day this landed.
 */
export function canView(ride: ViewableRide, viewer: Viewer, grants: ViewGrants = {}): boolean {
  if (viewer !== null && viewer.id === ride.ownerId) return true

  // Membership beats visibility, deliberately and at every level. Being invited
  // onto a ride is a stronger statement than any setting on the ride — the
  // owner named this rider — so a member sees a private ride. It is also the
  // only thing that makes `private` usable for a group ride at all.
  if (grants.isMember && isRider(viewer)) return true

  switch (ride.visibility) {
    case 'public':
    case 'unlisted':
      return true
    case 'friends':
      return isRider(viewer) && Boolean(grants.isFriendOfOwner)
    case 'private':
      return false
  }
}

/**
 * Whether a ride appears in a LIST nobody asked for by name: /explore, and the
 * public ride grid on a rider's profile.
 *
 * Only `public`. This is the entire difference between `public` and `unlisted`
 * and the reason both exist — an unlisted ride is viewable by anyone holding
 * the link and must never be surfaced to someone who was not handed one.
 *
 * `friends` is deliberately NOT listed, although a friend may view it. Listing
 * it would mean /explore's query result depends on who is asking, which is a
 * different and much more expensive page, and it would put a rider's ride in
 * front of their friends without them choosing to publish it. A friends-only
 * ride is shared the way an unlisted one is: by handing over the link.
 */
export function isListed(visibility: RideVisibility): boolean {
  return visibility === 'public'
}

/**
 * Whether the viewer may take their own copy of someone else's ride.
 *
 * Ziad's call, 2026-08-26, made deliberately rather than inherited: cloning
 * follows the two levels where the owner has said who may have it — `public`,
 * which is publishing, and `friends`, where they named the audience. It does
 * NOT follow `unlisted`, which is the level whose entire meaning is "I gave
 * this to one person", and a copy that outlives the link is not what handing
 * over a link says.
 *
 * The owner is excluded rather than merely uninterested: they have Edit, and a
 * Clone button on your own ride reads as Duplicate, which is a different
 * feature nobody has asked for.
 *
 * Clone rights are also NOT edit rights on the original — see canEditRide in
 * routes/maps.ts, which stays owner-only. A clone is a new ride owned by
 * whoever took it.
 */
export function canClone(ride: ViewableRide, viewer: Viewer, grants: ViewGrants = {}): boolean {
  if (!isRider(viewer)) return false
  if (viewer.id === ride.ownerId) return false
  if (!canView(ride, viewer, grants)) return false
  return ride.visibility === 'public' || ride.visibility === 'friends'
}

/**
 * Whether a response for this ride may be cached by anything other than the
 * rider's own browser.
 *
 * A separate function rather than `visibility === 'public'` inline, because it
 * is the single easiest site in the sweep to miss and the most quietly harmful
 * to get wrong: a shared cache at the edge holding an unlisted ride's thumbnail
 * hands it to whoever asks next. Anything that is not published is `private`.
 */
export function isSharedCacheable(visibility: RideVisibility): boolean {
  return visibility === 'public'
}
