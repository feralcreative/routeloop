// Clubs (#182): the only module that reads or writes clubs, club_chapters and
// club_members. Every rule is in ./policy.ts, and every write here re-reads the
// standing it acts on, because a page renders its buttons from a moment ago.
import { and, asc, eq, sql } from 'drizzle-orm'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { db } from '../db/index'
import { clubChapters, clubMembers, clubs, userProfiles, users, type ClubPosition, type ClubRow } from '../db/schema'
import { STORAGE } from '../maps/storage'
import { PROCESSED_EXT } from '../images/process'
import type { RiderCard } from '../friends/service'
import type { Standing } from './policy'

export type ClubSummary = { id: number; name: string; members: number; hasIcon: boolean; managed: boolean }
export type RosterEntry = RiderCard & { status: Standing; position: ClubPosition; chapterId: number | null }

const card = {
  id: users.id,
  displayName: users.displayName,
  username: users.username,
  avatarUrl: users.avatarUrl,
  avatarBytes: sql<number>`coalesce(${userProfiles.avatarBytes}, 0)`,
}

export async function listClubs(): Promise<ClubSummary[]> {
  const rows = await db
    .select({
      id: clubs.id,
      name: clubs.name,
      iconBytes: clubs.iconBytes,
      managerId: clubs.managerId,
      members: sql<number>`count(${clubMembers.id}) filter (where ${clubMembers.status} = 'member')::int`,
    })
    .from(clubs)
    .leftJoin(clubMembers, eq(clubMembers.clubId, clubs.id))
    .groupBy(clubs.id)
    .orderBy(asc(clubs.name))
  return rows.map((r) => ({ id: r.id, name: r.name, members: r.members, hasIcon: r.iconBytes > 0, managed: r.managerId != null }))
}

export async function clubById(id: number): Promise<ClubRow | null> {
  const [row] = await db.select().from(clubs).where(eq(clubs.id, id)).limit(1)
  return row ?? null
}

export async function standingOf(clubId: number, userId: number): Promise<Standing> {
  const [row] = await db
    .select({ status: clubMembers.status })
    .from(clubMembers)
    .where(and(eq(clubMembers.clubId, clubId), eq(clubMembers.userId, userId)))
    .limit(1)
  return row?.status === 'member' ? 'member' : row?.status === 'requested' ? 'requested' : 'none'
}

