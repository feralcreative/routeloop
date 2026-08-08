// Everything that touches the database on behalf of an invite.
//
// The rules live next door in policy.ts and are tested; this file is the part
// that cannot be, because what it is really doing is arranging for Postgres to
// arbitrate. Read redeemInvite() with that in mind: almost every line is chosen
// so a WHERE clause decides something rather than JavaScript deciding it.
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import { db } from '../db'
import { inviteRedemptions, invites, users } from '../db/schema'
import type { InviteKind, InviteRow, UserRow } from '../db/schema'
import { generateSessionToken, hashToken } from '../auth/session'
import { shouldSendApproval } from '../emails/rules'
import { consumesSeat, inviteStatus, normalizeInviteToken, plannedGrants } from './policy'
import type { InviteLiveness } from './policy'

/** Why a redemption did not happen. `invalid` covers a token that is malformed
 *  or unknown — the two are deliberately indistinguishable to the holder, the
 *  same way /login reports invalid, used and expired links as one message. */
export type RedeemFailure = InviteLiveness | 'invalid'

export class InviteError extends Error {
  constructor(readonly reason: RedeemFailure) {
    super(reason)
    this.name = 'InviteError'
  }
}

export type RedeemResult =
  | {
      outcome: 'granted'
      invite: InviteRow
      beta: boolean
      survey: boolean
      /** Set only when the approval mail is owed. The CALLER sends it, after commit. */
      notifyEmail: string | null
      displayName: string
    }
  | { outcome: 'already' | 'nothing-to-grant'; invite: InviteRow }

// --- Creating ----------------------------------------------------------------

export type NewInvite = {
  kind: InviteKind
  grantsBeta: boolean
  grantsSurvey: boolean
  email: string | null
  label: string | null
  maxUses: number
  expiresAt: Date
  createdBy: number
}

/**
 * Mints an invite and returns the PLAINTEXT token exactly once.
 *
 * Only the hash is stored, following login_tokens, so this return value is the
 * single moment the link exists. The caller has to render it — there is no
 * second chance, and that is what `regenerateInvite` is for.
 */
export async function createInvite(args: NewInvite): Promise<{ invite: InviteRow; token: string }> {
  const token = generateSessionToken()
  const [invite] = await db
    .insert(invites)
    .values({ ...args, tokenHash: await hashToken(token) })
    .returning()
  return { invite, token }
}

/**
 * New token on the SAME row — same id, same label, same used_count, same
 * redemption history.
 *
 * This is the answer to a leaked group link, and it is why token_hash is a
 * unique index rather than the primary key. Revoking would also stop the leak,
 * but it throws away the seat budget and the audit trail with it.
 */
export async function regenerateInvite(id: number): Promise<string | null> {
  const token = generateSessionToken()
  const [row] = await db
    .update(invites)
    .set({ tokenHash: await hashToken(token), updatedAt: new Date() })
    .where(and(eq(invites.id, id), isNull(invites.revokedAt)))
    .returning({ id: invites.id })
  return row ? token : null
}

/** Conditional on `revoked_at is null` so a double submit reports honestly. */
export async function revokeInvite(id: number): Promise<boolean> {
  const [row] = await db
    .update(invites)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(invites.id, id), isNull(invites.revokedAt)))
    .returning({ id: invites.id })
  return Boolean(row)
}

// --- Reading -----------------------------------------------------------------

/**
 * Look an invite up without touching it.
 *
 * GET /i/:token calls this and NOTHING else. A link pasted into a channel is
 * fetched immediately by Discord's unfurler, by every client drawing the preview
 * card, by mail scanners and by browser prefetch — so the GET has to be inert,
 * and the only way to guarantee that is for the read path to have no write in it.
 */
export async function findInviteByToken(rawToken: string): Promise<InviteRow | null> {
  const token = normalizeInviteToken(rawToken)
  if (!token) return null
  const [row] = await db.select().from(invites).where(eq(invites.tokenHash, await hashToken(token))).limit(1)
  return row ?? null
}

export type InviteListRow = InviteRow & { redeemed: number }

/** The admin list. One query — a per-row count would be N+1 on a page that grows. */
export async function listInvites(limit = 100): Promise<InviteListRow[]> {
  const rows = await db
    .select({
      invite: invites,
      redeemed: sql<number>`(select count(*)::int from ${inviteRedemptions} where ${inviteRedemptions.inviteId} = ${invites.id})`,
    })
    .from(invites)
    .orderBy(desc(invites.createdAt))
    .limit(limit)
  return rows.map((r) => ({ ...r.invite, redeemed: r.redeemed }))
}

/** Who came in on one invite, for the detail line under it. */
export async function redeemersOf(inviteId: number): Promise<{ email: string | null; displayName: string; redeemedAt: Date }[]> {
  return db
    .select({ email: users.email, displayName: users.displayName, redeemedAt: inviteRedemptions.redeemedAt })
    .from(inviteRedemptions)
    .innerJoin(users, eq(users.id, inviteRedemptions.userId))
    .where(eq(inviteRedemptions.inviteId, inviteId))
    .orderBy(desc(inviteRedemptions.redeemedAt))
}

// --- Redeeming ---------------------------------------------------------------

/**
 * Redeems an invite for an ALREADY SIGNED-IN rider.
 *
 * Its own transaction, deliberately, and never threaded into the one that
 * creates the account. The seat claim below throws to roll back, and if that
 * rollback also took the users row with it, an exhausted group link would
 * silently destroy the sign-in that triggered it — the rider would be bounced
 * back to /login with no account and no idea why.
 *
 * No mail is sent in here. Everything below holds a pooled connection, and an
 * SMTP round trip inside a transaction is the mistake magic.ts already avoids.
 * The caller sends after the commit, on the returned flags.
 */
