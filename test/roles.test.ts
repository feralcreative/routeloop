// The waypoint-role taxonomy (#21).
//
// Three pure functions and one table, and the table is the interesting part.
// Its header calls itself the single source of truth and names two things that
// have to stay in step with it by hand — the Postgres enum in schema.ts and the
// icon files on disk — so those are asserted here rather than left to be
// noticed when a role renders as a broken image or a row refuses to insert.
//
// The functions matter because they are the only place the `GAS/FOOD - Name`
// convention exists. Every format's import goes through parseRoleName and every
// format's export through formatRoleName, so a change here moves all six at once.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { waypointRoleEnum } from '../src/db/schema'
import {
  canonicalRole,
  formatRoleName,
  parseRoleName,
  MAX_ROLES_PER_POINT,
  ROLES,
  ROLE_META,
  type Role,
} from '../src/maps/roles'

describe('the table itself', () => {
  // "keep the two lists in sync" is an instruction in the header comment, which
  // is to say it is enforced by remembering. A role added to one and not the
  // other fails at INSERT time on a real ride, which is a long way from here.
  it('matches the Postgres enum exactly, in the same order', () => {
    expect([...waypointRoleEnum.enumValues]).toEqual([...ROLES])
  })

  it('has metadata for every role and no orphans', () => {
    expect(Object.keys(ROLE_META).sort()).toEqual([...ROLES].sort())
  })

  // The header states this as a rule: "Aliases always include the canonical
  // term itself, uppercase." Without it a role cannot survive its own export,
  // because formatRoleName writes the canonical term and nothing reads it back.
  it('lists every canonical term among its own aliases', () => {
    for (const role of ROLES) {
      expect(ROLE_META[role].aliases, role).toContain(role.toUpperCase())
    }
  })

  // Two roles claiming one alias is not an error anywhere — the later role
  // simply wins the map, silently, for every file that uses that word.
  it('never lets two roles claim the same alias', () => {
    const owner = new Map<string, Role>()
    for (const role of ROLES) {
      for (const alias of ROLE_META[role].aliases) {
        expect(owner.get(alias), `"${alias}" claimed by both ${owner.get(alias)} and ${role}`).toBeUndefined()
        owner.set(alias, role)
      }
    }
  })

  it('has aliases that are uppercase and unpadded, since lookup uppercases and trims', () => {
    for (const role of ROLES) {
      for (const alias of ROLE_META[role].aliases) {
        expect(alias, role).toBe(alias.trim().toUpperCase())
      }
    }
  })

  it('points every role at an icon that exists on disk', () => {
    for (const role of ROLES) {
      const path = join(__dirname, '..', 'public', 'img', 'icons', ROLE_META[role].icon)
      expect(existsSync(path), `${role} → ${ROLE_META[role].icon}`).toBe(true)
    }
  })

  it('gives every role a title', () => {
    for (const role of ROLES) expect(ROLE_META[role].title.trim(), role).not.toBe('')
  })
})

describe('canonicalRole', () => {
  it('resolves a canonical term to itself', () => {
    for (const role of ROLES) expect(canonicalRole(role), role).toBe(role)
  })

  it('resolves every listed alias', () => {
    for (const role of ROLES) {
      for (const alias of ROLE_META[role].aliases) expect(canonicalRole(alias), alias).toBe(role)
    }
  })

  it('ignores case and surrounding whitespace', () => {
    expect(canonicalRole('  fUeL  ')).toBe('gas')
  })

  // The two deliberate fixes the header calls out, made when the legacy
  // viewer's three divergent alias tables were merged.
  it('matches the literal WTF, which the legacy tables did not', () => {
    expect(canonicalRole('WTF')).toBe('wtf')
  })

  it('matches CHARGER as well as CHARGE', () => {
    expect(canonicalRole('CHARGER')).toBe('charge')
    expect(canonicalRole('CHARGE')).toBe('charge')
  })

  it('returns null for a word it does not know, rather than guessing', () => {
    expect(canonicalRole('unicorn')).toBeNull()
    expect(canonicalRole('')).toBeNull()
    expect(canonicalRole('   ')).toBeNull()
  })
})

