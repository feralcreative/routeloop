// The roster, query side. The rules are in ./policy.ts and nothing here
// re-decides one.
//
// EVERY WRITE RE-READS THE VIEWER'S OWN ROW FIRST. A page renders buttons from a
// roster it read a moment ago, and the roster can change between the render and
// the press — the owner removes you, you leave from another tab. So the button
// is a hint and `roleOf()` on submit is the decision. The same arrangement
// src/friends/service.ts has, for the same reason.
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { db } from '../db/index'
import {
  rideInvites,
  rideMembers,
  rides,
  users,
  type MemberState,
  type RidePerm,
  type RideRole,
  type Rsvp,
} from '../db/schema'
import { areFriends, pairOf } from '../friends/policy'
import { friendships } from '../db/schema'
import {
  canDecline,
  canInvite,
  canRemove,
  canRsvp,
  canSetPerm,
  DEFAULT_PERM,
  isLiveMember,
  MAX_MEMBERS,
  sendPlanFor,
  type MemberFields,
  type SendPlan,
} from './policy'
import type { Tx } from '../maps/ride-graph'
import { LIVE_RIDE } from '../trash/service'

/** The db or a transaction on it. seedOwner is called from inside the same
 *  transaction that inserts the ride at every real call site — a ride that
 *  exists with nobody on its roster, even for a moment, is a state no reader
 *  should have to allow for — and from the seed script, which has none. */
type Writer = Tx | typeof db

/**
 * A row that is a member in the sense every gate means — isLiveMember()'s SQL
 * half (#428). A draft, a row waiting on a friend request or a signup, and a
 * declined invitation are all on the organizer's roster and none of them may see
 * the ride, comment, vote or be told about it.
 *
 * A NAMED PREDICATE FOR THE SAME REASON LIVE_RIDE IS ONE: an access path that
 * forgets it shows up in review as a missing import rather than as an absent
 * `state = 'invited'`, and test/live-member.test.ts reads the access paths for it.
 */
export const LIVE_MEMBER = eq(rideMembers.state, 'invited')

/** A row the organizer PLANS with — isPlanned()'s SQL half. Everybody but a
 *  declined invitation. */
export const PLANNED_MEMBER = ne(rideMembers.state, 'declined')

/** The viewer's role on this ride, or null if they are not a member of it. The
 *  one question every gate in this file starts from — and a draft is not a
 *  member, so it answers null for one. */
export async function roleOf(rideId: number, viewerId: number | null): Promise<RideRole | null> {
  if (viewerId === null) return null
  const [row] = await db
    .select({ role: rideMembers.role })
    .from(rideMembers)
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, viewerId), LIVE_MEMBER))
    .limit(1)
  return row?.role ?? null
}

/** Whether this rider is on the organizer's roster in ANY state but declined.
 *  For the planning verbs — putting a draft in a group — and never for access. */
export async function onRoster(rideId: number, riderId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: rideMembers.id })
    .from(rideMembers)
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, riderId), PLANNED_MEMBER))
    .limit(1)
  return Boolean(row)
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
  /** A seeded tour guide rather than a person. Rendered as plain text and never
   *  as a `/@handle` link, because the profile page refuses a guide by design. */
  isGuide: boolean
  /** Where the row is in the organizer's flow. Present here, where MemberFields
   *  leaves it optional, because every reader of the roster has to decide. */
  state: MemberState
  /** A person with no account — a `placeholder` users row (#428). */
  isPlaceholder: boolean
}

/**
 * The roster, owner first and then by name. Owner-first is not a sort key on
 * the role column — it is a `case`, because 'owner' sorts after 'rider'
 * alphabetically and the enum's own order is not something to lean on.
 *
 * EVERY STATE, because the organizer's Riders tab is one of its readers and
 * drafts are what it exists to show. A reader that serves anybody else —
 * the roster page a member opens — filters with isLiveMember().
 */
