// The email palette.
//
// These values are DUPLICATED from style/_tokens.scss rather than imported,
// because SCSS is not importable from TypeScript and the two alternatives are
// both worse: parsing _tokens.scss at runtime puts a file read and a regex on
// the send path (and `$brand: $url` is an alias and `$panel-bg` is an rgba(),
// so the parse is not trivial), while generating this file at build time adds a
// step to a repo whose only build is `npm run sass` — and generated files get
// hand-edited and drift.
//
// The duplication is made safe by test/email-theme.test.ts, which reads
// _tokens.scss as text and fails the moment the two disagree. That is the same
// arrangement test/content.test.ts uses to pin the FAQ id contract: hold the
// contract in a test rather than in machinery.

/**
 * Colors mirrored from `style/_tokens.scss`. The key is the SCSS variable name
 * WITHOUT its `$`, so the pinning test can look each one up directly.
 *
 * Only what the emails actually use. Adding one here means adding it there.
 */
export const TOKEN_COLORS = {
  url: '#1565c0',
  text: '#333',
  white: '#fff',
  grey: '#ddd',
  // The dark surface. Mirrored under its SCSS name rather than a friendlier one
  // because the pinning test looks the key up verbatim; `DARK.cardBg` below is
  // the name the templates actually read.
  'splash-ink': '#0a0e11',
} as const

/**
 * Values with no token behind them, so the pinning test deliberately skips them.
 *
 * `muted` is the one real gap: the site uses a bare `#666` in _splash.scss and
 * _forms.scss without ever naming it, so there is no token to mirror. It is
 * defined here rather than inlined for the same reason the others are — the
 * "every hex in a rendered template is a member of the palette" assertion only
 * works if there is exactly one place a color can come from.
 *
 * `pageBg` is email-only by nature. The site has no equivalent because a web
 * page's body is the canvas; an email's canvas is the client's, and the near-
 * white sits behind the 600px card to give it an edge in clients that show one.
 */
export const EMAIL_ONLY_COLORS = {
  muted: '#666',
  pageBg: '#f4f5f6',
} as const

export const COLORS = { ...TOKEN_COLORS, ...EMAIL_ONLY_COLORS } as const

/**
 * The dark-mode palette, used ONLY inside the `prefers-color-scheme` block in
 * shell.tsx. Nothing here is ever an inline style — see that block's comment for
 * why the light values have to stand alone.
 *
 * `cardBg` IS PURE BLACK AND IS NOT FREE TO CHANGE. The dark wordmark is an
 * opaque PNG whose ground is #000 (checked, uniform across its whole perimeter),
 * so any other value paints a 180x52 rectangle of not-quite-the-right-black into
 * the header. #0a0e11 against #000 is only 1.07:1 — invisible on most screens
 * and clearly visible on an OLED phone in the dark, which is precisely where
 * dark mode gets read. If the asset is ever redrawn on a different ground, this
 * value moves with it.
 *
 * That fixes the rest by knock-on. `pageBg` takes $splash-ink, so the page is
 * the LIGHTER of the two — which looks like an inverted elevation until you
 * notice it mirrors the light design exactly: there the card is the whitest
 * thing on a slightly pulled-back page, here it is the blackest. The card is the
 * extreme in both, and the page is always a step toward the middle.
 *
 * The three greys are the site's own dark-surface values from `_splash.scss`,
 * flattened over #000, because an email cannot use the rgba() they are written
 * as — a translucent color over an unknown backdrop is the "color without a
 * background" mistake the shell's header warns about:
 *
 *   text    rgba(255,255,255,0.88)  (_splash.scss:78)  -> #e0e0e0   15.9:1
 *   muted   rgba(255,255,255,0.72)  (_splash.scss:113) -> #b8b8b8   10.6:1
 *   border  rgba(255,255,255,0.16)  (_splash.scss:80)  -> #292929   hairline
 *
 * That is an anchor rather than a law — the splash page is a photo-backed hero
 * and this is a card — but it beats picking greys by eye, and the contrast
 * figures beside them are the actual check.
 *
 * `url` is the one value with no counterpart anywhere. It cannot be $url:
 * #1565c0 on black is 4.0:1, under the 4.5:1 a link at body size needs. #64b5f6
 * is 9.5:1, and is Material Blue 300 — $url is exactly Blue 800, so this is the
 * same family's lighter step rather than a blue picked to look close, which is
 * the sourcing argument $google-blue already makes in _tokens.scss.
 */
export const DARK = {
  pageBg: TOKEN_COLORS['splash-ink'],
  cardBg: '#000',
  text: '#e0e0e0',
  muted: '#b8b8b8',
  url: '#64b5f6',
  border: '#292929',
} as const

/**
 * Every color any template may use, lowercased, for the "no stray hex" test.
 * Lowercased because a hand-written `#FFF` and a palette `#fff` are the same
 * color and the assertion is about provenance, not spelling.
 *
 * DARK is included because those values are rendered into the document too — in
 * the <style> block rather than on an element, but the test reads the bytes and
 * does not care which.
 */
export const PALETTE: readonly string[] = [...Object.values(COLORS), ...Object.values(DARK)].map((c) =>
  c.toLowerCase(),
)

// No webfont. layout.tsx links Google Fonts for the site; an email must not,
// because a <link> in a mail body is stripped or ignored by every major client
// and the fallback is what renders anyway. Lato where it happens to be
// installed, Arial everywhere else — which is the realistic outcome regardless.
//
// UNQUOTED on purpose, and this is not a style preference. These strings end up
// inside a style="" attribute rendered by Hono's JSX, which escapes ' to &#39;
// and " to &quot;. A browser decodes those before the CSS parser sees them;
// Outlook's Word engine is not reliably a browser, and a font-family it cannot
// parse falls back to Times New Roman for the whole message. CSS permits a
// family name to be a sequence of identifiers, so `Helvetica Neue` unquoted is
// valid and sidesteps the question entirely. Keep every value in this file free
// of quote characters.
export const FONT_STACK = 'Lato, Helvetica Neue, Helvetica, Arial, sans-serif'

// The width every serious email client agrees on. Wider than this and Outlook's
// reading pane clips rather than scrolls.
export const CONTENT_WIDTH = 600
