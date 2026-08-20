// Long-form page copy, read from `src/content/*.html` rather than embedded in a
// route file.
//
// Before this, the FAQ, privacy policy and terms lived as template literals in
// pages.ts — 265 of its 471 lines. Rewording an answer meant opening a
// TypeScript file, escaping backticks and `${`, and not breaking the literal.
// Nobody who is not already fluent in TS could touch the copy.
//
// The files live under `src/` and not at the repo root because the Dockerfile
// copies `src`, `public` and `style` by name. A root-level `content/` would be
// silently absent from the image, and every content page would render empty in
// production while working perfectly in dev.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// serveStatic resolves './public' against cwd, so the process runs from the app
// root; mirror that here, exactly as views/assets.ts does.
const CONTENT_DIR = join(process.cwd(), 'src', 'content')

// Guarded by mtime, and that is not an optimization — it is what keeps editing
// prose bearable. `npm run dev` is `tsx watch src/index.ts`, which watches
// TypeScript, so nothing restarts when a .html file changes. Read once at
// startup and you would have to bounce the server for every typo; this way an
// edit shows up on the next request. In production the bytes are fixed for the
// life of the container, so it is one statSync per request and nothing else.
const cache = new Map<string, { mtimeMs: number; raw: string }>()

/**
 * A `{{TOKEN}}` in a content file, substituted from `tokens`.
 *
 * Deliberately the smallest possible thing — no conditionals, no loops, no
 * expressions. Three values need it and that is all it is for: the legal pages'
 * shared effective date, which would otherwise be duplicated in two files and
 * drift, and the two figures in the FAQ that are computed from the current year
 * and so cannot be written down at all.
 */
export type ContentTokens = Record<string, string | number>

const TOKEN = /\{\{(\w+)\}\}/g

/**
 * Reads `src/content/<name>` and substitutes any tokens.
 *
 * Throws on a missing file rather than degrading. assets.ts can fall back to a
 * bare path because a missing asset 404s visibly; a missing content file would
 * render a page with a header, a footer and nothing between them, which reads
 * as a styling bug and could ship unnoticed.
 *
 * Only ever called with literal in-repo names. No user input reaches it, so
 * there is no traversal surface — keep it that way.
 */
export function content(name: string, tokens: ContentTokens = {}): string {
  const file = join(CONTENT_DIR, name)

  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    throw new Error(`content: ${name} is missing from src/content/`)
  }

  const hit = cache.get(name)
  // trimEnd because a text file ends with a newline and the template literals
  // these replaced did not, so without it every content page gained a stray
  // blank line before its footer. Trailing whitespace in an HTML fragment is
  // never meaningful, and the file keeps its final newline like any other.
  const raw = hit && hit.mtimeMs === mtimeMs ? hit.raw : readFileSync(file, 'utf8').trimEnd()
  if (!hit || hit.mtimeMs !== mtimeMs) cache.set(name, { mtimeMs, raw })

  // Substituted per call rather than cached, because a token's value can change
  // without the file changing — RIDING_YEARS ticks over at New Year.
  return raw.replace(TOKEN, (_, key: string) => {
    if (!(key in tokens)) {
      // Louder than leaving `{{FOO}}` visible on a legal page, and it surfaces
      // on the first render rather than whenever someone happens to read it.
      throw new Error(`content: ${name} uses {{${key}}}, which was not supplied`)
    }
    return String(tokens[key])
  })
}
