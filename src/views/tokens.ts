// Reads the design tokens back out of the SCSS that defines them, so /brand
// shows what the app actually ships rather than a copy that drifts.
//
// A hardcoded table in TypeScript would have been half the code and wrong
// within a week — that is the whole failure mode this page exists to fix, since
// the palette already has one copy too many (DAY_COLORS was duplicated in
// builder.js until the importer needed it too). Parsing the source means a
// token trimmed in _tokens.scss disappears from the page on the next reload,
// with no second place to remember.
//
// Cached by mtime, the same guard views/assets.ts uses: production parses once
// because the files are fixed for the life of the container, and a dev edit
// re-reads on the next request without a restart.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const STYLE_DIR = join(process.cwd(), 'style')
const TOKENS_FILE = join(STYLE_DIR, '_tokens.scss')

// The compiled stylesheet, which is where the VALUES are now.
//
// _tokens.scss stopped holding colors when the theme engine landed: every token
// there is a `var(--x)` reference and the numbers moved to _palette.scss, where
// they are Sass maps put through `color.adjust()` and do not exist until the
// compiler has run. This page went to zero color tokens overnight and nothing
// failed, because "is this a color" was a regex over a string.
//
// Reading the BUILD rather than re-deriving it is deliberate. Reimplementing the
// palette's color math in TypeScript would give a second implementation of the
// thing this page exists to display, and the first hue that disagreed would look
// like a design decision. Compiling Sass at request time was the other option and
// is worse: `sass` is a devDependency and the production image does not install
// it, so /brand would work locally and 500 in the container.
const CSS_FILE = join(process.cwd(), 'public', 'style', 'main.min.css')

export type Token = {
  /** Without the `$`. */
  name: string
  /** Exactly as written, so `$brand: $url` shows that it is an alias. */
  raw: string
  /** The alias followed to a literal. Same as `raw` when it is already one. */
  value: string
  /** The `//` block immediately above the declaration, joined into a sentence. */
  note: string
  /** False for `$font` and the `$z-*` stack, which are tokens but not colors. */
  isColor: boolean
}

export type Literal = {
  value: string
  /** Total occurrences across every partial except _tokens.scss itself. */
  count: number
  /** The token carrying this exact value, if one does. */
  duplicates: string | null
  /** Which partials it appears in, for the trim pass. */
  files: string[]
}

/** The named colors Sass shortens to in this palette. See channels(). */
const KEYWORDS = new Map<string, [number, number, number]>([
  ['black', [0, 0, 0]],
  ['white', [1, 1, 1]],
  ['red', [1, 0, 0]],
])

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
// The three keywords are here for the same reason luminance() knows them: Sass
// writes the shortest form of a color, so a derivation that lands exactly on one
// arrives as a keyword rather than as a hex.
const isColorValue = (v: string) =>
  HEX.test(v) || v.startsWith('rgba(') || v.startsWith('rgb(') || KEYWORDS.has(v)

/**
 * Parses `$name: value;` declarations, carrying the comment block above each
 * one down with it.
 *
 * The comments are the point. Every token in this file that is not obvious
 * carries a paragraph explaining why it exists and what it must not be confused
 * with, and those paragraphs are exactly what a decision to trim needs in front
 * of it. Rendering the swatch without them would be a color chart; rendering
 * them together is a design system.
 */
