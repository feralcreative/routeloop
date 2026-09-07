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

/**
 * One route's explicit roster, as stored. Rows are an OVERRIDE; see below.
 *
 * `subgroupId` is WHO THEY ARE RIDING AS on this route, which is not the group
 * they belong to on the ride. Null is the MAIN group — everybody together — and
 * not "no group": see the column's own comment in schema.ts.
 */
export type RouteRiderRef = { routeUid: string; riderId: number; subgroupId: number | null }

/** A rider on a route, and the group they are riding as there. */
export type RouteRider = { id: number; group: number | null }

/** A route with the riders actually on it, after the walk. */
export type ResolvedRoute = {
  uid: string
  position: number
  /** Sorted by rider id, so two resolutions of the same ride compare equal and a
   *  junction can be found by set difference rather than by order. */
  riders: RouteRider[]
  /** Just the ids, for the callers that only ask about membership. Derived here
   *  rather than at four call sites so there is one definition of the order. */
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
  const byRoute = new Map<string, RouteRider[]>()
  for (const r of explicit) {
    const list = byRoute.get(r.routeUid)
    const one = { id: r.riderId, group: r.subgroupId }
    if (list) list.push(one)
    else byRoute.set(r.routeUid, [one])
  }

  const out: ResolvedRoute[] = []
  // The whole roster is the seed, not an empty set: a ride nobody has answered
  // for is one everybody is on, which is every ordinary tour — and they are on it
  // as the MAIN group, which is what a null group means.
  let carried: RouteRider[] = [...roster].sort((a, b) => a - b).map((id) => ({ id, group: null }))

  for (const d of routes) {
    const own = byRoute.get(d.uid)
    // A stored rider who has since left the ride is dropped rather than carried:
    // `route_riders` cascades from `rides` and from `users`, so a removal from the
    // ROSTER leaves rows behind. Filtering here means the resolution is correct
    // before anybody gets round to reconciling.
    const kept = own ? own.filter((r) => roster.includes(r.id)) : []
    const explicitHere = kept.length > 0
    if (explicitHere) {
      // THE GROUP IS CARRIED FORWARD WITH THE RIDER, not just their presence.
      // That is the whole point of storing it per route: a rider inherits both
      // "still riding" and "still riding as VMCSC" until something says
      // otherwise, so a feeder that spans two routes needs one answer and not
      // two. Deduplicated on id, last write winning, because a row set arrives
      // from one write and cannot meaningfully name a rider twice.
      const seen = new Map<number, RouteRider>()
      for (const r of kept) seen.set(r.id, r)
      carried = [...seen.values()].sort((a, b) => a.id - b.id)
    }
    out.push({
      uid: d.uid,
      position: d.position,
      riders: carried,
      riderIds: carried.map((r) => r.id),
      explicit: explicitHere,
    })
  }
  return out
}

/**
 * Which groups a route carries, for the checkbox list on its row.
 *
 * **DERIVED FROM WHO IS ON IT, BY THEIR HOME GROUP — NOT FROM WHAT IS STORED
 * HERE.** That distinction is the whole reason the control can be honest. Once
 * VMCSC joins the main group their stored group on that route is null, so
 * reading the stored value would tick nothing and the route would look like
 * everybody's — which is exactly the "Everyone" lie this replaces. Reading each
 * rider's HOME group instead ticks VMCSF and VMCSC on the shared stretch and
 * leaves VMCSLO unticked while they are still on their approach.
 *
 * `home` is `ride_members.subgroup_id` per rider: which group they belong to on
 * this ride, which never changes as they merge and split.
 */
export function groupsOnRoute(route: ResolvedRoute, home: Map<number, number | null>): Array<number | null> {
  const out = new Set<number | null>()
  for (const r of route.riders) out.add(home.get(r.id) ?? null)
  return [...out].sort((a, b) => (a ?? -1) - (b ?? -1))
}

/**
 * Every group a rider has ridden as, most recent route first.
 *
 * **SCAFFOLDING FOR THE SPLIT PICKER**, which is its own branch. When VMCSC
 * peels off for home, the planner should be offered "split off as VMCSC again"
 * with those riders already ticked rather than having to rebuild the group by
 * hand — and the only record that VMCSC ever existed as a riding set is the
 * route they rode as it. Most recent first because the last grouping is the one
 * a planner is most likely to mean.
 *
 * Nulls are dropped: riding as the main group is not a grouping anybody splits
 * back into.
 */
export function groupsRiddenAs(resolved: ResolvedRoute[], riderId: number): number[] {
  const out: number[] = []
  for (let i = resolved.length - 1; i >= 0; i--) {
    const mine = resolved[i].riders.find((r) => r.id === riderId)
    if (mine?.group != null && !out.includes(mine.group)) out.push(mine.group)
  }
  return out
}

/**
 * The riders who last rode as a given group, for the split picker to prefill.
 *
 * Scaffolding, like `groupsRiddenAs`. It reads the LAST route that group rode
 * rather than the union of every one: VMCSC's membership can have changed
 * between the outward leg and the way home, and the most recent answer is the
 * one a planner means by "the same lot again". The picker makes it editable,
 * which is what covers the two riders who carry on to Oakland.
 */
export function ridersWhoRodeAs(resolved: ResolvedRoute[], subgroupId: number): number[] {
  for (let i = resolved.length - 1; i >= 0; i--) {
    const mine = resolved[i].riders.filter((r) => r.group === subgroupId)
    if (mine.length > 0) return mine.map((r) => r.id).sort((a, b) => a - b)
  }
  return []
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
