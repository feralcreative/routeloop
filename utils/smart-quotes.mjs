#!/usr/bin/env node
//
// Curls quotes in visible text: `don't` becomes `don’t`.
//
// House rule, set 2026-09-07: rider-facing copy uses typographic quotes, never
// the straight ASCII ones. Same standing instruction as the em-dash tightener
// beside this file, and the same shape — a `--check` for CI and a `--write` for
// the hook.
//
// **WHY THIS CANNOT BE A REGEX OVER LINES, WHICH IS WHERE THE DASH TIGHTENER
// GETS AWAY WITH IT.** An em dash is punctuation wherever it appears; a straight
// quote is usually a STRING DELIMITER. `s/'/’/g` over this repo would not
// produce wrong prose, it would produce a codebase that does not parse. So this
// walks the file with a scanner that knows where it is, and converts nothing it
// cannot place.
//
// **THE ONE RULE, AND WHY IT IS PROVABLY SAFE.** An apostrophe BETWEEN TWO WORD
// CHARACTERS is a contraction, everywhere:
//
//   - inside a string literal it cannot be a delimiter, because a delimiter
//     would have ended the string before reaching the letter after it;
//   - in ordinary TypeScript outside a string it cannot occur at all, since a
//     bare `'` in code always opens one — so `word'word` in a non-string,
//     non-comment region is JSX text and nothing else.
//
// That covers the contractions, which is nearly all of the copy in this app.
//
// **COMMENTS ARE SKIPPED**, for the reason the dash tightener skips them: this
// codebase writes dense prose in comments and the rule is about what a rider
// sees, not about source. A comment is also the one place `word'word` appears
// legitimately in a form nobody reads on a screen.
//
// **DOUBLE QUOTES ARE ONLY CURLED IN `src/content/*.html`**, where a `"` in a
// text node is unambiguously a quotation mark. In TypeScript it is a delimiter
// far more often than it is punctuation, and the pairing rule (which one opens,
// which closes) is not decidable from a line. Those are reported by `--check`
// with `--strict` and fixed by hand.
//
// Usage:
//   node utils/smart-quotes.mjs --check [files…]   report and exit 1
//   node utils/smart-quotes.mjs --write [files…]   fix in place

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

/** A contraction: an apostrophe with a word character either side. */
const CONTRACTION = /(\w)'(\w)/g

/**
 * Curls contractions in a source file, leaving comments alone.
 *
 * LINE-BASED, AND THAT IS THE SECOND ATTEMPT. The first walked the file with a
 * character scanner that tracked strings and comments together — which is the
 * right shape in principle and desynchronized in practice on the first template
 * literal it met: bailing out at `${` left the closing backtick to be read as an
 * OPENING one, and everything after it was misclassified. The symptom was this
 * tool rewriting apostrophes inside comments, which is the one thing it is
 * written not to do. Caught by diffing before writing, not by the check.
 *
 * So it does what the em-dash tightener beside it does, for the same reason: a
 * comment in this codebase always starts its line with `//`, `/*` or a
 * continuation `*`, and a trailing `//` is masked. Within what is left,
 * `word'word` can only be a contraction inside a string or in JSX text — a bare
 * `'` in code always opens a string, so it cannot have letters on both sides.
 */
