// The client-side ring buffer, evaluated the way test/ride-time.test.ts
// evaluates ride-time.js — the house pattern for a pure client helper.
//
// The window handed in is a bare object with no addEventListener, which is what
// makes this work: feedback-buffer.js installs its recorder only when it finds a
// real one, so the module's pure half is loadable and testable while the half
// that wraps console.error and fetch stays out of the way.
//
// The behavior most worth pinning is the eviction direction. The ring keeps the
// OLDEST entries once full, because the first error is almost always the cause
// and the twenty after it are the consequences. A buffer that keeps the newest
// would reliably discard the one line worth reading, and nothing about that is
// visible until someone tries to read a real report.
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

let B: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/feedback-buffer.js', 'utf8'))(win)
  B = win.TBBuffer
})

describe('makeRing', () => {
  it('collects up to its limit', () => {
    const r = B.makeRing(3)
    r.push('a')
    r.push('b')
    expect(r.list()).toEqual(['a', 'b'])
    expect(r.length).toBe(2)
  })

  // The one that matters. See the header.
  it('keeps the oldest entries and drops later ones once full', () => {
    const r = B.makeRing(3)
    for (const x of ['a', 'b', 'c', 'd', 'e']) r.push(x)
    expect(r.list()).toEqual(['a', 'b', 'c'])
  })

  it('hands back a copy, so a caller cannot mutate the buffer', () => {
    const r = B.makeRing(3)
    r.push('a')
    r.list().push('b')
    expect(r.list()).toEqual(['a'])
  })

  it('clears', () => {
    const r = B.makeRing(2)
    r.push('a')
    r.clear()
    expect(r.list()).toEqual([])
  })

  it('is inert at a limit of zero rather than throwing', () => {
    const r = B.makeRing(0)
    r.push('a')
    expect(r.list()).toEqual([])
  })
})

describe('errorEntry', () => {
  it('flattens to primitives', () => {
    expect(B.errorEntry('error', 'boom', 'at x', 120)).toEqual({
      kind: 'error',
      at: 120,
      message: 'boom',
      stack: 'at x',
    })
  })

  it('omits an absent message or stack rather than storing null', () => {
    expect(B.errorEntry('console', 'boom', null, 1)).toEqual({ kind: 'console', at: 1, message: 'boom' })
  })

  it('truncates a runaway message and stack', () => {
    const e = B.errorEntry('error', 'x'.repeat(9000), 'y'.repeat(9000), 0)
    expect(e.message.length).toBeLessThanOrEqual(2000)
    expect(e.stack.length).toBeLessThanOrEqual(4000)
  })

  it('coerces a thrown non-string without throwing', () => {
    expect(() => B.errorEntry('error', { toString: () => 'obj' }, undefined, 0)).not.toThrow()
  })
})

describe('worthRecording', () => {
  // Recording every request would push the interesting one out of a ten-slot
  // buffer within seconds of opening the builder.
  it('records failures, network errors and slow calls only', () => {
    expect(B.worthRecording(500, 20)).toBe(true)
    expect(B.worthRecording(404, 20)).toBe(true)
    expect(B.worthRecording(0, 20)).toBe(true) // network error
    expect(B.worthRecording(200, B.SLOW_MS)).toBe(true)
    expect(B.worthRecording(200, 20)).toBe(false)
    expect(B.worthRecording(304, 20)).toBe(false)
  })
})

describe('routePattern', () => {
  // The single most useful field in the payload: it is what lets six
  // unrelated-looking reports be recognized as one broken screen.
  it('collapses an id into its pattern', () => {
    expect(B.routePattern('/m/Xk9abc')).toBe('/m/:slug')
    expect(B.routePattern('/m/Xk9abc/roadbook')).toBe('/m/:slug/roadbook')
    expect(B.routePattern('/build/Xk9abc')).toBe('/build/:slug')
    expect(B.routePattern('/feedback/Xk9abc')).toBe('/feedback/:publicId')
  })

  it('two different rides on one screen give the same pattern', () => {
    expect(B.routePattern('/m/aaa')).toBe(B.routePattern('/m/bbb'))
  })

  it('leaves a path with no id alone', () => {
    expect(B.routePattern('/rides')).toBe('/rides')
    expect(B.routePattern('/build')).toBe('/build')
  })

  it('drops a query string and a fragment', () => {
    expect(B.routePattern('/build/Xk9?day=2#top')).toBe('/build/:slug')
  })

  it('is total on junk', () => {
    expect(typeof B.routePattern('')).toBe('string')
    expect(typeof B.routePattern(null)).toBe('string')
  })
})

describe('buildPayload', () => {
  it('omits blocks that were never collected', () => {
    expect(B.buildPayload({ app: { pattern: '/build' } })).toEqual({ app: { pattern: '/build' } })
    expect(B.buildPayload({})).toEqual({})
    expect(B.buildPayload(null)).toEqual({})
  })

  it('caps the two lists at what the server would keep anyway', () => {
    const errors = Array.from({ length: 100 }, (_, i) => ({ message: String(i) }))
    const net = Array.from({ length: 100 }, (_, i) => ({ path: `/x/${i}` }))
    const out = B.buildPayload({ errors, net })
    expect(out.errors).toHaveLength(B.ERRORS_MAX)
    expect(out.net).toHaveLength(B.NET_MAX)
  })

  it('drops empty lists rather than sending an empty array', () => {
    const out = B.buildPayload({ errors: [], net: [] })
    expect(out.errors).toBeUndefined()
    expect(out.net).toBeUndefined()
  })
})

describe('safe', () => {
  // The read that takes the page down if it is not guarded:
  // navigator.connection is absent on Safari and Firefox, and this code runs
  // when something has already gone wrong.
  it('returns the fallback when the read throws', () => {
    expect(
      B.safe(() => {
        throw new Error('no such property')
      }, 'fallback'),
    ).toBe('fallback')
  })

  it('returns the fallback for null and undefined', () => {
    expect(B.safe(() => undefined, '')).toBe('')
    expect(B.safe(() => null, '')).toBe('')
  })

  it('passes a real value through, including a falsy one', () => {
    expect(B.safe(() => 0, -1)).toBe(0)
    expect(B.safe(() => false, true)).toBe(false)
  })
})

describe('the caps agree with the server', () => {
  // policy.ts is the authority and truncates regardless, so a mismatch only
  // wastes bytes on the wire — but a silent mismatch is still worth catching.
  it('matches DIAG_ERRORS_MAX and DIAG_NET_MAX', async () => {
    const { DIAG_ERRORS_MAX, DIAG_NET_MAX } = await import('../src/feedback/policy')
    expect(B.ERRORS_MAX).toBe(DIAG_ERRORS_MAX)
    expect(B.NET_MAX).toBe(DIAG_NET_MAX)
  })
})
