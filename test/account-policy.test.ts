// The rules around leaving.
//
// The boundary cases are the ones that matter: 'due' is what makes a purge
// eligible to run, so getting the comparison wrong by one tick either strands an
// account forever or destroys one a day early.
//
// The refusal guards matter for a different reason. Both exist to stop the app
// reaching a state where nobody can open /admin — which would mean nobody can
// approve a rider, cancel a deletion, or stop the purge that caused it.
import { describe, expect, it } from 'vitest'
import {
  canDeleteAccount,
  confirmsDeletion,
  daysUntilPurge,
  deletionState,
  DELETION_HOLD_DAYS,
  isLeaving,
  purgeDateFor,
  type DeletionFields,
} from '../src/account/policy'

const NOW = new Date('2026-08-15T12:00:00.000Z')
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000)

const fields = (over: Partial<DeletionFields> = {}): DeletionFields => ({
  deletionRequestedAt: null,
  purgeAfter: null,
  ...over,
})

describe('purgeDateFor', () => {
  it('is the hold, in days, after the request', () => {
    expect(purgeDateFor(NOW).toISOString()).toBe(day(DELETION_HOLD_DAYS).toISOString())
  })

  it('keeps the time of day, so the deadline is a moment and not a date', () => {
    expect(purgeDateFor(NOW).getUTCHours()).toBe(NOW.getUTCHours())
  })
})

describe('deletionState', () => {
  it('is none for an account that has not asked', () => {
    expect(deletionState(fields(), NOW)).toBe('none')
    expect(isLeaving(fields())).toBe(false)
  })

  it('is scheduled inside the hold', () => {
    const u = fields({ deletionRequestedAt: NOW, purgeAfter: day(DELETION_HOLD_DAYS) })
    expect(deletionState(u, NOW)).toBe('scheduled')
    expect(deletionState(u, day(29))).toBe('scheduled')
    expect(isLeaving(u)).toBe(true)
  })

  it('is due once the deadline has passed', () => {
    const u = fields({ deletionRequestedAt: NOW, purgeAfter: day(DELETION_HOLD_DAYS) })
    expect(deletionState(u, day(31))).toBe('due')
  })

  // The boundary. Exactly-at-the-deadline counts as due; one tick before does not.
  it('treats the deadline itself as due, and the tick before it as not', () => {
    const purgeAfter = day(DELETION_HOLD_DAYS)
    const u = fields({ deletionRequestedAt: NOW, purgeAfter })

    expect(deletionState(u, purgeAfter)).toBe('due')
    expect(deletionState(u, new Date(purgeAfter.getTime() - 1))).toBe('scheduled')
    expect(deletionState(u, new Date(purgeAfter.getTime() + 1))).toBe('due')
  })

  // A row should never look like this. Reading it as 'due' would destroy an
  // account on the strength of a half-written row, so it reads as scheduled.
  it('refuses to call a row due when it carries no deadline', () => {
    expect(deletionState(fields({ deletionRequestedAt: NOW }), day(365))).toBe('scheduled')
  })

  // purge_after is the promise that was made. Reading the state from
  // requested_at plus the constant would let a later change to
  // DELETION_HOLD_DAYS move a date a rider was already shown.
  it('reads the stored deadline rather than recomputing it', () => {
    const u = fields({ deletionRequestedAt: NOW, purgeAfter: day(90) })
    expect(deletionState(u, day(31))).toBe('scheduled')
  })
})

describe('daysUntilPurge', () => {
  it('counts whole days left', () => {
    const u = fields({ deletionRequestedAt: NOW, purgeAfter: day(DELETION_HOLD_DAYS) })
    expect(daysUntilPurge(u, NOW)).toBe(30)
    expect(daysUntilPurge(u, day(29))).toBe(1)
  })

  // Rounds up, so the last partial day reads as "1 day" to someone deciding
  // whether to hit Save Me rather than as "0 days".
  it('rounds a part-day up', () => {
    const purgeAfter = day(DELETION_HOLD_DAYS)
    const u = fields({ deletionRequestedAt: NOW, purgeAfter })
    expect(daysUntilPurge(u, new Date(purgeAfter.getTime() - 3600_000))).toBe(1)
  })

  it('is zero once the deadline has passed', () => {
    const u = fields({ deletionRequestedAt: NOW, purgeAfter: day(DELETION_HOLD_DAYS) })
    expect(daysUntilPurge(u, day(31))).toBe(0)
    expect(daysUntilPurge(u, day(DELETION_HOLD_DAYS))).toBe(0)
  })
})

describe('canDeleteAccount', () => {
  const ctx = (over = {}) => ({
    isOwner: false,
    canManageRiders: false,
    otherManagerCount: 0,
    alreadyLeaving: false,
    ...over,
  })

  it('lets an ordinary rider leave', () => {
    expect(canDeleteAccount(ctx())).toEqual({ ok: true })
  })

  it('refuses the owner account', () => {
    expect(canDeleteAccount(ctx({ isOwner: true }))).toEqual({ ok: false, reason: 'owner' })
  })

  // Without this the app can reach a state where /admin is unreachable — so
  // nobody can approve a rider, and nobody can cancel this very deletion.
  it('refuses the last remaining manager', () => {
    expect(canDeleteAccount(ctx({ canManageRiders: true, otherManagerCount: 0 }))).toEqual({
      ok: false,
      reason: 'last-manager',
    })
  })

  it('lets a manager leave when another one remains', () => {
    expect(canDeleteAccount(ctx({ canManageRiders: true, otherManagerCount: 1 }))).toEqual({ ok: true })
  })

  it('refuses a second request from an account already on its way out', () => {
    expect(canDeleteAccount(ctx({ alreadyLeaving: true }))).toEqual({ ok: false, reason: 'already-leaving' })
  })

  // Ordering: an owner who is also the last manager is refused once, and the
  // already-leaving check comes first so a repeat request never reports the
  // wrong reason.
  it('reports already-leaving ahead of the other refusals', () => {
    expect(canDeleteAccount(ctx({ alreadyLeaving: true, isOwner: true }))).toEqual({
      ok: false,
      reason: 'already-leaving',
    })
  })
})

describe('confirmsDeletion', () => {
  it('accepts the address exactly', () => {
    expect(confirmsDeletion('rider@example.com', 'rider@example.com')).toBe(true)
  })

  // Neither case nor stray whitespace signals intent — nobody mistypes their
  // address into the right letters in the wrong case.
  it('forgives case and surrounding whitespace', () => {
    expect(confirmsDeletion('  Rider@Example.COM ', 'rider@example.com')).toBe(true)
  })

  it('rejects anything short of the whole address', () => {
    for (const typed of ['rider', 'rider@example', '@example.com', 'example.com', '', 'delete']) {
      expect(confirmsDeletion(typed, 'rider@example.com'), typed).toBe(false)
    }
  })

  it('rejects a different address', () => {
    expect(confirmsDeletion('someone@example.com', 'rider@example.com')).toBe(false)
  })

  // users.email is nullable, and an account with no address has no way to
  // confirm — which must fail closed rather than accept an empty string.
  it('cannot be confirmed by an account with no email', () => {
    expect(confirmsDeletion('', null)).toBe(false)
    expect(confirmsDeletion('anything', null)).toBe(false)
  })
})
