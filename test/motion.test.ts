// The in-app motion preference. A display layer, the same shape as appearance.ts.
import { describe, expect, it } from 'vitest'
import { MOTION_CHOICES, MOTIONS, motionAttr, toMotion } from '../src/views/motion'

describe('toMotion', () => {
  it('takes the three members', () => {
    for (const m of MOTIONS) expect(toMotion(m)).toBe(m)
  })

  // The default is `system` rather than `always`, and this is the assertion that
  // keeps it that way: defaulting to "animate" would override the OS preference
  // of every rider who already has reduced motion set — the accessibility
  // setting made worse by the accessibility feature.
  it('falls back to system, never to always', () => {
    expect(toMotion(undefined)).toBe('system')
    expect(toMotion(null)).toBe('system')
    expect(toMotion('on')).toBe('system')
  })
})

describe('motionAttr', () => {
  // No request header carries the OS motion setting, so `system` has to render
  // as the ABSENCE of the attribute and let the media query answer. Stamping
  // data-motion="system" would match no rule and pin every such rider to
  // animated — the same trap schemeAttr avoids for `system`.
  it('stamps nothing for system', () => {
    expect(motionAttr('system')).toBeNull()
  })

  // BOTH overrides are stamped. `always` is not the same as no preference: it
  // means "animate even though my machine says reduce", which the CSS has to be
  // able to tell apart from "I have not said".
  it('stamps both overrides', () => {
    expect(motionAttr('always')).toBe('always')
    expect(motionAttr('never')).toBe('never')
  })
})

describe('MOTION_CHOICES', () => {
  it('offers every member exactly once, in order', () => {
    expect(MOTION_CHOICES.map((c) => c.id)).toEqual([...MOTIONS])
  })

  it('describes each one without naming the media query at a rider', () => {
    for (const c of MOTION_CHOICES) {
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.hint.length).toBeGreaterThan(0)
      expect(c.hint).not.toMatch(/prefers-reduced-motion/)
    }
  })
})
