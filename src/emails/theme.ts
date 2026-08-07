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
 * Every color any template may use, lowercased, for the "no stray hex" test.
 * Lowercased because a hand-written `#FFF` and a palette `#fff` are the same
 * color and the assertion is about provenance, not spelling.
 */
export const PALETTE: readonly string[] = Object.values(COLORS).map((c) => c.toLowerCase())

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
