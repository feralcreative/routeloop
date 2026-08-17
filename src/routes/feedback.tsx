// The intake flow, and the page a rider reads their own reports back on.
//
// Server-rendered, one screen per step, following routes/survey.tsx — which
// already solves multi-step form state with no bundler. GET is inert; every
// write is a POST behind requireSameOrigin.
//
// **The send button is live from screen 2 onward, and that is the highest-
// leverage decision in the whole design.** Everything after the first typed
// field is a tap, optional, and skippable. A rider who types one sentence and
// hits Send has filed a complete report; the screens after it are for the rider
// who wants to say more, never a toll gate on the one who does not.
//
// Two mechanics worth knowing before changing anything here:
//
// **Steps advance by POST, and nothing is written until `action=send`.** The
// accumulated answers ride in hidden fields, so a refresh mid-flow re-posts a
// no-op rather than creating a second report. That is also why the photo step is
// LAST: a File cannot survive a re-render, so it is only ever collected on the
// screen that submits.
//
// **The flow is light-mode-first regardless of the system theme.** A dark UI on
// a phone in direct sunlight is close to unreadable, and this is the one surface
// used at a gas stop in July more than at a desk. Decided 2026-08-16; the
// `feedback-flow` body class is what carries it, in style/_feedback.scss.
import { Hono } from 'hono'
import type { Context } from 'hono'
import { readFile } from 'node:fs/promises'
import {
  currentUser,
  requireActive,
  requireActiveApi,
  requireManageRiders,
  requireSameOrigin,
  type AuthEnv,
} from '../auth/middleware'
import { APP_ORIGIN } from '../config'
import { page } from '../views/layout'
import { asset } from '../views/assets'
import { content } from '../views/content'
import {
  AREAS,
  ATTACHMENT_MAX,
  BODY_MIN,
  FREQUENCIES,
  IMPACTS,
  KIND_META,
  KIND_ORDER,
  SUBMIT_LIMIT,
  STATUS_META,
  areaLabel,
  canWant,
  frequencyLabel,
  impactLabel,
  isAreaId,
  isFrequencyId,
  isImpactId,
  parseDiagnostics,
  statusLabel,
} from '../feedback/policy'
import { parseFaq } from '../feedback/faq'
import {
  getById,
  getByPublicId,
  getDiagnostics,
  isOverSubmitLimit,
  listBoard,
  listMine,
  listQueue,
  listShipped,
  moderate,
  queueCounts,
  submitReport,
  toggleWant,
  wantedBy,
} from '../feedback/service'
import type { BoardRow, BoardSort, IncomingAttachment, Moderation } from '../feedback/service'
import { notifyNewReport } from '../feedback/notify'
import { ATTACHMENT_MAX_BYTES, MIME_EXT, pathForKey } from '../feedback/storage'
import { visibleTo } from '../feedback/policy'
import { feedbackStateEnum, feedbackStatusEnum } from '../db/schema'
import type { FeedbackKind, FeedbackState, FeedbackStatus } from '../db/schema'

/** The enum members, in schema order, for the queue's status picker. */
const feedbackStatusValues = feedbackStatusEnum.enumValues

function isState(v: string): v is FeedbackState {
  return (feedbackStateEnum.enumValues as readonly string[]).includes(v)
}

function isStatus(v: string): v is FeedbackStatus {
  return (feedbackStatusValues as readonly string[]).includes(v)
}

export const feedbackRoutes = new Hono<AuthEnv>()

// --- Body parsing ------------------------------------------------------------

// Same shape as routes/survey.tsx: parseBody({ all: true }) yields arrays for
// repeated names, and everything below normalizes back down. A field that is
// sometimes a string and sometimes an array is what produces "why is my answer
// the letter G".
type Body = Record<string, string | File | (string | File)[]>

const one = (v: Body[string] | undefined): string => {
  const x = Array.isArray(v) ? v[0] : v
  return typeof x === 'string' ? x : ''
}

const files = (v: Body[string] | undefined): File[] => {
  const list = Array.isArray(v) ? v : [v]
  return list.filter((x): x is File => x instanceof File && x.size > 0)
}

// --- The draft ---------------------------------------------------------------

/** Everything gathered so far. Lives in hidden fields between screens and in
 *  nothing else — no session key, no localStorage, no half-written row. An
 *  abandoned flow leaves no trace, which is the correct behavior for something a
 *  rider started typing and thought better of. */
type Draft = {
  kind: FeedbackKind | ''
  body: string
  area: string
  frequency: string
  impact: string
  context: string
  replyOk: boolean
  /** Filled by public/js/feedback.js. Opaque JSON here; redacted in the service. */
  diag: string
}

const EMPTY: Draft = { kind: '', body: '', area: '', frequency: '', impact: '', context: '', replyOk: true, diag: '' }

function isKind(v: string): v is FeedbackKind {
  return (KIND_ORDER as readonly string[]).includes(v)
}