export async function roster(rideId: number): Promise<RosterEntry[]> {
  const rows = await db
    .select({
      riderId: rideMembers.riderId,
      role: rideMembers.role,
      perm: rideMembers.perm,
      rsvp: rideMembers.rsvp,
      state: rideMembers.state,
      invitedBy: rideMembers.invitedBy,
      subgroupId: rideMembers.subgroupId,
      bikeId: rideMembers.bikeId,
      displayName: users.displayName,
      username: users.username,
      isGuide: users.isGuide,
      status: users.status,
    })
    .from(rideMembers)
    .innerJoin(users, eq(users.id, rideMembers.riderId))
    .where(eq(rideMembers.rideId, rideId))
    .orderBy(sql`case when ${rideMembers.role} = 'owner' then 0 else 1 end`, users.displayName)
  return rows.map(({ status, ...r }) => ({ ...r, isPlaceholder: status === 'placeholder' }))
}

export type AddResult =
  // `riderId` rides along on success so the caller can hand it back to the tab.
  | { ok: true; riderId: number }
  | { ok: false; reason: 'not-owner' | 'already-on' | 'full' | 'unknown-rider' | 'bad-name' }

/** How many rows the roster holds, in every state: a draft takes a seat as
 *  surely as a member does, or MAX_MEMBERS bounds nothing an organizer plans. */
async function seatsTaken(rideId: number): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rideMembers)
    .where(eq(rideMembers.rideId, rideId))
  return n
}

/**
 * Put a Routeloop rider on the ride AS A DRAFT (#428).
 *
 * **NOBODY IS TOLD AND NOTHING IS GRANTED.** That is the organizer's flow: build
 * the ride around the people you expect, then send. sendInvitations() is the
 * only thing that turns a draft into anything.
 *
 * **ANY ACTIVE RIDER, NOT ONLY A FRIEND.** The friends-only rule was the whole
 * invite mechanism until #428; it survives at SEND, where somebody who is not a
 * friend gets a friend request instead of a ride, and is put on it when they
 * accept. Adding a draft contacts nobody, so there is nothing for it to protect.
 */
export async function addDraft(
  rideId: number,
  viewerId: number,
  handle: string,
  perm: RidePerm = DEFAULT_PERM,
): Promise<AddResult> {
  const role = await roleOf(rideId, viewerId)
  if (!canInvite(role)) return { ok: false, reason: 'not-owner' }

  const [target] = await db
    .select({ id: users.id })
    .from(users)
    // The same predicate the roster page and the public profile use: a pending,
    // blocked or leaving account has no presence and cannot be added either.
    .where(
      sql`lower(${users.username}) = lower(${handle}) and ${users.status} = 'active'
          and ${users.deletionRequestedAt} is null`,
    )
    .limit(1)
  if (!target || target.id === viewerId) return { ok: false, reason: 'unknown-rider' }
  if ((await seatsTaken(rideId)) >= MAX_MEMBERS) return { ok: false, reason: 'full' }

  const added = await db
    .insert(rideMembers)
    .values({ rideId, riderId: target.id, role: 'rider', perm, state: 'draft', invitedBy: viewerId })
    .onConflictDoNothing({ target: [rideMembers.rideId, rideMembers.riderId] })
    .returning({ id: rideMembers.id })
  return added.length > 0 ? { ok: true, riderId: target.id } : { ok: false, reason: 'already-on' }
}

/** The longest name a placeholder may carry — the users column is wider, and
 *  this is what the Riders tab's field allows. */
export const PLACEHOLDER_NAME_MAX = 80

/**
 * Put somebody with NO ACCOUNT on the ride, as a draft (#428).
 *
 * A placeholder is a real `users` row — status `placeholder`, no email, no
 * identity — so groups, route riders and every planning read need no second
 * shape of rider. What only the organizer should see, the address, is on the
 * `ride_invites` row beside it. One transaction, because a placeholder with no
 * roster row is a users row nothing will ever clean up.
 */
export async function addPlaceholder(
  rideId: number,
  viewerId: number,
  name: string,
  email: string | null,
  perm: RidePerm = DEFAULT_PERM,
): Promise<AddResult> {
  const role = await roleOf(rideId, viewerId)
  if (!canInvite(role)) return { ok: false, reason: 'not-owner' }
  const display = name.trim().slice(0, PLACEHOLDER_NAME_MAX)
  if (!display) return { ok: false, reason: 'bad-name' }
  if ((await seatsTaken(rideId)) >= MAX_MEMBERS) return { ok: false, reason: 'full' }

  const riderId = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ displayName: display, status: 'placeholder' })
      .returning({ id: users.id })
    await tx
      .insert(rideMembers)
      .values({ rideId, riderId: u.id, role: 'rider', perm, state: 'draft', invitedBy: viewerId })
    await tx.insert(rideInvites).values({ rideId, placeholderId: u.id, email, createdBy: viewerId })
    return u.id
  })
  return { ok: true, riderId }
}

