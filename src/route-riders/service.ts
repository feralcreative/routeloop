// Who is on which stretch of road, query side. The rules are in ./policy.ts and
// nothing here re-decides one.
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/index'
import { routeRiders, routes as routesTable, rideMembers, rideSubgroups } from '../db/schema'
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
  const rows = await tx
    .select({ routeUid: routeRiders.routeUid })
    .from(routeRiders)
    .where(eq(routeRiders.rideId, rideId))
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
    .select({ routeUid: routeRiders.routeUid, riderId: routeRiders.riderId, subgroupId: routeRiders.subgroupId })
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
/**
 * The route uids one rider is actually on, or null when there is nothing to
 * filter by.
 *
 * WHAT A PER-RIDER EXPORT IS BUILT FROM, replacing `strandOf`'s job on those
 * surfaces. A strand is a GROUP's run — its own routes plus every shared one —
 * which was an approximation of the thing a rider wanted and is simply wrong the
 * moment two riders in one group ride different stretches.
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
  if (mine.length === 0 || mine.length === resolved.length) return null
  return mine.map((d) => d.uid)
}

/**
 * Set exactly who is on one route, and who they are riding as, replacing
 * whatever it said.
 *
 * **AN EMPTY LIST CLEARS THE OVERRIDE RATHER THAN EMPTYING THE ROUTE.** A route
 * ridden by nobody is not a thing anyone means, so "nobody" is how a planner
 * says "go back to inheriting from the route before this one".
 */
export async function setRouteRiders(
  rideId: number,
  routeUid: string,
  riders: Array<{ id: number; group: number | null }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(routeRiders).where(and(eq(routeRiders.rideId, rideId), eq(routeRiders.routeUid, routeUid)))
    if (riders.length > 0) {
      // Only riders actually on the ride, and only groups actually on it. A
      // stranger's id resolves to nothing anyway — policy filters against the
      // roster — but storing one is a row nothing will ever clean up, and a
      // subgroup id from somebody else's ride would pass the foreign key while
      // meaning nothing here.
      const [roster, groups] = await Promise.all([
        tx.select({ riderId: rideMembers.riderId }).from(rideMembers).where(eq(rideMembers.rideId, rideId)),
        tx.select({ id: rideSubgroups.id }).from(rideSubgroups).where(eq(rideSubgroups.rideId, rideId)),
      ])
      const allowed = new Set(roster.map((r) => r.riderId))
      const ours = new Set(groups.map((g) => g.id))
      const seen = new Map<number, number | null>()
      for (const r of riders) {
        if (!allowed.has(r.id)) continue
        seen.set(r.id, r.group != null && ours.has(r.group) ? r.group : null)
      }
      const values = [...seen].map(([riderId, subgroupId]) => ({ rideId, routeUid, riderId, subgroupId }))
      if (values.length > 0) await tx.insert(routeRiders).values(values)
    }
    await writeLegacyRouteGroup(tx, rideId, routeUid)
  })
}

/**
 * Keep `routes.subgroup_id` in step with who is on the route.
 *
 * **THE COLUMN IS RETIRED BUT NOT YET DROPPED**, so for one release it is
 * DERIVED rather than authoritative. Ziad's call, 2026-09-06. `strandOf`, the
 * meeting-point proposer and the viewer's per-group dimming all still read it,
 * and moving those over is the contract-phase work; writing it here means none
 * of them has to change while the rows become the real answer.
 *
 * **ONE GROUP OR NOTHING, WHICH IS ALL THE COLUMN CAN SAY.** A route ridden by
 * exactly one group is that group's; a route two groups share cannot be
 * expressed by a single id, so it goes null — which those readers already
 * understand as "everybody". That is the old "Everyone" imprecision, now
 * confined to a column nothing new reads: the honest answer is the rows, and
 * `groupsOnRoute()` is what the panel renders from.
 *
 * **BY HOME GROUP, NOT BY THE STORED ONE.** Once VMCSC merges, their stored
 * group on that route is null — so reading stored values would call every shared
 * route the main group's and lose the feeder tagging entirely.
 */
async function writeLegacyRouteGroup(tx: Tx, rideId: number, routeUid: string): Promise<void> {
  const [rows, home] = await Promise.all([
    tx
      .select({ riderId: routeRiders.riderId })
      .from(routeRiders)
      .where(and(eq(routeRiders.rideId, rideId), eq(routeRiders.routeUid, routeUid))),
    tx
      .select({ riderId: rideMembers.riderId, subgroupId: rideMembers.subgroupId })
      .from(rideMembers)
      .where(eq(rideMembers.rideId, rideId)),
  ])
  // No rows means the route INHERITS, and an inherited route's tag is whatever
  // it already was — there is nothing here to derive from and overwriting it
  // would throw away a tag the rider set on an earlier save.
  if (rows.length === 0) return
  const homeOf = new Map(home.map((h) => [h.riderId, h.subgroupId]))
  const groups = new Set(rows.map((r) => homeOf.get(r.riderId) ?? null))
  const only = groups.size === 1 ? [...groups][0] : null
  await tx
    .update(routesTable)
    .set({ subgroupId: only })
    .where(and(eq(routesTable.rideId, rideId), eq(routesTable.uid, routeUid)))
}
