#!/usr/bin/env node
// Production minifier for the two kinds of file that ship to a browser
// VERBATIM: `public/js/*.js`, which serveStatic sends exactly as committed, and
// `src/content/*.html`, which content() reads and returns as-is. Everything
// else is already handled — sass compiles with `--style=compressed`, and the
// JSX views are transpiled by tsx, whose output carries no comments.
//
// Two passes, deliberately unequal:
//
//   JS    esbuild, full minify (whitespace, identifiers, syntax). Comments go
//         with it. `*.min.js` is skipped because it is somebody else's build
//         output (uplot) and re-minifying it buys nothing.
//   HTML  comments only. latest.ts and test/content.test.ts read these files
//         with regexes that assume the line structure the author wrote, and
//         release-notes.html holds a `<section>` INSIDE a comment that both of
//         them mask before searching — so the comments have to go before that
//         markup is served, and the whitespace has to stay.
//
// Usage:
//   node utils/minify-dist.mjs             writes to dist/, reports sizes
//   node utils/minify-dist.mjs --in-place  rewrites the sources (Dockerfile)
//
// --in-place REFUSES TO RUN INSIDE A GIT CHECKOUT. The Dockerfile copies
// `public` and `src` by name and no `.git`, so the image is the only place the
// guard passes; on a laptop it would overwrite the committed sources with
// comment-free one-liners and the next `git diff` would be every file.
import { transform } from 'esbuild'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const ROOT = process.cwd()
const inPlace = process.argv.includes('--in-place')

if (inPlace) {
  let git = false
  try {
    git = statSync(join(ROOT, '.git')).isDirectory()
  } catch {
    /* no .git — the image */
  }
  if (git) {
    console.error('minify-dist: --in-place refused inside a git checkout; run it in the image, or without the flag to write dist/')
    process.exit(1)
  }
}

const OUT = inPlace ? ROOT : join(ROOT, 'dist')

const files = (dir, ext) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => join(dir, f))

const js = files('public/js', '.js').filter((f) => !f.endsWith('.min.js'))
const html = files('src/content', '.html')

// The stripped comment leaves its line behind; collapse the blank run so the
// file does not open with a dozen empty lines where the authoring contract was.
const stripHtmlComments = (s) => s.replace(/<!--[^]*?-->/g, '').replace(/\n{3,}/g, '\n\n').replace(/^\s*\n/, '')

const bytes = (s) => Buffer.byteLength(s, 'utf8')
const rows = []
const write = (rel, out) => {
  const dest = join(OUT, rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, out)
}

for (const rel of js) {
  const src = readFileSync(join(ROOT, rel), 'utf8')
  // target esnext: no syntax is lowered, so what ships is the same language
  // the source was written in, only shorter. Warnings are surfaced because
  // esbuild's include the duplicate-declaration case map-globals.test.ts
  // exists for.
  const { code, warnings } = await transform(src, { loader: 'js', minify: true, target: 'esnext', legalComments: 'none' })
  for (const w of warnings) console.warn(`minify-dist: ${rel}: ${w.text}`)
  write(rel, code)
  rows.push([rel, bytes(src), bytes(code)])
}

for (const rel of html) {
  const src = readFileSync(join(ROOT, rel), 'utf8')
  const out = stripHtmlComments(src)
  write(rel, out)
  rows.push([rel, bytes(src), bytes(out)])
}

const fmt = (n) => n.toLocaleString('en-US').padStart(11)
const pct = (a, b) => `${(((a - b) / a) * 100).toFixed(1).padStart(5)}%`
const sum = (i) => rows.reduce((t, r) => t + r[i], 0)
console.log(`${'file'.padEnd(36)}${'before'.padStart(11)}${'after'.padStart(11)}   saved`)
for (const [rel, a, b] of rows) console.log(`${rel.padEnd(36)}${fmt(a)}${fmt(b)}  ${pct(a, b)}`)
console.log(`${'total'.padEnd(36)}${fmt(sum(1))}${fmt(sum(2))}  ${pct(sum(1), sum(2))}`)
if (!inPlace) console.log(`\nwritten to ${relative(ROOT, OUT)}/`)