/**
 * Change a placeholder's name or address. The organizer's, and only while the
 * row is still a draft: once the link has gone out, the address it went to is a
 * fact, and changing it would leave the organizer believing somebody else had
 * been invited.
 */
export async function editPlaceholder(
  rideId: number,
  viewerId: number,
  placeholderId: number,
  patch: { name?: string; email?: string | null },
): Promise<boolean> {
  const role = await roleOf(rideId, viewerId)
  if (!canInvite(role)) return false
  const [row] = await db
    .select({ state: rideMembers.state, status: users.status })
    .from(rideMembers)
    .innerJoin(users, eq(users.id, rideMembers.riderId))
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, placeholderId)))
    .limit(1)
  if (!row || row.status !== 'placeholder') return false
  if (patch.name !== undefined) {
    const display = patch.name.trim().slice(0, PLACEHOLDER_NAME_MAX)
    if (!display) return false
    await db.update(users).set({ displayName: display, updatedAt: new Date() }).where(eq(users.id, placeholderId))
  }
  if (patch.email !== undefined) {
    if (row.state !== 'draft') return false
    await db
      .update(rideInvites)
      .set({ email: patch.email, updatedAt: new Date() })
      .where(and(eq(rideInvites.rideId, rideId), eq(rideInvites.placeholderId, placeholderId)))
  }
  return true
}

/** One draft, with everything sendPlanFor() reads. */
export type DraftRow = {
  riderId: number
  displayName: string
  placeholder: boolean
  email: string | null
  isFriend: boolean
  isGuide: boolean
  plan: SendPlan
}

/**
 * Every draft on the ride with what Send would do with it. The confirm dialog
 * and sendInvitations() both read this, so what the organizer is shown is what
 * happens.
 */
export async function draftsOf(rideId: number, viewerId: number): Promise<DraftRow[]> {
  const rows = await db
    .select({
      riderId: rideMembers.riderId,
      state: rideMembers.state,
      displayName: users.displayName,
      status: users.status,
      isGuide: users.isGuide,
      email: rideInvites.email,
    })
    .from(rideMembers)
    .innerJoin(users, eq(users.id, rideMembers.riderId))
    .leftJoin(rideInvites, and(eq(rideInvites.rideId, rideId), eq(rideInvites.placeholderId, rideMembers.riderId)))
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.state, 'draft')))
    .orderBy(users.displayName)
  if (rows.length === 0) return []

  const real = rows.filter((r) => r.status !== 'placeholder').map((r) => r.riderId)
  const friends = new Set<number>()
  if (real.length > 0) {
    const fr = await db
      .select({ a: friendships.riderA, b: friendships.riderB })
      .from(friendships)
      .where(
        and(
          eq(friendships.status, 'accepted'),
          sql`(${friendships.riderA} = ${viewerId} or ${friendships.riderB} = ${viewerId})`,
        ),
      )
    for (const f of fr) friends.add(f.a === viewerId ? f.b : f.a)
  }
  return rows.map((r) => {
    const placeholder = r.status === 'placeholder'
    const facts = { placeholder, email: r.email ?? null, isFriend: friends.has(r.riderId), isGuide: r.isGuide }
    return {
      riderId: r.riderId,
      displayName: r.displayName,
      ...facts,
      plan: sendPlanFor({ state: r.state, ...facts }),
    }
  })
}

/** What Send did, for the caller to notify on. The service writes; the route
 *  sends the mail, after the writes, the house arrangement. */
export type SendOutcome = {
  invited: number[]
  friendRequested: number[]
  emailed: Array<{ riderId: number; email: string; token: string }>
  needsEmail: string[]
}

