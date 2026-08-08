// What an invite is allowed to do, as pure functions.
//
// Same split as src/emails/rules.ts, and for the same reason: the rule and the
// race guard are different jobs and neither substitutes for the other.
//
//   this file  — the RULE. Readable, enumerable, and asserted as a table in
//                test/invite-policy.test.ts.
//   the SQL    — the CLAIM. Conditional UPDATE ... RETURNING in service.ts, so
//                two riders taking the last seat cannot both win.
//
// Everything here is a function of its arguments and nothing else, which is what
// lets the test import it with no database. Nothing that reads a table belongs
// in this file.
import type { UserStatus } from '../db/schema'

/** The token as it appears in a URL: 24 random bytes, hex. Same shape as a session token. */
export const TOKEN_HEX_LENGTH = 48

export type InviteKind = 'email' | 'link' | 'group'

/**
 * Why an invite will not be honoured, or `ok`.
 *
 * Ordered by how the rider should hear it. An expired invite that is also full
 * reads better as "expired" — that is the fact they can do something about, by
 * asking for another one.
 */
export type InviteLiveness = 'ok' | 'revoked' | 'expired' | 'exhausted'

/** The subset of an invite row these rules need. Deliberately not InviteRow — a
 *  narrower argument is what keeps this callable from a test with no database. */
export type InviteState = {
  maxUses: number
  usedCount: number
  revokedAt: Date | null
  expiresAt: Date
}

export function seatsLeft(inv: InviteState): number {
  return Math.max(0, inv.maxUses - inv.usedCount)
}

export function inviteStatus(inv: InviteState, now: Date): InviteLiveness {
  if (inv.revokedAt !== null) return 'revoked'
  // <= rather than <: an invite expiring exactly now is expired. The boundary
  // has to match the SQL, which uses `expires_at > now()`.
  if (inv.expiresAt.getTime() <= now.getTime()) return 'expired'
  if (seatsLeft(inv) === 0) return 'exhausted'
  return 'ok'
}

/**
 * The token as it arrives, cleaned up, or null if it cannot be one.
 *
 * Not defensive programming for its own sake. A link pasted into Discord comes
 * back with a trailing `)` from someone's parenthetical, mail clients swallow
 * and append punctuation around URLs, and a token read aloud and retyped arrives
 * in the wrong case. Every one of those is a rider who was invited and cannot
 * get in, which is the most expensive failure this feature has.
 *
 * Strict about length on purpose: anything that is not exactly 48 hex characters
 * is not a token this app issued, and guessing at a truncated one would turn a
 * clear "that link is not valid" into a lookup that quietly finds nothing.
 */
export function normalizeInviteToken(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase().replace(/[^0-9a-f]/g, '')
  return cleaned.length === TOKEN_HEX_LENGTH ? cleaned : null
}

export function inviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/i/${token}`
}

// --- Grants ------------------------------------------------------------------

export type Grants = { grantsBeta: boolean; grantsSurvey: boolean }

/** What redeeming would actually CHANGE for this rider — not what the invite offers. */
export type GrantPlan = { beta: boolean; survey: boolean }

/** The subset of a user row these rules need. */
export type GranteeState = { status: UserStatus; surveyInvitedAt: Date | null }

/**
 * What this invite would change for this rider, if anything.
 *
 * Two rules live here, and they are the reason this is a function rather than a
 * pair of `if`s at the call site.
 *
 * **A blocked rider is never let back in by an invite.** /admin reinstates with
 * `ne(status, 'active')` because reinstatement is a transition a manager chooses
 * deliberately. An invite must never offer it — otherwise someone who was
 * blocked clicks the link still sitting in the Discord channel and un-blocks
 * themselves. Only `pending` is upgraded.
 *
 * **An invite that changes nothing does not spend a seat.** Seats are a budget
 * for letting new people in. An already-active member opening a group link out
 * of curiosity would otherwise burn one, and a 25-seat link pasted into a
 * channel of 40 riders who mostly already have accounts would be exhausted by
 * people who gained nothing from it. That is the group link quietly failing.
 */
export function plannedGrants(invite: Grants, user: GranteeState): GrantPlan {
  return {
    beta: invite.grantsBeta && user.status === 'pending',
    survey: invite.grantsSurvey && user.surveyInvitedAt === null,
  }
}

export function consumesSeat(plan: GrantPlan): boolean {
  return plan.beta || plan.survey
}

/** For the admin list. Order is fixed so two invites with the same grants read the same. */
export function grantsLabel(g: Grants): string {
  const parts = [g.grantsBeta ? 'beta' : '', g.grantsSurvey ? 'survey' : ''].filter(Boolean)
  // The check constraint on the table makes this unreachable from a stored row.
  // It is here because this function is also called on a half-filled create form.
  return parts.length ? parts.join(' + ') : 'nothing'
}
