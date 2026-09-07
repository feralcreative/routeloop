// Subgroups, query side. The rules are in ./policy.ts, ./schedule.ts and
// ./rendezvous.ts, and nothing here re-decides one.
//
// RECONCILED BY UID, NOT CHURNED. Every other child of a ride — routes, points,
// legs — is deleted and re-inserted on every save, and this deliberately is not:
// `ride_members.subgroup_id` and `rides.primary_subgroup_id` both point at these
// rows, and a delete-and-reinsert would null every one of them on the first edit
// a rider made. So the payload's subgroups are matched against the stored ones
// by uid, the missing ones deleted and the rest updated in place, which keeps
// ids stable for exactly as long as the rider keeps the subgroup.
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/index'
import { rideMembers, rideSubgroups, rides, users, type RideSubgroupRow, type TimeAnchor } from '../db/schema'
import type { Tx } from '../maps/ride-graph'
import { newUid } from '../maps/uid'
import { routeUidsForRider } from '../route-riders/service'

/** The db or a transaction on it. `seedMainGroup` runs inside the same
 *  transaction that inserts the ride at every real call site — the same
 *  arrangement, and for the same reason, as seedOwner in ../members/service. */
type Writer = Tx | typeof db

/** What a payload carries for one subgroup. Ids never appear in a payload — the
 *  client has not seen them and must not have to. */
export type SubgroupInput = {
  uid: string
  name: string
  color: string
}

/**
 * Bring the stored subgroups into line with the payload, and hand back the
 * uid → id map every route insert needs.
 *
 * Runs BEFORE the routes are inserted, inside the save transaction, because
 * `routes.subgroup_id` is resolved through the map this returns.
 *
 * Deleting a subgroup is `set null` on both sides: its routes become everyone's
 * and its riders become ungrouped, rather than either being destroyed. That is
 * the `place_groups` call again — a rider tidying up a name must not lose the
 * road they planned.
 */
export async function reconcileSubgroups(
  tx: Tx,
  rideId: number,
  incoming: SubgroupInput[],
): Promise<Map<string, number>> {
  const existing = await tx
    .select({ id: rideSubgroups.id, uid: rideSubgroups.uid })
    .from(rideSubgroups)
    .where(eq(rideSubgroups.rideId, rideId))
  const byUid = new Map(existing.map((r) => [r.uid, r.id]))

  const live = new Set(incoming.map((s) => s.uid))
  const doomed = existing.filter((r) => !live.has(r.uid)).map((r) => r.id)
  if (doomed.length > 0) {
    // inArray, never a JS array in a tagged `sql` template — drizzle expands one
    // into a tuple and `= any((...))` is not valid SQL.
    await tx.delete(rideSubgroups).where(inArray(rideSubgroups.id, doomed))
    for (const [uid, id] of byUid) if (doomed.includes(id)) byUid.delete(uid)
  }

  for (const [position, s] of incoming.entries()) {
    const id = byUid.get(s.uid)
    if (id === undefined) {
      const [row] = await tx
        .insert(rideSubgroups)
        .values({ rideId, uid: s.uid, name: s.name, color: s.color, position })
        .returning({ id: rideSubgroups.id })
      byUid.set(s.uid, row.id)
    } else {
      await tx.update(rideSubgroups).set({ name: s.name, color: s.color, position }).where(eq(rideSubgroups.id, id))
    }
  }
  return byUid
}

/** A ride's subgroups, in the planner's order. */
export const subgroupsOf = (rideId: number): Promise<RideSubgroupRow[]> =>
  db.select().from(rideSubgroups).where(eq(rideSubgroups.rideId, rideId)).orderBy(rideSubgroups.position)

/**
 * Which subgroup a rider is on, or null.
 *
 * Null covers two different things on purpose and neither is an error: a rider
 * who has not been assigned, and a ride with no subgroups at all. Both get the
 * trunk, which is the whole ride in the second case — see strandOf.
 */