/**
 * SEND INVITATIONS (#428): every draft goes out at once, each by its plan.
 *
 *   invite          a friend (or a guide) → `invited`; the caller sends ride_added
 *   friend-request  not a friend yet → a friend request and `pending_friend`;
 *                   promotePendingFriends() puts them on the ride when they accept
 *   email           a placeholder with an address → a token is minted and
 *                   `pending_signup`; the caller mails the personal link
 *   needs-email     a placeholder with no address stays a draft and is reported
 *                   back by name — it does not hold up anybody else
 *
 * `mint` is passed in so this file does not import the ride-invites module,
 * which imports this one.
 */
export async function sendInvitations(
  rideId: number,
  viewerId: number,
  mint: (rideId: number, placeholderId: number) => Promise<string>,
  request: (viewerId: number, otherId: number) => Promise<{ ok: boolean }>,
): Promise<SendOutcome | null> {
  const role = await roleOf(rideId, viewerId)
  if (!canInvite(role)) return null
  const out: SendOutcome = { invited: [], friendRequested: [], emailed: [], needsEmail: [] }
  const setState = (riderId: number, state: MemberState) =>
    db
      .update(rideMembers)
      .set({ state, updatedAt: new Date() })
      .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, riderId), eq(rideMembers.state, 'draft')))
      .returning({ id: rideMembers.id })

  for (const d of await draftsOf(rideId, viewerId)) {
    switch (d.plan) {
      case 'invite':
        if ((await setState(d.riderId, 'invited')).length) out.invited.push(d.riderId)
        break
      case 'friend-request': {
        // A request that is refused — a block in either direction, or one already
        // pending from them — still moves the row to Waiting, and says nothing
        // more. A refusal must stay indistinguishable, the friendship rule.
        // An already-pending request FROM them is the one case worth taking: they
        // asked first, so accepting it is theirs to do and the row waits on it.
        const res = await request(viewerId, d.riderId)
        if ((await setState(d.riderId, 'pending_friend')).length && res.ok) out.friendRequested.push(d.riderId)
        break
      }
      case 'email': {
        const token = await mint(rideId, d.riderId)
        if ((await setState(d.riderId, 'pending_signup')).length) {
          out.emailed.push({ riderId: d.riderId, email: d.email!, token })
        }
        break
      }
      case 'needs-email':
        out.needsEmail.push(d.displayName)
        break
      case 'skip':
        break
    }
  }
  return out
}

/**
 * A friendship was just accepted: put the newly-friended rider on every ride the
 * other one had them WAITING on (#428). Both directions, because either of the
 * two may be the organizer. Returns the rows it promoted so the caller can send
 * ride_added for each.
 */
export async function promotePendingFriends(
  one: number,
  other: number,
): Promise<Array<{ rideId: number; riderId: number; by: number }>> {
  const rows = await db
    .update(rideMembers)
    .set({ state: 'invited', updatedAt: new Date() })
    .where(
      and(
        eq(rideMembers.state, 'pending_friend'),
        sql`((${rideMembers.riderId} = ${one} and ${rideMembers.invitedBy} = ${other})
          or (${rideMembers.riderId} = ${other} and ${rideMembers.invitedBy} = ${one}))`,
      ),
    )
    .returning({ rideId: rideMembers.rideId, riderId: rideMembers.riderId, by: rideMembers.invitedBy })
  return rows.map((r) => ({ rideId: r.rideId, riderId: r.riderId, by: r.by ?? (r.riderId === one ? other : one) }))
}

/**
 * Decline your own invitation (#428). The row stays, as `declined`, so the
 * organizer can see the answer; it grants nothing from here on — the ride leaves
 * your lists and stops being viewable through membership. Not leaving: leaving
 * deletes the row and says nothing to anybody.
 */
