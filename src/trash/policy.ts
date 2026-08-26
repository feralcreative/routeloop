// The rules around the recycle bin: how long the hold is, what state a trashed
// row is in, and whether it can come back.
//
// Pure — arithmetic and branching over plain values, no database — so it is
// testable under the pure-logic rule that governs test/. The queries live in
// ./service.ts, the same split as invites/policy.ts vs service.ts.
//
// This is deliberately GENERIC over what is in the bin. A ride, a saved place
// and a place group all carry the same two timestamps and obey the same hold, so
// the rules take the fields rather than a row type. Only canRestore() knows
// anything ride-shaped, and that is because only a ride costs quota.

/**
 * The hold. Thirty days from the moment something is put in the bin.
 *
 * The same number as DELETION_HOLD_DAYS in account/policy.ts, and — as that file
 * argues about USERNAME_HOLD_DAYS — a coincidence worth not collapsing. They are
 * unrelated promises that happen to be the same length: one is how long a rider
 * has to change their mind about leaving, this is how long a trashed ride waits.
 * Merging them would tie a ride's grace period to an account's.
 */
export const TRASH_HOLD_DAYS = 30

const DAY_MS = 86_400_000

/**
 * When something trashed now becomes eligible for purging.
 *
 * Called on EVERY trash, which is what makes the reset work: taking something
 * out of the bin and putting it back recomputes the deadline from that moment,
 * so there is no separate reset mechanism to write or to forget.
 */
export const purgeDateFor = (deletedAt: Date): Date => new Date(deletedAt.getTime() + TRASH_HOLD_DAYS * DAY_MS)

/** Only the fields the rules read, so a test does not have to build a whole row. */
export type TrashFields = {
  deletedAt: Date | null
  purgeAfter: Date | null
}

export type TrashState =
  /** Not in the bin. The overwhelming majority of rows, and the only ones any
   *  ordinary query should ever see. */
  | 'live'
  /** In the bin, still inside the hold. Restorable. */
  | 'trashed'
  /** The hold has run out. Eligible for the purge whenever it next runs. */
  | 'due'

/**
 * Note what decides 'due': purge_after, not deleted_at plus the constant. The
 * stored deadline is the promise that was made, and changing TRASH_HOLD_DAYS
 * later must not move a date a rider was already shown.
 *
 * A row with deleted_at set but no purge_after is treated as 'trashed' rather
 * than 'due'. That combination should not exist, and guessing "due" would
 * destroy a rider's ride on the strength of a half-written row. Same defensive
 * reading as deletionState() in account/policy.ts, for the same reason.
 */
export function trashState(row: TrashFields, now: Date): TrashState {
  if (!row.deletedAt) return 'live'
  if (!row.purgeAfter) return 'trashed'
  return row.purgeAfter.getTime() <= now.getTime() ? 'due' : 'trashed'
}

/** True whenever the row is in the bin, whether or not the hold has run out. */
export const isTrashed = (row: TrashFields): boolean => row.deletedAt != null

/**
 * Whole days left, rounded up so the last partial day still reads as "1 day"
 * rather than "0 days" to someone deciding whether to restore. Zero once the
 * deadline has passed.
 */
export function daysUntilPurge(row: TrashFields, now: Date): number {
  if (!row.purgeAfter) return TRASH_HOLD_DAYS
  const ms = row.purgeAfter.getTime() - now.getTime()
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS)
}

export type RestoreRefusal = 'not-trashed' | 'over-quota'
export type RestoreCheck = { ok: true } | { ok: false; reason: RestoreRefusal; shortfallBytes: number }

export type RestoreContext = {
  /** The trashed row's own bytes. Zero for a natively built ride, and for a
   *  saved place or a group, neither of which stores a file. */
  sizeBytes: number
  /** The rider's tally, which trashing this row already decremented. */
  usedBytes: number
  quotaBytes: number
  trashed: boolean
}

/**
 * Whether a trashed row can come back.
 *
 * THE QUOTA CHECK IS THE WHOLE POINT. Trashing frees a rider's quota
 * immediately, so a restore is an upload as far as the allowance is concerned —
 * and between the two the rider may well have imported something else with the
 * room they just freed. Letting the restore through anyway would put the account
 * over its limit, which makes the number meaningless; refusing without saying by
 * how much makes it unactionable. Hence the shortfall.
 *
 * A rider refused here is never stuck: trashing something else frees quota, and
 * the thing they want back is still sitting in the bin.
 *
 * NOTE THE `sizeBytes > 0` GUARD, which is not redundant. A rider can already be
 * over their limit without having done anything wrong — the beta lowered the
 * default from 250 MB to 25 MB, and lowering a quota does not shrink what is
 * already stored. Without the guard, such a rider could not restore a saved
 * place or a ride they built in the builder, neither of which costs a byte:
 * refused, for room, for something that needs none. The check is whether this
 * restore takes them over, not whether they are over.
 */
export function canRestore(ctx: RestoreContext): RestoreCheck {
  if (!ctx.trashed) return { ok: false, reason: 'not-trashed', shortfallBytes: 0 }
  if (ctx.sizeBytes <= 0) return { ok: true }
  const over = ctx.usedBytes + ctx.sizeBytes - ctx.quotaBytes
  if (over > 0) return { ok: false, reason: 'over-quota', shortfallBytes: over }
  return { ok: true }
}

export const RESTORE_REFUSAL_MESSAGES: Record<RestoreRefusal, string> = {
  'not-trashed': 'That is not in the bin.',
  'over-quota': 'Restoring this would put you over your storage limit.',
}
