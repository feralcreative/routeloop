// THE CATEGORICAL VIZ SLOTS, MEASURED.
//
// `style/_dashboard.scss` said its four categorical hues "were run through the
// data-viz validator" and told the next person not to swap one by eye. There
// was no validator in the repo — the numbers in that comment could not be
// reproduced, re-run, or defended, which is the same failure mode
// test/palette-contrast.test.ts exists to fix one file over. This is the
// validator, and being a test rather than a script means it runs on every push
// instead of whenever somebody remembers.
//
// It compiles the SCSS for its numbers, through the same helper the contrast
// audit uses, for the same reason: the derived values exist only after Sass has
// run, and a second implementation of the color math in TypeScript would
// disagree eventually — and the disagreement would look like a design decision.
//
// WHAT IT ACTUALLY CHECKS. Three things, across all six palettes:
//
//   1. Every pair of the four is distinguishable under normal vision and under
//      the two red-green deficiencies, which together are about 8% of men.
//   2. Every one of the four is distinguishable from the card it is painted on
//      and from the empty-track grey behind it.
//   3. Tritanopia is measured and pinned, and it FAILS a distinguishability bar
//      — see the note on that test. It is pinned so it cannot quietly worsen.
//
// Color is never the only cue on this chart: the legend beside it direct-labels
// every segment with its name and its count. That is what makes point 3 a known
// weakness rather than an unreadable chart, and it is the same argument
// src/maps/role-colors.ts makes about seventeen categories.
import { describe, expect, it } from 'vitest'
import { PALETTE_KEYS, token, type PaletteKey } from './helpers/palettes'

/** The slots, in the order _dashboard.scss assigns them. Token names, because
 *  the value depends on the palette and the assignment does not. */
const CATEGORIES = ['disabled', 'detour', 'interstate', 'concrete']

/** The card the chart is painted on, and the empty part of the track behind a
 *  segment. Both move with the scheme, which is why they are read rather than
 *  written as hexes. */
const SURFACE = 'white'
const TRACK = 'neutral-94'

type Rgb = [number, number, number]

/** Sass emits a hex for an authored literal and `rgb(60%, …)` for anything
 *  color.adjust() produced — the same two spellings contrast() in
 *  src/views/tokens.ts has to read, and for the same reason. */
function parse(value: string): Rgb {
  const hex = value.match(/^#([0-9a-fA-F]{6})$/)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255) as Rgb
  const fn = value.match(/rgba?\(([^)]+)\)/)
  if (!fn) throw new Error(`viz: cannot read color ${value}`)
  const parts = fn[1]
    .split(/[,\s/]+/)
    .filter(Boolean)
    .slice(0, 3)
  return parts.map((p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255)) as Rgb
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055)

// Viénot, Brettel and Mollon 1999 — the standard single-plane projection, on
// linear sRGB through the Hunt-Pointer-Estévez LMS space. Not an approximation
// anyone invented here; the matrices are the published ones.
const RGB_TO_LMS = [
  [0.31399022, 0.63951294, 0.04649755],
  [0.15537241, 0.75789446, 0.08670142],
  [0.01775239, 0.10944209, 0.87256922],
]
const LMS_TO_RGB = [
  [5.47221206, -4.6419601, 0.16963708],
  [-1.1252419, 2.29317094, -0.1678952],
  [0.02980165, -0.19318073, 1.16364789],
]
const DEFICIENCIES = {
  /** Red-blind. ~1% of men. */
  protanopia: [
    [0, 1.05118294, -0.05116099],
    [0, 1, 0],
    [0, 0, 1],
  ],
  /** Green-blind, the commonest. ~1.5% of men, and a further ~5% are anomalous
   *  rather than dichromatic, for whom this is the worst case. */
  deuteranopia: [
    [1, 0, 0],
    [0.9513092, 0, 0.04866992],
    [0, 0, 1],
  ],
  /** Blue-blind. Rare — about 1 in 10,000 — and not sex-linked. */
  tritanopia: [
    [1, 0, 0],
    [0, 1, 0],
    [-0.86744736, 1.86727089, 0],
  ],
} as const

type Deficiency = keyof typeof DEFICIENCIES

const apply = (m: readonly (readonly number[])[], v: readonly number[]) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])

function simulate(rgb: Rgb, kind: Deficiency | 'normal'): Rgb {
  if (kind === 'normal') return rgb
  const lms = apply(RGB_TO_LMS, rgb.map(toLinear))
  return apply(LMS_TO_RGB, apply(DEFICIENCIES[kind], lms))
    .map(toSrgb)
    .map((c) => Math.min(1, Math.max(0, c))) as Rgb
}

