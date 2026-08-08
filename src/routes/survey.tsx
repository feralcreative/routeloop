// The Rider Survey, and the page that reads it back.
//
// A long form with no client JavaScript, which is a constraint worth stating
// because two decisions fall straight out of it.
//
// The five must-have picks are five ordered <select> elements, not a checkbox
// group with a shared name. Partly because `parseBody()` collapses repeated
// field names — a checkbox group would silently yield one value and look like a
// validation bug — but mostly because the ORDER is real information a rider
// gave deliberately, and a set throws it away. Selects also enforce "exactly
// five" with no script at all.
//
// And there are two submit buttons on one form. `action=draft` skips validation
// and leaves submitted_at null; `action=submit` runs the strict pass. A rider
// part-way through 34 questions must be able to come back tomorrow, and doing
// that without a draft state would need localStorage, a scheduler, or both.
import { Hono } from 'hono'
import { desc, eq, isNotNull } from 'drizzle-orm'
import { db } from '../db/index'
import { surveyResponses, users } from '../db/schema'
import { currentUser, requireManageRiders, requireSameOrigin, requireSurvey, type AuthEnv } from '../auth/middleware'
import { page } from '../views/layout'
import {
  BUNDLES,
  CHOICE_QUESTIONS,
  EMPTY_ANSWERS,
  OPEN_MAX,
  OPEN_QUESTIONS,
  RATINGS,
  SECTIONS,
  SURVEY_VERSION,
  TOP_PICKS,
  bundleLabel,
  bundlesIn,
  parseAnswers,
  validateSubmission,
} from '../survey/questions'
import type { SurveyAnswers } from '../survey/questions'
import { choiceTally, histogram, openAnswers, rankBundles, summaryLine } from '../survey/score'
import { surveyCsv } from '../survey/csv'

export const surveyRoutes = new Hono<AuthEnv>()

// --- Body parsing ------------------------------------------------------------

// parseBody({ all: true }) gives arrays for repeated names, which the
// multi-choice checkbox groups need. Everything below normalizes back down,
// because a field that is sometimes a string and sometimes an array is the
// shape that produces "why is my answer the letter G" bugs.
export type Body = Record<string, string | File | (string | File)[]>

const one = (v: Body[string] | undefined): string => {
  const x = Array.isArray(v) ? v[0] : v
  return typeof x === 'string' ? x : ''
}

const many = (v: Body[string] | undefined): string[] => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return typeof v === 'string' ? [v] : []
}

/**
 * Form body to answers.
 *
 * Deliberately does no validating of its own — it shapes, and parseAnswers()
 * decides what is real. One place makes that judgement, and it is the same place
 * that judges a row coming back out of the database.
 */
export function answersFromBody(body: Body): SurveyAnswers {
  const raw: Record<string, unknown> = {
    // The empty string is filtered BEFORE Number() touches it, and that order is
    // the whole point: `Number('')` is 0, not NaN, so a question nobody answered
    // would arrive as a considered "Don't care". Unanswered has to stay absent —
    // absent is what validateSubmission refuses to submit and what keeps an
    // abandoned draft out of the mean.
    ratings: Object.fromEntries(
      BUNDLES.map((b) => [b.id, one(body[`rating:${b.id}`])] as const)
        .filter(([, s]) => s !== '')
        .map(([id, s]) => [id, Number(s)] as const)
        .filter(([, n]) => Number.isFinite(n)),
    ),
    top: Array.from({ length: TOP_PICKS }, (_, i) => one(body[`top${i + 1}`])).filter(Boolean),
    single: Object.fromEntries(
      CHOICE_QUESTIONS.filter((q) => !q.multi).map((q) => [q.id, one(body[`single:${q.id}`])]),
    ),
    multi: Object.fromEntries(CHOICE_QUESTIONS.filter((q) => q.multi).map((q) => [q.id, many(body[`multi:${q.id}`])])),
    open: Object.fromEntries(OPEN_QUESTIONS.map((q) => [q.id, one(body[`open:${q.id}`])])),
  }
  return parseAnswers(raw)
}

// --- The form ----------------------------------------------------------------

type FormArgs = {
  answers: SurveyAnswers
  errors?: Record<string, string>
  saved?: boolean
  welcome?: boolean
}

