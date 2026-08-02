// The prose tightener that runs on every commit.
//
// It rewrites files in place from a git hook, so a bug here silently corrupts
// documentation. The cases that matter are the ones it must NOT touch.
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs with no types, which is the point of it
import { tighten } from '../utils/tighten-em-dashes.mjs'

const fix = (s: string, code = false) => tighten(s, { code }).text

describe('tightening', () => {
  it('closes a spaced em dash in prose', () => {
    expect(fix('a—b')).toBe('a—b')
  })

  it('handles several on one line', () => {
    expect(fix('a—b—c')).toBe('a—b—c')
  })

  it('catches a non-breaking space, which is what a paste leaves behind', () => {
    expect(fix('a—b')).toBe('a—b')
  })

  it('leaves an already tight dash alone', () => {
    expect(fix('a—b')).toBe('a—b')
  })
})

describe('what it must not touch', () => {
  it('leaves en dashes, which are the escape hatch for wanting air', () => {
    expect(fix('a – b')).toBe('a – b')
  })

  it('leaves fenced blocks, either fence style', () => {
    expect(fix('```text\na — b\n```')).toBe('```text\na — b\n```')
    expect(fix('~~~\na—b\n~~~')).toBe('~~~\na—b\n~~~')
  })

  it('leaves inline code', () => {
    expect(fix('see `a — b` here')).toBe('see `a — b` here')
  })

  it('still fixes prose sitting beside inline code', () => {
    expect(fix('x—y and `a — b`')).toBe('x—y and `a — b`')
  })

  it('leaves source comments, which follow the codebase convention', () => {
    expect(fix('// a—b', true)).toBe('// a—b')
    expect(fix(' * a—b', true)).toBe(' * a—b')
  })

  it('still fixes strings in source', () => {
    expect(fix("const s = 'a—b'", true)).toBe("const s = 'a—b'")
  })

  it('treats markdown as prose throughout, comment-looking or not', () => {
    expect(fix('// a—b')).toBe('// a—b')
  })
})

describe('no exemptions', () => {
  it('tightens table cells, which the rule used to allow', () => {
    expect(fix('| a—b | c—d |')).toBe('| a—b | c—d |')
  })

  it('tightens after a bold label', () => {
    expect(fix('- **shipped**—done.')).toBe('- **shipped**—done.')
  })
})
