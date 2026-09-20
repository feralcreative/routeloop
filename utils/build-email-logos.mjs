// Regenerates the two email wordmarks in public/img/ from the SVGs beside them.
//
//   node utils/build-email-logos.mjs          # the plain wordmark
//   node utils/build-email-logos.mjs --beta   # the composite with the BETA sign hanging off it
//
// An email has no CSS to hang the sign with, so the beta lockup is baked into
// the raster there, from the composites Ziad drew — the one surface where the
// sign is not `.logo-beta` overlaid in the browser (see views/logo.tsx). Both
// files are OPAQUE on the card color they sit on (white, #000), which
// test/email-dark-mode.test.ts reads off the corner pixel: a transparent PNG
// disappears wherever a client repaints the cell behind it.
//
// The wordmark is rendered at 800px wide at 2x either way — the composite is
// wider and taller because of the sign, and LOGO_W/LOGO_H in
// src/emails/shell.tsx have to say the file's real size at 1x. This prints
// them. sharp rasterizes through librsvg, filters included.
import sharp from 'sharp'

const beta = process.argv.includes('--beta')

// The plain hz mark is 1500×184; in the composite it spans 988 of 1048, so
// 1048 × (800 / 988) keeps the word itself at the size it has always been.
const JOBS = beta
  ? [
      { src: 'public/img/logo-routeloop-hz-beta.svg', out: 'public/img/logo-routeloop-email-hz@2x.png', bg: '#ffffff' },
      {
        src: 'public/img/logo-routeloop-hz-dk-beta.svg',
        out: 'public/img/logo-routeloop-email-hz-dark@2x.png',
        bg: '#000000',
      },
    ]
  : [
      { src: 'public/img/logo-routeloop-hz.svg', out: 'public/img/logo-routeloop-email-hz@2x.png', bg: '#ffffff' },
      {
        src: 'public/img/logo-routeloop-hz-dk.svg',
        out: 'public/img/logo-routeloop-email-hz-dark@2x.png',
        bg: '#000000',
      },
    ]
const WIDTH = beta ? Math.round(1048 * (800 / 988)) : 800

for (const j of JOBS) {
  const info = await sharp(j.src, { density: 300 })
    .resize({ width: WIDTH })
    .flatten({ background: j.bg })
    .png()
    .toFile(j.out)
  console.log(
    `${j.out}  ${info.width}×${info.height} (${Math.round(info.width / 2)}×${Math.round(info.height / 2)} at 1x)`,
  )
}
console.log(
  `LOGO_W = ${Math.round(WIDTH / 2)}, LOGO_H = ${beta ? Math.round((WIDTH * 368) / 1048 / 2) : 50} in src/emails/shell.tsx`,
)
