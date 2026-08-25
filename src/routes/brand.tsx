// The brand page: every color the app defines, read live from the SCSS.
//
// Internal, and signed-in only. Not because the palette is a secret — it ships
// in a stylesheet anyone can fetch — but because it is a workbench, not a page
// with an audience, and a public route implies a promise to keep it presentable.
//
// It is deliberately an audit rather than a swatch chart. The palette is known
// to be too large and partly arbitrary, so the page leads with the parts that
// answer "what can go": each token's own comment explaining why it exists, and
// the list of hexes written straight into a partial with no name at all.
import { Hono } from 'hono'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { page } from '../views/layout'
import { esc } from '../views/esc'
import { contrast, readTokens, type Literal, type Token } from '../views/tokens'
import { DAY_COLORS } from '../maps/palette'

export const brandRoutes = new Hono<AuthEnv>()

// The two grounds the app actually paints text on. Measuring against anything
// else would be theater: $white is every card, panel and input, and $neutral-96
// is the chrome page ground under all of them.
//
// READ OUT OF THE PALETTE, not written as hexes. Under the dark scheme `--white`
// is the page's own near-black — the token means "the page", not the color — so a
// hardcoded #ffffff here would be measuring a surface the app does not have in
// four of its six palettes. This page reports the DEFAULT LIGHT one; see
// parsePalette() and the note in the body copy below.
const GROUND_TOKENS = [
  { label: 'on surface', token: 'white' },
  { label: 'on page', token: 'neutral-96' },
]

const AA = 4.5

/**
 * Contrast against both grounds.
 *
 * Passing is marked; falling short is not marked as a failure, because most of
 * these colors are never text. $white is the card ground and $grey is every
 * hairline — flagging them red would put two alarms on the page for things that
 * are working exactly as intended, and a page full of false alarms is one
 * nobody reads. The number is shown either way; what it means depends on
 * whether the color is used as a foreground, which the SCSS cannot tell us.
 */
function ratioChips(value: string, palette: ReadonlyMap<string, string>): string {
  const chips = GROUND_TOKENS.map((g) => {
    const ground = palette.get(g.token)
    if (!ground) return ''
    const r = contrast(value, ground)
    if (r === null) return ''
    const cls = r >= AA ? 'is-pass' : 'is-low'
    return `<span class="brand-chip ${cls}"><b>${r.toFixed(2)}:1</b> ${esc(g.label)}</span>`
  }).filter(Boolean)
  return chips.length ? `<span class="brand-chips">${chips.join('')}</span>` : ''
}

function swatch(t: Token, palette: ReadonlyMap<string, string>): string {
  // A value with alpha needs something behind it or it reads as opaque, so the
  // field carries a checkerboard and the color sits on top of it.
  const alpha = t.value.startsWith('rgba(')
  const field = alpha
    ? `<span class="brand-field is-alpha"><span style="background:${esc(t.value)}"></span></span>`
    : `<span class="brand-field" style="background:${esc(t.value)}"></span>`

  return `<li class="brand-swatch">
    ${field}
    <span class="brand-meta">
      <code class="brand-name">$${esc(t.name)}</code>
      <code class="brand-value">${esc(t.value)}${t.raw !== t.value ? ` <span class="brand-alias">${esc(t.raw)}</span>` : ''}</code>
      ${t.note ? `<span class="brand-note" title="${esc(t.note)}">${esc(t.note)}</span>` : ''}
      ${ratioChips(t.value, palette)}
    </span>
  </li>`
}

function literalRow(l: Literal): string {
  return `<tr>
    <td class="brand-hex"><span class="brand-mini" style="background:${esc(l.value)}"></span>${esc(l.value)}</td>
    <td>${l.duplicates ? `<code>$${esc(l.duplicates)}</code>` : '<span class="brand-none">no token</span>'}</td>
    <td class="brand-files">${l.files.map((f) => esc(f.replace(/^_|\.scss$/g, ''))).join(', ')}</td>
    <td class="brand-count">${l.count}</td>
  </tr>`
}

