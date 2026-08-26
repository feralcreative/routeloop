// The email palette, pinned to the SCSS it was copied from.
//
// src/emails/theme.ts duplicates a handful of hex values out of the stylesheet
// palette because SCSS is not importable from TypeScript. That duplication is
// only safe if something fails when the two drift, which is this file. Same
// arrangement as the FAQ id contract in content.test.ts: hold the contract in a
// test rather than building machinery to enforce it.
//
// If this fails because a token was deliberately restyled, update theme.ts to
// match — do not update the expectation here, because the expectation IS the
// stylesheet.
//
// **IT READS style/_palette.scss, NOT _tokens.scss, as of 2026-08-24.** The
// values moved when the theme axes landed: _tokens.scss now holds `var(--x)`
// references and the literals live in the palette. Re-pointed rather than
// loosened — a scraper that stopped finding hex values and passed would be worse
// than useless.
//
// **AND IT READS THE DEFAULT LIGHT PALETTE SPECIFICALLY**, which is the right
// one and not merely the convenient one: no mail client supports custom
// properties, so an email cannot follow a rider's theme even in principle.
// theme.ts carries its own DARK map for clients that report a dark preference,
// and that is a separate mechanism from the site's scheme axis.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ALL_EMAILS } from '../src/emails/index'
import { renderEmail } from '../src/emails/shell'
import { COLORS, PALETTE, TOKEN_COLORS } from '../src/emails/theme'

const PALETTE_SCSS = readFileSync('style/_palette.scss', 'utf8')
const TOKENS_SCSS = readFileSync('style/_tokens.scss', 'utf8')

/**
 * The literal hex a token holds in the DEFAULT LIGHT palette.
 *
 * Three forms, because the palette stores three kinds of thing and a scraper
 * that silently matched none of them would pass while proving nothing:
 *
 *   1. `"stop": #dd0000` — a road-sign color, in one of the sign maps.
 *   2. `21: #333333` — a neutral, keyed by its CIE L* number rather than by the
 *      `neutral-21` name the emails use.
 *   3. `$splash-ink: #0a0e11;` — the one token that stayed a real Sass color,
 *      because the splash never themes and Sass still computes scrims from it.
 *
 * Aliases and derived entries are deliberately not matched, and nothing in
 * TOKEN_COLORS is allowed to need them.
 */
function tokenHex(name: string): string | undefined {
  const neutral = name.match(/^neutral-(\d+)$/)
  if (neutral) {
    // Only the LIGHT ramp. The dark one is a separate map further down the file
    // and an email must never mirror it — see the header.
    const light = PALETTE_SCSS.split('$-neutrals-dark')[0]
    return light.match(new RegExp(`\\b${neutral[1]}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1]?.toLowerCase()
  }
  const inMap = PALETTE_SCSS.match(new RegExp(`"${name}":\\s*(#[0-9a-fA-F]{3,8})\\s*[,)]`))
  if (inMap) return inMap[1].toLowerCase()
  for (const src of [PALETTE_SCSS, TOKENS_SCSS]) {
    // Leading whitespace allowed: $white and $black are assigned inside build(),
    // where they are the page surface rather than a sign color.
    const m = src.match(new RegExp(`^\\s*\\$${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`, 'm'))
    if (m) return m[1].toLowerCase()
  }
  return undefined
}

const SCSS = PALETTE_SCSS

describe('the email palette mirrors style/_palette.scss', () => {
  for (const [name, value] of Object.entries(TOKEN_COLORS)) {
    it(`$${name} matches`, () => {
      const scss = tokenHex(name)
      expect(scss, `$${name} is not a plain hex token in style/_tokens.scss`).toBeDefined()
      expect(value.toLowerCase()).toBe(scss)
    })
  }

  // Two one-level aliases sit between the accent's name and its value:
  // `$brand: $url` and `$url: $disabled`. The emails mirror `disabled`, the only
  // one of the three that is a literal hex, and expose it as `COLORS.url`.
  // Both links are asserted so that giving either its own value stops being a
  // silent substitution and says so here instead.
  it('$url is still an alias of $disabled, so mirroring `disabled` is correct', () => {
    expect(SCSS).toMatch(/\$url:\s*\$disabled\s*;/)
  })

  it('$brand is still an alias of $url, so the accent has one source', () => {
    expect(SCSS).toMatch(/"brand":\s*\$url\s*,/)
  })

  // COLORS.url is what the templates read; it must be the mirrored token and not
  // a value of its own.
  it('COLORS.url is the mirrored $disabled', () => {
    expect(COLORS.url).toBe(TOKEN_COLORS.disabled)
  })

  // Same arrangement for the two greys, which became aliases when the neutral
  // scale landed on 2026-08-15: $grey is $neutral-88 and $text is $neutral-21,
  // exactly, so the scale is the only place a grey is written down. The emails
  // mirror the steps and keep the semantic names for the templates.
  it('$text is still the neutral scale step 21', () => {
    expect(SCSS).toMatch(/\$text:\s*map\.get\(\$n,\s*21\)/)
  })

  it('$grey is still the neutral scale step 88', () => {
    expect(SCSS).toMatch(/\$grey:\s*map\.get\(\$n,\s*88\)/)
  })

  it('COLORS.text and COLORS.grey are the mirrored steps', () => {
    expect(COLORS.text).toBe(TOKEN_COLORS['neutral-21'])
    expect(COLORS.grey).toBe(TOKEN_COLORS['neutral-88'])
  })
})

describe('no template invents a color', () => {
  // The point is provenance, not spelling: a hand-written #FFF in one template
  // and the palette's #fff are the same color, and the thing worth catching is
  // a value that came from nowhere.
  const hexesIn = (html: string) => [...html.matchAll(/#[0-9a-f]{3,6}\b/gi)].map((m) => m[0].toLowerCase())

  for (const t of ALL_EMAILS) {
    it(`${t.key} uses only palette colors`, () => {
      const { html } = renderEmail(t, t.sample)
      const strays = [...new Set(hexesIn(html))].filter((h) => !PALETTE.includes(h))
      expect(strays, `add these to src/emails/theme.ts or stop using them: ${strays.join(', ')}`).toEqual([])
    })
  }
})
