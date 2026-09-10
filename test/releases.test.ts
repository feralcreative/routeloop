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
import { allReleases, latestRelease, releaseDate, releaseId, withAnchors } from '../src/releases/latest'
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
    const html = wrap('<section class="rn-release"><h3>8 September 2026 &mdash; the &#8942; menu</h3></section>')
    expect(latestRelease(html)?.title).toBe('8 September 2026 — the \u22ee menu')
  })

  // The ampersand is decoded LAST, or it eats the leading & of every entity
  // beside it and turns "&amp;mdash;" into an em dash.
  it('does not double-decode an escaped ampersand', () => {
    const html = wrap('<section class="rn-release"><h3>8 September 2026 &amp;mdash; stays literal</h3></section>')
    expect(latestRelease(html)?.title).toBe('8 September 2026 &mdash; stays literal')
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

// #288's second half, Ziad's call 2026-09-09: the page keeps 100% of the notes
// and EVERY release is referenced in notifications. Thirty-one of the forty-two
// sections are longer than the 400-character `body` column and the largest is
// over six thousand, so the row carries a heading, a derived sentence or two,
// and a link to that entry's anchor.
describe('every release, not just the newest', () => {
  const html = readFileSync('src/content/release-notes.html', 'utf8')
  const all = allReleases(html)

  // COUNTED AGAINST THE FILE, not a floor. A heading with no readable date is
  // DROPPED — it cannot be placed chronologically and inventing a date would
  // order it wrongly — so without this the loss is silent: the release simply
  // never reaches anybody's notifications and the page still shows it.
  it('reads every release section the file ships, losing none', () => {
    const sections = (html.replace(/<!--[^]*?-->/g, '').match(/<section class="rn-release">/g) || []).length
    expect(sections).toBeGreaterThan(30)
    expect(all.length).toBe(sections)
    expect(all[0]).toEqual(latestRelease(html))
  })

  // A collision would make two releases one row and lose the older, and the id
  // is also the page anchor, so a duplicate links both to the same place.
  it('gives every release its own id', () => {
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length)
  })

  // THE DATE IS WHAT PUTS IT IN THE LIST. The centre orders by created_at, so a
  // release with no date would have to fall back to "now" and land the whole
  // history in a block at the top — the opposite of mixing it chronologically.
  it('dates every release from its own heading', () => {
    for (const r of all) expect(Number.isFinite(r.at)).toBe(true)
  })

  it('is newest first, the order the file is authored in', () => {
    for (let i = 1; i < all.length; i++) expect(all[i - 1].at).toBeGreaterThanOrEqual(all[i].at)
  })

  // Comfortably inside the body column, and short enough to read as a line in a
  // list rather than as the release itself.
  it('summarizes every release inside the column that stores it', () => {
    for (const r of all) {
      expect(r.summary.length).toBeGreaterThan(0)
      expect(r.summary.length).toBeLessThanOrEqual(220)
    }
  })

  it('summarizes from the release own first bullet', () => {
    const got = allReleases(
      wrap(
        '<section class="rn-release"><h3>8 September 2026 &mdash; a thing</h3><ul>' +
          '<li><strong>The headline.</strong> The rest of it.</li>' +
          '<li>A second bullet nobody asked for.</li></ul></section>',
      ),
    )
    expect(got[0].summary).toBe('The headline. The rest of it.')
  })

  it('takes two sentences at most, cut on a sentence boundary', () => {
    const long = 'One. Two. Three. ' + 'x'.repeat(400)
    const got = allReleases(
      wrap(`<section class="rn-release"><h3>8 September 2026 &mdash; t</h3><ul><li>${long}</li></ul></section>`),
    )
    expect(got[0].summary).toBe('One. Two.')
  })
})

// The month names, because a date read wrongly orders a release wrongly and
// looks like a data problem rather than a parser one.
describe('reading a date out of a heading', () => {
  // MIDDAY, not midnight: notifications.created_at is a real instant rendered in
  // the rider's own zone, so a midnight stamp shows an 8 September release as
  // the 7th to everybody west of Greenwich. Seen in dev before it was fixed.
  it('reads the house style, at midday so the date survives every zone', () => {
    expect(releaseDate('8 September 2026 — a thing')).toBe(Date.UTC(2026, 8, 8, 12))
  })

  it('renders as the authored date from UTC-11 to UTC+11', () => {
    const at = releaseDate('8 September 2026 — a thing')!
    for (const offset of [-11, -8, 0, 5.5, 11]) {
      const shifted = new Date(at + offset * 3600_000)
      expect(shifted.getUTCDate()).toBe(8)
    }
  })

  // The single oldest catch-all names a month and no day.
  it('takes a bare month as the first of it', () => {
    expect(releaseDate('Before all that, July 2026')).toBe(Date.UTC(2026, 6, 1, 12))
  })

  it('is null for a heading with no date at all, rather than guessing', () => {
    expect(releaseDate('a heading with no date')).toBeNull()
  })
})

// A notification links to `/release-notes#<id>`, so the anchor has to exist and
// has to equal releaseId(heading) exactly. Injected at render rather than
// authored: an id typed by hand is one transposed character from a link that
// lands nowhere, which is the argument stamp-release.ts makes about the commit.
describe('the anchors a notification links to', () => {
  const html = readFileSync('src/content/release-notes.html', 'utf8')

  it('gives every shipped release an anchor matching its id', () => {
    const out = withAnchors(html)
    for (const r of allReleases(html)) expect(out).toContain(`id="${r.id}"`)
  })

  it('leaves a section that already carries an id alone', () => {
    const src = wrap('<section class="rn-release" id="mine"><h3>8 September 2026 &mdash; a thing</h3></section>')
    expect(withAnchors(src)).toContain('id="mine"')
    expect(withAnchors(src)).not.toContain('id="8-september')
  })

  // The worked example inside the authoring contract must not be given one —
  // it is documentation, and an id there would be a duplicate on the page.
  it('does not touch a release block inside an HTML comment', () => {
    const src = wrap(
      '<!--\n  <section class="rn-release">\n    <h3>24 August 2026</h3>\n  </section>\n-->\n' +
        '<section class="rn-release"><h3>8 September 2026 &mdash; real</h3></section>',
    )
    expect((withAnchors(src).match(/id="/g) || []).length).toBe(1)
  })

  it('is safe to run twice', () => {
    const once = withAnchors(html)
    expect(withAnchors(once)).toBe(once)
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
