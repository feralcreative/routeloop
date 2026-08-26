// THE CONTRAST AUDIT, MEASURED — #102's last open item.
//
// `style/_palette.scss` said its own figures were reasoned rather than measured,
// and said so in the file, because the derivations are SIGNED: `$pending` is
// `color.adjust($warning, -20%)` on a light scheme and `+20%` on a dark one, and
// +20% on a dark ground and -20% on a light one do not land on the same ratio.
// Six palettes therefore need six sets of numbers and none of them can be
// inferred from the light default. This file is those numbers.
//
// IT IS AN ENFORCEMENT, NOT A REPORT. The thing that made the audit owed in the
// first place is that nothing failed when a value was wrong — the seventeen
// broken tints on this branch compiled clean and shipped. A ratio written into a
// comment goes stale the first time somebody nudges a hue; a ratio asserted here
// cannot.
//
// WHAT IS NOT CHECKED, and why. Every pair below is one the app actually paints:
// a legend on its own sign field, body text on the page, a derived text color on
// the surface it sits on. Most tokens are never a foreground — `$grey` is every
// hairline, `$white` is every card — and holding those to 4.5:1 would fill the
// suite with alarms for things working exactly as intended. That judgment is the
// same one src/routes/brand.tsx makes about which chips to mark.
import { describe, expect, it } from 'vitest'
import { contrast } from '../src/views/tokens'
import { PALETTE_KEYS, palette, token, type PaletteKey } from './helpers/palettes'

const AA = 4.5

// The ink-pairing table from _tokens.scss, which is copied off real signs rather
// than chosen: a sign never picks its legend color by taste. Both legends are
// scheme-invariant literals in all six palettes — a yield sign takes black ink at
// night too — so these pairs are the field moving and the ink standing still.
const WHITE_LEGEND = ['stop', 'interstate', 'disabled', 'tarmac', 'recreation']
const BLACK_LEGEND = ['warning', 'yield', 'detour', 'speed']

// $go is the green traffic signal and $concrete the post: neither carries a
// legend on a real sign, and both are dark enough for black and too light for
// white. They follow the black-legend group wherever the app puts type on them.
const BLACK_LEGEND_BY_LUMINANCE = ['go', 'concrete']

// Text tokens, each against the surface it is actually set on. `--white` is the
// page surface rather than the color white — under the dark scheme it is the
// page's own near-black — which is exactly why these are read out of the palette
// rather than written as hexes.
const TEXT_ON_SURFACE = ['text', 'neutral-21', 'neutral-29', 'neutral-36', 'neutral-43']

