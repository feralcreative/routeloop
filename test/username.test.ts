// Username rules that do not need a database.
//
// publicIdFor is the one worth pinning hardest: it is written once per account
// and never again, so a formatting change silently breaks every identifier
// already issued. Availability and the 30-day hold need real rows and are still
// verified by hand against the dev database.
import { describe, expect, it } from 'vitest'
import { publicIdFor, usernameSchema, RESERVED_USERNAMES, USERNAME_HOLD_DAYS } from '../src/auth/username'

describe('publicIdFor', () => {
  it('is {username}-{YYMMDDTHHMMZ}', () => {
    expect(publicIdFor('ziad', new Date(Date.UTC(2026, 7, 1, 22, 20)))).toBe('ziad-260801T2220Z')
  })

  it('lowercases the handle so capitalisation cannot change the id', () => {
    const d = new Date(Date.UTC(2026, 7, 1, 22, 20))
    expect(publicIdFor('ZiadEzzat', d)).toBe(publicIdFor('ziadezzat', d))
  })

  it('formats from UTC, not the server clock', () => {
    // 23:30 UTC on the 1st is still the 1st in Zulu whatever the host zone says.
    expect(publicIdFor('x', new Date(Date.UTC(2026, 7, 1, 23, 30)))).toBe('x-260801T2330Z')
  })

  it('pads every field', () => {
    expect(publicIdFor('x', new Date(Date.UTC(2026, 0, 2, 3, 4)))).toBe('x-260102T0304Z')
  })

  it('fits the column at the longest possible handle', () => {
    const longest = 'a'.repeat(30)
    expect(publicIdFor(longest, new Date()).length).toBeLessThanOrEqual(64)
  })
})

describe('usernameSchema', () => {
  const ok = (v: string) => usernameSchema.safeParse(v).success
  const why = (v: string) => usernameSchema.safeParse(v).error?.issues[0]?.message

  it('accepts letters, numbers and underscores', () => {
    expect(ok('ziad')).toBe(true)
    expect(ok('Ziad_Ezzat_99')).toBe(true)
  })

  it('rejects anything shorter than three', () => {
    expect(ok('zi')).toBe(false)
    expect(why('zi')).toMatch(/at least 3/)
  })

  it('rejects anything longer than thirty', () => {
    expect(ok('a'.repeat(31))).toBe(false)
  })

  it('rejects spaces and punctuation', () => {
    expect(ok('ziad ezzat')).toBe(false)
    expect(ok('ziad-ezzat')).toBe(false)
    expect(ok('ziad@home')).toBe(false)
  })

  it('rejects a reserved name regardless of case', () => {
    expect(ok('admin')).toBe(false)
    expect(ok('ADMIN')).toBe(false)
    expect(why('admin')).toMatch(/reserved/)
  })
})

describe('reserved list', () => {
  it('covers the paths a handle could otherwise shadow', () => {
    for (const p of ['admin', 'api', 'builder', 'login', 'profile', 'welcome']) {
      expect(RESERVED_USERNAMES.has(p)).toBe(true)
    }
  })

  it('needs no entry for hyphenated paths, which the charset already excludes', () => {
    expect(usernameSchema.safeParse('choose-name').success).toBe(false)
  })
})

describe('the hold window', () => {
  it('is stated once so the check and the copy cannot disagree', () => {
    expect(USERNAME_HOLD_DAYS).toBe(30)
  })
})
