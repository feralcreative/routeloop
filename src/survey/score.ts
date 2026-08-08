// Turning a pile of responses into an order.
//
// The reason this is a module and not a SQL query: aggregating in JavaScript
// makes it a pure function of its input, which is the only kind of thing this
// repo can test (vitest.config.ts — pure logic, no database). A
// `GROUP BY question_key` would be untestable here and would join
// deleteExpiredLoginTokens in the category of code nobody can exercise.
//
// The arithmetic is small; the interpretation is the hard part, so it is stated
// here rather than left implicit in a template.
import { BUNDLES, TOP_PICKS, bundleLabel } from './questions'
import type { SurveyAnswers } from './questions'

export type Ranked = {
  id: string
  label: string
  /** How many riders rated it. Not the response count — a draft may skip rows. */
  n: number
  /** Mean rating over the riders who rated it, 0..3. */
  mean: number
  /** How many riders put it in their five. */
  topPicks: number
  /** Sum of rank weights: a first pick is worth 5, a fifth is worth 1. */
  topWeighted: number
  /** 0..1. topWeighted over the most it could possibly have scored. */
  topShare: number
  /** The composite the table sorts by. See SCORE_WEIGHTS. */
  score: number
}

/**
 * A first pick counts for more than a fifth.
 *
 * The five picks are captured as ordered selects, so the order is real
 * information a rider deliberately gave. Treating them as a flat set would throw
 * it away, and the difference between "the thing I most want" and "the fifth
 * thing I thought of" is most of what the question was for.
 */
export function topRankWeight(rank: number): number {
  if (!Number.isInteger(rank) || rank < 1 || rank > TOP_PICKS) return 0
  return TOP_PICKS + 1 - rank
}

/**
 * How the two halves combine.
 *
 * This is a PRESENTATION CHOICE, not a fact about riders, and it is a named
 * constant so it can be argued with rather than reverse-engineered out of an
 * expression.
 *
 * The rating grid alone inflates: with a friendly audience most things land on
 * "would use" and the middle of the table is noise. The forced five is what
 * actually separates, because a rider spending a pick on one bundle is not
 * spending it on another. So the picks carry the larger share, and the ratings
 * keep the bundles nobody picked in a sensible order rather than a random one.
 */
export const SCORE_WEIGHTS = { rating: 0.4, picks: 0.6 } as const

const MAX_RATING_VALUE = 3

/**
 * Every bundle, ordered most-wanted first.
 *
 * Includes bundles nobody rated, at the bottom with n=0 — a bundle everyone
 * skipped is a finding, and dropping it from the table would hide it.
 *
 * The mean is over the riders who RATED that bundle, not over all responses.
 * Dividing by the response count instead would punish a bundle for appearing
 * late in a form some people abandoned, which measures form fatigue rather than
 * what riders want.
 */
export function rankBundles(responses: readonly SurveyAnswers[]): Ranked[] {
  const maxWeightPerRider = topRankWeight(1)

  const rows = BUNDLES.map((b) => {
    let sum = 0
    let n = 0
    let topPicks = 0
    let topWeighted = 0

    for (const r of responses) {
      const rating = r.ratings[b.id]
      if (typeof rating === 'number') {
        sum += rating
        n += 1
      }
      const rank = r.top.indexOf(b.id)
      if (rank !== -1) {
        topPicks += 1
        topWeighted += topRankWeight(rank + 1)
      }
    }

    const mean = n === 0 ? 0 : sum / n
    // Over all responses, not just the raters: a pick is a choice against every
    // other bundle, so the denominator is everyone who could have made it.
    const topShare = responses.length === 0 ? 0 : topWeighted / (responses.length * maxWeightPerRider)
    const score = SCORE_WEIGHTS.rating * (mean / MAX_RATING_VALUE) + SCORE_WEIGHTS.picks * topShare

    return { id: b.id, label: b.label, n, mean, topPicks, topWeighted, topShare, score }
  })

  // Deterministic all the way down, including the all-zeroes case: two bundles
  // with identical numbers must not swap places between two loads of the same
  // page, or the table looks like it is telling you something when it is not.
  return rows.sort(
    (a, z) => z.score - a.score || z.topWeighted - a.topWeighted || z.mean - a.mean || a.id.localeCompare(z.id),
  )
}

/**
 * The spread of ratings for one bundle, as counts by rating value.
 *
 * Worth having beside the mean because they answer different questions. A
 * bundle that everyone calls "would use" and one that half call "must have" and
 * half call "don't care" can share a mean, and they are not the same finding —
 * the second is a feature for a subset, which is a different decision.
 */
export function histogram(responses: readonly SurveyAnswers[], bundleId: string): number[] {
  const counts = [0, 0, 0, 0]
  for (const r of responses) {
    const v = r.ratings[bundleId]
    if (typeof v === 'number' && v >= 0 && v < counts.length) counts[v] += 1
  }
  return counts
}

export type Tally = { option: string; n: number; share: number }

/**
 * Counts for one choice question, biggest first.
 *
 * Reads both maps, so one call serves single- and multi-choice questions and the
 * caller does not have to know which it is asking about. `share` is over
 * respondents, so for a multi-choice question the shares sum past 1 — that is
 * correct and is what "62% of riders use Google Maps" means.
 */
export function choiceTally(responses: readonly SurveyAnswers[], questionId: string): Tally[] {
  const counts = new Map<string, number>()
  let answered = 0

  for (const r of responses) {
    const picked = r.multi[questionId] ?? (r.single[questionId] ? [r.single[questionId]] : [])
    if (picked.length) answered += 1
    for (const opt of picked) counts.set(opt, (counts.get(opt) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([option, n]) => ({ option, n, share: answered === 0 ? 0 : n / answered }))
    .sort((a, z) => z.n - a.n || a.option.localeCompare(z.option))
}

/** Non-empty open answers for one question, for the admin page to read through. */
export function openAnswers(responses: readonly SurveyAnswers[], questionId: string): string[] {
  return responses.map((r) => r.open[questionId] ?? '').filter((s) => s.trim().length > 0)
}

/** The headline the summary page opens with. */
export function summaryLine(responses: readonly SurveyAnswers[]): string {
  const n = responses.length
  if (n === 0) return 'No responses yet.'
  const complete = responses.filter((r) => r.top.length === TOP_PICKS).length
  return `${n} ${n === 1 ? 'response' : 'responses'}, ${complete} with a full top ${TOP_PICKS}`
}

export { bundleLabel }
