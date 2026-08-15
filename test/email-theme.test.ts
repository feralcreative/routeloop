// The email palette, pinned to the SCSS it was copied from.
//
// src/emails/theme.ts duplicates a handful of hex values out of
// style/_tokens.scss because SCSS is not importable from TypeScript. That
// duplication is only safe if something fails when the two drift, which is this
// file. Same arrangement as the FAQ id contract in content.test.ts: hold the
// contract in a test rather than building machinery to enforce it.
//
// If this fails because a token was deliberately restyled, update theme.ts to
// match — do not update the expectation here, because the expectation IS
// _tokens.scss.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ALL_EMAILS } from '../src/emails/index'
import { renderEmail } from '../src/emails/shell'
import { COLORS, PALETTE, TOKEN_COLORS } from '../src/emails/theme'

const SCSS = readFileSync('style/_tokens.scss', 'utf8')

/** `$name: #hex;` — the only form the mirrored values take. Aliases like
 *  `$brand: $url` and functions like rgba() are deliberately not matched, and
 *  nothing in TOKEN_COLORS is allowed to need them. */
function tokenHex(name: string): string | undefined {
  const m = SCSS.match(new RegExp(`^\\$${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`, 'm'))
  return m?.[1]?.toLowerCase()
}

describe('the email palette mirrors style/_tokens.scss', () => {
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
    expect(SCSS).toMatch(/^\$url:\s*\$disabled\s*;/m)
  })

  it('$brand is still an alias of $url, so the accent has one source', () => {
    expect(SCSS).toMatch(/^\$brand:\s*\$url\s*;/m)
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
  it('$text is still an alias of $neutral-21', () => {
    expect(SCSS).toMatch(/^\$text:\s*\$neutral-21\s*;/m)
  })

  it('$grey is still an alias of $neutral-88', () => {
    expect(SCSS).toMatch(/^\$grey:\s*\$neutral-88\s*;/m)
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
