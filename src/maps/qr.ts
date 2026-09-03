// A ride's share link as a scannable code (#226).
//
// THE CASE THIS IS FOR IS A CAR PARK, NOT A DESKTOP. Ziad's call, 2026-09-02:
// you turn up to a ride, half the group has not seen the route, and the way to
// hand it to six people at once is to hold up a phone. Everything below follows
// from that — it is rendered large, it is rendered on white, and it needs no
// network of its own once the page has loaded.
//
// SERVER-SIDE AND INLINE, rather than a CDN image service. A hosted QR endpoint
// would publish every ride slug this app ever renders a code for to a third
// party, which is a share link leaving the building for the sake of an <img>.
// Inline SVG also scales to whatever the sheet gives it with no second request.
import QRCode from 'qrcode'

/**
 * BLACK ON WHITE, ALWAYS, and deliberately not theme-aware.
 *
 * A camera reads a QR by contrast, and while the spec's decoders handle an
 * inverted code plenty of phone cameras in the wild do not. A dark-theme rider
 * holding up a white-on-black code to a stranger's phone is exactly the moment
 * this must not be the interesting choice. The card it sits on is painted white
 * in CSS for the same reason.
 */
const DARK = '#000000'
const LIGHT = '#ffffff'

/**
 * ERROR CORRECTION LEVEL M, the middle of the four.
 *
 * L makes the smallest code and gives up the redundancy that lets a camera read
 * it at an angle, off a screen, with a thumb over one corner — which is every
 * real scan here. H would survive more and makes the modules smaller at the same
 * physical size, which is the wrong trade when the code is being read across a
 * car park rather than off a sticker.
 */
const LEVEL = 'M' as const

/**
 * A ride's share URL as an inline SVG.
 *
 * `margin: 1` rather than the spec's 4-module quiet zone: the card around it
 * supplies the rest in CSS, and four modules of internal white on a small screen
 * is a quarter of the width spent on nothing.
 *
 * Returns null rather than throwing. A QR that will not generate must not take
 * a ride page down with it — the link itself is still on the page, and a missing
 * code is a missing convenience.
 */
export async function shareQr(url: string): Promise<string | null> {
  try {
    return await QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: LEVEL,
      margin: 1,
      color: { dark: DARK, light: LIGHT },
    })
  } catch (err) {
    console.error('[qr] could not render', err instanceof Error ? err.stack : err)
    return null
  }
}