function draftFromBody(b: Body): Draft {
  const kind = one(b.kind)
  const area = one(b.area)
  const frequency = one(b.frequency)
  const impact = one(b.impact)
  return {
    kind: isKind(kind) ? kind : '',
    body: one(b.body),
    // Validated here rather than trusted, because these arrive from hidden
    // fields a rider could edit. An unknown value becomes empty, never stored:
    // the column is a varchar and would happily take anything.
    area: isAreaId(area) ? area : '',
    frequency: isFrequencyId(frequency) ? frequency : '',
    impact: isImpactId(impact) ? impact : '',
    context: one(b.context),
    replyOk: one(b.replyOk) !== '0',
    diag: one(b.diag),
  }
}

// --- Steps -------------------------------------------------------------------

type StepId = 'kind' | 'body' | 'context' | 'impact' | 'area' | 'frequency' | 'photo'

// Derived from KIND_META rather than restated, so a kind that stops asking for
// impact cannot keep a screen that collects it.
function stepsFor(kind: FeedbackKind): StepId[] {
  const m = KIND_META[kind]
  const out: StepId[] = ['body']
  if (m.asksContext) out.push('context')
  if (m.asksImpact) out.push('impact')
  if (m.asksArea) out.push('area')
  if (m.asksFrequency) out.push('frequency')
  if (m.asksAttachment) out.push('photo')
  return out
}

/** The step after this one, or null when this was the last. */
function nextStep(kind: FeedbackKind, current: StepId): StepId | null {
  const steps = stepsFor(kind)
  const i = steps.indexOf(current)
  return i === -1 || i === steps.length - 1 ? null : steps[i + 1]
}

function isStep(v: string): v is StepId {
  return ['kind', 'body', 'context', 'impact', 'area', 'frequency', 'photo'].includes(v)
}

// --- Screens -----------------------------------------------------------------

/** Everything gathered so far, carried forward. A field absent from here is a
 *  field silently dropped between screens — the same failure mode
 *  `loadRidePayload` carries a comment about in routes/builder.ts. */
const Carry = ({ d, except }: { d: Draft; except?: keyof Draft }) => (
  <>
    {(['kind', 'body', 'area', 'frequency', 'impact', 'context', 'diag'] as const)
      .filter((k) => k !== except)
      .map((k) => (
        <input type="hidden" name={k} value={String(d[k] ?? '')} />
      ))}
    {except !== 'replyOk' && <input type="hidden" name="replyOk" value={d.replyOk ? '1' : '0'} />}
  </>
)

/** Next plus Send, in that order visually but with Send always present. The
 *  `formnovalidate` on Send is deliberate: an optional screen must not be able
 *  to block the submit a rider already earned on screen 2. */
const Actions = ({ last, sendLabel }: { last: boolean; sendLabel?: string }) => (
  <div class="fb-actions">
    {!last && (
      <button class="btn fb-next" type="submit" name="action" value="next">
        Next
      </button>
    )}
    <button
      class={last ? 'btn fb-send' : 'linkbtn fb-send-now'}
      type="submit"
      name="action"
      value="send"
      formnovalidate
    >
      {sendLabel ?? (last ? 'Send it' : 'Send it now')}
    </button>
  </div>
)

const KindFork = ({ area }: { area: string }) => (
  <>
    <h1>What's going on?</h1>
    <form method="get" action="/feedback" class="fb-fork">
      {area && <input type="hidden" name="area" value={area} />}
      {KIND_ORDER.map((k) => (
        <button class="fb-card" type="submit" name="kind" value={k}>
          <span class="fb-card-label">{KIND_META[k].label}</span>
          <span class="fb-card-blurb">{KIND_META[k].blurb}</span>
        </button>
      ))}
      {/* Never let the fork be the abandonment point. Someone who cannot
          classify their own problem still has the problem. */}
      <p class="fb-escape">
        Not sure which?{' '}
        <button class="linkbtn" type="submit" name="kind" value="bug">
          Just start typing →
        </button>
      </p>
    </form>
  </>
)

const BodyScreen = ({ d, kind, last, error }: { d: Draft; kind: FeedbackKind; last: boolean; error?: string }) => (
  <>
    <h1>{KIND_META[kind].prompt}</h1>
    <p class="fb-help">Plain words are perfect. No need to be technical.</p>
    {error && <p class="fb-error">{error}</p>}
    {/* No placeholder. Placeholder text vanishes on focus and measurably raises
        error rates; the example lives below the box, where it stays. */}
    <textarea
      class="fb-body"
      name="body"
      rows={6}
      autofocus
      required
      minlength={BODY_MIN}
      autocapitalize="sentences"
      enterkeyhint={last ? 'send' : 'next'}
    >
      {d.body}
    </textarea>
    <p class="fb-example">
      {kind === 'bug'
        ? 'Something like: "I hit save on my Blue Ridge route and the map went white."'
        : kind === 'idea'
          ? "Doesn't have to be polished. Half-formed is fine."
          : "Ask it however you'd say it out loud."}
    </p>
    <p class="fb-help">Wearing gloves? Tap the mic on your keyboard and just talk.</p>
    {kind === 'question' && <div class="fb-faq" id="fb-faq" hidden></div>}
    <Carry d={d} except="body" />
    <Actions last={last} />
  </>
)

