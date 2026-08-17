// The FAQ index and the suggestion matcher.
//
// Two failures worth a test. The parser reads ids that are a PUBLIC CONTRACT —
// other pages link to /faq#gps-ignores-route — so a regex that stops matching
// silently empties the suggestion strip rather than breaking anything visibly.
// And the matcher's threshold is the whole difference between a useful strip and
// one riders learn to ignore: three irrelevant suggestions under every question
// is worse than none.
//
// The real faq.html is parsed at the end, so a change to its markup fails here
// rather than in production.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { matchFaq, parseFaq, tokenize } from '../src/feedback/faq'
import type { FaqEntry } from '../src/feedback/faq'

const SAMPLE = `
<details id="need-a-motorcycle">
  <summary>Do I need a motorcycle to use this?</summary>
  <p>No.</p>
</details>
<details id="is-it-navigation" class="x">
  <summary>Is this a navigation app? Will it give me turn-by-turn directions?</summary>
</details>
<details id="waypoint-vs-poi">
  <summary>What&#39;s the difference between a <em>waypoint</em>, a POI and a stop?</summary>
</details>
`

describe('parseFaq', () => {
  it('reads every entry with its id and question', () => {
    const out = parseFaq(SAMPLE)
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ id: 'need-a-motorcycle', q: 'Do I need a motorcycle to use this?' })
  })

  it('strips inline markup and decodes entities', () => {
    const out = parseFaq(SAMPLE)
    expect(out[2].q).toBe("What's the difference between a waypoint, a POI and a stop?")
  })

  it('keeps document order, which is the order the FAQ was written in', () => {
    expect(parseFaq(SAMPLE).map((e) => e.id)).toEqual(['need-a-motorcycle', 'is-it-navigation', 'waypoint-vs-poi'])
  })

  // A missing suggestion strip is a far smaller failure than a 500 on the
  // intake, so nothing in here throws.
  it('returns an empty list rather than throwing on markup it does not recognize', () => {
    expect(parseFaq('')).toEqual([])
    expect(parseFaq('<p>no details here</p>')).toEqual([])
    expect(parseFaq('<details><summary>No id</summary></details>')).toEqual([])
  })
})

describe('tokenize', () => {
  it('drops stop words and anything shorter than three characters', () => {
    expect(tokenize('How do I import a GPX file?')).toEqual(['import', 'gpx', 'file'])
  })

  // The FAQ copy uses curly apostrophes and a phone keyboard produces them too,
  // so "what's" typed on a phone must tokenize like "whats" in the markup.
  it('folds curly and straight apostrophes alike', () => {
    expect(tokenize("what's")).toEqual(tokenize('what’s'))
  })

  it('keeps route, ride and map, which are the words that distinguish entries', () => {
    expect(tokenize('my route on the map')).toEqual(['route', 'map'])
  })

  it('returns nothing for empty or all-stop-word input', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('how do I')).toEqual([])
  })
})

describe('matchFaq', () => {
  const entries: FaqEntry[] = parseFaq(SAMPLE)

  it('finds the entry sharing the most words', () => {
    const out = matchFaq(entries, 'does it do turn-by-turn navigation directions')
    expect(out[0].id).toBe('is-it-navigation')
  })

  // The threshold matters more than the ranking. A strip that always shows three
  // suggestions teaches a rider to stop looking at it.
  it('returns nothing when nothing is close', () => {
    expect(matchFaq(entries, 'my chain needs adjusting')).toEqual([])
  })

  it('returns nothing for empty input', () => {
    expect(matchFaq(entries, '')).toEqual([])
    expect(matchFaq(entries, 'how do I')).toEqual([])
  })

  it('caps the results', () => {
    expect(matchFaq(entries, 'motorcycle navigation waypoint stop', 2).length).toBeLessThanOrEqual(2)
  })

  it('is total against an empty index', () => {
    expect(matchFaq([], 'anything at all')).toEqual([])
  })
})

describe('the real FAQ', () => {
  const html = readFileSync('src/content/faq.html', 'utf8')
  const entries = parseFaq(html)

  // The guard against a markup change quietly emptying the strip.
  it('parses every question in src/content/faq.html', () => {
    const summaries = (html.match(/<summary/g) ?? []).length
    expect(entries.length).toBe(summaries)
    expect(entries.length).toBeGreaterThan(10)
  })

  it('gives every entry a usable id and a non-empty question', () => {
    for (const e of entries) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/)
      expect(e.q.length).toBeGreaterThan(5)
    }
  })

  it('has no duplicate ids, since they are anchors', () => {
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length)
  })

  // The case the strip exists for: a rider typing a real question in their own
  // words gets the entry that answers it.
  it('matches a question asked in a rider’s own words', () => {
    const out = matchFaq(entries, 'why does my gps ignore the route I planned')
    expect(out.length).toBeGreaterThan(0)
    expect(out.map((e) => e.id)).toContain('gps-ignores-route')
  })
})
