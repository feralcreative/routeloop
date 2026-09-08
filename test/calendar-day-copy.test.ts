// THE DAY→ROUTE RENAME SWEPT THE CALENDAR SENSE IT WAS TOLD TO LEAVE ALONE, and
// this is the guard that stops it happening again.
//
// AGENTS.md is explicit that "day" survives for the calendar sense — a real date,
// a start time, the thirty-day trash hold — and the 2026-09-06 rename replaced it
// anyway wherever the word appeared. The bin told a rider their ride had "17
// routes left", the account page said it would be destroyed "30 routes from now",
// the admin invite form asked for a duration "in routes", and the invite email
// promised a link good for "14 routes".
//
// ONE OF THEM WAS NOT COSMETIC AND IS WHY THIS FILE EXISTS. `checkAvailability()`
// built its held-name window as `interval '${USERNAME_HOLD_DAYS} routes'`, which
// Postgres rejects outright — `invalid input syntax for type interval` — so every
// username change 500'd, in production, from the moment the rename merged. A
// string built by interpolation is invisible to the typechecker and there is no
// database-backed test to catch it at runtime, so the unit is checked here as
// text.
//
// TEXT AND NOT BEHAVIOR, deliberately. `vitest.config.ts` is scoped to pure logic
// and CI runs no Postgres, so the only place this can be caught for free is in
// the source. Same arrangement as test/map-globals.test.ts.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

const SOURCES = sourceFiles('src')

// Every unit `interval` accepts. Postgres also takes plurals and a handful of
// abbreviations; the whole word is what this codebase writes, so the check is on
// the singular stem and anything else is a typo or a bad rename.
const INTERVAL_UNITS = /^(microsecond|millisecond|second|minute|hour|day|week|month|year|decade|century|millennium)s?$/

describe('SQL interval literals', () => {
  it('names a unit Postgres accepts', () => {
    const bad: string[] = []
    for (const file of SOURCES) {
      const src = readFileSync(file, 'utf8')
      // Both spellings this repo uses: a bare literal, and one built by
      // interpolating a count in front of the unit.
      for (const m of src.matchAll(/interval '(?:\$\{[^}]*\}|[\d.]+)\s+([A-Za-z]+)'/g)) {
        if (!INTERVAL_UNITS.test(m[1])) bad.push(`${file}: interval '… ${m[1]}'`)
      }
    }
    expect(bad).toEqual([])
  })
})

describe('calendar-day copy', () => {
  // A constant whose name ends in _DAYS counts days. Printing it beside the word
  // "route" is the rename reaching a sentence about the calendar.
  it('never prints a _DAYS constant as a count of routes', () => {
    const bad: string[] = []
    for (const file of SOURCES) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/[A-Z_]+_DAYS\}?\s+routes?\b/.test(line)) bad.push(`${file}:${i + 1}`)
        })
    }
    expect(bad).toEqual([])
  })

  // `daysUntilPurge` returns days. The bin and the account page both render its
  // result, and both were reading "N routes left" — so the name it is bound to is
  // what the sentence is built from, and binding it to `routes` is the bug.
  it('binds daysUntilPurge to a name that says days', () => {
    const bad: string[] = []
    for (const file of SOURCES) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/const\s+routes?\s*=\s*daysUntilPurge\(/.test(line)) bad.push(`${file}:${i + 1}`)
        })
    }
    expect(bad).toEqual([])
  })
})
