// The content files, and the FAQ id contract in particular.
//
// The ids are not decoration. `faqLink()` in src/views/layout.ts builds links to
// them from inside the builder panel, and anyone who has shared a `/faq#…` URL
// is relying on them too. Renaming or dropping one silently breaks every inbound
// link — nothing else in the codebase would notice.
//
// So the set is checked in here, explicitly. If this test fails because a
// question was genuinely retired, update the list deliberately and go fix the
// links; do not just paste the new set in.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { content } from '../src/views/content'

const FAQ_IDS = [
  'need-a-motorcycle',
  'is-it-navigation',
  'gps-ignores-route',
  'vs-google-maps',
  'vs-other-planners',
  'spontaneity',
  'limits',
  'waypoint-poi-stop',
  'stop-categories',
  'twistiness',
  'import-a-route',
  'file-names',
  'one-file-per-day',
  'on-a-phone',
  'outside-the-us',
  'share-without-account',
  'visibility',
  'what-happens-to-my-data',
  'google-name',
  'home-address',
  'invites',
  'alpha-data-loss',
  'is-it-free',
  'who-builds-this',
]

// The ids the app actually links to. These are the ones whose loss would be
// visible to a rider rather than merely to a search engine.
const LINKED_FROM_UI = ['waypoint-poi-stop', 'visibility', 'twistiness']

const idsIn = (html: string) => [...html.matchAll(/<details class="qa" id="([^"]+)"/g)].map((m) => m[1])

describe('the FAQ id contract', () => {
  const html = readFileSync('src/content/faq.html', 'utf8')

  it('carries exactly the ids that are checked in, in order', () => {
    expect(idsIn(html)).toEqual(FAQ_IDS)
  })

  it('has no duplicates, which would make a deep link ambiguous', () => {
    const ids = idsIn(html)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('still has the ones the builder panel links to', () => {
    for (const id of LINKED_FROM_UI) expect(idsIn(html)).toContain(id)
  })

  it('gives every question a summary and an answer', () => {
    expect(html.match(/<summary>/g)?.length).toBe(FAQ_IDS.length)
    expect(html.match(/<div class="qa-answer">/g)?.length).toBe(FAQ_IDS.length)
  })
})

describe('the loader', () => {
  it('substitutes tokens', () => {
    const html = content('faq.html', { RIDING_YEARS: 27, WEB_YEARS: 33 })
    expect(html).toContain('riding for 27 years')
    expect(html).not.toContain('{{')
  })

  it('throws rather than rendering a token it was not given', () => {
    // Better than leaving `{{EFFECTIVE}}` visible on a legal page, and it
    // surfaces on the first render instead of whenever someone reads it.
    expect(() => content('privacy.html', {})).toThrow(/EFFECTIVE/)
  })

  it('throws on a missing file rather than rendering an empty page', () => {
    expect(() => content('nope.html')).toThrow(/missing/)
  })

  it('leaves no trailing blank line, which would show up before the footer', () => {
    expect(content('terms.html', { EFFECTIVE: 'x' })).not.toMatch(/\n$/)
  })

  it('supplies a token for every placeholder each page actually uses', () => {
    // The pairing that would otherwise only fail in production: a file gains a
    // token and the route that renders it is not updated.
    const supplied: Record<string, string[]> = {
      'faq.html': ['RIDING_YEARS', 'WEB_YEARS'],
      'privacy.html': ['EFFECTIVE'],
      // No tokens, and it should stay that way: the version a rider is running
      // is rendered by the dialog around this copy, not interpolated into it.
      // The file is served twice — the page at /release-notes and the fragment
      // the modal fetches — and a token would have to be supplied identically at
      // both, which is exactly the drift this test exists to catch.
      'release-notes.html': [],
      'terms.html': ['EFFECTIVE'],
    }
    for (const file of readdirSync('src/content')) {
      const used = [...readFileSync(`src/content/${file}`, 'utf8').matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
      expect(supplied[file], `${file} is not wired to a route in this test`).toBeDefined()
      expect(new Set(used)).toEqual(new Set(used.filter((u) => supplied[file].includes(u))))
    }
  })
})
