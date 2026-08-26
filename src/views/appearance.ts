// Which palette a rider sees, on two independent axes.
//
// A DISPLAY LAYER ONLY, exactly like src/views/date-format.ts, whose shape this
// follows. Nothing here touches storage or any rendered value: the two stored
// strings become two attributes on <html>, and style/_theme.scss does the rest.
//
// TWO AXES, NOT SIX NAMES, and that is the decision worth stating. **Theme** is
// about which signals a rider can distinguish — default, high contrast,
// colorblind. **Scheme** is about ambient light — system, light, dark. They are
// genuinely unrelated questions, and collapsing them into one list of six would
// ask a rider to hunt for "colorblind dark" in a flat menu.
//
// It also makes `system` expressible, which a single list cannot do: "follow the
// OS" is a statement about the scheme axis alone. **There is no OS signal for
// colorblindness**, so there is no equivalent member on the theme axis and its
// absence is not an oversight.
//
// WHY `system` HAS NO ATTRIBUTE. The server cannot know a reader's OS setting —
// no request header carries it — so `system` is rendered as the ABSENCE of
// data-scheme, and a `prefers-color-scheme` media query fills it in. That is why
// schemeAttr() returns null for it rather than the string 'system'. Stamping
// `data-scheme="system"` would match no rule and silently pin every such rider
// to light.

export const THEMES = ['default', 'contrast', 'colorblind'] as const
export type Theme = (typeof THEMES)[number]
export const DEFAULT_THEME: Theme = 'default'

export const SCHEMES = ['system', 'light', 'dark'] as const
export type Scheme = (typeof SCHEMES)[number]
export const DEFAULT_SCHEME: Scheme = 'system'

/**
 * Coerces anything to a supported value.
 *
 * Same contract as toDateFormat: a rider who has never opened their preferences
 * has no `user_profiles` row at all, so this is handed `undefined` as often as it
 * is handed a value, and the answer has to be the column's own default rather
 * than a third state every caller would have to think about.
 */
export const toTheme = (v: unknown): Theme => (THEMES.includes(v as Theme) ? (v as Theme) : DEFAULT_THEME)
export const toScheme = (v: unknown): Scheme => (SCHEMES.includes(v as Scheme) ? (v as Scheme) : DEFAULT_SCHEME)

/**
 * What to stamp on <html>, or null to stamp nothing.
 *
 * The default theme returns null for a different reason than `system` does: its
 * palette is the bare `:root` block, so an attribute would be redundant rather
 * than wrong. Both keep the markup honest — an attribute is present only when it
 * is doing something.
 */
export const themeAttr = (t: Theme): string | null => (t === 'default' ? null : t)
export const schemeAttr = (s: Scheme): string | null => (s === 'system' ? null : s)

/** The preferences page's radio sets. */
export const THEME_CHOICES: { id: Theme; label: string; hint: string }[] = [
  { id: 'default', label: 'Road sign', hint: 'The green, red, and amber of US highway signs.' },
  {
    id: 'contrast',
    label: 'High contrast',
    hint: 'Every color pushed further from the text on it, for glare and for tired eyes.',
  },
  {
    id: 'colorblind',
    label: 'Colorblind',
    hint: 'Separates the red/green and the two ambers, which look alike to many riders.',
  },
]

export const SCHEME_CHOICES: { id: Scheme; label: string; hint: string }[] = [
  { id: 'system', label: 'Match my device', hint: 'Follows whatever your phone or computer is set to.' },
  { id: 'light', label: 'Light', hint: 'Always light, even at night.' },
  { id: 'dark', label: 'Dark', hint: 'Always dark, even in daylight.' },
]
