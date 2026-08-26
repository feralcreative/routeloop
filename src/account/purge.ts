// The account purge — the query side ./policy.ts has referred to since it was
// written, and which did not exist until now.
//
// WHAT WAS BROKEN. `/account/delete` stamps `deletion_requested_at` and
// `purge_after`, locks the rider out through auth/middleware.ts, and tells them
// on the page that everything they have will be destroyed on a named date.
// Nothing then destroyed it. The columns, the index (`idx_users_purge_due`), the
// pure rules and the copy were all in place; the runner was missing, so a rider
// who asked to leave was locked out indefinitely and their rows sat there.
//
// THIS IS THE MOST DESTRUCTIVE CODE IN THE APP. It removes a person's account,
// every ride they own, every file they uploaded and every row that cascades from
// them. It is gated on PURGE_ACCOUNTS for exactly that reason: the flag is off
// by default, so deploying this changes nothing until someone decides otherwise,
// and utils/purge-accounts.ts --dry-run reports who WOULD go before anyone does.
//
// Files first, row second — the same ordering argument as trash/purge.ts. Once
// the users row is gone nothing can name the directory that belonged to it, so
// removing it afterwards risks orphaning a rider's files permanently.
import { and, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { users } from '../db/schema'
import { PURGE_ACCOUNTS } from '../config'
import { deleteOwnerDir } from '../maps/storage'
import { PURGE_SWEEP_INTERVAL_MS } from '../trash/purge'
import { deletionState } from './policy'

/** As in trash/purge.ts: a claim has to expire or a crashed sweep strands the
 *  row it was working on, claimed and therefore never selected again. */
export const CLAIM_STALE_MS = 60 * 60_000

/** A bound on the blast radius. Riders are counted in the tens, so a pass that
 *  wants to destroy more than this is a bug, not a backlog. */
export const MAX_PURGE_PER_SWEEP = 10

export type AccountPurgeCandidate = {
  id: number
  /** Nullable on the column, so nullable here — an identity-only account has
   *  none. The dry-run report says so rather than printing an empty string. */
  email: string | null
  purgeAfter: Date | null
}

/**
 * Who is eligible right now, without touching anything.
 *
 * This is what `--dry-run` prints, and it is deliberately a separate function
 * from the one that destroys: a report that shares its selection with the
 * destroyer is the only kind worth trusting, and one that shares its CODE cannot
 * drift from it.
 */
export async function dueAccounts(now: Date = new Date()): Promise<AccountPurgeCandidate[]> {
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS)
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      deletionRequestedAt: users.deletionRequestedAt,
      purgeAfter: users.purgeAfter,
    })
    .from(users)
    .where(
      and(
        isNotNull(users.deletionRequestedAt),
        isNotNull(users.purgeAfter),
        lte(users.purgeAfter, now),
        or(isNull(users.purgeStartedAt), lte(users.purgeStartedAt, staleBefore)),
      ),
    )
    .orderBy(users.purgeAfter)
    .limit(MAX_PURGE_PER_SWEEP)

  // Re-checked through the pure rule rather than trusted from the WHERE clause.
  // deletionState() is the definition of 'due' and it reads purge_after, not
  // deletion_requested_at plus the constant — the two can differ, which is the
  // whole reason purge_after is stored. Belt and braces on the one operation in
  // this app that cannot be undone.
  return rows
    .filter((r) => deletionState(r, now) === 'due')
    .map((r) => ({ id: r.id, email: r.email, purgeAfter: r.purgeAfter }))
}

/**
 * Destroys every account whose hold has run out. Returns how many went.
 *
 * Deleting the `users` row cascades to rides — and through them to days, points,
 * legs and point_details — plus sessions, identities, profile and username
 * history. The directory removal is the half the database cannot do.
 */
export async function purgeDueAccounts(now: Date = new Date()): Promise<number> {
  const candidates = await dueAccounts(now)
  let destroyed = 0

  for (const account of candidates) {
    // Claimed one at a time, and the claim is what makes this safe to run from
    // two places at once: the UPDATE only matches while purge_started_at is
    // still null (or stale), so a second runner gets nothing back for this row.
    const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS)
    const [claim] = await db
      .update(users)
      .set({ purgeStartedAt: now })
      .where(
        and(
          sql`${users.id} = ${account.id}`,
          isNotNull(users.deletionRequestedAt),
          or(isNull(users.purgeStartedAt), lte(users.purgeStartedAt, staleBefore)),
        ),
      )
      .returning({ id: users.id })
    if (!claim) continue

    try {
      await deleteOwnerDir(account.id)
      await db.delete(users).where(sql`${users.id} = ${account.id}`)
      destroyed++
      // The only surviving record that the account existed. Logged before
      // anything else can fail, and without anything that identifies the rider
      // beyond the id — the address is gone and does not belong in a log.
      console.log(`[purge] destroyed account ${account.id} and everything it owned`)
    } catch (err) {
      console.error(`[purge] account ${account.id} failed`, err)
    }
  }
  return destroyed
}

/**
 * Starts the account purge timer, IF it has been turned on.
 *
 * Gated, and the gate is the point. Every other sweep in this app is safe to run
 * unattended because the worst it can do is redraw a picture or correct a
 * number. This one destroys people's accounts, and it is shipping into a
 * database that has had riders sitting past their deadline for as long as the
 * runner has been missing — so the first pass after deploy would destroy them
 * all, correctly, and with no chance to look first.
 *
 * So: off unless PURGE_ACCOUNTS is set, and utils/purge-accounts.ts --dry-run
 * prints exactly who the first pass would take. Turn it on once that list has
 * been read and believed.
 */
export function startAccountPurge(): void {
  if (!PURGE_ACCOUNTS) {
    console.log('[purge] account purge is OFF (set PURGE_ACCOUNTS=on to enable)')
    return
  }
  const run = () =>
    purgeDueAccounts()
      .then((n) => {
        if (n > 0) console.warn(`[purge] destroyed ${n} account${n === 1 ? '' : 's'}`)
      })
      .catch((err) => console.error('account purge failed', err))
  run()
  const timer = setInterval(run, PURGE_SWEEP_INTERVAL_MS)
  timer.unref()
}
