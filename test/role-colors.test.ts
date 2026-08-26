// The seventeen role colors (#139).
//
// THE FOURTH LIST. `ROLES`, `ROLE_META`, the `waypoint_role` Postgres enum and
// the icon files on disk already have to carry the same seventeen keys — that is
// what test/roles.test.ts holds together, and it exists because those lists have
// drifted before. `ROLE_COLORS` is a fifth thing to keep in step, so it is
// asserted here rather than left to be noticed when a bar renders grey.
//
// AND THE MEASUREMENTS, which is the part that could not be asserted by reading
// the file. src/maps/role-colors.ts claims the ring survives on a light page, on
// a dark page and behind a white glyph, all at once. Those three pull against
// each other — the first and the third are the SAME inequality — so the window is
// narrow, and a hand-edit to one hue can leave it silently. Every claim in that
// module's header is a number here.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { waypointRoleEnum } from '../src/db/schema'
import { ROLES, ROLE_META, type Role } from '../src/maps/roles'
import { ROLE_COLORS, roleColor } from '../src/maps/role-colors'
import { contrast, luminance } from '../src/views/tokens'

// The two page grounds, and the ink on the disc. $neutral-98 in each scheme:
// #fafafa on the light palette, $splash-ink on the dark one. The dark CARD is
// checked too, because a bar sitting inside .stat-block is on $neutral-96 there,
// which is the lighter of the two dark surfaces and therefore the harder test.
const LIGHT_PAGE = '#f4f4f4'
const DARK_PAGE = '#0a0e11'
const DARK_CARD = '#1a1a1a'
const GLYPH = '#ffffff'

// 3:1, the WCAG threshold for a non-text graphic that carries meaning. These are
// bar fills and icon glyphs, not body copy, so 4.5 is the wrong bar to hold them
// to — and holding them to it would empty the window the ring has to live in.
const AA_GRAPHIC = 3

describe('the table itself', () => {
  it('has a color for every role and no orphans', () => {
    expect(Object.keys(ROLE_COLORS).sort()).toEqual([...ROLES].sort())
  })

  it('agrees with the Postgres enum', () => {
    expect(Object.keys(ROLE_COLORS).sort()).toEqual([...waypointRoleEnum.enumValues].sort())
  })

  it('agrees with ROLE_META, which is what pairs a color with its mark', () => {
    expect(Object.keys(ROLE_COLORS).sort()).toEqual(Object.keys(ROLE_META).sort())
  })

  // A colored bar with no mark beside it is a bar carrying meaning by color
  // alone, which is the thing the ring is explicitly not allowed to do.
  it('has an icon file on disk for every colored role', () => {
    for (const role of ROLES) {
      const file = join(process.cwd(), 'public', 'img', 'icons', `icon-${role}.svg`)
      expect(existsSync(file), `icon-${role}.svg`).toBe(true)
    }
  })

  it('gives every role a distinct color', () => {
    expect(new Set(Object.values(ROLE_COLORS)).size).toBe(ROLES.length)
  })

  it('is all six-digit lowercase hex, which is what the inline style writes', () => {
    for (const [role, hex] of Object.entries(ROLE_COLORS)) {
      expect(hex, role).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

describe('roleColor', () => {
  it('answers for a real role', () => {
    expect(roleColor('gas')).toBe(ROLE_COLORS.gas)
  })

  // Null rather than a fallback hue, so a taxonomy drift renders visibly wrong
  // instead of rendering plausibly.
  it('returns null for anything else', () => {
    expect(roleColor('brunch')).toBeNull()
    expect(roleColor('')).toBeNull()
    expect(roleColor('GAS')).toBeNull()
  })
})

describe('the ring is legible where it is actually drawn', () => {
  it.each(ROLES)('%s clears 3:1 as a bar on the light page', (role: Role) => {
    expect(contrast(ROLE_COLORS[role], LIGHT_PAGE)!).toBeGreaterThanOrEqual(AA_GRAPHIC)
  })

  it.each(ROLES)('%s clears 3:1 as a bar on the dark page', (role: Role) => {
    expect(contrast(ROLE_COLORS[role], DARK_PAGE)!).toBeGreaterThanOrEqual(AA_GRAPHIC)
  })

  // The harder of the two dark surfaces: a stat block sits on $neutral-96, which
  // under the dark scheme is #1a1a1a rather than the page's near-black.
  it.each(ROLES)('%s clears 3:1 as a bar on a dark card', (role: Role) => {
    expect(contrast(ROLE_COLORS[role], DARK_CARD)!).toBeGreaterThanOrEqual(AA_GRAPHIC)
  })

  // Every icon is a disc in the role color with the glyph knocked out white, so
  // this is the mark's own internal contrast and it has nothing to do with the
  // page behind it.
  it.each(ROLES)('%s holds a white glyph on its disc', (role: Role) => {
    expect(contrast(ROLE_COLORS[role], GLYPH)!).toBeGreaterThanOrEqual(AA_GRAPHIC)
  })
})

describe('the ring is categorical rather than a ramp', () => {
  // THE PROPERTY THAT MAKES IT A CATEGORY SET. Seventeen roles have no rank, and
  // a set whose members differ in lightness reads as one — the eye takes darker
  // for more. Fixed luminance is what stops the chart implying an order the data
  // does not have, and it is also why every contrast figure above is nearly the
  // same number.
  it('holds every hue to one lightness', () => {
    const ys = ROLES.map((r) => luminance(ROLE_COLORS[r])!)
    const spread = Math.max(...ys) - Math.min(...ys)
    expect(spread).toBeLessThan(0.01)
  })

  // The generator's own window, restated as a bound. Below it the ring vanishes
  // into a dark page; above it the white glyph goes.
  it('sits inside the window both grounds leave', () => {
    for (const role of ROLES) {
      const y = luminance(ROLE_COLORS[role])!
      expect(y, role).toBeGreaterThan(0.11)
      expect(y, role).toBeLessThan(0.3)
    }
  })
})
