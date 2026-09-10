// Inlines an SVG from `public/img/icons/` into a view.
//
// Inlining rather than `<img src>` because these marks are two-tone: a field in
// `currentColor` with the glyph knocked out in white. An external image has no
// inherited color to resolve `currentColor` against, so it paints black; a CSS
// mask is worse, flattening the knockout into a solid silhouette. The element
// has to be in the document for the color to reach it.
//
// **BOTH TONES ARE CSS-SETTABLE, AND THE KNOCKOUT IS NORMALIZED HERE RATHER
// THAN IN THE FILES.** Ziad's call, 2026-09-09. The field has always been
// `color:`; the glyph is now `--icon-ink`, so a caller sets two colors instead
// of one. Doing it in the loader rather than by hand-editing 46 SVGs is the
// whole point: `npm run dev` reads these from disk per request precisely so a
// re-export from the drawing tool shows up on reload, and a re-export
// overwrites anything typed into the file. A `var()` written into the artwork
// would be reverted silently, and the failure has no error — it is a white
// glyph on amber, which is #282.
//
// **IT MATCHES FIVE SPELLINGS AND BOTH PROPERTIES, BECAUSE THE OLD
// `[fill="white"]` SELECTOR MATCHED ONE.** That is what was broken: `bug`,
// `help` and `info` spell the knockout `#ffffff`/`#FFFFFF`, and the four
// `record-*` marks put it on `stroke` rather than `fill` — so all seven kept a
// white glyph in every black-legend field, at 1.23:1 on `$yield`. Reported by
// Ziad off /icons, 2026-09-09.
//
// **THE FALLBACK IS WHAT KEEPS EVERY EXISTING CALL SITE UNTOUCHED**: an
// unset `--icon-ink` resolves to `#fff`, which is byte-for-byte what these
// files painted before. A surface that wants a black legend sets the property;
// nothing else changes.
//
// Same file-reading arrangement as views/content.ts, for the same reason: `npm
// run dev` is `tsx watch src/index.tsx`, which watches TypeScript and does not
// restart when an .svg changes, so reading once at startup would mean bouncing
// the server after every re-export from the drawing tool. In production the
// bytes are fixed for the life of the container, so it is one statSync per
// render and nothing else.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// serveStatic resolves './public' against cwd, so the process runs from the app
// root; mirror that here, exactly as views/assets.ts and views/content.ts do.
// The Dockerfile copies `public` by name, so this directory is in the image.
const ICON_DIR = join(process.cwd(), 'public', 'img', 'icons')

const cache = new Map<string, { mtimeMs: number; svg: string }>()

const SVG_TAG = /^<svg\b[^>]*>/
const SIZE_ATTR = /\s(?:width|height)="[^"]*"/g

/**
 * The knockout, in every spelling the folder actually contains, on either
 * property. Case-insensitive so `#FFFFFF` is caught with `#ffffff` — the two
 * are the same color and were two different bugs.
 *
 * Anchored on `="` so it cannot reach `fill-rule`, `stroke-width` or
 * `stroke-linecap`, all of which are present in these files.
 */
const KNOCKOUT = /(fill|stroke)="(?:white|#fff|#ffffff)"/gi

/**
 * Marks whose whites are ARTWORK rather than a knockout, and which therefore
 * must not be repainted.
 *
 * `vmc` is a club logo with a fixed palette — teal, yellow, four greys, black
 * and 62 white paths — and no `currentColor` anywhere in it. It is not a badge
 * and has no legend to flip; handing its whites to `--icon-ink` would let any
 * surface recolor somebody else's logo.
 */
const FIXED_PALETTE = new Set(['vmc'])

/**
 * Returns the contents of `public/img/icons/icon-<name>.svg` as an HTML string,
 * ready to be handed to `raw()`.
 *
 * Two tones, both settable from the call site: `color` paints the field and
 * `--icon-ink` paints the glyph knocked out of it. `--icon-ink` defaults to
 * `#fff`, so a caller that sets only `color` gets exactly what it got before
 * this existed.
 *
 * The `width` and `height` attributes are stripped so CSS sizes the mark — the
 * files are exported at 1000×1000 and would otherwise render at that size for
 * the instant before the stylesheet lands, which on the alpha modal is three
 * full-viewport discs. `viewBox` is left alone; it is what makes the drawing
 * scale at all.
 *
 * Marked `aria-hidden` because every caller so far pairs the mark with a text
 * label or an aria-label on the link around it. A decorative mark that also
 * announces itself reads the destination twice.
 *
 * Throws on a missing file rather than degrading to an empty string. A silently
 * absent icon looks like a styling bug and could ship unnoticed; this surfaces
 * on the first render.
 *
 * Only ever called with literal in-repo names. No user input reaches it, so
 * there is no traversal surface — keep it that way.
 */
export function icon(name: string): string {
  const file = join(ICON_DIR, `icon-${name}.svg`)

  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    throw new Error(`icon: icon-${name}.svg is missing from public/img/icons/`)
  }

  const hit = cache.get(name)
  if (hit && hit.mtimeMs === mtimeMs) return hit.svg

  let svg = readFileSync(file, 'utf8')
    .trim()
    .replace(SVG_TAG, (tag) => `<svg aria-hidden="true" focusable="false"${tag.slice(4).replace(SIZE_ATTR, '')}`)

  if (!FIXED_PALETTE.has(name)) svg = svg.replace(KNOCKOUT, '$1="var(--icon-ink, #fff)"')

  cache.set(name, { mtimeMs, svg })
  return svg
}
