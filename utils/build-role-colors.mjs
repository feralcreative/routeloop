// Regenerates the seventeen role colors in src/maps/role-colors.ts.
//
// The ring is DERIVED, not hand-picked, and this file is the derivation. Run it,
// paste the printed table, and the reasoning below is what the numbers mean.
//
//   node utils/build-role-colors.mjs
//
// THE CONSTRAINT IS A WINDOW, not a taste. Every color has to work as a bar fill
// on both page grounds AND as a disc behind a white glyph, and those pull in
// opposite directions:
//
//   disc against the light page, 3:1     ->  relative luminance Y <= 0.30
//   white glyph on the disc, 3:1         ->  the same constraint, exactly
//   disc against the dark page, 3:1      ->  Y >= 0.11
//
// The first two are the same inequality because both compare the color against
// white. Y = 0.19 sits near the middle of the surviving window and lands every
// hue at roughly 4.4:1 on both grounds — comfortably past 3:1 in both directions
// rather than optimal in one.
//
// EQUAL LUMINANCE IS THE POINT. Seventeen categories have no rank, so a ring
// whose members differ in lightness would imply one. Fixing Y and varying only
// hue is what makes it a categorical palette rather than an accidental ramp.
//
// The chroma is the largest every hue can hold at that luminance — the ring is
// only as saturated as its weakest hue, or it stops being one ring. Yellow-green
// is the binding constraint, which is why the whole set reads slightly muted.
import { writeFileSync } from 'node:fs'

const COUNT = 17
const TARGET_Y = 0.19
const START_HUE = 25

// STRIDE 7, AND THE COPRIMALITY IS THE WHOLE TRICK. Walking the hue circle in
// steps of 360/17 would give consecutive roles neighboring hues, and the roles
// next to each other in the table are the ones most likely to end up next to
// each other in the chart. 7 and 17 share no factor, so a stride of 7 slots
// visits all seventeen evenly spaced hues — the ring is unchanged — while
// putting consecutive roles about 148 degrees apart.
const STRIDE = 7

const toSrgb = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)

function oklchToLinear(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

const inGamut = (rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005)
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const hex = (rgb) =>
  '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, toSrgb(v))) * 255).toString(16).padStart(2, '0')).join('')

/** The OKLab lightness that puts (C, h) on a given WCAG relative luminance. */
function solveL(C, h, targetY) {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (luminance(oklchToLinear(mid, C, h)) < targetY) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

const hueAt = (i) => (START_HUE + (i * STRIDE * 360) / COUNT) % 360

// The weakest hue sets the chroma for all seventeen.
let chroma = 0.4
for (let i = 0; i < COUNT; i++) {
  const h = hueAt(i)
  let lo = 0
  let hi = 0.4
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2
    const rgb = oklchToLinear(solveL(mid, h, TARGET_Y), mid, h)
    if (inGamut(rgb) && Math.abs(luminance(rgb) - TARGET_Y) < 1e-4) lo = mid
    else hi = mid
  }
  chroma = Math.min(chroma, lo)
}

const ring = []
for (let i = 0; i < COUNT; i++) {
  const h = hueAt(i)
  ring.push(hex(oklchToLinear(solveL(chroma, h, TARGET_Y), chroma, h)))
}

// Same order as ROLES in src/maps/roles.ts. Kept here as a literal rather than
// imported, because this file is plain ESM and roles.ts is TypeScript — the test
// is what holds the two lists together.
const ROLES = [
  'start', 'finish', 'home', 'meet', 'split', 'gas', 'charge', 'break', 'camp',
  'hotel', 'food', 'coffee', 'drinks', 'grocery', 'view', 'poi', 'wtf',
]

const width = Math.max(...ROLES.map((r) => r.length))
console.log(`OKLCH chroma ${chroma.toFixed(4)}, target Y ${TARGET_Y}, hue ${START_HUE} + ${STRIDE}/${COUNT} turns\n`)
for (let i = 0; i < COUNT; i++) {
  console.log(`  ${ROLES[i].padEnd(width)}: '${ring[i]}', // ${hueAt(i).toFixed(1).padStart(5)}°`)
}

if (process.argv.includes('--json')) {
  writeFileSync(new URL('./role-ring.json', import.meta.url), JSON.stringify(ring, null, 2))
}