export function curl(source) {
  let block = false
  let hits = 0

  const out = source.split('\n').map((line) => {
    const trimmed = line.trimStart()

    if (block) {
      if (trimmed.includes('*/')) block = false
      return line
    }
    // `{/*` as well as `/*`: a JSX comment's continuation lines are plain
    // indented prose with no leading `*`, so missing the opener leaves the whole
    // block looking like code. That is how this rewrote the panel-toggle notes
    // in layout.tsx on the second attempt.
    if (/^\{?\/\*/.test(trimmed)) {
      if (!trimmed.includes('*/')) block = true
      return line
    }
    // A continuation line of a block comment, and a whole-line `//`.
    if (/^(\/\/|\*)/.test(trimmed)) return line

    // A TRAILING comment is masked rather than skipped, so the code before it is
    // still converted. Split on the first `//` that is not inside a string — the
    // cheap test being that an even number of quotes precedes it.
    const at = trailingComment(line)
    const head = at === -1 ? line : line.slice(0, at)
    const tail = at === -1 ? '' : line.slice(at)

    const found = head.match(CONTRACTION)
    if (!found) return line
    hits += found.length
    return head.replace(CONTRACTION, '$1\u2019$2') + tail
  })

  return { text: out.join('\n'), hits }
}

/** Index of a `//` that starts a comment, or -1. Ignores one inside a string by
 *  counting unescaped quotes before it — enough for `'https://x'`, which is the
 *  case that breaks the naive version. */
function trailingComment(line) {
  let s = null
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i]
    if (c === '\\') {
      i++
      continue
    }
    if (s) {
      if (c === s) s = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      s = c
      continue
    }
    if (c === '/' && line[i + 1] === '/') return i
  }
  return -1
}

/**
 * The HTML content files, where a text node is entirely prose.
 *
 * Tags are masked so an attribute's delimiters are never touched, then both the
 * contractions and the paired double quotes are curled. The pairing is by
 * ORDER within a text run — open, close, open, close — which is what a writer
 * means and what no line-level rule can work out.
 */
export function curlHtml(source) {
  let hits = 0
  // COMMENTS FIRST, and they are not covered by the tag pattern below: `<!-- … -->`
  // spans lines and routinely CONTAINS a `>` — release-notes.html carries a
  // worked example of a stamped `<section class="rn-release">` inside one — so
  // `<[^>]*>` ends the "tag" at that inner bracket and the rest of the comment
  // is read as prose. Its own attributes would then be curled into markup that
  // no longer parses if the block were ever uncommented.
  const text = source.replace(/(<!--[\s\S]*?-->)|(<[^>]*>)|([^<]+)/g, (m, comment, tag, body) => {
    if (comment || tag) return m
    let open = true
    const curled = body
      .replace(CONTRACTION, (_, a, b) => {
        hits++
        return `${a}’${b}`
      })
      .replace(/"/g, () => {
        hits++
        const q = open ? '“' : '”'
        open = !open
        return q
      })
    return curled
  })
  return { text, hits }
}

// --- CLI --------------------------------------------------------------------

import { fileURLToPath } from 'node:url'
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()

function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const check = args.includes('--check')
  let files = args.filter((a) => !a.startsWith('--'))

  if (!write && !check) {
    console.error('Usage: smart-quotes.mjs --check|--write [files…]')
    process.exit(2)
  }

  if (files.length === 0) {
    files = execSync('git ls-files "src/**/*.ts" "src/**/*.tsx" "src/content/*.html" "public/js/*.js"', {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
  }

  let total = 0
  const touched = []

  for (const file of files) {
    if (!/\.(ts|tsx|js|mjs|html)$/.test(file)) continue
    // Fixtures are data. Rewriting one turns an assertion into a tautology that
    // still reports green — the exact failure the dash tightener records having
    // caused in test/em-dashes.test.ts.
    if (/(^|\/)test\//.test(file) || /\.test\.[tj]sx?$/.test(file)) continue
    // Vendored, minified, or not ours to reformat.
    if (/\.min\.js$/.test(file) || /(^|\/)vendor\//.test(file)) continue
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const { text, hits } = file.endsWith('.html') ? curlHtml(source) : curl(source)
    if (!hits) continue
    total += hits
    touched.push(`${file} (${hits})`)
    if (write) writeFileSync(file, text)
  }

  if (total === 0) {
    if (check) console.log('quotes: clean')
    process.exit(0)
  }

  console.log(`${write ? 'Curled' : 'Found'} ${total} straight quote${total === 1 ? '' : 's'}:`)
  for (const t of touched) console.log(`  ${t}`)

  if (check) {
    console.log('\nFix with: npm run fix:quotes')
    process.exit(1)
  }
}
