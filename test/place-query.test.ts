// Telling a category search from a name search.
//
// The detection rule is the whole point of place-query.js, and both directions
// of getting it wrong cost something real: a false positive spends a billed Text
// Search call on somebody typing a business name, and a false negative is the
// bug the file was written to fix — "gas station in oakdale ca" answered by
// Autocomplete with the one business literally named "76 Gas Station".
//
// place-query.js is a plain IIFE that assigns window.TBQuery, so it loads by
// evaluating it against a stub global rather than importing.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { ROLES } from '../src/maps/roles'

let Q: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/place-query.js', 'utf8'))(win)
  Q = win.TBQuery
})

describe('a category query', () => {
  it('reads the kind and keeps the whole query for Text Search', () => {
    // The text is passed through UNCHANGED, place included. Text Search reads
    // "X in Y" itself, so cutting the place out and geocoding it separately
    // would be an extra billed call for nothing.
    expect(Q.parse('gas station in oakdale ca')).toEqual({ text: 'gas station in oakdale ca', role: 'gas' })
  })

  it('works with no place at all', () => {
    expect(Q.parse('coffee')).toEqual({ text: 'coffee', role: 'coffee' })
  })

  it.each([
    ['gas station in oakdale ca', 'gas'],
    ['fuel near sonora', 'gas'],
    ['coffee shop in half moon bay', 'coffee'],
    ['motel near bridgeport', 'hotel'],
    ['campground around lake tahoe', 'camp'],
    ['ev charging in modesto', 'charge'],
    ['rest stop in tracy', 'break'],
    ['scenic overlook near big sur', 'view'],
    ['tacos in salinas', 'food'],
    ['brewery in santa cruz', 'drinks'],
    ['groceries in jackson', 'grocery'],
    ['motorcycle shop in reno', 'poi'],
  ])('maps %s to the %s role', (input, role) => {
    expect(Q.parse(input)?.role).toBe(role)
  })

  it('strips the filler a person actually types', () => {
    for (const q of ['find me a gas station in oakdale', 'nearest gas station in oakdale', 'a gas station in oakdale']) {
      expect(Q.parse(q)?.role, q).toBe('gas')
    }
  })

  it('accepts every splitter, not just "in"', () => {
    for (const sep of ['in', 'near', 'around', 'close to', 'by']) {
      expect(Q.parse(`coffee ${sep} oakdale`)?.role, sep).toBe('coffee')
    }
  })

  it('matches the longest phrase, so a prefix cannot win', () => {
    // "rest stop" must not be read as "rest", and "gas station" not as "gas"
    // plus stray words — both would still land on the right role here, so the
    // assertion that matters is that the fuller phrase is recognized at all.
    expect(Q.parse('rest stop in tracy')?.role).toBe('break')
    expect(Q.parse('coffee shop in davenport')?.role).toBe('coffee')
  })
})

describe('a name query is left alone', () => {
  // THE EXPENSIVE MISTAKE. Every one of these would otherwise spend a Text
  // Search call to answer a question Autocomplete answers for free — and worse,
  // a rider typing "Chevron Oakdale" wants that station, not a list of every
  // fuel stop in town.
  it.each([
    'Chevron Oakdale CA',
    'Shell',
    '76',
    'Oakdale, CA',
    'Cahoots Corner Cafe',
    'Highway 120',
    "Denny's",
    'Santa Cruz',
    '1505 E F St, Oakdale',
  ])('does not treat %s as a category', (input) => {
    expect(Q.parse(input)).toBeNull()
  })

  it('is null for nothing at all', () => {
    for (const q of ['', '   ', null, undefined]) expect(Q.parse(q as never)).toBeNull()
  })

  // A brand that CONTAINS a category word is still a name. "shell gas station"
  // is a person describing one specific place; the head is not a bare category
  // phrase, so it goes down the name path.
  it('does not fire on a brand qualified by a category word', () => {
    expect(Q.parse('shell gas station oakdale')).toBeNull()
    expect(Q.parse('chevron gas')).toBeNull()
  })
})

describe('roles', () => {
  it('only ever names roles that exist in roles.ts', () => {
    // The client and the server have to agree about the 17 roles, and a typo
    // here would tag a point with something the schema's enum refuses — a save
    // that 400s well after the search that caused it.
    for (const c of Q.CATEGORIES) expect(ROLES).toContain(c.role)
  })

  it('maps a Google place type to one of ours', () => {
    expect(Q.roleForType('gas_station')).toBe('gas')
    expect(Q.roleForType('coffee_shop')).toBe('coffee')
    expect(Q.roleForType('campground')).toBe('camp')
    expect(Q.roleForType('GAS_STATION')).toBe('gas')
  })

  it('is null for a type it does not know, rather than guessing poi', () => {
    // A point is created as a POI regardless, so claiming a role nothing
    // established is worse than leaving it untagged. Same null-is-not-zero
    // reasoning as twistiness.
    expect(Q.roleForType('convenience_store')).toBeNull()
    expect(Q.roleForType('museum')).toBeNull()
    expect(Q.roleForType('')).toBeNull()
    expect(Q.roleForType(undefined)).toBeNull()
  })

  it('never maps a type to a role roles.ts does not have', () => {
    for (const t of ['gas_station', 'cafe', 'hotel', 'rest_stop', 'scenic_lookout', 'supermarket']) {
      expect(ROLES).toContain(Q.roleForType(t))
    }
  })
})
