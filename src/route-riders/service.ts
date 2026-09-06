// Who is on which stretch of road, query side. The rules are in ./policy.ts and
// nothing here re-decides one.
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/index'
import { routeRiders, routes as routesTable, rideMembers } from '../db/schema'
import type { Tx } from '../maps/ride-graph'
import { resolveRouteRiders, routesForRider, type RouteRiderRef, type ResolvedRoute } from './policy'

/**
 * Bring `route_riders` into line with the routes the payload actually carries.
 *
 * **THE SAME OBLIGATION `reconcileVotes` AND `writePointDetails` HAVE, AND FOR
 * THE SAME REASON.** These rows cascade from `rides` and key on `routes.uid`, not
 * on `routes.id` — because the builder's PUT deletes and re-inserts every route on
 * every save — so nothing else cleans them up. Skip this and a deleted route
 * keeps its roster forever, and a uid that later gets reused inherits it.
 *
 * Called from `insertRideGraph`, beside the other two.
 */
export async function reconcileRouteRiders(tx: Tx, rideId: number, liveRouteUids: string[]): Promise<void> {
  if (liveRouteUids.length === 0) {
    await tx.delete(routeRiders).where(eq(routeRiders.rideId, rideId))
    return
  }
  const rows = await tx.select({ routeUid: routeRiders.routeUid }).from(routeRiders).where(eq(routeRiders.rideId, rideId))
  const live = new Set(liveRouteUids)
  const doomed = [...new Set(rows.map((r) => r.routeUid))].filter((uid) => !live.has(uid))
  if (doomed.length > 0) {
    // inArray, never a JS array interpolated into a tagged `sql` template —
    // drizzle expands one into a tuple and `= any((...))` is not valid SQL.
    await tx.delete(routeRiders).where(and(eq(routeRiders.rideId, rideId), inArray(routeRiders.routeUid, doomed)))
  }
}

/** The stored overrides for a ride. Rows are an override and their absence means
 *  "inherit" — see resolveRouteRiders, which is the only place that rule lives. */
export async function routeRiderRefs(rideId: number): Promise<RouteRiderRef[]> {
  return db
    .select({ routeUid: routeRiders.routeUid, riderId: routeRiders.riderId })
    .from(routeRiders)
    .where(eq(routeRiders.rideId, rideId))
}

/**
 * Every route of a ride with the riders actually on it.
 *
 * **THREE READS AND NOT A JOIN**, deliberately: the resolution is a WALK in
 * position order that carries a set forward, so it cannot be expressed as a
 * per-row join anyway — and the roster is an argument rather than a lookup
 * inside the rule, because adding a rider to the ride has to change every
 * inherited route with no write.
 */
export async function resolvedRoutes(rideId: number): Promise<ResolvedRoute[]> {
  const [routes, refs, roster] = await Promise.all([
    db
      .select({ uid: routesTable.uid, position: routesTable.position })
      .from(routesTable)
      .where(eq(routesTable.rideId, rideId))
      .orderBy(routesTable.position),
    routeRiderRefs(rideId),
    db.select({ riderId: rideMembers.riderId }).from(rideMembers).where(eq(rideMembers.rideId, rideId)),
  ])
  return resolveRouteRiders(
    routes,
    refs,
    roster.map((r) => r.riderId),
  )
}

/**
 * Set exactly who is on one route, replacing whatever it said.
 *
 * **AN EMPTY LIST CLEARS THE OVERRIDE RATHER THAN EMPTYING THE ROUTE.** A route
 * ridden by nobody is not a thing anyone means, so "nobody" is how a planner
 * says "go back to inheriting from the route before this one" — which is the
 * only way to undo an answer, and the reason the absence of rows is unambiguous.
 *
 * Delete-then-insert rather than a diff: a route's roster is small, this runs on
 * a deliberate press rather than on a timer, and a diff is two more states to
 * get wrong.
 */
export async function setRouteRiders(rideId: number, routeUid: string, riderIds: number[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(routeRiders).where(and(eq(routeRiders.rideId, rideId), eq(routeRiders.routeUid, routeUid)))
    if (riderIds.length === 0) return
    // Only riders actually on the ride. A stranger's id reaching this table
    // would resolve to nothing anyway — policy filters against the roster — but
    // storing it is a row nothing will ever clean up.
    const roster = await tx
      .select({ riderId: rideMembers.riderId })
      .from(rideMembers)
      .where(eq(rideMembers.rideId, rideId))
    const allowed = new Set(roster.map((r) => r.riderId))
    const values = [...new Set(riderIds)]
      .filter((id) => allowed.has(id))
      .map((riderId) => ({ rideId, routeUid, riderId }))
    if (values.length > 0) await tx.insert(routeRiders).values(values)
  })
}

/**
 * The route uids one rider is actually on, or null when there is nothing to
 * filter by.
 *
 * WHAT A PER-RIDER EXPORT IS BUILT FROM, replacing `strandOf`'s job on those
 * surfaces. A strand is a GROUP's run — its own routes plus every shared one —
 * which was an approximation of the thing a rider wanted and is simply wrong the
 * moment two riders in one group ride different stretches. That is the case
 * `route_riders` exists for: a friend who joins for the middle of a ride is on
 * neither group's strand and on exactly three routes.
 *
 * NULL, NOT AN EMPTY ARRAY, WHEN EVERY ROUTE IS THEIRS. An ordinary tour has
 * nobody joining or leaving, so every rider is on every route — and a caller
 * that filtered by the full list would do the same work to reach the same
 * answer. Null says "no narrowing applies", which is also what a non-member
 * gets: a stranger holding a public ride's link downloads the whole ride,
 * because a share link is permission to see the route and not a claim to be on
 * it.
 */
export async function routeUidsForRider(rideId: number, riderId: number | null): Promise<string[] | null> {
  if (riderId === null) return null
  const resolved = await resolvedRoutes(rideId)
  const mine = routesForRider(resolved, riderId)
  // On every route, or on none of them because they are not a member at all.
  // Both mean the same thing here: nothing to narrow to.
  if (mine.length === 0 || mine.length === resolved.length) return null
  return mine.map((d) => d.uid)
}
