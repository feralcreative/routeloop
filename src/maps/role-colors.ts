// One color per waypoint role, for the dashboard's "What you stop for" chart.
//
// NOT `DAY_COLORS`, and the reason is semantic before it is arithmetic. That
// palette holds twelve, so five roles would wrap onto a duplicate — but the real
// objection is that the same hue would mean "day 3" in a ride legend and "coffee"
// here, in an app where a colored line on a map already carries meaning.
//
// GENERATED, NOT PICKED. `utils/build-role-colors.mjs` is the derivation and its
// header is the reasoning; run it to reproduce this table exactly. Seventeen hues
// evenly spaced around the circle at ONE fixed lightness and ONE fixed chroma:
//
//   - Equal lightness is what makes it categorical. Seventeen roles have no rank,
//     and a ring whose members differ in lightness would imply one.
//   - The chroma is the largest every hue can hold at that lightness, which is
//     why the set reads a little muted. Yellow-green is the binding hue.
//   - The hues are walked with a stride of 7, coprime with 17. Same seventeen
//     evenly spaced hues, but consecutive roles land ~148 degrees apart, so two
//     roles adjacent in the chart are never adjacent in hue.
//
// ONE RING SERVES BOTH SCHEMES, which is why this is a plain table rather than a
// per-theme block in `_palette.scss`. Every entry clears 3:1 against the light
// page, against the dark page, AND behind the white glyph the icons carry — those
// last two pull in opposite directions, and the ring sits in the window where all
// three hold. `test/role-colors.test.ts` measures every one of those and fails
// rather than trusting this paragraph. A per-scheme pair of rings would be
// optimal on each ground and would be a second table to keep in sync; Ziad's
// call, 2026-08-25, was the single ring.
//
// IT DOES NOT FOLLOW THE COLORBLIND THEME, deliberately. Seventeen categories
// cannot be made mutually distinguishable under dichromacy by any assignment —
// the useful number is about eight — so shifting these with the theme would trade
// a palette that is honestly undifferentiable for one that pretends otherwise.
// What makes the chart readable instead is that COLOR IS NEVER THE ONLY CUE
// there: every bar carries its own icon and its own text label, and the color is
// redundant with both. See the RoleChart comment in src/routes/home.tsx.
import { ROLES, type Role } from './roles'

export const ROLE_COLORS: Record<Role, string> = {
  start: '#ae645f',
  finish: '#248770',
  home: '#97689f',
  meet: '#7c7c32',
  split: '#547ab2',
  gas: '#aa6848',
  charge: '#008786',
  break: '#a4658c',
  camp: '#628243',
  hotel: '#6e74b3',
  food: '#a06e36',
  coffee: '#13849a',
  drinks: '#ac6376',
  grocery: '#458659',
  view: '#856eac',
  poi: '#90762d',
  wtf: '#3680a9',
}

/**
 * The color for a role, or null for a string that is not one.
 *
 * Null rather than a fallback hue: an unknown role is a taxonomy bug — the enum,
 * `ROLES`, `ROLE_META` and this table all have to carry the same seventeen keys —
 * and painting it a default color would hide that. The one caller renders an
 * uncolored bar instead, which is visibly odd and therefore reportable.
 */
export const roleColor = (role: string): string | null =>
  (ROLES as readonly string[]).includes(role) ? ROLE_COLORS[role as Role] : null