export function parseTokens(scss: string, palette?: ReadonlyMap<string, string>): Token[] {
  const out: Token[] = []
  const literals = new Map<string, string>()
  let comment: string[] = []

  for (const line of scss.split('\n')) {
    const trimmed = line.trim()

    if (trimmed.startsWith('//')) {
      comment.push(trimmed.replace(/^\/\/\s?/, ''))
      continue
    }

    const decl = trimmed.match(/^\$([a-z0-9-]+):\s*(.+?);/i)
    if (!decl) {
      // Any non-comment, non-declaration line ends the block above — otherwise
      // a file-level header would attach itself to whatever declared first.
      if (trimmed === '') comment = []
      continue
    }

    const [, name, raw] = decl
    // One level of alias resolution, which is all the file uses ($brand: $url,
    // $ride: $url). A chain would need a loop; there is no chain, and inventing
    // one would be code with no caller.
    //
    // Then the custom property, if a palette was supplied. `raw` is left exactly
    // as written — `var(--stop)` is the honest answer to "what does this file
    // say" and the page shows it beside the value — while `value` becomes what a
    // browser would actually paint.
    let value = raw.startsWith('$') ? (literals.get(raw.slice(1)) ?? raw) : raw
    const ref = value.match(/^var\(--([a-z0-9-]+)\)$/i)
    if (ref && palette) value = palette.get(ref[1]) ?? value
    if (isColorValue(value)) literals.set(name, value)

    out.push({
      name,
      raw,
      value,
      note: comment.join(' ').trim(),
      isColor: isColorValue(value),
    })
    comment = []
  }

  return out
}

/**
 * Every hex written directly into a partial, with where and how often.
 *
 * `_tokens.scss` is excluded because a token's own definition is not a stray
 * literal, and counting it would put every token at the top of a list whose
 * whole purpose is finding the colors that have no name.
 */
