// The wordmark, in whichever ink the scheme needs.
//
// TWO <img>s AND A STYLESHEET RULE, NOT <picture>. A `<source media="(prefers-color-scheme: dark)">`
// would follow the OS and ignore a rider who chose light on a dark machine —
// the case `_theme.scss` is written twice to get right — and an `<img>` cannot
// take its `src` from a custom property. So both files are in the markup and
// `.logo-light` / `.logo-dark` in `_theme.scss` show one, keyed on exactly the
// selectors the palette switches on. Solved without JavaScript for the reason
// that file gives: a script deciding the artwork flashes the wrong one first.
//
// The suffix names the GROUND, not the ink: no suffix is the dark artwork for a
// light ground and `-dk` is the reversed white one for a dark ground. See the
// note above `siteHeader()` in layout.tsx. #317.
//
// **THE BETA SIGN IS A THIRD <img>, OVERLAID BY CSS, NOT BAKED INTO THE
// WORDMARK.** Ziad's call, 2026-09-20. The composites he drew hang the sign
// off the wordmark's right end and so change its box — the hz one goes from
// 8.15:1 to 2.85:1 — and the header sizes the mark by height, so a baked
// file would shrink the word to a third to fit the sign in. `beta-lockup.svg`
// is the sign alone; `.logo-beta` in _chrome.scss hangs it from the same
// nail the composites use, sized per surface, and it goes with one class when
// the stage does. The composites stay for the rasters — email and the OG
// card — where there is no CSS. `BETA_SIGN` in views/stage.ts is the switch.
//
// **AND SINCE 2026-09-21 THE SIGN IS INLINE, IN `currentColor`, PAINTED
// `$detour`.** Ziad's call: the sign's orange is the palette's work-zone
// orange, and an `<img>` has no inherited color to resolve `currentColor`
// against — the views/icon.ts argument. The file's field is `currentColor`;
// `.logo-beta` in _chrome.scss sets `color: $detour`, so the sign follows the
// theme's orange (and any future retune of it) with no re-export. Read from
// disk per render on an mtime cache, the icon.ts arrangement, so a redrawn
// file shows up on reload under `npm run dev`. The rasters keep their own
// baked orange.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { raw } from 'hono/html'
import { asset } from './assets'
import { BETA_SIGN } from './stage'

type Mark = 'hz' | 'stacked'

const SIGN_FILE = join(process.cwd(), 'public', 'img', 'beta-lockup.svg')
let signCache: { mtimeMs: number; svg: string } | null = null

/** The sign's SVG with the class and aria-hidden on its root tag. The file's
 *  own width/height attributes stay: they are the aspect ratio `height: auto`
 *  sizes the inline element by. */
function signSvg(): string {
  const { mtimeMs } = statSync(SIGN_FILE)
  if (signCache && signCache.mtimeMs === mtimeMs) return signCache.svg
  const svg = readFileSync(SIGN_FILE, 'utf8')
    .replace(/^\s*<svg\b/, '<svg class="logo-beta" aria-hidden="true"')
    .trim()
  signCache = { mtimeMs, svg }
  return svg
}

const FILE: Record<Mark, { light: string; dark: string; w: number; h: number }> = {
  hz: { light: '/img/logo-routeloop-hz.svg', dark: '/img/logo-routeloop-hz-dk.svg', w: 1500, h: 184 },
  stacked: { light: '/img/logo-routeloop.svg', dark: '/img/logo-routeloop-dk.svg', w: 920, h: 518 },
}

/** Both inks of the mark; the stylesheet shows the one the scheme wants.
 *  `alt` goes on both — one is always hidden, so a screen reader meets it once.
 *  Wrapped in `.logo-lockup`, the box the beta sign is positioned in; the
 *  wrapper carries `className` and `data-mark` so a surface can size the sign
 *  for the mark it holds. */
export function wordmark(mark: Mark, alt: string, className = ''): string {
  const f = FILE[mark]
  const named = alt && BETA_SIGN ? `${alt} beta` : alt
  // THROUGH asset(), SO A REDRAWN FILE REACHES THE BROWSER. The paths were bare
  // until 2026-09-20, when Ziad saved a new beta sign and the page kept showing
  // the old one: the browser's copy is fresh for as long as it likes, and the
  // edge's for its TTL. asset() puts the file's own hash in the query, so a
  // changed file is a changed URL.
  return (
    <span class={className ? `logo-lockup ${className}` : 'logo-lockup'} data-mark={mark}>
      <img class="logo-light" src={asset(f.light)} alt={named} width={f.w} height={f.h} />
      <img class="logo-dark" src={asset(f.dark)} alt={named} width={f.w} height={f.h} />
      {BETA_SIGN && sign()}
    </span>
  ).toString()
}

/** The sign alone, decorative: the wordmark's alt already says beta. */
const sign = () => raw(signSvg())

/** The sign for a surface that draws its own wordmark rather than calling
 *  wordmark() — the splash's reversed stacked mark. Empty outside a beta. */
export function betaSign(): string {
  return BETA_SIGN ? sign().toString() : ''
}
