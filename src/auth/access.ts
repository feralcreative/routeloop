// Cloudflare Access authenticates at the edge. routeloop turns that identity into
// its existing local user + session so public pages remain public and private
// ride ownership continues to work throughout the app.
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { OWNER_EMAIL } from '../config'
import { db } from '../db/index'
import { userIdentities, users, type UserRow } from '../db/schema'

export const APP_ORIGIN = process.env.APP_ORIGIN ?? 'http://127.0.0.1:6686'
export const ACCESS_EMAIL_HEADER = 'Cf-Access-Authenticated-User-Email'

const IS_PRODUCTION_ORIGIN = APP_ORIGIN.startsWith('https://')

// Local development does not pass through Cloudflare. The explicit dev value
// is ignored on HTTPS origins so it can never impersonate a production user.
export function accessEmail(c: Context): string | null {
  const raw = c.req.header(ACCESS_EMAIL_HEADER) || (!IS_PRODUCTION_ORIGIN ? process.env.DEV_AUTH_EMAIL : '') || ''
  const email = raw.trim().toLowerCase()
  if (!email || email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return email
}

function displayNameFromEmail(email: string): string {
  const local = email.slice(0, email.indexOf('@')).replace(/[._-]+/g, ' ').trim()
  return local ? local.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Rider'
}

// The Access policy has verified this address, but it no longer *authorizes* it:
// the policy admits any Google account, so authorization is users.status and a
// brand-new account starts 'pending'. Link to an existing verified-email user
// where possible so the migration preserves ride ownership; otherwise create a
// new local account.
//
// Only the insert below sets status. The link-by-email branch deliberately
// leaves it alone — an existing rider must not be demoted to pending by signing
// in again.
export async function resolveAccessUser(email: string): Promise<UserRow> {
  const [identity] = await db
    .select({ user: users })
    .from(userIdentities)
    .innerJoin(users, eq(userIdentities.userId, users.id))
    .where(and(eq(userIdentities.provider, 'cloudflare'), eq(userIdentities.providerUserId, email)))
    .limit(1)

  if (identity) {
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, identity.user.id))
    return identity.user
  }

  return db.transaction(async (tx) => {
    const [match] = await tx.select().from(users).where(eq(users.email, email)).limit(1)
    const user =
      match ??
      (
        await tx
          .insert(users)
          .values({
            email,
            displayName: displayNameFromEmail(email),
            status: email === OWNER_EMAIL ? 'active' : 'pending',
            lastLoginAt: new Date(),
          })
          .returning()
      )[0]

    await tx.insert(userIdentities).values({
      userId: user.id,
      provider: 'cloudflare',
      providerUserId: email,
      providerEmail: email,
    })
    if (match) await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, match.id))
    return user
  })
}

// Production is strict. In development, Mapbox requires localhost while the
// configured origin may use 127.0.0.1, so accept both names on the same port.
const ALLOWED_ORIGINS: ReadonlySet<string> = (() => {
  const set = new Set<string>([APP_ORIGIN])
  if (!IS_PRODUCTION_ORIGIN) {
    try {
      const port = new URL(APP_ORIGIN).port
      const suffix = port ? `:${port}` : ''
      set.add(`http://localhost${suffix}`)
      set.add(`http://127.0.0.1${suffix}`)
    } catch {
      // An invalid APP_ORIGIN falls back to exact matching only.
    }
  }
  return set
})()

export function isAllowedOrigin(origin: string | undefined | null): boolean {
  return origin != null && ALLOWED_ORIGINS.has(origin)
}
