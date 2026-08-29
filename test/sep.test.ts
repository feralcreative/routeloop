// The data delimiter, and the three copies of it.
//
// SEP is one string on three runtimes: src/views/sep.ts for everything rendered
// on the server, and a local const in each of public/js/builder.js and
// public/js/viewer.js, which build the same lines in the browser. Same
// arrangement as filename.ts/filename.js and twist.ts/twist.js, and the same
// failure if they drift — a timeline readout spaced one way in the builder and
// another in the viewer, with nothing raised.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { SEP } from '../src/views/sep'

const clientSep = (file: string): string => {
  const src = readFileSync(file, 'utf8')
  const m = /const SEP = "((?:[^"\\]|\\.)*)";/.exec(src)
  if (!m) throw new Error(`no SEP declaration in ${file}`)
  // The literal is written with escapes on purpose; this is what the browser
  // would end up holding.
  return JSON.parse(`"${m[1]}"`)
}

describe('the interpunct delimiter', () => {
  it('is an interpunct with an en space either side', () => {
    expect(SEP).toBe(' · ')
  })

  it('does not lean on an ASCII space, which HTML would collapse', () => {
    // The bug this replaced: the source carried a word space either side, one
    // of which JSX had already eaten, and adding a second ASCII space would
    // have rendered as one. Nothing here may be a collapsible space.
    for (const ch of SEP) expect(' \t\n\r\f').not.toContain(ch)
  })

  it('is the same string in both browser copies', () => {
    expect(clientSep('public/js/builder.js')).toBe(SEP)
    expect(clientSep('public/js/viewer.js')).toBe(SEP)
  })

  it('is written as an escape in every copy, never as the raw character', () => {
    // An invisible character in source is unreviewable in a diff and
    // undetectable when something strips it — the same rule AGENTS.md gives for
    // U+00A0. The interpunct itself stays literal, because it is visible.
    for (const f of ['src/views/sep.ts', 'public/js/builder.js', 'public/js/viewer.js']) {
      const decl = /const SEP = ['"](.*?)['"]/.exec(readFileSync(f, 'utf8'))![1]
      expect(decl).not.toContain(' ')
      expect(decl).toContain('\\u2002')
    }
  })
})
