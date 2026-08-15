// The rules around leaving: how long the hold is, what state an account is in,
// and who is allowed to ask.
//
// Pure — arithmetic and branching over plain values, no database — so it is
// testable under the pure-logic rule that governs test/. The queries live in
// ./service.ts and ./purge.ts. Same split as invites/policy.ts vs service.ts.
import type { UserRow } from '../db/schema'

/**
 * The hold. Thirty days, mandatory, with no rider-facing bypass.
 *
 * There is deliberately no "delete now" button. The point of GTFO is
 * portability and respect for a rider's data, not a one-click way to destroy an
 * account someone has broken into — with no bypass, the worst a stolen session
 * can do is hide a rider's rides for a month, and Save Me undoes it.
 *
 * The same number as USERNAME_HOLD_DAYS in auth/username.ts, and that is a
 * coincidence worth not collapsing: they are unrelated promises that happen to
 * be the same length, and merging them would tie a name's cooling-off to an
 * account's grace period.
 */
export const DELETION_HOLD_DAYS = 30

const DAY_MS = 86_400_000

/** When a deletion requested now would become eligible for purging. */
export const purgeDateFor = (requestedAt: Date): Date =>
  new Date(requestedAt.getTime() + DELETION_HOLD_DAYS * DAY_MS)

/** Only the fields the rules read, so a test does not have to build a whole row. */
export type DeletionFields = Pick<UserRow, 'deletionRequestedAt' | 'purgeAfter'>

export type DeletionState =
  /** Not leaving. */
  | 'none'
  /** Asked to leave, still inside the hold. Recoverable by Save Me. */
  | 'scheduled'
  /** The hold has run out. Eligible for the purge whenever it next runs. */
  | 'due'

/**
 * Note what decides 'due': purge_after, not deletion_requested_at plus the
 * constant. The stored deadline is the promise that was made, and changing
 * DELETION_HOLD_DAYS later must not move a date a rider was already shown.
 *
 * A row with deletion_requested_at set but no purge_after is treated as
 * 'scheduled' rather than 'due' — that combination should not exist, and
 * guessing "due" would destroy an account on the strength of a half-written row.
 */
export function deletionState(user: DeletionFields, now: Date): DeletionState {
  if (!user.deletionRequestedAt) return 'none'
  if (!user.purgeAfter) return 'scheduled'
  return user.purgeAfter.getTime() <= now.getTime() ? 'due' : 'scheduled'
}

/** True whenever the rider is on their way out, whether or not the hold has run out. */
export const isLeaving = (user: DeletionFields): boolean => user.deletionRequestedAt != null

/**
 * Whole days left, rounded up so the last partial day still reads as "1 day"
 * rather than "0 days" to someone deciding whether to hit Save Me. Zero once the
 * deadline has passed.
 */
export function daysUntilPurge(user: DeletionFields, now: Date): number {
  if (!user.purgeAfter) return DELETION_HOLD_DAYS
  const ms = user.purgeAfter.getTime() - now.getTime()
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS)
}

export type DeletionRefusal = 'owner' | 'last-manager' | 'already-leaving'
export type DeletionCheck = { ok: true } | { ok: false; reason: DeletionRefusal }

export type DeletionRequestContext = {
  /** Whether this account is the one named by OWNER_EMAIL. */
  isOwner: boolean
  canManageRiders: boolean
  /** Active accounts other than this one that hold can_manage_riders. */
  otherManagerCount: number
  alreadyLeaving: boolean
}

/**
 * Whether this rider may ask to leave.
 *
 * Both refusals are lockout guards, mirroring the self-demotion check in
 * routes/admin.tsx: an app with nobody able to reach /admin cannot approve a
 * rider, cancel a deletion, or stop a purge — including this one.
 */
export function canDeleteAccount(ctx: DeletionRequestContext): DeletionCheck {
  if (ctx.alreadyLeaving) return { ok: false, reason: 'already-leaving' }
  if (ctx.isOwner) return { ok: false, reason: 'owner' }
  if (ctx.canManageRiders && ctx.otherManagerCount === 0) return { ok: false, reason: 'last-manager' }
  return { ok: true }
}

export const REFUSAL_MESSAGES: Record<DeletionRefusal, string> = {
  owner: 'This is the account that runs Routeloop. It cannot delete itself from inside the app.',
  'last-manager':
    'You are the only rider who can manage other riders. Give someone else that access first, or nobody will be able to approve a rider—or undo this.',
  'already-leaving': 'This account is already scheduled for deletion.',
}

/**
 * The confirmation a rider types to start the hold: their own address, exactly.
 *
 * Case and surrounding whitespace are forgiven because neither is a signal of
 * intent — nobody mistypes their address into the right letters in the wrong
 * case by accident. Nothing else is: a partial match, a display name or a
 * username all fail.
 */
export function confirmsDeletion(typed: string, email: string | null): boolean {
  if (!email) return false
  return typed.trim().toLowerCase() === email.trim().toLowerCase()
}
