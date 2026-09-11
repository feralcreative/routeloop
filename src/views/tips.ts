// Whether a control explains itself. #133, "Show me around".
//
// **THE MODE IS A PREFERENCE; THE WORDS ARE NOT IN THIS FILE.** What a given
// control means lives in `public/js/tips.js`, because the builder renders every
// one of its rows as a string in the browser and there is no server pass to
// hang the copy off. This module owns the same three things every other
// preference module here owns — the members, the default, and the coercer — and
// nothing else, which is the `./volume.ts` and `./units.ts` arrangement exactly.
//
// **ON IS THE DEFAULT AND THAT IS THE WHOLE POINT OF THE FEATURE.** Every other
// preference in `user_profiles` defaults to what a rider who said nothing would
// most likely have wanted. This one defaults to what somebody who has never
// been here needs, which is a different question with a different answer: #133
// exists for the least technical end of the cohort, and first contact is when
// it pays off. Shipping it off-by-default means the riders it was built for
// form their impression without it and then never find the switch.
//
// **THE ABSENCE OF A STAMP MEANS `on`, WHICH INVERTS THE `data-motion` RULE AND
// SAYS SO.** `motion` and `scheme` omit `system` so the BROWSER can answer
// instead; there is no second answerer here, so absence simply means the
// default — and the default being `on` is what makes a signed-out visitor and a
// rider with no `user_profiles` row land in the same place as everybody else.
// See the stamp in src/views/layout.tsx.

export const TIPS = ['on', 'off'] as const
export type Tips = (typeof TIPS)[number]
export const DEFAULT_TIPS: Tips = 'on'

/**
 * Coerces anything to a supported value.
 *
 * Same contract as toUnits and toVolumeUnits: `undefined` is as common as a
 * value, because a rider with no `user_profiles` row has no answer stored.
 */
export const toTips = (v: unknown): Tips => (TIPS.includes(v as Tips) ? (v as Tips) : DEFAULT_TIPS)

/**
 * What the settings page offers, in the order it offers it.
 *
 * `on` is first because it is the default and a rider reading down the pair
 * should meet the state they are already in. The second line of each is what
 * the choice actually changes rather than a restatement of the label — the
 * `UNITS_CHOICES` shape, for the same reason: two radios reading "Yes" and "No"
 * make a rider guess what they are answering.
 */
export const TIPS_CHOICES: { id: Tips; label: string; example: string }[] = [
  { id: 'on', label: 'Yes, explain things', example: 'Point at a control and get a sentence on what it is for.' },
  { id: 'off', label: 'No, just the labels', example: 'Short labels only, the way your browser shows them.' },
]
