// The tour's bookkeeping: which ride it is building, and the two stamps.
//
// Split from routes/tour.ts so the hourly trash sweep can bin an abandoned
// tour ride without importing a route module — the rule-from-query split
// every other subsystem here follows.
import { and, eq, lt, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, userProfiles, users } from '../db/schema'
import { deleteMapFiles } from '../maps/storage'
import { LIVE_RIDE } from '../trash/service'
import { fromAcceptLanguage } from '../views/date-format'

/**
 * Destroys the tour ride outright. THE SECOND PLACE IN THE APP THAT DESTROYS A
 * RIDE, beside src/trash/purge.ts, and the distinction is whose work it is:
 * the purge destroys a ride a RIDER made, after a hold they were shown, and
 * this destroys one the APP made for a demonstration. It was binned until
 * 2026-09-13 — Ziad's call, after twenty-eight copies of Coast run had
 * collected in his recycle bin: a tour ride is never the rider's work, so a
 * bin entry for it is furniture, and a rider who takes the tour twice must
 * not find two of them waiting to be emptied.
 *
 * GUARDED ON THE OWNER AND THE ID, never on the title, and every caller has
 * already matched the id against `user_profiles.tour_ride_id`. A ride the
 * rider binned by hand in the meantime is destroyed too — it is still the
 * tour's — and its quota was freed when it was binned, so the decrement is
 * made only for a live one. Files first for the reason purge.ts records,
 * although a tour ride stores none.
 */
export async function destroyTourRide(ownerId: number, rideId: number): Promise<boolean> {
  await deleteMapFiles(ownerId, rideId)
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(rides)
      .where(and(eq(rides.id, rideId), eq(rides.ownerId, ownerId)))
      .returning({ sizeBytes: rides.sizeBytes, deletedAt: rides.deletedAt })
    if (!row) return false
    if (row.deletedAt === null && (row.sizeBytes ?? 0) > 0) {
      await tx
        .update(users)
        .set({ usedBytes: sql`GREATEST(0, ${users.usedBytes} - ${row.sizeBytes ?? 0})`, updatedAt: new Date() })
        .where(eq(users.id, ownerId))
    }
    console.log(`[tour] destroyed tour ride ${rideId} of user ${ownerId}`)
    return true
  })
}

/** How long a tour ride may sit untouched before the sweep destroys it. A day:
 *  long enough that no tour still in progress is taken from under a rider,
 *  short enough that a closed tab does not leave a "Coast run" on the
 *  dashboard for a week. */
export const ABANDONED_TOUR_MS = 24 * 60 * 60_000

/** The tour ride this rider currently has, if any, read off their profile row. */
export async function tourRideOf(userId: number): Promise<number | null> {
  const [row] = await db
    .select({ tourRideId: userProfiles.tourRideId })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
  return row?.tourRideId ?? null
}

/**
 * Writes the two tour columns through the same lazily-created-row upsert every
 * handler in settings.tsx uses, WITH THE SAME SEEDING TRAP: a rider taking the
 * tour on their first visit is exactly the rider with no `user_profiles` row,
 * so the INSERT has to seed `date_format` from the header or the tour would
 * stamp en-US over what Accept-Language was giving them for free.
 */
export async function stampTour(
  userId: number,
  acceptLanguage: string | undefined,
  set: { tourRideId?: number | null; tourDoneAt?: Date },
): Promise<void> {
  const now = new Date()
  await db
    .insert(userProfiles)
    .values({ userId, dateFormat: fromAcceptLanguage(acceptLanguage), updatedAt: now, ...set })
    .onConflictDoUpdate({ target: userProfiles.userId, set: { ...set, updatedAt: now } })
}

/**
 * Destroys tour rides that were simply abandoned — a tab closed mid-tour
 * leaves a live ride called Coast run on the dashboard with nobody coming
 * back for it. Called from the hourly trash sweep, so it adds no timer; a
 * day is long enough that no tour still in progress is ever taken from under
 * a rider. The profile's `tour_ride_id` goes null with the row (`set null`),
 * so the next start finds nothing to clear.
 */
export async function destroyAbandonedTourRides(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ABANDONED_TOUR_MS)
  const rows = await db
    .select({ userId: userProfiles.userId, rideId: rides.id })
    .from(userProfiles)
    .innerJoin(rides, eq(rides.id, userProfiles.tourRideId))
    .where(and(LIVE_RIDE, eq(rides.ownerId, userProfiles.userId), lt(rides.createdAt, cutoff)))
  let n = 0
  for (const r of rows) if (await destroyTourRide(r.userId, r.rideId)) n++
  if (n > 0) console.log(`[tour] destroyed ${n} abandoned tour ride${n === 1 ? '' : 's'}`)
  return n
}
