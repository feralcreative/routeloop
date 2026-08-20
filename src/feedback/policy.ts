// What a report is, who may see it, and what every state is called in front of a
// rider — as pure functions.
//
// Same split as src/invites/policy.ts and src/survey/score.ts:
//
//   this file  — the RULE. Readable, enumerable, asserted as a table in
//                test/feedback-policy.test.ts.
//   service.ts — the QUERIES. Everything that touches a table.
//
// Everything here is a function of its arguments and nothing else, which is what
// lets the tests import it with no database — vitest.config.ts is deliberately
// scoped to pure logic and CI runs with no Postgres. Nothing that reads a table
// belongs in this file.
import type { FeedbackKind, FeedbackState, FeedbackStatus, UserStatus } from '../db/schema'

/** Reports one rider may submit per hour. Generous — the cost of blocking a real
 *  bug report is far higher than the cost of storing a few junk rows. */
export const SUBMIT_LIMIT = 10

/** The one required field, matching `feedback.body` varchar(4000). */
export const BODY_MIN = 3
export const BODY_MAX = 4000

/** Attachments per report, matching the `multiple` file input's own cap. */
export const ATTACHMENT_MAX = 3

// --- Kinds -------------------------------------------------------------------

/**
 * Which optional fields each kind actually collects.
 *
 * This is the single source for what the intake asks and what the queue renders,
 * so a field can never be asked on one screen and dropped on the other. Asking a
 * rider a question whose answer is then thrown away is the specific failure this
 * table prevents.
 */
export type KindMeta = {
  /** The tap card on screen 1. */
  label: string
  /** The card's second line. */
  blurb: string
  /** The heading on the one required screen. */
  prompt: string
  /** Which screen it happened on. Bugs and ideas both want it; a question does not. */
  asksArea: boolean
  /** "Does it do it every time?" — steps-to-reproduce asked in a way someone answers. */
  asksFrequency: boolean
  /** "When did you last wish you had it?" — the story, which people can tell. */
  asksContext: boolean
  /** "How much would this change your rides?" — the whole prioritization signal. */
  asksImpact: boolean
  /** A screenshot or photo. */
  asksAttachment: boolean
  /** Whether a published report of this kind opens for wants. */
  wantable: boolean
}

export const KIND_META: Record<FeedbackKind, KindMeta> = {
  bug: {
    label: "Something's broken",
    blurb: "It didn't work, looked wrong, or wouldn't load",
    prompt: 'What happened?',
    asksArea: true,
    asksFrequency: true,
    asksContext: false,
    asksImpact: false,
    asksAttachment: true,
    // Publishing a bug is the exception, for a known-issue banner that cuts
    // duplicate reports — and a bug is not a thing riders vote for.
    wantable: false,
  },
  idea: {
    label: "I've got an idea",
    blurb: "Something Routeloop should do that it doesn't",
    prompt: 'What do you wish Routeloop did?',
    asksArea: true,
    asksFrequency: false,
    asksContext: true,
    asksImpact: true,
    asksAttachment: true,
    wantable: true,
  },
  question: {
    label: "I've got a question",
    blurb: 'Not sure how something works? Ask away',
    prompt: 'What do you want to know?',
    asksArea: false,
    asksFrequency: false,
    asksContext: false,
    asksImpact: false,
    asksAttachment: false,
    wantable: false,
  },
}

export const KIND_ORDER: readonly FeedbackKind[] = ['bug', 'idea', 'question']

// --- Areas -------------------------------------------------------------------

/**
 * Where it happened, as a chip group — never a `<select>`.
 *
 * A native select on iOS opens a wheel picker with roughly 34px rows, which is
 * not operable with gloves on. The whole flow is used outdoors.
 *
 * These are rider words, not route names. "Looking at the map" is the viewer;
 * nobody calls it that but us.
 */
