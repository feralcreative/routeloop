// The Rider Survey, as data.
//
// The question set lives here rather than in the database on purpose. Migrations
// in this repo are push-only and genuinely dangerous — see the warnings on
// users.status in db/schema.ts — so a survey whose shape is a code change and
// never a DDL change is worth the constraint it puts on everything else. That is
// also why survey_responses stores one jsonb blob per rider instead of a row per
// answer.
//
// The consequence, and it is the important one: Postgres validates NOTHING about
// what is in that column. `.$type<SurveyAnswers>()` is a claim the compiler
// makes and the database has never checked. A draft written under version 1 and
// read by version 2 code has missing keys, and a cast would assert they are
// there. So there are two parsers, not one:
//
//   parseAnswers()       lenient. Every READ. Fills gaps, drops what it does not
//                        recognise, never throws. A rider must never lose a
//                        half-finished form because a question was renamed.
//   validateSubmission() strict. The submit button only. Returns field-keyed
//                        errors the form re-renders against.
//
// The bundles are DELIBERATELY NOT LABELLED as built or planned. The whole point
// is to learn what riders want, and telling them what already exists gets
// politeness about finished work instead of an answer.
import { z } from 'zod'

/** Bump when the shape of an answer changes, not when wording changes. Stored on
 *  every response so an old row stays interpretable. */
export const SURVEY_VERSION = 1

/** How many bundles a rider must pick as their must-haves. */
export const TOP_PICKS = 5

/** Free-text cap. Long enough for a real story, short enough not to be a payload. */
export const OPEN_MAX = 2000

// --- The rating scale --------------------------------------------------------

// Three points, and the missing fourth is the point.
//
// This was four — don’t care, nice to have, would use, must have — and "would
// use" was doing no work. It is what a polite person picks when they do not
// want to say no to a friend, so it collected the answers that mattered most
// and reported them as mild enthusiasm. Dropping it forces the question the
// survey is actually asking: would you miss this, or not.
//
// Still no neutral. A midpoint collects "I have not thought about it" and
// reports it as a considered opinion.
//
// `tone` is carried here rather than derived in CSS because the colour IS the
// meaning — red, yellow, green — and a stylesheet reaching for :nth-child would
// silently repaint the scale the moment a row is reordered.
export const RATINGS = [
  { value: 0, label: 'Don’t care', tone: 'no' },
  { value: 1, label: 'Nice to have', tone: 'maybe' },
  { value: 2, label: 'Must have', tone: 'yes' },
] as const

export const MIN_RATING = 0
export const MAX_RATING = RATINGS.length - 1

// --- The bundles -------------------------------------------------------------

export type Bundle = {
  /** Stable. Stored in every response, so renaming one orphans data. */
  id: string
  /** Written for a rider, not for the repo. No feature names, no internal words. */
  label: string
  section: string
}

export type Section = { id: string; title: string; blurb: string }

export const SECTIONS: readonly Section[] = [
  { id: 'planning', title: 'Planning the trip', blurb: 'Getting the whole thing laid out before you go.' },
  { id: 'roads', title: 'The roads themselves', blurb: 'Which way the route actually goes.' },
  { id: 'conditions', title: 'Conditions', blurb: 'What the road will be like when you get there.' },
  { id: 'range', title: 'Fuel and range', blurb: 'Not running out, a long way from anywhere.' },
  { id: 'group', title: 'Riding with other people', blurb: 'Everything that stops being simple past one bike.' },
  { id: 'onbike', title: 'On the bike', blurb: 'Out of the driveway and using it with gloves on.' },
]

