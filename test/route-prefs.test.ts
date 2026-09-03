// A day's routing preferences (#29).
//
// The cases here are all one worry: that two spellings of "no preference" reach
// the row, the cache key or the revision hash as different values. Each of those
// costs something real — a spurious save conflict, a cache miss that re-bills a
// route, a toggle that looks broken.
import { describe, expect, it } from 'vitest'
import {
  describePrefs,
  normalizePrefs,
  prefsKey,
  routePrefsSchema,
  toRouteModifiers,
  wantsTwisty,
} from '../src/maps/route-prefs'

describe('normalizing', () => {
  it('collapses every empty spelling to null', () => {
    expect(normalizePrefs(null)).toBeNull()
    expect(normalizePrefs(undefined)).toBeNull()
    expect(normalizePrefs({})).toBeNull()
    expect(normalizePrefs({ avoidTolls: false })).toBeNull()
    expect(normalizePrefs({ avoidHighways: false, avoidTolls: false, avoidFerries: false })).toBeNull()
  })

  // An explicit false stored beside a true would give one state two spellings
  // again, one level down.
  it('keeps only the flags that are set', () => {
    expect(normalizePrefs({ avoidHighways: true, avoidTolls: false })).toEqual({ avoidHighways: true })
  })

  it('is idempotent', () => {
    const once = normalizePrefs({ avoidHighways: true, avoidFerries: true })
    expect(normalizePrefs(once)).toEqual(once)
  })
})

describe('the Google request', () => {
  // A day with no preferences must send the request it sent before this feature
  // existed, or every route already in the cache misses on the deploy that
  // lands it and the whole corpus re-bills.
  it('asks for no modifiers at all when nothing is set', () => {
    expect(toRouteModifiers(null)).toBeUndefined()
    expect(toRouteModifiers({})).toBeUndefined()
    expect(toRouteModifiers({ avoidTolls: false })).toBeUndefined()
  })

  it('sends only the flags that are set', () => {
    expect(toRouteModifiers({ avoidHighways: true })).toEqual({ avoidHighways: true })
    expect(toRouteModifiers({ avoidHighways: true, avoidTolls: true, avoidFerries: true })).toEqual({
      avoidHighways: true,
      avoidTolls: true,
      avoidFerries: true,
    })
  })
})

describe('the cache key', () => {
  it('is empty for no preferences, so keys predating the feature are unchanged', () => {
    expect(prefsKey(null)).toBe('')
    expect(prefsKey({})).toBe('')
    expect(prefsKey({ avoidHighways: false })).toBe('')
  })

  // THE POINT OF THE KEY. Without preferences in it, an avoid-highways route and
  // a plain one between the same two points share an entry and whichever
  // answered first wins — the toggle then looks broken while behaving correctly.
  it('separates two requests that differ only by preference', () => {
    expect(prefsKey({ avoidHighways: true })).not.toBe(prefsKey({ avoidTolls: true }))
    expect(prefsKey({ avoidHighways: true })).not.toBe(prefsKey(null))
  })

  it('does not depend on the order the flags were written in', () => {
    expect(prefsKey({ avoidTolls: true, avoidHighways: true })).toBe(prefsKey({ avoidHighways: true, avoidTolls: true }))
  })
})

describe('the schema', () => {
  it('refuses a key it does not know, so jsonb cannot become a junk drawer', () => {
    expect(routePrefsSchema.safeParse({ avoidTraffic: true }).success).toBe(false)
    expect(routePrefsSchema.safeParse({ avoidHighways: 'yes' }).success).toBe(false)
  })

  it('accepts the empty object and every subset', () => {
    expect(routePrefsSchema.safeParse({}).success).toBe(true)
    expect(routePrefsSchema.safeParse({ avoidFerries: true }).success).toBe(true)
  })
})

describe('the rider-facing summary', () => {
  it('says nothing when there is nothing to say', () => {
    expect(describePrefs(null)).toBe('')
    expect(describePrefs({})).toBe('')
  })

  it('reads as a sentence, with the Oxford comma at three', () => {
    expect(describePrefs({ avoidHighways: true })).toBe('Avoiding highways')
    expect(describePrefs({ avoidHighways: true, avoidTolls: true })).toBe('Avoiding highways and tolls')
    expect(describePrefs({ avoidHighways: true, avoidTolls: true, avoidFerries: true })).toBe(
      'Avoiding highways, tolls, and ferries',
    )
  })
})

// #28's flag rides in the same jsonb, which is why that column is jsonb — but it
// is NOT one of Google's route modifiers, and the two lists exist so that a
// field Routes would reject can never reach a request.
describe('the twisty preference', () => {
  it('never reaches routeModifiers, which Routes would reject', () => {
    expect(toRouteModifiers({ preferTwisty: true })).toBeUndefined()
    expect(toRouteModifiers({ preferTwisty: true, avoidTolls: true })).toEqual({ avoidTolls: true })
  })

  // It changes the road that comes back, so a cached plain route must not be
  // served for it — the same reason the avoid flags are in the key.
  it('is part of the cache key', () => {
    expect(prefsKey({ preferTwisty: true })).not.toBe('')
    expect(prefsKey({ preferTwisty: true })).not.toBe(prefsKey({ avoidHighways: true }))
    expect(prefsKey({ preferTwisty: true, avoidTolls: true })).toBe(
      prefsKey({ avoidTolls: true, preferTwisty: true }),
    )
  })

  it('survives normalizing and collapses when false', () => {
    expect(normalizePrefs({ preferTwisty: true })).toEqual({ preferTwisty: true })
    expect(normalizePrefs({ preferTwisty: false })).toBeNull()
  })

  it('is what wantsTwisty answers, and only when actually set', () => {
    expect(wantsTwisty({ preferTwisty: true })).toBe(true)
    expect(wantsTwisty({ preferTwisty: false })).toBe(false)
    expect(wantsTwisty({ avoidTolls: true })).toBe(false)
    expect(wantsTwisty(null)).toBe(false)
  })

  it('reads as a sentence on its own and alongside the avoids', () => {
    expect(describePrefs({ preferTwisty: true })).toBe('Preferring the twistier road')
    expect(describePrefs({ preferTwisty: true, avoidHighways: true })).toBe(
      'Avoiding highways, preferring the twistier road',
    )
  })
})
