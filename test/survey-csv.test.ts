// The CSV the owner actually opens.
//
// Two failure modes, and neither is visible in review.
//
// The first is formula injection. Free-text answers land in a spreadsheet on the
// machine of the person who ran the survey, and a cell starting `=`, `+`, `-` or
// `@` is a formula to Excel, Numbers and LibreOffice alike. This is not only an
// attack: "+1 for offline maps" and "-1 star" are ordinary things to write and
// both are formulas. src/maps/export.ts deliberately does NOT do this
// neutralization — round-trip fidelity forbids it there — so the two escapers
// look alike and must stay separate. A test that catches them being merged is
// most of the point of this file.
//
// The second is column drift: a question added without a column, producing rows
// one cell out from their header. That is why the header is derived from the
// question set and why the width assertion below exists.
import { describe, expect, it } from 'vitest'
import {
  BUNDLES,
  BUNDLE_IDS,
  CHOICE_QUESTIONS,
  EMPTY_ANSWERS,
  MAX_RATING,
  OPEN_QUESTIONS,
  RATINGS,
  TOP_PICKS,
} from '../src/survey/questions'
import type { SurveyAnswers } from '../src/survey/questions'
import { surveyCell, surveyCsv, surveyHeader, surveyRow } from '../src/survey/csv'
import type { SurveyRow } from '../src/survey/csv'
import { csvCell } from '../src/maps/export'

const B = BUNDLE_IDS
const TOP = MAX_RATING

const row = (over: Partial<SurveyRow> = {}): SurveyRow => ({
  email: 'rider@example.com',
  displayName: 'Rider',
  status: 'active',
  submittedAt: new Date('2026-08-08T17:00:00Z'),
  answers: EMPTY_ANSWERS,
  ...over,
})

const answers = (over: Partial<SurveyAnswers> = {}): SurveyAnswers => ({
  ...EMPTY_ANSWERS,
  ratings: {},
  top: [],
  single: {},
  multi: {},
  open: {},
  ...over,
})

describe('surveyCell — formula injection', () => {
  it.each(['=1+1', '+1 for offline maps', '-1 star', '@SUM(A1)', '\t=cmd', '\r=cmd'])(
    'neutralizes a cell starting with %j',
    (raw) => {
      const out = surveyCell(raw)
      // The apostrophe is the marker; a spreadsheet reads the rest as text.
      const inner = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out
      expect(inner.startsWith("'")).toBe(true)
    },
  )

  // The real-world one worth naming: this executes on open in Excel.
  it('neutralizes a HYPERLINK payload', () => {
    expect(surveyCell('=HYPERLINK("http://evil.example","click")')).toContain("'=HYPERLINK")
  })

  it('keeps the original text so the answer is still readable', () => {
    expect(surveyCell('=1+1')).toBe("'=1+1")
  })

  it('leaves ordinary text alone', () => {
    for (const s of ['the GPS rerouted me', 'Garmin', '2,000 to 5,000 miles', "it's fine"]) {
      const out = surveyCell(s)
      const inner = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out
      expect(inner).toBe(s)
    }
  })

  // If this ever fails, someone has "deduplicated" the two escapers. The fix is
  // to separate them again, not to relax this.
  it('is NOT the same function as the ride exporter, which must stay unguarded', () => {
    expect(csvCell('=1+1')).toBe('=1+1')
    expect(surveyCell('=1+1')).not.toBe(csvCell('=1+1'))
  })
})

describe('surveyCell — RFC 4180 quoting', () => {
  it.each([
    ['plain', 'plain'],
    ['has,comma', '"has,comma"'],
    ['has"quote', '"has""quote"'],
    ['line\nbreak', '"line\nbreak"'],
    ['', ''],
  ])('%j becomes %j', (raw, expected) => {
    expect(surveyCell(raw)).toBe(expected)
  })

  it('renders null and undefined as empty', () => {
    expect(surveyCell(null)).toBe('')
    expect(surveyCell(undefined)).toBe('')
  })

  it('quotes a neutralized cell that also needs quoting', () => {
    expect(surveyCell('=a,b')).toBe('"\'=a,b"')
  })

  it('handles a number', () => {
    expect(surveyCell(3)).toBe('3')
  })
})