/**
 * Give a ride its main group, at the moment the ride is created.
 *
 * EVERY RIDE HAS AT LEAST ONE GROUP — planning a route means somebody is riding
 * it, which is a group of one. `SEED_GROUP` in builder.js is what makes that
 * true for a ride planned in the builder, and it is CLIENT-SIDE, so a ride
 * created by any other path — an upload, a clone, the seed script — arrived with
 * none and stayed that way until somebody opened it in the builder. Ziad's call,
 * 2026-09-06: the four creating paths seed it themselves, so no new ride can be
 * groupless whatever made it.
 *
 * THIS IS NOT A BACKFILL AND DELIBERATELY SO. Rides already stored without a
 * group still get theirs the first time the builder saves them, which is the
 * repair that was already there; what changes is that the set of such rides
 * stops growing. A data migration over live rider records was declined for this
 * on 2026-09-03 and that half of the decision stands.
 *
 * `onConflictDoNothing` on the ride/uid pair, so a caller that runs this twice
 * — or one whose payload already carries a group with the same uid — writes one
 * row. It does NOT set `rides.primary_subgroup_id`: the column is resolved from
 * the payload's own order on every save (`subgroups[0]` is the main group), and
 * a value written here would be one more thing that could disagree with the list
 * a rider is looking at.
 *
 * The name matches what the builder seeds so a ride is not identifiable by which
 * path created it.
 */
export async function seedMainGroup(w: Writer, rideId: number): Promise<void> {
  // ONLY WHEN THE RIDE HAS NONE, checked rather than inferred from the call
  // site. Two of the four creating paths run `insertRideGraph` FIRST, which
  // reconciles the payload's own subgroups — so an unconditional insert would
  // give every ride saved from the builder a second, empty group named the same
  // as the one it already has. `onConflictDoNothing` does not catch that: the
  // uid is minted here and is new by construction, so there is no conflict to
  // catch. Asking is the only thing that works at all four sites in either
  // order, which is what makes this safe to call from a fifth.
  const existing = await w.select({ id: rideSubgroups.id }).from(rideSubgroups).where(eq(rideSubgroups.rideId, rideId))
  if (existing.length > 0) return
  await w.insert(rideSubgroups).values({ rideId, uid: newUid(), name: 'Group 1', position: 0 })
}

export async function subgroupOf(rideId: number, riderId: number): Promise<number | null> {
  const [row] = await db
    .select({ subgroupId: rideMembers.subgroupId })
    .from(rideMembers)
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, riderId)))
    .limit(1)
  return row?.subgroupId ?? null
}

/** Put a rider on an approach, or take them off one. Owner-gated by the caller,
 *  the same as every other roster write. */
export async function assignRider(rideId: number, riderId: number, subgroupId: number | null): Promise<void> {
  await db
    .update(rideMembers)
    .set({ subgroupId, updatedAt: new Date() })
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, riderId)))
}

/**
 * The riders on each subgroup, keyed by subgroup id, plus the ungrouped under
 * `null`.
 *
 * One query rather than one per subgroup. The `null` bucket is always present
 * even when empty, so a caller renders "nobody yet" from an empty array rather
 * than from a missing key.
 */
export async function ridersBySubgroup(rideId: number): Promise<Map<number | null, { id: number; name: string }[]>> {
  const rows = await db
    .select({ subgroupId: rideMembers.subgroupId, id: users.id, name: users.displayName })
    .from(rideMembers)
    .innerJoin(users, eq(users.id, rideMembers.riderId))
    .where(eq(rideMembers.rideId, rideId))
    .orderBy(users.displayName)
  const out = new Map<number | null, { id: number; name: string }[]>([[null, []]])
  for (const r of rows) {
    const key = r.subgroupId
    if (!out.has(key)) out.set(key, [])
    out.get(key)!.push({ id: r.id, name: r.name })
  }
  return out
}

/**
 * The ride's two subgroup pointers and its anchor, resolved from uids.
 *
 * Written AFTER reconcileSubgroups, because a payload can create a subgroup and
 * name it primary in the same save — the id does not exist until the reconcile
 * has run. An unknown uid lands null rather than failing the save: a client that
 * names a subgroup it also deleted is describing a coherent intention badly, and
 * refusing the whole autosave over it would lose the rider's work.
 */
