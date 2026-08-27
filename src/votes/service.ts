// Voting on a ride's alternates, query side. The rules are in ./policy.ts.
//
// A VOTE POINTS AT A DAY BY `uid`, NEVER BY `id`, and this file is where that
// costs something. The builder's PUT deletes and re-inserts every day of a ride
// on every save, so `days.id` churns and `days.alt_group` is renumbered densely
// from zero — neither can be stored. `alt_votes` is keyed `(ride_id, day_uid,
// user_id)` and cascades from `rides`, exactly as `point_details` is and does,
// which means the same obligation: nothing cleans a vote up when its day leaves
// the payload, so reconcileVotes() below has to, and insertRideGraph calls it.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { altVotes, days as daysTable, rides } from '../db/schema'
import type { Tx } from '../maps/ride-graph'
import { electWinner, votingOpen, type Tally } from './policy'

/**
 * Delete votes whose day is no longer in the ride.
 *
 * Called from insertRideGraph inside the save transaction. Skip it and a vote
 * for a deleted alternate lives forever and keeps counting toward a tally that
 * has no row to show it against.
 *
 * The empty case deletes everything, which is correct rather than a guard worth
 * adding: a ride saved with no days has no alternates and therefore no votes.
 */
export async function reconcileVotes(tx: Tx, rideId: number, liveDayUids: string[]): Promise<void> {
  if (liveDayUids.length === 0) {
    await tx.delete(altVotes).where(eq(altVotes.rideId, rideId))
    return
  }
  const rows = await tx.select({ dayUid: altVotes.dayUid }).from(altVotes).where(eq(altVotes.rideId, rideId))
  const live = new Set(liveDayUids)
  const doomed = [...new Set(rows.map((r) => r.dayUid))].filter((uid) => !live.has(uid))
  if (doomed.length > 0) {
    // inArray, never a JS array interpolated into a tagged `sql` template —
    // drizzle expands one into a tuple and `= any((...))` is not valid SQL.
    await tx.delete(altVotes).where(and(eq(altVotes.rideId, rideId), inArray(altVotes.dayUid, doomed)))
  }
}

/** One alternate group as the page renders it: the sibling days, their counts,
 *  and which one is currently counting toward the ride. */
export type VoteGroup = {
  altGroup: number
  tallies: Tally[]
  /** The day this viewer picked in this group, if any. */
  mine: string | null
}

/**
 * Every alternate group in a ride, with counts.
 *
 * Two queries rather than a join with a filtered aggregate, because the days a
 * group contains and the votes cast in it answer to different keys — the days
 * by `alt_group`, the votes by uid — and the join that reconciles them is a
 * grouping the client wants anyway.
 */
export async function voteGroups(rideId: number, viewerId: number | null): Promise<VoteGroup[]> {
  const rows = await db
    .select({ uid: daysTable.uid, altGroup: daysTable.altGroup, active: daysTable.altActive })
    .from(daysTable)
    .where(and(eq(daysTable.rideId, rideId), sql`${daysTable.altGroup} is not null`))
    .orderBy(daysTable.position)
  if (rows.length === 0) return []

  const counts = await db
    .select({ dayUid: altVotes.dayUid, n: sql<number>`count(*)::int` })
    .from(altVotes)
    .where(eq(altVotes.rideId, rideId))
    .groupBy(altVotes.dayUid)
  const byUid = new Map(counts.map((c) => [c.dayUid, c.n]))

  const mine = viewerId === null ? [] : await minePicks(rideId, viewerId)
  const mineSet = new Set(mine)

  const groups = new Map<number, VoteGroup>()
  for (const r of rows) {
    const g = r.altGroup as number
    if (!groups.has(g)) groups.set(g, { altGroup: g, tallies: [], mine: null })
    const entry = groups.get(g)!
    entry.tallies.push({ uid: r.uid, votes: byUid.get(r.uid) ?? 0, active: r.active })
    if (mineSet.has(r.uid)) entry.mine = r.uid
  }
  return [...groups.values()].sort((a, b) => a.altGroup - b.altGroup)
}