export const AREAS = [
  { id: 'planning', label: 'Planning a route' },
  { id: 'map', label: 'Looking at the map' },
  { id: 'saving', label: 'Saving or opening a ride' },
  { id: 'my_rides', label: 'My saved rides' },
  { id: 'sharing', label: 'Sharing a ride' },
  { id: 'account', label: 'Signing in / my account' },
  { id: 'elsewhere', label: 'Somewhere else' },
  { id: 'unsure', label: 'Not sure' },
] as const

export type AreaId = (typeof AREAS)[number]['id']

const AREA_BY_ID = new Map<string, (typeof AREAS)[number]>(AREAS.map((a) => [a.id, a]))

/** The rider-facing label, or null for an id we do not offer. Never throws — an
 *  area stored before this list changed must not 500 the queue. */
export function areaLabel(id: string | null): string | null {
  return id === null ? null : (AREA_BY_ID.get(id)?.label ?? null)
}

export function isAreaId(id: unknown): id is AreaId {
  return typeof id === 'string' && AREA_BY_ID.has(id)
}

/**
 * Which area a path is in, so the floating entry point can pre-fill `?area=` and
 * screen 3 can offer a one-tap confirm instead of eight chips.
 *
 * Inference, not truth: a rider who disagrees taps "Somewhere else". Returning
 * null is always safe and simply falls back to the cold chip group.
 *
 * Matched on the pattern, not the URL — `/m/:slug` and `/m/abc123` must land in
 * the same bucket, and no query string ever reaches here.
 */
export function areaFromPath(path: string): AreaId | null {
  const p = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  if (p === '/build' || p.startsWith('/build/')) return 'planning'
  if (p === '/m' || p.startsWith('/m/')) return 'map'
  if (p === '/rides' || p.startsWith('/rides/')) return 'my_rides'
  if (p === '/import' || p.startsWith('/import/')) return 'saving'
  if (p === '/account' || p.startsWith('/account/') || p.startsWith('/login')) return 'account'
  return null
}

// --- The optional single-choice answers --------------------------------------

/** Bugs only. "Just the once so far" is a real answer and must not be missing —
 *  a rider forced to claim a pattern they have not seen will guess. */
export const FREQUENCIES = [
  { id: 'every_time', label: 'Every time' },
  { id: 'sometimes', label: 'Sometimes' },
  { id: 'once', label: 'Just the once so far' },
  { id: 'unknown', label: "Don't know" },
] as const

export type FrequencyId = (typeof FREQUENCIES)[number]['id']

/** Ideas only. The third option is the entire prioritization signal, and it is
 *  phrased as a sentence a rider would say out loud. */
export const IMPACTS = [
  { id: 'nice', label: 'Nice to have' },
  { id: 'often', label: "I'd use it a lot" },
  { id: 'every_ride', label: 'I work around this every single ride' },
] as const

export type ImpactId = (typeof IMPACTS)[number]['id']

const FREQ_IDS = new Set<string>(FREQUENCIES.map((f) => f.id))
const IMPACT_IDS = new Set<string>(IMPACTS.map((i) => i.id))

export function isFrequencyId(id: unknown): id is FrequencyId {
  return typeof id === 'string' && FREQ_IDS.has(id)
}

export function isImpactId(id: unknown): id is ImpactId {
  return typeof id === 'string' && IMPACT_IDS.has(id)
}

export function frequencyLabel(id: string | null): string | null {
  return id === null ? null : (FREQUENCIES.find((f) => f.id === id)?.label ?? null)
}

export function impactLabel(id: string | null): string | null {
  return id === null ? null : (IMPACTS.find((i) => i.id === id)?.label ?? null)
}

// --- Status copy -------------------------------------------------------------

