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

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const isColorValue = (v: string) => HEX.test(v) || v.startsWith('rgba(') || v.startsWith('rgb(')

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
export function parseTokens(scss: string): Token[] {
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
    const value = raw.startsWith('$') ? (literals.get(raw.slice(1)) ?? raw) : raw
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

export function luminance(hex: string): number | null {
  const h = expand(hex.toLowerCase())
  if (!HEX.test(h)) return null
  const n = parseInt(h.slice(1), 16)
  return (
    0.2126 * channel(((n >> 16) & 255) / 255) +
    0.7152 * channel(((n >> 8) & 255) / 255) +
    0.0722 * channel((n & 255) / 255)
  )
}

/** WCAG 2.1 contrast, or null if either side is not a plain hex. */
export function contrast(a: string, b: string): number | null {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return null
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

// --- Disk -------------------------------------------------------------------

type Snapshot = { tokens: Token[]; literals: Literal[] }
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
    // a literal added to _map.scss has to show up without a restart too.
    const key = names.map((n) => `${n}:${statSync(join(STYLE_DIR, n)).mtimeMs}`).join('|')
    if (cache && cache.key === key) return cache.snapshot

    const tokens = parseTokens(readFileSync(TOKENS_FILE, 'utf8'))
    const others = names
      .filter((n) => n !== '_tokens.scss')
      .map((n) => ({ name: n, text: readFileSync(join(STYLE_DIR, n), 'utf8') }))

    const snapshot: Snapshot = { tokens, literals: findLiterals(others, tokens) }
    cache = { key, snapshot }
    return snapshot
  } catch {
    return { tokens: [], literals: [] }
  }
}
