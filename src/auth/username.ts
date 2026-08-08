// Usernames: validation, availability, and claiming one.
//
// Extracted from routes/profile.ts because there are now two places a rider can
// set a name — the signup prompt and the profile form — and they have to agree
// on every rule. A second copy of "is this free?" is a second copy of the race
// handling and the reserved list, and those drift.
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index'
import { users, usernameHistory, type UserRow } from '../db/schema'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type Executor = typeof db | Tx

// How long a released name stays out of everyone else's reach. Named once so
// the check and the copy that explains it cannot disagree.
export const USERNAME_HOLD_DAYS = 30

// Reserved because a username is the natural basis for a future public profile
// URL, and because the rider-list lookup will accept usernames. Claiming "api"
// or "builder" now would poison that later.
//
// Note that paths containing a hyphen never need to be listed: the charset
// below is letters, numbers and underscores only, so /choose-name can never be
// shadowed by a username.
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'builder',
  'dashboard',
  'favicon',
  'i',
  'img',
  'invites',
  'js',
  'login',
  'logout',
  'm',
  'places',
  'profile',
  'static',
  'style',
  'survey',
  'video',
  'welcome',
])

export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'username must be at least 3 characters')
  .max(30, 'username must be 30 characters or fewer')
  .regex(/^[a-zA-Z0-9_]+$/, 'username may use only letters, numbers and underscores')
  .refine((v) => !RESERVED_USERNAMES.has(v.toLowerCase()), 'that username is reserved')

const pad = (n: number): string => String(n).padStart(2, '0')

// The rider's permanent public handle: `{first-username}-{YYMMDDTHHMMZ}`.
//
// Built from explicit UTC getters rather than toISOString slicing or local
// getters, because users.created_at is `timestamp` *without* time zone — the
// Z in the format is a promise, and the server's own clock zone must not be
// what decides whether it is kept.
export function publicIdFor(username: string, createdAt: Date): string {
  const stamp =
    pad(createdAt.getUTCFullYear() % 100) +
    pad(createdAt.getUTCMonth() + 1) +
    pad(createdAt.getUTCDate()) +
    'T' +
    pad(createdAt.getUTCHours()) +
    pad(createdAt.getUTCMinutes()) +
    'Z'
  return `${username.toLowerCase()}-${stamp}`
}

export type Availability =
  | { ok: true }
  | { ok: false; reason: 'taken' }
  | { ok: false; reason: 'held'; until: Date }

// Two questions, not one. A name is unavailable while someone else holds it, and
// for USERNAME_HOLD_DAYS after someone else let it go — but never to the rider
// who let it go, which is the entire point of the hold.
//
// Both checks are advisory. uq_username_lower is the hard guard, and callers
// still have to catch its violation: two riders can pass this check in the same
// instant and only one of them can win the insert.
export async function checkAvailability(
  name: string,
  selfUserId: number,
  exec: Executor = db,
): Promise<Availability> {
  const [heldNow] = await exec
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = lower(${name}) and ${users.id} <> ${selfUserId}`)
    .limit(1)
  if (heldNow) return { ok: false, reason: 'taken' }

  const [recent] = await exec
    .select({ releasedAt: usernameHistory.releasedAt })
    .from(usernameHistory)
    .where(
      sql`lower(${usernameHistory.username}) = lower(${name})
          and ${usernameHistory.userId} <> ${selfUserId}
          and ${usernameHistory.releasedAt} is not null
          and ${usernameHistory.releasedAt} > now() - ${sql.raw(`interval '${USERNAME_HOLD_DAYS} days'`)}`,
    )
    .orderBy(sql`${usernameHistory.releasedAt} desc`)
    .limit(1)

  if (recent?.releasedAt) {
    const until = new Date(recent.releasedAt.getTime() + USERNAME_HOLD_DAYS * 86400000)
    return { ok: false, reason: 'held', until }
  }
  return { ok: true }
}

// Claims a name for a rider: closes out whatever they held, records the new one,
// and updates the account. Callers pass their own transaction — the history and
// users.username must never be able to disagree, and they would if this ran as
// three independent statements.
export async function claimUsername(tx: Tx, user: UserRow, name: string): Promise<void> {
  const now = new Date()

  await tx
    .update(usernameHistory)
    .set({ releasedAt: now })
    .where(and(eq(usernameHistory.userId, user.id), isNull(usernameHistory.releasedAt)))

  await tx.insert(usernameHistory).values({ userId: user.id, username: name, claimedAt: now })

  // public_id is written once and never again. It is stamped from the account's
  // creation time and the *first* name ever held, so every later change leaves
  // it alone and anything that has referred to this rider keeps resolving.
  const patch: { username: string; updatedAt: Date; publicId?: string } = { username: name, updatedAt: now }
  if (!user.publicId) patch.publicId = publicIdFor(name, user.createdAt ?? now)

  await tx.update(users).set(patch).where(eq(users.id, user.id))
}

// Every name a rider has held, newest first. Their own history only — this is
// not a lookup anyone else gets to run.
export async function usernameHistoryFor(userId: number, exec: Executor = db) {
  return exec
    .select()
    .from(usernameHistory)
    .where(eq(usernameHistory.userId, userId))
    .orderBy(sql`${usernameHistory.claimedAt} desc`)
}
