// "Near me" on /explore (#37): listed rides whose road passes within NEAR_MILES of a
// point, nearest first. Read from route_tracks, so a ride with no drawn road is
// never near anything. The same three predicates as the other /explore tabs: listed,
// not binned, and not owned by a rider who has asked to leave.
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, routeTracks, routes as routesTable, users } from '../db/schema'
import { LISTED_RIDE } from '../access/query'
import { LIVE_RIDE } from '../trash/service'
import { METERS_PER_MILE } from '../maps/kml'

export const NEAR_MILES = 50
export const NEAR_LIMIT = 24

export function validPoint(lng: unknown, lat: unknown): [number, number] | null {
  const x = Number(lng)
  const y = Number(lat)
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) return null
  return [x, y]
}

export async function ridesNear([lng, lat]: [number, number]) {
  const here = sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`
  const near = db
    .select({
      rideId: routeTracks.rideId,
      d: sql<number>`min(ST_Distance(${routeTracks.track}::geography, ${here}))`.as('d'),
    })
    .from(routeTracks)
    .where(sql`ST_DWithin(${routeTracks.track}::geography, ${here}, ${NEAR_MILES * METERS_PER_MILE})`)
    .groupBy(routeTracks.rideId)
    .as('near')
  return db
    .select({ ride: rides, color: routesTable.color, d: near.d })
    .from(rides)
    .innerJoin(near, eq(near.rideId, rides.id))
    .innerJoin(users, eq(users.id, rides.ownerId))
    .leftJoin(routesTable, and(eq(routesTable.rideId, rides.id), eq(routesTable.position, 0)))
    .where(and(LISTED_RIDE, isNull(users.deletionRequestedAt), LIVE_RIDE))
    .orderBy(asc(near.d))
    .limit(NEAR_LIMIT)
}
