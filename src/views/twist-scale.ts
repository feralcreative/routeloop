// The twistiness scale as markup: one line that gets wavier with the band,
// drawn by `.twist-scale[data-rank]` in style/_chrome.scss — flat for
// Straight, a tight sine for Very twisty. Ziad's call, 2026-09-20, over the
// five words and then over five repeated curve marks, which he hated: a
// sparkline says "how twisty" in one glance and does not read as a rating.
// See TWIST_BANDS in src/maps/twist.ts.
//
// The word is the accessible name ("Twisty, 4 of 5") and, with whatever number
// the caller adds, the hover — so a screen reader and a pointer both get what
// the line says. `title` defaults to the bare word. The drawing itself lives in
// the stylesheet, keyed on `data-rank`, so the markup is one empty span and
// the five paths exist in one place.
//
// BYTE-IDENTICAL TO twistScale() IN public/js/twist.js. The viewer's legend and
// the builder's totals line build the same markup client-side, and
// test/twist-client.test.ts holds the two strings together.
import { TWIST_MAX } from '../maps/twist'
import { esc } from './esc'

export function twistScale(rank: number, label: string, title: string = label): string {
  return `<span class="twist-scale" role="img" data-rank="${rank}" aria-label="${esc(`${label}, ${rank} of ${TWIST_MAX}`)}" title="${esc(title)}"></span>`
}