brandRoutes.get('/brand', requireActive, (c) => {
  const user = currentUser(c)
  const { tokens, literals, palette } = readTokens()

  const colors = tokens.filter((t) => t.isColor)
  const others = tokens.filter((t) => !t.isColor)
  const untokenized = literals.filter((l) => !l.duplicates)
  const duplicated = literals.filter((l) => l.duplicates)
  const strayTotal = untokenized.reduce((n, l) => n + l.count, 0)

  // Source order, not a grouping of my invention: the file's own sequence is
  // the closest thing to an intended structure, and it survives a trim pass
  // that a hand-maintained grouping here would not.
  const body = `
    <h1>Brand</h1>
    <p class="lede">
      Every color the app defines, read out of <code>style/_tokens.scss</code> when this page loads. Edit the SCSS
      and reload — there is no copy of these values in the page itself.
    </p>

    <p class="brand-sub">
      Names and comments come from <code>style/_tokens.scss</code>; the values behind them come from the compiled
      stylesheet, because each token there is now a <code>var()</code> reference and the numbers live in
      <code>style/_palette.scss</code>. What you see below is the <strong>default light</strong> palette — one of six.
      The other five are measured by <code>test/palette-contrast.test.ts</code>, which fails the build rather than
      waiting for somebody to open this page.
    </p>

    <p class="brand-summary">
      <strong>${colors.length}</strong> color tokens ·
      <strong>${DAY_COLORS.length}</strong> day colors ·
      <strong>${untokenized.length}</strong> hexes with no token, used <strong>${strayTotal}</strong> times
    </p>

    <h2>Tokens</h2>
    <p class="brand-sub">In the order they appear in the file, each with the comment that explains why it exists.</p>
    <ul class="brand-grid">${colors.map((t) => swatch(t, palette)).join('')}</ul>

    <h2>Day palette</h2>
    <p class="brand-sub">
      From <code>src/maps/palette.ts</code>, walked in order so a multi-day ride gets distinct days without the rider
      picking each one. A ride longer than ${DAY_COLORS.length} days wraps and repeats.
    </p>
    <ol class="brand-days">
      ${DAY_COLORS.map(
        (hex, i) => `<li class="brand-day">
          <span class="brand-dot" style="background:${esc(hex)}"></span>
          <span class="brand-day-meta"><b>Day ${i + 1}</b><code>${esc(hex)}</code></span>
        </li>`,
      ).join('')}
    </ol>

    <h2>Hexes with no token</h2>
    <p class="brand-sub">
      Written straight into a partial. This is the trim list — most of it is near-identical grays doing the same job,
      and <code>#f4f4f4</code>, the ground every signed-in page sits on, has no name at all.
    </p>
    <div class="brand-table-wrap">
      <table class="brand-table">
        <thead><tr><th>Value</th><th>Token</th><th>In</th><th class="brand-count">Uses</th></tr></thead>
        <tbody>${untokenized.map(literalRow).join('')}</tbody>
      </table>
    </div>

    <h2>Hexes that duplicate a token</h2>
    <p class="brand-sub">These already have a name. Each one is a place the token could be used instead.</p>
    <div class="brand-table-wrap">
      <table class="brand-table">
        <thead><tr><th>Value</th><th>Token</th><th>In</th><th class="brand-count">Uses</th></tr></thead>
        <tbody>${duplicated.map(literalRow).join('')}</tbody>
      </table>
    </div>

    <h2>Not colors</h2>
    <p class="brand-sub">Also in the tokens file, listed so the file's contents are accounted for in one place.</p>
    <ul class="brand-plain">
      ${others.map((t) => `<li><code>$${esc(t.name)}</code> <code>${esc(t.value)}</code></li>`).join('')}
    </ul>

    <p class="brand-foot">
      Contrast is WCAG 2.1, computed on the server. Green marks ${AA}:1 or better, the threshold for normal-size text.
      Anything below is shown plain rather than flagged: large or bold text clears at 3:1, and a color used as a
      ground or a hairline — <code>$white</code> and <code>$grey</code> among them — has no text threshold to meet at all.
    </p>
  `

  return c.html(page({ title: 'Brand', user, body }))
})
