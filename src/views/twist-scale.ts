// The twistiness rating as markup: the band's line — flat for Straight, a
// tight sine for Very twisty, drawn by `.twist-scale[data-rank]` in
// style/_chrome.scss — with the band's word beside it. Ziad's call,
// 2026-09-20, after seeing all five lines on one page: together they read,
// but one line alone told a rider nothing, and of the three ways to say "X of
// 5" (a progressive line lit to the rank, the line plus "4/5", the line plus
// the word) he chose the word. See TWIST_BANDS in src/maps/twist.ts.
//
// The word is the visible name, so the line is `aria-hidden` decoration and
// there is no `role="img"` to describe; `title` carries whatever number the
// caller adds and defaults to the word. The drawing lives in the stylesheet,
// keyed on `data-rank`, so the five paths exist in one place.
//
// BYTE-IDENTICAL TO twistScale() IN public/js/twist.js. The viewer's legend and
// the builder's totals line build the same markup client-side, and
// test/twist-client.test.ts holds the two strings together.
import { TWIST_BANDS } from '../maps/twist'
import { esc } from './esc'

export function twistScale(rank: number, label: string, title: string = label): string {
  return `<span class="twist-rating" title="${esc(title)}"><i class="twist-scale" data-rank="${rank}" aria-hidden="true"></i>${esc(label)}</span>`
}

/** The key: every band's line with its word, twistiest first — what the
 *  dashboard's `?` bubble shows, so one rating can be read against the rest.
 *  Ziad's call, 2026-09-20, after the static page that showed all five. */
export function twistKey(): string {
  const rows = TWIST_BANDS.map((b) => `<span class="twist-key-row">${twistScale(b.rank, b.label)}</span>`).join('')
  return `<span class="twist-key">${rows}</span>`
}
