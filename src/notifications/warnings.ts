// The three notifications nothing a rider does can trigger.
//
// Every other event in the catalog has an actor pressing a button. These three
// are about a DEADLINE arriving or a THRESHOLD being crossed, so the only thing
// that can raise them is a sweep — which is why they live here rather than
// beside a route, and why each one needs an anti-repeat stamp that the
// button-driven events do not.
//
// **THEY RIDE ON THE SWEEPS THAT ALREADY RUN AND ADD NO SIXTH TIMER.** There are
// five `unref()`d intervals in src/index.tsx and they are named in AGENTS.md;
// this adds none. `warnRidePurges` runs inside the hourly trash sweep, which
// already selects on `purge_after`, and both account warnings run inside the
// five-minutely quota sweep, which already walks every rider.
//
// **THE ACCOUNT-DELETION WARNING IS DELIBERATELY NOT ON THE ACCOUNT PURGE'S OWN
// SWEEP.** That one is gated behind `PURGE_ACCOUNTS`, which is off by default
// because it destroys rider data — so a warning hung off it would never fire on
// any environment where the destruction is not already armed, which is every
// environment today. The warning has to run whether or not the purge does, and
// the quota sweep is the one that always runs.
//
// **AN ANTI-REPEAT STAMP IS COMPARED, NOT TESTED FOR NULL.** A boolean cannot say
// "warned about the LAST deadline" once a deadline has moved, and both of these
// deadlines move: `purge_after` on a ride is recomputed from scratch every time
// it is binned, and a rider who asks to leave twice gets a fresh one. So each
// stamp is compared against the deadline it was supposedly about, and a stamp
// older than the current hold began is a warning about a purge that never
// happened.
import { and, gt, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, users } from '../db/schema'
import { TRASH_HOLD_DAYS } from '../trash/policy'
import { DELETION_HOLD_DAYS } from '../account/policy'
import { notifyAccountPurgeSoon, notifyQuotaFull, notifyRidePurgeSoon } from './senders'

/**
 * How much notice a rider gets before something is destroyed.
 *
 * **SEVEN DAYS, NOT ONE AND NOT TWENTY-NINE.** A day is not enough to act on
 * something you have forgotten about — a rider on a trip does not read their
 * mail for a week — and a warning most of a month early arrives while the
 * deadline is still abstract and is itself forgotten. Seven is a weekend plus
 * either side of it.
 *
 * It is deliberately the SAME number for both, although the two holds could
 * diverge: they are both thirty days for reasons that have nothing to do with
 * each other, and a rider being warned about one has no way to know the other is
 * on a different schedule.
 */
export const WARN_LEAD_DAYS = 7
const LEAD_MS = WARN_LEAD_DAYS * 86_400_000

/**
 * How full is nearly full.
 *
 * **NINETY PERCENT, WHICH IS ABOUT ONE MORE IMPORT.** An import is roughly
 * 0.3–1 MB against a 100 MB allowance, so 90% is ten or more uploads of
 * headroom — early enough to be a nudge rather than a refusal, and late enough
 * that it is not fired at somebody who has barely started. Below about 80% it
 * would reach riders with dozens of imports left, which reads as an upsell.
 */
export const QUOTA_WARN_PERCENT = 90

/** MB with one decimal, for a number a rider reads once. `fmtNumber` is the
 *  locale-aware one and is not reached for here: this is a size, the three date
 *  formats all group identically, and the sweeps have no request to read a
 *  preference off. */
const mb = (bytes: number): string => `${Math.round((bytes / 1_048_576) * 10) / 10} MB`

/**
 * Rides a week from being destroyed, warned once each.
 *
 * **IT SELECTS ON `purge_after` AND NOT ON `deleted_at`**, so a ride restored
 * and re-binned is warned again about its new deadline rather than being
 * skipped because it was warned about the old one — the comparison in the
 * predicate is what does that, and testing `purge_warned_at is null` would not.
 *
 * The stamp is written BEFORE the notification goes, which is the opposite of
 * the usual order and is right here: this runs hourly, `notify()` is
 * fire-and-forget, and stamping afterwards leaves a window in which the next
 * sweep selects the same ride again. A warning lost to a failed send is a
 * missing message; a warning sent every hour for a week is worse.
 */