function RatingRow({ id, label, value, invalid }: { id: string; label: string; value?: number; invalid: boolean }) {
  return (
    <div class={`rate-row${invalid ? ' has-error' : ''}`} role="group" aria-label={label}>
      <div class="rate-label">{label}</div>
      <div class="rate-strip">
        {RATINGS.map((r) => (
          <label class={`rate-opt rate-${r.tone}`}>
            <input type="radio" name={`rating:${id}`} value={String(r.value)} checked={value === r.value} />
            <span>{r.label}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

function SurveyForm({ answers, errors, saved, welcome }: FormArgs) {
  const e = errors ?? {}
  const bad = Object.keys(e).length > 0

  return (
    <>
      <h1>The rider survey</h1>
      <p class="lede">
        I am building Tankbag on my own judgement about what a trip needs, and my judgement is one rider’s. This is
        how I find out where it is wrong. Everything below is genuinely undecided—the parts I have already made my
        mind up about are not on the list, because asking about those would waste the only 5 minutes you owe me.
      </p>

      {welcome && <p class="notice">You’re in. Thanks for doing this.</p>}
      {saved && <p class="notice">Saved. Come back whenever—this page remembers where you got to.</p>}
      {bad && (
        <p class="notice is-error">
          {e.ratings ? `${e.ratings}. ` : ''}
          {e.top ? `${e.top} for your must-haves. ` : ''}
          Everything you typed is still here.
        </p>
      )}

      <form class="survey-form" method="post" action="/survey">
        {SECTIONS.map((s) => (
          <fieldset class="survey-section">
            <legend>{s.title}</legend>
            <p class="field-hint section-blurb">{s.blurb}</p>
            {bundlesIn(s.id).map((b) => (
              <RatingRow
                id={b.id}
                label={b.label}
                value={answers.ratings[b.id]}
                invalid={Boolean(e[`rating:${b.id}`])}
              />
            ))}
          </fieldset>
        ))}

        <fieldset class="survey-section">
          <legend>The five that matter most</legend>
          <p class={`field-hint section-blurb${e.top ? ' has-error' : ''}`}>
            Out of everything above, the {TOP_PICKS} you would actually want, best first. This is the part that
            decides what I build—a rating says everything is nice, {TOP_PICKS} picks say what you would trade the
            rest for.
          </p>
          {Array.from({ length: TOP_PICKS }, (_, i) => (
            <p class="field">
              <label for={`f-top${i + 1}`}>{i === 0 ? 'Most of all' : `Then`}</label>
              <select id={`f-top${i + 1}`} name={`top${i + 1}`}>
                <option value="">—</option>
                {BUNDLES.map((b) => (
                  <option value={b.id} selected={answers.top[i] === b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </p>
          ))}
          {e.top && <span class="field-error">{e.top}</span>}
        </fieldset>

        <fieldset class="survey-section">
          <legend>How you ride</legend>
          {CHOICE_QUESTIONS.map((q) => (
            <div class={`field${e[q.id] ? ' has-error' : ''}`}>
              <span class="field-label">{q.label}</span>
              {q.hint && <span class="field-hint">{q.hint}</span>}
              <div class="opt-list">
                {q.options.map((opt) => (
                  <label class="check">
                    <input
                      type={q.multi ? 'checkbox' : 'radio'}
                      name={q.multi ? `multi:${q.id}` : `single:${q.id}`}
                      value={opt}
                      checked={q.multi ? (answers.multi[q.id] ?? []).includes(opt) : answers.single[q.id] === opt}
                    />
                    <span>{opt}</span>
                  </label>
                ))}
              </div>
              {e[q.id] && <span class="field-error">{e[q.id]}</span>}
            </div>
          ))}
        </fieldset>

        <fieldset class="survey-section">
          <legend>In your own words</legend>
          {OPEN_QUESTIONS.map((q) => (
            <p class={`field${e[q.id] ? ' has-error' : ''}`}>
              <label for={`f-${q.id}`}>{q.label}</label>
              {q.hint && <span class="field-hint">{q.hint}</span>}
              <textarea id={`f-${q.id}`} name={`open:${q.id}`} rows={4} maxlength={OPEN_MAX}>
                {answers.open[q.id] ?? ''}
              </textarea>
              {e[q.id] && <span class="field-error">{e[q.id]}</span>}
            </p>
          ))}
        </fieldset>

        <div class="survey-actions">
          <button class="btn" type="submit" name="action" value="submit">
            Send it
          </button>
          <button class="btn btn-quiet" type="submit" name="action" value="draft">
            Save and finish later
          </button>
        </div>
      </form>
    </>
  )
}

// --- Rider routes ------------------------------------------------------------

async function loadAnswers(userId: number): Promise<{ answers: SurveyAnswers; submittedAt: Date | null }> {
  const [row] = await db.select().from(surveyResponses).where(eq(surveyResponses.userId, userId)).limit(1)
  // parseAnswers, never a cast: the column is jsonb and Postgres has validated
  // nothing about what is in it.
  return { answers: row ? parseAnswers(row.answers) : EMPTY_ANSWERS, submittedAt: row?.submittedAt ?? null }
}

surveyRoutes.get('/survey', requireSurvey, async (c) => {
  const me = currentUser(c)
  const { answers, submittedAt } = await loadAnswers(me.id)

  // A submitted response is not locked — a rider who thinks of something better
  // an hour later should be able to say so, and a form that refuses is a form
  // people fill in defensively.
  const body = (
    <>
      {submittedAt && (
        <p class="notice">
          Sent on {submittedAt.toISOString().slice(0, 10)}. Change anything you like and send it again.
        </p>
      )}
      <SurveyForm answers={answers} saved={c.req.query('saved') === '1'} welcome={c.req.query('welcome') === '1'} />
    </>
  ).toString()

  return c.html(page({ title: 'Rider survey', user: me, navKey: 'survey', body }))
})

surveyRoutes.post('/survey', requireSurvey, requireSameOrigin, async (c) => {
  const me = currentUser(c)
  const body = (await c.req.parseBody({ all: true })) as Body
  const answers = answersFromBody(body)
  const submitting = one(body.action) === 'submit'

  const errors = submitting ? validateSubmission(answers) : {}
  if (Object.keys(errors).length > 0) {
    // Re-render with what they typed, at 400 — never a redirect, or the whole
    // form is lost. Same contract as profile.tsx.
    const html = (<SurveyForm answers={answers} errors={errors} />).toString()
    return c.html(page({ title: 'Rider survey', user: me, navKey: 'survey', body: html }), 400)
  }

  const now = new Date()
  await db
    .insert(surveyResponses)
    .values({
      userId: me.id,
      surveyVersion: SURVEY_VERSION,
      answers,
      submittedAt: submitting ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: surveyResponses.userId,
      set: {
        answers,
        surveyVersion: SURVEY_VERSION,
        updatedAt: now,
        // A draft save must not un-send an already-sent response. Only a submit
        // ever writes this, and re-submitting re-stamps it.
        ...(submitting ? { submittedAt: now } : {}),
      },
    })

  // Redirect rather than re-render so a refresh cannot resubmit.
  return c.redirect(submitting ? '/survey/thanks' : '/survey?saved=1', 302)
})

surveyRoutes.get('/survey/thanks', requireSurvey, (c) => {
  const me = currentUser(c)
  const body = (
    <>
      <h1>Got it. Thank you.</h1>
      <p class="lede">
        That is genuinely useful. If you said something worth a longer conversation I will come find you.
      </p>
      <p>
        <a class="btn" href="/survey">
          Change an answer
        </a>{' '}
        <a class="linkbtn" href="/">
          Back to Tankbag
        </a>
      </p>
    </>
  ).toString()
  return c.html(page({ title: 'Thanks', user: me, navKey: 'survey', body }))
})

// --- Admin -------------------------------------------------------------------

type LoadedResponse = {
  email: string
  displayName: string
  status: string
  submittedAt: Date | null
  answers: SurveyAnswers
}

async function loadAll(submittedOnly: boolean): Promise<LoadedResponse[]> {
  const rows = await db
    .select({
      email: users.email,
      displayName: users.displayName,
      status: users.status,
      submittedAt: surveyResponses.submittedAt,
      answers: surveyResponses.answers,
    })
    .from(surveyResponses)
    .innerJoin(users, eq(users.id, surveyResponses.userId))
    .where(submittedOnly ? isNotNull(surveyResponses.submittedAt) : undefined)
    .orderBy(desc(surveyResponses.submittedAt))

  return rows.map((r) => ({
    email: r.email ?? '',
    displayName: r.displayName,
    status: r.status,
    submittedAt: r.submittedAt,
    answers: parseAnswers(r.answers),
  }))
}

const pct = (n: number): string => `${Math.round(n * 100)}%`

surveyRoutes.get('/admin/survey', requireManageRiders, async (c) => {
  const me = currentUser(c)
  // Drafts are excluded from the ranking on purpose: a half-finished form has
  // rated the top of the list and not the bottom, and counting it would make
  // "appeared early in the form" look like "riders wanted it".
  const submitted = await loadAll(true)
  const all = await loadAll(false)
  const answers = submitted.map((r) => r.answers)
  const ranked = rankBundles(answers)

  const body = (
    <>
      <h1>Rider survey</h1>
      <div class="sub">
        {summaryLine(answers)} · {all.length - submitted.length} still in draft ·{' '}
        <a href="/admin/survey.csv">download the CSV</a>
      </div>

      {submitted.length === 0 ? (
        <p class="empty">Nothing submitted yet.</p>
      ) : (
        <>
          <h2>What riders want, most first</h2>
          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Feature</th>
                  <th>Score</th>
                  <th>Mean</th>
                  <th>In someone’s five</th>
                  <th>Spread</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((r, i) => {
                  const h = histogram(answers, r.id)
                  return (
                    <tr>
                      <td class="num">{i + 1}</td>
                      <td>{r.label}</td>
                      <td class="num">{r.score.toFixed(2)}</td>
                      <td class="num">{r.n === 0 ? '—' : r.mean.toFixed(2)}</td>
                      <td class="num">{r.topPicks}</td>
                      {/* The bar the mean cannot draw: a room split between
                          "must have" and "don't care" is a feature for a subset,
                          not a middling feature. */}
                      <td>
                        {/* Same three tones as the form, so a bar the reader
                            saw as green when they answered still reads green
                            here. */}
                        <span class="spread" title={RATINGS.map((x, k) => `${x.label}: ${h[k]}`).join(', ')}>
                          {h.map((n, k) => (
                            <span class={`rate-${RATINGS[k]?.tone ?? 'no'}`} style={`flex:${n}`}></span>
                          ))}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <h2>How they ride</h2>
          {CHOICE_QUESTIONS.map((q) => {
            const rows = choiceTally(answers, q.id)
            return (
              <div class="tally">
                <h3>{q.label}</h3>
                {rows.length === 0 ? (
                  <p class="empty">No answers.</p>
                ) : (
                  <ul class="tally-list">
                    {rows.map((t) => (
                      <li>
                        <span class="tally-bar" style={`width:${Math.round(t.share * 100)}%`}></span>
                        {/*
                          A spaced EN dash, not a tight em dash. This separates a
                          label from a count rather than joining two clauses, and
                          "Google Maps—3 (62%)" reads as a compound. The style
                          rule allows exactly this substitution where a line needs
                          air.
                        */}
                        <span class="tally-label">
                          {t.option} – {t.n} ({pct(t.share)})
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}

          <h2>In their own words</h2>
          {OPEN_QUESTIONS.map((q) => {
            const said = openAnswers(answers, q.id)
            return (
              <div class="tally">
                <h3>{q.label}</h3>
                {said.length === 0 ? (
                  <p class="empty">Nobody answered this.</p>
                ) : (
                  <ul class="quote-list">
                    {said.map((s) => (
                      <li>{s}</li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}

          <h2>Who answered</h2>
          <ul class="cards">
            {submitted.map((r) => (
              <li class="rider">
                <div class="rider-main">
                  <div class="rider-name">{r.displayName}</div>
                  <div class="rider-email">{r.email}</div>
                  <div class="rider-meta">
                    sent {r.submittedAt ? r.submittedAt.toISOString().slice(0, 10) : '—'} · top pick:{' '}
                    {r.answers.top[0] ? bundleLabel(r.answers.top[0]) : '—'}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  ).toString()

  return c.html(page({ title: 'Rider survey', user: me, navKey: 'survey', body }))
})

surveyRoutes.get('/admin/survey.csv', requireManageRiders, async (c) => {
  // Drafts included here, unlike the ranking: the CSV is the raw material and
  // the person reading it can filter on the submitted-at column.
  const rows = await loadAll(false)
  return new Response(surveyCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'attachment; filename="tankbag-rider-survey.csv"',
    },
  })
})
