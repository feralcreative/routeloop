// The database half of the saved-place library. Every rule it enforces lives in
// policy.ts, which is the half with the tests — this file is queries and nothing
// else, the same split invites, survey, stats and feedback already use.
//
// **Ownership is checked in every function here, not at the route.** A place
// library is per-rider and there is no sharing surface at all, so the safe shape
// is one where a caller cannot ask for someone else's row: every read and write
// takes an `ownerId` and folds it into the WHERE clause. A route that forgot its
// gate would still return nothing rather than someone else's home address.
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { placeGroups, places, type PlaceGroupRow, type PlaceRow } from '../db/schema'
import type { GroupInput, PlaceInput } from './policy'

export async function listPlaces(ownerId: number): Promise<{ groups: PlaceGroupRow[]; places: PlaceRow[] }> {
  const [groupRows, placeRows] = await Promise.all([
    db.select().from(placeGroups).where(eq(placeGroups.ownerId, ownerId)).orderBy(asc(placeGroups.position)),
    db.select().from(places).where(eq(places.ownerId, ownerId)).orderBy(asc(places.name)),
  ])
  return { groups: groupRows, places: placeRows }
}

export async function countPlaces(ownerId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(places)
    .where(eq(places.ownerId, ownerId))
  return row?.n ?? 0
}

export async function countGroups(ownerId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(placeGroups)
    .where(eq(placeGroups.ownerId, ownerId))
  return row?.n ?? 0
}

/** One place, or undefined — including when it belongs to someone else. */
export async function getPlace(ownerId: number, id: number): Promise<PlaceRow | undefined> {
  const [row] = await db
    .select()
    .from(places)
    .where(and(eq(places.id, id), eq(places.ownerId, ownerId)))
    .limit(1)
  return row
}

// Empty string to null, so clearing a field removes the value rather than
// storing ''. Same rule the point_details writer follows, and for the same
// reason: two representations of "nothing here" means every reader has to test
// for both.
const orNull = (v: string): string | null => (v.trim() === '' ? null : v.trim())

// A group id from the payload is only honored if the rider actually owns that
// group. Without this a crafted request could file a place into a stranger's
// group — harmless-looking, but it would then appear in their library.
async function ownedGroupId(ownerId: number, groupId: number | null): Promise<number | null> {
  if (groupId == null) return null
  const [row] = await db
    .select({ id: placeGroups.id })
    .from(placeGroups)
    .where(and(eq(placeGroups.id, groupId), eq(placeGroups.ownerId, ownerId)))
    .limit(1)
  return row ? row.id : null
}

export async function createPlace(ownerId: number, input: PlaceInput): Promise<PlaceRow> {
  const [row] = await db
    .insert(places)
    .values({
      ownerId,
      groupId: await ownedGroupId(ownerId, input.groupId),
      name: input.name,
      lat: input.lat,
      lng: input.lng,
      roles: input.roles,
      phone: orNull(input.phone),
      address: orNull(input.address),
      links: input.links.filter((l) => l.url),
    })
    .returning()
  return row
}

export async function updatePlace(ownerId: number, id: number, input: PlaceInput): Promise<PlaceRow | undefined> {
  const [row] = await db
    .update(places)
    .set({
      groupId: await ownedGroupId(ownerId, input.groupId),
      name: input.name,
      lat: input.lat,
      lng: input.lng,
      roles: input.roles,
      phone: orNull(input.phone),
      address: orNull(input.address),
      links: input.links.filter((l) => l.url),
      updatedAt: new Date(),
    })
    .where(and(eq(places.id, id), eq(places.ownerId, ownerId)))
    .returning()
  return row
}

export async function deletePlace(ownerId: number, id: number): Promise<boolean> {
  const rows = await db
    .delete(places)
    .where(and(eq(places.id, id), eq(places.ownerId, ownerId)))
    .returning({ id: places.id })
  return rows.length > 0
}

export async function createGroup(ownerId: number, input: GroupInput): Promise<PlaceGroupRow | undefined> {
  const [last] = await db
    .select({ p: sql<number>`coalesce(max(${placeGroups.position}), -1)::int` })
    .from(placeGroups)
    .where(eq(placeGroups.ownerId, ownerId))
  const [row] = await db
    .insert(placeGroups)
    .values({ ownerId, name: input.name, position: (last?.p ?? -1) + 1 })
    // A duplicate name is a rider typing one they already have, not an error
    // worth a 400 — the unique index is per owner, and the sensible answer is
    // "you already have that one".
    .onConflictDoNothing({ target: [placeGroups.ownerId, placeGroups.name] })
    .returning()
  return row
}

export async function renameGroup(ownerId: number, id: number, input: GroupInput): Promise<PlaceGroupRow | undefined> {
  const [row] = await db
    .update(placeGroups)
    .set({ name: input.name })
    .where(and(eq(placeGroups.id, id), eq(placeGroups.ownerId, ownerId)))
    .returning()
  return row
}

/**
 * Deletes a group. **The places in it survive** and become ungrouped — the FK is
 * `set null`, not cascade.
 *
 * That is deliberate and worth not "fixing": a rider tidying up a folder name
 * must not lose the locations filed under it, and cascade is exactly how that
 * would happen. groupPlaces() in policy.ts renders the survivors in their own
 * section.
 */
export async function deleteGroup(ownerId: number, id: number): Promise<boolean> {
  const rows = await db
    .delete(placeGroups)
    .where(and(eq(placeGroups.id, id), eq(placeGroups.ownerId, ownerId)))
    .returning({ id: placeGroups.id })
  return rows.length > 0
}
