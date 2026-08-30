// The roster, query side. The rules are in ./policy.ts and nothing here
// re-decides one.
//
// EVERY WRITE RE-READS THE VIEWER'S OWN ROW FIRST. A page renders buttons from a
// roster it read a moment ago, and the roster can change between the render and
// the press — the owner removes you, you leave from another tab. So the button
// is a hint and `roleOf()` on submit is the decision. The same arrangement
// src/friends/service.ts has, for the same reason.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { rideMembers, rides, users, type RidePerm, type RideRole, type Rsvp } from '../db/schema'
import { areFriends, pairOf } from '../friends/policy'
import { friendships } from '../db/schema'
import { canInvite, canRemove, canRsvp, canSetPerm, DEFAULT_PERM, MAX_MEMBERS, type MemberFields } from './policy'
import type { Tx } from '../maps/ride-graph'

/** The db or a transaction on it. seedOwner is called from inside the same
 *  transaction that inserts the ride at every real call site — a ride that
 *  exists with nobody on its roster, even for a moment, is a state no reader
 *  should have to allow for — and from the seed script, which has none. */
type Writer = Tx | typeof db

/** The viewer's role on this ride, or null if they are not on it. The one
 *  question every gate in this file starts from. */
export async function roleOf(rideId: number, viewerId: number | null): Promise<RideRole | null> {
  if (viewerId === null) return null
  const [row] = await db
    .select({ role: rideMembers.role })
    .from(rideMembers)
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, viewerId)))
    .limit(1)
  return row?.role ?? null
}

/**
 * Put the owner on their own roster.
 *
 * Called from every path that creates a ride, and idempotent so a retry or a
 * re-import costs nothing. **This is what makes "the roster" one question**: a
 * ride whose owner is not a member forces every reader to ask about `ownerId`
 * separately, and the reader that forgets shows a ride nobody is on.
 */
export async function seedOwner(w: Writer, rideId: number, ownerId: number): Promise<void> {
  await w
    .insert(rideMembers)
    .values({ rideId, riderId: ownerId, role: 'owner', rsvp: 'going' })
    .onConflictDoNothing({ target: [rideMembers.rideId, rideMembers.riderId] })
}

export type RosterEntry = MemberFields & {
  displayName: string
  username: string | null
  invitedBy: number | null
  /** Which approach they are on, or null. Null is a real state and not an
   *  error: #67 is explicit that a club secretary planning a joint rally is not
   *  in any of the groups. */
  subgroupId: number | null
  /** Which bike they are bringing, or null for their default — see
   *  bikesOnRide() in src/bikes/group-range.ts. */
  bikeId: number | null
}

/** The roster, owner first and then by name. Owner-first is not a sort key on
 *  the role column — it is a `case`, because 'owner' sorts after 'rider'
 *  alphabetically and the enum's own order is not something to lean on. */
export async function roster(rideId: number): Promise<RosterEntry[]> {
  return db
    .select({
      riderId: rideMembers.riderId,
      role: rideMembers.role,
      perm: rideMembers.perm,
      rsvp: rideMembers.rsvp,
      invitedBy: rideMembers.invitedBy,
      subgroupId: rideMembers.subgroupId,
      bikeId: rideMembers.bikeId,
      displayName: users.displayName,
      username: users.username,
    })
    .from(rideMembers)
    .innerJoin(users, eq(users.id, rideMembers.riderId))
    .where(eq(rideMembers.rideId, rideId))
    .orderBy(sql`case when ${rideMembers.role} = 'owner' then 0 else 1 end`, users.displayName)
}

export type InviteResult =
  { ok: true } | { ok: false; reason: 'not-owner' | 'not-a-friend' | 'already-on' | 'full' | 'unknown-rider' }

/**
 * Add a friend to a ride.
 *
 * **A FRIEND, AND ONLY A FRIEND.** Not an email, not a handle you have not
 * befriended, not a link. That is the entire invite mechanism, and it is what
 * lets this ship at all: an invite link for someone with no account either
 * bypasses the pending-approval gate or strands them somewhere they cannot see
 * the ride, and that was the sign-off nobody had given. A friend already has an
 * active account, already passed approval, and already chose to be reachable by
 * this rider. There is nothing left to decide.
 *
 * It also answers #12's fourth box — rate-limit rider lookup by email or phone —
 * by not having the surface to rate-limit.
 */
