// The color a route is drawn in on a dark map. Same harness as
// range-circle.test.ts: the file is eval'd with a bare window.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { ROUTE_COLORS } from '../src/maps/palette'

let I: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/route-ink.js', 'utf8'))(win)
  I = (win as any).TBRouteInk
})

const lightness = (hex: string) => I.toHsl(I.parseHex(hex))[2]
const hue = (hex: string) => I.toHsl(I.parseHex(hex))[0]

describe('liftForDark', () => {
  it('raises every stored route color to the floor, and no higher', () => {
    for (const c of ROUTE_COLORS) {
      const lifted = I.liftForDark(c)
      expect(lifted).toMatch(/^#[0-9a-f]{6}$/)
      expect(lightness(lifted)).toBeGreaterThanOrEqual(I.DARK_FLOOR - 0.5)
      expect(lightness(lifted)).toBeLessThanOrEqual(Math.max(I.DARK_FLOOR, lightness(c)) + 0.5)
    }
  })

  it('keeps the hue, so a plum stays plum and a navy stays blue', () => {
    for (const c of ROUTE_COLORS) {
      const [, s] = I.toHsl(I.parseHex(c))
      if (s < 5) continue
      const dh = Math.abs(hue(I.liftForDark(c)) - hue(c))
      expect(Math.min(dh, 360 - dh)).toBeLessThan(2)
    }
  })

  it('leaves a color already above the floor alone', () => {
    expect(I.liftForDark('#ffcc66')).toBe('#ffcc66')
    expect(I.liftForDark('#ffffff')).toBe('#ffffff')
  })

  it('makes the two near-black entries into a green and a red', () => {
    expect(lightness('#003300')).toBeLessThan(12)
    expect(lightness(I.liftForDark('#003300'))).toBeGreaterThan(50)
    expect(lightness(I.liftForDark('#550000'))).toBeGreaterThan(50)
  })

  it('reads a short hex, and the rgb() a style object hands back, and passes anything else through', () => {
    expect(I.liftForDark('#06c')).toBe(I.liftForDark('#0066cc'))
    expect(I.liftForDark('rgb(0, 102, 204)')).toBe(I.liftForDark('#0066cc'))
    expect(I.liftForDark('var(--white)')).toBe('var(--white)')
    expect(I.liftForDark('')).toBe('')
    expect(I.liftForDark(undefined)).toBe(undefined)
  })
})