// WHAT IS NOT HERE IS AS DELIBERATE AS WHAT IS.
//
// Nothing on this list is table stakes. The whole ride on one map, routing
// between stops, dragging the line onto the road you meant, import and export,
// a share link that needs no account — every one of those is either the premise
// of the app or a line in its own tagline, and none of them is going away
// whatever a survey says. Asking about them is not a question, it is a
// formality, and it costs a rider ten rows of attention that the real questions
// need. A survey that runs long gets abandoned in the middle, and the middle is
// where the answers that would change a sprint are sitting.
//
// So this list is only the undecided: things not built, things half-decided, and
// things where the shape is still an argument. That is what a ranking can
// actually move.
//
// The blindness rule still holds — no label says which side of the line it is on
// — but note that the omissions are their own signal to anyone already using the
// app. Most respondents are not, so it costs little; it is a real trade rather
// than a free one.
export const BUNDLES: readonly Bundle[] = [
  // Planning
  {
    id: 'saved-places',
    section: 'planning',
    label: 'Saved places you reuse across trips instead of searching for them every time',
  },
  {
    id: 'lodging-anchors',
    section: 'planning',
    label: 'Where you sleep sets where the day ends, and the next morning starts there',
  },
  {
    id: 'day-budget',
    section: 'planning',
    label: 'A per-day time budget, so you find out Tuesday is over-packed before you leave',
  },
  { id: 'elevation', section: 'planning', label: 'Elevation and grade, before you commit to a pass' },

  // Roads
  { id: 'prefer-curves', section: 'roads', label: 'Routing that prefers the fun road over the fast one' },
  { id: 'avoid-highways', section: 'roads', label: 'Switches to stay off the interstate or push onto back roads' },
  {
    id: 'per-leg-routing',
    section: 'roads',
    label: 'Different routing per leg—slab out of town, twisty once you are in the hills',
  },
  { id: 'unpaved', section: 'roads', label: 'Say whether you will take dirt, per leg, and have the route respect it' },
  { id: 'road-flags', section: 'roads', label: 'Riders flag rough or gravelly roads, and everyone routes around them' },

  // Conditions
  {
    id: 'weather-timeline',
    section: 'conditions',
    label: 'Weather along the route, for the day and hour you would actually be there',
  },
  { id: 'closures', section: 'conditions', label: 'Seasonal closures—a warning that the pass is shut in April' },
  { id: 'map-layers', section: 'conditions', label: 'Map layers you can stack and fade—terrain, satellite' },

  // Range
  { id: 'bike-profile', section: 'range', label: 'Your bike’s tank and mpg, so it knows your range' },
  { id: 'range-warnings', section: 'range', label: 'A warning when two stops are further apart than one tank' },
  { id: 'group-range', section: 'range', label: 'Planning around the shortest fuel range in the group' },

  // Group
  { id: 'roster', section: 'group', label: 'Invite riders to a ride and see who is actually coming' },
  { id: 'friends', section: 'group', label: 'Friends you ride with regularly, and sharing with just them' },
  {
    id: 'subgroups',
    section: 'group',
    label: 'Groups that leave from different cities, meet up, ride as one, then split for home',
  },
  { id: 'vote', section: 'group', label: 'Two ways to go on the map, and the group votes' },
  { id: 'money', section: 'group', label: 'Splitting gas, motels and meals with the people on the ride' },

  // On the bike. device-gpx sits here rather than in a hand-off section of its
  // own: import and export are table stakes and gone, which left that section
  // holding one row, and a heading for one question is a heading that reads as
  // an oversight.
  {
    id: 'device-gpx',
    section: 'onbike',
    label: 'A GPX written for your exact device, so it does not quietly rebuild your route',
  },
  { id: 'one-bar', section: 'onbike', label: 'Works with one bar of signal' },
  { id: 'leg-progress', section: 'onbike', label: 'Mark a leg done, and pick up where you left off' },
  { id: 'offline', section: 'onbike', label: 'Open a saved ride with no connection at all' },
]

export const BUNDLE_IDS: readonly string[] = BUNDLES.map((b) => b.id)
const BUNDLE_ID_SET = new Set(BUNDLE_IDS)

export const bundlesIn = (sectionId: string): Bundle[] => BUNDLES.filter((b) => b.section === sectionId)
export const bundleLabel = (id: string): string => BUNDLES.find((b) => b.id === id)?.label ?? id

// --- The other questions -----------------------------------------------------

export type ChoiceQuestion = {
  id: string
  label: string
  hint?: string
  multi: boolean
  required: boolean
  options: readonly string[]
}

export type OpenQuestion = { id: string; label: string; hint?: string; required: boolean }

/**
 * How they ride, which is what makes the ranking readable.
 *
 * Without these the result is one averaged rider who does not exist. With them,
 * "the people who ride multi-day in groups want X" is a sentence you can act on.
 */
