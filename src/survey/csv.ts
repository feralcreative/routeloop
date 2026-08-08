// The survey as a spreadsheet.
//
// There is already a CSV writer in src/maps/export.ts and this deliberately does
// NOT reuse its `csvCell`. That one does RFC 4180 quoting and nothing else,
// which is exactly right where it lives: test/round-trip.test.ts requires a ride
// exported to CSV and re-imported to come back byte-identical, and any
// neutralization would corrupt that.
//
// This file writes something different — free text a rider typed, opened in
// Excel or Numbers by the person who asked the question. A cell beginning `=`,
// `+`, `-` or `@` is a FORMULA to a spreadsheet, so an answer of
// `=HYPERLINK("http://…","click")` executes on open. The rider does not even
// have to be malicious; `-1 star` and `+1 for offline maps` are things people
// write, and both are formulas.
//
// So: same quoting rules, plus a leading-character guard. Two functions that
// look alike and must not be merged.
import {
  BUNDLES,
  CHOICE_QUESTIONS,
  OPEN_QUESTIONS,
  RATINGS,
  TOP_PICKS,
  bundleLabel,
} from './questions'
import type { SurveyAnswers } from './questions'

export type SurveyRow = {
  email: string
  displayName: string
  status: string
  submittedAt: Date | null
  answers: SurveyAnswers
}

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * Tab and carriage return are in here because both Excel and LibreOffice strip
 * leading whitespace before deciding, so `\t=cmd` is still a formula.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/

/** Needs RFC 4180 quoting. */
const NEEDS_QUOTES = /[",\r\n]/

/**
 * One cell, safe to open.
 *
 * Neutralizes with a leading apostrophe, which every major spreadsheet reads as
 * "the rest of this is literal text" and does not display. The alternative —
 * stripping the character — silently edits what a rider wrote, and the whole
 * point of the open questions is to read what they actually said.
 */
export function surveyCell(v: string | number | null | undefined): string {
  if (v == null) return ''
  let s = String(v)
  if (FORMULA_LEAD.test(s)) s = `'${s}`
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * The header, derived from the question set rather than written out.
 *
 * That is what makes `surveyHeader().length === row.length` a real test: a
 * question added without a column fails immediately, instead of producing a CSV
 * whose columns are one out from its header three sprints later.
 */
export function surveyHeader(): string[] {
  return [
    'email',
    'name',
    'account status',
    'submitted at',
    ...BUNDLES.map((b) => `rate: ${b.label}`),
    ...Array.from({ length: TOP_PICKS }, (_, i) => `top ${i + 1}`),
    ...CHOICE_QUESTIONS.map((q) => q.label),
    ...OPEN_QUESTIONS.map((q) => q.label),
  ]
}

/** Rating as the words the rider saw, not the number they never did. */
const ratingLabel = (v: number | undefined): string =>
  v === undefined ? '' : (RATINGS.find((r) => r.value === v)?.label ?? String(v))

export function surveyRow(row: SurveyRow): string[] {
  const a = row.answers
  return [
    row.email,
    row.displayName,
    row.status,
    // ISO, in UTC, because a spreadsheet's date parsing is a guess and this one
    // sorts correctly as text in every locale.
    row.submittedAt ? row.submittedAt.toISOString() : '',
    ...BUNDLES.map((b) => ratingLabel(a.ratings[b.id])),
    ...Array.from({ length: TOP_PICKS }, (_, i) => (a.top[i] ? bundleLabel(a.top[i]) : '')),
    ...CHOICE_QUESTIONS.map((q) => (q.multi ? (a.multi[q.id] ?? []).join('; ') : (a.single[q.id] ?? ''))),
    ...OPEN_QUESTIONS.map((q) => a.open[q.id] ?? ''),
  ]
}

export function surveyCsv(rows: readonly SurveyRow[]): string {
  const lines = [surveyHeader().map(surveyCell).join(',')]
  for (const r of rows) lines.push(surveyRow(r).map(surveyCell).join(','))
  // CRLF: the line ending RFC 4180 specifies, and the one Excel needs. Same
  // choice as maps/export.ts, for the same reason.
  return `${lines.join('\r\n')}\r\n`
}
