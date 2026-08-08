// The arithmetic behind the ranked table.
//
// This is the file that decides what gets built next, which makes a quiet error
// here more expensive than most bugs in this repo: a wrong denominator does not
// crash, it produces a plausible-looking order that sends a sprint in the wrong
// direction. Nothing about that is visible in review or in the rendered page.
//
// Three things in particular are pinned:
//   - the mean is over riders who RATED a bundle, not over all responses, so a
//     bundle late in a form some people abandoned is not punished for it
//   - a first pick outweighs a fifth, because the order is real information
//   - the sort is total, so the same data cannot produce two different tables
import { describe, expect, it } from 'vitest'
import { BUNDLE_IDS, EMPTY_ANSWERS, TOP_PICKS } from '../src/survey/questions'
import type { SurveyAnswers } from '../src/survey/questions'
import {
  SCORE_WEIGHTS,
  choiceTally,
  histogram,
  openAnswers,
  rankBundles,
  summaryLine,
  topRankWeight,
} from '../src/survey/score'

const B = BUNDLE_IDS

const answer = (over: Partial<SurveyAnswers> = {}): SurveyAnswers => ({
  ...EMPTY_ANSWERS,
  ratings: {},
  top: [],
  single: {},
  multi: {},
  open: {},
  ...over,
})

const find = (rows: ReturnType<typeof rankBundles>, id: string) => {
  const row = rows.find((r) => r.id === id)
  if (!row) throw new Error(`${id} missing from the ranking`)
  return row
}

describe('topRankWeight', () => {
  it('makes a first pick worth the most and a last pick worth the least', () => {
    expect(topRankWeight(1)).toBe(TOP_PICKS)
    expect(topRankWeight(TOP_PICKS)).toBe(1)
  })

  it('descends by one', () => {
    const weights = Array.from({ length: TOP_PICKS }, (_, i) => topRankWeight(i + 1))
    expect(weights).toEqual([...weights].sort((a, z) => z - a))
    expect(new Set(weights).size).toBe(TOP_PICKS)
  })

  it.each([0, -1, TOP_PICKS + 1, 1.5, Number.NaN])('scores %s as nothing', (r) => {
    expect(topRankWeight(r as number)).toBe(0)
  })
})

describe('rankBundles', () => {
  it('returns every bundle even with no responses', () => {
    const rows = rankBundles([])
    expect(rows).toHaveLength(B.length)
    expect(rows.every((r) => r.n === 0 && r.score === 0)).toBe(true)
  })

  // A bundle nobody rated is a finding, not a row to hide.
  it('keeps an unrated bundle in the table at the bottom', () => {
    const rows = rankBundles([answer({ ratings: { [B[0]]: 3 } })])
    expect(rows.some((r) => r.id === B[1])).toBe(true)
    expect(find(rows, B[1]).n).toBe(0)
  })

  it('averages only the riders who rated it', () => {
    const rows = rankBundles([
      answer({ ratings: { [B[0]]: 3 } }),
      answer({ ratings: { [B[0]]: 1 } }),
      answer({ ratings: {} }), // abandoned before reaching it
    ])
    const row = find(rows, B[0])
    expect(row.n).toBe(2)
    expect(row.mean).toBe(2)
  })

  // The distinction that keeps form fatigue out of the results. If the mean were
  // over all three responses it would read 1.33 and the bundle would sink for a
  // reason that has nothing to do with what riders want.
  it('does not let an abandoned form drag a bundle down', () => {
    const rated = rankBundles([answer({ ratings: { [B[0]]: 3 } }), answer({ ratings: { [B[0]]: 3 } })])
    const withAbandon = rankBundles([
      answer({ ratings: { [B[0]]: 3 } }),
      answer({ ratings: { [B[0]]: 3 } }),
      answer({ ratings: {} }),
    ])
    expect(find(withAbandon, B[0]).mean).toBe(find(rated, B[0]).mean)
  })

  it('counts picks and weights them by rank', () => {
    const rows = rankBundles([
      answer({ top: [B[0], B[1], B[2], B[3], B[4]] }),
      answer({ top: [B[1], B[0], B[2], B[3], B[4]] }),
    ])
    expect(find(rows, B[0]).topPicks).toBe(2)
    expect(find(rows, B[0]).topWeighted).toBe(topRankWeight(1) + topRankWeight(2))
    expect(find(rows, B[1]).topWeighted).toBe(topRankWeight(2) + topRankWeight(1))
  })

  // The whole reason picks are ordered selects rather than checkboxes.
  it('ranks a bundle picked first above one picked fifth by the same riders', () => {
    const rows = rankBundles([
      answer({ top: [B[0], B[1], B[2], B[3], B[4]] }),
      answer({ top: [B[0], B[1], B[2], B[3], B[4]] }),
    ])
    expect(rows[0].id).toBe(B[0])
    expect(find(rows, B[0]).score).toBeGreaterThan(find(rows, B[4]).score)
  })

  // The ceiling effect the forced five exists to break. Both bundles are rated
  // "must have" by everyone; only one gets picked. It has to win.
  it('separates two bundles that everyone rated identically', () => {
    const responses = [
      answer({ ratings: { [B[0]]: 3, [B[1]]: 3 }, top: [B[0], B[2], B[3], B[4], B[5]] }),
      answer({ ratings: { [B[0]]: 3, [B[1]]: 3 }, top: [B[0], B[2], B[3], B[4], B[5]] }),
    ]
    const rows = rankBundles(responses)
    expect(find(rows, B[0]).mean).toBe(find(rows, B[1]).mean)
    expect(find(rows, B[0]).score).toBeGreaterThan(find(rows, B[1]).score)
  })

  // And the other direction: ratings still order the bundles nobody picked,
  // rather than leaving the bottom of the table in arbitrary order.
  it('still orders bundles that nobody picked, by rating', () => {
    const rows = rankBundles([answer({ ratings: { [B[0]]: 3, [B[1]]: 0 } })])
    expect(find(rows, B[0]).score).toBeGreaterThan(find(rows, B[1]).score)
  })

  it('weights picks more heavily than ratings, as SCORE_WEIGHTS says', () => {
    expect(SCORE_WEIGHTS.picks).toBeGreaterThan(SCORE_WEIGHTS.rating)
    expect(SCORE_WEIGHTS.picks + SCORE_WEIGHTS.rating).toBeCloseTo(1)
  })

  it('caps topShare at 1 when everyone picks the same thing first', () => {
    const rows = rankBundles([answer({ top: [B[0]] }), answer({ top: [B[0]] })])
    expect(find(rows, B[0]).topShare).toBe(1)
  })

  it('sorts descending by score', () => {
    const rows = rankBundles([answer({ ratings: { [B[0]]: 1, [B[1]]: 3, [B[2]]: 2 } })])
    const scores = rows.map((r) => r.score)
    expect(scores).toEqual([...scores].sort((a, z) => z - a))
  })

  // A total order matters more than which order. Without the id tiebreak, two
  // bundles with identical numbers can swap between loads and the table looks
  // like it is reporting a change.
  it('is stable for identical data', () => {
    const responses = [answer({ ratings: Object.fromEntries(B.map((id) => [id, 2])) })]
    expect(rankBundles(responses).map((r) => r.id)).toEqual(rankBundles(responses).map((r) => r.id))
  })

  it('ignores a pick for a bundle that no longer exists', () => {
    const rows = rankBundles([answer({ top: ['deleted-bundle', B[0]] })])
    expect(find(rows, B[0]).topPicks).toBe(1)
    // Weighted by its real position in the list, not by where it would have been.
    expect(find(rows, B[0]).topWeighted).toBe(topRankWeight(2))
  })
})