const ContextScreen = ({ d, last }: { d: Draft; last: boolean }) => (
  <>
    <h1>When did you last wish you had it?</h1>
    {/* Never "what problem does this solve" or "what's your use case". People
        cannot write a problem statement; they can tell you about last Saturday,
        and the story is worth more than the feature request anyway. */}
    <p class="fb-help">The story helps more than the feature does, honestly.</p>
    <textarea class="fb-body" name="context" rows={5} autofocus autocapitalize="sentences" enterkeyhint="next">
      {d.context}
    </textarea>
    <p class="fb-example">
      Like: "Planning a 3-day trip through Colorado and I couldn't figure out where I'd end up each night."
    </p>
    <Carry d={d} except="context" />
    <Actions last={last} />
  </>
)

const ChipGroup = ({
  name,
  options,
  value,
}: {
  name: string
  options: readonly { id: string; label: string }[]
  value: string
}) => (
  // Chips, never a <select>. A native select on iOS opens a wheel picker with
  // roughly 34px rows, which is not operable with gloves on.
  <div class="fb-chips" role="radiogroup">
    {options.map((o) => (
      <label class={`fb-chip${value === o.id ? ' is-on' : ''}`}>
        <input type="radio" name={name} value={o.id} checked={value === o.id} />
        <span>{o.label}</span>
      </label>
    ))}
  </div>
)

const ImpactScreen = ({ d, last }: { d: Draft; last: boolean }) => (
  <>
    <h1>How much would this change your rides?</h1>
    <ChipGroup name="impact" options={IMPACTS} value={d.impact} />
    <Carry d={d} except="impact" />
    <Actions last={last} />
  </>
)

const FrequencyScreen = ({ d, last }: { d: Draft; last: boolean }) => (
  <>
    <h1>Does it do it every time?</h1>
    <p class="fb-help">Helps us find it faster.</p>
    <ChipGroup name="frequency" options={FREQUENCIES} value={d.frequency} />
    <Carry d={d} except="frequency" />
    <Actions last={last} />
  </>
)

const AreaScreen = ({ d, last, prefilled }: { d: Draft; last: boolean; prefilled: boolean }) =>
  // Pre-filled from ?area= by the floating entry point, so the rider confirms
  // instead of reading eight chips. This is the entire reason the floating
  // button exists rather than only a menu item.
  prefilled ? (
    <>
      <h1>Where did this happen?</h1>
      <p class="fb-confirm">
        Looks like this happened in <strong>{areaLabel(d.area)}</strong>.
      </p>
      <Carry d={d} />
      <div class="fb-actions">
        <button class="btn" type="submit" name="action" value="next">
          Yep
        </button>
        <button class="linkbtn" type="submit" name="action" value="pick-area">
          Somewhere else
        </button>
      </div>
      <p class="fb-actions">
        <button class="linkbtn fb-send-now" type="submit" name="action" value="send" formnovalidate>
          Send it now
        </button>
      </p>
    </>
  ) : (
    <>
      <h1>Where did this happen?</h1>
      <ChipGroup name="area" options={AREAS} value={d.area} />
      <Carry d={d} except="area" />
      <Actions last={last} />
    </>
  )

const PhotoScreen = ({ d }: { d: Draft }) => (
  <>
    <h1>Got a picture of it?</h1>
    <p class="fb-help">
      A screenshot beats a thousand words. If you already took one, it's probably at the top of your photos.
    </p>
    {/*
      No `capture` attribute. Setting capture="environment" forces the camera and
      blocks the screenshot the rider has already taken, which is the file we
      most want. A photo of the screen taken with another phone is accepted too —
      riders do this and it is still diagnostic.
    */}
    <input class="fb-file" type="file" name="photo" accept="image/*" multiple />
    <p class="fb-example">Up to {ATTACHMENT_MAX}. We shrink them before they leave your phone.</p>
    <Carry d={d} />
    <Actions last sendLabel="Send it" />
  </>
)

/** The line under the send button, and the reason it is one line with an
 *  expander rather than a paragraph: a rider who wants the detail taps for it,
 *  and one who does not is not made to read a privacy notice to file a bug. */
const DiagNote = () => (
  <details class="fb-diag">
    <summary>
      We attach a few technical details about your phone and what the app was doing. No location, no personal info.
    </summary>
    <ul>
      <li>Which screen you were on, and the app version</li>
      <li>Your phone, browser and screen size</li>
      <li>Any errors the app logged in the last few minutes</li>
      <li>Whether you had given permission for things like location — never where you are</li>
    </ul>
    <p>
      <a href="/privacy">How we handle this</a>
    </p>
  </details>
)

function flowPage(c: Context<AuthEnv>, inner: string, title: string, tb?: Record<string, unknown>) {
  return c.html(
    page({
      title,
      user: currentUser(c),
      navKey: 'feedback',
      // Carries the light-mode-first rule. See the header comment.
      bodyClass: 'feedback-flow',
      body: inner,
      scripts: `<script src="${asset('/js/feedback.js')}" defer></script>`,
      ...(tb ? { tb } : {}),
    }),
  )
}

/** One step, wrapped in the form that carries it. Screen 1 is its own GET form
 *  and does not come through here. */
