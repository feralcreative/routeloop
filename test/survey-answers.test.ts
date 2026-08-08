// The two parsers, and the reason there are two.
//
// survey_responses.answers is jsonb with a `.$type<SurveyAnswers>()` on it, and
// that type is a claim the compiler makes which Postgres has never checked.
// Every row read back is unvalidated input that happens to have come from our
// own database. The failure this file exists to catch is the one that only shows
// up later: a question renamed in a sprint, a rider reopening a draft written
// before it, and either a crash or a silently wrong answer.
//
// parseAnswers must never throw and must never lose good data.
// validateSubmission must never let a half-finished form through, and must never
// block a draft.
//
// The bundle ids used here are read from BUNDLES rather than hardcoded, so this
// file keeps working when the question set changes — which is exactly the event
// it is meant to survive.
import { describe, expect, it } from 'vitest'
import {
  BUNDLES,
  BUNDLE_IDS,
  CHOICE_QUESTIONS,
  EMPTY_ANSWERS,
  MAX_RATING,
  OPEN_MAX,
  OPEN_QUESTIONS,
  SECTIONS,
  TOP_PICKS,
  parseAnswers,
  validateSubmission,
} from '../src/survey/questions'
import type { SurveyAnswers } from '../src/survey/questions'

const B = BUNDLE_IDS
const REQUIRED_CHOICES = CHOICE_QUESTIONS.filter((q) => q.required)

/** A complete, valid submission, built from the live question set. */
function goodAnswers(): SurveyAnswers {
  const a: SurveyAnswers = { ratings: {}, top: [], single: {}, multi: {}, open: {} }
  for (const b of BUNDLES) a.ratings[b.id] = 2
  a.top = B.slice(0, TOP_PICKS)
  for (const q of REQUIRED_CHOICES) {
    if (q.multi) a.multi[q.id] = [q.options[0]]
    else a.single[q.id] = q.options[0]
  }
  return a
}

