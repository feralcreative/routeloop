// Whether this app animates, as a rider's own choice.
//
// A DISPLAY LAYER ONLY, the same shape as ./appearance.ts and ./date-format.ts:
// the stored string becomes one attribute on <html> and the SCSS does the rest.
//
// **THIS IS NOT `prefers-reduced-motion`, WHICH IS ALREADY HONORED THOROUGHLY.**
// Six SCSS blocks respect it and four client files bail on it in JS, so a rider
// with the OS toggle on already gets a still page. What was missing is the rider
// who wants motion off HERE without changing their whole machine — or who does
// not know the OS setting exists. This adds a control, not a capability.
//
// THREE STATES, NOT A CHECKBOX, and `scheme` is the precedent for exactly why.
// A two-state toggle defaulting to "animations on" would silently OVERRIDE the
// OS preference of every rider who already has reduced motion set: the
// accessibility setting would be made worse by the accessibility feature. So
// `system` is the default and it means "whatever the machine says", the same way
// `scheme: system` delegates light-or-dark to the browser.
//
// WHY `system` STAMPS NO ATTRIBUTE, and it is the same reason schemeAttr()
// returns null: no request header carries the OS motion preference, so the
// server cannot know it. `system` is rendered as the ABSENCE of data-motion and
// the media query fills it in. Stamping `data-motion="system"` would match no
// rule and silently pin every such rider to animated.
//
// `always` is not redundant with the absence of a preference. It means "animate
// even though my machine says reduce", which is a real answer a rider can want
// on a machine whose setting they inherited from somebody else.

export const MOTIONS = ['system', 'always', 'never'] as const
export type Motion = (typeof MOTIONS)[number]
export const DEFAULT_MOTION: Motion = 'system'

/**
 * Coerces anything to a supported value.
 *
 * Same contract as toScheme and toDateFormat: a rider with no `user_profiles`
 * row hands this `undefined` as often as a value, and the answer is the column's
 * own default rather than a third state every caller would have to interpret.
 */
export const toMotion = (v: unknown): Motion => (MOTIONS.includes(v as Motion) ? (v as Motion) : DEFAULT_MOTION)

/**
 * What to stamp on <html>, or null to stamp nothing.
 *
 * Only `system` returns null, and unlike themeAttr's null it is not because the
 * value is the default — it is because the answer lives in the browser. Both
 * `always` and `never` are stamped, because both are the rider overriding what
 * the machine said and the CSS has to be able to tell them apart.
 */
export const motionAttr = (m: Motion): string | null => (m === 'system' ? null : m)

/** The settings page's radio set. */
export const MOTION_CHOICES: { id: Motion; label: string; hint: string }[] = [
  {
    id: 'system',
    label: 'Follow my device',
    // Named for what the rider does rather than for the media query, because a
    // rider who has never heard of `prefers-reduced-motion` is exactly who this
    // option is the safe default for.
    hint: 'Animate unless your phone or computer is set to reduce motion.',
  },
  { id: 'always', label: 'Always animate', hint: 'Animate here even if your device asks for less motion.' },
  { id: 'never', label: 'Never animate', hint: 'No animation on this site, whatever your device says.' },
]
