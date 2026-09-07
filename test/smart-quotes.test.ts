// The curly-quote sweeper, and mostly the things it must NOT touch.
//
// House rule, set 2026-09-07: rider-facing copy uses typographic quotes. The
// tool is the enforcement, the same arrangement `npm run check:dashes` has.
//
// **THE ASSERTIONS THAT MATTER ARE THE NEGATIVE ONES.** An em dash is
// punctuation wherever it appears, so its tightener can be careless about
// context; a straight quote is usually a STRING DELIMITER, and a sweeper that
// gets that wrong does not produce bad prose, it produces a repo that does not
// parse. Both failures below were real, caught by diffing before writing rather
// than by the check.
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs with no types, the same as the dash tightener
import { curl, curlHtml } from '../utils/smart-quotes.mjs'

const one = (s: string) => curl(s).text

describe('curl', () => {
  it('curls a contraction in a string literal', () => {
    expect(one(`const a = "Something's broken"`)).toBe(`const a = "Something’s broken"`)
  })

  it('curls a contraction in JSX text', () => {
    expect(one(`      <h1>What's going on?</h1>`)).toBe(`      <h1>What’s going on?</h1>`)
  })

  // A DELIMITER HAS A NON-WORD CHARACTER ON AT LEAST ONE SIDE, always — a
  // string ends before the letter that would follow its closing quote. That is
  // the whole safety argument for the rule, so it is asserted rather than
  // trusted.
  it('never touches a string delimiter', () => {
    const src = `const kinds = ['bug', 'idea', "question"]`
    expect(one(src)).toBe(src)
  })

  it('leaves an escaped apostrophe alone, because it is already correct code', () => {
    const src = `const a = 'don\\'t'`
    expect(one(src)).toBe(src)
  })

  // FAILURE ONE. The first version walked the file with a character scanner
  // that tracked strings and comments together, and desynchronized on the first
  // template literal: bailing out at `${` left the closing backtick to be read
  // as an opening one, and every comment after it was rewritten.
  it('leaves comments alone, in all four shapes this codebase writes', () => {
    const src = [
      `// The rider's corrections, when the review table sent any.`,
      `/* A block comment about the builder's state. */`,
      `/**`,
      ` * Starts the bin's timer.`,
      ` */`,
      `const x = 1 // trailing: the group's clock`,
    ].join('\n')
    expect(one(src)).toBe(src)
  })

  // FAILURE TWO. A JSX comment's continuation lines are plain indented prose
  // with no leading `*`, so missing the `{/*` opener left the whole block
  // looking like code — it rewrote the panel-toggle notes in layout.tsx.
  it('leaves a JSX comment alone, including its unmarked continuation lines', () => {
    const src = [
      `            {/*`,
      `              the button's own aria-expanded, so the pair`,
      `            */}`,
    ].join('\n')
    expect(one(src)).toBe(src)
  })

  it('still converts code on a line that also carries a trailing comment', () => {
    expect(one(`const a = "it's here" // the rider's note`)).toBe(`const a = "it’s here" // the rider's note`)
  })

  it('does not mistake a URL for a comment', () => {
    expect(one(`const u = 'https://x/y' + "it's"`)).toBe(`const u = 'https://x/y' + "it’s"`)
  })
})

describe('curlHtml', () => {
  it('curls contractions and pairs double quotes in a text node', () => {
    expect(curlHtml(`<p>What's new: "a thing"</p>`).text).toBe(`<p>What’s new: “a thing”</p>`)
  })

  it('never touches an attribute', () => {
    const src = `<section class="rn-release" data-x="a b">text</section>`
    expect(curlHtml(src).text).toBe(src)
  })

  // FAILURE THREE, and the one with teeth. `<!-- … -->` spans lines and
  // routinely CONTAINS a `>` — release-notes.html carries a worked example of a
  // stamped `<section class="rn-release">` inside one — so a tag pattern of
  // `<[^>]*>` ends at that inner bracket and reads the rest of the comment as
  // prose, curling the quotes in markup that would then no longer parse if the
  // block were uncommented.
  it('leaves an HTML comment alone even when it contains markup', () => {
    const src = `<!--\n  <section class="rn-release">\n  It's an example.\n-->\n<p>It's real.</p>`
    const out = curlHtml(src).text
    expect(out).toContain(`class="rn-release"`)
    expect(out).toContain(`It's an example.`)
    expect(out).toContain(`<p>It’s real.</p>`)
  })

  it('opens and closes double quotes in order', () => {
    expect(curlHtml(`<p>"a" and "b"</p>`).text).toBe(`<p>“a” and “b”</p>`)
  })
})

describe('the repo itself', () => {
  it('reports clean, which is what the check script asserts in CI', async () => {
    const { readFileSync } = await import('node:fs')
    const { execSync } = await import('node:child_process')
    const files = execSync('git ls-files "src/**/*.ts" "src/**/*.tsx" "src/content/*.html" "public/js/*.js"', {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .filter((f) => !/(^|\/)test\//.test(f) && !/\.test\./.test(f) && !/\.min\.js$/.test(f))

    const dirty = files.filter((f) => {
      const src = readFileSync(f, 'utf8')
      return (f.endsWith('.html') ? curlHtml(src) : curl(src)).hits > 0
    })
    expect(dirty).toEqual([])
  })
})
