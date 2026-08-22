// Inlines an SVG from `public/img/icons/` into a view.
//
// Inlining rather than `<img src>` because these marks are two-tone: a field in
// `currentColor` with the glyph knocked out in white. An external image has no
// inherited color to resolve `currentColor` against, so it paints black; a CSS
// mask is worse, flattening the knockout into a solid silhouette. The element
// has to be in the document for the color to reach it.
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
 * Returns the contents of `public/img/icons/icon-<name>.svg` as an HTML string,
 * ready to be handed to `raw()`.
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

  const svg = readFileSync(file, 'utf8')
    .trim()
    .replace(SVG_TAG, (tag) => `<svg aria-hidden="true" focusable="false"${tag.slice(4).replace(SIZE_ATTR, '')}`)

  cache.set(name, { mtimeMs, svg })
  return svg
}