describe('parseRoleName', () => {
  it('splits the documented convention', () => {
    expect(parseRoleName('GAS - Chevron')).toEqual({ roles: ['gas'], name: 'Chevron' })
  })

  it('reads several roles from a slash list', () => {
    expect(parseRoleName('GAS/FOOD - Chevron')).toEqual({ roles: ['gas', 'food'], name: 'Chevron' })
  })

  it('deduplicates two aliases of the same role', () => {
    expect(parseRoleName('GAS/FUEL - Chevron')).toEqual({ roles: ['gas'], name: 'Chevron' })
  })

  it('caps the list, matching the legacy slash-combining limit', () => {
    const parsed = parseRoleName('GAS/FOOD/COFFEE/VIEW/WTF/CAMP - Everything')
    expect(parsed.roles).toHaveLength(MAX_ROLES_PER_POINT)
  })

  it('keeps the whole string as the name when no token is a role', () => {
    // Not { roles: [], name: 'Chevron' } — a hyphen in a name is ordinary, and
    // eating the text before it would silently rename the stop.
    expect(parseRoleName('Bob - Chevron')).toEqual({ roles: [], name: 'Bob - Chevron' })
  })

  it('keeps a name that has no hyphen at all', () => {
    expect(parseRoleName('Chevron')).toEqual({ roles: [], name: 'Chevron' })
  })

  it('splits on the first hyphen only, so the name may contain more', () => {
    expect(parseRoleName('GAS - Chevron - Petaluma')).toEqual({ roles: ['gas'], name: 'Chevron - Petaluma' })
  })

  it('does not need spaces around the hyphen', () => {
    expect(parseRoleName('START-Santa Cruz')).toEqual({ roles: ['start'], name: 'Santa Cruz' })
  })

  it('trims the padding a hand-edited file collects', () => {
    expect(parseRoleName('   GAS   -   Chevron   ')).toEqual({ roles: ['gas'], name: 'Chevron' })
  })

  it('accepts a role with no name after it', () => {
    expect(parseRoleName('GAS -')).toEqual({ roles: ['gas'], name: '' })
  })

  it('reads a name that runs onto another line', () => {
    expect(parseRoleName('GAS - Chevron\nPetaluma')).toEqual({ roles: ['gas'], name: 'Chevron\nPetaluma' })
  })

  it('skips an unknown token instead of rejecting the whole prefix', () => {
    expect(parseRoleName('GAS/UNICORN - Chevron')).toEqual({ roles: ['gas'], name: 'Chevron' })
  })

  it('handles an empty string', () => {
    expect(parseRoleName('')).toEqual({ roles: [], name: '' })
  })
})

describe('formatRoleName', () => {
  it('writes the documented convention', () => {
    expect(formatRoleName(['gas', 'food'], 'Chevron')).toBe('GAS/FOOD - Chevron')
  })

  it('leaves a name alone when there are no roles', () => {
    // Not 'Chevron' with a stray separator — a leading " - " would come back as
    // part of the name on the next import.
    expect(formatRoleName([], 'Chevron')).toBe('Chevron')
  })

  it('preserves the order it was given', () => {
    expect(formatRoleName(['food', 'gas'], 'X')).toBe('FOOD/GAS - X')
  })
})

// The property that matters: these two are inverses, and every format's export
// relies on it. A role that survives formatRoleName but not parseRoleName would
// vanish from a file this app wrote and then read back.
describe('formatRoleName and parseRoleName are inverses', () => {
  it('round-trips every single role', () => {
    for (const role of ROLES) {
      expect(parseRoleName(formatRoleName([role], 'Somewhere')), role).toEqual({
        roles: [role],
        name: 'Somewhere',
      })
    }
  })

  it('round-trips every pair of roles', () => {
    for (const a of ROLES) {
      for (const b of ROLES) {
        if (a === b) continue
        expect(parseRoleName(formatRoleName([a, b], 'Somewhere')).roles, `${a}+${b}`).toEqual([a, b])
      }
    }
  })

  it('round-trips a full-capacity role list', () => {
    const four = ROLES.slice(0, MAX_ROLES_PER_POINT) as Role[]
    expect(parseRoleName(formatRoleName(four, 'Somewhere'))).toEqual({ roles: four, name: 'Somewhere' })
  })

  // Where the round trip genuinely does not hold, so it is stated rather than
  // discovered. A name that itself looks like the convention is re-read as one.
  it('does not round-trip a name that is itself in the convention', () => {
    const written = formatRoleName([], 'GAS - Chevron')
    expect(written).toBe('GAS - Chevron')
    expect(parseRoleName(written)).toEqual({ roles: ['gas'], name: 'Chevron' })
  })
})
