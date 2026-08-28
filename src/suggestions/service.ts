// Suggestions, query side. The rules are in ./policy.ts and nothing here
// re-decides one.
//
// ACCEPTING A SUGGESTION IS A NORMAL RIDE SAVE with one day swapped out. It
// re-reads the ride's payload, replaces the target day, and goes back through
// insertRideGraph — the SAME path the builder's PUT and the native JSON import
// use. That is deliberate: a second write path for "apply a day" would be a
// second place for the graph's invariants to be got wrong, and this one already
// handles uids, alts, subgroups, votes, details and comments correctly.
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '../db/index'
import {
  days as daysTable,
  points as pointsTable,
  rideSuggestions,
  rides,
  users,
  type RideRow,
} from '../db/schema'
import { membershipOf } from '../members/service'
import { dayPayload, insertRideGraph, rideTotals, type DayPayload } from '../maps/ride-graph'
import { loadRidePayload } from '../routes/builder'
import {
  canDecide,
  canPropose,
  canWithdraw,
  dayFingerprint,
  isActionable,
  MAX_OPEN_PER_RIDER,
  suggestionState,
  type DayShape,
  type SuggestionFields,
  type SuggestionState,
} from './policy'

/**
 * Every day of a ride, as the fingerprint wants it.
 *
 * Read from the DATABASE rather than from a payload the client sent, because the
 * fingerprint has to describe what the ride actually says — a client that
 * fingerprinted its own idea of the day would find every suggestion applied
 * cleanly to a ride it had already changed.
 */
export async function dayShapes(rideId: number): Promise<Map<string, DayShape>> {
  const rows = await db
    .select({ id: daysTable.id, uid: daysTable.uid })
    .from(daysTable)
    .where(eq(daysTable.rideId, rideId))
    .orderBy(asc(daysTable.position))
  const out = new Map<string, DayShape>()
  for (const r of rows) {
    const pts = await db
      .select({ uid: pointsTable.uid, lng: pointsTable.lng, lat: pointsTable.lat, kind: pointsTable.kind })
      .from(pointsTable)
      .where(eq(pointsTable.dayId, r.id))
      .orderBy(asc(pointsTable.position))
    out.set(r.uid, { uid: r.uid, points: pts })
  }
  return out
}

export type SuggestionView = SuggestionFields & {
  note: string | null
  createdAt: Date
  authorName: string
  authorHandle: string | null
  state: SuggestionState
}

/** Every suggestion on a ride, oldest first, each with its state derived
 *  against what the ride says right now. */
export async function suggestionsOn(rideId: number): Promise<SuggestionView[]> {
  const [rows, shapes] = await Promise.all([
    db
      .select({
        id: rideSuggestions.id,
        authorId: rideSuggestions.authorId,
        dayUid: rideSuggestions.dayUid,
        baseFingerprint: rideSuggestions.baseFingerprint,
        resolvedAt: rideSuggestions.resolvedAt,
        outcome: rideSuggestions.outcome,
        note: rideSuggestions.note,
        createdAt: rideSuggestions.createdAt,
        authorName: users.displayName,
        authorHandle: users.username,
      })
      .from(rideSuggestions)
      .innerJoin(users, eq(users.id, rideSuggestions.authorId))
      .where(eq(rideSuggestions.rideId, rideId))
      .orderBy(asc(rideSuggestions.createdAt)),
    dayShapes(rideId),
  ])
  return rows.map((r) => {
    const shape = shapes.get(r.dayUid)
    return { ...r, state: suggestionState(r, shape ? dayFingerprint(shape) : null) }
  })
}

export type ProposeResult =
  | { ok: true; id: number }
  | { ok: false; reason: 'refused' | 'invalid' | 'no-such-day' | 'too-many' }

/**
 * Propose a replacement for one day.
 *
 * **THE FINGERPRINT IS TAKEN HERE, FROM THE DATABASE, AND NEVER FROM THE
 * CLIENT.** It records what the day looked like at the moment the proposal was
 * made, which is the only thing that makes staleness meaningful. A
 * client-supplied fingerprint would let a stale proposal declare itself fresh.
 */
export async function propose(
  rideId: number,
  viewerId: number,
  dayUid: string,
  rawDay: unknown,
  note: string | null,
): Promise<ProposeResult> {
  const viewer = await membershipOf(rideId, viewerId)
  if (!canPropose(viewer)) return { ok: false, reason: 'refused' }

  const parsed = dayPayload.safeParse(rawDay)
  if (!parsed.success) return { ok: false, reason: 'invalid' }

  const shapes = await dayShapes(rideId)
  const target = shapes.get(dayUid)
  if (!target) return { ok: false, reason: 'no-such-day' }

  const open = await db
    .select({ id: rideSuggestions.id })
    .from(rideSuggestions)
    .where(
      and(
        eq(rideSuggestions.rideId, rideId),
        eq(rideSuggestions.authorId, viewerId),
        isNull(rideSuggestions.resolvedAt),
      ),
    )
  if (open.length >= MAX_OPEN_PER_RIDER) return { ok: false, reason: 'too-many' }

  const [row] = await db
    .insert(rideSuggestions)
    .values({
      rideId,
      authorId: viewerId,
      dayUid,
      payload: parsed.data,
      baseFingerprint: dayFingerprint(target),
      note: note && note.trim() ? note.trim().slice(0, 2000) : null,
    })
    .returning({ id: rideSuggestions.id })
  return { ok: true, id: row.id }
}

