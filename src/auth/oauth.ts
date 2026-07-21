// Arctic OAuth clients plus the user-resolution rule shared by both providers.
//
// Lucia is no longer a library — it is documentation pointing at Arctic — so the
// state check, the PKCE verifier, and the account-linking decision all live in
// our own code, where they can be read and reviewed.
import * as arctic from 'arctic'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index'
import { users, userIdentities, type UserRow } from '../db/schema'

export const APP_ORIGIN = process.env.APP_ORIGIN ?? 'http://127.0.0.1:6686'

export type Provider = 'google' | 'github'

export const callbackUrl = (p: Provider): string => `${APP_ORIGIN}/auth/${p}/callback`

// Missing credentials must not crash the whole app — the rest of tankbag is
// public and has to keep serving. Each provider is simply offered only when it
// is configured.
function client<T>(id: string | undefined, secret: string | undefined, make: (i: string, s: string) => T): T | null {
  return id && secret ? make(id, secret) : null
}

export const google = client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  (i, s) => new arctic.Google(i, s, callbackUrl('google')),
)

export const github = client(
  process.env.GITHUB_CLIENT_ID,
  process.env.GITHUB_CLIENT_SECRET,
  (i, s) => new arctic.GitHub(i, s, callbackUrl('github')),
)

export const enabledProviders = (): Provider[] => {
  const out: Provider[] = []
  if (google) out.push('google')
  if (github) out.push('github')
  return out
}

export type ProviderProfile = {
  provider: Provider
  providerUserId: string
  email: string | null
  emailVerified: boolean
  displayName: string
  avatarUrl: string | null
}

/**
 * Resolve a provider profile to a tankbag user.
 *
 * 1. Known identity wins outright — that is this person, whatever the email now
 *    says.
 * 2. Otherwise a *verified* email matching an existing user attaches a new
 *    identity to that user, so Google-you and GitHub-you are one account.
 * 3. Otherwise a new user is created. An unverified email is deliberately not
 *    written to `users.email`: trusting it would let someone claim an address
 *    they do not own, and it would collide with the unique index besides.
 */
export async function resolveUser(p: ProviderProfile): Promise<UserRow> {
  const [existing] = await db
    .select({ user: users })
    .from(userIdentities)
    .innerJoin(users, eq(userIdentities.userId, users.id))
    .where(and(eq(userIdentities.provider, p.provider), eq(userIdentities.providerUserId, p.providerUserId)))
    .limit(1)

  if (existing) {
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, existing.user.id))
    return existing.user
  }

  return db.transaction(async (tx) => {
    if (p.email && p.emailVerified) {
      const [match] = await tx.select().from(users).where(eq(users.email, p.email)).limit(1)
      if (match) {
        await tx.insert(userIdentities).values({
          userId: match.id,
          provider: p.provider,
          providerUserId: p.providerUserId,
          providerEmail: p.email,
        })
        await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, match.id))
        return match
      }
    }

    const [created] = await tx
      .insert(users)
      .values({
        email: p.email && p.emailVerified ? p.email : null,
        displayName: p.displayName || 'Rider',
        avatarUrl: p.avatarUrl,
        lastLoginAt: new Date(),
      })
      .returning()

    await tx.insert(userIdentities).values({
      userId: created.id,
      provider: p.provider,
      providerUserId: p.providerUserId,
      providerEmail: p.email,
    })

    return created
  })
}

// --- Provider profile fetching -------------------------------------------

type GoogleClaims = {
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
}

export function googleProfile(idToken: string): ProviderProfile {
  const claims = arctic.decodeIdToken(idToken) as GoogleClaims
  return {
    provider: 'google',
    providerUserId: claims.sub,
    email: claims.email ?? null,
    emailVerified: claims.email_verified === true,
    displayName: claims.name ?? claims.email ?? 'Rider',
    avatarUrl: claims.picture ?? null,
  }
}

// GitHub has no ID token, and the profile endpoint's `email` is only the public
// one — often null. The verified address comes from /user/emails.
export async function githubProfile(accessToken: string): Promise<ProviderProfile> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'tankbag',
  }

  const res = await fetch('https://api.github.com/user', { headers })
  if (!res.ok) throw new Error(`GitHub /user failed: ${res.status}`)
  const u = (await res.json()) as { id: number; login: string; name?: string; avatar_url?: string }

  let email: string | null = null
  let emailVerified = false
  const emailsRes = await fetch('https://api.github.com/user/emails', { headers })
  if (emailsRes.ok) {
    const list = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[]
    const primary = list.find((e) => e.primary && e.verified) ?? list.find((e) => e.verified)
    if (primary) {
      email = primary.email
      emailVerified = true
    }
  }

  return {
    provider: 'github',
    providerUserId: String(u.id),
    email,
    emailVerified,
    displayName: u.name || u.login,
    avatarUrl: u.avatar_url ?? null,
  }
}
