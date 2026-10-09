// A personal ride link (#428), the queries half. The rules are in ./policy.ts.
//
// Three things touch the database here: minting the token at Send, answering the
// view grant for a browser holding one, and the two things a person can do with
// it — decline, or join. Joining is the one with weight: it merges the
// placeholder the organizer planned with into the account that just signed in,
// and it is the one door past the beta waitlist.
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { friendships, rideInvites, rideMembers, rides, routeRiders, users } from '../db/schema'
import type { RideInviteRow, RideRow, UserRow } from '../db/schema'
import { generateSessionToken, hashToken } from '../auth/session'
import { normalizeInviteToken } from '../invites/policy'
import { shouldSendApproval } from '../emails/rules'
import { pairOf } from '../friends/policy'
import { LIVE_RIDE } from '../trash/service'
import { inviteLiveness, type InviteLiveness } from './policy'

/**
 * Mint the personal link for one placeholder, at Send. The plaintext comes back
 * exactly once, for the email; only its hash is kept. Minting again — a resend —
 * replaces the hash, so an older email's link stops working.
 */
export async function mintRideInvite(rideId: number, placeholderId: number): Promise<string> {
  const token = generateSessionToken()
  await db
    .update(rideInvites)
    .set({ tokenHash: await hashToken(token), sentAt: new Date(), updatedAt: new Date() })
    .where(and(eq(rideInvites.rideId, rideId), eq(rideInvites.placeholderId, placeholderId)))
  return token
}

/** A link and the ride it opens, for the landing page. The ride is only
 *  returned while it is live and its owner is not leaving — the same two
 *  conditions viewableRide() applies — so a binned ride's link reads as dead. */
export type FoundInvite = {
  invite: RideInviteRow
  ride: RideRow
  /** Who sent it, for "Ziad invited you". */
  fromName: string
  /** The name the organizer planned with. */
  placeholderName: string | null
  liveness: InviteLiveness
}

export async function findRideInvite(rawToken: string): Promise<FoundInvite | null> {
  const token = normalizeInviteToken(rawToken)
  if (!token) return null
  const [row] = await db
    .select({ invite: rideInvites, ride: rides })
    .from(rideInvites)
    .innerJoin(rides, eq(rides.id, rideInvites.rideId))
    .innerJoin(users, and(eq(users.id, rides.ownerId), isNull(users.deletionRequestedAt)))
    .where(and(eq(rideInvites.tokenHash, await hashToken(token)), LIVE_RIDE))
    .limit(1)
  if (!row) return null
  const ids = [row.invite.createdBy ?? row.ride.ownerId, row.invite.placeholderId].filter(
    (n): n is number => typeof n === 'number',
  )
  const names = new Map(
    (await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, ids))).map(
      (u) => [u.id, u.name],
    ),
  )
  return {
    ...row,
    fromName: names.get(row.invite.createdBy ?? row.ride.ownerId) ?? 'Somebody',
    placeholderName: row.invite.placeholderId ? (names.get(row.invite.placeholderId) ?? null) : null,
    liveness: inviteLiveness(row.invite),
  }
}

/**
 * Whether any of these tokens is a live link to this ride — the view grant
 * grantsFor() asks for. Each token is checked against the charset before it is
 * hashed, because it came out of a cookie.
 */
export async function holdsLiveInvite(rideId: number, rawTokens: readonly string[]): Promise<boolean> {
  const tokens = rawTokens.map(normalizeInviteToken).filter((t): t is string => t !== null)
  if (tokens.length === 0) return false
  const hashes = await Promise.all(tokens.map(hashToken))
  const [row] = await db
    .select({ id: rideInvites.id })
    .from(rideInvites)
    .where(
      and(
        eq(rideInvites.rideId, rideId),
        inArray(rideInvites.tokenHash, hashes),
        isNotNull(rideInvites.sentAt),
        isNull(rideInvites.redeemedAt),
        isNull(rideInvites.declinedAt),
        isNull(rideInvites.revokedAt),
      ),
    )
    .limit(1)
  return Boolean(row)
}

/**
 * Say no (#428). Stamps the link declined, which ends the view grant, and marks
 * the placeholder's roster row declined so the organizer sees the answer.
 * Returns what the caller needs to tell the organizer, or null when the link was
 * not live — declining twice is a no-op, not a second message.
 */
export async function declineRideInvite(
  rawToken: string,
): Promise<{ rideId: number; placeholderId: number } | null> {
  const found = await findRideInvite(rawToken)
  if (!found || found.liveness !== 'ok' || !found.invite.placeholderId) return null
  const placeholderId = found.invite.placeholderId
  await db.transaction(async (tx) => {
    await tx
      .update(rideInvites)
      .set({ declinedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(rideInvites.id, found.invite.id), isNull(rideInvites.declinedAt)))
    await tx
      .update(rideMembers)
      .set({ state: 'declined', updatedAt: new Date() })
      .where(and(eq(rideMembers.rideId, found.ride.id), eq(rideMembers.riderId, placeholderId)))
  })
  return { rideId: found.ride.id, placeholderId }
}

export class RideInviteError extends Error {
  constructor(readonly reason: InviteLiveness | 'invalid') {
    super(reason)
    this.name = 'RideInviteError'
  }
}

