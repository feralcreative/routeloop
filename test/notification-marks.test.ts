// EVERY NOTIFICATION MARK'S DECLARED INK IS THE ONE THE PALETTE MEASURES.
//
// **WHY THIS EXISTS.** The disc field and the knockout ink used to be `[data-tone]`
// rules in `_account.scss`, so `test/sign-legend.test.ts` could read the pairing
// straight out of the compiled sheet. They are declared in TypeScript now
// (`src/notifications/marks.ts`) and reach the element as an inline style, which
// is invisible to a test that compiles CSS — so the guard has to move rather
// than lapse. This is that guard, and it is stronger than the one it replaces:
// the old one asked only whether a black-legend tone named SOME ink, and this
// one asks whether the ink named is the RIGHT one, per field, in all six.
//
// **THE FAILURE IT PREVENTS IS #282 BY ANOTHER DOOR.** A hue nudged in
// `_palette.scss` can flip which ink a field carries, and nothing about that is
// visible in a diff of the palette — the mark keeps rendering, just with
// near-invisible ink on a saturated ground, which is exactly what a white glyph
// on `$yield` (1.23:1) looks like.
//
// **IT COMPILES THE SCSS rather than reading `public/style/main.min.css`**, for
// the reason `test/helpers/palettes.ts` records: that file is a gitignored build
// artifact and CI does not build SCSS, so a test reading it would pass here and
// fail on every pull request.
import { describe, expect, it } from 'vitest'
import { PALETTE_KEYS, palettes, type PaletteKey } from './helpers/palettes'
import { contrast } from '../src/views/tokens'
import { FORCE_WHITE, legendFor } from '../src/views/legend'
import { BLACK_GLYPH_FIELDS, DEFAULT_FIELD, MARK_FIELD, fieldFor, markStyle } from '../src/notifications/marks'
import { EVENTS } from '../src/notifications/catalog'

const P = palettes()

/** One token's value in a palette, or a loud failure — never a silent skip. */
function token(key: PaletteKey, name: string): string {
  const v = P.get(key)?.get(name)
  if (!v) throw new Error(`${key} has no --${name}`)
  return v
}

/** Worst white and black ratios for a field across every palette. */
function worst(name: string): { white: number; black: number } {
  let white = Infinity
  let black = Infinity
  for (const key of PALETTE_KEYS) {
    const v = token(key, name)
    white = Math.min(white, contrast(v, '#ffffff')!)
    black = Math.min(black, contrast(v, '#000000')!)
  }
  return { white, black }
}

/** Every field the centre can paint: each mark's, plus every event override. */
const FIELDS = [...new Set([...Object.values(MARK_FIELD), ...EVENTS.map((e) => fieldFor(e)), DEFAULT_FIELD])].sort()

describe('the notification mark fields', () => {
  it('are a real set, or the sweeps below assert nothing', () => {
    expect(FIELDS.length).toBeGreaterThan(5)
    expect(Object.keys(MARK_FIELD).length).toBeGreaterThanOrEqual(10)
  })

  // A field that clears NEITHER ink at 4.5:1 is not a sign field, and a disc
  // painted in one has no legible legend in any color.
  it.each(FIELDS)('$%s is a field a legend can sit on', (name: string) => {
    const { white, black } = worst(name)
    expect(
      legendFor(name, white, black),
      `--${name}: white ${white.toFixed(2)}, black ${black.toFixed(2)}`,
    ).not.toBeNull()
  })

  // THE ASSERTION THIS FILE IS FOR. What marks.ts declares must equal what the
  // compiled palette measures, field by field.
  it.each(FIELDS)('$%s declares the ink the palette measures', (name: string) => {
    const { white, black } = worst(name)
    const declared = BLACK_GLYPH_FIELDS.has(name) && !FORCE_WHITE.has(name) ? 'black' : 'white'
    expect(legendFor(name, white, black), `--${name}: white ${white.toFixed(2)}, black ${black.toFixed(2)}`).toBe(
      declared,
    )
  })

  // The other direction: a name in BLACK_GLYPH_FIELDS that no mark uses is a
  // line nobody reads, and the set stops describing the centre.
  it.each([...BLACK_GLYPH_FIELDS])('$%s is actually painted by a mark', (name: string) => {
    expect(FIELDS).toContain(name)
  })

  // STORAGE IS THE ONE MARK ON TWO FIELDS, and it is the distinction the
  // tone-keyed scheme got right. If this collapses to one, the quota warning and
  // the two destructions have stopped being told apart.
  it('keeps the storage mark on two fields', () => {
    const fields = new Set(EVENTS.filter((e) => e.icon === 'storage').map((e) => fieldFor(e)))
    expect([...fields].sort()).toEqual(['stop', 'yield'])
  })

  // Every other mark is ONE color. Two rows drawing the same disc in two colors
  // reads as a bug rather than a distinction — the surviving half of the
  // 2026-09-07 reasoning.
  it('gives every other mark exactly one field', () => {
    const multi: string[] = []
    for (const mark of new Set(EVENTS.map((e) => e.icon))) {
      if (mark === 'storage') continue
      const fields = new Set(EVENTS.filter((e) => e.icon === mark).map((e) => fieldFor(e)))
      if (fields.size > 1) multi.push(`${mark}: ${[...fields].join(', ')}`)
    }
    expect(multi).toEqual([])
  })

  // Every event resolves, and an unknown one falls back rather than throwing —
  // a stored row whose key left the catalog is an ordinary state, per isEvent().
  it('resolves a field for every event and for none', () => {
    for (const e of EVENTS) expect(FIELDS).toContain(fieldFor(e))
    expect(fieldFor(null)).toBe(MARK_FIELD.info)
  })

  // THE INK IS ALWAYS WRITTEN. Leaving it to icon.ts's `#fff` default would
  // inherit a black ink from any ancestor that had set one, silently.
  it.each(EVENTS.map((e) => [e.key, e] as const))('%s writes both halves of the style', (_key, e) => {
    const style = markStyle(e)
    expect(style).toMatch(/^color:var\(--[a-z0-9-]+\);--icon-ink:var\(--ink-(light|dark)\)$/)
  })

  // A LEGEND DOES NOT FOLLOW THE PAGE, which is #282 and what
  // test/sign-legend.test.ts exists for. --white is the page SURFACE and is the
  // page's own near-black under a dark scheme; a sign takes black ink at night
  // too, so the ink may only ever be a sign token.
  it('never inks a mark with a page-surface token', () => {
    for (const e of EVENTS) expect(markStyle(e)).not.toMatch(/--icon-ink:var\(--(white|black|neutral-\d+)\)/)
  })
})