/**
 * Every rider-facing status, in the words a rider reads.
 *
 * Two rules, and they are why this is a table rather than a switch in a view:
 * **one motorcycle metaphor maximum** across the whole set, and every status is a
 * sentence about what is TRUE, not a workflow state. "In the shop" is the one
 * metaphor. Adding a second is how this ends up sounding like a mechanic
 * cosplay.
 *
 * test/feedback-status-labels.test.ts asserts this covers the enum exhaustively,
 * so adding a status to schema.ts without copy fails the build rather than
 * rendering `needs_info` to a rider.
 */
export type StatusMeta = {
  label: string
  /** Kind-specific override — 'shipped' is "Fixed and live" for a bug and "Built
   *  and live" for an idea, because those are different pieces of news. */
  labelByKind?: Partial<Record<FeedbackKind, string>>
  sub: string
  /** Whether this status means we are done with it, for grouping in the queue
   *  and the board's "Recently shipped" strip. */
  closed: boolean
}

export const STATUS_META: Record<FeedbackStatus, StatusMeta> = {
  new: { label: "We've seen it", sub: "Read it, haven't dug in yet", closed: false },
  needs_info: {
    label: 'We need one more thing from you',
    sub: 'Check your email—we asked a question',
    closed: false,
  },
  confirmed: { label: "Yep, that's a bug", sub: "We reproduced it. It's ours to fix.", closed: false },
  planned: { label: "We're going to build this", sub: "Not started yet, but it's happening", closed: false },
  in_progress: { label: 'In the shop', sub: 'Being worked on right now', closed: false },
  shipped: {
    label: 'Fixed and live',
    labelByKind: { idea: 'Built and live' },
    sub: 'Go try it',
    closed: true,
  },
  on_list: { label: 'On the list', sub: 'Good idea, not soon. Still counting wants.', closed: false },
  not_doing: {
    label: "We're not doing this one",
    // The reason is publicResponse, and the queue should refuse to save this
    // status without one. A bare "no" is worse than no answer at all.
    sub: 'Always paired with a one-line reason',
    closed: true,
  },
  no_repro: {
    label: "We couldn't make it happen",
    sub: 'Tell us more if you see it again',
    closed: true,
  },
  by_design: { label: "That's how it works on purpose", sub: 'Explains why, links to the FAQ', closed: true },
}

/** The label for this status as this kind of report. */
export function statusLabel(status: FeedbackStatus, kind: FeedbackKind): string {
  const meta = STATUS_META[status]
  return meta.labelByKind?.[kind] ?? meta.label
}

/**
 * Words that must never appear on a rider-facing surface, in code or in copy.
 *
 * Every one of them is either jargon a rider does not have, or a judgment about
 * the rider rather than the report. "user error" and "invalid" are the two that
 * lose a rider permanently.
 *
 * Asserted against STATUS_META by test/feedback-status-labels.test.ts. It cannot
 * police a view, so this list is also the review checklist for one.
 */
export const BANNED_WORDS: readonly string[] = [
  'triaged',
  'backlog',
  "won't fix",
  'wontfix',
  'p0',
  'p1',
  'p2',
  'sev',
  'repro',
  'epic',
  'sprint',
  'deprioritized',
  'invalid',
  'user error',
]

// --- Visibility --------------------------------------------------------------

/** The subset of a report these rules need. Deliberately not FeedbackRow — a
 *  narrower argument is what keeps this callable from a test with no database. */
export type ReportState = {
  authorId: number
  kind: FeedbackKind
  state: FeedbackState
}

/** The subset of a user row these rules need. Never null: every feedback route
 *  is behind requireActive or requireManageRiders, so an anonymous viewer does
 *  not reach any of them. */
export type ViewerState = {
  id: number
  status: UserStatus
  canManageRiders: boolean
}

/**
 * Whether this viewer may see this report at all.
 *
 * **This function is the private-bug feature.** There is no separate mechanism:
 * a report is invisible to everyone but its author and the owner until it is
 * `published`, and nothing publishes a bug by default. That is the whole design,
 * and it is why `state` and `status` are two columns — see the enums in
 * schema.ts.
 *
 * A report the viewer may not see must 404, never 403, matching the ride-slug
 * precedent: a 403 confirms the report exists, which on a moderated board leaks
 * that someone reported something.
 */