export type JoinResult = {
  ride: RideRow
  /** Set only when the approval mail is owed. The CALLER sends it, after commit. */
  notifyEmail: string | null
  displayName: string
  /** Who sent the link, for ride_added. */
  by: number | null
}

/**
 * JOIN: merge the placeholder the organizer planned with into the account that
 * just signed in through the link (#428). One transaction:
 *
 *   1. the link is claimed with a conditional UPDATE — the WHERE is the claim, so
 *      two tabs pressing Join cannot both merge;
 *   2. the roster row and every route-riders row move from the placeholder to
 *      the rider, so they land in the group and on the routes they were planned
 *      on. A rider ALREADY on the ride keeps their own row and the placeholder's
 *      is dropped — their own answer outranks the organizer's guess;
 *   3. the account is activated, pending → active and never from `blocked`: the
 *      one door past the beta waitlist, and a rider who was blocked must not be
 *      able to walk back in through an organizer's link;
 *   4. the organizer and the rider become friends, which is what a ride
 *      invitation has always implied — unless either has blocked the other;
 *   5. the placeholder is deleted. The link row survives, set null, as the record.
 *
 * No mail in here: an SMTP round trip must not hold a pooled connection. The
 * caller sends the approval mail and ride_added after commit.
 */
export async function joinRideInvite(rawToken: string, user: UserRow): Promise<JoinResult> {
  const token = normalizeInviteToken(rawToken)
  if (!token) throw new RideInviteError('invalid')
  const hash = await hashToken(token)

  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(rideInvites)
      .set({ redeemedAt: new Date(), redeemedBy: user.id, updatedAt: new Date() })
      .where(
        and(
          eq(rideInvites.tokenHash, hash),
          isNotNull(rideInvites.sentAt),
          isNull(rideInvites.redeemedAt),
          isNull(rideInvites.declinedAt),
          isNull(rideInvites.revokedAt),
        ),
      )
      .returning()
    if (!claimed) {
      const [dead] = await tx.select().from(rideInvites).where(eq(rideInvites.tokenHash, hash)).limit(1)
      throw new RideInviteError(dead ? inviteLiveness(dead) : 'invalid')
    }
    const [ride] = await tx
      .select()
      .from(rides)
      .where(and(eq(rides.id, claimed.rideId), LIVE_RIDE))
      .limit(1)
    if (!ride) throw new RideInviteError('revoked')

    const placeholderId = claimed.placeholderId
    if (placeholderId !== null) {
      const [mine] = await tx
        .select({ id: rideMembers.id, role: rideMembers.role })
        .from(rideMembers)
        .where(and(eq(rideMembers.rideId, ride.id), eq(rideMembers.riderId, user.id)))
        .limit(1)
      if (mine) {
        // Already on it. Their row wins; it becomes a member if it was not one.
        if (mine.role !== 'owner') {
          await tx
            .update(rideMembers)
            .set({ state: 'invited', updatedAt: new Date() })
            .where(eq(rideMembers.id, mine.id))
        }
        await tx
          .insert(routeRiders)
          .select(
            tx
              .select({
                rideId: routeRiders.rideId,
                routeUid: routeRiders.routeUid,
                riderId: sql<number>`${user.id}::bigint`.as('rider_id'),
                subgroupId: routeRiders.subgroupId,
                createdAt: routeRiders.createdAt,
              })
              .from(routeRiders)
              .where(and(eq(routeRiders.rideId, ride.id), eq(routeRiders.riderId, placeholderId))),
          )
          .onConflictDoNothing()
      } else {
        await tx
          .update(rideMembers)
          .set({ riderId: user.id, state: 'invited', updatedAt: new Date() })
          .where(and(eq(rideMembers.rideId, ride.id), eq(rideMembers.riderId, placeholderId)))
        await tx
          .update(routeRiders)
          .set({ riderId: user.id })
          .where(and(eq(routeRiders.rideId, ride.id), eq(routeRiders.riderId, placeholderId)))
      }
      await tx.update(rideInvites).set({ placeholderId: null }).where(eq(rideInvites.id, claimed.id))
      // Cascades whatever is left of the placeholder — its roster row in the
      // already-on case, and its route-riders rows.
      await tx.delete(users).where(and(eq(users.id, placeholderId), eq(users.status, 'placeholder')))
    }

    // Activation. eq(status, 'pending'), never ne(status, 'active') — see
    // redeemInvite(), which this mirrors: a blocked rider stays blocked.
    const notify = shouldSendApproval(user.status, 'active', user.approvedEmailAt)
    const [changed] = await tx
      .update(users)
      .set({ status: 'active', updatedAt: new Date(), ...(notify ? { approvedEmailAt: new Date() } : {}) })
      .where(and(eq(users.id, user.id), eq(users.status, 'pending')))
      .returning({ email: users.email })

    const by = claimed.createdBy
    if (by !== null && by !== user.id) {
      const pair = pairOf(by, user.id)
      // Insert a friendship, or accept a pending one either way round. A block
      // is left exactly as it is: an invitation must not lift one.
      await tx
        .insert(friendships)
        .values({ ...pair, status: 'accepted', requestedBy: by })
        .onConflictDoUpdate({
          target: [friendships.riderA, friendships.riderB],
          set: { status: 'accepted', updatedAt: new Date() },
          setWhere: eq(friendships.status, 'pending'),
        })
    }

    return { ride, notifyEmail: changed && notify ? changed.email : null, displayName: user.displayName, by }
  })
}
