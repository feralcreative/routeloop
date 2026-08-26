// The database half of the Paddock. Every rule it enforces lives in policy.ts,
// which is the half with the tests — the same split places, invites, survey and
// feedback already use.
//
// **Ownership is folded into every WHERE clause here, not checked at the route.**
// Same rule as places/service.ts and for the same reason: a route that forgot its
// gate returns nothing rather than someone else's garage.
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { bikes, type BikeRow } from '../db/schema'
import { milesToMeters, type BikeInput } from './policy'
import { deleteBikePhoto } from './photo'

/** Miles in, meters out — the boundary, applied in exactly one place on the
 *  write path so no caller has to remember which unit it holds. */
const toRow = (input: BikeInput) => ({
  nickname: input.nickname,
  make: input.make,
  model: input.model,
  year: input.year,
  fuelType: input.fuelType,
  usableRangeM: input.usableRangeMi == null ? null : milesToMeters(input.usableRangeMi),
  comfortRangeM: input.comfortRangeMi == null ? null : milesToMeters(input.comfortRangeMi),
})

export async function listBikes(ownerId: number): Promise<BikeRow[]> {
  return db.select().from(bikes).where(eq(bikes.ownerId, ownerId)).orderBy(asc(bikes.position), asc(bikes.id))
}

export async function countBikes(ownerId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bikes)
    .where(eq(bikes.ownerId, ownerId))
  return row?.n ?? 0
}

/** One bike, or undefined — including when it belongs to someone else. */
export async function getBike(ownerId: number, id: number): Promise<BikeRow | undefined> {
  const [row] = await db
    .select()
    .from(bikes)
    .where(and(eq(bikes.id, id), eq(bikes.ownerId, ownerId)))
    .limit(1)
  return row
}

/**
 * Adds a bike.
 *
 * THE FIRST ONE IS THE DEFAULT, without being asked. A rider with one bike has
 * no choice to make, and making them tick a box to say so is a question with one
 * possible answer. Every bike after that arrives non-default.
 */
export async function createBike(ownerId: number, input: BikeInput): Promise<BikeRow | undefined> {
  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ p: sql<number>`coalesce(max(${bikes.position}), -1)::int`, n: sql<number>`count(*)::int` })
      .from(bikes)
      .where(eq(bikes.ownerId, ownerId))

    const [row] = await tx
      .insert(bikes)
      .values({
        ownerId,
        ...toRow(input),
        position: (last?.p ?? -1) + 1,
        isDefault: (last?.n ?? 0) === 0,
      })
      .returning()
    return row
  })
}

export async function updateBike(ownerId: number, id: number, input: BikeInput): Promise<BikeRow | undefined> {
  const [row] = await db
    .update(bikes)
    .set({ ...toRow(input), updatedAt: new Date() })
    .where(and(eq(bikes.id, id), eq(bikes.ownerId, ownerId)))
    .returning()
  return row
}

/**
 * Removes a bike and its photo.
 *
 * A HARD DELETE, unlike a ride. The recycle bin exists because a ride is a
 * plan somebody spent an evening on and cannot rebuild from memory; a bike is
 * five short fields and a picture, and re-adding one is a minute's work. If that
 * turns out to be wrong the columns are the same three the bin already uses.
 *
 * PROMOTES ANOTHER BIKE when the deleted one was the default, so a rider who
 * removes their only marked bike does not end up with a paddock and no default.
 * Oldest by position, which is the order they see.
 */
export async function deleteBike(ownerId: number, id: number): Promise<boolean> {
  const removed = await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(bikes)
      .where(and(eq(bikes.id, id), eq(bikes.ownerId, ownerId)))
      .returning({ id: bikes.id, wasDefault: bikes.isDefault })
    if (!row) return null

    if (row.wasDefault) {
      const [next] = await tx
        .select({ id: bikes.id })
        .from(bikes)
        .where(eq(bikes.ownerId, ownerId))
        .orderBy(asc(bikes.position), asc(bikes.id))
        .limit(1)
      if (next) await tx.update(bikes).set({ isDefault: true }).where(eq(bikes.id, next.id))
    }
    return row
  })

  // Outside the transaction: the row is gone either way, and a file that will
  // not unlink must not roll back a delete the rider asked for.
  if (removed) await deleteBikePhoto(ownerId, id)
  return removed != null
}

/**
 * Marks one bike as the default.
 *
 * CLEARS EVERY OTHER ONE FIRST, IN THE SAME TRANSACTION, because
 * `uq_bike_default` is a partial unique index on (owner_id) where is_default —
 * setting the new one while the old is still marked violates it and the whole
 * statement fails. The order is not optional and the transaction is what makes
 * the intermediate state, where the rider briefly has no default, invisible.
 */
export async function setDefaultBike(ownerId: number, id: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: bikes.id })
      .from(bikes)
      .where(and(eq(bikes.id, id), eq(bikes.ownerId, ownerId)))
      .limit(1)
    if (!target) return false

    await tx.update(bikes).set({ isDefault: false }).where(eq(bikes.ownerId, ownerId))
    await tx.update(bikes).set({ isDefault: true, updatedAt: new Date() }).where(eq(bikes.id, target.id))
    return true
  })
}

/** Records a processed photo against the bike. The bytes are written by the
 *  route; this is the row half, and `photo_bytes` is counted here and nowhere
 *  else — never in users.used_bytes. */
export async function setBikePhoto(
  ownerId: number,
  id: number,
  photo: { hash: string; bytes: number },
): Promise<BikeRow | undefined> {
  const [row] = await db
    .update(bikes)
    .set({ photoHash: photo.hash, photoBytes: photo.bytes, updatedAt: new Date() })
    .where(and(eq(bikes.id, id), eq(bikes.ownerId, ownerId)))
    .returning()
  return row
}

export async function clearBikePhoto(ownerId: number, id: number): Promise<boolean> {
  const [row] = await db
    .update(bikes)
    .set({ photoHash: null, photoBytes: 0, updatedAt: new Date() })
    .where(and(eq(bikes.id, id), eq(bikes.ownerId, ownerId)))
    .returning({ id: bikes.id })
  if (!row) return false
  await deleteBikePhoto(ownerId, id)
  return true
}
