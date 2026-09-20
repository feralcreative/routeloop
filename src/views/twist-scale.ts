// The twistiness scale as markup: `rank` road-curve marks lit out of
// TWIST_MAX, drawn by `.twist-scale` in style/_chrome.scss. Ziad's call,
// 2026-09-20, over the five words alone — see TWIST_BANDS in src/maps/twist.ts
// for why marks rather than grades or a percentage.
//
// The word is the accessible name ("Twisty, 4 of 5") and, with whatever number
// the caller adds, the hover — so a screen reader and a pointer both get what
// the marks say. `title` defaults to the bare word.
//
// BYTE-IDENTICAL TO twistScale() IN public/js/twist.js. The viewer's legend and
// the builder's totals line build the same markup client-side, and
// test/twist-client.test.ts holds the two strings together.
import { TWIST_MAX } from '../maps/twist'
import { esc } from './esc'

export function twistScale(rank: number, label: string, title: string = label): string {
  let marks = ''
  for (let i = 0; i < TWIST_MAX; i++) marks += `<i class="twist-mark${i < rank ? ' is-on' : ''}"></i>`
  return `<span class="twist-scale" role="img" aria-label="${esc(`${label}, ${rank} of ${TWIST_MAX}`)}" title="${esc(title)}">${marks}</span>`
}
