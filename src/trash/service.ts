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
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { placeGroups, places, rides, users, type PlaceGroupRow, type PlaceRow, type RideRow } from '../db/schema'
import { canRestore, purgeDateFor, type RestoreRefusal } from './policy'

/** Every ride not in the bin. The default for any query a rider's own eyes reach. */
export const LIVE_RIDE = isNull(rides.deletedAt)

/** Every ride in the bin, due or not. What the bin page lists. */
export const TRASHED_RIDE = isNotNull(rides.deletedAt)

export const LIVE_PLACE = isNull(places.deletedAt)
export const TRASHED_PLACE = isNotNull(places.deletedAt)

export const LIVE_PLACE_GROUP = isNull(placeGroups.deletedAt)
export const TRASHED_PLACE_GROUP = isNotNull(placeGroups.deletedAt)

// --- Operations --------------------------------------------------------------
//
/** What a successful trash hands back: the date the rider is being promised. */
export type Trashed = { purgeAfter: Date }
//
// Everything below moves a row into the bin or takes it out again. Nothing here
// destroys anything: that is the purge, and it is the only code in the app
// allowed to.

/**
 * Moves a ride to the bin and frees its quota on the spot.
 *
 * THE QUOTA DECREMENT IS THE SAME ONE THE OLD HARD DELETE DID, clamp included —
 * a drifted tally must never wedge an account negative. What is different is
 * that the files stay on disk and the row stays in the table, so this is
 * reversible and the old one was not.
 *
 * Narrowed by LIVE_RIDE so trashing something already in the bin is a no-op
 * rather than a second decrement. Without it a rider could drain their own
 * tally to zero by pressing the button twice.
 */
export async function trashRide(ownerId: number, rideId: number): Promise<Trashed | null> {
  const now = new Date()
  const purgeAfter = purgeDateFor(now)
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(rides)
      .set({ deletedAt: now, purgeAfter, updatedAt: now })
      .where(and(eq(rides.id, rideId), eq(rides.ownerId, ownerId), LIVE_RIDE))
      .returning({ id: rides.id, sizeBytes: rides.sizeBytes })
    if (!row) return null

    await tx
      .update(users)
      .set({
        usedBytes: sql`GREATEST(0, ${users.usedBytes} - ${row.sizeBytes ?? 0})`,
        updatedAt: now,
      })
      .where(eq(users.id, ownerId))
    console.log(`[trash] user ${ownerId} binned ride ${rideId} (freed ${row.sizeBytes ?? 0} bytes)`)
    return { purgeAfter }
  })
}

export type RestoreResult = { ok: true } | { ok: false; reason: 'not-found' | RestoreRefusal | 'name-taken' }

/**
 * Takes a ride back out of the bin, if there is room for it.
 *
 * The quota check is why this cannot be a one-statement UPDATE: trashing freed
 * the allowance, and between then and now the rider may well have spent it. See
 * canRestore() in ./policy.ts.
 *
 * `purge_started_at is null` is the other half. A row the purge has already
 * claimed is on its way out inside a running sweep, and restoring it would race
 * a delete that is mid-flight — refuse, and let it go.
 */
export async function restoreRide(ownerId: number, rideId: number): Promise<RestoreResult> {
  const [row] = await db
    .select({ sizeBytes: rides.sizeBytes, deletedAt: rides.deletedAt, purgeStartedAt: rides.purgeStartedAt })
    .from(rides)
    .where(and(eq(rides.id, rideId), eq(rides.ownerId, ownerId), TRASHED_RIDE, isNull(rides.purgeStartedAt)))
    .limit(1)
  if (!row) return { ok: false, reason: 'not-found' }

  const [owner] = await db
    .select({ usedBytes: users.usedBytes, quotaBytes: users.quotaBytes })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1)
  if (!owner) return { ok: false, reason: 'not-found' }

  const check = canRestore({
    sizeBytes: row.sizeBytes ?? 0,
    usedBytes: owner.usedBytes,
    quotaBytes: owner.quotaBytes,
    trashed: true,
  })
  if (!check.ok) return { ok: false, reason: check.reason }

  const now = new Date()
  return db.transaction(async (tx) => {
    const [restored] = await tx
      .update(rides)
      .set({ deletedAt: null, purgeAfter: null, purgeStartedAt: null, updatedAt: now })
      .where(and(eq(rides.id, rideId), eq(rides.ownerId, ownerId), TRASHED_RIDE, isNull(rides.purgeStartedAt)))
      .returning({ id: rides.id, sizeBytes: rides.sizeBytes })
    if (!restored) return { ok: false, reason: 'not-found' } as RestoreResult

    await tx
      .update(users)
      .set({ usedBytes: sql`${users.usedBytes} + ${restored.sizeBytes ?? 0}`, updatedAt: now })
      .where(eq(users.id, ownerId))
    console.log(`[trash] user ${ownerId} restored ride ${rideId} (${restored.sizeBytes ?? 0} bytes)`)
    return { ok: true } as RestoreResult
  })
}

