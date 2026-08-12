// The invite rules, as a table.
//
// Two of these matter more than the rest and are the reason the file exists.
//
// `plannedGrants` decides whether a blocked rider can let themselves back in by
// clicking a link that is still sitting in a Discord channel. That is a
// privilege escalation, it is one operator away from being wrong — /admin
// deliberately uses `ne(status, 'active')` for the same-shaped update — and
// nothing about the resulting bug is visible in review.
//
// `normalizeInviteToken` decides whether a rider who was genuinely invited can
// get in at all. Links come back from Discord and mail clients with punctuation
// stuck to them, and the failure is indistinguishable from a revoked invite.
//
// The concurrency half — two riders taking the last seat — is the conditional
// UPDATE in src/invites/service.ts and is deliberately NOT tested here. It needs
// a database. This covers the policy; the SQL covers the race.
import { describe, expect, it } from 'vitest'
import {
  consumesSeat,
  grantsLabel,
  inviteStatus,
  inviteUrl,
  normalizeInviteToken,
  plannedGrants,
  seatsLeft,
  TOKEN_HEX_LENGTH,
} from '../src/invites/policy'
import type { GranteeState, Grants, InviteState } from '../src/invites/policy'

const NOW = new Date('2026-08-08T12:00:00Z')
const LATER = new Date('2026-08-15T12:00:00Z')
const EARLIER = new Date('2026-08-01T12:00:00Z')

const invite = (over: Partial<InviteState> = {}): InviteState => ({
  maxUses: 1,
  usedCount: 0,
  revokedAt: null,
  expiresAt: LATER,
  ...over,
})

describe('inviteStatus', () => {
  const cases: [string, InviteState, string][] = [
    ['a fresh single-use invite', invite(), 'ok'],
    ['a group link with seats left', invite({ maxUses: 25, usedCount: 3 }), 'ok'],
    ['a revoked invite', invite({ revokedAt: EARLIER }), 'revoked'],
    ['an expired invite', invite({ expiresAt: EARLIER }), 'expired'],
    ['a full single-use invite', invite({ usedCount: 1 }), 'exhausted'],
    ['a full group link', invite({ maxUses: 25, usedCount: 25 }), 'exhausted'],
    // Revocation is the manager's deliberate act and is the most useful thing to
    // report, so it wins over both of the passive states.
    ['revoked AND expired', invite({ revokedAt: EARLIER, expiresAt: EARLIER }), 'revoked'],
    ['revoked AND full', invite({ revokedAt: EARLIER, usedCount: 1 }), 'revoked'],
    // Expiry beats exhaustion: "ask me for another one" is actionable, "it is
    // full" invites them to wait for a seat that is never coming back.
    ['expired AND full', invite({ expiresAt: EARLIER, usedCount: 1 }), 'expired'],
  ]

  for (const [name, inv, expected] of cases) {
    it(`${name} reads as ${expected}`, () => {
      expect(inviteStatus(inv, NOW)).toBe(expected)
    })
  }

  // The boundary has to agree with `gt(expiresAt, now())` in the seat claim, or
  // the page says one thing and the database does another.
  it('treats an invite expiring exactly now as expired, matching the SQL', () => {
    expect(inviteStatus(invite({ expiresAt: NOW }), NOW)).toBe('expired')
    expect(inviteStatus(invite({ expiresAt: new Date(NOW.getTime() + 1) }), NOW)).toBe('ok')
  })
})

describe('seatsLeft', () => {
  it('counts down', () => {
    expect(seatsLeft(invite({ maxUses: 25, usedCount: 4 }))).toBe(21)
  })

  // A check constraint stops this being stored, but the admin page renders a
  // meter from it and a negative width is a broken page rather than a caught bug.
  it('floors at zero rather than going negative', () => {
    expect(seatsLeft(invite({ maxUses: 5, usedCount: 9 }))).toBe(0)
  })
})