/** OKLab, which is perceptually uniform enough that one distance threshold means
 *  the same thing at every lightness — the reason for using it over CIE Lab or
 *  a raw RGB distance. */
function oklab(rgb: Rgb): [number, number, number] {
  const [r, g, b] = rgb.map(toLinear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** Scaled by 100 so the numbers read like the ΔE figures everyone quotes. */
function deltaE(a: Rgb, b: Rgb): number {
  const x = oklab(a)
  const y = oklab(b)
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) * 100
}

/** The closest any two of the four come, across every palette, under one vision. */
function worstPair(kind: Deficiency | 'normal'): { dE: number; where: string } {
  let dE = Infinity
  let where = ''
  for (const key of PALETTE_KEYS) {
    const seen = CATEGORIES.map((name) => simulate(parse(token(key, name)), kind))
    for (let i = 0; i < seen.length; i++) {
      for (let j = i + 1; j < seen.length; j++) {
        const d = deltaE(seen[i], seen[j])
        if (d < dE) {
          dE = d
          where = `${key}: ${CATEGORIES[i]} vs ${CATEGORIES[j]}`
        }
      }
    }
  }
  return { dE, where }
}

function worstAgainst(background: string): { dE: number; where: string } {
  let dE = Infinity
  let where = ''
  for (const key of PALETTE_KEYS) {
    const bg = parse(token(key, background))
    for (const name of CATEGORIES) {
      const d = deltaE(parse(token(key, name)), bg)
      if (d < dE) {
        dE = d
        where = `${key}: ${name} on --${background}`
      }
    }
  }
  return { dE, where }
}

describe('the categorical viz slots', () => {
  it('assigns one token per slot, with no repeats', () => {
    expect(new Set(CATEGORIES).size).toBe(CATEGORIES.length)
  })

  // 7.5 is the floor the current set actually clears, rounded down from 7.70,
  // and it is written as a number this set passes rather than as an aspiration.
  // It is not a standard — there is no agreed ΔE for categorical distinctness —
  // so the useful property is that it cannot silently get worse.
  it.each(['normal', 'protanopia', 'deuteranopia'] as const)('separates every pair under %s', (kind) => {
    const { dE, where } = worstPair(kind)
    expect(dE, `closest pair: ${where}`).toBeGreaterThanOrEqual(7.5)
  })

  // TRITANOPIA FAILS AND IS PINNED ANYWAY, which needs saying plainly rather
  // than being left out of the file.
  //
  // `--disabled` (sign blue) and `--interstate` (sign green) collapse onto each
  // other with the blue cone gone: ΔE 2.05 at worst, against 7.7 under the
  // red-green deficiencies. It is a property of the SIGN PALETTE those two
  // tokens come from, it predates the fourth slot — the fourth slot's own
  // closest pair is 11.0 — and fixing it means either taking the chart off the
  // sign palette or moving a sign color, neither of which is a chart decision.
  //
  // What makes it survivable is that the legend direct-labels every segment
  // with its name and count, so color reinforces identity here and never
  // carries it. Same argument as src/maps/role-colors.ts.
  //
  // Pinned so the number can only be improved deliberately. If a future palette
  // change raises it, this test fails and the floor moves up with it.
  it('records the known tritanopia collapse rather than hiding it', () => {
    const { dE, where } = worstPair('tritanopia')
    expect(dE, `closest pair: ${where}`).toBeGreaterThanOrEqual(2.0)
    expect(where).toContain('disabled vs interstate')
  })

  // A segment nobody can see is not a category. Both grounds are checked
  // because the bar sits on the card and the empty part of the track sits
  // behind it, and a fill that matched either would read as absent.
  it('separates every slot from the card it is painted on', () => {
    const { dE, where } = worstAgainst(SURFACE)
    expect(dE, `closest: ${where}`).toBeGreaterThanOrEqual(18)
  })

  it('separates every slot from the empty track behind it', () => {
    const { dE, where } = worstAgainst(TRACK)
    expect(dE, `closest: ${where}`).toBeGreaterThanOrEqual(8.5)
  })

  // The slots exist in every palette or the chart loses a color in one theme
  // and nothing says so. token() throws on a missing name, which is the assert.
  it.each(PALETTE_KEYS)('defines every slot in %s', (key: PaletteKey) => {
    for (const name of [...CATEGORIES, SURFACE, TRACK]) expect(token(key, name)).toBeTruthy()
  })
})
