// Regenerates every derived icon in public/img/favicon/ from the two source
// SVGs beside them. Run it after redrawing the mark:
//
//   node utils/build-favicons.mjs
//
// It exists because the derived set is eight files in four shapes, and doing
// them by hand is how half of them end up a rebrand behind the other half —
// which is exactly the state this script was written to clear.
//
// rsvg-convert does the rasterizing (brew install librsvg). It is checked for up
// front and the script dies if it is missing, rather than skipping a file and
// leaving the previous brand's icon in place.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The sources live in the repo, next to what they generate. They used to sit in
// `_assets/`, which is Ziad's raw creative folder and is deliberately NOT
// committed — so this script broke the moment anyone else cloned, and so did the
// test that compared the served logos against it. Anything the build or the
// suite needs belongs under public/; `_assets/` is where work happens, not where
// the repo reads from.
//
// `source-` names them apart from the eight derived files in the same folder.
// The script only ever writes those eight, so the sources sitting beside them
// are safe from it.
const SRC_LIGHT = 'public/img/favicon/source-light.svg'
const SRC_DARK = 'public/img/favicon/source-dark.svg'
const OUT = 'public/img/favicon'

// The road color in each source. The two SVGs are otherwise identical, which is
// what lets one served favicon.svg cover both schemes — see darkModeSvg below.
const ROAD_LIGHT = '#333333'
const ROAD_DARK = '#666666'

// $accent in style/_tokens.scss. The maskable ground, and not a coincidence: the
// token was lifted from this wordmark's dashed center line in the first place.
const ACCENT = '#ffdd00'

// Android crops a maskable icon to whatever shape the launcher likes, and only
// the middle 80% is guaranteed to survive. The mark is 2:1 inside a square
// canvas, so its height is the axis with room to spare and the width is the one
// this is actually protecting.
const SAFE = 0.8

function need(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'pipe' })
  } catch {
    throw new Error(`${cmd} is not installed — brew install librsvg`)
  }
}

/** Rasterize an SVG file to a square PNG of the given size. */
function render(svgPath, size, outPath) {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', outPath, svgPath])
}

/** Rasterize to a Buffer instead of a file — for the .ico payloads. */
function renderBuffer(svgPath, size) {
  return execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svgPath], {
    maxBuffer: 1 << 24,
  })
}

/**
 * The served favicon.svg: the light artwork, plus one rule that swaps the road
 * to the dark-ground color when the browser chrome is dark.
 *
 * A class rather than two files, because the pair differs in exactly one fill
 * and a tab icon cannot pick between two hrefs the way a <picture> can.
 */
function darkModeSvg() {
  const src = readFileSync(SRC_LIGHT, 'utf8')
  const road = `fill="${ROAD_LIGHT}"`
  if (!src.includes(road)) throw new Error(`${SRC_LIGHT}: no ${road} to key the dark rule on`)
  const style = `<style>@media (prefers-color-scheme: dark){.road{fill:${ROAD_DARK}}}</style>`
  return src
    .replace(road, `${road} class="road"`)
    .replace(/(<svg[^>]*>)/, `$1\n${style}`)
}

/**
 * A maskable icon: the mark at 80%, centered, on an opaque accent ground.
 *
 * Built as a wrapper around the source's own markup rather than a second
 * drawing, so it cannot drift from the icon it is a variant of.
 */
function maskableSvg() {
  const src = readFileSync(SRC_LIGHT, 'utf8')
  const inner = src.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  const offset = (1000 * (1 - SAFE)) / 2
  return `<svg width="1000" height="1000" viewBox="0 0 1000 1000" xmlns="http://www.w3.org/2000/svg">
<rect width="1000" height="1000" fill="${ACCENT}"/>
<g transform="translate(${offset} ${offset}) scale(${SAFE})">${inner}</g>
</svg>`
}

/**
 * A PNG-payload .ico.
 *
 * The format is a 6-byte header, one 16-byte directory entry per image, then
 * the images end to end. Every entry here is a whole PNG file, which Windows has
 * accepted since Vista and every browser in use accepts — so this needs no
 * encoder of its own and therefore no dependency.
 */
function ico(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(pngs.length, 4)

  const dir = Buffer.alloc(16 * pngs.length)
  let offset = header.length + dir.length
  pngs.forEach(({ size, data }, i) => {
    const e = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, e) // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1)
    dir.writeUInt8(0, e + 2) // palette size, 0 for truecolor
    dir.writeUInt8(0, e + 3) // reserved
    dir.writeUInt16LE(1, e + 4) // color planes
    dir.writeUInt16LE(32, e + 6) // bits per pixel
    dir.writeUInt32LE(data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += data.length
  })

  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)])
}

need('rsvg-convert')

const tmp = mkdtempSync(join(tmpdir(), 'routeloop-icons-'))
try {
  // The transparent set. Sized for what asks for each: 96 is the tab icon Safari
  // and Firefox reach for, 180 is what iOS pins to a home screen, and the two
  // manifest sizes are the pair Chrome documents as the minimum.
  render(SRC_LIGHT, 96, `${OUT}/favicon-96x96.png`)
  render(SRC_LIGHT, 180, `${OUT}/apple-touch-icon.png`)
  render(SRC_LIGHT, 192, `${OUT}/web-app-manifest-192x192.png`)
  render(SRC_LIGHT, 512, `${OUT}/web-app-manifest-512x512.png`)

  const maskable = join(tmp, 'maskable.svg')
  writeFileSync(maskable, maskableSvg())
  render(maskable, 192, `${OUT}/maskable-192x192.png`)
  render(maskable, 512, `${OUT}/maskable-512x512.png`)

  // 16/32/48 is the whole useful range for an .ico now: it is only reached by
  // the bare /favicon.ico request, which is a legacy client or a crawler.
  const sizes = [16, 32, 48]
  writeFileSync(
    `${OUT}/favicon.ico`,
    ico(sizes.map((size) => ({ size, data: renderBuffer(SRC_LIGHT, size) })))
  )

  writeFileSync(`${OUT}/favicon.svg`, darkModeSvg())

  // Read, so the check is of the file on disk rather than of what was meant to
  // be written to it.
  if (!readFileSync(SRC_DARK, 'utf8').includes(ROAD_DARK)) {
    throw new Error(`${SRC_DARK}: ${ROAD_DARK} is gone — the dark rule in favicon.svg is now a guess`)
  }

  console.log(`wrote 8 files to ${OUT}/`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
