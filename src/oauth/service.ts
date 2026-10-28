// The only module that reads or writes the OAuth tables. Every secret handed out
// is stored as its SHA-256, the arrangement `sessions` uses, so a database dump
// holds nothing anybody can present.
import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, lt } from 'drizzle-orm'
import { db } from '../db/index'
import { oauthClients, oauthCodes, oauthTokens, users, type UserRow } from '../db/schema'
import { hashToken } from '../auth/session'
import { ACCESS_TTL_MS, CODE_TTL_MS, REFRESH_TTL_MS, s256 } from './policy'

const secret = () => randomBytes(32).toString('base64url')

export async function registerClient(name: string, redirectUris: string[]): Promise<string> {
  const id = 'rlc_' + randomBytes(16).toString('hex')
  await db.insert(oauthClients).values({ id, name: name.slice(0, 120), redirectUris })
  return id
}

export async function clientById(id: string) {
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, id)).limit(1)
  return row ?? null
}

export async function issueCode(
  clientId: string,
  userId: number,
  redirectUri: string,
  codeChallenge: string,
): Promise<string> {
  const code = secret()
  await db.insert(oauthCodes).values({
    codeHash: await hashToken(code),
    clientId,
    userId,
    redirectUri,
    codeChallenge,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  })
  return code
}

export type Tokens = { access_token: string; refresh_token: string; token_type: 'Bearer'; expires_in: number }

async function issueTokens(clientId: string, userId: number): Promise<Tokens> {
  const access = secret()
  const refresh = secret()
  const now = Date.now()
  await db.insert(oauthTokens).values([
    { tokenHash: await hashToken(access), kind: 'access', clientId, userId, expiresAt: new Date(now + ACCESS_TTL_MS) },
    {
      tokenHash: await hashToken(refresh),
      kind: 'refresh',
      clientId,
      userId,
      expiresAt: new Date(now + REFRESH_TTL_MS),
    },
  ])
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000 }
}

/**
 * Redeem an authorization code. ONE USE: the row is deleted in the same statement
 * that reads it, so a code replayed after a successful exchange finds nothing.
 */
export async function redeemCode(opts: {
  code: string
  clientId: string
  redirectUri: string
  verifier: string
}): Promise<Tokens | null> {
  const [row] = await db
    .delete(oauthCodes)
    .where(eq(oauthCodes.codeHash, await hashToken(opts.code)))
    .returning()
  if (!row) return null
  if (row.expiresAt.getTime() < Date.now()) return null
  if (row.clientId !== opts.clientId || row.redirectUri !== opts.redirectUri) return null
  if (s256(opts.verifier) !== row.codeChallenge) return null
  return issueTokens(row.clientId, row.userId)
}

/** Trade a refresh token for a new pair. ROTATED: the old one is deleted, so a
 *  stolen refresh token stops working the first time either party uses it. */
export async function refresh(token: string, clientId: string): Promise<Tokens | null> {
  const [row] = await db
    .delete(oauthTokens)
    .where(and(eq(oauthTokens.tokenHash, await hashToken(token)), eq(oauthTokens.kind, 'refresh')))
    .returning()
  if (!row || row.clientId !== clientId || row.expiresAt.getTime() < Date.now()) return null
  return issueTokens(row.clientId, row.userId)
}

/** The rider an access token acts as, or null. Only an ACTIVE account passes, the
 *  same gate requireActiveApi applies to a session. */
export async function userForAccessToken(token: string): Promise<UserRow | null> {
  const hash = await hashToken(token)
  const [row] = await db
    .select({ user: users, id: oauthTokens.id })
    .from(oauthTokens)
    .innerJoin(users, eq(users.id, oauthTokens.userId))
    .where(and(eq(oauthTokens.tokenHash, hash), eq(oauthTokens.kind, 'access'), gt(oauthTokens.expiresAt, new Date())))
    .limit(1)
  if (!row || row.user.status !== 'active' || row.user.purgeAfter) return null
  void db
    .update(oauthTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(oauthTokens.id, row.id))
    .catch(() => {})
  return row.user
}

/** The apps a rider has connected, for the Preferences list. One row per client. */
export async function connectedApps(userId: number) {
  const rows = await db
    .select({
      clientId: oauthTokens.clientId,
      name: oauthClients.name,
      lastUsedAt: oauthTokens.lastUsedAt,
      createdAt: oauthTokens.createdAt,
    })
    .from(oauthTokens)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthTokens.clientId))
    .where(and(eq(oauthTokens.userId, userId), gt(oauthTokens.expiresAt, new Date())))
    .orderBy(desc(oauthTokens.createdAt))
  const seen = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (!seen.has(r.clientId)) seen.set(r.clientId, r)
  return [...seen.values()]
}

export async function revokeApp(userId: number, clientId: string): Promise<void> {
  await db.delete(oauthTokens).where(and(eq(oauthTokens.userId, userId), eq(oauthTokens.clientId, clientId)))
}

/** Expired codes and tokens, swept on registration so the tables cannot grow
 *  without bound and no sixth timer is needed. */
export async function pruneExpired(): Promise<void> {
  const now = new Date()
  await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, now))
  await db.delete(oauthTokens).where(lt(oauthTokens.expiresAt, now))
}