export function visibleTo(report: ReportState, viewer: ViewerState): boolean {
  if (viewer.canManageRiders) return true
  if (report.authorId === viewer.id) return true
  return report.state === 'published'
}

/**
 * Whether this viewer may cast a want on this report.
 *
 * The author is excluded because their want is auto-cast when the report is
 * published — they already have a vote row, and offering them the button would
 * let them un-want their own idea, which reads as a bug rather than a feature.
 *
 * The composite primary key on feedback_votes enforces one-per-rider regardless
 * of what this returns; this decides whether the button renders.
 */
export function canWant(report: ReportState, viewer: ViewerState): boolean {
  if (report.state !== 'published') return false
  if (!KIND_META[report.kind].wantable) return false
  if (viewer.status !== 'active') return false
  return report.authorId !== viewer.id
}

/** Whether the owner's moderation surface is this viewer's to use. Thin, but it
 *  keeps the queue's own checks reading like the rest of this file. */
export function canModerate(viewer: ViewerState): boolean {
  return viewer.canManageRiders
}

// --- Titles ------------------------------------------------------------------

/** Matches `feedback.title` varchar(150), but titles are cut far shorter than
 *  that — this is the readable length in the queue, not the column limit. */
export const TITLE_MAX = 80

/**
 * A title, derived from the body. **Riders are never asked for one.**
 *
 * Asking for a title is the single most abandonment-prone field on a feedback
 * form: it demands a summary before the person has finished working out what
 * they want to say. The owner can edit this before publishing, which is the only
 * place a title needs to be good.
 *
 * First sentence, or the first `TITLE_MAX` characters cut at a word boundary,
 * whichever is shorter. Deterministic and total — it never throws and always
 * returns a string, because it runs inside the submit transaction and a report
 * must not be lost to a body it could not summarize.
 */
export function titleFrom(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (!flat) return ''

  // The first sentence, if one ends inside the budget. A decimal or an
  // abbreviation would split early here; that is acceptable for a queue label
  // and not worth a sentence tokenizer.
  const end = flat.search(/[.!?](\s|$)/)
  if (end !== -1 && end + 1 <= TITLE_MAX) {
    // The '.' is dropped and '?'/'!' are kept: a trailing period on a label
    // reads like a typo, a question mark carries meaning.
    const punct = flat[end]
    return flat.slice(0, end) + (punct === '.' ? '' : punct)
  }

  if (flat.length <= TITLE_MAX) return flat

  // Cut at a word boundary, leaving room for the ellipsis inside the budget. A
  // single word longer than the budget has no boundary to find, so it is cut
  // hard rather than returned whole.
  const cut = flat.slice(0, TITLE_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd() + '…'
}

// --- Diagnostics -------------------------------------------------------------

/**
 * What the browser told us, after redaction.
 *
 * Every field is optional because every field is best-effort: `feedback.js`
 * enriches and is not load-bearing, and a report submitted with JavaScript
 * broken is exactly the report we most want to keep.
 */
export type Diagnostics = {
  app?: { version?: string; pattern?: string; referrer?: string }
  device?: Record<string, string | number | boolean>
  prefs?: Record<string, string | number | boolean>
  errors?: { at?: number; kind?: string; message?: string; stack?: string }[]
  net?: { at?: number; method?: string; path?: string; status?: number; ms?: number }[]
  health?: Record<string, string | number | boolean>
  map?: Record<string, string | number | boolean>
  permissions?: Record<string, string>
}

/** Caps, applied on read as well as on write. A payload that grew past these in
 *  storage is truncated rather than rejected — it is already stored, and half a
 *  stack trace still names the file. */
export const DIAG_ERRORS_MAX = 25
export const DIAG_NET_MAX = 10
const STRING_MAX = 2000
const STACK_MAX = 4000

function str(v: unknown, max = STRING_MAX): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
}

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Flat maps of primitives, which is all the device/prefs/health blocks ever
 *  hold. Anything nested is dropped rather than walked — nothing writes it, so
 *  its presence means the payload is not ours. */