describe('histogram', () => {
  it('counts by rating value', () => {
    expect(
      histogram([answer({ ratings: { [B[0]]: 0 } }), answer({ ratings: { [B[0]]: 3 } }), answer({ ratings: { [B[0]]: 3 } })], B[0]),
    ).toEqual([1, 0, 0, 2])
  })

  it('is all zeroes for an unrated bundle', () => {
    expect(histogram([answer()], B[0])).toEqual([0, 0, 0, 0])
  })

  // The case the mean cannot show: a bundle half the riders must have and half
  // do not care about is a feature for a subset, not a middling feature.
  it('separates a split room from a lukewarm one', () => {
    const split = [answer({ ratings: { [B[0]]: 3 } }), answer({ ratings: { [B[0]]: 0 } })]
    const lukewarm = [answer({ ratings: { [B[0]]: 2 } }), answer({ ratings: { [B[0]]: 1 } })]
    expect(rankBundles(split)[0]).toBeDefined()
    expect(histogram(split, B[0])).toEqual([1, 0, 0, 1])
    expect(histogram(lukewarm, B[0])).toEqual([0, 1, 1, 0])
  })
})

describe('choiceTally', () => {
  it('counts a multi-choice question and sorts biggest first', () => {
    const rows = choiceTally(
      [answer({ multi: { q: ['Garmin', 'Phone'] } }), answer({ multi: { q: ['Phone'] } })],
      'q',
    )
    expect(rows[0]).toEqual({ option: 'Phone', n: 2, share: 1 })
    expect(rows[1]).toEqual({ option: 'Garmin', n: 1, share: 0.5 })
  })

  it('reads single-choice answers through the same call', () => {
    expect(choiceTally([answer({ single: { q: 'Just me' } })], 'q')).toEqual([{ option: 'Just me', n: 1, share: 1 }])
  })

  // Shares summing past 1 is correct for a multi-choice question, and is what
  // "62% of riders use Google Maps" means.
  it('lets multi-choice shares exceed 1 in total', () => {
    const rows = choiceTally([answer({ multi: { q: ['a', 'b'] } })], 'q')
    expect(rows.reduce((t, r) => t + r.share, 0)).toBe(2)
  })

  it('divides by the riders who answered, not by everyone', () => {
    const rows = choiceTally([answer({ multi: { q: ['a'] } }), answer()], 'q')
    expect(rows[0].share).toBe(1)
  })

  it('is empty when nobody answered', () => {
    expect(choiceTally([answer()], 'q')).toEqual([])
  })
})

describe('openAnswers', () => {
  it('returns the answers that have something in them', () => {
    expect(
      openAnswers([answer({ open: { q: 'the GPS rerouted me' } }), answer({ open: { q: '   ' } }), answer()], 'q'),
    ).toEqual(['the GPS rerouted me'])
  })
})

describe('summaryLine', () => {
  it('says so when there is nothing', () => {
    expect(summaryLine([])).toBe('No responses yet.')
  })

  it('counts responses and full top picks separately', () => {
    const full = answer({ top: B.slice(0, TOP_PICKS) })
    const partial = answer({ top: B.slice(0, 2) })
    expect(summaryLine([full, partial])).toBe(`2 responses, 1 with a full top ${TOP_PICKS}`)
  })

  it('uses the singular for one', () => {
    expect(summaryLine([answer()])).toContain('1 response,')
  })
})
