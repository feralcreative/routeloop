// The timed half of voting: closing a ride's alternate vote and applying it.
//
// The rules are ./policy.ts and the writes are ./service.ts. This file is only
// the schedule, kept apart for the same reason src/trash/purge.ts is kept apart
// from service.ts — a thing that runs unattended and rewrites rider data should
// be one small file somebody can read in full.
//
// WHAT IT ACTUALLY CHANGES is which alternate counts toward a ride: `alt_active`
// and nothing else. It never deletes, never routes, and never touches a day that
// is not part of a group. A ride with no deadline is never selected at all —
// `alt_votes_close_at` is null for every ride that existed before this landed
// and for every ride whose owner has not asked for one.
import { and, eq, isNotNull, lte } from 'drizzle-orm'
import { db } from '../db/index'
import { rides } from '../db/schema'
import { LIVE_RIDE } from '../trash/service'
import { applyTallies } from './service'

/** Ten minutes. A vote closing is not urgent to the minute — the deadline is a
 *  date an owner picked, not a start gun — and a sweep that runs six times an
 *  hour over a table with almost no rows costs nothing either way. */
export const RESOLVE_SWEEP_INTERVAL_MS = 10 * 60_000

/** A bound on the blast radius of a bug as much as on the work, the same job
 *  MAX_PURGE_PER_SWEEP does one folder over. */
export const MAX_RESOLVE_PER_SWEEP = 50

/**
 * Resolve every ride whose vote has closed, returning how many days changed.
 *
 * **`alt_votes_close_at` IS CLEARED AS PART OF RESOLVING**, and that is what
 * makes this idempotent: a ride is selected because it has a deadline in the
 * past, and applying it removes the deadline, so the next sweep does not see it.
 * Without that, a tie — which resolves to no change — would be re-examined on
 * every pass forever, and the log would fill with a decision nobody made.
 *
 * A cleared deadline also reads correctly to a rider: voting closed, the result
 * stands, and the numbers are still on the page. The owner can set a new one to
 * reopen it, which is the only way back and is deliberately a deliberate act.
 */
export async function resolveDueVotes(now: Date = new Date()): Promise<number> {
  const due = await db
    .select({ id: rides.id })
    .from(rides)
    // LIVE_RIDE: a ride in the recycle bin has a rider who deleted it, and
    // silently rewriting its route while it waits out its thirty days would be
    // a change nobody could see and nobody asked for.
    .where(and(isNotNull(rides.altVotesCloseAt), lte(rides.altVotesCloseAt, now), LIVE_RIDE))
    .limit(MAX_RESOLVE_PER_SWEEP)

  let changed = 0
  for (const r of due) {
    // Per ride rather than one transaction over all of them: a ride whose
    // tallies throw must not take the others down with it, and each ride's
    // resolution is independent of every other.
    try {
      const winners = await applyTallies(r.id)
      changed += winners.length
      await db.update(rides).set({ altVotesCloseAt: null }).where(eq(rides.id, r.id))
      if (winners.length > 0) console.log(`[votes] ride ${r.id}: elected ${winners.join(', ')}`)
    } catch (err) {
      console.error(`[votes] ride ${r.id} failed to resolve`, err)
    }
  }
  return changed
}

/** Started from src/index.tsx alongside the other sweeps. `unref()` so it never
 *  holds the process open, the same as every other timer in the app. */
export function startVoteResolver(): void {
  const run = () =>
    resolveDueVotes()
      .then((n) => {
        if (n) console.log(`[votes] ${n} alternate(s) elected by vote`)
      })
      .catch((err) => console.error('vote resolve failed', err))
  run()
  const timer = setInterval(run, RESOLVE_SWEEP_INTERVAL_MS)
  timer.unref()
}