function flat(v: unknown, keyMax = 40): Record<string, string | number | boolean> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k.length > keyMax) continue
    if (typeof val === 'boolean' || typeof val === 'number') out[k] = val
    else {
      const s = str(val, 300)
      if (s !== undefined) out[k] = s
    }
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * The stored blob, read leniently. **Never casts.**
 *
 * Same contract as `parseAnswers()` in the survey, for the same reason: `$type<>`
 * on a jsonb column is a compile-time claim Postgres does not enforce, so a row
 * written by an older build, a truncated POST or a hand-crafted one all arrive
 * here as `unknown` and must not throw. The queue must not 500 on one malformed
 * payload out of forty, and a report whose diagnostics are unreadable is still a
 * report worth reading.
 *
 * Anything this drops was already unusable.
 */
export function parseDiagnostics(raw: unknown): Diagnostics {
  const src = (raw ?? {}) as Record<string, unknown>
  const out: Diagnostics = {}

  const app = (src.app ?? {}) as Record<string, unknown>
  const version = str(app.version, 60)
  const pattern = str(app.pattern, 200)
  const referrer = str(app.referrer, 300)
  if (version || pattern || referrer)
    out.app = { ...(version && { version }), ...(pattern && { pattern }), ...(referrer && { referrer }) }

  const device = flat(src.device)
  if (device) out.device = device
  const prefs = flat(src.prefs)
  if (prefs) out.prefs = prefs
  const health = flat(src.health)
  if (health) out.health = health
  const map = flat(src.map)
  if (map) out.map = map

  const errors = Array.isArray(src.errors) ? src.errors : []
  const errOut: NonNullable<Diagnostics['errors']> = []
  for (const e of errors) {
    if (errOut.length >= DIAG_ERRORS_MAX) break
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const message = str(r.message)
    const kind = str(r.kind, 40)
    const stack = str(r.stack, STACK_MAX)
    const at = num(r.at)
    if (message || stack)
      errOut.push({
        ...(at !== undefined && { at }),
        ...(kind && { kind }),
        ...(message && { message }),
        ...(stack && { stack }),
      })
  }
  if (errOut.length) out.errors = errOut

  const net = Array.isArray(src.net) ? src.net : []
  const netOut: NonNullable<Diagnostics['net']> = []
  for (const n of net) {
    if (netOut.length >= DIAG_NET_MAX) break
    if (!n || typeof n !== 'object') continue
    const r = n as Record<string, unknown>
    const path = str(r.path, 300)
    if (!path) continue
    const method = str(r.method, 10)
    const status = num(r.status)
    const ms = num(r.ms)
    const at = num(r.at)
    netOut.push({
      ...(at !== undefined && { at }),
      ...(method && { method }),
      path,
      ...(status !== undefined && { status }),
      ...(ms !== undefined && { ms }),
    })
  }
  if (netOut.length) out.net = netOut

  // Permission STATES only, and this is the one place the parser is strict
  // rather than lenient: anything that is not one of the three known states is
  // dropped, so a coordinate pair smuggled in under `permissions.geolocation`
  // cannot survive a read even if it somehow survived a write.
  const perms = (src.permissions ?? {}) as Record<string, unknown>
  const permOut: Record<string, string> = {}
  for (const [k, v] of Object.entries(perms)) {
    if (k.length > 40) continue
    const s = str(v, 20)
    if (s === 'granted' || s === 'denied' || s === 'prompt') permOut[k] = s
  }
  if (Object.keys(permOut).length) out.permissions = permOut

  return out
}