export function findLiterals(files: { name: string; text: string }[], tokens: Token[]): Literal[] {
  const byValue = new Map<string, string>()
  for (const t of tokens) {
    if (t.isColor) byValue.set(expand(t.value.toLowerCase()), t.name)
  }

  const seen = new Map<string, { count: number; files: Set<string> }>()
  for (const f of files) {
    for (const m of f.text.matchAll(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
      const key = expand(m[0].toLowerCase())
      const hit = seen.get(key) ?? { count: 0, files: new Set<string>() }
      hit.count++
      hit.files.add(f.name)
      seen.set(key, hit)
    }
  }

  return [...seen.entries()]
    .map(([value, hit]) => ({
      value,
      count: hit.count,
      duplicates: byValue.get(value) ?? null,
      files: [...hit.files].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** `#06c` and `#0066cc` are the same color and must not count as two. */
function expand(hex: string): string {
  if (hex.length !== 4) return hex
  return '#' + hex.slice(1).split('').map((c) => c + c).join('')
}

// --- Contrast ---------------------------------------------------------------

const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))

/**
 * The three sRGB channels of a color, each 0..1, or null if it is not one this
 * can measure.
 *
 * TWO FORMS, AND THE SECOND IS NOT COSMETIC. Sass emits a hex for an authored
 * literal but `rgb(60%, 40.47%, 0%)` for anything `color.adjust()` produced —
 * which is every derived token in the palette, `$pending` and `$label` among
 * them. Reading only hex meant the two tokens most likely to have a contrast
 * problem, because they are amber pushed toward legibility, were the two this
 * could not measure. They rendered as "no ratio" on /brand and were skipped
 * silently by the audit.
 *
 * ALPHA STILL RETURNS NULL, deliberately. A translucent color has no contrast
 * ratio without knowing what is behind it, and inventing a backdrop would put a
 * confident wrong number on the page — `$panel-bg` is a white scrim over a map.
 * That is why the `/` guard and the four-argument `rgba()` both bail.
 */
function channels(value: string): [number, number, number] | null {
  const v = value.trim().toLowerCase()

  // The keywords Sass actually emits. It writes the shortest form of a color, so
  // a derivation that lands exactly on a named one comes out as that name rather
  // than as a hex — and without these, the tokens most likely to have been
  // clamped by accident are the ones that cannot be measured.
  //
  // `black` and `white` are the clamped ends of the lightness scale. `red` is
  // there since 2026-08-26 and is the reason this is a table rather than two
  // comparisons: $stop became #cc0000, which sits at exactly 40% HSL lightness,
  // so the dark schemes' `kml-d10` — a 10% step run the other way — lands on
  // hsl(0, 100%, 50%), which IS #ff0000, which Sass writes as `red`.
  //
  // Still not a general lookup of all 148 names. Each entry is a value this
  // palette provably emits, checked by the sweep in test/palette-contrast.ts
  // that refuses anything not matching this set.
  const named = KEYWORDS.get(v)
  if (named) return named

  const h = expand(v)
  if (HEX.test(h)) {
    const n = parseInt(h.slice(1), 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }

  const m = v.match(/^rgba?\(([^)]*)\)$/)
  if (!m) return null
  // Modern `rgb(r g b / a)` syntax carries its alpha after a slash.
  if (m[1].includes('/')) return null

  const parts = m[1].split(',').map((p) => p.trim())
  if (parts.length !== 3) return null

  const out = parts.map((p) => {
    const pct = p.endsWith('%')
    const n = Number(pct ? p.slice(0, -1) : p)
    if (!Number.isFinite(n)) return NaN
    return Math.min(1, Math.max(0, pct ? n / 100 : n / 255))
  })
  return out.some(Number.isNaN) ? null : (out as [number, number, number])
}

export function luminance(value: string): number | null {
  const rgb = channels(value)
  if (!rgb) return null
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

/** WCAG 2.1 contrast, or null if either side is not an opaque color. */
export function contrast(a: string, b: string): number | null {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return null
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

// --- Disk -------------------------------------------------------------------

/**
 * The default light palette, read out of the `:root` block of the compiled CSS.
 *
 * The FIRST `:root` block specifically, which is the default light one — the five
 * others are `:root[data-theme=…]` and `:root[data-scheme=…]` and do not match
 * this pattern. That is the palette this page reports, and the page says so:
 * showing one rider's active theme would make the figures depend on who is
 * looking, and showing all six would turn a swatch chart into a matrix. All six
 * are measured by test/palette-contrast.test.ts, which is enforcement rather than
 * a page somebody has to remember to open.
 *
 * Empty when the stylesheet has not been built. /brand then renders exactly as it
 * did before this was added — names and comments, no swatches — rather than
 * failing, because a reference page must never be able to take a route down.
 */
export function parsePalette(css: string): Map<string, string> {
  const out = new Map<string, string>()
  const block = css.match(/(^|\})\s*:root\s*\{([^}]*)\}/)
  if (!block) return out
  for (const d of block[2].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+)/gi)) out.set(d[1], d[2].trim())
  return out
}

type Snapshot = { tokens: Token[]; literals: Literal[]; palette: Map<string, string> }
let cache: { key: string; snapshot: Snapshot } | null = null

/**
 * Tokens and stray literals as they are on disk right now.
 *
 * Returns empty lists rather than throwing if `style/` is missing: this backs
 * one internal page, and a reference page failing to render must never be able
 * to take a route down.
 */
export function readTokens(): Snapshot {
  try {
    const names = readdirSync(STYLE_DIR).filter((f) => f.endsWith('.scss'))
    // mtimes of every partial, so editing any of them invalidates the scan —
    // a literal added to _map.scss has to show up without a restart too. The
    // compiled CSS is in the key as well: in dev the sass watcher rewrites it a
    // moment after the partial it came from, and without this the page would
    // show the previous build's colors until something else changed.
    const key = [
      ...names.map((n) => `${n}:${statSync(join(STYLE_DIR, n)).mtimeMs}`),
      `css:${cssMtime()}`,
    ].join('|')
    if (cache && cache.key === key) return cache.snapshot

    const palette = parsePalette(readCss())
    const tokens = parseTokens(readFileSync(TOKENS_FILE, 'utf8'), palette)
    const others = names
      .filter((n) => n !== '_tokens.scss')
      .map((n) => ({ name: n, text: readFileSync(join(STYLE_DIR, n), 'utf8') }))

    const snapshot: Snapshot = { tokens, literals: findLiterals(others, tokens), palette }
    cache = { key, snapshot }
    return snapshot
  } catch {
    return { tokens: [], literals: [], palette: new Map() }
  }
}

// Both tolerate a missing build. `npm run sass` writes this file and it is
// gitignored, so a fresh clone that has not built yet is an ordinary state.
function cssMtime(): number {
  try {
    return statSync(CSS_FILE).mtimeMs
  } catch {
    return 0
  }
}

function readCss(): string {
  try {
    return readFileSync(CSS_FILE, 'utf8')
  } catch {
    return ''
  }
}
