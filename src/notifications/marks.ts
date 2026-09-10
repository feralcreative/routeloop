// WHAT COLOR EACH NOTIFICATION MARK IS, AND IT IS KEYED ON THE MARK.
//
// **THIS REVERSES THE 2026-09-07 CALL AND THE OLD REASONING IS STRUCK RATHER
// THAN LEFT TO BE REDISCOVERED.** Ziad's call, 2026-09-09, naming all ten
// fields himself. Color was keyed on `tone` — advice amber, a verdict red,
// everything else the blue sign field — on the argument that "colouring by mark
// was the first shape and it cannot express this: the storage disc is shared by
// a quota warning and two destructions". That argument was about ONE mark, and
// it is answered by letting that one mark's events override rather than by
// keying all thirteen events off three tones. What the tone arrangement could
// not express is the thing a rider actually reads: eleven of the thirteen
// events came out the SAME blue, so the mark carried every bit of the meaning
// and the color carried none of it.
//
// **STORAGE IS STILL TWO COLORS, WHICH IS THE OLD RULE KEPT.** `$yield` for the
// quota warning, `$stop` for the two destructions, via `field` on those events.
// The distinction was correct; where it lived was not.
//
// **THE FIELD LIVES HERE AND NOT IN `_account.scss`.** Ziad's call, 2026-09-09.
// `routes/icons.tsx` needs the same mapping to draw its "as assigned" swatches,
// and its own comment already flagged the SCSS table as "two copies... they have
// to agree, or the swatch beside a name recommends a colour the centre does not
// use". One source in TypeScript, emitted as an inline `style` exactly as the
// workbench does, retires that copy instead of adding a third.
//
// **THE INK IS DECLARED, NOT MEASURED AT RUNTIME.** Working it out per render
// means parsing the built stylesheet in the request path, and the value cannot
// change without a deploy. `BLACK_GLYPH_FIELDS` is the measured answer written
// down, and `test/notification-marks.test.ts` compiles the palette and fails if
// a hue moves under it — the arrangement `src/maps/role-colors.ts` already uses.
import { FORCE_WHITE } from '../views/legend'

/** The token a mark's disc is painted in, without the leading `--`. */
export const MARK_FIELD: Readonly<Record<string, string>> = {
  // A remark on a ride. The most frequent and least urgent thing here, so it
  // takes the palette's grey rather than a sign field.
  //
  // **$concrete AND NOT $ink-light**, which is what Ziad named first and then
  // changed on being shown the number: `$ink-light` is #ffffff in all six
  // palettes and the row ground is #ffffff in the three light ones, so the disc
  // measured 1.00:1 against it — legible, because that field takes a BLACK
  // glyph, but rendering as a bare glyph with no disc in light and a bright
  // white disc in dark. Two designs for one mark. `$concrete` is present in
  // both at 3.54:1.
  comment: 'concrete',
  // A suggestion to go a different way. $yield is the sign-head yellow.
  proposal: 'yield',
  // A vote that resolved: the group decided, so the road is open. White glyph by
  // override rather than by measurement — see FORCE_WHITE.
  vote: 'go',
  // Who is coming. The blue sign field, which is also the fallback below.
  roster: 'disabled',
  friendship: 'recreation',
  // A report you filed moved. Red because it is about something broken.
  bug: 'stop',
  // ADVICE by default — you are nearly out of room and it is yours to act on.
  // The two DESTRUCTIONS override this to `stop` on the event, which is the one
  // place a mark wears two colors.
  storage: 'yield',
  // A release. $interstate is the guide-sign green: this is the app itself.
  product: 'interstate',
  // Reserved, for #48/#53 and #24 — named now because Ziad named all ten, so a
  // field waiting for its event is a decision made early rather than a gap.
  road: 'detour',
  weather: 'signal',
  // THE UNKNOWN EVENT, and it has to be here rather than defaulted at the call
  // site. `notifications.tsx` draws the `info` mark for a stored row whose key
  // is no longer in the catalog — which `isEvent()` makes an ordinary state
  // rather than an error, because removing an event is meant to need no
  // migration.
  info: 'disabled',
}

/** The disc a mark falls back to when nothing names it. */
export const DEFAULT_FIELD = 'disabled'

/**
 * Fields whose knockout is BLACK, measured across all six palettes and pinned
 * by test/notification-marks.test.ts.
 *
 * **ONE ENTRY, AND IT IS THE ONLY FIELD LEFT THAT EARNS IT.** White on `$yield`
 * measures 1.23:1 — tone-on-tone, and the single most illegible pairing the
 * palette can produce. Everything else here either clears the 3:1 graphical bar
 * for white or is named in FORCE_WHITE, which is why `detour` (1.98) and `go`
 * (2.30) are deliberately absent despite measuring worse than several fields
 * that pass.
 *
 * `go` was in this set for about an hour on 2026-09-09 and Ziad moved it; the
 * `vote` mark is a white glyph on green now.
 */
export const BLACK_GLYPH_FIELDS: ReadonlySet<string> = new Set(['yield'])

/** Just enough of an event to color its mark. Avoids importing the catalog. */
export type Marked = { readonly icon: string; readonly field?: string }

/** The field for one event: its own override, else its mark's, else the blue. */
export function fieldFor(def: Marked | null): string {
  if (!def) return MARK_FIELD.info ?? DEFAULT_FIELD
  return def.field ?? MARK_FIELD[def.icon] ?? DEFAULT_FIELD
}

/**
 * The inline style for a mark: the disc in `color`, the knockout in
 * `--icon-ink`.
 *
 * **THE INK IS ALWAYS WRITTEN, NEVER LEFT TO DEFAULT.** `views/icon.ts` defaults
 * `--icon-ink` to `#fff`, so omitting it for a white legend would work — and
 * would inherit a BLACK ink from any ancestor that had set one, silently. Both
 * halves stated is one fewer thing to reason about.
 *
 * Sign white and sign black, never `--white`/`--black`: a legend does not follow
 * the page, which is #282 and the reason test/sign-legend.test.ts exists.
 */
export function markStyle(def: Marked | null): string {
  const field = fieldFor(def)
  const ink = BLACK_GLYPH_FIELDS.has(field) && !FORCE_WHITE.has(field) ? 'ink-dark' : 'ink-light'
  return `color:var(--${field});--icon-ink:var(--${ink})`
}