export async function redeemInvite(rawToken: string, user: UserRow): Promise<RedeemResult> {
  const token = normalizeInviteToken(rawToken)
  if (!token) throw new InviteError('invalid')
  const hash = await hashToken(token)

  return db.transaction(async (tx) => {
    // A plain read, NOT `for update`. The WHERE clause on the seat claim below
    // is the authority on capacity, revocation and expiry, so a lock here would
    // buy nothing and would serialize every redemption of a group link during
    // exactly the burst that makes a group link worth having.
    //
    // This read exists to produce a SPECIFIC message — "that invite was
    // revoked" rather than a generic refusal. The cost: if an invite is revoked
    // between here and the claim, the rider is told there are no seats left.
    // That is the whole downside and it is acceptable.
    const [invite] = await tx.select().from(invites).where(eq(invites.tokenHash, hash)).limit(1)
    if (!invite) throw new InviteError('invalid')

    const live = inviteStatus(invite, new Date())
    if (live !== 'ok') throw new InviteError(live)

    // Idempotency first, and it is free: the unique index IS the check. A double
    // click, a retried POST and a second visit next week all land here and take
    // the early return instead of a second seat.
    //
    // The conflict target is NAMED. A bare `onConflictDoNothing()` swallows
    // every constraint on the table, and "zero rows" would then mean more than
    // one thing while the line below assumes it means exactly one.
    const [claimed] = await tx
      .insert(inviteRedemptions)
      .values({ inviteId: invite.id, userId: user.id, consumedSeat: false })
      .onConflictDoNothing({ target: [inviteRedemptions.inviteId, inviteRedemptions.userId] })
      .returning({ id: inviteRedemptions.id })

    if (!claimed) return { outcome: 'already', invite }

    // What this invite would actually change for this rider. Advisory, exactly
    // like checkAvailability in auth/username.ts — the conditional UPDATEs below
    // are the authority. Losing this race wastes a seat; it cannot grant
    // anything, which is the only direction that matters.
    const plan = plannedGrants(invite, user)
    if (!consumesSeat(plan)) return { outcome: 'nothing-to-grant', invite }

    // The seat claim, and the WHERE is the claim. Under READ COMMITTED Postgres
    // re-evaluates this predicate against the newly committed row after waiting
    // on the lock, so two riders taking the last seat cannot both come back with
    // a row. Reading used_count above and comparing it in JavaScript would let
    // both through.
    //
    // used_count is not part of any key, so this takes FOR NO KEY UPDATE, which
    // does not conflict with the FOR KEY SHARE the redemption insert just took
    // on this same row. If used_count ever joins a unique index, that stops
    // being true and this becomes a lock-upgrade deadlock.
    const [seat] = await tx
      .update(invites)
      .set({ usedCount: sql`${invites.usedCount} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(invites.id, invite.id),
          lt(invites.usedCount, invites.maxUses),
          isNull(invites.revokedAt),
          gt(invites.expiresAt, new Date()),
        ),
      )
      .returning({ usedCount: invites.usedCount })

    // Rolls the redemption row back with it, which is right: they did not get in.
    if (!seat) throw new InviteError('exhausted')

    await tx.update(inviteRedemptions).set({ consumedSeat: true }).where(eq(inviteRedemptions.id, claimed.id))

    let beta = false
    let notifyEmail: string | null = null
    if (plan.beta) {
      // eq(status, 'pending'), NOT ne(status, 'active'). /admin uses ne()
      // because reinstating a blocked rider is a transition a manager chooses
      // deliberately. An invite must never offer it, or a rider you blocked
      // clicks the link still sitting in the Discord channel and un-blocks
      // themselves. plannedGrants() has already decided this; the predicate here
      // is what enforces it against a concurrent status change.
      //
      // approved_email_at is stamped in the same statement, so there is no
      // window where the status is active and the flag is still null — the same
      // reasoning as routes/admin.tsx.
      const notify = shouldSendApproval(user.status, 'active', user.approvedEmailAt)
      const [changed] = await tx
        .update(users)
        .set({ status: 'active', updatedAt: new Date(), ...(notify ? { approvedEmailAt: new Date() } : {}) })
        .where(and(eq(users.id, user.id), eq(users.status, 'pending')))
        .returning({ email: users.email })
      beta = Boolean(changed)
      if (changed && notify) notifyEmail = changed.email
    }

    let survey = false
    if (plan.survey) {
      const [changed] = await tx
        .update(users)
        .set({ surveyInvitedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(users.id, user.id), isNull(users.surveyInvitedAt)))
        .returning({ id: users.id })
      survey = Boolean(changed)
    }

    return { outcome: 'granted', invite, beta, survey, notifyEmail, displayName: user.displayName }
  })
}

/**
 * Housekeeping, mirroring deleteExpiredLoginTokens — and, like it, UNCALLED.
 *
 * That is deliberate. This app has no scheduler at all, and introducing the
 * first one for the lowest-stakes cleanup in it would invert a decision
 * auth/mailer.ts already argues. Expired invites are inert because the WHERE
 * clause on the seat claim enforces it, and the table holds a few hundred rows
 * forever. Revoked rows are kept regardless: they are the audit trail for a link
 * that leaked, which is exactly when you want to look.
 */
export async function deleteExpiredInvites(before: Date): Promise<void> {
  await db.delete(invites).where(and(lt(invites.expiresAt, before), isNull(invites.revokedAt)))
}