export const CHOICE_QUESTIONS: readonly ChoiceQuestion[] = [
  {
    id: 'riding-kind',
    label: 'What kind of riding do you actually do?',
    hint: 'Pick everything that applies.',
    multi: true,
    required: true,
    options: [
      'Day rides',
      'Weekend trips',
      'Multi-day tours',
      'Rallies and organized events',
      'Adventure or dual-sport',
      'Track or canyon days',
      'Commuting',
    ],
  },
  {
    id: 'longest-trip',
    label: 'Longest trip you have planned in the last couple of years?',
    multi: false,
    required: true,
    options: ['Under 300 miles', '300 to 800 miles', '800 to 2,000 miles', '2,000 to 5,000 miles', 'Over 5,000 miles'],
  },
  {
    id: 'group-size',
    label: 'How many bikes, usually?',
    multi: false,
    required: true,
    options: ['Just me', '2 or 3', '4 to 8', '9 or more', 'It varies a lot'],
  },
  {
    id: 'who-plans',
    label: 'Who does the planning?',
    multi: false,
    required: true,
    options: ['Me, usually', 'Someone else', 'Split between a few of us', 'Nobody, we work it out as we go'],
  },
  {
    id: 'plan-with',
    label: 'What do you plan with today?',
    hint: 'Pick everything you have actually used.',
    multi: true,
    required: true,
    options: [
      'Google Maps or My Maps',
      'REVER',
      'Calimoto',
      'Scenic',
      'Kurviger',
      'Garmin BaseCamp or Garmin Explore',
      'Ride with GPS',
      'Furkot',
      'MyRoute-app',
      'Paper, notes or a spreadsheet',
      'Nothing, I just go',
    ],
  },
  {
    id: 'navigate-with',
    label: 'What is actually on the bike when you ride?',
    hint: 'Pick everything that applies.',
    multi: true,
    required: true,
    options: [
      'Google Maps',
      'Apple Maps',
      'Sygic',
      'HERE WeGo',
      'OsmAnd',
      'Another iOS/Android app',
      'A Garmin',
      'A TomTom',
      'Printed directions or a roadbook',
      'Memory and road signs',
    ],
  },
  {
    id: 'beta',
    label: 'Want in on the beta?',
    hint: 'Riders are waved in by hand, a few at a time.',
    multi: false,
    required: false,
    options: ['Yes, put me on the list', 'Maybe later', 'No thanks'],
  },
]

export const OPEN_QUESTIONS: readonly OpenQuestion[] = [
  {
    id: 'planner-failed',
    label: 'The last time a route planner or a GPS let you down, what happened?',
    hint: 'Specifics are more useful than a verdict.',
    required: false,
  },
  {
    id: 'group-pain',
    label: 'What is the most annoying part of planning a ride with other people?',
    required: false,
  },
  { id: 'anything-else', label: 'Anything else I should know?', required: false },
]

const CHOICE_BY_ID = new Map(CHOICE_QUESTIONS.map((q) => [q.id, q]))

// --- The stored shape --------------------------------------------------------

export type SurveyAnswers = {
  /** bundle id -> 0..3. Sparse while a draft is in progress. */
  ratings: Record<string, number>
  /** Up to TOP_PICKS bundle ids, most important first. Order is the answer. */
  top: string[]
  /** Single-choice question id -> the chosen option. */
  single: Record<string, string>
  /** Multi-choice question id -> chosen options. */
  multi: Record<string, string[]>
  /** Open question id -> text. */
  open: Record<string, string>
}

export const EMPTY_ANSWERS: SurveyAnswers = { ratings: {}, top: [], single: {}, multi: {}, open: {} }

/**
 * Read whatever is in the column and produce something the form can render.
 *
 * Lenient by contract. It drops ratings for bundles that no longer exist, drops
 * options that are no longer offered, clamps out-of-range numbers and truncates
 * long text, and it never throws. A rider with a half-finished form must not
 * lose it because a question was reworded between two sessions, and the admin
 * summary must not 500 on one malformed row out of forty.
 *
 * Anything this drops was already unusable — a rating for a deleted bundle
 * cannot be scored and cannot be rendered.
 */
