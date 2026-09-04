// What a subgroup IS, in terms of the days it owns.
//
// Pure — a function of a day list and nothing else — so it is testable under the
// house rule that governs test/. The queries live in ./service.ts and the two
// harder derivations in ./schedule.ts and ./rendezvous.ts.
//
// THE WHOLE MODEL IN ONE PARAGRAPH. A ride's days are one dense sequence, as
// they always were. Each day carries a subgroup or null, and null means everyone
// rides it. A rider in subgroup S rides the SUBSEQUENCE of days whose subgroup
// is S or null, in position order. That is the entire representation: no second
// ordinal, no parallel numbering, no join table. Which days happen on the same
// calendar day is carried by `start_at`, which already existed.
//
// It was chosen over subgroup-membership-on-legs, which reads better in #67 and
// breaks a settled rule — a day is ONE ORDERED LIST of points, and two feeders
// cannot both start at position 0 of one list. See docs/decisions.md.

/** Only the fields these rules read, so a test does not have to build a whole
 *  row and a client can pass its own in-memory day straight in. */
export type StrandDay = {
  position: number
  /** Null means every subgroup rides it — the trunk. */
  subgroupId: number | null
}

/** A boundary between one day and the next where the set of riders changes. */
export type Junction = {
  /** The position of the day AFTER the boundary. A meet's junction is the
   *  shared day the feeders converge into; a split's is the first private day
   *  after the shared stretch. */
  position: number
  kind: 'meet' | 'split'
  /** The subgroups involved. For a meet, who arrives; for a split, who leaves. */
  subgroupIds: number[]
}

/**
 * The days one subgroup actually rides, in order.
 *
 * `null` asks for the trunk alone — the days everybody rides — which is what a
 * planner sees when no subgroup is focused and what a rider in NO subgroup
 * gets. #67 is explicit that being in no subgroup has to be representable: a
 * club secretary planning a joint rally is not in any of the groups.
 */
export function strandOf<T extends StrandDay>(days: T[], subgroupId: number | null): T[] {
  return days.filter((d) => d.subgroupId === null || d.subgroupId === subgroupId)
}

/** Every subgroup with at least one day, in the order they first appear. Used
 *  for the legend and for deciding whether a ride has subgroups at all — which
 *  is what every surface tests before doing anything different. */
export function activeSubgroupIds(days: StrandDay[]): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const d of days) {
    if (d.subgroupId !== null && !seen.has(d.subgroupId)) {
      seen.add(d.subgroupId)
      out.push(d.subgroupId)
    }
  }
  return out
}

/** Whether this ride is a converge-and-split ride at all. One subgroup is not:
 *  a ride where everyone starts in the same place has nothing to converge. */
export const hasSubgroups = (days: StrandDay[]): boolean => activeSubgroupIds(days).length >= 2

/**
 * Every meet and every split in a ride, derived rather than stored.
 *
 * A MEET IS A BOUNDARY, NOT A POINT, and that is why nothing needs a column.
 * Walking the days in order, a run of subgroup-tagged days followed by a shared
 * day is a meet at that shared day; a shared day followed by subgroup-tagged
 * days is a split at the first of them. The `meet` and `split` waypoint roles
 * stay exactly what they were — a label a rider or an importer puts on a point —
 * and nothing here reads them. Deriving beats storing because the structure
 * changes every time a day is added, removed or reordered, and a stored flag
 * would be wrong the first time somebody dragged a day.
 *
 * Consecutive runs of DIFFERENT subgroups with no shared day between them are
 * not a junction. Seattle's two approach days followed by SF's one is three
 * private days in a row and nobody has met anybody; the meet is the shared day
 * after them, and it is one meet involving both.
 */
export function junctions(days: StrandDay[]): Junction[] {
  const out: Junction[] = []
  // The subgroups seen since the last shared day — who is about to converge.
  let pending = new Set<number>()
  let sawShared = false

  for (const d of days) {
    if (d.subgroupId === null) {
      if (pending.size > 0) {
        out.push({ position: d.position, kind: 'meet', subgroupIds: [...pending].sort((a, b) => a - b) })
      }
      pending = new Set()
      sawShared = true
      continue
    }
    // First private day after a shared stretch: everybody splits here. The
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
 * ONE RULE, and it is about the ride rather than about any one day: a ride with
 * subgroups needs at least one shared day, or it is not one ride. Two subgroups
 * that never converge are two rides that happen to be stored together — every
 * total, every export and the whole map would be the union of two things with
 * nothing in common, and the rider is better told than shown that.
 *
 * Deliberately NOT enforced by the schema or by the save. It is a warning the
 * builder shows, the same way an unrouted leg is: a rider passes through this
 * shape while building — the trunk is the last thing you add — and refusing the
 * save would refuse the work in progress.
 */
export function neverConverges(days: StrandDay[]): boolean {
  return hasSubgroups(days) && !days.some((d) => d.subgroupId === null)
}

/** Why there is no spine to propose a meeting point on. Null is not one of
 *  these — it means there is one, and `days` holds it. */
export type NoTrunk = 'no-trunk-group' | 'is-trunk' | 'no-trunk'

/**
 * WHICH DAYS ARE THE SPINE a joining group is offered a meet on.
 *
 * Split out of the route so it can be tested at all — the house rule that puts
 * `policy.ts` beside `service.ts` everywhere else in this app. It is the whole
 * of #239: the shared days when there are any, and otherwise the days of the
 * group the planner named as the one everybody joins.
 *
 * THE FALLBACK IS THE POINT. A ride whose groups converge at the DESTINATION —
 * Los Gatos and San Francisco both riding to Lake Shasta — has no shared day by
 * construction, because there is no road after the meet until somebody proposes
 * one, which is the button they just pressed. That shape is exactly what
 * `neverConverges` above warns about, and answering it with "leave a day on
 * Everyone" asked the planner to do the app's job. `rides.trunk_subgroup_id` was
 * in the schema for this from the day subgroups landed and nothing read it.
 *
 * IT STILL REFUSES TO PICK. `no-trunk-group` is a question for the planner, not
 * a cue to choose the longest route or the primary group: whose road everybody
 * else bends around is the same fairness question `primary_subgroup_id` refuses
 * a default for, and the planner is the one person who cannot see when they have
 * answered it in their own favor.
 */
export function trunkDaysFor<T extends StrandDay>(
  days: T[],
  joiningSubgroupId: number,
  trunkSubgroupId: number | null,
): { days: T[]; reason: NoTrunk | null } {
  const shared = days.filter((d) => d.subgroupId === null)
  if (shared.length > 0) return { days: shared, reason: null }
  if (trunkSubgroupId === null) return { days: [], reason: 'no-trunk-group' }
  // Joining the route you are already on is not a meeting point. Its own reason
  // rather than an empty candidate list, which would read as "nowhere works" for
  // a question that was malformed.
  if (trunkSubgroupId === joiningSubgroupId) return { days: [], reason: 'is-trunk' }
  const own = days.filter((d) => d.subgroupId === trunkSubgroupId)
  return own.length > 0 ? { days: own, reason: null } : { days: [], reason: 'no-trunk' }
}