describe('normalizeInviteToken', () => {
  const token = 'a'.repeat(TOKEN_HEX_LENGTH)

  const cases: [string, string, string | null][] = [
    ['a clean token', token, token],
    ['surrounding whitespace', `  ${token}\n`, token],
    ['uppercase, as retyped from a screen', token.toUpperCase(), token],
    ['a trailing paren from a Discord parenthetical', `${token})`, token],
    ['a trailing period from the end of a sentence', `${token}.`, token],
    ['angle brackets, as some mail clients wrap URLs', `<${token}>`, token],
    ['a zero-width space pasted from a chat client', `${token}​`, token],
    ['too short', 'abc123', null],
    ['too long', token + 'ff', null],
    ['empty', '', null],
    ['non-hex only', 'zzzz', null],
  ]

  for (const [name, raw, expected] of cases) {
    it(`${expected === null ? 'rejects' : 'accepts'}: ${name}`, () => {
      expect(normalizeInviteToken(raw)).toBe(expected)
    })
  }

  // The stripping is what makes the mangled cases above work, and it is also the
  // one thing that could turn a wrong token into a valid-looking one. It cannot:
  // stripping only ever shortens, and the length check is exact.
  it('does not assemble a valid token out of junk around a short one', () => {
    expect(normalizeInviteToken(`<<${'a'.repeat(40)}>>`)).toBeNull()
  })
})

describe('inviteUrl', () => {
  it('builds an absolute link', () => {
    expect(inviteUrl('https://routeloop.app', 'abc')).toBe('https://routeloop.app/i/abc')
  })

  it('does not double the slash when the origin carries one', () => {
    expect(inviteUrl('https://routeloop.app/', 'abc')).toBe('https://routeloop.app/i/abc')
  })
})

describe('plannedGrants', () => {
  const both: Grants = { grantsBeta: true, grantsSurvey: true }
  const betaOnly: Grants = { grantsBeta: true, grantsSurvey: false }
  const surveyOnly: Grants = { grantsBeta: false, grantsSurvey: true }

  const rider = (over: Partial<GranteeState> = {}): GranteeState => ({
    status: 'pending',
    surveyInvitedAt: null,
    ...over,
  })

  const cases: [string, Grants, GranteeState, { beta: boolean; survey: boolean }][] = [
    ['a new rider on a full invite', both, rider(), { beta: true, survey: true }],
    ['a new rider on a beta-only invite', betaOnly, rider(), { beta: true, survey: false }],
    ['a new rider on a survey-only invite', surveyOnly, rider(), { beta: false, survey: true }],
    [
      'an active rider who has not been surveyed',
      both,
      rider({ status: 'active' }),
      { beta: false, survey: true },
    ],
    [
      'an active rider already surveyed',
      both,
      rider({ status: 'active', surveyInvitedAt: EARLIER }),
      { beta: false, survey: false },
    ],
    [
      'a pending rider already surveyed, on a full invite',
      both,
      rider({ surveyInvitedAt: EARLIER }),
      { beta: true, survey: false },
    ],
  ]

  for (const [name, g, u, expected] of cases) {
    it(`${name}: beta=${expected.beta} survey=${expected.survey}`, () => {
      expect(plannedGrants(g, u)).toEqual(expected)
    })
  }

  // THE test in this file. /admin reinstates a blocked rider with
  // ne(status, 'active'), which is right there because a manager chose it. Here
  // it would mean a rider you blocked clicks the link still sitting in the
  // Discord channel and un-blocks themselves. If this ever fails, the fix is the
  // operator in service.ts, never the expectation here.
  it('never lets a blocked rider back in, whatever the invite offers', () => {
    expect(plannedGrants(both, rider({ status: 'blocked' })).beta).toBe(false)
    expect(plannedGrants(betaOnly, rider({ status: 'blocked' })).beta).toBe(false)
  })

  // A blocked rider is blocked from the app, not from having an opinion — and
  // the survey grant does not touch users.status, so it cannot be an escalation.
  it('still lets a blocked rider be surveyed, which grants no access', () => {
    expect(plannedGrants(surveyOnly, rider({ status: 'blocked' }))).toEqual({ beta: false, survey: true })
  })
})

describe('consumesSeat', () => {
  it('spends a seat when anything would change', () => {
    expect(consumesSeat({ beta: true, survey: false })).toBe(true)
    expect(consumesSeat({ beta: false, survey: true })).toBe(true)
  })

  // The reason a 25-seat link pasted into a 40-rider channel is not exhausted by
  // the members who already have accounts.
  it('spends nothing when the rider already has everything on offer', () => {
    expect(consumesSeat({ beta: false, survey: false })).toBe(false)
  })
})

describe('grantsLabel', () => {
  it.each([
    [{ grantsBeta: true, grantsSurvey: true }, 'beta + survey'],
    [{ grantsBeta: true, grantsSurvey: false }, 'beta'],
    [{ grantsBeta: false, grantsSurvey: true }, 'survey'],
    [{ grantsBeta: false, grantsSurvey: false }, 'nothing'],
  ])('%o reads as %s', (g, expected) => {
    expect(grantsLabel(g)).toBe(expected)
  })
})
