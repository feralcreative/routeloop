#!/usr/bin/env node
//
// Tightens em dashes in prose: `word — word` becomes `word—word`.
//
// House rule: an em dash is always tight. There are no exemptions — not in
// table cells, not after a bold label. When a line genuinely needs air around
// the dash, the character to reach for is an en dash (`a – b`), which this
// script leaves alone.
//
// The only things skipped are code, where the character is data rather than
// punctuation: fenced blocks, inline spans, and comment lines in source files.
//
// Usage:
//   node utils/tighten-em-dashes.mjs --check [files…]   report and exit 1
//   node utils/tighten-em-dashes.mjs --write [files…]   fix in place
//
// With no files it reads every tracked .md. Markdown is processed in full;
// .ts/.js are processed with comment lines left alone, because this codebase
// writes spaced dashes in comments throughout and the rule is about prose a
// reader sees, not about source.

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// Spaced em dash. Any whitespace either side, including a non-breaking space,
// which is what a word processor leaves behind on a paste.
const SPACED_EM = /[  \t]+—[  \t]+/g

// Inline code is verbatim. Masking it first means a dash inside backticks is
// never touched. The placeholder is a NUL byte, chosen so it cannot occur in
// real prose.
//
// Written as \u0000 rather than as the raw byte it used to be. Identical at
// runtime, but a literal control character in source is invisible: an editor
// that strips them, or a copy-paste through a terminal, would silently break
// the masking — and this hook would then start rewriting em dashes *inside*
// backticks, which is exactly the thing it exists not to do.
function maskInlineCode(line) {
  const spans = []
  const masked = line.replace(/`[^`]*`/g, (m) => {
    spans.push(m)
    return `\u0000${spans.length - 1}\u0000`
  })
  return [masked, spans]
}

// The NUL is the point — see maskInlineCode above. A placeholder that could
// appear in real prose would let the tightener corrupt text it was meant to
// protect, which is the whole failure this avoids.
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate, see above
const unmask = (line, spans) => line.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)])

export function tighten(source, { code = false } = {}) {
  let fence = null
  let hits = 0

  const out = source.split('\n').map((line) => {
    const trimmed = line.trimStart()

    // Fenced blocks, either fence style, are code from open to close.
    const mark = trimmed.match(/^(```+|~~~+)/)
    if (mark) {
      if (!fence) fence = mark[1][0]
      else if (mark[1][0] === fence) fence = null
      return line
    }
    if (fence) return line

    // Source comments keep the codebase's own convention.
    if (code && /^(\/\/|\/\*|\*)/.test(trimmed)) return line

    const [masked, spans] = maskInlineCode(line)
    const found = masked.match(SPACED_EM)
    if (!found) return line
    hits += found.length
    return unmask(masked.replace(SPACED_EM, '—'), spans)
  })

  return { text: out.join('\n'), hits }
}

// --- CLI --------------------------------------------------------------------

// Only when run directly. Importing this module (the tests do) must not trip
// the argument parser and exit the process.
import { fileURLToPath } from 'node:url'
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()

function main() {
const args = process.argv.slice(2)
const write = args.includes('--write')
const check = args.includes('--check')
let files = args.filter((a) => !a.startsWith('--'))

if (!write && !check) {
  console.error('Usage: tighten-em-dashes.mjs --check|--write [files…]')
  process.exit(2)
}

if (files.length === 0) {
  files = execSync('git ls-files "*.md"', { encoding: 'utf8' }).split('\n').filter(Boolean)
}

let total = 0
const touched = []

for (const file of files) {
  if (!/\.(md|ts|js|mjs)$/.test(file)) continue
  // Test fixtures are data, not prose. Rewriting them turns assertions into
  // tautologies that still report green — which is exactly what happened to
  // test/em-dashes.test.ts the first time this hook ran over it.
  if (/(^|\/)test\//.test(file) || /\.test\.[tj]s$/.test(file)) continue
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    continue // staged then deleted, or a path that moved
  }
  const { text, hits } = tighten(source, { code: /\.(ts|js|mjs)$/.test(file) })
  if (!hits) continue
  total += hits
  touched.push(`${file} (${hits})`)
  if (write) writeFileSync(file, text)
}

if (total === 0) {
  if (check) console.log('em dashes: clean')
  process.exit(0)
}

console.log(`${write ? 'Tightened' : 'Found'} ${total} spaced em dash${total === 1 ? '' : 'es'}:`)
for (const t of touched) console.log(`  ${t}`)

if (check) {
  console.log('\nFix with: npm run fix:dashes')
  console.log('If a line genuinely needs spacing, use an en dash: a – b')
  process.exit(1)
}
}
