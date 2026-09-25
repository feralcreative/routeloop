// The database half of the public profile. policy.ts decides; this only loads.
import { and, asc, eq, or, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { bikes, friendships, rides, routeLegs, routes, userProfiles, type BikeRow } from '../db/schema'
import { LISTED_RIDE } from '../access/query'
import { LIVE_RIDE } from '../trash/service'
import { NOMINAL_SPEED_MS } from '../maps/ride-time'
import type { RawTwist } from '../stats/shape'
import { toProfileVisibility, type ProfileVisibility } from './policy'

export type ProfileGate = { visibility: ProfileVisibility; sharePaddock: boolean }

/** A rider with no profile row gets the defaults, the same as the column. */
export async function profileGateOf(userId: number): Promise<ProfileGate> {
  const [row] = await db
    .select({ visibility: userProfiles.profileVisibility, sharePaddock: userProfiles.sharePaddock })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
  return { visibility: toProfileVisibility(row?.visibility), sharePaddock: row?.sharePaddock ?? false }
}

/** The owner of a bike, for the photo route, which is addressed by bike id alone. */
export async function bikeForPhoto(id: number): Promise<Pick<BikeRow, 'id' | 'ownerId' | 'photoHash'> | undefined> {
  const [row] = await db
    .select({ id: bikes.id, ownerId: bikes.ownerId, photoHash: bikes.photoHash })
    .from(bikes)
    .where(eq(bikes.id, id))
    .limit(1)
  return row
}

export async function friendCount(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(friendships)
    .where(
      and(eq(friendships.status, 'accepted'), or(eq(friendships.riderA, userId), eq(friendships.riderB, userId))),
    )
  return row?.n ?? 0
}

export type PublicStats = { rides: number; distanceM: number; durationS: number; twist: RawTwist[] }

/**
 * Totals over LISTED rides only, so a figure on a public page never includes a
 * private ride. Active alternates only, and the same saddle-time estimate the
 * dashboard uses for legs the router never timed.
 */
export async function publicStats(userId: number): Promise<PublicStats> {
  const listed = and(eq(rides.ownerId, userId), LISTED_RIDE, LIVE_RIDE)
  const counted = and(listed, eq(routes.altActive, true))

  const [rideRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rides)
    .where(listed)

  const [legRow] = await db
    .select({
      distanceM: sql<number>`coalesce(sum(${routeLegs.distanceM}), 0)::bigint`,
      durationS: sql<number>`coalesce(sum(case
          when ${routeLegs.durationS} <= 0 and ${routeLegs.distanceM} > 0
            then round(${routeLegs.distanceM}::numeric / ${NOMINAL_SPEED_MS})
          else ${routeLegs.durationS}
        end), 0)::bigint`,
    })
    .from(routeLegs)
    .innerJoin(routes, eq(routes.id, routeLegs.routeId))
    .innerJoin(rides, eq(rides.id, routes.rideId))
    .where(counted)

  const twist = await db
    .select({ dpm: sql<number>`${routes.twistinessDpm}::int`, distanceM: sql<number>`${routes.distanceM}::int` })
    .from(routes)
    .innerJoin(rides, eq(rides.id, routes.rideId))
    .where(and(counted, sql`${routes.twistinessDpm} is not null`, sql`${routes.distanceM} > 0`))

  return {
    rides: rideRow?.n ?? 0,
    distanceM: Number(legRow?.distanceM ?? 0),
    durationS: Number(legRow?.durationS ?? 0),
    twist: twist as RawTwist[],
  }
}

export const paddockOf = (userId: number): Promise<BikeRow[]> =>
  db.select().from(bikes).where(eq(bikes.ownerId, userId)).orderBy(asc(bikes.position), asc(bikes.id))