export async function writeRideAnchors(
  tx: Tx,
  rideId: number,
  byUid: Map<string, number>,
  primaryUid: string | null,
  trunkUid: string | null,
  timeAnchor: TimeAnchor,
  stopByMin: number | null,
): Promise<void> {
  await tx
    .update(rides)
    .set({
      primarySubgroupId: primaryUid ? (byUid.get(primaryUid) ?? null) : null,
      trunkSubgroupId: trunkUid ? (byUid.get(trunkUid) ?? null) : null,
      // ALL OF THEM IN ONE WRITE. The anchor was left out of the first draft of
      // this function and the round-trip test caught it: the payload carried
      // 'meet', the save reported success, and the ride came back 'departure'
      // with nothing raised. Fields describing when and around whom a ride is
      // solved belong in one statement for exactly that reason — which is why
      // "stop by four" joined them here rather than getting an update of its own.
      timeAnchor,
      stopByMin,
    })
    .where(eq(rides.id, rideId))
}

export type Strand = {
  /**
   * What to hand `loadRideForExport`. `undefined` is the whole ride, `null` is
   * the trunk alone, a number is one subgroup's own strand — the three cases
   * are genuinely different and collapsing any two of them is a bug.
   */
  subgroupId: number | null | undefined
  /** The subgroup itself, for a heading. Null when the answer is the whole ride. */
  group: RideSubgroupRow | null
  /** Every subgroup on the ride, so a page can offer the others. */
  all: RideSubgroupRow[]
  /**
   * The route uids this VIEWER is on, or null when nothing narrows.
   *
   * **THIS OUTRANKS `subgroupId` AND IS THE REASON A PER-RIDER EXPORT IS NOW
   * CORRECT.** A strand is a GROUP's run — its own routes plus every shared one
   * — which was an approximation of what a rider wanted and is wrong the moment
   * two riders in one group ride different stretches. A friend who joins for the
   * middle of a ride is on neither group's strand and on exactly three routes.
   * `route_riders` is what knows that; see src/route-riders/policy.ts.
   *
   * **ONLY WHEN THE STRAND WAS DERIVED FROM MEMBERSHIP.** An explicit `?group`
   * is a planner asking for a GROUP's view and still gets one, and `?group=all`
   * is the way back to the whole ride — narrowing either to the viewer's own
   * routes would take away the question they asked.
   */
  routeUids: string[] | null
}

/**
 * Which strand this reader should be shown.
 *
 * DERIVED FROM MEMBERSHIP, NOT ASKED FOR, which is #67's own argument: it is
 * what makes "highlight my path" and the per-rider hand-off work without
 * anybody being asked anything. A rider on the Sacramento approach opens the
 * roadbook and gets their own roadbook.
 *
 * `requested` overrides it, and `'all'` is the way back to the whole ride —
 * which is what the PLANNER wants, since they are looking at everybody's. Both
 * are query parameters and both are therefore rider-supplied: an unknown uid
 * falls through to the derived answer rather than erroring, because a stale
 * link should degrade to something sensible.
 *
 * A ride with no subgroups always answers `undefined`. Nothing downstream has
 * to test for that separately, which is the point of resolving it here.
 */
export async function resolveStrand(rideId: number, viewerId: number | null, requested?: string): Promise<Strand> {
  const all = await subgroupsOf(rideId)
  // A RIDE WITH NO SUBGROUPS CAN STILL NARROW BY RIDER, which is what makes the
  // Portland case work: a friend riding the middle three routes of a solo tour
  // needs no group at all, and asking for one to express it is the machinery
  // #67 was trying to avoid. So this is asked before the early returns rather
  // than after them.
  const routeUids = await routeUidsForRider(rideId, viewerId)
  if (all.length === 0) return { subgroupId: undefined, group: null, all, routeUids }
  // `all` is the planner's way back to the WHOLE ride, so it clears both
  // narrowings and not just the group one.
  if (requested === 'all') return { subgroupId: undefined, group: null, all, routeUids: null }

  // An explicit group is the question that was asked; answering it with the
  // viewer's own routes instead would be answering a different one.
  const asked = requested ? (all.find((g) => g.uid === requested) ?? null) : null
  if (asked) return { subgroupId: asked.id, group: asked, all, routeUids: null }

  const mine = viewerId === null ? null : await subgroupOf(rideId, viewerId)
  if (mine === null) return { subgroupId: undefined, group: null, all, routeUids }
  // BOTH, and `loadRideForExport` applies the uids first. A rider is on their
  // group's strand by construction in the ordinary case, so the two agree —
  // and where they disagree it is because somebody joined or left partway,
  // which is exactly what the uids know and the strand does not.
  return { subgroupId: mine, group: all.find((g) => g.id === mine) ?? null, all, routeUids }
}
