// American English, asserted.
//
// **THE HOOK IS NOT THE ENFORCEMENT — THIS IS.** `utils/us-english.mjs` runs in
// the pre-commit hook beside the em-dash tightener and the smart-quote sweeper,
// which is what FIXES a spelling before it lands. But a hook is per-clone
// (`git config core.hooksPath .githooks`, once, by hand), it is skipped by
// `--no-verify`, and it never runs at all for anything committed by a tool that
// does not go through it. This test runs in `npm test`, which is step 2 of the
// definition of done and runs on every PR and every push to main — so a British
// spelling fails somewhere a person is already looking.
//
// It reads the tree as TEXT, the same arrangement `test/content.test.ts` and
// `test/archive-completeness.test.ts` use: CI has no database and no browser,
// and this needs neither.
//
// **THE SWEEPER'S OWN TWO FILES ARE EXCLUDED BY THE SWEEPER**, not here — one
// is a list of British spellings and the other is this file, so neither can
// ever be clean. Excluding them anywhere else would be a second list.
import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
// @ts-expect-error — plain .mjs with no types, the same arrangement
// test/em-dashes.test.ts and test/smart-quotes.test.ts use for their scripts
import { americanize } from '../utils/us-english.mjs'

const FILES = execSync('git ls-files "*.md" "*.ts" "*.tsx" "*.js" "*.mjs" "*.html" "*.scss"', {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((f) => f !== 'utils/us-english.mjs' && f !== 'test/us-english.test.ts')

describe('US English', () => {
  it('finds the tracked prose files at all', () => {
    // The sanity floor `test/archive-completeness.test.ts` records the need for:
    // a glob that silently matches nothing is a test that passes forever.
    expect(FILES.length).toBeGreaterThan(200)
  })

  it('has no British spellings anywhere in the tree', () => {
    const offenders: string[] = []
    for (const f of FILES) {
      const src = readFileSync(f, 'utf8')
      const out = americanize(src)
      if (out === src) continue
      // Report the LINE, not just the file. A bare file list makes somebody
      // re-run the script to find out what it objected to.
      const a = src.split('\n')
      const b = out.split('\n')
      a.forEach((line, i) => {
        if (line !== b[i]) offenders.push(`${f}:${i + 1}\n  is:     ${line.trim()}\n  should: ${b[i].trim()}`)
      })
    }
    expect(offenders.join('\n\n')).toBe('')
  })
})
