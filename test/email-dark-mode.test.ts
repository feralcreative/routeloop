// Dark mode, and the logo assets it swaps.
//
// The light design is asserted everywhere else — emails.test.ts renders every
// template and checks the things that are fatal in an inbox. This file covers
// the half that only exists in a client with dark mode turned on, which is the
// half nobody looks at: a broken dark rule produces a message that is perfect in
// every screenshot anyone takes and unreadable for the people who happen to have
// the setting on.
//
// Three things can rot here, and each has a test below rather than a comment:
//
//   1. A new primitive in shell.tsx gets a `tb-` class and no rule in the media
//      block, so it stays dark-on-dark.
//   2. Someone redraws a logo on a different ground. The wordmark is an OPAQUE
//      PNG deliberately, so its own ground has to match the card exactly — a
//      mismatch is a visible rectangle, and it is visible on precisely the
//      screens dark mode is read on.
//   3. A dark grey gets nudged until it no longer contrasts.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { APP_ORIGIN } from '../src/config'
import { ALL_EMAILS } from '../src/emails/index'
import { renderEmail } from '../src/emails/shell'
import { COLORS, DARK } from '../src/emails/theme'

const { html } = renderEmail(ALL_EMAILS[0], ALL_EMAILS[0].sample)

/** The @media (prefers-color-scheme: dark) block, brace-matched out of <style>. */
const darkBlock = (() => {
  const start = html.indexOf('@media (prefers-color-scheme: dark)')
  expect(start, 'there is no dark-mode block at all').toBeGreaterThan(-1)
  let depth = 0
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1)
  }
  throw new Error('unbalanced braces in the dark-mode block')
})()

describe('the dark-mode block', () => {
  // The whole arrangement rests on this. An inline style beats a stylesheet
  // rule, and every one of these elements carries its light color inline, so a
  // rule that loses its !important silently stops applying.
  it('marks every declaration !important', () => {
    const decls = [...darkBlock.matchAll(/[\w-]+\s*:\s*[^;{}]+;/g)].map((m) => m[0])
    expect(decls.length).toBeGreaterThan(0)
    const weak = decls.filter((d) => !d.includes('!important'))
    expect(weak, `these lose to the inline style they are meant to override: ${weak.join(' ')}`).toEqual([])
  })

  // The failure this exists for: someone adds a primitive to shell.tsx, gives it
  // a class out of habit, and never writes the rule. Nothing else would notice.
  it('has a rule for every tb- class in the document', () => {
    const used = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))
    const styled = new Set([...darkBlock.matchAll(/\.(tb-[\w-]+)/g)].map((m) => m[1]))
    // tb-pad is the mobile padding hook and has nothing to say about color.
    const missing = [...used].filter((c) => c !== 'tb-pad' && !styled.has(c))
    expect(missing, `no dark rule for: ${missing.join(', ')}`).toEqual([])
  })

  // Light values are inline and must stand alone; dark values must never be. A
  // dark hex on an element is a message that renders dark for everyone.
  it('is the only place the dark palette appears', () => {
    const outside = html.replace(darkBlock, '')
    for (const [name, hex] of Object.entries(DARK)) {
      // pageBg is $splash-ink, which nothing else in an email uses; cardBg is
      // #000, which would also match a stray shorthand. Both are checked as
      // whole tokens rather than substrings.
      const stray = new RegExp(`${hex}\\b`, 'i').test(outside)
      expect(stray, `DARK.${name} (${hex}) is inline somewhere, not just in the media block`).toBe(false)
    }
  })
})