describe('surveyHeader and surveyRow', () => {
  // The assertion that makes the derived header worth having.
  it('produces a row exactly as wide as the header', () => {
    expect(surveyRow(row())).toHaveLength(surveyHeader().length)
  })

  it('stays aligned for a fully answered response', () => {
    const a = answers({
      ratings: Object.fromEntries(B.map((id) => [id, 2])),
      top: B.slice(0, TOP_PICKS),
      single: Object.fromEntries(CHOICE_QUESTIONS.filter((q) => !q.multi).map((q) => [q.id, q.options[0]])),
      multi: Object.fromEntries(CHOICE_QUESTIONS.filter((q) => q.multi).map((q) => [q.id, [...q.options]])),
      open: Object.fromEntries(OPEN_QUESTIONS.map((q) => [q.id, 'something'])),
    })
    expect(surveyRow(row({ answers: a }))).toHaveLength(surveyHeader().length)
  })

  it('covers every bundle, pick slot, choice and open question', () => {
    expect(surveyHeader()).toHaveLength(
      4 + BUNDLES.length + TOP_PICKS + CHOICE_QUESTIONS.length + OPEN_QUESTIONS.length,
    )
  })

  // The number is an implementation detail the rider never saw; the words are
  // what they picked, and what makes the sheet readable without a legend.
  it('writes ratings as the words the rider saw', () => {
    const cells = surveyRow(row({ answers: answers({ ratings: { [B[0]]: TOP } }) }))
    const topLabel = RATINGS.find((r) => r.value === TOP)?.label ?? ''
    expect(cells).toContain(topLabel)
    // The number is an implementation detail the rider never saw.
    expect(cells).not.toContain(String(TOP))
  })

  it('writes top picks as labels, in order, padding the empty slots', () => {
    const cells = surveyRow(row({ answers: answers({ top: [B[1], B[0]] }) }))
    const start = 4 + BUNDLES.length
    expect(cells[start]).toBe(BUNDLES.find((b) => b.id === B[1])?.label)
    expect(cells[start + 1]).toBe(BUNDLES.find((b) => b.id === B[0])?.label)
    expect(cells[start + 2]).toBe('')
  })

  it('joins multi-choice answers into one cell', () => {
    const q = CHOICE_QUESTIONS.find((x) => x.multi)
    if (!q) return
    const cells = surveyRow(row({ answers: answers({ multi: { [q.id]: [q.options[0], q.options[1]] } }) }))
    expect(cells).toContain(`${q.options[0]}; ${q.options[1]}`)
  })

  it('writes an unsubmitted draft with an empty timestamp', () => {
    expect(surveyRow(row({ submittedAt: null }))[3]).toBe('')
  })

  it('writes the timestamp as sortable ISO', () => {
    expect(surveyRow(row())[3]).toBe('2026-08-08T17:00:00.000Z')
  })
})

describe('surveyCsv', () => {
  it('starts with the header and uses CRLF', () => {
    const out = surveyCsv([row()])
    expect(out.startsWith(surveyHeader().map(surveyCell).join(','))).toBe(true)
    expect(out.endsWith('\r\n')).toBe(true)
    expect(out.split('\r\n').filter(Boolean)).toHaveLength(2)
  })

  it('writes a header even with no responses', () => {
    expect(surveyCsv([]).split('\r\n').filter(Boolean)).toHaveLength(1)
  })

  // An embedded newline inside a quoted cell is legal and must not be read as a
  // new record. Counting raw \r\n would over-count; splitting on the quoted form
  // is what a real parser does.
  it('keeps a multi-line answer inside one record', () => {
    const q = OPEN_QUESTIONS[0]
    const out = surveyCsv([row({ answers: answers({ open: { [q.id]: 'line one\nline two' } }) })])
    expect(out).toContain('"line one\nline two"')
    expect(out.split('\r\n').filter(Boolean)).toHaveLength(2)
  })

  it('neutralizes a formula written into an open answer', () => {
    const q = OPEN_QUESTIONS[0]
    const out = surveyCsv([row({ answers: answers({ open: { [q.id]: '=1+1' } }) })])
    expect(out).toContain("'=1+1")
    expect(out).not.toMatch(/,=1\+1/)
  })
})
