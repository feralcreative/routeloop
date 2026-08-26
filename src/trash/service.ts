// The recycle bin's query side. The rules it obeys are in ./policy.ts.
//
// THIS FILE EXISTS SO THERE IS ONE PLACE TO FORGET. A nullable `deleted_at`
// means every query that lists, counts, sums or resolves a row now has to opt
// out of the bin, and nothing enforces that it does — a missed one shows a
// trashed ride on the dashboard, counts it in the stats, keeps a share link
// alive, or hands its bytes back to the quota tally. That is the same shape as
// "only active days count, and there is no single place that enforces it" in
// AGENTS.md, and the mitigation is the same: name the predicate once, import it
// everywhere, and make an omission visible in review as a missing import rather
// than invisible as an absent `is null`.
import { isNotNull, isNull } from 'drizzle-orm'
import { placeGroups, places, rides } from '../db/schema'

/** Every ride not in the bin. The default for any query a rider's own eyes reach. */
export const LIVE_RIDE = isNull(rides.deletedAt)

/** Every ride in the bin, due or not. What the bin page lists. */
export const TRASHED_RIDE = isNotNull(rides.deletedAt)

export const LIVE_PLACE = isNull(places.deletedAt)
export const TRASHED_PLACE = isNotNull(places.deletedAt)

export const LIVE_PLACE_GROUP = isNull(placeGroups.deletedAt)
export const TRASHED_PLACE_GROUP = isNotNull(placeGroups.deletedAt)