describe('the wordmark', () => {
  const LIGHT = `${APP_ORIGIN}/img/logo-routeloop-email-hz@2x.png`
  const DARK_SRC = `${APP_ORIGIN}/img/logo-routeloop-email-hz-dark@2x.png`

  for (const t of ALL_EMAILS) {
    it(`${t.key} carries both copies, absolute`, () => {
      const { html: h } = renderEmail(t, t.sample)
      expect(h).toContain(`src="${LIGHT}"`)
      expect(h).toContain(`src="${DARK_SRC}"`)
    })
  }

  // A logo is the one element guaranteed not to render on first open, because
  // images are blocked by default in a large share of clients. Both copies carry
  // the wordmark as alt text so the header reads with images off.
  it('puts the wordmark in alt text on both copies', () => {
    const alts = [...html.matchAll(/<img[^>]*\balt="([^"]*)"/g)].map((m) => m[1])
    expect(alts).toHaveLength(2)
    for (const alt of alts) expect(alt).toBe('RouteLoop')
  })

  // Hidden by default and revealed by the query, never the reverse: a client
  // that drops the <style> block has to land on the light copy, not both.
  it('hides the dark copy by default and reveals it only in the query', () => {
    expect(html).toMatch(/class="tb-logo-dark" style="display:none;mso-hide:all/)
    expect(darkBlock).toMatch(/\.tb-logo-dark\s*\{[^}]*display:\s*block\s*!important/)
    expect(darkBlock).toMatch(/\.tb-logo-light\s*\{[^}]*display:\s*none\s*!important/)
  })
})

// Reads the actual pixel, rather than trusting a note in a comment that the
// asset is opaque and its ground is #000.
describe('the logo assets', () => {
  /**
   * The top-left pixel of a PNG, as #rrggbb.
   *
   * Only the first pixel of the first scanline, which is the one pixel that
   * needs no filter reconstruction: every PNG filter type predicts from the
   * pixel to the left and the scanline above, both of which are defined as zero
   * there, so all five reduce to the raw byte. That is what makes this ~20 lines
   * instead of a decoder — and the ground is what is being checked, so a corner
   * is the right sample.
   */
  function groundOf(path: string): string {
    const buf = readFileSync(path)
    expect(buf.subarray(0, 8).toString('hex'), `${path} is not a PNG`).toBe('89504e470d0a1a0a')

    let idat = Buffer.alloc(0)
    let ihdr: Buffer | undefined
    for (let i = 8; i < buf.length; ) {
      const len = buf.readUInt32BE(i)
      const type = buf.subarray(i + 4, i + 8).toString('ascii')
      const data = buf.subarray(i + 8, i + 8 + len)
      if (type === 'IHDR') ihdr = data
      else if (type === 'IDAT') idat = Buffer.concat([idat, data])
      i += 12 + len
    }
    if (!ihdr) throw new Error(`${path} has no IHDR`)

    const [depth, colorType, , , interlace] = [ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12]]
    // The shortcut above is only valid for these. If an export ever changes
    // them, this must fail rather than quietly read the wrong bytes.
    expect(depth, `${path}: expected 8-bit`).toBe(8)
    expect([2, 6], `${path}: expected RGB or RGBA`).toContain(colorType)
    expect(interlace, `${path}: expected non-interlaced`).toBe(0)

    const px = inflateSync(idat).subarray(1, 4) // skip the scanline's filter byte
    return `#${px.toString('hex')}`
  }

  // The reason cardBg is pinned to pure black. These are opaque PNGs, so each
  // one's own ground shows wherever the card does not match it exactly.
  it('the dark logo is drawn on the dark card color', () => {
    expect(groundOf('_assets/logo-routeloop-email-hz-dark@2x.png')).toBe('#000000')
    expect(DARK.cardBg).toBe('#000')
  })

  it('the light logo is drawn on the light card color', () => {
    expect(groundOf('_assets/logo-routeloop-email-hz@2x.png')).toBe('#ffffff')
    expect(COLORS.white).toBe('#fff')
  })

  // _assets holds the artwork; public/img is what /img/* actually serves. The
  // email points at the served copy, so updating only the source ships nothing.
  for (const name of ['logo-routeloop-email-hz@2x.png', 'logo-routeloop-email-hz-dark@2x.png']) {
    it(`${name} is identical in _assets and public/img`, () => {
      const src = readFileSync(`_assets/${name}`)
      const served = readFileSync(`public/img/${name}`)
      expect(served.equals(src), `public/img/${name} has drifted from _assets/${name}`).toBe(true)
    })
  }
})

// Encodes the reasoning in theme.ts as arithmetic, so a grey cannot be nudged
// into illegibility by eye.
describe('the dark palette is legible on the dark card', () => {
  const luminance = (hex: string): number => {
    const h = hex.replace('#', '')
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
    const [r, g, b] = [0, 2, 4].map((i) => {
      const c = Number.parseInt(full.slice(i, i + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  // 4.5:1 for all three: every one of them is used at body size or smaller —
  // muted is 13px in the footer — so none qualifies for the 3:1 large-text bar.
  it.each([
    ['text', DARK.text],
    ['muted', DARK.muted],
    ['url', DARK.url],
  ])('DARK.%s clears 4.5:1 on the card', (_name, hex) => {
    expect(contrast(hex, DARK.cardBg)).toBeGreaterThanOrEqual(4.5)
  })

  // The specific mistake this rules out: reusing a light-mode value because it
  // is already in the palette. Both of these are comfortably legible on white
  // and fail on black, which is the trap.
  it.each([
    ['muted', COLORS.muted],
    ['url', COLORS.url],
  ])('the light-mode %s would NOT have cleared it', (_name, hex) => {
    expect(contrast(hex, DARK.cardBg)).toBeLessThan(4.5)
  })
})
