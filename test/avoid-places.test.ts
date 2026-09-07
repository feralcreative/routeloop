// A rider's avoid list (#271).
//
// THE ONE PROPERTY THAT MATTERS MORE THAN ANY OTHER: nothing is ever removed.
// The whole reason this is a weighting rather than a filter is that a rider out
// of fuel with an ARCO in front of them must still be shown it — so the length
// of the list is asserted on every path here, not just the order.
import { describe, expect, it } from 'vitest'
import { demoteAvoided, isAvoided, MAX_AVOID_TERMS, parseAvoidList } from '../src/places/avoid'

const places = (...names: string[]) => names.map((name) => ({ name }))
const names = (rows: { name: string }[]) => rows.map((r) => r.name)

describe('parseAvoidList', () => {
  it('is empty for nothing at all', () => {
    expect(parseAvoidList(null)).toEqual([])
    expect(parseAvoidList(undefined)).toEqual([])
    expect(parseAvoidList('')).toEqual([])
    expect(parseAvoidList('   ')).toEqual([])
  })

  it('takes commas, semicolons and newlines, because a rider will use all three', () => {
    expect(parseAvoidList('ARCO, Costco Gas; fast food\nSubway')).toEqual(['arco', 'costco gas', 'fast food', 'subway'])
  })

  it('lowercases and collapses inner whitespace, so the matcher can be a plain includes', () => {
    expect(parseAvoidList('  Costco   Gas  ')).toEqual(['costco gas'])
  })

  it('de-duplicates, so one brand typed twice does not demote twice', () => {
    expect(parseAvoidList('ARCO, arco, Arco')).toEqual(['arco'])
  })

  // ONE AND TWO CHARACTERS MATCH HALF THE MAP. "BP" is a real brand and also a
  // substring of a hundred unrelated names, and a term that matches everything
  // is a list that orders nothing.
  it('drops terms shorter than three characters', () => {
    expect(parseAvoidList('BP, 76, ARCO')).toEqual(['arco'])
  })

  it('stops at the cap rather than storing a paste accident', () => {
    const many = Array.from({ length: MAX_AVOID_TERMS + 20 }, (_, i) => `brand${i}`).join(',')
    expect(parseAvoidList(many)).toHaveLength(MAX_AVOID_TERMS)
  })
})

describe('isAvoided', () => {
  const terms = parseAvoidList('arco, costco gas')

  it('matches case-insensitively and as a substring', () => {
    expect(isAvoided({ name: 'ARCO' }, terms)).toBe(true)
    expect(isAvoided({ name: 'ARCO am/pm' }, terms)).toBe(true)
    expect(isAvoided({ name: 'Costco Gas Station' }, terms)).toBe(true)
  })

  it('leaves everything else alone', () => {
    expect(isAvoided({ name: 'Chevron' }, terms)).toBe(false)
  })

  it('matches nothing when the list is empty', () => {
    expect(isAvoided({ name: 'ARCO' }, [])).toBe(false)
  })
})

describe('demoteAvoided', () => {
  it('keeps every result, which is the whole point', () => {
    const out = demoteAvoided(places('ARCO', 'Chevron', 'Shell'), parseAvoidList('arco'))
    expect(out).toHaveLength(3)
    expect(names(out).sort()).toEqual(['ARCO', 'Chevron', 'Shell'])
  })

  it('moves the named ones to the back', () => {
    const out = demoteAvoided(places('ARCO', 'Chevron', 'Costco Gas', 'Shell'), parseAvoidList('arco; costco gas'))
    expect(names(out)).toEqual(['Chevron', 'Shell', 'ARCO', 'Costco Gas'])
  })

  // STABLE WITHIN EACH HALF. Text Search's own order is a ranking this app has
  // no better answer than, so the only thing that may change is which half a
  // result is in — a score-based sort would quietly re-rank the ones nobody
  // mentioned.
  it('preserves the original order inside each half', () => {
    const out = demoteAvoided(places('Shell', 'ARCO', 'Chevron', 'ARCO am/pm', '76'), parseAvoidList('arco'))
    expect(names(out)).toEqual(['Shell', 'Chevron', '76', 'ARCO', 'ARCO am/pm'])
  })

  it('returns the list untouched when there is nothing to avoid', () => {
    const list = places('Shell', 'ARCO')
    expect(demoteAvoided(list, [])).toBe(list)
  })

  it('is a no-op when every result is avoided, rather than emptying the list', () => {
    const out = demoteAvoided(places('ARCO', 'ARCO am/pm'), parseAvoidList('arco'))
    expect(names(out)).toEqual(['ARCO', 'ARCO am/pm'])
  })
})