const minePicks = async (rideId: number, viewerId: number): Promise<string[]> =>
  (
    await db
      .select({ dayUid: altVotes.dayUid })
      .from(altVotes)
      .where(and(eq(altVotes.rideId, rideId), eq(altVotes.userId, viewerId)))
  ).map((r) => r.dayUid)

export type CastResult = { ok: true } | { ok: false; reason: 'closed' | 'not-an-alternate' }

/**
 * Cast or move a vote.
 *
 * ONE VOTE PER MEMBER PER GROUP, and this transaction is the only thing
 * enforcing it. The primary key stops a rider voting twice for the SAME day; it
 * cannot stop them voting for every day in a group, because a group has no
 * durable id to put in an index — it forms and dissolves as a rider edits and
 * `alt_group` is rewritten on every save. So the group is resolved from the
 * days as they stand right now and the member's other votes in it are deleted
 * in the same transaction as the insert.
 *
 * Voting for the day you already voted for is a WITHDRAWAL rather than a no-op.
 * A vote is the only thing a member can say here, so pressing it again has to be
 * how they unsay it — there is nowhere else to put an Undo that would not be a
 * second control meaning "not that one after all".
 */
export async function castVote(rideId: number, viewerId: number, dayUid: string): Promise<CastResult> {
  const [ride] = await db.select({ closeAt: rides.altVotesCloseAt }).from(rides).where(eq(rides.id, rideId)).limit(1)
  if (!ride) return { ok: false, reason: 'not-an-alternate' }
  if (!votingOpen(ride.closeAt, new Date())) return { ok: false, reason: 'closed' }

  const [target] = await db
    .select({ altGroup: daysTable.altGroup })
    .from(daysTable)
    .where(and(eq(daysTable.rideId, rideId), eq(daysTable.uid, dayUid)))
    .limit(1)
  // A plain day is not a candidate. Voting on one would create a group of one
  // that electWinner refuses anyway, and a tally beside a day with no siblings
  // is a control that can never do anything.
  if (!target || target.altGroup === null) return { ok: false, reason: 'not-an-alternate' }

  const siblings = (
    await db
      .select({ uid: daysTable.uid })
      .from(daysTable)
      .where(and(eq(daysTable.rideId, rideId), eq(daysTable.altGroup, target.altGroup)))
  ).map((r) => r.uid)

  await db.transaction(async (tx) => {
    const had = await tx
      .select({ dayUid: altVotes.dayUid })
      .from(altVotes)
      .where(and(eq(altVotes.rideId, rideId), eq(altVotes.userId, viewerId), inArray(altVotes.dayUid, siblings)))
    await tx
      .delete(altVotes)
      .where(and(eq(altVotes.rideId, rideId), eq(altVotes.userId, viewerId), inArray(altVotes.dayUid, siblings)))
    // Pressing the same alternate again withdraws rather than re-casting.
    if (!had.some((h) => h.dayUid === dayUid)) {
      await tx.insert(altVotes).values({ rideId, dayUid, userId: viewerId })
    }
  })
  return { ok: true }
}

/**
 * Apply a group's tally, returning the day uids that changed.
 *
 * Shared by the sweep and by the owner's Resolve now button, so a scheduled
 * resolution and a pressed one cannot disagree about what the votes said.
 */
export async function applyTallies(rideId: number): Promise<string[]> {
  const groups = await voteGroups(rideId, null)
  const changed: string[] = []
  for (const g of groups) {
    const winner = electWinner(g.tallies)
    if (!winner) continue
    await db.transaction(async (tx) => {
      // Both halves in one transaction, and the loser first: uq_day_alt_active
      // is a partial unique index over the winning member of each group, so
      // setting the new winner active while the old one still is would violate
      // it. That index is a tripwire for a bug in resolveAltGroups and this is
      // the one place in the app that would trip it legitimately.
      for (const t of g.tallies) {
        if (t.uid !== winner && t.active) {
          await tx
            .update(daysTable)
            .set({ altActive: false })
            .where(and(eq(daysTable.rideId, rideId), eq(daysTable.uid, t.uid)))
        }
      }
      await tx
        .update(daysTable)
        .set({ altActive: true })
        .where(and(eq(daysTable.rideId, rideId), eq(daysTable.uid, winner)))
    })
    changed.push(winner)
  }
  return changed
}
