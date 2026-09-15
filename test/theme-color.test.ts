// The theme-color meta (#69) paints the browser chrome on an installed phone
// the page's own surface color. The two values are DECLARED in src/views/sw.ts
// rather than read out of the built stylesheet per request — the role-colors.ts
// arrangement — so this is what keeps them true: compile the palette and fail
// if `$white` moves under them.
import { describe, expect, it } from 'vitest'
import { THEME_COLOR } from '../src/views/sw'
import { token } from './helpers/palettes'

const norm = (v: string) => v.trim().toLowerCase()

describe('theme-color follows the page surface', () => {
  it('matches --white in the default light palette', () => {
    expect(norm(token('default-light', 'white'))).toBe(THEME_COLOR.light)
  })

  it('matches --white in the default dark palette', () => {
    expect(norm(token('default-dark', 'white'))).toBe(THEME_COLOR.dark)
  })

  it('is a six-digit hex in both, because a browser reads nothing else reliably', () => {
    expect(THEME_COLOR.light).toMatch(/^#[0-9a-f]{6}$/)
    expect(THEME_COLOR.dark).toMatch(/^#[0-9a-f]{6}$/)
  })
})
