// A personal ride link (#428): when it still works, and the view cookie that
// carries it.
import { describe, expect, it } from 'vitest'
import {
  inviteLiveness,
  isLiveInvite,
  MAX_VIEW_TOKENS,
  parseViewTokens,
  rideInvitePath,
  serializeViewTokens,
  withViewToken,
} from '../src/ride-invites/policy'

const at = new Date('2026-10-01T00:00:00Z')
const facts = (over: Partial<Record<'sentAt' | 'redeemedAt' | 'declinedAt' | 'revokedAt', Date | null>> = {}) => ({
  sentAt: at,
  redeemedAt: null,
  declinedAt: null,
  revokedAt: null,
  ...over,
})

describe('inviteLiveness', () => {
  it('is live once sent and before anything else happens', () => {
    expect(inviteLiveness(facts())).toBe('ok')
    expect(isLiveInvite(facts())).toBe(true)
  })

  it('is not live as a draft — the token has not been minted', () => {
    expect(inviteLiveness(facts({ sentAt: null }))).toBe('unsent')
  })

  it('dies on join, decline and revoke', () => {
    expect(inviteLiveness(facts({ redeemedAt: at }))).toBe('joined')
    expect(inviteLiveness(facts({ declinedAt: at }))).toBe('declined')
    expect(inviteLiveness(facts({ revokedAt: at }))).toBe('revoked')
  })

  it('reports a revoke over anything else, since it is the organizer taking it back', () => {
    expect(inviteLiveness(facts({ revokedAt: at, declinedAt: at, redeemedAt: at }))).toBe('revoked')
  })
})

describe('the view cookie', () => {
  it('round-trips a list of tokens', () => {
    expect(parseViewTokens(serializeViewTokens(['aa', 'bb']))).toEqual(['aa', 'bb'])
    expect(parseViewTokens('')).toEqual([])
  })

  it('adds a token once, newest last', () => {
    expect(withViewToken(['aa', 'bb'], 'aa')).toEqual(['bb', 'aa'])
  })

  it('drops the oldest past the cap, so the header cannot grow forever', () => {
    let list: string[] = []
    for (let i = 0; i < MAX_VIEW_TOKENS + 5; i++) list = withViewToken(list, `t${i}`)
    expect(list).toHaveLength(MAX_VIEW_TOKENS)
    expect(list[0]).toBe('t5')
    expect(parseViewTokens(serializeViewTokens([...list, 'x', 'y']))).toHaveLength(MAX_VIEW_TOKENS)
  })
})

describe('rideInvitePath', () => {
  it('is a path, so the origin is added in exactly one place', () => {
    expect(rideInvitePath('abc')).toBe('/ride-invite/abc')
  })
})
