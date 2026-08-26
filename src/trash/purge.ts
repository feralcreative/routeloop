// The recycle bin's purge. THE ONLY CODE IN THE APP THAT DESTROYS A RIDER'S
// RIDE, and the reason every other path in ./service.ts is reversible.
//
// Rules in ./policy.ts, bin operations in ./service.ts, this is the end of the
// line. Nothing here is undoable and nothing here asks a rider anything: a row
// is destroyed because a deadline they were shown has passed.
//
// ORDER MATTERS AND IT IS FILES FIRST, ROW SECOND. The opposite order — the one
// the old hard delete used, correctly, because it had no claim column — leaves
// orphaned files if the process dies between the two: the row that named them is
// gone, so nothing can ever find them again. This way a crash leaves a claimed
// row with its files already removed, and the stale-claim reclaim below picks it
// up and finishes the job. deleteMapFiles is best-effort and idempotent, so
// running it twice costs nothing.
import { and, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { placeGroups, places, rides } from '../db/schema'
import { deleteMapFiles } from '../maps/storage'

/**
 * How long a claim is trusted before another sweep may take it.
 *
 * A claim exists so two sweeps cannot purge the same ride at once. It has to
 * expire, or a process that died mid-purge strands its row forever — claimed, so
 * never re-selected, and half-destroyed. An hour is far longer than a purge can
 * legitimately take and far shorter than the thirty-day hold it sits inside.
 */
export const CLAIM_STALE_MS = 60 * 60_000

/** How many rides one pass will destroy. A bound on the blast radius of a bug
 *  as much as on the work: a sweep that has gone wrong stops after this many
 *  and says so, rather than emptying the table before anyone notices. */
export const MAX_PURGE_PER_SWEEP = 50

/**
 * Destroys every ride whose hold has run out.
 *
 * Returns how many it removed, which is what makes it worth calling by hand from
 * a script as well as on the timer.
 */
export async function purgeDueRides(now: Date = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS)

  // Claim and select in one statement. Two sweeps racing here both run the same
  // UPDATE, and only one of them gets each row back — Postgres serializes the
  // writes and the loser's WHERE no longer matches. A SELECT followed by an
  // UPDATE would leave a window between them.
  const claimed = await db
    .update(rides)
    .set({ purgeStartedAt: now })
    .where(
      and(
        isNotNull(rides.deletedAt),
        isNotNull(rides.purgeAfter),
        lte(rides.purgeAfter, now),
        or(isNull(rides.purgeStartedAt), lte(rides.purgeStartedAt, staleBefore)),
        sql`${rides.id} in (
          select id from rides
           where deleted_at is not null
             and purge_after is not null
             and purge_after <= ${now}
             and (purge_started_at is null or purge_started_at <= ${staleBefore})
           order by purge_after
           limit ${MAX_PURGE_PER_SWEEP}
        )`,
      ),
    )
    .returning({ id: rides.id, ownerId: rides.ownerId, slug: rides.slug, sizeBytes: rides.sizeBytes })

  let destroyed = 0
  for (const ride of claimed) {
    try {
      await deleteMapFiles(ride.ownerId, ride.id)
      await db.delete(rides).where(sql`${rides.id} = ${ride.id}`) // days/points/legs/details cascade
      destroyed++
      // Logged per ride and not just counted. This is irreversible, so the log is
      // the only record that the ride ever existed once the row is gone.
      console.log(`[purge] destroyed ride ${ride.id} (${ride.slug}) of user ${ride.ownerId}`)
    } catch (err) {
      // Left claimed. The stale reclaim retries it in an hour rather than this
      // sweep spinning on a row that just failed.
      console.error(`[purge] ride ${ride.id} failed`, err)
    }
  }
  return destroyed
}

/**
 * Destroys every saved place and place group whose hold has run out.
 *
 * No claim column and no loop: neither stores a file, so each is one statement
 * that is atomic on its own and idempotent if it runs twice.
 *
 * Groups go last so a place purged in the same pass is removed as a place rather
 * than being briefly ungrouped by the group's `set null` first. The end state is
 * identical either way — this is about the intermediate one being sensible if
 * something reads the table between the two statements.
 */
export async function purgeDuePlaces(now: Date = new Date()): Promise<{ places: number; groups: number }> {
  const placeRows = await db
    .delete(places)
    .where(and(isNotNull(places.deletedAt), isNotNull(places.purgeAfter), lte(places.purgeAfter, now)))
    .returning({ id: places.id })

  const groupRows = await db
    .delete(placeGroups)
    .where(and(isNotNull(placeGroups.deletedAt), isNotNull(placeGroups.purgeAfter), lte(placeGroups.purgeAfter, now)))
    .returning({ id: placeGroups.id })

  return { places: placeRows.length, groups: groupRows.length }
}

export type TrashPurgeResult = { rides: number; places: number; groups: number }

/** One pass over everything in the bin. */
export async function purgeTrash(now: Date = new Date()): Promise<TrashPurgeResult> {
  const rideCount = await purgeDueRides(now)
  const { places: placeCount, groups: groupCount } = await purgeDuePlaces(now)
  return { rides: rideCount, places: placeCount, groups: groupCount }
}

/**
 * How often the bin is emptied.
 *
 * HOURLY, not the five minutes the quota and thumbnail sweeps use, and the
 * difference is what each one is racing. Those two exist to bound how long a
 * WRONG ANSWER survives — a denied upload, a stale picture — so they want to be
 * frequent. This one enforces a thirty-day deadline, where an hour of slack is
 * invisible to everybody and 24 queries a day beats 288 for the same outcome.
 *
 * Exported because the account purge runs on the same schedule. Two jobs on one
 * cadence, the same arrangement the quota sweep has with the thumbnail sweep.
 */
export const PURGE_SWEEP_INTERVAL_MS = 60 * 60_000

/**
 * Starts the bin's timer.
 *
 * `unref()` so it never holds the process open, and one immediate pass at boot
 * so a restart is also a sweep — both copied from startQuotaSweep(), which is
 * the pattern this app uses for background work.
 */
export function startTrashPurge(): void {
  const run = () =>
    purgeTrash()
      .then(({ rides: r, places: p, groups: g }) => {
        if (r || p || g) console.log(`[purge] bin emptied: ${r} ride(s), ${p} place(s), ${g} group(s)`)
      })
      .catch((err) => console.error('trash purge failed', err))
  run()
  const timer = setInterval(run, PURGE_SWEEP_INTERVAL_MS)
  timer.unref()
}
