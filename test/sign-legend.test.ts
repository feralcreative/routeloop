// A SIGN'S LEGEND MUST NOT FOLLOW THE PAGE.
//
// **THE BUG THIS EXISTS FOR, AND IT HAD SHIPPED ON EVERY PAGE.** `--white` is
// the PAGE SURFACE token, not the color white — under a dark scheme it is the
// page's own near-black, which is exactly what makes cards work. A guide sign's
// legend is the opposite: a yield sign takes black ink at night too. `.btn`
// painted `color: $white` on the green `$interstate` field, so every button in
// the app rendered a near-black legend on green under the dark scheme, at
// **2.67:1** — below the 4.5:1 the palette audit holds everything else to.
//
// **`test/palette-contrast.test.ts` COULD NOT HAVE CAUGHT IT**, and the split is
// the point: that file audits the PALETTE and correctly asserts that
// `$interstate` carries `$ink-light` at 4.5:1 in all six. It was right. The
// mistake was in the STYLESHEET, which paired that field with a different token
// — a CSS authoring error, invisible to a test that only reads colors.
//
// So this reads the compiled CSS and looks for the pairing itself. Compiled
// rather than read off `public/style/main.min.css`, for the reason
// helpers/palettes.ts records: that file is a gitignored build artifact and CI
// does not build SCSS.
//
// **SCOPED TO THE FIELDS THAT CARRY A LEGEND**, which is the same list
// palette-contrast.test.ts calls WHITE_LEGEND. A `--white` background is every
// card in the app and is correct everywhere; it is only a defect as the INK on
// one of these.
import { describe, expect, it } from 'vitest'
import { compileString } from 'sass'

// The fields a white legend is set on. Kept in step with WHITE_LEGEND in
// test/palette-contrast.test.ts by hand — two lists, because that one is about
// whether the COLORS pair and this one is about whether the CSS says so.
const SIGN_FIELDS = ['interstate', 'stop', 'disabled', 'tarmac', 'recreation']

const css = (() => {
  const out = compileString('@use "style/main.scss";', { loadPaths: ['.'], style: 'expanded' })
  return out.css
})()

/** Every `{ ... }` declaration block in the sheet, selector discarded. */
function blocks(source: string): string[] {
  return [...source.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1])
}

// The fields that take a BLACK legend, from the same source as SIGN_FIELDS
// above and for the same reason: this list is about whether the CSS says so.
const BLACK_FIELDS = ['warning', 'yield', 'detour', 'speed']

// THE NOTIFICATION MARKS ARE DISCS WITH THE GLYPH KNOCKED OUT IN WHITE, and the
// knockout is a presentation attribute inside the SVG file rather than anything
// the stylesheet sets. So a mark painted in a black-legend field is #282 in a
// form test/palette-contrast.test.ts cannot see — the palette is correct, and
// the STYLESHEET has paired that field with white ink.
//
// **THE FLIP IS `--icon-ink` AND THIS GUARD USED TO LOOK FOR AN ATTRIBUTE
// SELECTOR.** It asserted `[fill="white"]`, which was the real rule until
// 2026-09-09 and reached exactly one of the five spellings the folder uses —
// so it passed while `bug`, `help`, `info` and the four `record-*` marks kept a
// white glyph on every black-legend field. The guard was as narrow as the bug.
// views/icon.ts normalizes every spelling to the property now, and
// test/icon-ink.test.ts is what holds that end; this end only has to see that a
// black-legend tone names the ink.
//
// The amber quota mark is the one that needs it today. This is what stops the
// next tone from being added without it.
describe('a notification mark never leaves a white glyph on a black-legend field', () => {
  it('flips the knockout wherever the disc takes one', () => {
    const tones = [...css.matchAll(/\.notif-mark\[data-tone=["']?([a-z]+)["']?\]\s*\{([^{}]*)\}/g)]
    // If this is empty the selector was renamed and the guard silently stopped
    // guarding, which is the failure the whole file exists to prevent.
    expect(tones.length).toBeGreaterThan(0)
    const unflipped: string[] = []
    for (const [, tone, body] of tones) {
      const field = BLACK_FIELDS.find((f) => new RegExp(`color:\\s*var\\(--${f}\\)`).test(body))
      if (!field) continue
      if (!/--icon-ink:/.test(body)) unflipped.push(`${tone} paints --${field} and leaves the glyph white`)
    }
    expect(unflipped).toEqual([])
  })
})

describe('a sign legend is scheme-invariant', () => {
  it('never paints var(--white) on a sign field', () => {
    const bad: string[] = []
    for (const body of blocks(css)) {
      const field = SIGN_FIELDS.find((f) => new RegExp(`background(-color)?:\\s*var\\(--${f}\\)`).test(body))
      if (!field) continue
      // `color:` and the keyline, which is drawn as an inset box-shadow.
      if (/(^|[;\s])color:\s*var\(--white\)/.test(body)) bad.push(`color on --${field}`)
      if (/box-shadow:[^;]*var\(--white\)/.test(body)) bad.push(`keyline on --${field}`)
    }
    expect([...new Set(bad)]).toEqual([])
  })

  // The other half, and the reason the first is not enough on its own: the
  // `.btn` base bakes its keyline in without naming a background, so a block
  // setting `--white` in an inset shadow beside `--ink-light` is a sign whose
  // ring half-follows the page. Narrow on purpose — an inset shadow in `--white`
  // on its own is an ordinary inner highlight and not a keyline.
  it('never mixes page-white and legend-white in one keyline', () => {
    const bad = blocks(css).filter((b) =>
      /box-shadow:[^;]*var\(--white\)[^;]*var\(--ink-light\)|box-shadow:[^;]*var\(--ink-light\)[^;]*var\(--white\)/.test(
        b,
      ),
    )
    expect(bad).toEqual([])
  })
})
