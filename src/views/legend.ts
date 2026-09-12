// WHICH INK A SIGN FIELD CARRIES, AS ONE RULE THREE PLACES READ.
//
// Pulled out of `routes/icons.tsx` on 2026-09-09, when the notification center
// became a second consumer: the workbench recommends a pairing, the center
// paints one, and a test pins them together. Three copies of a threshold is how
// the workbench ends up recommending something the center does not do.
//
// **TWO THRESHOLDS, BECAUSE ADMISSION AND INK ARE TWO QUESTIONS.** Ziad's call,
// 2026-09-09. Whether a token is a field the app paints a sign on is text
// contrast, 4.5:1 on one ink or the other — the bar the palette audit already
// holds those to, and what keeps the derived ramp steps out of the table.
// Whether the glyph can be read on it is NON-TEXT graphical contrast, 3:1,
// because a knockout glyph is a graphical object rather than type.
//
// **WHITE IS PREFERRED RATHER THAN THE HIGHER RATIO**, which is the part that is
// a decision rather than arithmetic: `$concrete`, `$neutral-50`, `$google-blue`
// and `$signal` all clear BLACK by more than they clear white, so a best-ratio
// rule keeps them black. These marks are white-knockout artwork, the app paints
// the white one everywhere it can, and a black glyph is the exception a field
// has to earn.
//
// Pure on purpose — it takes two measured ratios and a name, reads no file and
// imports nothing, so `test/notification-marks.test.ts` can hold the center's
// declared inks against the compiled palette with no database and no build.

/** Text contrast. Decides whether a token is a field a sign is painted on. */
export const AA = 4.5

/** Non-text graphical contrast. Decides which ink the knockout takes. */
export const AA_GRAPHIC = 3

/**
 * Fields given a white legend AGAINST the measurement, by name.
 *
 * Ziad's call per entry, never a widened threshold: dropping `AA_GRAPHIC` far
 * enough to admit these would take nine other fields with it silently, which is
 * the failure the workbench exists to surface. A SET of named exceptions makes
 * each one a line somebody wrote beside a measured ratio.
 *
 * - `detour` — white measures 2.46, 1.98 and 2.60 across the three sign
 *   palettes. The worst pairing the app ships, and worse than the 2.25 it read
 *   before the token took `$fuel-low`'s value on 2026-09-09.
 * - `go` — white measures 2.80, 2.30 and 3.80. It clears the graphical bar in
 *   the colorblind palette, where the token is a BLUE (#0089d6), and misses it
 *   in the two where it is green.
 *
 * **NOTE THE TENSION WITH `test/palette-contrast.test.ts`, AND DO NOT "FIX" IT.**
 * That file lists `go` under `BLACK_LEGEND_BY_LUMINANCE` and asserts it carries
 * BLACK at 4.5:1, which is true and is about TYPE set on the field. This is
 * about a knockout glyph, which is a different object with a different bar and,
 * here, a deliberate override on top of it. Both claims stand; neither is
 * evidence against the other. `concrete` is the same shape already.
 *
 * Every surface reporting a ratio reports the REAL one rather than a passing
 * one, so a forced field reads as the exception it is.
 */
export const FORCE_WHITE: ReadonlySet<string> = new Set(['detour', 'go'])

export type Legend = 'white' | 'black'

/**
 * The ink for a field, given its WORST white and black ratios across every
 * palette, or null when the token is not a sign field at all.
 *
 * Worst-of-all-palettes rather than per palette, because one SVG is served to
 * every theme: an ink chosen per palette would need six copies of every mark.
 */
export function legendFor(name: string, white: number, black: number): Legend | null {
  if (white < AA && black < AA) return null
  if (white >= AA_GRAPHIC || FORCE_WHITE.has(name)) return 'white'
  return 'black'
}
