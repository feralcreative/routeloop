// The top release in the notes, as something that can be announced.
//
// THE CASE THIS FILE EXISTS FOR IS THE COMMENT AT THE TOP OF THE FILE. It is
// the file's own authoring contract and it contains a worked example of a
// stamped release block, so a naive search finds the EXAMPLE — which here would
// mean announcing "24 August 2026" to every rider on the first deploy. Two other
// readers of this same file have hit it: utils/stamp-release.ts, which would
// have rewritten the documentation instead of the release, and
// test/content.test.ts.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { latestRelease, releaseId } from '../src/releases/latest'
import { content } from '../src/views/content'
import { NOTES_FILE } from '../src/notifications/announce'

const wrap = (body: string) => `<h1>What's new</h1>\n${body}`

describe('the newest release', () => {
  it('reads the heading of the first section', () => {
    const got = latestRelease(
      wrap('<section class="rn-release">\n  <h3>8 September 2026 &mdash; a thing changed</h3>\n</section>'),
    )
    expect(got?.title).toBe('8 September 2026 — a thing changed')
  })

  // THE STORED TITLE IS PROSE, NOT MARKUP, and it shipped as markup for one
  // build. Views are Hono JSX and JSX escapes by default, so a rider saw the
  // literal text "&mdash;" in their notification centre. The email's text arm
  // could never have rendered an entity at all.
  it('decodes the entities the notes are written with', () => {
    const html = wrap(
      '<section class="rn-release"><h3>8 September 2026 &mdash; Ziad&rsquo;s call, &ldquo;quoted&rdquo; &amp; more</h3></section>',
    )
    expect(latestRelease(html)?.title).toBe('8 September 2026 \u2014 Ziad\u2019s call, \u201cquoted\u201d & more')
  })

  it('decodes a numeric entity, which the notes also use', () => {
    const html = wrap('<section class="rn-release"><h3>the &#8942; menu</h3></section>')
    expect(latestRelease(html)?.title).toBe('the \u22ee menu')
  })

  // The ampersand is decoded LAST, or it eats the leading & of every entity
  // beside it and turns "&amp;mdash;" into an em dash.
  it('does not double-decode an escaped ampersand', () => {
    const html = wrap('<section class="rn-release"><h3>&amp;mdash; stays literal</h3></section>')
    expect(latestRelease(html)?.title).toBe('&mdash; stays literal')
  })

  it('takes the newest of several, not the oldest', () => {
    const html = wrap(
      '<section class="rn-release"><h3>9 September 2026 &mdash; newest</h3></section>' +
        '<section class="rn-release"><h3>8 September 2026 &mdash; older</h3></section>',
    )
    expect(latestRelease(html)?.title).toBe('9 September 2026 — newest')
  })

  // THE WHOLE REASON FOR THE MASK. Without it the first match is the worked
  // example inside the authoring contract.
  it('ignores a release block that is inside an HTML comment', () => {
    const html = wrap(
      '<!--\n  HOW TO ADD A RELEASE:\n    <section class="rn-release">\n      <h3>24 August 2026 <code>2026-08-24-0912PT</code></h3>\n    </section>\n-->\n' +
        '<section class="rn-release"><h3>8 September 2026 &mdash; the real one</h3></section>',
    )
    expect(latestRelease(html)?.title).toBe('8 September 2026 — the real one')
  })

  it('drops the build stamp and the commit link from the title', () => {
    const html = wrap(
      '<section class="rn-release">\n  <h3>8 September 2026 &mdash; a thing <code>2026-09-08-1834PT</code>\n' +
        '    <a class="rn-sha" href="https://github.com/feralcreative/routeloop/commit/abc"><code>abc1234</code></a>\n  </h3>\n</section>',
    )
    expect(latestRelease(html)?.title).toBe('8 September 2026 — a thing')
  })

  // Null is a real answer, not a failure: a checkout with no releases yet has
  // nothing to announce and that is correct.
  it('is null when there is no release section', () => {
    expect(latestRelease(wrap('<p>nothing here</p>'))).toBeNull()
    expect(latestRelease('')).toBeNull()
  })

  // The real file, because a fixture written to suit the parser is how the
  // corridor bug got through for two weeks.
  it('reads the release notes this repo actually ships', () => {
    const got = latestRelease(readFileSync('src/content/release-notes.html', 'utf8'))
    expect(got).not.toBeNull()
    expect(got!.title).not.toMatch(/24 August 2026/)
    expect(got!.id.length).toBeGreaterThan(0)
  })
})

// The name announce.ts passes to content(), which joins it onto src/content/ and
// THROWS when it is not there. It was 'release-notes' without the extension for
// one build: every boot threw, the catch at the call site swallowed it, and the
// feature was silently off on an app that was otherwise perfectly healthy. That
// is the failure this file cannot see by reading the notes directly — its own
// fixtures use readFileSync, which does not care what content() would accept.
describe('the file the announcer actually asks for', () => {
  it('resolves through content(), extension and all', () => {
    expect(() => content(NOTES_FILE)).not.toThrow()
    expect(latestRelease(content(NOTES_FILE))).not.toBeNull()
  })
})

describe('the id that stops it being announced twice', () => {
  // Stamping is documented to happen AFTER the deploy, so the same release is
  // read both with and without its stamp. One id, or every rider hears twice.
  it('is unchanged by stamping the release afterwards', () => {
    const bare = latestRelease(wrap('<section class="rn-release"><h3>8 September 2026 &mdash; a thing</h3></section>'))
    const stamped = latestRelease(
      wrap(
        '<section class="rn-release"><h3>8 September 2026 &mdash; a thing <code>2026-09-08-1834PT</code>' +
          '<a class="rn-sha" href="https://x/commit/abc"><code>abc1234</code></a></h3></section>',
      ),
    )
    expect(stamped!.id).toBe(bare!.id)
  })

  // Two releases on one day is the house style — 26 August 2026 carries three —
  // so the date alone cannot be the id.
  it('separates two releases dated the same day', () => {
    expect(releaseId('8 September 2026 &mdash; one thing')).not.toBe(
      releaseId('8 September 2026 &mdash; another thing'),
    )
  })

  it('is stable across entity and punctuation noise', () => {
    expect(releaseId('8 September 2026 &mdash; a thing')).toBe(releaseId('8 September 2026 — a thing'))
  })

  it('is bounded, so it fits the column that stores it', () => {
    expect(releaseId('x'.repeat(400)).length).toBeLessThanOrEqual(120)
  })
})
