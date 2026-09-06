// WHO IS ON WHICH STRETCH OF ROAD, and where the ride joins up or comes apart.
//
// Pure: no database, no Hono, no clock. `service.ts` is the query half, the same
// split as invites, survey, stats, access, friends, members, votes, subgroups,
// follows, comments and suggestions.
//
// THIS SUPERSEDES `routes.subgroup_id` AS THE ANSWER TO "WHO RIDES THIS", and the
// reason is a shape subgroups could not hold. A route carried one subgroup or
// none, and a rider belonged to one subgroup for the whole ride — so "three
// riders join at Portland and one of them peels off at Eugene" had nowhere to
// live: those three share a group, and the group is what the route is tagged
// with. Ziad's call, 2026-09-06, after describing exactly that ride. The set of
// people riding together changes for reasons that have nothing to do with where
// anybody set off from, so the rider is the primitive and the group is not.
//
// **A GROUP IS NOT GONE AND MUST NOT BE REMOVED.** It still answers a different
// question — where does this lot set off from — which is what the meeting-point
// proposer reads, and it is still how a planner assigns several riders at once.
// What it stopped being is the thing that says who rides a route.
/**
 * The minimum a route has to carry to be resolved: an identity that survives a
 * save, and its place in the order.
 *
 * `uid` AND NOT `id`, for the reason `route_riders` keys on one — the builder's PUT
 * deletes and re-inserts every route on every save, so an id is dangling the
 * first time anybody moves a stop. Deliberately NOT `StrandRoute`, which carries
 * `subgroupId` and no uid: that type is about which GROUP rides a route, which
 * is the question this module replaces.
 */
export type RouteRef = { uid: string; position: number }

/** One route's explicit roster, as stored. Rows are an OVERRIDE; see below. */
export type RouteRiderRef = { routeUid: string; riderId: number }

/** A route with the riders actually on it, after the walk. */
export type ResolvedRoute = {
  uid: string
  position: number
  /** Sorted, so two resolutions of the same ride compare equal and a junction
   *  can be found by set difference rather than by order. */
  riderIds: number[]
  /** Whether this route said who was on it, or inherited. Rendered rather than
   *  used for logic — a planner needs to know which routes they have actually
   *  answered for, because an inherited one changes under them when they edit
   *  an earlier route. */
  explicit: boolean
}

/**
 * Resolve every route's rider set.
 *
 * **ROWS ARE AN OVERRIDE AND THEIR ABSENCE IS NOT "NOBODY".** A route with no
 * rows inherits the set from the route before it; the first route of a ride with
 * no rows is ridden by the whole roster. Ziad's call, 2026-09-06, chosen over
 * "everyone unless removed" because it is how a ride actually reads: you say who
 * joins and who leaves, and it stays that way until you say otherwise. On the
 * worked example — ride to Portland, a friend joins to Seattle, they peel off,
 * you carry on to Vancouver — that is two answers instead of four, and the two
 * are exactly the two junctions.
 *
 * **A ROUTE RIDDEN BY NOBODY IS NOT A THING ANYONE MEANS**, which is what makes
 * the absence unambiguous: there is no state that an empty explicit set would
 * express and an inherited one would not. An explicit set that arrives empty is
 * therefore treated as no answer at all rather than as an empty route.
 *
 * **DERIVED, NEVER STORED.** The same argument `junctions()` makes about meets
 * and splits: the resolved set changes every time a route is added, removed or
 * reordered, and a stored copy would be wrong the first time anybody dragged
 * one. It is also why this takes the roster as an argument rather than reading
 * it — adding a rider to the ride changes the answer for every inherited route,
 * and that has to happen without a write.
 *
 * `routes` must be in position order; the caller owns that, the same way
 * `junctions()` does.
 */
