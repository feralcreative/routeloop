// Turning a verified identity into a local user, for every provider.
//
// Generalized from the Cloudflare Access version this replaces. The behavior it
// preserves matters more than the shape: link to an existing verified-email user
// where one exists so ride ownership survives, create as 'pending' otherwise,
// and never demote an account that already exists.
//
// Authentication happens before this function is called. Authorization is
// users.status, which this sets once and then leaves alone.
import { and, eq } from 'drizzle-orm'
import { OWNER_EMAIL } from '../config'
import { db } from '../db/index'
import { userIdentities, users, type UserRow } from '../db/schema'

export type Provider = 'google' | 'email'

// Callers that are already inside a transaction must hand theirs in. Opening a
// nested one would take a second pooled connection while the outer transaction
// still holds its locks — which breaks the atomicity the magic-link redemption
// depends on, and can deadlock outright once the pool is busy.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type Executor = typeof db | Tx

export type VerifiedIdentity = {
  provider: Provider
  /** Stable id from the provider — Google's `sub`, or the address itself for a
   *  magic link, which is the only identifier that flow has. */
  providerUserId: string
  /** Already verified by the provider. Callers must not pass an unverified one. */
  email: string
  displayName?: string
}

function displayNameFromEmail(email: string): string {
  const local = email.slice(0, email.indexOf('@')).replace(/[._-]+/g, ' ').trim()
  return local ? local.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Rider'
}

export async function resolveUser(identity: VerifiedIdentity, exec?: Executor): Promise<UserRow> {
  const email = identity.email.trim().toLowerCase()
  const displayName = identity.displayName?.trim() || displayNameFromEmail(email)
  const read = exec ?? db

  // Returning user on this exact provider — the common path.
  const [existing] = await read
    .select({ user: users })
    .from(userIdentities)
    .innerJoin(users, eq(userIdentities.userId, users.id))
    .where(
      and(
        eq(userIdentities.provider, identity.provider),
        eq(userIdentities.providerUserId, identity.providerUserId),
      ),
    )
    .limit(1)

  if (existing) {
    await read.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, existing.user.id))
    return existing.user
  }

  const create = async (tx: Executor): Promise<UserRow> => {
    // Same person arriving by a second method. Both providers verify the address
    // before we get here, so matching on it is safe and is what lets someone use
    // Google one day and a magic link the next without splitting their rides
    // across two accounts.
    const [match] = await tx.select().from(users).where(eq(users.email, email)).limit(1)

    const user =
      match ??
      (
        await tx
          .insert(users)
          .values({
            email,
            displayName,
            // The only account never left waiting, and the one that does the
            // waiting-list clearing: the owner lands active AND able to manage
            // riders, so /admin has a way in from the very first login. Everyone
            // else is approved by hand — the NAS capacity gate, not a policy.
            status: email === OWNER_EMAIL ? 'active' : 'pending',
            canManageRiders: email === OWNER_EMAIL,
            lastLoginAt: new Date(),
          })
          .returning()
      )[0]

    await tx.insert(userIdentities).values({
      userId: user.id,
      provider: identity.provider,
      providerUserId: identity.providerUserId,
      providerEmail: email,
    })

    // Deliberately only lastLoginAt: an existing user's status, display name and
    // profile are theirs, and a new login method must not overwrite them.
    if (match) await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, match.id))

    return user
  }

  // Borrow the caller's transaction when there is one; otherwise own it, so the
  // user row and its identity row still land together.
  return exec ? create(exec) : db.transaction(create)
}
