// The tour's bookkeeping: which ride it is building, and the two stamps.
//
// Split from routes/tour.ts so the hourly trash sweep can bin an abandoned
// tour ride without importing a route module — the rule-from-query split
// every other subsystem here follows.
import { and, eq, lt } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, userProfiles } from '../db/schema'
import { LIVE_RIDE, trashRide } from '../trash/service'
import { fromAcceptLanguage } from '../views/date-format'

/** How long a tour ride may sit untouched before the sweep bins it. A day:
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
 * Bins tour rides that were simply abandoned — a tab closed mid-tour leaves
 * a live ride called Coast run on the dashboard with nobody coming back for
 * it. Called from the hourly trash sweep, so it adds no timer; a day is long
 * enough that no tour still in progress is ever taken from under a rider.
 */
export async function binAbandonedTourRides(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ABANDONED_TOUR_MS)
  const rows = await db
    .select({ userId: userProfiles.userId, rideId: rides.id })
    .from(userProfiles)
    .innerJoin(rides, eq(rides.id, userProfiles.tourRideId))
    .where(and(LIVE_RIDE, eq(rides.ownerId, userProfiles.userId), lt(rides.createdAt, cutoff)))
  let n = 0
  for (const r of rows) if (await trashRide(r.userId, r.rideId)) n++
  if (n > 0) console.log(`[tour] binned ${n} abandoned tour ride${n === 1 ? '' : 's'}`)
  return n
}