export async function declineInvitation(rideId: number, viewerId: number): Promise<boolean> {
  const target = await memberRow(rideId, viewerId)
  if (!target || !canDecline(viewerId, target)) return false
  await db
    .update(rideMembers)
    .set({ state: 'declined', updatedAt: new Date() })
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, viewerId)))
  return true
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
      state: rideMembers.state,
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
  await db.transaction(async (tx) => {
    await tx.delete(rideMembers).where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, targetId)))
    // A PLACEHOLDER BELONGS TO THIS RIDE AND NOTHING ELSE, so taking it off the
    // roster takes the person with it — and their link, which dies with the row.
    // Scoped to this ride's own invite so a forged id cannot reach anybody else.
    const [ph] = await tx
      .delete(rideInvites)
      .where(and(eq(rideInvites.rideId, rideId), eq(rideInvites.placeholderId, targetId)))
      .returning({ id: rideInvites.id })
    if (ph) await tx.delete(users).where(and(eq(users.id, targetId), eq(users.status, 'placeholder')))
  })
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
 *  role. Null means they are not a member — which is not the same as `view`,
 *  and rankOf() keeps the two apart. A draft, a pending row and a declined one
 *  all answer null: none of them is a member yet, or any more. */
export async function membershipOf(rideId: number, viewerId: number | null): Promise<MemberFields | null> {
  if (viewerId === null) return null
  const row = await memberRow(rideId, viewerId)
  return isLiveMember(row) ? row : null
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
/** **`changed` IS WHY THIS IS NOT A BOOLEAN.** The RSVP form posts the whole
 *  field, so pressing Going while already going is an ordinary submit — and
 *  notifying on it would mail the owner every time a rider re-confirmed. The
 *  previous value is in hand here and nowhere else, so this is the only place
 *  the difference can be reported from. */
export type RsvpResult = { ok: false } | { ok: true; changed: boolean }

export async function setRsvp(rideId: number, viewerId: number, rsvp: Rsvp): Promise<RsvpResult> {
  const target = await memberRow(rideId, viewerId)
  if (!target || !canRsvp(viewerId, target)) return { ok: false }
  await db
    .update(rideMembers)
    .set({ rsvp, updatedAt: new Date() })
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, viewerId)))
  return { ok: true, changed: target.rsvp !== rsvp }
}

/** How many riders have said they are coming. Read after a change rather than
 *  derived from it, because several riders answer at once and a count carried
 *  forward from the update would be one rider's stale view of the roster. */
export async function goingCount(rideId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rideMembers)
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.rsvp, 'going'), LIVE_MEMBER))
  return row?.n ?? 0
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

/** Rides this rider is on but does not own — the tail of Your rides on /rides,
 *  after the rides they own. `owner` is who put them on it, because a card in
 *  a list of your own rides needs to say why this one is not.
 *
 *  LIVE_RIDE IS LOAD-BEARING HERE FOR THE SAME REASON IT IS IN EVERY OTHER RIDE
 *  LIST, AND THIS WAS THE ONE THAT DID NOT HAVE IT. Binning a ride kills its
 *  share link on the spot — `viewableRide()` filters on LIVE_RIDE — so a
 *  membership list that does not filter shows a card whose only action is a
 *  404, on a ride the owner has deleted and the member cannot restore. Seen on
 *  a binned private ride that sat on the dashboard for six days.
 *
 *  The owner join mirrors `viewableRide()` too: a rider on their way out takes
 *  their rides off every other list, and this must not be the exception that
 *  keeps them visible. */
export async function ridesImOn(viewerId: number) {
  return db
    .select({ ride: rides, role: rideMembers.role, rsvp: rideMembers.rsvp, owner: users.displayName })
    .from(rideMembers)
    .innerJoin(rides, eq(rides.id, rideMembers.rideId))
    .innerJoin(users, and(eq(users.id, rides.ownerId), isNull(users.deletionRequestedAt)))
    .where(and(eq(rideMembers.riderId, viewerId), sql`${rideMembers.role} <> 'owner'`, LIVE_MEMBER, LIVE_RIDE))
    .orderBy(rides.createdAt)
}

/** Bulk role lookup, for a list of rides. One query rather than one per card. */
export async function rolesOn(viewerId: number, rideIds: number[]): Promise<Map<number, RideRole>> {
  if (rideIds.length === 0) return new Map()
  const rows = await db
    .select({ rideId: rideMembers.rideId, role: rideMembers.role })
    .from(rideMembers)
    .where(and(eq(rideMembers.riderId, viewerId), inArray(rideMembers.rideId, rideIds), LIVE_MEMBER))
  return new Map(rows.map((r) => [r.rideId, r.role]))
}