function stepBody(d: Draft, kind: FeedbackKind, step: StepId, opts: { prefilled?: boolean; error?: string }): string {
  const last = nextStep(kind, step) === null
  return (
    <form class="fb-flow" method="post" action="/feedback" enctype="multipart/form-data">
      <input type="hidden" name="step" value={step} />
      {step === 'body' && <BodyScreen d={d} kind={kind} last={last} error={opts.error} />}
      {step === 'context' && <ContextScreen d={d} last={last} />}
      {step === 'impact' && <ImpactScreen d={d} last={last} />}
      {step === 'area' && <AreaScreen d={d} last={last} prefilled={opts.prefilled ?? false} />}
      {step === 'frequency' && <FrequencyScreen d={d} last={last} />}
      {step === 'photo' && <PhotoScreen d={d} />}
      <DiagNote />
    </form>
  ).toString()
}

// --- Routes ------------------------------------------------------------------

// /feedback/mine and /feedback/thanks are registered BEFORE /feedback/:publicId
// on purpose. Registered after it, the parameterized route swallows them and
// answers with a 404 for a report whose public id happens to be "mine". Same
// class of bug as the zip route ordering in src/index.tsx, which is documented
// there because it was observed rather than theorised.

feedbackRoutes.get('/feedback', requireActive, (c) => {
  const kindRaw = c.req.query('kind') ?? ''
  const areaRaw = c.req.query('area') ?? ''
  const area = isAreaId(areaRaw) ? areaRaw : ''

  if (!isKind(kindRaw)) {
    return flowPage(c, (<KindFork area={area} />).toString(), 'Tell us something')
  }

  const d: Draft = { ...EMPTY, kind: kindRaw, area }
  const tb =
    kindRaw === 'question'
      ? // Shipped to the client so the suggestion strip is live as they type.
        // 24 short strings; smaller than one of the icons on the page.
        { faq: parseFaq(content('faq.html', { RIDING_YEARS: 0, WEB_YEARS: 0 })) }
      : undefined
  return flowPage(c, stepBody(d, kindRaw, 'body', {}), KIND_META[kindRaw].label, tb)
})

feedbackRoutes.post('/feedback', requireActive, requireSameOrigin, async (c) => {
  const me = currentUser(c)
  const raw = (await c.req.parseBody({ all: true })) as Body
  const d = draftFromBody(raw)
  const action = one(raw.action)
  const stepRaw = one(raw.step)
  const step: StepId = isStep(stepRaw) ? stepRaw : 'body'

  if (!d.kind) return c.redirect('/feedback', 302)
  const kind = d.kind

  // "Somewhere else" on the confirm chip: clear the inference and re-render the
  // full group rather than advancing.
  if (action === 'pick-area') {
    return flowPage(c, stepBody({ ...d, area: '' }, kind, 'area', { prefilled: false }), KIND_META[kind].label)
  }

  if (action !== 'send') {
    const next = nextStep(kind, step)
    if (next) {
      return flowPage(
        c,
        stepBody(d, kind, next, { prefilled: next === 'area' && d.area !== '' }),
        KIND_META[kind].label,
      )
    }
    // Nothing left to ask, so Next means Send. Falls through.
  }

  const body = d.body.trim()
  if (body.length < BODY_MIN) {
    return flowPage(
      c,
      stepBody(d, kind, 'body', { error: 'Tell us what happened first — even a few words is plenty.' }),
      KIND_META[kind].label,
    )
  }

  if (await isOverSubmitLimit(me.id, new Date())) {
    return flowPage(
      c,
      (
        <>
          <h1>That's a lot of reports</h1>
          <p class="fb-help">
            You've sent {SUBMIT_LIMIT} in the last hour, which is where we stop for now. Nothing you sent is lost. Give
            it a few minutes and the form will work again.
          </p>
          <p>
            <a class="btn" href="/feedback/mine">
              See what you've sent
            </a>
          </p>
        </>
      ).toString(),
      'Slow down a moment',
    )
  }

  const attachments: IncomingAttachment[] = []
  for (const f of files(raw.photo).slice(0, ATTACHMENT_MAX)) {
    const ext = MIME_EXT[f.type]
    // Refused rather than stored under a guessed extension. A file nothing can
    // open is worse than no file, and it would still count against the report.
    if (!ext) continue
    if (f.size > ATTACHMENT_MAX_BYTES) continue
    attachments.push({ ext, mime: f.type, data: Buffer.from(await f.arrayBuffer()) })
  }

  let diagnostics: unknown = null
  try {
    diagnostics = d.diag ? JSON.parse(d.diag) : null
  } catch {
    // A malformed blob must never cost a rider their report. The service
    // redacts and parses leniently either way; this is one more layer of the
    // same rule.
    diagnostics = null
  }

  const report = await submitReport({
    authorId: me.id,
    kind,
    body,
    context: d.context,
    area: d.area || null,
    frequency: kind === 'bug' ? d.frequency || null : null,
    impact: kind === 'idea' ? d.impact || null : null,
    replyOk: d.replyOk,
    diagnostics,
    attachments,
  })

  // After the transaction has committed, and fire-and-forget. A mail failure
  // must not turn a filed report into an error page — the entire design of this
  // intake is that nothing a rider sends can be lost to something going wrong
  // after they hit send.
  notifyNewReport(report, me.displayName)

  // Redirect rather than re-render, so a refresh cannot file it twice.
  return c.redirect(`/feedback/thanks?r=${report.publicId}`, 302)
})