export function resolveRouteRiders(routes: RouteRef[], explicit: RouteRiderRef[], roster: number[]): ResolvedRoute[] {
  const byRoute = new Map<string, number[]>()
  for (const r of explicit) {
    const list = byRoute.get(r.routeUid)
    if (list) list.push(r.riderId)
    else byRoute.set(r.routeUid, [r.riderId])
  }

  const out: ResolvedRoute[] = []
  // The whole roster is the seed, not an empty set: a ride nobody has answered
  // for is one everybody is on, which is every ordinary tour.
  let carried = [...roster].sort((a, b) => a - b)

  for (const d of routes) {
    const own = byRoute.get(d.uid)
    // A stored rider who has since left the ride is dropped rather than carried:
    // `route_riders` cascades from `rides` and from `users`, so a removal from the
    // ROSTER leaves rows behind. Filtering here means the resolution is correct
    // before anybody gets round to reconciling.
    const kept = own ? own.filter((id) => roster.includes(id)) : []
    const explicitHere = kept.length > 0
    if (explicitHere) carried = [...new Set(kept)].sort((a, b) => a - b)
    out.push({ uid: d.uid, position: d.position, riderIds: carried, explicit: explicitHere })
  }
  return out
}

/** A place where the set of people riding together changes. */
export type RiderJunction = {
  /** The position of the route the change happens AT — the first route ridden by
   *  the new set. A junction is a boundary, and naming it by the route that
   *  follows is what makes "they join here" and "they leave here" the same fact
   *  read from two sides. */
  position: number
  joined: number[]
  left: number[]
}

/**
 * Where the ride joins up and where it comes apart, from the resolved sets.
 *
 * **THIS IS `junctions()` GENERALIZED, AND IT IS WHY THE MODEL CHANGED.** The
 * subgroup version reported a `meet` when a run of tagged routes was followed by
 * a shared one and a `split` for the reverse, which can only describe whole
 * groups converging and separating. A set difference describes any change at
 * all, including the one that broke the old model: three riders join together
 * and one of them leaves later, which is a `left` of one against a set that came
 * from a `joined` of three.
 *
 * **BOTH DIRECTIONS AT ONE BOUNDARY, IN ONE ENTRY.** A route where two riders
 * leave and one joins is a single junction with both lists, not a split
 * followed by a meet — those are the same moment on the same road, and reporting
 * them separately makes the roadbook say a group came apart and re-formed.
 *
 * **DERIVED, LIKE EVERYTHING ELSE HERE.** Nothing is stored and no `meet` or
 * `split` role is read: those stay labels a rider or an importer puts on a
 * point, exactly as they were.
 */
export function riderJunctions(resolved: ResolvedRoute[]): RiderJunction[] {
  const out: RiderJunction[] = []
  for (let i = 1; i < resolved.length; i++) {
    const before = new Set(resolved[i - 1].riderIds)
    const after = new Set(resolved[i].riderIds)
    const joined = resolved[i].riderIds.filter((id) => !before.has(id))
    const left = resolved[i - 1].riderIds.filter((id) => !after.has(id))
    if (joined.length || left.length) out.push({ position: resolved[i].position, joined, left })
  }
  return out
}

/**
 * The routes one rider is actually on, in order.
 *
 * What a per-rider roadbook, hand-off and export are built from. It replaces
 * `strandOf`'s job for those surfaces: a strand is a GROUP's run — its own
 * routes plus every shared one — which was only ever an approximation of the
 * thing a rider wanted, and is wrong the moment two riders in one group ride
 * different stretches.
 */
export function routesForRider(resolved: ResolvedRoute[], riderId: number): ResolvedRoute[] {
  return resolved.filter((d) => d.riderIds.includes(riderId))
}

/**
 * Where a rider sets off from: the first route they are on.
 *
 * The meeting-point proposer needs an origin, and it read a group's own first
 * route to get one. With membership per route the honest answer is the first
 * route this rider is on, which is the same answer for an ordinary group and the
 * right one when two riders in a group start in different places.
 *
 * Null when the rider is on no route at all, which is a real state: somebody on
 * the roster who has not been put on anything yet.
 */
export function firstRouteFor(resolved: ResolvedRoute[], riderId: number): ResolvedRoute | null {
  return resolved.find((d) => d.riderIds.includes(riderId)) ?? null
}
