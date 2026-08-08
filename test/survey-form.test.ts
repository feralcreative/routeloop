// Form body to answers.
//
// This file exists because of one bug, caught by walking the form in a browser
// and not by any of the other three survey test files.
//
// An unanswered rating arrives as the empty string. `Number('')` is 0, not NaN,
// so the first version of answersFromBody() turned every question a rider had
// not reached into a considered "Don't care" — a full set of answers nobody
// gave. Nothing about that fails loudly: validateSubmission() sees 34 ratings
// and passes, the row saves, and the ranking is computed over invented data. The
// only symptom is a survey that quietly says everything is unimportant.
//
// Same shape as roadbook.test.ts: the pure function is lifted out of the handler
// and tested there, because nothing in this repo can exercise a route.
import { describe, expect, it } from 'vitest'
import { BUNDLE_IDS, CHOICE_QUESTIONS, OPEN_QUESTIONS, TOP_PICKS } from '../src/survey/questions'
import { answersFromBody } from '../src/routes/survey'
import type { Body } from '../src/routes/survey'

const B = BUNDLE_IDS

/** What a browser actually posts for a form nobody touched: every named control
 *  present, every value empty. Radios are the exception — an unchecked radio
 *  group sends NOTHING — which is why both shapes are tested below. */
const emptyBody = (): Body => {
  const b: Body = {}
  for (const q of CHOICE_QUESTIONS) b[q.multi ? `multi:${q.id}` : `single:${q.id}`] = ''
  for (const q of OPEN_QUESTIONS) b[`open:${q.id}`] = ''
  for (let i = 1; i <= TOP_PICKS; i++) b[`top${i}`] = ''
  return b
}

describe('answersFromBody — the empty-string trap', () => {
  // THE regression. If this fails, every unanswered question is being recorded
  // as a real answer.
  it('does not turn an unanswered rating into "Don\'t care"', () => {
    const out = answersFromBody({ ...emptyBody(), [`rating:${B[0]}`]: '' })
    expect(Object.keys(out.ratings)).toEqual([])
    expect(out.ratings[B[0]]).toBeUndefined()
  })

  it('treats an absent radio group as unanswered, not as zero', () => {
    // An unchecked radio group is simply not in the body at all.
    const out = answersFromBody(emptyBody())
    expect(out.ratings).toEqual({})
  })

  // And the other half: 0 is a real answer a rider can give, and it must survive.
  it('keeps a deliberate "Don\'t care"', () => {
    const out = answersFromBody({ ...emptyBody(), [`rating:${B[0]}`]: '0' })
    expect(out.ratings[B[0]]).toBe(0)
  })

  it('keeps the whole scale', () => {
    const body = emptyBody()
    for (const [i, id] of B.slice(0, 4).entries()) body[`rating:${id}`] = String(i)
    const out = answersFromBody(body)
    expect(out.ratings[B[0]]).toBe(0)
    expect(out.ratings[B[3]]).toBe(3)
  })

  it('drops a rating that is not a number', () => {
    expect(answersFromBody({ ...emptyBody(), [`rating:${B[0]}`]: 'three' }).ratings).toEqual({})
  })
})

describe('answersFromBody — the rest of the form', () => {
  it('reads the ordered top picks and drops the empty slots', () => {
    const out = answersFromBody({ ...emptyBody(), top1: B[2], top2: '', top3: B[0] })
    // Order is preserved and the gap closes; "exactly five" is validateSubmission's
    // job, not this one's.
    expect(out.top).toEqual([B[2], B[0]])
  })

  it('reads a repeated checkbox name as every value', () => {
    const q = CHOICE_QUESTIONS.find((x) => x.multi)
    if (!q) return
    const out = answersFromBody({ ...emptyBody(), [`multi:${q.id}`]: [q.options[0], q.options[2]] })
    expect(out.multi[q.id]).toEqual([q.options[0], q.options[2]])
  })

  // parseBody() without { all: true } collapses a repeated name to one value.
  // If the route ever loses that option this is what catches it.
  it('still reads a single-value multi answer', () => {
    const q = CHOICE_QUESTIONS.find((x) => x.multi)
    if (!q) return
    expect(answersFromBody({ ...emptyBody(), [`multi:${q.id}`]: q.options[1] }).multi[q.id]).toEqual([q.options[1]])
  })

  it('drops an empty multi answer rather than storing an empty array', () => {
    const q = CHOICE_QUESTIONS.find((x) => x.multi)
    if (!q) return
    expect(answersFromBody(emptyBody()).multi[q.id]).toBeUndefined()
  })

  it('reads a single-choice answer', () => {
    const q = CHOICE_QUESTIONS.find((x) => !x.multi)
    if (!q) return
    expect(answersFromBody({ ...emptyBody(), [`single:${q.id}`]: q.options[1] }).single[q.id]).toBe(q.options[1])
  })

  it('reads open text and drops the blanks', () => {
    const [a, b] = OPEN_QUESTIONS
    const out = answersFromBody({ ...emptyBody(), [`open:${a.id}`]: 'the GPS rerouted me', ...(b ? { [`open:${b.id}`]: '   ' } : {}) })
    expect(out.open[a.id]).toBe('the GPS rerouted me')
    if (b) expect(out.open[b.id]).toBeUndefined()
  })

  // A file in a text field is not a realistic form submission, but parseBody's
  // type says it can happen and a String(File) would store "[object File]".
  it('ignores a File where a string belongs', () => {
    const f = new File(['x'], 'x.txt')
    expect(answersFromBody({ ...emptyBody(), [`rating:${B[0]}`]: f, top1: f }).ratings).toEqual({})
    expect(answersFromBody({ ...emptyBody(), top1: f }).top).toEqual([])
  })

  it('produces empty answers from an empty body', () => {
    expect(answersFromBody({})).toEqual({ ratings: {}, top: [], single: {}, multi: {}, open: {} })
  })
})
