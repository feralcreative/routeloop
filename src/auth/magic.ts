// Passwordless sign-in by emailed link.
//
// The token follows the session token exactly — random bytes handed to the user,
// only the SHA-256 hash stored — so a leaked login_tokens table yields nothing
// redeemable. Redemption is single-use and consumed inside the same transaction
// that mints the session, because a forwarded email is otherwise a replayable
// credential.
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import { APP_ORIGIN } from '../config'
import { db } from '../db/index'
import { loginTokens } from '../db/schema'
import { resolveUser } from './identity'
import { sendMail } from './mailer'
import { generateSessionToken, hashToken } from './session'
import type { UserRow } from '../db/schema'
import { allow } from './ratelimit'

const TOKEN_TTL_MS = 15 * 60 * 1000

// Rate limits. Two windows because they stop different things: the per-address
// cap stops someone using the endpoint to repeatedly mail a person they do not
// control, and the per-IP cap stops a single client walking an address list.
const MAX_PER_EMAIL_PER_HOUR = 5
const MAX_PER_IP_PER_HOUR = 20
const HOUR_MS = 60 * 60 * 1000

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase()
  if (!email || email.length > 255) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return email
}

// The per-IP guard now comes from auth/ratelimit.ts. The per-email limit below
// stays database-backed and is the one that actually protects other people's
// inboxes — it has to survive a restart, which an in-memory counter does not.
const ipAllowed = (ip: string): boolean => allow('magic-link', ip, { max: MAX_PER_IP_PER_HOUR, windowMs: HOUR_MS })

async function emailAllowed(email: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(loginTokens)
    .where(and(eq(loginTokens.email, email), gt(loginTokens.createdAt, new Date(Date.now() - HOUR_MS))))
  return (row?.n ?? 0) < MAX_PER_EMAIL_PER_HOUR
}

function linkEmail(url: string): { text: string; html: string } {
  return {
    text: `Sign in to TankBag:\n\n${url}\n\nThis link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.`,
    html: `<p>Sign in to TankBag:</p><p><a href="${url}">Sign in</a></p><p style="color:#666;font-size:14px">This link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.</p>`,
  }
}

/**
 * Issues and sends a link. Returns nothing either way on purpose — the caller
 * must respond identically whether or not the address has an account, or this
 * becomes an oracle for which addresses are registered.
 */
export async function requestMagicLink(email: string, ip: string): Promise<void> {
  if (!ipAllowed(ip) || !(await emailAllowed(email))) {
    console.warn('[magic] rate limited', { email, ip })
    return
  }

  const token = generateSessionToken()
  await db.insert(loginTokens).values({
    id: await hashToken(token),
    email,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  })

  const url = `${APP_ORIGIN}/auth/magic/${token}`
  const { text, html } = linkEmail(url)
  await sendMail(email, 'Your TankBag sign-in link', text, html)
}

export class MagicLinkError extends Error {}

/**
 * Redeems a token and returns the user it signed in. Throws on anything that is
 * not a live, unconsumed, unexpired token.
 */
export async function redeemMagicLink(token: string): Promise<UserRow> {
  const id = await hashToken(token)

  return db.transaction(async (tx) => {
    // The update is the claim: `consumed_at is null` in the WHERE means two
    // simultaneous redemptions cannot both match, so single-use holds without a
    // separate lock.
    const claimed = await tx
      .update(loginTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(loginTokens.id, id), isNull(loginTokens.consumedAt), gt(loginTokens.expiresAt, new Date())))
      .returning()

    if (claimed.length === 0) throw new MagicLinkError('link is invalid, used, or expired')

    // The address is verified by the fact that the token reached the inbox.
    // `tx` is passed so consuming the token and creating the account commit
    // together — without it this opens a second pooled connection while the
    // outer transaction still holds its locks.
    return resolveUser(
      {
        provider: 'email',
        providerUserId: claimed[0].email,
        email: claimed[0].email,
      },
      tx,
    )
  })
}

// Housekeeping, mirroring deleteExpiredSessions.
export async function deleteExpiredLoginTokens(): Promise<void> {
  await db.delete(loginTokens).where(lt(loginTokens.expiresAt, new Date()))
}