describe('the question set itself', () => {
  it('has unique bundle ids', () => {
    expect(new Set(B).size).toBe(B.length)
  })

  it('has unique question ids across choice and open questions', () => {
    const ids = [...CHOICE_QUESTIONS.map((q) => q.id), ...OPEN_QUESTIONS.map((q) => q.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })

  // A bundle in no section renders nowhere, which is invisible in review and
  // means a question silently never gets asked.
  it('puts every bundle in a real section', () => {
    const sections = new Set(SECTIONS.map((s) => s.id))
    const orphans = BUNDLES.filter((b) => !sections.has(b.section)).map((b) => b.id)
    expect(orphans, `bundles in no section: ${orphans.join(', ')}`).toEqual([])
  })

  it('leaves no section empty', () => {
    const used = new Set(BUNDLES.map((b) => b.section))
    const empty = SECTIONS.filter((s) => !used.has(s.id)).map((s) => s.id)
    expect(empty, `sections with no bundles: ${empty.join(', ')}`).toEqual([])
  })

  it('has enough bundles to fill the top picks', () => {
    expect(B.length).toBeGreaterThan(TOP_PICKS)
  })

  it('gives every choice question at least two options', () => {
    for (const q of CHOICE_QUESTIONS) expect(q.options.length, `${q.id} has too few options`).toBeGreaterThan(1)
  })

  // The survey is blind on purpose. If a label ever says which side of the line
  // a feature is on, the answers stop being about what riders want and become
  // politeness about finished work.
  //
  // Phrases, not words. "a route you already have" is about the rider's own
  // file and is fine; "already built" is the leak. A bare-word list flags the
  // first and is the kind of test people delete rather than fix.
  it('never tells the rider what is built and what is not', () => {
    const banned = [
      /\balready (built|works|shipped|there|exists|done)\b/i,
      /\b(coming soon|not yet built|on the roadmap|in development)\b/i,
      /\b(currently|today) (supported|available|possible)\b/i,
      /\b(planned|unbuilt|shipped|existing) (feature|today)\b/i,
    ]
    for (const b of BUNDLES) {
      const hit = banned.find((re) => re.test(b.label))
      expect(hit, `"${b.label}" leaks build status via ${hit}`).toBeUndefined()
    }
  })
})

describe('parseAnswers', () => {
  it('returns empty answers for junk rather than throwing', () => {
    for (const junk of [null, undefined, 0, 'nope', [], { ratings: 'no' }, { top: 'no' }]) {
      expect(parseAnswers(junk)).toEqual(EMPTY_ANSWERS)
    }
  })

  it('keeps good data intact', () => {
    const a = goodAnswers()
    expect(parseAnswers(a)).toEqual(a)
  })

  // The version-skew case, and the reason this function is lenient. A draft
  // written before a bundle was renamed must still open.
  it('drops ratings for bundles that no longer exist and keeps the rest', () => {
    const out = parseAnswers({ ratings: { [B[0]]: 3, 'bundle-deleted-last-sprint': 2 } })
    expect(out.ratings).toEqual({ [B[0]]: 3 })
  })

  it('drops unknown ids out of the top picks without shortening the valid ones', () => {
    const out = parseAnswers({ top: [B[0], 'gone', B[1]] })
    expect(out.top).toEqual([B[0], B[1]])
  })

  it('clamps out-of-range ratings instead of discarding the row', () => {
    const out = parseAnswers({ ratings: { [B[0]]: 99, [B[1]]: -4, [B[2]]: 1.6 } })
    expect(out.ratings[B[0]]).toBe(MAX_RATING)
    expect(out.ratings[B[1]]).toBe(0)
    expect(out.ratings[B[2]]).toBe(2)
  })

  it('drops non-numeric ratings', () => {
    expect(parseAnswers({ ratings: { [B[0]]: 'three' } }).ratings).toEqual({})
  })

  // A duplicate would be counted twice by the weighted score, which is the only
  // way a bad row skews the result rather than merely looking untidy.
  it('dedupes the top picks', () => {
    expect(parseAnswers({ top: [B[0], B[0], B[1]] }).top).toEqual([B[0], B[1]])
  })

  it('caps the top picks at the limit', () => {
    expect(parseAnswers({ top: B.slice(0, TOP_PICKS + 4) }).top).toHaveLength(TOP_PICKS)
  })

  it('drops choice answers that are no longer offered', () => {
    const q = REQUIRED_CHOICES.find((x) => !x.multi)
    if (!q) return
    expect(parseAnswers({ single: { [q.id]: 'an option removed last sprint' } }).single).toEqual({})
    expect(parseAnswers({ single: { [q.id]: q.options[1] } }).single).toEqual({ [q.id]: q.options[1] })
  })

  it('filters a multi answer down to the options that still exist', () => {
    const q = REQUIRED_CHOICES.find((x) => x.multi)
    if (!q) return
    const out = parseAnswers({ multi: { [q.id]: [q.options[0], 'gone', q.options[1]] } })
    expect(out.multi[q.id]).toEqual([q.options[0], q.options[1]])
  })

  it('does not let a single-choice answer arrive through the multi map', () => {
    const single = REQUIRED_CHOICES.find((x) => !x.multi)
    if (!single) return
    expect(parseAnswers({ multi: { [single.id]: [single.options[0]] } }).multi).toEqual({})
  })

  it('trims and truncates open text', () => {
    const id = OPEN_QUESTIONS[0].id
    expect(parseAnswers({ open: { [id]: '  hello  ' } }).open[id]).toBe('hello')
    expect(parseAnswers({ open: { [id]: 'x'.repeat(OPEN_MAX + 500) } }).open[id]).toHaveLength(OPEN_MAX)
  })

  it('drops open answers that are only whitespace', () => {
    expect(parseAnswers({ open: { [OPEN_QUESTIONS[0].id]: '   ' } }).open).toEqual({})
  })

  // Prototype pollution through a jsonb column would be an odd route in, but the
  // column is written from a form and read straight into an object literal.
  //
  // Checked with hasOwn, not property access: `x.__proto__` returns the
  // prototype for every object alive and would pass a `toBeUndefined()` for no
  // reason at all. Own keys are the question.
  it('ignores a __proto__ key', () => {
    const out = parseAnswers(JSON.parse('{"ratings":{"__proto__":3},"top":["__proto__"]}'))
    expect(Object.hasOwn(out.ratings, '__proto__')).toBe(false)
    expect(Object.keys(out.ratings)).toEqual([])
    expect(out.top).toEqual([])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('validateSubmission', () => {
  it('passes a complete response', () => {
    expect(validateSubmission(goodAnswers())).toEqual({})
  })

  it('rejects an empty response', () => {
    expect(Object.keys(validateSubmission(EMPTY_ANSWERS)).length).toBeGreaterThan(0)
  })

  it('names every unrated bundle so the form can mark each row', () => {
    const a = goodAnswers()
    delete a.ratings[B[3]]
    const errors = validateSubmission(a)
    expect(errors[`rating:${B[3]}`]).toBeDefined()
    expect(errors.ratings).toContain('1')
  })

  it.each([0, 1, TOP_PICKS - 1, TOP_PICKS + 1])('rejects %i top picks', (n) => {
    const a = goodAnswers()
    a.top = B.slice(0, n)
    expect(validateSubmission(a).top).toBeDefined()
  })

  it(`accepts exactly ${TOP_PICKS}`, () => {
    expect(validateSubmission(goodAnswers()).top).toBeUndefined()
  })

  // Only reachable from a hand-built POST, since parseAnswers dedupes — but the
  // message has to be real rather than a silent truncation to four.
  it('rejects duplicate top picks', () => {
    const a = goodAnswers()
    a.top = [B[0], B[0], B[1], B[2], B[3]]
    expect(validateSubmission(a).top).toContain('different')
  })

  it('requires every required choice question', () => {
    for (const q of REQUIRED_CHOICES) {
      const a = goodAnswers()
      delete a.single[q.id]
      delete a.multi[q.id]
      expect(validateSubmission(a)[q.id], `${q.id} was not required`).toBeDefined()
    }
  })

  it('treats an empty multi array as unanswered', () => {
    const q = REQUIRED_CHOICES.find((x) => x.multi)
    if (!q) return
    const a = goodAnswers()
    a.multi[q.id] = []
    expect(validateSubmission(a)[q.id]).toBeDefined()
  })

  it('does not require the optional questions', () => {
    const a = goodAnswers()
    const errors = validateSubmission(a)
    for (const q of CHOICE_QUESTIONS.filter((x) => !x.required)) expect(errors[q.id]).toBeUndefined()
    for (const q of OPEN_QUESTIONS.filter((x) => !x.required)) expect(errors[q.id]).toBeUndefined()
  })

  // Drafts do not come through here at all. Stated as a test because the whole
  // save-and-come-back flow breaks the moment someone wires the draft path into
  // this function.
  it('is not used by drafts: a half-finished form is invalid but still savable', () => {
    const half: SurveyAnswers = { ...EMPTY_ANSWERS, ratings: { [B[0]]: 3 } }
    expect(Object.keys(validateSubmission(half)).length).toBeGreaterThan(0)
    expect(parseAnswers(half)).toEqual(half)
  })
})
