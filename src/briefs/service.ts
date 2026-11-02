// The only reader and writer of `ride_briefs` (#456). policy.ts decides the shape.
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { rideBriefs } from '../db/schema'
import { mergeBrief, readBrief, type Brief, type BriefEdit } from './policy'

export async function briefFor(rideId: number): Promise<Brief> {
  const [row] = await db.select({ brief: rideBriefs.brief }).from(rideBriefs).where(eq(rideBriefs.rideId, rideId))
  return readBrief(row?.brief)
}

/**
 * Apply an edit to the ride's brief and return the result.
 *
 * MERGED AGAINST THE STORED ROW, UNDER A LOCK, never against a copy read at the
 * start of a turn: two planners' assistants changing different fields at once must
 * both land, and a whole-document write from a stale read would erase the first.
 * The empty row is inserted first (and ignored if present) so there is always a row
 * to lock, which is what makes two first writes safe as well.
 *
 * FIELDS THIS CODE NO LONGER KNOWS ARE KEPT: the merge reads leniently, but what it
 * writes back is the stored document with the known fields replaced, so a field an
 * older or newer release wrote survives.
 */
export async function updateBrief(rideId: number, userId: number, edit: BriefEdit): Promise<Brief> {
  return db.transaction(async (tx) => {
    await tx
      .insert(rideBriefs)
      .values({ rideId, brief: {}, updatedBy: userId })
      .onConflictDoNothing({ target: rideBriefs.rideId })
    const [row] = await tx
      .select({ brief: rideBriefs.brief })
      .from(rideBriefs)
      .where(eq(rideBriefs.rideId, rideId))
      .for('update')
    const stored = row?.brief && typeof row.brief === 'object' ? (row.brief as Record<string, unknown>) : {}
    const known = mergeBrief(readBrief(stored), edit)
    const keep = Object.fromEntries(Object.entries(stored).filter(([k]) => !(k in known) && !(k in edit)))
    await tx
      .update(rideBriefs)
      .set({ brief: { ...keep, ...known }, updatedAt: sql`now()`, updatedBy: userId })
      .where(eq(rideBriefs.rideId, rideId))
    return known
  })
}