export async function invite(
  rideId: number,
  viewerId: number,
  handle: string,
  perm: RidePerm = DEFAULT_PERM,
): Promise<InviteResult> {
  const role = await roleOf(rideId, viewerId)
  if (!canInvite(role)) return { ok: false, reason: 'not-owner' }

  const [target] = await db
    .select({ id: users.id })
    .from(users)
    // The same predicate the roster page and the public profile use: a pending,
    // blocked or leaving account has no presence and cannot be invited either.
    .where(
      sql`lower(${users.username}) = lower(${handle}) and ${users.status} = 'active'
          and ${users.deletionRequestedAt} is null`,
    )
    .limit(1)
  if (!target || target.id === viewerId) return { ok: false, reason: 'unknown-rider' }

  const pair = pairOf(viewerId, target.id)
  const [f] = await db
    .select({ status: friendships.status })
    .from(friendships)
    .where(and(eq(friendships.riderA, pair.riderA), eq(friendships.riderB, pair.riderB)))
    .limit(1)
  if (!areFriends(f)) return { ok: false, reason: 'not-a-friend' }

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rideMembers)
    .where(eq(rideMembers.rideId, rideId))
  if (n >= MAX_MEMBERS) return { ok: false, reason: 'full' }

  const added = await db
    .insert(rideMembers)
    .values({ rideId, riderId: target.id, role: 'rider', perm, invitedBy: viewerId })
    .onConflictDoNothing({ target: [rideMembers.rideId, rideMembers.riderId] })
    .returning({ id: rideMembers.id })
  return added.length > 0 ? { ok: true } : { ok: false, reason: 'already-on' }
}

/** Only the fields the pure rule reads, fetched once so a caller does not have
 *  to hand the whole row through two layers. */
async function memberRow(rideId: number, riderId: number): Promise<MemberFields | null> {
  const [row] = await db
    .select({
      riderId: rideMembers.riderId,
      role: rideMembers.role,
      perm: rideMembers.perm,
      rsvp: rideMembers.rsvp,
    })
    .from(rideMembers)
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, riderId)))
    .limit(1)
  return row ?? null
}

/** How many members hold `role = 'owner'`. Read on every removal because the
 *  last-owner rule needs it, and read as its own query rather than off a roster
 *  the caller happens to have: the roster a page rendered from is a hint, and a
 *  co-owner can leave between the render and the press. */
async function ownerCount(rideId: number): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rideMembers)
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.role, 'owner')))
  return n
}

/** Remove somebody, or leave. One operation because they are the same row going
 *  away, and canRemove is the only thing that tells them apart. */
export async function removeMember(rideId: number, viewerId: number, targetId: number): Promise<boolean> {
  const [role, target, owners] = await Promise.all([
    roleOf(rideId, viewerId),
    memberRow(rideId, targetId),
    ownerCount(rideId),
  ])
  if (!target || !canRemove(viewerId, role, target, owners)) return false
  await db.delete(rideMembers).where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, targetId)))
  return true
}

/**
 * Move a member up or down the ladder.
 *
 * Owner-only, and never on another owner — canSetPerm is the rule. The viewer's
 * own row is re-read here rather than trusted from the page that rendered the
 * control, the same as every other write in this file.
 */
export async function setPerm(rideId: number, viewerId: number, targetId: number, perm: RidePerm): Promise<boolean> {
  const [viewer, target] = await Promise.all([memberRow(rideId, viewerId), memberRow(rideId, targetId)])
  if (!target || !canSetPerm(viewer, target)) return false
  await db
    .update(rideMembers)
    .set({ perm, updatedAt: new Date() })
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, targetId)))
  return true
}

/** The viewer's own row, for the gates that need the rung and not just the
 *  role. Null means they are not on the roster — which is not the same as
 *  `view`, and rankOf() keeps the two apart. */
