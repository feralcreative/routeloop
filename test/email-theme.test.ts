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
import { PALETTE, TOKEN_COLORS } from '../src/emails/theme'

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

  // $brand is a one-level alias of $url (_tokens.scss:20), which is why the
  // emails mirror `url` and not `brand`. Asserted so that if someone gives
  // $brand its own value, this stops being a safe substitution and says so.
  it('$brand is still an alias of $url, so mirroring `url` is correct', () => {
    expect(SCSS).toMatch(/^\$brand:\s*\$url\s*;/m)
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
