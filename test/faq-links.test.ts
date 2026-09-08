// EVERY `?` HAS AN ANSWER TO SHOW, AND THE ANCHOR IS THE ONLY THING HOLDING THE
// TWO TOGETHER.
//
// #268's whole premise is one source and two surfaces: the copy stays in
// `src/content/faq.html` and `faqLink(anchor, …)` addresses it by the same id the
// link already used. Nothing else checks that the id still resolves — a renamed
// FAQ entry degrades to the old jump-to-the-page behavior, silently, which is a
// good failure mode and a bad thing to discover in production.
//
// TEXT, NOT A RENDER. `faqLink` reads the file through `content()`, so calling it
// here would work — but the useful assertion is about the CALL SITES, and those
// are string literals in a template. Reading them out is what makes this catch a
// third caller added later.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { faqAnswer, parseFaq } from '../src/feedback/faq'

const FAQ = readFileSync('src/content/faq.html', 'utf8')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

/** Every anchor faqLink() is actually called with, read out of the call sites. */
const anchorsInUse = (): string[] => {
  const out = new Set<string>()
  for (const file of sourceFiles('src')) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/faqLink\(\s*'([^']+)'/g)) out.add(m[1])
    for (const m of src.matchAll(/faqLink\(\s*"([^"]+)"/g)) out.add(m[1])
  }
  return [...out]
}

describe('faqLink anchors', () => {
  // A floor, so a refactor that stops matching the call sites fails here rather
  // than passing over an empty list.
  it('finds the call sites at all', () => {
    expect(anchorsInUse().length).toBeGreaterThan(0)
  })

  it('names an entry that exists in faq.html', () => {
    const ids = new Set(parseFaq(FAQ).map((e) => e.id))
    const missing = anchorsInUse().filter((a) => !ids.has(a))
    expect(missing).toEqual([])
  })

  // THE STRONGER ONE. An id can exist and still yield nothing to show if the
  // entry's shape changes — faqAnswer reads from `</summary>` to the matching
  // `</details>`, and a `?` that opens an empty card is worse than one that
  // jumps to the page.
  it('has an answer body worth showing', () => {
    for (const anchor of anchorsInUse()) {
      const answer = faqAnswer(FAQ, anchor)
      expect(answer, anchor).toBeTruthy()
      expect(answer!.length, anchor).toBeGreaterThan(40)
    }
  })
})

describe('faqAnswer', () => {
  it('returns null for an id that is not there', () => {
    expect(faqAnswer(FAQ, 'no-such-entry')).toBeNull()
  })

  // MATCHED BY NESTING DEPTH, NOT BY THE FIRST `</details>`. An answer may hold
  // one of its own, and stopping at the first close truncates it mid-sentence —
  // which reads as bad copy rather than as a bug.
  it('reads past a nested details block', () => {
    const html = [
      '<details id="outer"><summary>Q</summary>',
      '<div class="qa-answer"><p>before</p>',
      '<details id="inner"><summary>sub</summary><p>nested</p></details>',
      '<p>after</p></div>',
      '</details>',
    ].join('\n')
    const answer = faqAnswer(html, 'outer')
    expect(answer).toContain('before')
    expect(answer).toContain('nested')
    expect(answer).toContain('after')
  })

  it('does not bleed into the entry that follows', () => {
    const html =
      '<details id="a"><summary>A</summary><p>one</p></details><details id="b"><summary>B</summary><p>two</p></details>'
    expect(faqAnswer(html, 'a')).not.toContain('two')
  })
})