export async function membershipOf(rideId: number, viewerId: number | null): Promise<MemberFields | null> {
  if (viewerId === null) return null
  return memberRow(rideId, viewerId)
}

/**
 * The viewer's row, or a synthesized one for the ride's creator.
 *
 * **THE OWNER IS A MEMBER AND `seedOwner()` GUARANTEES A ROW, so the fallback
 * here is a belt on top of braces rather than the mechanism.** It exists because
 * the cost of being wrong is asymmetric: a creating path that forgot to seed
 * would otherwise lock the owner out of their own builder, and the failure would
 * look like a permissions bug rather than a missing insert.
 *
 * ONE IMPLEMENTATION, because there are now two callers that must not disagree —
 * `/builder/:id` deciding whether to admit a rider, and the viewer deciding what
 * to offer them a link to. Two copies of this and the button starts promising
 * what the page refuses, which is the whole failure builderLabel() is written to
 * prevent.
 */
export async function memberOrOwner(
  ride: { id: number; ownerId: number },
  viewerId: number | null,
): Promise<MemberFields | null> {
  const row = await membershipOf(ride.id, viewerId)
  if (row) return row
  if (viewerId === null || ride.ownerId !== viewerId) return null
  return { riderId: viewerId, role: 'owner', perm: DEFAULT_PERM, rsvp: 'going' }
}

/** Answer for yourself, and nobody else — see canRsvp. */
export async function setRsvp(rideId: number, viewerId: number, rsvp: Rsvp): Promise<boolean> {
  const target = await memberRow(rideId, viewerId)
  if (!target || !canRsvp(viewerId, target)) return false
  await db
    .update(rideMembers)
    .set({ rsvp, updatedAt: new Date() })
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, viewerId)))
  return true
}

/**
 * The friends this rider could still add: accepted friendships minus whoever is
 * already on the roster.
 *
 * Both halves in the database rather than fetching the friends and filtering in
 * JS, because the roster is the smaller set and `not in` over it is one round
 * trip. The `case` is the price of one row per pair — there is no near column.
 */
export async function invitableFriends(rideId: number, viewerId: number) {
  const other = sql<number>`case when ${friendships.riderA} = ${viewerId} then ${friendships.riderB} else ${friendships.riderA} end`
  const onRide = db.select({ id: rideMembers.riderId }).from(rideMembers).where(eq(rideMembers.rideId, rideId))
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, username: users.username })
    .from(friendships)
    .innerJoin(users, eq(users.id, other))
    .where(
      and(
        sql`(${friendships.riderA} = ${viewerId} or ${friendships.riderB} = ${viewerId})`,
        eq(friendships.status, 'accepted'),
        sql`${users.status} = 'active' and ${users.deletionRequestedAt} is null`,
        sql`${users.id} not in ${onRide}`,
      ),
    )
    .orderBy(users.displayName)
  return rows.filter((r): r is { id: number; displayName: string; username: string } => r.username !== null)
}

/** Rides this rider is on but does not own — what the dashboard shows under
 *  "riding with". Their own rides are already the page's main list. */
export async function ridesImOn(viewerId: number) {
  return db
    .select({ ride: rides, role: rideMembers.role, rsvp: rideMembers.rsvp })
    .from(rideMembers)
    .innerJoin(rides, eq(rides.id, rideMembers.rideId))
    .where(and(eq(rideMembers.riderId, viewerId), sql`${rideMembers.role} <> 'owner'`))
    .orderBy(rides.createdAt)
}

/** Bulk role lookup, for a list of rides. One query rather than one per card. */
export async function rolesOn(viewerId: number, rideIds: number[]): Promise<Map<number, RideRole>> {
  if (rideIds.length === 0) return new Map()
  const rows = await db
    .select({ rideId: rideMembers.rideId, role: rideMembers.role })
    .from(rideMembers)
    .where(and(eq(rideMembers.riderId, viewerId), inArray(rideMembers.rideId, rideIds)))
  return new Map(rows.map((r) => [r.rideId, r.role]))
}
