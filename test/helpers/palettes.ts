// The six palettes, as they actually compile.
//
// WHY THIS COMPILES SASS RATHER THAN PARSING IT. `style/_palette.scss` holds the
// authored bases and derives the rest with `color.adjust()`, so the numbers a
// browser sees exist only after the compiler has run. Reimplementing that math
// in TypeScript would give a second implementation of the thing under test, and
// the first hue that disagreed would be indistinguishable from a real defect.
//
// AND WHY NOT `public/style/main.min.css`. That file is a build artifact and is
// gitignored, and CI does not build SCSS — a test reading it would pass here and
// fail on every pull request. `sass` is already a devDependency, so compiling a
// three-line stylesheet costs nothing that is not already installed.
//
// The selectors below are the ones `style/_theme.scss` actually emits, which is
// what makes this cover the plumbing as well as the values: rename a block and
// this stops finding six palettes rather than quietly measuring five.
import { compileString } from 'sass'

export const THEMES = ['default', 'contrast', 'colorblind'] as const
export const SCHEMES = ['light', 'dark'] as const

export type PaletteKey = `${(typeof THEMES)[number]}-${(typeof SCHEMES)[number]}`

/** Token name (without the leading `--`) to its compiled value. */
export type Palette = Map<string, string>

// Written unquoted, because that is how the compiler emits them: Sass drops the
// quotes around an attribute value it does not need them for, so the selector in
// the output is `:root[data-theme=contrast]` and not what _theme.scss says.
// Normalizing both sides would hide a real selector change behind a tidy-up, so
// these are the literal output strings.
const SELECTORS: Record<string, PaletteKey> = {
  ':root': 'default-light',
  ':root[data-theme=contrast]': 'contrast-light',
  ':root[data-theme=colorblind]': 'colorblind-light',
  ':root[data-scheme=dark]': 'default-dark',
  ':root[data-scheme=dark][data-theme=contrast]': 'contrast-dark',
  ':root[data-scheme=dark][data-theme=colorblind]': 'colorblind-dark',
}

let cached: Map<PaletteKey, Palette> | null = null

/**
 * Every emitted palette, keyed `theme-scheme`.
 *
 * Compiled once per process. The `prefers-color-scheme` blocks are skipped
 * deliberately — they emit the same values as the explicit dark ones and only
 * exist because the server cannot know the reader's OS setting.
 */
export function palettes(): Map<PaletteKey, Palette> {
  if (cached) return cached

  const css = compileString('@use "theme";', { loadPaths: ['style'] }).css
  const out = new Map<PaletteKey, Palette>()

  // Top-level blocks only. The media query's contents are nested one level in,
  // and this pattern will not match across the outer brace.
  for (const m of css.matchAll(/(^|\n)([^{}\n][^{}]*)\{([^{}]*)\}/g)) {
    const selector = m[2].trim()
    const key = SELECTORS[selector]
    if (!key) continue

    const palette: Palette = new Map()
    for (const d of m[3].matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) palette.set(d[1], d[2].trim())
    out.set(key, palette)
  }

  cached = out
  return out
}

/** One palette, or a loud failure — a missing key is a renamed block. */
export function palette(key: PaletteKey): Palette {
  const p = palettes().get(key)
  if (!p) throw new Error(`palette: ${key} was not emitted — check the selectors in style/_theme.scss`)
  return p
}

/** A token's value in one palette, or a loud failure. */
export function token(key: PaletteKey, name: string): string {
  const v = palette(key).get(name)
  if (v === undefined) throw new Error(`palette: ${key} has no --${name}`)
  return v
}

export const PALETTE_KEYS: PaletteKey[] = THEMES.flatMap((t) => SCHEMES.map((s) => `${t}-${s}` as PaletteKey))
