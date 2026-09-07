// What a subgroup IS, in terms of the routes it owns.
//
// Pure — a function of a route list and nothing else — so it is testable under the
// house rule that governs test/. The queries live in ./service.ts and the two
// harder derivations in ./schedule.ts and ./rendezvous.ts.
//
// THE WHOLE MODEL IN ONE PARAGRAPH. A ride's routes are one dense sequence, as
// they always were. Each route carries a subgroup or null, and null means everyone
// rides it. A rider in subgroup S rides the SUBSEQUENCE of routes whose subgroup
// is S or null, in position order. That is the entire representation: no second
// ordinal, no parallel numbering, no join table. Which routes happen on the same
// calendar route is carried by `start_at`, which already existed.
//
// It was chosen over subgroup-membership-on-legs, which reads better in #67 and
// breaks a settled rule — a route is ONE ORDERED LIST of points, and two feeders
// cannot both start at position 0 of one list. See docs/decisions.md.

/** Only the fields these rules read, so a test does not have to build a whole
 *  row and a client can pass its own in-memory route straight in. */
export type StrandRoute = {
  position: number
  /** Null means every subgroup rides it — the trunk. */
  subgroupId: number | null
}

/** A boundary between one route and the next where the set of riders changes. */
export type Junction = {
  /** The position of the route AFTER the boundary. A meet's junction is the
   *  shared route the feeders converge into; a split's is the first private route
   *  after the shared stretch. */
  position: number
  kind: 'meet' | 'split'
  /** The subgroups involved. For a meet, who arrives; for a split, who leaves. */
  subgroupIds: number[]
}

/**
 * The routes one subgroup actually rides, in order.
 *
 * `null` asks for the trunk alone — the routes everybody rides — which is what a
 * planner sees when no subgroup is focused and what a rider in NO subgroup
 * gets. #67 is explicit that being in no subgroup has to be representable: a
 * club secretary planning a joint rally is not in any of the groups.
 */
export function strandOf<T extends StrandRoute>(routes: T[], subgroupId: number | null): T[] {
  return routes.filter((d) => d.subgroupId === null || d.subgroupId === subgroupId)
}

/**
 * The route a group SETS OFF from, which is not always the first route of its strand.
 *
 * A JOINING GROUP CONTRIBUTES A STARTING POINT AND NOTHING ELSE, and it has to
 * be their OWN. A strand is a group's routes plus every SHARED one in position
 * order, so a shared route sitting before a group's own route becomes `strand[0]` —
 * and reading the origin from there hands the group somebody else's starting
 * point. Measured on ride 34: two untagged one-point routes left over from before
 * groups seeded their own routes sorted ahead of both satellites, so the group
 * starting in San Luis Obispo was proposed a meeting point as though it set off
 * from Santa Cruz — and both joining groups came back with identical candidates
 * and identical diverts, because they had been given the same origin.
 *
 * THE FALLBACK IS THE STRAND, NOT NULL. A group with no route of its own is one
 * that rides only shared routes, and where the shared road starts is the only
 * honest answer available for it.
 */
export function startRouteOf<T extends StrandRoute>(routes: T[], subgroupId: number): T | null {
  const strand = strandOf(routes, subgroupId)
  return strand.find((d) => d.subgroupId === subgroupId) ?? strand[0] ?? null
}

/** Every subgroup with at least one route, in the order they first appear. Used
 *  for the legend and for deciding whether a ride has subgroups at all — which
 *  is what every surface tests before doing anything different. */
export function activeSubgroupIds(routes: StrandRoute[]): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const d of routes) {
    if (d.subgroupId !== null && !seen.has(d.subgroupId)) {
      seen.add(d.subgroupId)
      out.push(d.subgroupId)
    }
  }
  return out
}

/** Whether this ride is a converge-and-split ride at all. One subgroup is not:
 *  a ride where everyone starts in the same place has nothing to converge. */
export const hasSubgroups = (routes: StrandRoute[]): boolean => activeSubgroupIds(routes).length >= 2

/**
 * Every meet and every split in a ride, derived rather than stored.
 *
 * A MEET IS A BOUNDARY, NOT A POINT, and that is why nothing needs a column.
 * Walking the routes in order, a run of subgroup-tagged routes followed by a shared
 * route is a meet at that shared route; a shared route followed by subgroup-tagged
 * routes is a split at the first of them. The `meet` and `split` waypoint roles
 * stay exactly what they were — a label a rider or an importer puts on a point —
 * and nothing here reads them. Deriving beats storing because the structure
 * changes every time a route is added, removed or reordered, and a stored flag
 * would be wrong the first time somebody dragged a route.
 *
 * Consecutive runs of DIFFERENT subgroups with no shared route between them are
 * not a junction. Seattle's two approach routes followed by SF's one is three
 * private routes in a row and nobody has met anybody; the meet is the shared route
 * after them, and it is one meet involving both.
 */
export function junctions(routes: StrandRoute[]): Junction[] {
  const out: Junction[] = []
  // The subgroups seen since the last shared route — who is about to converge.
  let pending = new Set<number>()
  let sawShared = false

  for (const d of routes) {
    if (d.subgroupId === null) {
      if (pending.size > 0) {
        out.push({ position: d.position, kind: 'meet', subgroupIds: [...pending].sort((a, b) => a - b) })
      }
      pending = new Set()
      sawShared = true
      continue
    }
    // First private route after a shared stretch: everybody splits here. The
    // subgroups listed are collected on the NEXT pass through the run, so this
    // records the boundary and the run below fills in who left.
    if (sawShared && pending.size === 0) {
      out.push({ position: d.position, kind: 'split', subgroupIds: [] })
      sawShared = false
    }
    pending.add(d.subgroupId)
    const last = out[out.length - 1]
    if (last?.kind === 'split' && !last.subgroupIds.includes(d.subgroupId)) {
      last.subgroupIds.push(d.subgroupId)
      last.subgroupIds.sort((a, b) => a - b)
    }
  }
  return out
}

/**
 * Whether a subgroup assignment describes a shape the app can render.
 *
 * ONE RULE, and it is about the ride rather than about any one route: a ride with
 * subgroups needs at least one shared route, or it is not one ride. Two subgroups
 * that never converge are two rides that happen to be stored together — every
 * total, every export and the whole map would be the union of two things with
 * nothing in common, and the rider is better told than shown that.
 *
 * Deliberately NOT enforced by the schema or by the save. It is a warning the
 * builder shows, the same way an unrouted leg is: a rider passes through this
 * shape while building — the trunk is the last thing you add — and refusing the
 * save would refuse the work in progress.
 */
export function neverConverges(routes: StrandRoute[]): boolean {
  return hasSubgroups(routes) && !routes.some((d) => d.subgroupId === null)
}