export async function warnRidePurges(now: Date = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + LEAD_MS)
  const due = await db
    .select({ id: rides.id, ownerId: rides.ownerId, title: rides.title, purgeAfter: rides.purgeAfter })
    .from(rides)
    .where(
      and(
        isNotNull(rides.deletedAt),
        isNotNull(rides.purgeAfter),
        // Inside the window, and not already gone. A ride past its deadline is
        // the purge's business, not this one's — warning about a destruction
        // that has already happened is the one thing this must never do.
        lte(rides.purgeAfter, horizon),
        gt(rides.purgeAfter, now),
        // Never warned, or warned about a DIFFERENT (earlier) deadline — which
        // is what a restore-and-rebin leaves behind.
        or(
          sql`${rides.purgeWarnedAt} is null`,
          lt(rides.purgeWarnedAt, sql`${rides.purgeAfter} - ${`${TRASH_HOLD_DAYS} days`}::interval`),
        ),
      ),
    )
    .limit(50)
  if (due.length === 0) return 0

  // `inArray` AND NOT A HAND-WRITTEN `in`: drizzle expands a JS array inside a
  // tagged sql template into a tuple, so the literal form emits `in (($1, $2))`
  // — invalid SQL, no type error, and it fails at runtime on the first sweep
  // that actually finds something. AGENTS.md names this one.
  await db
    .update(rides)
    .set({ purgeWarnedAt: now })
    .where(
      inArray(
        rides.id,
        due.map((d) => d.id),
      ),
    )

  notifyRidePurgeSoon(
    due.map((d) => ({ ownerId: d.ownerId, title: d.title, purgeAfter: d.purgeAfter as Date })),
    now,
  )
  return due.length
}

/**
 * Riders at or over the line, and riders who have dropped back under it.
 *
 * **CLEARING THE STAMP IS HALF THE FEATURE.** Without it a rider is warned once
 * and never again — so somebody who frees space, refills it and hits the ceiling
 * a second time gets no warning at all, and the ceiling arrives as a refused
 * upload with no explanation. Clearing on the way down is what makes the warning
 * repeatable without being repetitive.
 *
 * It reads `used_bytes` rather than the authoritative sum, deliberately: this
 * runs immediately after `reconcileUsedBytes()` in the same sweep, so the tally
 * has just been repaired, and the QUOTA CHECK reads the tally too — warning
 * about a number the enforcement does not use would be warning about the wrong
 * thing.
 */
export async function warnQuota(now: Date = new Date()): Promise<number> {
  const overLine = sql`${users.usedBytes} * 100 >= ${users.quotaBytes} * ${QUOTA_WARN_PERCENT}`

  // Back under the line: forget, so the next crossing is heard.
  await db
    .update(users)
    .set({ quotaWarnedAt: null })
    .where(and(isNotNull(users.quotaWarnedAt), sql`not (${overLine})`))

  const due = await db
    .select({ id: users.id, used: users.usedBytes, quota: users.quotaBytes })
    .from(users)
    .where(and(overLine, sql`${users.quotaWarnedAt} is null`, sql`${users.quotaBytes} > 0`))
    .limit(50)
  if (due.length === 0) return 0

  await db.update(users).set({ quotaWarnedAt: now }).where(
    inArray(
      users.id,
      due.map((d) => d.id),
    ),
  )

  for (const u of due) {
    // Floored, so a rider at 99.6% is never told they are at 100% of an
    // allowance they have not actually filled.
    const percent = Math.floor((u.used / u.quota) * 100)
    notifyQuotaFull(u.id, mb(u.used), mb(u.quota), percent)
  }
  return due.length
}

/**
 * Riders a week from having their account destroyed, warned once each.
 *
 * Same comparison as the ride warning and for the same reason: Save Me clears
 * `purge_after`, and a rider who asks to leave a second time gets a fresh one —
 * so a stamp older than the current hold began is a warning about a deletion
 * that was canceled, and they are warned again.
 */
export async function warnAccountPurges(now: Date = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + LEAD_MS)
  const due = await db
    .select({ id: users.id, purgeAfter: users.purgeAfter })
    .from(users)
    .where(
      and(
        isNotNull(users.purgeAfter),
        lte(users.purgeAfter, horizon),
        gt(users.purgeAfter, now),
        or(
          sql`${users.purgeWarnedAt} is null`,
          lt(users.purgeWarnedAt, sql`${users.purgeAfter} - ${`${DELETION_HOLD_DAYS} days`}::interval`),
        ),
      ),
    )
    .limit(50)
  if (due.length === 0) return 0

  await db.update(users).set({ purgeWarnedAt: now }).where(
    inArray(
      users.id,
      due.map((d) => d.id),
    ),
  )

  for (const u of due) notifyAccountPurgeSoon(u.id, u.purgeAfter as Date, now)
  return due.length
}
