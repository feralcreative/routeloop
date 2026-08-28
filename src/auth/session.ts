// Server sessions, hand-rolled per the current Lucia/Copenhagen Book guidance.
//
// The browser gets a random token. The database stores only its SHA-256 hash,
// so a database leak yields no usable cookies. Web Crypto rather than
// node:crypto keeps this portable to Cloudflare Workers later.
import { eq, lt } from 'drizzle-orm'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { IS_HTTPS_ORIGIN } from '../config'
import { db } from '../db/index'
import { sessions, userProfiles, users, type UserRow } from '../db/schema'
import { type Scheme, type Theme, toScheme, toTheme } from '../views/appearance'
import { type Motion, toMotion } from '../views/motion'

// Renamed with the product on 2026-08-11. No legacy name is read: these cookies
// are host-scoped with no `domain` attribute, so moving the canonical host to
// routeloop.app invalidates every one of them anyway. Everybody signs in once.
export const SESSION_COOKIE = 'routeloop_session'

const DAY_MS = 24 * 60 * 60 * 1000
const SESSION_TTL_MS = 30 * DAY_MS
// Renewed once fewer than half the lifetime remains, so active users are not
// logged out on a fixed schedule.
const RENEW_WHEN_UNDER_MS = 15 * DAY_MS

// APP_ORIGIN decides the Secure flag: dev runs on plain http at 127.0.0.1, and a
// Secure cookie there would simply never be sent back. Exported because the
// OAuth state and PKCE cookies must be flagged identically.
export const SECURE_COOKIES = IS_HTTPS_ORIGIN

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function generateSessionToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return toHex(new Uint8Array(digest))
}

export async function createSession(userId: number): Promise<string> {
  const token = generateSessionToken()
  await db.insert(sessions).values({
    id: await hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  })
  return token
}

/**
 * The signed-in rider, plus the three appearance values the shell needs.
 *
 * `theme`, `scheme` and `motion` are widened onto the user rather than returned beside it
 * because `page()` takes a user and nothing else that could carry them. They are
 * DISPLAY values and belong to no table row on their own — `user_profiles` holds
 * them, `users` does not — which is why this is a composed type rather than a
 * change to UserRow.
 */
export type SessionUser = {
  user: UserRow & { theme: Theme; scheme: Scheme; motion: Motion; avatarBytes: number }
  sessionId: string
}

// Returns the signed-in user, or undefined. Expired rows are deleted on sight
// rather than left to accumulate.
export async function validateSessionToken(token: string): Promise<SessionUser | undefined> {
  if (!token) return undefined
  const id = await hashToken(token)

  // The appearance columns ride along on the session query rather than being
  // fetched per page, and the LEFT join is what makes that free: it is the same
  // round trip, and `user_profiles` is keyed by user_id as its primary key.
  //
  // Carried on the user object because that is what reaches the renderer.
  // page() in src/views/layout.tsx stamps `data-theme` and `data-scheme` on
  // <html>, and it is called from 32 places across 16 files — threading two more
  // arguments through all of them would work until somebody added the 33rd and
  // forgot, and a missed call site is not a visible bug. It is a page that
  // silently renders light for a rider who chose dark.
  //
  // LEFT, not inner: `user_profiles` rows are created lazily by the preferences
  // upsert, so most riders have no row at all. An inner join here would sign
  // them all out.
  const [row] = await db
    .select({
      session: sessions,
      user: users,
      theme: userProfiles.theme,
      scheme: userProfiles.scheme,
      motion: userProfiles.motion,
      avatarBytes: userProfiles.avatarBytes,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(sessions.id, id))
    .limit(1)
  if (!row) return undefined

  if (row.session.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, id))
    return undefined
  }

  if (row.session.expiresAt.getTime() - Date.now() < RENEW_WHEN_UNDER_MS) {
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
      .where(eq(sessions.id, id))
  }

  // Coerced here so no reader downstream has to interpret a null — a rider with
  // no profile row gets the same values as one who chose the defaults.
  return {
    user: {
      ...row.user,
      theme: toTheme(row.theme),
      scheme: toScheme(row.scheme),
      motion: toMotion(row.motion),
      // THE UPLOAD WINS OVER THE PROVIDER PICTURE when both exist (#99).
      // `users.avatar_url` is write-once from Google sign-in and a rider cannot
      // change it; an upload is a deliberate choice and outranks it. Zero means
      // no upload, which is what makes the column the flag as well as the size.
      avatarBytes: row.avatarBytes ?? 0,
    },
    sessionId: id,
  }
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}

// Housekeeping for expired rows belonging to users who never returned.
export async function deleteExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: 'Lax', // still sent on the top-level redirect back from the provider
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  })
}

export function readSessionCookie(c: Context): string {
  return getCookie(c, SESSION_COOKIE) ?? ''
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: SECURE_COOKIES })
}