/** One suggestion, scoped to its ride so a forged id from another ride resolves
 *  to nothing rather than to a row the viewer has standing over here. */
async function suggestionRow(rideId: number, id: number) {
  const [row] = await db
    .select()
    .from(rideSuggestions)
    .where(and(eq(rideSuggestions.rideId, rideId), eq(rideSuggestions.id, id)))
    .limit(1)
  return row ?? null
}

export type DecideResult = { ok: true } | { ok: false; reason: 'refused' | 'stale' | 'not-found' }

/**
 * Accept a suggestion: replace its day and write the ride.
 *
 * **STALENESS IS RE-CHECKED HERE, NOT TRUSTED FROM THE PAGE.** The owner's list
 * was rendered from a read that may be minutes old, and the whole hazard this
 * feature has is applying a proposal made against a day that has since moved.
 *
 * The write goes through insertRideGraph like every other ride save, so the
 * accepted day gets the same treatment as one the owner drew: uids settled,
 * alt groups resolved, votes and comments reconciled, totals recomputed.
 */
export async function accept(rideId: number, viewerId: number, id: number, ride: RideRow): Promise<DecideResult> {
  const [viewer, row] = await Promise.all([membershipOf(rideId, viewerId), suggestionRow(rideId, id)])
  if (!row) return { ok: false, reason: 'not-found' }
  if (!canDecide(viewer)) return { ok: false, reason: 'refused' }

  const shapes = await dayShapes(rideId)
  const shape = shapes.get(row.dayUid)
  if (!isActionable(suggestionState(row, shape ? dayFingerprint(shape) : null))) {
    return { ok: false, reason: 'stale' }
  }

  // The ride as it stands, with the one day swapped for the proposal. Read
  // through the builder's own loader so the shape is exactly what the save path
  // expects — details included, because the accepting rider is the owner.
  const current = await loadRidePayload(ride, { id: viewerId })
  const proposed = row.payload as DayPayload
  const days = (current.days as DayPayload[]).map((d) => (d.uid === row.dayUid ? proposed : d))

  await db.transaction(async (tx) => {
    const payload = { ...current, days } as Parameters<typeof insertRideGraph>[2]
    await tx
      .update(rides)
      .set({ ...rideTotals(payload), updatedAt: new Date() })
      .where(eq(rides.id, rideId))
    await tx.delete(daysTable).where(eq(daysTable.rideId, rideId))
    await insertRideGraph(tx, rideId, payload)
    await tx
      .update(rideSuggestions)
      .set({ resolvedAt: new Date(), outcome: 'accepted' })
      .where(eq(rideSuggestions.id, id))
  })
  return { ok: true }
}

/** Turn one down. No staleness check — a stale proposal is exactly the kind an
 *  owner wants to be able to clear off the list. */
export async function discard(rideId: number, viewerId: number, id: number): Promise<DecideResult> {
  const [viewer, row] = await Promise.all([membershipOf(rideId, viewerId), suggestionRow(rideId, id)])
  if (!row) return { ok: false, reason: 'not-found' }
  if (!canDecide(viewer)) return { ok: false, reason: 'refused' }
  if (row.resolvedAt) return { ok: false, reason: 'refused' }
  await db
    .update(rideSuggestions)
    .set({ resolvedAt: new Date(), outcome: 'discarded' })
    .where(eq(rideSuggestions.id, id))
  return { ok: true }
}

/** Take your own proposal back. Recorded rather than deleted, so an owner who
 *  half-read it is not left wondering what it said. */
export async function withdraw(rideId: number, viewerId: number, id: number): Promise<DecideResult> {
  const [viewer, row] = await Promise.all([membershipOf(rideId, viewerId), suggestionRow(rideId, id)])
  if (!row) return { ok: false, reason: 'not-found' }
  if (!canWithdraw(viewer, row)) return { ok: false, reason: 'refused' }
  if (row.resolvedAt) return { ok: false, reason: 'refused' }
  await db
    .update(rideSuggestions)
    .set({ resolvedAt: new Date(), outcome: 'withdrawn' })
    .where(eq(rideSuggestions.id, id))
  return { ok: true }
}
