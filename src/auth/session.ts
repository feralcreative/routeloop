// Server sessions, hand-rolled per the current Lucia/Copenhagen Book guidance.
//
// The browser gets a random token. The database stores only its SHA-256 hash,
// so a database leak yields no usable cookies. Web Crypto rather than
// node:crypto keeps this portable to Cloudflare Workers later.
import { eq, lt, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { IS_HTTPS_ORIGIN } from '../config'
import { db } from '../db/index'
import { notifications, sessions, userProfiles, users, type UserRow } from '../db/schema'
import { type Scheme, type Theme, toScheme, toTheme } from '../views/appearance'
import { type Motion, toMotion } from '../views/motion'
import { type Clock, toClock } from '../views/clock'
import { type Tips, toTips } from '../views/tips'
import { type DateFormat, toDateFormat } from '../views/date-format'

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
 * The signed-in rider, plus the display values the shell needs.
 *
 * `theme`, `scheme` and `motion` are widened onto the user rather than returned
 * beside it because `page()` takes a user and nothing else that could carry
 * them. They are DISPLAY values and belong to no table row on their own —
 * `user_profiles` holds them, `users` does not — which is why this is a composed
 * type rather than a change to UserRow.
 *
 * `dateFormat` AND `clock` JOINED THEM ON 2026-09-07 (#270), for the same reason
 * and to answer a new one: the CLIENT formats times too, and it was calling
 * `toLocaleTimeString(undefined, …)` — the BROWSER's locale, not the rider's
 * choice. So a rider who asked for a 24-hour clock got one in the printed
 * roadbook and not in the builder. Stamping both on <html> is what lets the
 * three client formatters read the same answer the server used.
 *
 * `tips` JOINED THEM ON 2026-09-10 (#133) for the second of those reasons and
 * not the first: nothing on the server renders differently for it. It reaches
 * <html> so `public/js/tips.js` can read one answer on every page, including
 * the builder, whose controls are strings assembled in the browser.
 */
export type SessionUser = {
  user: UserRow & {
    theme: Theme
    scheme: Scheme
    motion: Motion
    dateFormat: DateFormat
    clock: Clock
    tips: Tips
    /** Null until the guided tour has been finished or skipped once (#133). */
    tourDoneAt: Date | null
    /** Whether the header's Take the tour sign is hidden, from /settings. */
    hideTour: boolean
    /** The ride the guided tour is building, or null. Stamped on <html> so
     *  tour.js can tell a saved tour position from a stale one. */
    tourRideId: number | null
    avatarBytes: number
    /** Unread notifications, for the badge on the account chip. */
    unread: number
  }
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
      dateFormat: userProfiles.dateFormat,
      clock: userProfiles.clock,
      tips: userProfiles.tips,
      tourDoneAt: userProfiles.tourDoneAt,
      hideTour: userProfiles.hideTour,
      tourRideId: userProfiles.tourRideId,
      avatarBytes: userProfiles.avatarBytes,
      // THE UNREAD COUNT RIDES ALONG HERE FOR THE REASON THE APPEARANCE COLUMNS
      // DO, one paragraph up: the badge is on the account chip, which is on
      // every page, and page() is synchronous and called from dozens of places.
      // Threading a count through all of them works until somebody adds one more
      // and forgets — and a missed call site is not a visible bug, it is a rider
      // who is never told anything happened.
      //
      // A CORRELATED SUBQUERY RATHER THAN A JOIN: a left join to `notifications`
      // multiplies the session row by every notification and would need a GROUP
      // BY over the whole select list. This is one indexed count on a query that
      // already runs once per request, and `idx_notifications_unread` is the
      // partial index that serves exactly this predicate.
      unread: sql<number>`(
        select count(*)::int from ${notifications}
        where ${notifications.userId} = ${users.id} and ${notifications.readAt} is null
      )`,
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
      dateFormat: toDateFormat(row.dateFormat),
      clock: toClock(row.clock),
      // NOTE THE COERCER'S DEFAULT IS `on` HERE, WHICH IS THE ONE PLACE IN THIS
      // BLOCK WHERE A NULL IS NOT "the column default a rider would have
      // chosen". A rider with no profile row has never been asked, and #133 is
      // for exactly that rider — see src/views/tips.ts.
      tips: toTips(row.tips),
      // NOT COERCED, because null is the answer here and not a gap: it is what
      // makes the tour run on its own the first time the builder opens.
      tourDoneAt: row.tourDoneAt ?? null,
      // Null is the no-row case and means the column default: the sign shows.
      hideTour: row.hideTour ?? false,
      tourRideId: row.tourRideId ?? null,
      // THE UPLOAD WINS OVER THE PROVIDER PICTURE when both exist (#99).
      // `users.avatar_url` is write-once from Google sign-in and a rider cannot
      // change it; an upload is a deliberate choice and outranks it. Zero means
      // no upload, which is what makes the column the flag as well as the size.
      avatarBytes: row.avatarBytes ?? 0,
      unread: row.unread ?? 0,
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