feedbackRoutes.get('/feedback/thanks', requireActive, async (c) => {
  const publicId = c.req.query('r') ?? ''
  const found = publicId ? await getByPublicId(publicId) : null
  const me = currentUser(c)
  // Confirmation is a full screen, not a toast. Riders need to believe it
  // landed, and a toast that has already faded is indistinguishable from a form
  // that silently failed.
  const body = (
    <>
      <h1>Got it. Thanks.</h1>
      <p class="fb-help">A real person reads every one of these — usually same day.</p>
      <p class="fb-help">We grabbed the technical bits automatically, so you don't have to explain any of it.</p>
      {found && <p class="fb-ref">Your report: #{found.report.id}</p>}
      {/* Deliberately NOT "it's on the board". The board is moderated, and that
          message would be a lie the first time something is declined. */}
      {found?.report.kind === 'idea' && <p class="fb-help">If it's a good fit you'll see it turn up on the board.</p>}
      <p class="fb-after">
        <a class="btn" href="/feedback/mine">
          See what you've sent
        </a>{' '}
        <a class="linkbtn" href="/">
          Back to Routeloop
        </a>
      </p>
    </>
  ).toString()
  return c.html(page({ title: 'Thanks', user: me, navKey: 'feedback', bodyClass: 'feedback-flow', body }))
})

feedbackRoutes.get('/feedback/mine', requireActive, async (c) => {
  const me = currentUser(c)
  const rows = await listMine(me.id)
  const body = (
    <>
      <h1>What you've sent</h1>
      {rows.length === 0 ? (
        <p class="fb-help">
          Nothing yet. <a href="/feedback">Tell us something</a> — it genuinely helps.
        </p>
      ) : (
        <ul class="fb-list">
          {rows.map((r) => {
            const meta = STATUS_META[r.status]
            return (
              <li class="fb-item">
                <div class="fb-item-head">
                  <span class={`fb-kind is-${r.kind}`}>{KIND_META[r.kind].label}</span>
                  <span class="fb-when">{r.createdAt.toISOString().slice(0, 10)}</span>
                </div>
                <div class="fb-item-title">{r.title ?? r.body.slice(0, 80)}</div>
                <div class="fb-status">
                  <strong>{statusLabel(r.status, r.kind)}</strong>
                  <span class="fb-status-sub">{meta.sub}</span>
                </div>
                {r.publicResponse && <p class="fb-response">{r.publicResponse}</p>}
                {r.state === 'published' && r.kind === 'idea' && (
                  <p class="fb-wants">{r.wantCount === 1 ? '1 rider wants this' : `${r.wantCount} riders want this`}</p>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <p class="fb-after">
        <a class="btn" href="/feedback">
          Send something else
        </a>
      </p>
    </>
  ).toString()
  return c.html(page({ title: 'What you have sent', user: me, navKey: 'feedback', body }))
})

/**
 * One attachment.
 *
 * Not in the original plan's route table, and it has to exist: without it the
 * rider's own view and the owner's queue can store an image and never show one.
 * Gated by the same `visibleTo` as the report itself rather than by the
 * unguessability of the key — a storage key is a path, not a capability.
 */
feedbackRoutes.get('/feedback/:publicId/photo/:n', requireActive, async (c) => {
  const me = currentUser(c)
  const found = await getByPublicId(c.req.param('publicId'))
  // 404 rather than 403 throughout, matching the ride-slug precedent: a 403
  // confirms the report exists, which on a moderated board leaks that someone
  // reported something.
  if (!found || !visibleTo(found.report, me)) return c.notFound()

  const n = Number(c.req.param('n'))
  const file = Number.isInteger(n) ? found.attachments[n] : undefined
  if (!file) return c.notFound()

  const path = pathForKey(file.storageKey)
  if (!path) return c.notFound()
  const data = await readFile(path).catch(() => null)
  if (!data) return c.notFound()

  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': file.mime,
      'X-Content-Type-Options': 'nosniff',
      // Private: this is one rider's screenshot, and a shared cache holding it
      // is the same leak as showing it to the wrong person.
      'Cache-Control': 'private, max-age=3600',
    },
  })
})

feedbackRoutes.get('/feedback/:publicId', requireActive, async (c) => {
  const me = currentUser(c)
  const publicId = c.req.param('publicId')
  const found = await getByPublicId(publicId)
  if (!found || !visibleTo(found.report, me)) return c.notFound()

  const r = found.report
  const meta = STATUS_META[r.status]
  const body = (
    <>
      <h1>{r.title ?? KIND_META[r.kind].label}</h1>
      <p class="fb-when">
        {KIND_META[r.kind].label} · {r.createdAt.toISOString().slice(0, 10)}
      </p>
      <div class="fb-status">
        <strong>{statusLabel(r.status, r.kind)}</strong>
        <span class="fb-status-sub">{meta.sub}</span>
      </div>
      <p class="fb-said">{r.body}</p>
      {r.context && <p class="fb-said">{r.context}</p>}
      {found.attachments.length > 0 && (
        <div class="fb-shots">
          {found.attachments.map((_, i) => (
            <img src={`/feedback/${publicId}/photo/${i}`} alt="Screenshot the rider attached" loading="lazy" />
          ))}
        </div>
      )}
      {r.publicResponse && <p class="fb-response">{r.publicResponse}</p>}
      <p class="fb-after">
        <a class="linkbtn" href="/feedback/mine">
          Back to what you've sent
        </a>
      </p>
    </>
  ).toString()
  return c.html(page({ title: r.title ?? 'Your report', user: me, navKey: 'feedback', body }))
})

// --- The owner's queue -------------------------------------------------------

// A worklist, not a report. It answers one question — what needs a decision —
// and every control on it is a form that POSTs to the handler below, because a
// moderation surface that needs JavaScript is a moderation surface that stops
// working the day something else on the page throws.
//
// **Nothing here is rider-facing, so this is the one place `priority` is
// rendered.** A rider seeing "your bug is P3" is a support incident; see the
// column comment in schema.ts.

const STATE_FILTERS: (FeedbackState | 'all')[] = ['pending', 'published', 'declined', 'duplicate', 'spam', 'all']

const Field = ({ label, name, value, rows }: { label: string; name: string; value: string | null; rows?: number }) => (
  <label class="q-field">
    <span>{label}</span>
    <textarea name={name} rows={rows ?? 2}>
      {value ?? ''}
    </textarea>
  </label>
)

feedbackRoutes.get('/admin/feedback', requireManageRiders, async (c) => {
  const me = currentUser(c)
  const stateRaw = c.req.query('state') ?? 'pending'
  const kindRaw = c.req.query('kind') ?? ''
  const state =
    (STATE_FILTERS as string[]).includes(stateRaw) && stateRaw !== 'all' ? (stateRaw as FeedbackState) : undefined
  const kind = isKind(kindRaw) ? kindRaw : undefined

  const [rows, counts] = await Promise.all([listQueue({ state, kind }), queueCounts()])

  const body = (
    <>
      <h1>Feedback</h1>
      <nav class="q-filters">
        {STATE_FILTERS.map((s) => (
          <a
            class={`q-filter${(s === 'all' ? undefined : s) === state ? ' is-on' : ''}`}
            href={`/admin/feedback?state=${s}`}
          >
            {s === 'all' ? 'Everything' : s}
            {s !== 'all' && counts[s] ? <span class="q-count">{counts[s]}</span> : ''}
          </a>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p class="empty">Nothing here.</p>
      ) : (
        <ul class="q-list">
          {rows.map((r) => (
            <li class={`q-item is-${r.state}`}>
              <div class="q-head">
                <span class={`fb-kind is-${r.kind}`}>{r.kind}</span>
                <span class="q-id">#{r.id}</span>
                <span class="q-state">{r.state}</span>
                <span class="q-when">{r.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</span>
              </div>

              <div class="q-title">{r.title ?? '(no title)'}</div>
              <p class="fb-said">{r.body}</p>
              {r.context && (
                <p class="fb-said q-context">
                  <strong>When they last wanted it:</strong> {r.context}
                </p>
              )}

              <p class="q-facts">
                <strong>{r.authorName}</strong>
                {r.authorEmail ? ` · ${r.authorEmail}` : ''}
                {r.replyOk ? '' : ' · asked not to be contacted'}
                {r.area ? ` · ${areaLabel(r.area) ?? r.area}` : ''}
                {r.frequency ? ` · ${frequencyLabel(r.frequency) ?? r.frequency}` : ''}
                {r.impact ? ` · ${impactLabel(r.impact) ?? r.impact}` : ''}
                {r.shots ? ` · ${r.shots} photo${r.shots === 1 ? '' : 's'}` : ''}
                {r.duplicateOf ? ` · duplicate of #${r.duplicateOf}` : ''}
              </p>

              {r.shots > 0 && (
                <div class="fb-shots">
                  {Array.from({ length: r.shots }, (_, i) => (
                    <img src={`/feedback/${r.publicId}/photo/${i}`} alt="" loading="lazy" width="180" />
                  ))}
                </div>
              )}

              <details class="q-diag">
                <summary>What the browser was doing</summary>
                <p>
                  <a href={`/admin/feedback/${r.id}/diagnostics`}>Open the diagnostics</a>
                </p>
              </details>

              {/* Several small forms rather than one wide one, matching
                  `moderate()`, which writes only the fields it is given. One
                  form carrying every field would blank whatever the owner had
                  not retyped. */}
              <form class="q-actions" method="post" action={`/admin/feedback/${r.id}`}>
                <button type="submit" name="state" value="published">
                  Publish
                </button>
                <button type="submit" name="state" value="declined">
                  Decline
                </button>
                <button type="submit" name="state" value="spam">
                  Spam
                </button>
                <button type="submit" name="state" value="pending">
                  Back to pending
                </button>
              </form>

              <form class="q-set" method="post" action={`/admin/feedback/${r.id}`}>
                <label>
                  Status
                  <select name="status">
                    {feedbackStatusValues.map((s) => (
                      <option value={s} selected={s === r.status}>
                        {statusLabel(s, r.kind)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Kind
                  <select name="kind">
                    {KIND_ORDER.map((k) => (
                      <option value={k} selected={k === r.kind}>
                        {k}
                      </option>
                    ))}
                  </select>
                </label>
                {/* Owner-only. Never rendered on a rider-facing surface. */}
                <label>
                  Priority
                  <input type="number" name="priority" min="0" max="9" value={r.priority ?? ''} />
                </label>
                <label>
                  Duplicate of
                  <input type="number" name="duplicateOf" min="1" value={r.duplicateOf ?? ''} />
                </label>
                <button type="submit">Save</button>
              </form>

              <form class="q-text" method="post" action={`/admin/feedback/${r.id}`}>
                <label class="q-field">
                  <span>Title</span>
                  <input type="text" name="title" value={r.title ?? ''} maxlength={150} />
                </label>
                <Field label="Private note" name="ownerNote" value={r.ownerNote} />
                <Field
                  label="Public response — shown to the rider, and on the board once published"
                  name="publicResponse"
                  value={r.publicResponse}
                  rows={3}
                />
                <button type="submit">Save</button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </>
  ).toString()

  return c.html(page({ title: 'Feedback', user: me, navKey: 'admin', bodyClass: 'queue-page', body }))
})

/**
 * The stored diagnostics for one report.
 *
 * Its own page rather than inline in the queue: the blob is 5–50 KB and
 * rendering forty of them would make the worklist unusable, which is the same
 * reason it is a separate table. Read through parseDiagnostics, never a cast —
 * the column is jsonb and Postgres has validated nothing about its shape.
 */
feedbackRoutes.get('/admin/feedback/:id/diagnostics', requireManageRiders, async (c) => {
  const me = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.notFound()
  const report = await getById(id)
  if (!report) return c.notFound()

  const diag = parseDiagnostics(await getDiagnostics(id))
  const body = (
    <>
      <h1>Report #{id}</h1>
      <p>
        <a href="/admin/feedback">Back to the queue</a>
      </p>
      <pre class="q-json">{JSON.stringify(diag, null, 2)}</pre>
    </>
  ).toString()
  return c.html(page({ title: `Diagnostics #${id}`, user: me, navKey: 'admin', bodyClass: 'queue-page', body }))
})

feedbackRoutes.post('/admin/feedback/:id', requireManageRiders, requireSameOrigin, async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.notFound()

  const raw = (await c.req.parseBody({ all: true })) as Body
  const back = c.req.header('Referer')?.startsWith(APP_ORIGIN) ? c.req.header('Referer')! : '/admin/feedback'

  const m: Moderation = {}

  const state = one(raw.state)
  if (isState(state)) m.state = state

  const status = one(raw.status)
  if (isStatus(status)) m.status = status

  const kind = one(raw.kind)
  if (isKind(kind)) m.kind = kind

  // Present-but-empty clears the value; absent leaves it alone. That distinction
  // is why these read the raw key rather than the coerced string — `''` and
  // undefined mean different things here and collapsing them would make a
  // priority impossible to unset.
  if ('priority' in raw) {
    const n = Number(one(raw.priority))
    m.priority = one(raw.priority) === '' ? null : Number.isInteger(n) && n >= 0 && n <= 9 ? n : null
  }
  if ('duplicateOf' in raw) {
    const n = Number(one(raw.duplicateOf))
    // A report cannot be a duplicate of itself. The self-referencing foreign key
    // would happily accept it and every reader would then have a cycle.
    m.duplicateOf = one(raw.duplicateOf) === '' || !Number.isInteger(n) || n <= 0 || n === id ? null : n
  }
  if ('title' in raw) m.title = one(raw.title)
  if ('ownerNote' in raw) m.ownerNote = one(raw.ownerNote)
  if ('publicResponse' in raw) m.publicResponse = one(raw.publicResponse)

  // 'not_doing' without a reason is worse than no answer at all — it is the one
  // status whose whole content is the explanation. STATUS_META says so in its
  // sub-line; this is what makes the copy true.
  if (m.status === 'not_doing') {
    const existing = await getById(id)
    const reason = m.publicResponse ?? existing?.publicResponse ?? ''
    if (!reason.trim()) {
      return c.redirect(`${back}${back.includes('?') ? '&' : '?'}err=reason`, 302)
    }
  }

  const updated = await moderate(id, m)
  if (!updated) return c.notFound()
  return c.redirect(back, 302)
})

// --- The public board --------------------------------------------------------

// Published ideas, and the one surface where riders see each other's.
//
// **Signed in only.** An anonymous board on an invite-only beta is a scraping
// target with no upside, which is the same reasoning already applied to /riders.
// requireActive, not requireAuth: a pending rider has a valid session and no
// business here yet.
//
// What it deliberately does NOT show: bugs, in any state. A published bug is a
// known-issue banner rather than something to vote on, and mixing the two would
// turn a wishlist into a defect tracker in front of the exact audience you want
// believing the product works.

const BOARD_SORTS: { id: BoardSort; label: string }[] = [
  { id: 'wanted', label: 'Most wanted' },
  { id: 'new', label: 'Newest' },
]

const WantButton = ({
  row,
  viewer,
  wanted,
}: {
  row: BoardRow
  viewer: ReturnType<typeof currentUser>
  wanted: boolean
}) => {
  const me = { id: viewer.id, status: viewer.status, canManageRiders: viewer.canManageRiders }
  const allowed = canWant({ authorId: row.authorId, kind: row.kind, state: 'published' }, me)
  const count = row.wantCount === 1 ? '1 rider wants this' : `${row.wantCount} riders want this`

  // The author's own idea, whose want was auto-cast at publish. Shown as a fact
  // rather than a disabled button — a greyed control invites a click and then
  // explains nothing.
  if (!allowed) return <span class="b-count">{count}</span>

  // Whether this rider has already wanted it is rendered HERE, by the server,
  // rather than reconciled on the client from a list of ids. The client only has
  // the public id and the vote rows are keyed by the numeric one, so any
  // client-side matching would need a second mapping that exists purely to be
  // kept in sync.
  return (
    <form class={`b-want${wanted ? ' is-wanted' : ''}`} method="post" action={`/board/${row.publicId}/want`} data-want>
      {/* A real form, so the button works with no JavaScript. feedback.js
          intercepts the submit and swaps the count in place; without it the
          POST redirects back to the board, which is slower and still correct. */}
      <button type="submit" aria-pressed={wanted ? 'true' : 'false'}>
        <span class="b-want-label">{wanted ? 'You want this' : 'I want this'}</span>
        <span class="b-count">{count}</span>
      </button>
    </form>
  )
}

const BoardCard = ({
  row,
  viewer,
  wanted,
}: {
  row: BoardRow
  viewer: ReturnType<typeof currentUser>
  wanted: boolean
}) => {
  const meta = STATUS_META[row.status]
  return (
    <li class={`b-card is-${row.status}`}>
      <div class="b-title">{row.title ?? row.body.slice(0, 80)}</div>
      <p class="b-body">{row.body}</p>
      <div class="fb-status">
        <strong>{statusLabel(row.status, row.kind)}</strong>
        <span class="fb-status-sub">{meta.sub}</span>
      </div>
      {row.publicResponse && <p class="fb-response">{row.publicResponse}</p>}
      <div class="b-foot">
        <span class="b-who">{row.authorName}</span>
        <WantButton row={row} viewer={viewer} wanted={wanted} />
      </div>
    </li>
  )
}

feedbackRoutes.get('/board', requireActive, async (c) => {
  const me = currentUser(c)
  const sortRaw = c.req.query('sort') ?? 'wanted'
  const sort: BoardSort = sortRaw === 'new' ? 'new' : 'wanted'

  const [rows, shipped] = await Promise.all([listBoard(sort), listShipped()])
  // One query for every button's state rather than one per card.
  const mine = await wantedBy(
    me.id,
    rows.map((r) => r.id),
  )

  const body = (
    <>
      <h1>The idea board</h1>
      <p class="lede">Every idea here came from a rider. Tell us the ones you want and they move up the list.</p>

      {/* Permanent, and first. See listShipped(). */}
      {shipped.length > 0 && (
        <section class="b-shipped">
          <h2>Recently shipped</h2>
          <ul>
            {shipped.map((r) => (
              <li>
                <strong>{r.title ?? r.body.slice(0, 80)}</strong>
                {r.publicResponse ? ` — ${r.publicResponse}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      <nav class="b-sorts">
        {BOARD_SORTS.map((s) => (
          <a class={`q-filter${s.id === sort ? ' is-on' : ''}`} href={`/board?sort=${s.id}`}>
            {s.label}
          </a>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p class="empty">
          Nothing on the board yet. <a href="/feedback?kind=idea">Be the first</a>.
        </p>
      ) : (
        <ul class="b-list">
          {rows.map((r) => (
            <BoardCard row={r} viewer={me} wanted={mine.has(r.id)} />
          ))}
        </ul>
      )}
      <p class="fb-after">
        <a class="btn" href="/feedback?kind=idea">
          Add an idea
        </a>
      </p>
    </>
  ).toString()

  return c.html(
    page({
      title: 'The idea board',
      user: me,
      navKey: 'board',
      body,
      scripts: `<script src="${asset('/js/feedback.js')}" defer></script>`,
    }),
  )
})

/**
 * Cast or withdraw a want.
 *
 * `requireActiveApi` rather than `requireActive`: feedback.js calls this with
 * fetch() and wants a 403, not a redirect to an HTML page it would then try to
 * parse as JSON.
 *
 * Idempotent by construction — the service reads the delete's row count instead
 * of asking first, so two taps racing cannot both insert. The response carries
 * the count AS STORED so the client never has to guess what to render.
 */
feedbackRoutes.post('/board/:publicId/want', requireActiveApi, requireSameOrigin, async (c) => {
  const me = currentUser(c)
  const found = await getByPublicId(c.req.param('publicId'))
  if (!found) return c.json({ error: 'not found' }, 404)

  const report = found.report
  if (!canWant({ authorId: report.authorId, kind: report.kind, state: report.state }, me)) {
    // 403 rather than 404: the report is published and the viewer can see it,
    // so pretending it does not exist would be a lie they can disprove by
    // scrolling. This is genuinely "no", not "what".
    return c.json({ error: 'cannot want this' }, 403)
  }

  const result = await toggleWant(report.id, me.id)

  // A form POST with no JavaScript lands here too, and it wants the board back
  // rather than a JSON body rendered as text.
  if (!c.req.header('Accept')?.includes('application/json')) {
    return c.redirect('/board', 302)
  }
  return c.json(result)
})