export async function rosterOf(clubId: number): Promise<RosterEntry[]> {
  const rows = await db
    .select({ ...card, status: clubMembers.status, position: clubMembers.position, chapterId: clubMembers.chapterId })
    .from(clubMembers)
    .innerJoin(users, eq(users.id, clubMembers.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(and(eq(clubMembers.clubId, clubId), sql`${users.username} is not null`, sql`${users.deletionRequestedAt} is null`))
    .orderBy(asc(users.displayName))
  return rows.map((r) => ({ ...r, username: r.username!, status: r.status === 'member' ? 'member' : 'requested' }))
}

export async function chaptersOf(clubId: number): Promise<{ id: number; name: string }[]> {
  return db
    .select({ id: clubChapters.id, name: clubChapters.name })
    .from(clubChapters)
    .where(eq(clubChapters.clubId, clubId))
    .orderBy(asc(clubChapters.name))
}

/** Puts a rider on the roster as a member, or promotes their request. */
async function admit(clubId: number, userId: number): Promise<void> {
  await db
    .insert(clubMembers)
    .values({ clubId, userId, status: 'member' })
    .onConflictDoUpdate({ target: [clubMembers.clubId, clubMembers.userId], set: { status: 'member' } })
}

// --- Admin ------------------------------------------------------------------

export async function createClub(name: string, managerId: number | null): Promise<number> {
  const [row] = await db.insert(clubs).values({ name, managerId }).returning({ id: clubs.id })
  if (managerId != null) await admit(row.id, managerId)
  return row.id
}

/** Passing the torch. The old manager stays a member; the new one is admitted. */
export async function setManager(clubId: number, managerId: number | null): Promise<void> {
  await db.update(clubs).set({ managerId, updatedAt: new Date() }).where(eq(clubs.id, clubId))
  if (managerId != null) await admit(clubId, managerId)
}

// --- Every member: what the club says ----------------------------------------

export async function renameClub(clubId: number, name: string): Promise<void> {
  await db.update(clubs).set({ name, updatedAt: new Date() }).where(eq(clubs.id, clubId))
}

export async function addChapter(clubId: number, name: string): Promise<void> {
  await db
    .insert(clubChapters)
    .values({ clubId, name })
    .onConflictDoNothing()
}

export async function removeChapter(clubId: number, chapterId: number): Promise<void> {
  await db.delete(clubChapters).where(and(eq(clubChapters.id, chapterId), eq(clubChapters.clubId, clubId)))
}

/** A member picks their own chapter from the club's list, or none. */
export async function setOwnChapter(clubId: number, userId: number, chapterId: number | null): Promise<void> {
  if (chapterId != null) {
    const [ch] = await db
      .select({ id: clubChapters.id })
      .from(clubChapters)
      .where(and(eq(clubChapters.id, chapterId), eq(clubChapters.clubId, clubId)))
      .limit(1)
    if (!ch) return
  }
  await db
    .update(clubMembers)
    .set({ chapterId })
    .where(and(eq(clubMembers.clubId, clubId), eq(clubMembers.userId, userId), eq(clubMembers.status, 'member')))
}

// --- The roster: the manager's, plus each rider's own request and leaving ----

export async function requestToJoin(clubId: number, userId: number): Promise<void> {
  await db.insert(clubMembers).values({ clubId, userId, status: 'requested' }).onConflictDoNothing()
}

export async function leaveClub(clubId: number, userId: number): Promise<void> {
  await db.delete(clubMembers).where(and(eq(clubMembers.clubId, clubId), eq(clubMembers.userId, userId)))
}

export const acceptMember = admit
export const addMember = admit
export const removeMember = leaveClub

export async function setPosition(clubId: number, userId: number, position: ClubPosition): Promise<void> {
  await db
    .update(clubMembers)
    .set({ position })
    .where(and(eq(clubMembers.clubId, clubId), eq(clubMembers.userId, userId), eq(clubMembers.status, 'member')))
}

/** A rider's clubs, for their account archive and their profile. */
export async function clubsOf(userId: number) {
  return db
    .select({ club: clubs.name, status: clubMembers.status, position: clubMembers.position, chapter: clubChapters.name, since: clubMembers.createdAt })
    .from(clubMembers)
    .innerJoin(clubs, eq(clubs.id, clubMembers.clubId))
    .leftJoin(clubChapters, eq(clubChapters.id, clubMembers.chapterId))
    .where(eq(clubMembers.userId, userId))
    .orderBy(asc(clubs.name))
}

// --- The icon ----------------------------------------------------------------

/** STORAGE/clubs/<id>.webp, or undefined if it would escape the root. */
export function clubIconPath(clubId: number): string | undefined {
  if (!Number.isInteger(clubId) || clubId <= 0) return undefined
  const path = resolve(STORAGE, 'clubs', `${clubId}.${PROCESSED_EXT}`)
  return path.startsWith(STORAGE + sep) ? path : undefined
}

/** File first, row second, the bike photo's order. */
export async function setClubIcon(clubId: number, data: Buffer): Promise<void> {
  const path = clubIconPath(clubId)
  if (!path) throw new Error(`refusing to write outside storage root (club ${clubId})`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data, { mode: 0o640 })
  await db.update(clubs).set({ iconBytes: data.length, updatedAt: new Date() }).where(eq(clubs.id, clubId))
}

export async function clearClubIcon(clubId: number): Promise<void> {
  await db.update(clubs).set({ iconBytes: 0, updatedAt: new Date() }).where(eq(clubs.id, clubId))
  const path = clubIconPath(clubId)
  if (path) await unlink(path).catch(() => {})
}

export async function readClubIcon(clubId: number): Promise<Buffer | null> {
  const path = clubIconPath(clubId)
  return path ? readFile(path).catch(() => null) : null
}
