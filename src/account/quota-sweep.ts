// Keeping `users.used_bytes` honest.
//
// THE PROBLEM, and it is a database bookkeeping problem rather than a rider-
// facing one. Two numbers should always be equal:
//
//   - `users.used_bytes` — one integer per rider, a running tally the app
//     maintains by hand: added to on import (src/routes/maps.ts), subtracted
//     from on delete.
//   - `sum(rides.size_bytes)` — the actual total. `size_bytes` is a GENERATED
//     column, computed by Postgres from the three byte columns, so it cannot
//     disagree with the files.
//
// They part company because the tally is written by app code in two places and
// nothing has ever recomputed it. Three ways it goes wrong, all observed or
// reachable: the delete clamps with `GREATEST(0, …)`, so an over-subtraction is
// silently absorbed and the tally never recovers; an import that fails after the
// increment leaves it high; and a byte column missing from the generated
// expression leaks quota on every delete, permanently — AGENTS.md calls that one
// out by name.
//
// WHAT IT ACTUALLY COSTS A RIDER. Nothing they can see: the storage meter on the
// dashboard renders the authoritative sum, so the number in front of them is
// right either way. **The quota CHECK reads the tally.** Drifting high denies an
// upload they have room for; drifting low lets them past their limit. That is
// the whole of the harm, and it is why this repairs rather than reports.
//
// Decided 2026-08-24, answering the first of #103's four open questions. The
// alternatives were to keep logging it (fixes nothing) and to drop the column and
// sum on every upload (nothing can drift, but every upload pays for an aggregate
// where it used to read one integer). Repairing on a schedule keeps the cheap
// read and bounds how long a wrong answer can survive.
//
// ONE STATEMENT, NOT A LOOP. Riders are counted in the tens and the sum is over
// an indexed owner_id, so a single UPDATE ... FROM does every one of them, and
// there is no per-rider round trip to pace or batch.
//
// FEEDBACK ATTACHMENT BYTES MUST STAY OUT OF THIS. They are counted in
// `feedback_attachments.bytes` and nowhere else: an attachment is not ride data
// and must not eat a rider's quota. This sums `rides.size_bytes` alone, which is
// the same expression the meter reads, so the two cannot disagree about what
// counts.
import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { users } from '../db/schema'

/**
 * Rewrites every rider's `used_bytes` from the authoritative sum.
 *
 * Returns how many rows actually moved, which is the number worth logging: zero
 * is the expected result and a non-zero one says the tally drifted, which is a
 * bug somewhere in the increment/decrement paths rather than routine.
 *
 * The `is distinct from` is what makes that count meaningful — an unconditional
 * UPDATE would report every rider every time and tell you nothing.
 */
export async function reconcileUsedBytes(): Promise<number> {
  const res = await db.execute(sql`
    update ${users} u
       set used_bytes = t.total,
           updated_at = now()
      from (
             select ${users.id} as id,
                    coalesce((select sum(r.size_bytes) from rides r where r.owner_id = ${users.id}), 0) as total
               from ${users}
           ) t
     where u.id = t.id
       and u.used_bytes is distinct from t.total
  `)
  return (res as unknown as { rowCount?: number }).rowCount ?? 0
}

/** How often the tally is repaired. Shares the thumbnail sweep's cadence rather
 *  than inventing a second one — they are two jobs on one schedule, not one job.
 *  Five minutes bounds how long a wrongly-denied upload can persist. */
export const QUOTA_SWEEP_INTERVAL_MS = 5 * 60_000

/**
 * Starts the repair timer.
 *
 * Unlike the thumbnail sweep this is NOT gated on a Google key — it touches no
 * external service, costs one statement, and the thing it protects is a rider's
 * ability to upload at all. A deployment with no Maps key should still enforce
 * quota correctly.
 *
 * `unref()` so the timer never holds the process open, and one immediate pass at
 * boot so a restart is also a repair.
 */
export function startQuotaSweep(): void {
  const run = () =>
    reconcileUsedBytes()
      .then((n) => {
        if (n > 0) console.warn(`[quota] repaired used_bytes for ${n} rider${n === 1 ? '' : 's'}`)
      })
      .catch((err) => console.error('quota sweep failed', err))
  run()
  const timer = setInterval(run, QUOTA_SWEEP_INTERVAL_MS)
  timer.unref()
}