describe('every palette is emitted at all', () => {
  it('has all six', () => {
    expect(PALETTE_KEYS).toHaveLength(6)
    for (const key of PALETTE_KEYS) expect(palette(key).size).toBeGreaterThan(50)
  })

  // THE FAILURE THIS BRANCH ALREADY SHIPPED ONCE, generalized. `rgba($token, .06)`
  // compiles to `rgba(var(--x), .06)`, which is invalid CSS, and the declaration
  // is dropped silently — seventeen tints were broken that way and the build
  // succeeded throughout. A palette entry that still contains a `var()` is the
  // same mistake one level earlier: it means a value was derived from a token
  // rather than from a real color.
  it.each(PALETTE_KEYS)('%s emits real values, never a var()', (key: PaletteKey) => {
    for (const [name, value] of palette(key)) {
      expect(value, `--${name}`).not.toMatch(/var\(/)
      // A hex, a functional color, or one of the two keywords Sass shortens to.
      // Anything else is a value that reached the palette without being a color.
      expect(value, `--${name}`).toMatch(/^(#[0-9a-f]{3,8}|rgba?\(|color-mix\(|black$|white$)/i)
    }
  })

  // The rule at the top of _tokens.scss, which has no build error behind it: a
  // token declared there as `var(--x)` with no `--x` in the palette compiles to
  // a property that resolves to nothing, and the declaration silently drops.
  it('defines every custom property _tokens.scss references', async () => {
    const { readFileSync } = await import('node:fs')
    // Comments stripped first. The file's header explains the mechanism with a
    // worked example — "compiles to `background: var(--x)`" — and scanning the raw
    // text pulls `--x` in as a token nothing defines.
    const scss = readFileSync('style/_tokens.scss', 'utf8').replace(/^\s*\/\/.*$/gm, '')
    const referenced = [...scss.matchAll(/var\(--([a-z0-9-]+)\)/gi)].map((m) => m[1])
    expect(referenced.length).toBeGreaterThan(50)

    for (const key of PALETTE_KEYS) {
      const p = palette(key)
      for (const name of referenced) expect(p.has(name), `${key} is missing --${name}`).toBe(true)
    }
  })
})

describe.each(PALETTE_KEYS)('%s', (key: PaletteKey) => {
  const inkLight = () => token(key, 'ink-light')
  const inkDark = () => token(key, 'ink-dark')
  const surface = () => token(key, 'white')

  // The legends do not follow the scheme, and this is the assertion that keeps
  // them from being "fixed" into following it. Inverting $ink-dark put white ink
  // on the yield yellow at 1.4:1 during this branch's own development.
  it('keeps both legends as literal white and black', () => {
    expect(inkLight()).toBe('#ffffff')
    expect(inkDark()).toBe('#000000')
  })

  it.each(WHITE_LEGEND)('%s carries a white legend at 4.5:1', (name: string) => {
    expect(contrast(token(key, name), inkLight())!).toBeGreaterThanOrEqual(AA)
  })

  it.each([...BLACK_LEGEND, ...BLACK_LEGEND_BY_LUMINANCE])(
    '%s carries a black legend at 4.5:1',
    (name: string) => {
      expect(contrast(token(key, name), inkDark())!).toBeGreaterThanOrEqual(AA)
    },
  )

  // Every field takes ONE ink. This is the other half of the pairing table and
  // the reason it is not a preference: a field that cleared both would mean the
  // table had a choice in it, and none of them does.
  it.each(WHITE_LEGEND)('%s fails on the other ink, which is why the table exists', (name: string) => {
    expect(contrast(token(key, name), inkDark())!).toBeLessThan(AA)
  })

  it.each(TEXT_ON_SURFACE)('%s reads as body text on the page surface', (name: string) => {
    expect(contrast(token(key, name), surface())!).toBeGreaterThanOrEqual(AA)
  })

  // The two signed derivations, which are the whole reason the audit could not be
  // inferred from the light palette. Both are amber pushed toward the ink so it
  // survives as TEXT — `$label` is named against $warning rather than the
  // brighter $yield deliberately, because the same expression against $yield
  // lands on 3.7:1 and fails.
  it.each(['pending', 'label'])('%s survives as text on the page surface', (name: string) => {
    expect(contrast(token(key, name), surface())!).toBeGreaterThanOrEqual(AA)
  })

  // $url is the app's generic accent and is a link color everywhere.
  it('keeps links legible on the page surface', () => {
    expect(contrast(token(key, 'url'), surface())!).toBeGreaterThanOrEqual(AA)
  })
})

// THE TWO COLORS BAKED INTO DATA URIs, which are the only places in the app a
// color cannot be a custom property — a data URI has no access to one. Both were
// left open when the theme engine landed and both are answered here rather than
// left as a comment somebody has to trust.
describe('the colors that cannot be themed', () => {
  // The sign arrow in _chrome.scss, `fill='%23fff'`. It is a LEGEND on a sign
  // field and a legend is scheme-invariant, so a baked white is not a compromise
  // — it is the ink-pairing rule. The per-palette assertion that --ink-light is
  // literally #ffffff is what makes this true rather than lucky.
  it.each(PALETTE_KEYS)('%s keeps the arrow legend white', (key: PaletteKey) => {
    expect(token(key, 'ink-light')).toBe('#ffffff')
  })

  // The pencil in _builder.scss, `stroke='%23777777'`. This one IS luck: #777777
  // is $neutral-50 on the light ramp and the dark ramp puts $neutral-50 one step
  // away at #888888, so the same literal reads on both. Re-space the ramp and
  // that stops being true silently, which is what this measures.
  it.each(PALETTE_KEYS)('%s keeps the baked pencil grey visible on its field', (key: PaletteKey) => {
    expect(contrast('#777777', token(key, 'white'))!).toBeGreaterThanOrEqual(3)
  })
})

// The claim each non-default theme makes, asserted as a comparison rather than as
// a threshold. "High contrast" that merely also clears 4.5:1 has not done
// anything; the point is that the pairs which only just clear it stop only just
// clearing it.
describe('the themes do what they are named for', () => {
  const pairs: [string, 'ink-light' | 'ink-dark'][] = [
    ...WHITE_LEGEND.map((n) => [n, 'ink-light'] as [string, 'ink-light']),
    ...BLACK_LEGEND.map((n) => [n, 'ink-dark'] as [string, 'ink-dark']),
  ]

  it.each(['light', 'dark'] as const)('high contrast beats the default on every sign field (%s)', (scheme) => {
    const base = `default-${scheme}` as PaletteKey
    const hi = `contrast-${scheme}` as PaletteKey
    for (const [name, ink] of pairs) {
      const before = contrast(token(base, name), token(base, ink))!
      const after = contrast(token(hi, name), token(hi, ink))!
      expect(after, `--${name} on --${ink}`).toBeGreaterThanOrEqual(before)
    }
  })

  // THE COLLISIONS THE PALETTE HAS BY CONSTRUCTION. $stop and $go are a red/green
  // pair and $yield and $detour are adjacent ambers; both converge under
  // deuteranopia and protanopia. The colorblind theme pulls "go" toward blue and
  // "stop" toward orange-red so the pair separates on the blue-yellow axis, which
  // both common forms leave intact.
  //
  // Measured as a BLUE-YELLOW separation, because that is the claim. A hue
  // distance would pass for two colors a dichromat still cannot tell apart.
  const blueYellow = (hex: string) => {
    // The b* axis of a rough Lab: positive is yellow, negative is blue. Enough to
    // say two colors sit on opposite sides of it, which is all that is asserted.
    const n = parseInt(hex.slice(1), 16)
    const lin = (v: number) => {
      const c = v / 255
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    const r = lin((n >> 16) & 255)
    const g = lin((n >> 8) & 255)
    const b = lin(n & 255)
    return 0.5 * (r + g) - b
  }

  it.each(['light', 'dark'] as const)('colorblind separates stop from go on blue-yellow (%s)', (scheme) => {
    const key = `colorblind-${scheme}` as PaletteKey
    const stop = blueYellow(token(key, 'stop'))
    const go = blueYellow(token(key, 'go'))
    expect(stop).toBeGreaterThan(0)
    expect(go).toBeLessThan(0)

    // And that it is an improvement, not just a difference.
    const base = `default-${scheme}` as PaletteKey
    const spread = (k: PaletteKey) => Math.abs(blueYellow(token(k, 'stop')) - blueYellow(token(k, 'go')))
    expect(spread(key)).toBeGreaterThan(spread(base))
  })

  // THE AMBERS ARE A FLOOR, NOT A COMPARISON, and the measurement is why.
  //
  // #102 named `$yield` and `$detour` as a collision the colorblind theme should
  // address, alongside the red/green pair. Measured, they are not the same kind
  // of problem: hue is what separates $stop from $go and hue is what dichromacy
  // takes away, but the two ambers are separated by LIGHTNESS — 15.59:1 against
  // 6.59:1 in the default palette — and lightness survives every form of color
  // blindness there is. The default pair is already distinguishable, and the
  // colorblind palette's ambers are slightly LESS separated than the default's
  // (6.56 against 9.00) because it lightens the orange.
  //
  // So the requirement is a floor every palette has to clear, not an improvement
  // the colorblind theme has to make over the default. Asserting the improvement
  // would have forced a change to a palette that was not broken.
  it.each(PALETTE_KEYS)('%s keeps the two ambers apart on lightness', (key: PaletteKey) => {
    const gap = Math.abs(contrast(token(key, 'yield'), '#000000')! - contrast(token(key, 'detour'), '#000000')!)
    expect(gap).toBeGreaterThan(3)
  })
})
