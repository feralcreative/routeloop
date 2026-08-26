// The rules around the recycle bin.
//
// The boundary cases are the ones that matter, for the same reason they do in
// account-policy.test.ts: 'due' is what makes a purge eligible to run, so a
// comparison wrong by one tick either strands a ride in the bin forever or
// destroys one a day early.
//
// The quota case matters for a different reason. Trashing frees a rider's
// allowance immediately, so a restore spends it again — and if canRestore lets
// through a restore there is no room for, the account goes over its limit with
// nothing to say so.
import { describe, expect, it } from 'vitest'
import {
  canRestore,
  daysUntilPurge,
  isTrashed,
  purgeDateFor,
  TRASH_HOLD_DAYS,
  trashState,
  type RestoreContext,
  type TrashFields,
} from '../src/trash/policy'

const NOW = new Date('2026-08-26T12:00:00.000Z')
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000)

const fields = (over: Partial<TrashFields> = {}): TrashFields => ({
  deletedAt: null,
  purgeAfter: null,
  ...over,
})

const MB = 1024 * 1024
const ctx = (over: Partial<RestoreContext> = {}): RestoreContext => ({
  sizeBytes: 0,
  usedBytes: 0,
  quotaBytes: 100 * MB,
  trashed: true,
  ...over,
})

describe('purgeDateFor', () => {
  it('is the hold, in days, after the row was binned', () => {
    expect(purgeDateFor(NOW).toISOString()).toBe(day(TRASH_HOLD_DAYS).toISOString())
  })

  it('keeps the time of day, so the deadline is a moment and not a date', () => {
    expect(purgeDateFor(NOW).getUTCHours()).toBe(NOW.getUTCHours())
  })

  // This is the reset, and it is worth pinning because there is no other code
  // implementing it: re-trashing simply calls this again.
  it('resets in full when something is binned a second time', () => {
    const first = purgeDateFor(NOW)
    const second = purgeDateFor(day(29))
    expect(second.getTime() - first.getTime()).toBe(29 * 86_400_000)
    expect(daysUntilPurge({ deletedAt: day(29), purgeAfter: second }, day(29))).toBe(TRASH_HOLD_DAYS)
  })
})

describe('trashState', () => {
  it('is live when nothing has binned it', () => {
    expect(trashState(fields(), NOW)).toBe('live')
  })

  it('is trashed inside the hold', () => {
    expect(trashState(fields({ deletedAt: day(-1), purgeAfter: day(29) }), NOW)).toBe('trashed')
  })

  it('is due once the deadline has passed', () => {
    expect(trashState(fields({ deletedAt: day(-31), purgeAfter: day(-1) }), NOW)).toBe('due')
  })

  it('is due exactly on the deadline, not a tick after', () => {
    expect(trashState(fields({ deletedAt: day(-30), purgeAfter: NOW }), NOW)).toBe('due')
    expect(trashState(fields({ deletedAt: day(-30), purgeAfter: new Date(NOW.getTime() + 1) }), NOW)).toBe('trashed')
  })

  // A half-written row must never be read as permission to destroy something.
  it('refuses to call a row with no deadline due', () => {
    expect(trashState(fields({ deletedAt: day(-999) }), NOW)).toBe('trashed')
  })

  it('reads deleted_at alone, so a stale deadline on a live row is ignored', () => {
    expect(trashState(fields({ purgeAfter: day(-99) }), NOW)).toBe('live')
  })
})

describe('isTrashed', () => {
  it('is true for anything in the bin, due or not', () => {
    expect(isTrashed(fields())).toBe(false)
    expect(isTrashed(fields({ deletedAt: day(-1), purgeAfter: day(29) }))).toBe(true)
    expect(isTrashed(fields({ deletedAt: day(-31), purgeAfter: day(-1) }))).toBe(true)
  })
})

describe('daysUntilPurge', () => {
  it('rounds up, so the last partial day still reads as one', () => {
    expect(daysUntilPurge(fields({ purgeAfter: new Date(NOW.getTime() + 1) }), NOW)).toBe(1)
  })

  it('is zero once the deadline has passed', () => {
    expect(daysUntilPurge(fields({ purgeAfter: day(-1) }), NOW)).toBe(0)
    expect(daysUntilPurge(fields({ purgeAfter: NOW }), NOW)).toBe(0)
  })

  it('is the whole hold when there is no deadline to read', () => {
    expect(daysUntilPurge(fields(), NOW)).toBe(TRASH_HOLD_DAYS)
  })
})

describe('canRestore', () => {
  it('allows a restore that fits', () => {
    expect(canRestore(ctx({ sizeBytes: 5 * MB, usedBytes: 10 * MB }))).toEqual({ ok: true })
  })

  it('allows one that lands exactly on the limit', () => {
    expect(canRestore(ctx({ sizeBytes: 10 * MB, usedBytes: 90 * MB }))).toEqual({ ok: true })
  })

  it('refuses one byte over, and reports the shortfall', () => {
    expect(canRestore(ctx({ sizeBytes: 10 * MB + 1, usedBytes: 90 * MB }))).toEqual({
      ok: false,
      reason: 'over-quota',
      shortfallBytes: 1,
    })
  })

  // A place and a natively built ride both cost nothing, so neither can ever be
  // refused for room — including for a rider already over their limit, which is
  // reachable: the beta lowered the default quota from 250 MB to 25 MB, and that
  // does not shrink what a rider had already stored.
  it('always allows a zero-byte row back', () => {
    expect(canRestore(ctx({ sizeBytes: 0, usedBytes: 200 * MB }))).toEqual({ ok: true })
  })

  it('still refuses a costly restore for a rider who is already over', () => {
    expect(canRestore(ctx({ sizeBytes: 1, usedBytes: 200 * MB }))).toEqual({
      ok: false,
      reason: 'over-quota',
      shortfallBytes: 100 * MB + 1,
    })
  })

  it('refuses anything that is not in the bin', () => {
    expect(canRestore(ctx({ trashed: false }))).toEqual({ ok: false, reason: 'not-trashed', shortfallBytes: 0 })
  })
})
