// The avatar crop rectangle, clamped into an image that actually exists.
//
// **THE CROP ARRIVES FROM THE BROWSER AND IS THEREFORE UNTRUSTED.** The rider
// draws it on a preview, but what reaches the server is three numbers in a
// multipart body, and a hand-crafted request can put anything there. sharp's
// `extract` throws on a rectangle that leaves the image — so this is both the
// correctness half (the rider gets the square they drew) and the half that
// stops a 500 being a supported way to talk to the endpoint.
import { describe, expect, it } from 'vitest'
import { clampCrop } from '../src/account/avatar'

const LANDSCAPE = { width: 4000, height: 3000 }
const PORTRAIT = { width: 3000, height: 4000 }

describe('a crop that already fits is left alone', () => {
  it('keeps the rider’s square', () => {
    expect(clampCrop({ x: 100, y: 200, size: 1500 }, LANDSCAPE)).toEqual({ x: 100, y: 200, size: 1500 })
  })

  it('allows a square flush against the far edge', () => {
    expect(clampCrop({ x: 1000, y: 0, size: 3000 }, LANDSCAPE)).toEqual({ x: 1000, y: 0, size: 3000 })
  })
})

// THE ORDER IS THE WHOLE TRICK: size is capped to the shorter side BEFORE the
// origin is clamped. Doing it the other way round leaves an oversized square
// with no valid origin — the clamp pushes x negative and sharp refuses the
// extract, which is a 500 on a request a rider could make by resizing a window.
describe('a crop bigger than the image', () => {
  it('caps at the shorter side on a landscape photo', () => {
    expect(clampCrop({ x: 0, y: 0, size: 99999 }, LANDSCAPE)).toEqual({ x: 0, y: 0, size: 3000 })
  })

  it('caps at the shorter side on a portrait photo', () => {
    expect(clampCrop({ x: 0, y: 0, size: 99999 }, PORTRAIT)).toEqual({ x: 0, y: 0, size: 3000 })
  })

  it('never leaves a negative origin behind', () => {
    const c = clampCrop({ x: 9999, y: 9999, size: 99999 }, LANDSCAPE)
    expect(c.x).toBeGreaterThanOrEqual(0)
    expect(c.y).toBeGreaterThanOrEqual(0)
    expect(c.x + c.size).toBeLessThanOrEqual(LANDSCAPE.width)
    expect(c.y + c.size).toBeLessThanOrEqual(LANDSCAPE.height)
  })
})

describe('an origin outside the image', () => {
  it('pulls a square back inside from the right', () => {
    expect(clampCrop({ x: 3900, y: 0, size: 1000 }, LANDSCAPE)).toEqual({ x: 3000, y: 0, size: 1000 })
  })

  it('pulls a square back inside from the bottom', () => {
    expect(clampCrop({ x: 0, y: 2900, size: 1000 }, LANDSCAPE)).toEqual({ x: 0, y: 2000, size: 1000 })
  })

  it('refuses a negative origin', () => {
    expect(clampCrop({ x: -500, y: -500, size: 1000 }, LANDSCAPE)).toEqual({ x: 0, y: 0, size: 1000 })
  })
})

// No crop is what an API client sending only a file gets. A CENTER square,
// which is what the old server-side behavior did — acceptable as a fallback
// precisely because the browser normally sends a real one.
describe('no crop at all', () => {
  it('centers on a landscape photo', () => {
    expect(clampCrop(null, LANDSCAPE)).toEqual({ x: 500, y: 0, size: 3000 })
  })

  it('centers on a portrait photo', () => {
    expect(clampCrop(undefined, PORTRAIT)).toEqual({ x: 0, y: 500, size: 3000 })
  })

  it('takes the whole of a square photo', () => {
    expect(clampCrop(null, { width: 800, height: 800 })).toEqual({ x: 0, y: 0, size: 800 })
  })
})

// Every one of these is reachable from a hand-crafted multipart body, and every
// one of them would throw inside sharp if it got that far.
describe('values that are not numbers', () => {
  it.each([
    [{ x: NaN, y: 0, size: 100 }],
    [{ x: 0, y: NaN, size: 100 }],
    [{ x: 0, y: 0, size: NaN }],
    [{ x: Infinity, y: Infinity, size: Infinity }],
    [{ x: 0, y: 0, size: 0 }],
    [{ x: 0, y: 0, size: -100 }],
  ])('%j produces a usable square', (crop) => {
    const c = clampCrop(crop as never, LANDSCAPE)
    expect(Number.isInteger(c.x)).toBe(true)
    expect(Number.isInteger(c.y)).toBe(true)
    expect(Number.isInteger(c.size)).toBe(true)
    expect(c.size).toBeGreaterThan(0)
    expect(c.x + c.size).toBeLessThanOrEqual(LANDSCAPE.width)
    expect(c.y + c.size).toBeLessThanOrEqual(LANDSCAPE.height)
  })

  it('floors a fractional crop rather than passing it to sharp', () => {
    const c = clampCrop({ x: 10.9, y: 20.9, size: 100.9 }, LANDSCAPE)
    expect(c).toEqual({ x: 10, y: 20, size: 100 })
  })
})

// A 1x1 image is a real upload and must not produce a zero-sized extract.
describe('degenerate images', () => {
  it('survives a one-pixel image', () => {
    expect(clampCrop({ x: 0, y: 0, size: 500 }, { width: 1, height: 1 })).toEqual({ x: 0, y: 0, size: 1 })
  })

  it('survives a one-pixel-tall strip', () => {
    const c = clampCrop({ x: 300, y: 0, size: 500 }, { width: 1000, height: 1 })
    expect(c).toEqual({ x: 300, y: 0, size: 1 })
  })
})