/** A saved place costs no quota, so this is the whole operation. */
export async function trashPlace(ownerId: number, id: number): Promise<Trashed | null> {
  const now = new Date()
  const purgeAfter = purgeDateFor(now)
  const rows = await db
    .update(places)
    .set({ deletedAt: now, purgeAfter, updatedAt: now })
    .where(and(eq(places.id, id), eq(places.ownerId, ownerId), LIVE_PLACE))
    .returning({ id: places.id })
  return rows.length > 0 ? { purgeAfter } : null
}

/**
 * A place comes back UNGROUPED if its group has gone in the meantime.
 *
 * Nothing extra is needed to make that happen: `places.group_id` is `set null`
 * on the group's delete, so a place whose group was purged already has a null
 * there. Worth stating because it looks like data loss and is not — it is the
 * same thing that happens when a rider deletes a group today.
 */
export async function restorePlace(ownerId: number, id: number): Promise<boolean> {
  const rows = await db
    .update(places)
    .set({ deletedAt: null, purgeAfter: null, updatedAt: new Date() })
    .where(and(eq(places.id, id), eq(places.ownerId, ownerId), TRASHED_PLACE))
    .returning({ id: places.id })
  return rows.length > 0
}

/**
 * Bins a group. Its places stay in the library and become ungrouped, which is
 * exactly what deleting one does today — see deleteGroup() in places/service.ts
 * for why that is `set null` rather than cascade.
 *
 * The consequence, and it is worth being plain about it: restoring the group
 * brings back an EMPTY group. Re-filing the places is the rider's to do. Making
 * the restore re-adopt them would mean remembering the membership somewhere,
 * which is a table for something a rider can redo in three clicks.
 */
export async function trashGroup(ownerId: number, id: number): Promise<Trashed | null> {
  const now = new Date()
  const purgeAfter = purgeDateFor(now)
  const rows = await db
    .update(placeGroups)
    .set({ deletedAt: now, purgeAfter })
    .where(and(eq(placeGroups.id, id), eq(placeGroups.ownerId, ownerId), LIVE_PLACE_GROUP))
    .returning({ id: placeGroups.id })
  return rows.length > 0 ? { purgeAfter } : null
}

/**
 * Takes a group back out, unless the rider has since made another by that name.
 *
 * That collision is the price of the PARTIAL unique index — binning a group
 * frees its name immediately, which is the behavior a rider expects, and the
 * cost is that the name can be gone when they change their mind. Checked here
 * and refused with a reason, because the alternative is a raw unique-violation
 * 500 from Postgres.
 */
export async function restoreGroup(ownerId: number, id: number): Promise<RestoreResult> {
  const [row] = await db
    .select({ name: placeGroups.name })
    .from(placeGroups)
    .where(and(eq(placeGroups.id, id), eq(placeGroups.ownerId, ownerId), TRASHED_PLACE_GROUP))
    .limit(1)
  if (!row) return { ok: false, reason: 'not-found' }

  const [clash] = await db
    .select({ id: placeGroups.id })
    .from(placeGroups)
    .where(and(eq(placeGroups.ownerId, ownerId), eq(placeGroups.name, row.name), LIVE_PLACE_GROUP))
    .limit(1)
  if (clash) return { ok: false, reason: 'name-taken' }

  const rows = await db
    .update(placeGroups)
    .set({ deletedAt: null, purgeAfter: null })
    .where(and(eq(placeGroups.id, id), eq(placeGroups.ownerId, ownerId), TRASHED_PLACE_GROUP))
    .returning({ id: placeGroups.id })
  return rows.length > 0 ? { ok: true } : { ok: false, reason: 'not-found' }
}

export type BinContents = {
  rides: RideRow[]
  places: PlaceRow[]
  groups: PlaceGroupRow[]
}

/**
 * Everything a rider has in the bin, soonest to be destroyed first.
 *
 * Ordered by purge_after rather than deleted_at, which are the same order today
 * and would stop being if the hold ever changed length — the rider is looking at
 * this page to see what is about to go, so it sorts by that.
 */
export async function listBin(ownerId: number): Promise<BinContents> {
  const [rideRows, placeRows, groupRows] = await Promise.all([
    db
      .select()
      .from(rides)
      .where(and(eq(rides.ownerId, ownerId), TRASHED_RIDE))
      .orderBy(asc(rides.purgeAfter)),
    db
      .select()
      .from(places)
      .where(and(eq(places.ownerId, ownerId), TRASHED_PLACE))
      .orderBy(asc(places.purgeAfter)),
    db
      .select()
      .from(placeGroups)
      .where(and(eq(placeGroups.ownerId, ownerId), TRASHED_PLACE_GROUP))
      .orderBy(asc(placeGroups.purgeAfter)),
  ])
  return { rides: rideRows, places: placeRows, groups: groupRows }
}
