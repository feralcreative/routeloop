// Server sessions, hand-rolled per the current Lucia/Copenhagen Book guidance.
//
// The browser gets a random token. The database stores only its SHA-256 hash,
// so a database leak yields no usable cookies. Web Crypto rather than
// node:crypto keeps this portable to Cloudflare Workers later.
import { eq, lt } from 'drizzle-orm'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { db } from '../db/index'
import { sessions, users, type UserRow } from '../db/schema'

export const SESSION_COOKIE = 'routeloop_session'

const DAY_MS = 24 * 60 * 60 * 1000
const SESSION_TTL_MS = 30 * DAY_MS
// Renewed once fewer than half the lifetime remains, so active users are not
// logged out on a fixed schedule.
const RENEW_WHEN_UNDER_MS = 15 * DAY_MS

// APP_ORIGIN decides the Secure flag: dev runs on plain http at 127.0.0.1, and a
// Secure cookie there would simply never be sent back.
const SECURE_COOKIES = (process.env.APP_ORIGIN ?? '').startsWith('https://')

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

export type SessionUser = { user: UserRow; sessionId: string }

// Returns the signed-in user, or undefined. Expired rows are deleted on sight
// rather than left to accumulate.
export async function validateSessionToken(token: string): Promise<SessionUser | undefined> {
  if (!token) return undefined
  const id = await hashToken(token)

  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
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

  return { user: row.user, sessionId: id }
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
