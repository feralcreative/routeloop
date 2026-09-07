// A rider's two place lists (#271).
//
// THE ONE PROPERTY THAT MATTERS MORE THAN ANY OTHER: nothing is ever removed.
// The whole reason this is a weighting rather than a filter is that a rider out
// of fuel with an ARCO in front of them must still be shown it — so the length
// of the list is asserted on every path here, not just the order.
import { describe, expect, it } from 'vitest'
import { matchesAny, MAX_TERMS, parseTerms, rankPlaces } from '../src/places/ranking'

const places = (...names: string[]) => names.map((name) => ({ name }))
const names = (rows: { name: string }[]) => rows.map((r) => r.name)

describe('parseTerms', () => {
  it('is empty for nothing at all', () => {
    expect(parseTerms(null)).toEqual([])
    expect(parseTerms(undefined)).toEqual([])
    expect(parseTerms('')).toEqual([])
    expect(parseTerms('   ')).toEqual([])
  })

  it('takes commas, semicolons and newlines, because a rider will use all three', () => {
    expect(parseTerms('ARCO, Costco Gas; fast food\nSubway')).toEqual(['arco', 'costco gas', 'fast food', 'subway'])
  })

  it('lowercases and collapses inner whitespace, so the matcher can be a plain includes', () => {
    expect(parseTerms('  Costco   Gas  ')).toEqual(['costco gas'])
  })

  it('de-duplicates, so one brand typed twice does not demote twice', () => {
    expect(parseTerms('ARCO, arco, Arco')).toEqual(['arco'])
  })

  // ONE AND TWO CHARACTERS MATCH HALF THE MAP. "BP" is a real brand and also a
  // substring of a hundred unrelated names, and a term that matches everything
  // is a list that orders nothing.
  it('drops terms shorter than three characters', () => {
    expect(parseTerms('BP, 76, ARCO')).toEqual(['arco'])
  })

  it('stops at the cap rather than storing a paste accident', () => {
    const many = Array.from({ length: MAX_TERMS + 20 }, (_, i) => `brand${i}`).join(',')
    expect(parseTerms(many)).toHaveLength(MAX_TERMS)
  })
})

describe('matchesAny', () => {
  const terms = parseTerms('arco, costco gas')

  it('matches case-insensitively and as a substring', () => {
    expect(matchesAny({ name: 'ARCO' }, terms)).toBe(true)
    expect(matchesAny({ name: 'ARCO am/pm' }, terms)).toBe(true)
    expect(matchesAny({ name: 'Costco Gas Station' }, terms)).toBe(true)
  })

  it('leaves everything else alone', () => {
    expect(matchesAny({ name: 'Chevron' }, terms)).toBe(false)
  })

  it('matches nothing when the list is empty', () => {
    expect(matchesAny({ name: 'ARCO' }, [])).toBe(false)
  })
})

describe('rankPlaces, demoting', () => {
  it('keeps every result, which is the whole point', () => {
    const out = rankPlaces(places('ARCO', 'Chevron', 'Shell'), [], parseTerms('arco'))
    expect(out).toHaveLength(3)
    expect(names(out).sort()).toEqual(['ARCO', 'Chevron', 'Shell'])
  })

  it('moves the named ones to the back', () => {
    const out = rankPlaces(places('ARCO', 'Chevron', 'Costco Gas', 'Shell'), [], parseTerms('arco; costco gas'))
    expect(names(out)).toEqual(['Chevron', 'Shell', 'ARCO', 'Costco Gas'])
  })

  // STABLE WITHIN EACH HALF. Text Search's own order is a ranking this app has
  // no better answer than, so the only thing that may change is which half a
  // result is in — a score-based sort would quietly re-rank the ones nobody
  // mentioned.
  it('preserves the original order inside each half', () => {
    const out = rankPlaces(places('Shell', 'ARCO', 'Chevron', 'ARCO am/pm', '76'), [], parseTerms('arco'))
    expect(names(out)).toEqual(['Shell', 'Chevron', '76', 'ARCO', 'ARCO am/pm'])
  })

  it('returns the list untouched when there is nothing to avoid', () => {
    const list = places('Shell', 'ARCO')
    expect(rankPlaces(list, [], [])).toBe(list)
  })

  it('is a no-op when every result is avoided, rather than emptying the list', () => {
    const out = rankPlaces(places('ARCO', 'ARCO am/pm'), [], parseTerms('arco'))
    expect(names(out)).toEqual(['ARCO', 'ARCO am/pm'])
  })
})

// FAVOR IS THE MIRROR, added 2026-09-07. Same free text, same loose matching,
// same promise that nothing is added or removed — only the direction differs.
describe('rankPlaces, promoting', () => {
  it('moves the named ones to the front', () => {
    const out = rankPlaces(places('Shell', 'Chevron', 'ARCO', '76'), parseTerms('arco'), [])
    expect(names(out)).toEqual(['ARCO', 'Shell', 'Chevron', '76'])
  })

  it('keeps every result, which is the whole point', () => {
    const out = rankPlaces(places('Shell', 'ARCO'), parseTerms('arco'), [])
    expect(out).toHaveLength(2)
  })

  // NOTHING IS CONJURED UP EITHER. A favored place the search did not return is
  // not added — that would be a different search rather than a different order.
  it('does not invent a favored place the search did not return', () => {
    const out = rankPlaces(places('Shell', 'Chevron'), parseTerms('costco gas'), [])
    expect(names(out)).toEqual(['Shell', 'Chevron'])
  })

  it('is stable inside each bucket', () => {
    const out = rankPlaces(places('Shell', 'ARCO', 'Chevron', 'ARCO am/pm', '76'), parseTerms('arco'), [])
    expect(names(out)).toEqual(['ARCO', 'ARCO am/pm', 'Shell', 'Chevron', '76'])
  })
})

describe('rankPlaces, both lists at once', () => {
  it('sorts favored, then unmentioned, then avoided', () => {
    const out = rankPlaces(places('ARCO', 'Shell', 'Costco Gas', 'Chevron'), parseTerms('costco'), parseTerms('arco'))
    expect(names(out)).toEqual(['Costco Gas', 'Shell', 'Chevron', 'ARCO'])
  })

  // THE TIE IS A DECISION, NOT AN ACCIDENT OF WHICH PASS RAN SECOND, which is
  // why this is one partition into three rather than a promote followed by a
  // demote. Favor wins: being shown a place you asked for is a smaller wrong
  // than being denied one.
  it('lets favor win when a term is in both lists', () => {
    const out = rankPlaces(places('Shell', 'ARCO'), parseTerms('arco'), parseTerms('arco'))
    expect(names(out)).toEqual(['ARCO', 'Shell'])
  })

  it('returns the list untouched when both are empty', () => {
    const list = places('Shell', 'ARCO')
    expect(rankPlaces(list, [], [])).toBe(list)
  })
})
