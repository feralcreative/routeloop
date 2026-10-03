// The Most Active board (#192): the query. Rules in ./policy.ts.
//
// No cache, unlike cachedGlobalStats(): the aggregate starts from the riders who
// opted in, which is a short list, rather than from every ride in the app.
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, userProfiles, users } from '../db/schema'
import { LISTED_RIDE } from '../access/query'
import { LIVE_RIDE } from '../trash/service'
import { notBlockedWith } from '../friends/service'
import { BOARD_SIZE, rank, type Metric } from './policy'

export type BoardRow = {
  id: number
  displayName: string
  username: string
  avatarUrl: string | null
  avatarBytes: number
  miles: number
  rides: number
  stops: number
  rank: number
}

export async function leaderboard(viewerId: number, metric: Metric): Promise<BoardRow[]> {
  const miles = sql<number>`coalesce(sum(${rides.totalMiles}), 0)::float8`
  const rideCount = sql<number>`count(${rides.id})::int`
  const stops = sql<number>`coalesce(sum(${rides.stopCount}), 0)::int`
  const order = metric === 'rides' ? rideCount : metric === 'stops' ? stops : miles
  const rows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      username: users.username,
      avatarUrl: users.avatarUrl,
      avatarBytes: sql<number>`coalesce(${userProfiles.avatarBytes}, 0)`,
      miles,
      rides: rideCount,
      stops,
    })
    .from(users)
    .innerJoin(userProfiles, and(eq(userProfiles.userId, users.id), eq(userProfiles.onLeaderboard, true)))
    // Listed and live only, the same rides a public profile counts.
    .leftJoin(rides, and(eq(rides.ownerId, users.id), LISTED_RIDE, LIVE_RIDE))
    .where(
      and(
        eq(users.status, 'active'),
        isNull(users.deletionRequestedAt),
        eq(users.isGuide, false),
        sql`${users.username} is not null`,
        // Both halves of a block, as on the other tabs. The viewer is NOT excluded
        // here, unlike there: a rider who opted in wants to see where they rank.
        notBlockedWith(viewerId),
      ),
    )
    .groupBy(users.id, userProfiles.avatarBytes)
    .having(sql`count(${rides.id}) > 0`)
    .orderBy(desc(order), users.displayName)
    .limit(BOARD_SIZE)
  const shaped = rows.map((r) => ({ ...r, username: r.username!, miles: Number(r.miles) }))
  return rank(shaped, (r) => (metric === 'rides' ? r.rides : metric === 'stops' ? r.stops : r.miles))
}