export function parseAnswers(raw: unknown): SurveyAnswers {
  const src = (raw ?? {}) as Record<string, unknown>
  const out: SurveyAnswers = { ratings: {}, top: [], single: {}, multi: {}, open: {} }

  const ratings = (src.ratings ?? {}) as Record<string, unknown>
  for (const [id, v] of Object.entries(ratings)) {
    if (!BUNDLE_ID_SET.has(id)) continue
    const n = Math.round(Number(v))
    if (Number.isFinite(n)) out.ratings[id] = Math.min(MAX_RATING, Math.max(MIN_RATING, n))
  }

  // Deduped as well as filtered: a duplicate would be counted twice by the
  // weighted score, which is the one place a bad row could skew the result
  // rather than just look untidy.
  const seen = new Set<string>()
  for (const v of Array.isArray(src.top) ? src.top : []) {
    if (typeof v !== 'string' || !BUNDLE_ID_SET.has(v) || seen.has(v)) continue
    seen.add(v)
    out.top.push(v)
    if (out.top.length === TOP_PICKS) break
  }

  const single = (src.single ?? {}) as Record<string, unknown>
  for (const [id, v] of Object.entries(single)) {
    const q = CHOICE_BY_ID.get(id)
    if (q && !q.multi && typeof v === 'string' && q.options.includes(v)) out.single[id] = v
  }

  const multi = (src.multi ?? {}) as Record<string, unknown>
  for (const [id, v] of Object.entries(multi)) {
    const q = CHOICE_BY_ID.get(id)
    if (!q || !q.multi || !Array.isArray(v)) continue
    const picked = v.filter((x): x is string => typeof x === 'string' && q.options.includes(x))
    if (picked.length) out.multi[id] = [...new Set(picked)]
  }

  const open = (src.open ?? {}) as Record<string, unknown>
  for (const q of OPEN_QUESTIONS) {
    const v = open[q.id]
    if (typeof v === 'string' && v.trim()) out.open[q.id] = v.trim().slice(0, OPEN_MAX)
  }

  return out
}

/**
 * Zod mirror of the stored shape.
 *
 * Not used on the read path — parseAnswers is, because a schema that rejects is
 * the wrong tool for data already in the database. This exists so the shape is
 * stated once in a form the type system derives from, and for the admin import
 * path if one is ever added.
 */
export const answersSchema = z.object({
  ratings: z.record(z.string(), z.number().int().min(MIN_RATING).max(MAX_RATING)),
  top: z.array(z.string()).max(TOP_PICKS),
  single: z.record(z.string(), z.string()),
  multi: z.record(z.string(), z.array(z.string())),
  open: z.record(z.string(), z.string().max(OPEN_MAX)),
})

/**
 * Is this good enough to submit? Field-keyed errors, `{}` means yes.
 *
 * Field-keyed rather than first-issue-wins, for the reason profile.tsx gives:
 * a form shows every bad field at once. The keys match the input names the
 * survey view renders, so the template can look each one up directly.
 *
 * Draft saves do NOT come through here. A half-finished form is a valid draft
 * and an invalid submission, and conflating the two would mean a rider cannot
 * save and come back.
 */
export function validateSubmission(a: SurveyAnswers): Record<string, string> {
  const errors: Record<string, string> = {}

  const unrated = BUNDLES.filter((b) => a.ratings[b.id] === undefined)
  if (unrated.length) {
    // Named rather than counted: with 34 rows on one page, "12 unanswered" is a
    // scavenger hunt. The view also marks each row, but the summary has to be
    // able to stand alone at the top of the page.
    for (const b of unrated) errors[`rating:${b.id}`] = 'Pick one'
    errors.ratings = `${unrated.length} ${unrated.length === 1 ? 'question is' : 'questions are'} unanswered`
  }

  if (a.top.length !== TOP_PICKS) {
    errors.top = `Pick exactly ${TOP_PICKS}`
  } else if (new Set(a.top).size !== a.top.length) {
    // parseAnswers dedupes, so this is only reachable from a hand-built POST.
    // Still worth a real message rather than a silent truncation to 4.
    errors.top = 'Each pick has to be a different one'
  }

  for (const q of CHOICE_QUESTIONS) {
    if (!q.required) continue
    const answered = q.multi ? (a.multi[q.id]?.length ?? 0) > 0 : Boolean(a.single[q.id])
    if (!answered) errors[q.id] = q.multi ? 'Pick at least one' : 'Pick one'
  }

  for (const q of OPEN_QUESTIONS) {
    if (q.required && !a.open[q.id]?.trim()) errors[q.id] = 'This one needs an answer'
  }

  return errors
}
