// The prose tightener that runs on every commit.
//
// It rewrites files in place from a git hook, so a bug here silently corrupts
// documentation. The cases that matter are the ones it must NOT touch.
//
// **Every fixture is built from escapes, never from a literal spaced em dash.**
// The first version of this file used literals, and committing it ran the hook
// over its own test data: `fix('a — b')` was rewritten to `fix('a—b')`, turning
// half the assertions into tautologies that still reported green. Escapes make
// the fixtures immune to any formatter, this one included. `utils/` also skips
// `test/` now, but this file should not depend on that.
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs with no types, which is the point of it
import { tighten } from '../utils/tighten-em-dashes.mjs'

const EM = '—' // —
const EN = '–' // –
const NBSP = ' '
const spaced = (l = 'a', r = 'b') => `${l} ${EM} ${r}`
const tight = (l = 'a', r = 'b') => `${l}${EM}${r}`

const fix = (s: string, code = false) => tighten(s, { code }).text

describe('tightening', () => {
  it('closes a spaced em dash in prose', () => {
    expect(fix(spaced())).toBe(tight())
  })

  it('handles several on one line', () => {
    expect(fix(`a ${EM} b ${EM} c`)).toBe(`a${EM}b${EM}c`)
  })

  it('catches a non-breaking space, which is what a paste leaves behind', () => {
    expect(fix(`a${NBSP}${EM}${NBSP}b`)).toBe(tight())
  })

  it('leaves an already tight dash alone', () => {
    expect(fix(tight())).toBe(tight())
  })
})

describe('what it must not touch', () => {
  it('leaves en dashes, which are the escape hatch for wanting air', () => {
    expect(fix(`a ${EN} b`)).toBe(`a ${EN} b`)
  })

  it('leaves fenced blocks, either fence style', () => {
    expect(fix(`\`\`\`text\n${spaced()}\n\`\`\``)).toBe(`\`\`\`text\n${spaced()}\n\`\`\``)
    expect(fix(`~~~\n${spaced()}\n~~~`)).toBe(`~~~\n${spaced()}\n~~~`)
  })

  it('leaves inline code', () => {
    expect(fix(`see \`${spaced()}\` here`)).toBe(`see \`${spaced()}\` here`)
  })

  it('still fixes prose sitting beside inline code', () => {
    expect(fix(`${spaced('x', 'y')} and \`${spaced()}\``)).toBe(`${tight('x', 'y')} and \`${spaced()}\``)
  })

  it('leaves source comments, which follow the codebase convention', () => {
    expect(fix(`// ${spaced()}`, true)).toBe(`// ${spaced()}`)
    expect(fix(` * ${spaced()}`, true)).toBe(` * ${spaced()}`)
  })

  it('still fixes strings in source', () => {
    expect(fix(`const s = '${spaced()}'`, true)).toBe(`const s = '${tight()}'`)
  })

  it('treats markdown as prose throughout, comment-looking or not', () => {
    expect(fix(`// ${spaced()}`)).toBe(`// ${tight()}`)
  })
})

describe('no exemptions', () => {
  it('tightens table cells, which the rule used to allow', () => {
    expect(fix(`| ${spaced()} | ${spaced('c', 'd')} |`)).toBe(`| ${tight()} | ${tight('c', 'd')} |`)
  })

  it('tightens after a bold label', () => {
    expect(fix(`- **shipped** ${EM} done.`)).toBe(`- **shipped**${EM}done.`)
  })
})
