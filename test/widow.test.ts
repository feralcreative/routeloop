// The widow binder.
//
// Small enough to read, and pinned anyway because the failure is invisible: a
// version that binds the wrong space, or every space, renders identically until
// a paragraph reaches the width where it matters. See src/views/widow.ts for why
// this exists at all when style/_base.scss already sets `text-wrap: pretty`.
import { describe, expect, it } from 'vitest'
import { noWidow } from '../src/views/widow'

const NBSP = '\u00a0'

describe('noWidow', () => {
  it('binds the last two words', () => {
    expect(noWidow('sign in and start planning.')).toBe(`sign in and start${NBSP}planning.`)
  })

  it('binds only the last pair', () => {
    const out = noWidow('one two three')
    expect(out).toBe(`one two${NBSP}three`)
    expect(out.split(NBSP)).toHaveLength(2)
  })

  it('leaves a single word alone', () => {
    expect(noWidow('planning.')).toBe('planning.')
  })

  it('leaves an empty string alone', () => {
    expect(noWidow('')).toBe('')
  })

  // The pair is found past trailing whitespace, but the whitespace survives, so
  // a caller joining fragments does not silently lose a separator.
  it('ignores trailing whitespace when finding the pair, and keeps it', () => {
    expect(noWidow('comes up.  ')).toBe(`comes${NBSP}up.  `)
  })

  it('leaves a lone trailing space alone', () => {
    expect(noWidow('planning. ')).toBe('planning. ')
  })

  // Idempotence is not claimed and must not be relied on: a second pass binds
  // the pair BEFORE the one already bound, which is how a run wide enough to
  // overflow gets built up by accident.
  it('is not idempotent, which is why callers apply it once', () => {
    expect(noWidow(noWidow('one two three'))).toBe(`one${NBSP}two${NBSP}three`)
  })
})
