// Starting and cancelling a deletion. The queries; the rules are in ./policy.ts.
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { users, type UserRow } from '../db/schema'
import { OWNER_EMAIL } from '../config'
import { canDeleteAccount, purgeDateFor, type DeletionCheck } from './policy'

/**
 * How many OTHER accounts could still reach /admin if this one left.
 *
 * Active only: a pending or blocked manager cannot get past requireManageRiders,
 * so counting them would let the last usable manager delete themselves and
 * strand the app with an admin surface nobody can open.
 */
async function otherManagerCount(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.canManageRiders, true), eq(users.status, 'active'), ne(users.id, userId)))
  return row?.n ?? 0
}

/** The rules, with the counts they need read from the database. */
export async function checkCanDelete(user: UserRow): Promise<DeletionCheck> {
  return canDeleteAccount({
    isOwner: (user.email ?? '').trim().toLowerCase() === OWNER_EMAIL,
    canManageRiders: user.canManageRiders,
    otherManagerCount: user.canManageRiders ? await otherManagerCount(user.id) : 0,
    alreadyLeaving: user.deletionRequestedAt != null,
  })
}

export type DeletionRequested = { purgeAfter: Date }

/**
 * Start the hold.
 *
 * Conditional on deletion_requested_at still being null, with returning(), so
 * the database decides whether this request is the one that started it — the
 * same idiom the admin status flip and the invite seat claim use. A
 * double-submitted form cannot produce two different purge dates.
 *
 * Nothing is destroyed and nothing is even hidden by this write. Rides go dark
 * because every read path asks whether the owner is leaving, not because
 * anything about the rides changed, which is what makes cancelling free.
 */
export async function requestDeletion(userId: number, now = new Date()): Promise<DeletionRequested | null> {
  const purgeAfter = purgeDateFor(now)

  const [row] = await db
    .update(users)
    .set({ deletionRequestedAt: now, purgeAfter, updatedAt: now })
    .where(and(eq(users.id, userId), isNull(users.deletionRequestedAt)))
    .returning({ purgeAfter: users.purgeAfter })

  if (!row?.purgeAfter) return null
  console.log(`[account] user ${userId} requested deletion, purge after ${row.purgeAfter.toISOString()}`)
  return { purgeAfter: row.purgeAfter }
}

/**
 * Save Me, server side: clear the three columns and nothing else.
 *
 * Everything comes back because nothing left. status, username, public_id, the
 * rides, the files and the quota were never touched, so there is no restore to
 * perform — only a flag to clear.
 *
 * Refuses a row whose purge has already been claimed. Between purge_started_at
 * being stamped and the transaction committing, the rows are already going; a
 * cancel accepted in that window would report success and then find the account
 * gone.
 */
export async function cancelDeletion(userId: number, by: 'rider' | 'admin', now = new Date()): Promise<boolean> {
  const [row] = await db
    .update(users)
    .set({ deletionRequestedAt: null, purgeAfter: null, purgeStartedAt: null, updatedAt: now })
    .where(and(eq(users.id, userId), isNotNull(users.deletionRequestedAt), isNull(users.purgeStartedAt)))
    .returning({ id: users.id })

  if (row) console.log(`[account] deletion cancelled for user ${userId} by ${by}`)
  return Boolean(row)
}
