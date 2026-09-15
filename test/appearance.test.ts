// The two appearance axes, and the one rule that is easy to get backwards.
//
// Most of this file is the ordinary coercion contract every preference module
// has. The assertions that earn their place are the two about ABSENCE:
// `schemeAttr('system')` and `themeAttr('default')` must return null, and for
// different reasons.
//
// `default` returning null is a tidiness rule — its palette is the bare `:root`
// block, so an attribute would be redundant.
//
// **`system` returning null is load-bearing.** There is no `[data-scheme=system]`
// rule in style/_theme.scss and there cannot be one: the server does not know the
// reader's OS setting, so `system` is expressed as the absence of the attribute
// and a `prefers-color-scheme` media query answers instead. Stamping
// `data-scheme="system"` would match nothing, and — because the media block is
// guarded by `:not([data-scheme])` — would silently pin every such rider to light
// forever. That is invisible to anyone testing on a light machine.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAP_SCHEME,
  DEFAULT_SCHEME,
  DEFAULT_THEME,
  MAP_SCHEMES,
  MAP_SCHEME_CHOICES,
  SCHEMES,
  SCHEME_CHOICES,
  THEMES,
  THEME_CHOICES,
  mapSchemeAttr,
  schemeAttr,
  themeAttr,
  toMapScheme,
  toScheme,
  toTheme,
} from '../src/views/appearance'

describe('coercion', () => {
  it('accepts every member', () => {
    for (const t of THEMES) expect(toTheme(t)).toBe(t)
    for (const s of SCHEMES) expect(toScheme(s)).toBe(s)
  })

  // A rider who has never opened their preferences has no user_profiles row, so
  // undefined arrives here as often as a value does.
  it('falls back to the default for anything else', () => {
    for (const bad of [undefined, null, '', 'nope', 42, {}, 'DEFAULT', 'Dark']) {
      expect(toTheme(bad)).toBe(DEFAULT_THEME)
      expect(toScheme(bad)).toBe(DEFAULT_SCHEME)
    }
  })

  it('defaults to system, not light', () => {
    // Defaulting to light would be a decision made on the rider's behalf that
    // their own device has already answered.
    expect(DEFAULT_SCHEME).toBe('system')
  })
})

describe('what gets stamped on <html>', () => {
  it('stamps nothing for the default theme, which is the bare :root block', () => {
    expect(themeAttr('default')).toBe(null)
  })

  it('stamps the other two themes', () => {
    expect(themeAttr('contrast')).toBe('contrast')
    expect(themeAttr('colorblind')).toBe('colorblind')
  })

  // See the header. This one is not tidiness.
  it('stamps NOTHING for system, so prefers-color-scheme can answer', () => {
    expect(schemeAttr('system')).toBe(null)
  })

  it('stamps an explicit choice, which must beat the OS setting', () => {
    expect(schemeAttr('light')).toBe('light')
    expect(schemeAttr('dark')).toBe('dark')
  })
})

describe('the preference page offers exactly what the enums allow', () => {
  // The choices and the enum are two lists that have to agree; a member with no
  // radio is unreachable and a radio with no member coerces away to the default
  // on save, which reads as the form not working.
  it('offers every theme, in order', () => {
    expect(THEME_CHOICES.map((c) => c.id)).toEqual([...THEMES])
  })

  it('offers every scheme, in order', () => {
    expect(SCHEME_CHOICES.map((c) => c.id)).toEqual([...SCHEMES])
  })

  it('gives every choice a label and a hint', () => {
    for (const c of [...THEME_CHOICES, ...SCHEME_CHOICES]) {
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.hint.length).toBeGreaterThan(0)
    }
  })
})

// THE MAP'S OWN AXIS (2026-09-14). The one rule that matters is the same
// absence rule `system` carries: map-common.js reads `data-map-scheme` first
// and falls through to `data-scheme` and the OS, so `follow` has to stamp
// nothing — a stamped "follow" would be a value the map has to know to skip.
describe('the map scheme', () => {
  it('accepts every member and falls back to follow', () => {
    for (const m of MAP_SCHEMES) expect(toMapScheme(m)).toBe(m)
    for (const bad of [undefined, null, '', 'system', 'DARK', 42]) expect(toMapScheme(bad)).toBe(DEFAULT_MAP_SCHEME)
  })

  it('defaults to following the page, so a dark rider gets dark tiles unasked', () => {
    expect(DEFAULT_MAP_SCHEME).toBe('follow')
  })

  it('stamps nothing for follow and the value for the other two', () => {
    expect(mapSchemeAttr('follow')).toBe(null)
    expect(mapSchemeAttr('light')).toBe('light')
    expect(mapSchemeAttr('dark')).toBe('dark')
  })

  it('offers every member exactly once', () => {
    expect(MAP_SCHEME_CHOICES.map((c) => c.id)).toEqual([...MAP_SCHEMES])
  })
})
