// The only module that reads or writes the OAuth tables. Every secret handed out
// is stored as its SHA-256, the arrangement `sessions` uses, so a database dump
// holds nothing anybody can present.
import { randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNull, lt } from 'drizzle-orm'
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const newFamily = () => randomBytes(16).toString('hex')

/** A fresh pair in one family, written through the caller's transaction so the
 *  credential that paid for it and the pair it bought commit or fail together. */
async function issueTokens(tx: Tx, clientId: string, userId: number, familyId: string): Promise<Tokens> {
  const access = secret()
  const refresh = secret()
  const now = Date.now()
  await tx.insert(oauthTokens).values([
    {
      tokenHash: await hashToken(access),
      kind: 'access',
      clientId,
      userId,
      familyId,
      expiresAt: new Date(now + ACCESS_TTL_MS),
    },
    {
      tokenHash: await hashToken(refresh),
      kind: 'refresh',
      clientId,
      userId,
      familyId,
      expiresAt: new Date(now + REFRESH_TTL_MS),
    },
  ])
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000 }
}

/**
 * Redeem an authorization code. ONE USE: the row is deleted in the same statement
 * that reads it, so a code replayed after an exchange finds nothing. A code
 * presented with the wrong verifier or client is spent too, which is the rule
 * rather than a side effect: whoever sent it does not hold the verifier. The
 * delete and the new tokens share a transaction, so a failed insert does not burn
 * a code that paid for nothing.
 */
export async function redeemCode(opts: {
  code: string
  clientId: string
  redirectUri: string
  verifier: string
}): Promise<Tokens | null> {
  const codeHash = await hashToken(opts.code)
  return db.transaction(async (tx) => {
    const [row] = await tx.delete(oauthCodes).where(eq(oauthCodes.codeHash, codeHash)).returning()
    if (!row) return null
    if (row.expiresAt.getTime() < Date.now()) return null
    if (row.clientId !== opts.clientId || row.redirectUri !== opts.redirectUri) return null
    if (s256(opts.verifier) !== row.codeChallenge) return null
    return issueTokens(tx, row.clientId, row.userId, newFamily())
  })
}

/**
 * Trade a refresh token for a new pair. ROTATED WITH REPLAY DETECTION: the old
 * token is marked used rather than deleted, and a used one presented again
 * revokes its whole family. Two parties holding one refresh token means one of
 * them stole it, and the server cannot tell which, so both lose the grant and the
 * rider reconnects; deleting the old row instead would let whoever used it first
 * keep a working pair forever.
 */
export async function refresh(token: string, clientId: string): Promise<Tokens | null> {
  const tokenHash = await hashToken(token)
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(oauthTokens)
      .where(and(eq(oauthTokens.tokenHash, tokenHash), eq(oauthTokens.kind, 'refresh')))
      .for('update')
    if (!row) return null
    if (row.usedAt) {
      // A family minted before families existed has none to revoke, so its own
      // client's tokens for this rider go instead.
      await tx
        .delete(oauthTokens)
        .where(
          row.familyId
            ? eq(oauthTokens.familyId, row.familyId)
            : and(eq(oauthTokens.userId, row.userId), eq(oauthTokens.clientId, row.clientId)),
        )
      return null
    }
    if (row.clientId !== clientId || row.expiresAt.getTime() < Date.now()) return null
    const family = row.familyId ?? newFamily()
    await tx.update(oauthTokens).set({ usedAt: new Date(), familyId: family }).where(eq(oauthTokens.id, row.id))
    return issueTokens(tx, row.clientId, row.userId, family)
  })
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
    .where(and(eq(oauthTokens.userId, userId), gt(oauthTokens.expiresAt, new Date()), isNull(oauthTokens.usedAt)))
    .orderBy(desc(oauthTokens.createdAt))
  const seen = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (!seen.has(r.clientId)) seen.set(r.clientId, r)
  return [...seen.values()]
}

export async function revokeApp(userId: number, clientId: string): Promise<void> {
  await db.delete(oauthTokens).where(and(eq(oauthTokens.userId, userId), eq(oauthTokens.clientId, clientId)))
}

let prunedAt = 0

/** Expired codes and tokens, used refresh tokens included once they expire. Swept
 *  from registration and from the token endpoint, at most every ten minutes, so the
 *  tables cannot grow without bound and no sixth timer is needed. */
export async function pruneExpired(): Promise<void> {
  if (Date.now() - prunedAt < 10 * 60 * 1000) return
  prunedAt = Date.now()
  const now = new Date()
  await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, now))
  await db.delete(oauthTokens).where(lt(oauthTokens.expiresAt, now))
}
