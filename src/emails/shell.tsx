// The one email document, and the primitives templates build bodies from.
//
// Email is not the web and the differences are not stylistic. Outlook on Windows
// renders with Word's HTML engine, Gmail strips much of a <style> block and
// clips it entirely on long messages, and several mobile clients force-invert
// colors whatever you asked for. So:
//
//   - Layout is tables. Not flex, not grid, not a div with a max-width.
//   - Every style that MATTERS is an inline style= attribute. The <style> block
//     below may only ever *improve* a message that is already correct without
//     it, because a large minority of readers will never see it.
//   - Padding goes on a <td>. Word drops padding on a <div>.
//   - The design is light — white card, dark text. Clients that force-invert
//     produce something legible from that; force-inverting an already-dark
//     design yields grey mud.
//
// DARK MODE sits on top of that last point rather than replacing it, and the
// distinction is what keeps the rest of the file true. There are two populations
// and they are served by different mechanisms:
//
//   Clients that honour prefers-color-scheme (Apple Mail on both platforms is
//   the one that matters) get a real dark design, from the @media block below.
//
//   Clients that do not (Gmail everywhere, which applies its own inversion and
//   ignores the query) still get the light design and still invert it cleanly,
//   exactly as before.
//
// So the light values stay inline and stay correct standalone, the dark ones
// exist ONLY inside the media query, and the media query overrides with
// !important because that is what beats an inline declaration in the cascade.
// Nothing dark is load-bearing. Deleting the whole <style> block would still
// leave every message correct, which is the rule this file has always followed.
//
// Templates supply a body fragment and nothing else. Everything from the doctype
// to the footer lives here once, so no two emails can drift apart.
import { APP_ORIGIN } from '../config'
import { esc } from '../views/esc'
import { CONTENT_WIDTH, COLORS, DARK, FONT_STACK } from './theme'
import type { EmailTemplate, Rendered } from './types'

// --- Primitives -------------------------------------------------------------
//
// Bodies are written from these rather than raw tags, so the Outlook-safe
// details (explicit line-height, mso-line-height-rule, color paired with a
// background) are decided once instead of per template.

// Each primitive also carries a `tb-` class. The class is inert in every client
// that does not do dark mode and is the ONLY handle the @media block has, since
// an inline style cannot itself be conditional. Adding a primitive means adding
// it to that block too, or it will stay light-on-dark.

const TEXT_BASE = `margin:0 0 16px;color:${COLORS.text};background-color:${COLORS.white};font-family:${FONT_STACK};font-size:16px;line-height:24px;mso-line-height-rule:exactly`

export function P({ children }: { children?: unknown }) {
  return (
    <p class="tb-text" style={TEXT_BASE}>
      {children}
    </p>
  )
}

/** Secondary text. Smaller and quieter, for the line after the point. */
export function Muted({ children }: { children?: unknown }) {
  return (
    <p
      class="tb-muted"
      style={`margin:0 0 16px;color:${COLORS.muted};background-color:${COLORS.white};font-family:${FONT_STACK};font-size:14px;line-height:21px;mso-line-height-rule:exactly`}
    >
      {children}
    </p>
  )
}

/** An inline link. Always paired with a background-color — see the file header. */
export function A({ href, children }: { href: string; children?: unknown }) {
  return (
    <a
      href={href}
      class="tb-link"
      style={`color:${COLORS.url};background-color:${COLORS.white};text-decoration:underline`}
    >
      {children}
    </a>
  )
}

/**
 * The call to action.
 *
 * A table, not a styled <a>, because Word ignores padding on an inline element
 * and would render the label with no button around it. Outlook shows this with
 * square corners — border-radius is one of the properties Word drops — and that
 * is an acceptable outcome rather than a reason to hand-write VML for it.
 *
 * Every Button's href must also appear in the template's text() arm. A CTA that
 * exists only as a button is invisible to a plain-text reader, and
 * test/emails.test.ts asserts it.
 *
 * No dark-mode class, deliberately: this is the one element that already carries
 * its own opaque background, so white-on-$url is 5.7:1 whatever the card behind
 * it is doing. Lifting it to DARK.url would also mean dark label text, i.e. a
 * differently-colored primary button in half of all inboxes, which is a bigger
 * change to the brand than the 3.5:1 it sits at against the dark card — and that
 * figure is the button's edge against its surround, where 3:1 is the bar, not
 * the label against the button.
 */
export function Button({ href, children }: { href: string; children?: unknown }) {
  return (
    <table cellpadding="0" cellspacing="0" border={0} role="presentation" style="margin:0 0 24px">
      <tr>
        <td bgcolor={COLORS.url} style={`border-radius:4px;background-color:${COLORS.url}`}>
          <a
            href={href}
            style={`display:inline-block;padding:14px 28px;color:${COLORS.white};background-color:${COLORS.url};font-family:${FONT_STACK};font-size:16px;line-height:20px;font-weight:700;text-decoration:none;mso-line-height-rule:exactly`}
          >
            {children}
          </a>
        </td>
      </tr>
    </table>
  )
}

// --- The document -----------------------------------------------------------

// Gmail and Apple Mail show this after the subject in the message list. Without
// the padding the client spills the first line of the body in after it, so the
// preview reads "…on the list.Hi there —". The entities are invisible and are
// there purely to fill that space.
const PREHEADER_PAD = '&zwnj;&nbsp;'.repeat(60)

// The wordmark, one asset per scheme.
//
// Both are 360x103 and about 6 KB, drawn for this purpose — not the site's
// logo-tankbag-horiz-light@2x.png, which is 2911x852 and 84 KB and has no place
// in an inbox. Displayed at half size, so the source is the 2x asset.
//
// Both are also OPAQUE, which is the property that makes this work at all and
// is worth checking before swapping either file. A transparent PNG disappears
// wherever the client repaints the cell behind it; these carry their own ground
// (white / #000), so each one is correct on its own regardless of what the
// client does to the surrounding table.
const LOGO_W = 180
const LOGO_H = 52
const LOGO_LIGHT = `${APP_ORIGIN}/img/logo-tankbag-email-horiz.png`
const LOGO_DARK = `${APP_ORIGIN}/img/logo-tankbag-email-horiz-dark.png`

/**
 * The header wordmark.
 *
 * This used to be styled text, on the grounds that a remote image is blocked by
 * default in a large share of clients and so is the one element guaranteed not
 * to render on first open. That is still true, and it is why every style below
 * that governs ALT TEXT — font, size, weight, color — is set on the <img> itself
 * rather than the cell. With images off, a client draws the alt string using the
 * image's own styles, so "tankbag." still renders in brand-ish shape at roughly
 * the right size. The picture carries no information that is not in the alt.
 *
 * The dark copy is a second <img> in a hidden <div> that the media query
 * un-hides, rather than a CSS background-image swap, because background-image is
 * stripped by Gmail and ignored by Word — a background swap would show nothing
 * at all in the clients that most need a fallback.
 *
 * `mso-hide:all` AND the conditional comment are both here on purpose: Word
 * honours neither display:none nor max-height reliably, and being wrong shows
 * the reader two logos stacked. The belt-and-braces costs one comment.
 */
function header(): string {
  const img = (src: string) =>
    `<img src="${src}" width="${LOGO_W}" height="${LOGO_H}" alt="tankbag." style="display:block;width:${LOGO_W}px;height:${LOGO_H}px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;color:${COLORS.text};background-color:${COLORS.white};font-family:${FONT_STACK};font-size:26px;line-height:${LOGO_H}px;font-weight:900;letter-spacing:-0.02em;mso-line-height-rule:exactly">`

  return `<td class="tb-cell" style="padding:28px 32px 8px;background-color:${COLORS.white}">
        <div class="tb-logo-light"><a href="${APP_ORIGIN}" style="text-decoration:none">${img(LOGO_LIGHT)}</a></div>
        <!--[if !mso]><!-->
        <div class="tb-logo-dark" style="display:none;mso-hide:all;font-size:0;line-height:0;max-height:0;overflow:hidden"><a href="${APP_ORIGIN}" style="text-decoration:none">${img(LOGO_DARK)}</a></div>
        <!--<![endif]-->
      </td>`
}

function footer(): string {
  return `<td class="tb-cell tb-foot" style="padding:8px 32px 32px;background-color:${COLORS.white};border-top:1px solid ${COLORS.grey}">
        <p class="tb-muted" style="margin:16px 0 0;color:${COLORS.muted};background-color:${COLORS.white};font-family:${FONT_STACK};font-size:13px;line-height:20px;mso-line-height-rule:exactly">
          Tankbag — plan the whole ride.<br>
          <a href="${APP_ORIGIN}" class="tb-muted" style="color:${COLORS.muted};background-color:${COLORS.white};text-decoration:underline">${APP_ORIGIN.replace(/^https?:\/\//, '')}</a>
        </p>
      </td>`
}

/**
 * Renders a template into the three parts a send needs.
 *
 * The HTML arm is assembled as a template literal rather than JSX because the
 * scaffold is mostly conditional comments and a doctype — things JSX would fight
 * — and because the exact bytes that reach Outlook stay greppable this way. The
 * template's own body IS JSX, and therefore escaped; only the trusted scaffold
 * is written by hand here.
 */
export function renderEmail<P>(t: EmailTemplate<P>, props: P): Rendered {
  const body = t.html(props)
  const preheader = t.preheader(props)

  const html = `<!doctype html>
<html lang="en-US" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<title>${esc(t.subject(props))}</title>
<style>
  /* Enhancement only. Every rule that MATTERS is inline on its element — Gmail
     clips this block on long messages and Word ignores most of it. Nothing here
     may be load-bearing, and that includes everything under the dark-mode query:
     a client that drops this block gets the light design, which is complete. */
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  a { color: ${COLORS.url}; }
  @media only screen and (max-width: 620px) {
    .tb-pad { padding-left: 20px !important; padding-right: 20px !important; }
  }
  /* !important throughout, because an author !important is the one thing that
     outranks the inline styles these are overriding. */
  @media (prefers-color-scheme: dark) {
    .tb-body, .tb-page { background-color: ${DARK.pageBg} !important; }
    .tb-card, .tb-cell { background-color: ${DARK.cardBg} !important; }
    .tb-text { color: ${DARK.text} !important; background-color: ${DARK.cardBg} !important; }
    .tb-muted { color: ${DARK.muted} !important; background-color: ${DARK.cardBg} !important; }
    .tb-link { color: ${DARK.url} !important; background-color: ${DARK.cardBg} !important; }
    .tb-foot { border-top-color: ${DARK.border} !important; }
    /* The swap. Sizes are restored as well as display, because the dark copy is
       collapsed to zero rather than merely hidden — see header(). */
    .tb-logo-light { display: none !important; }
    .tb-logo-dark {
      display: block !important;
      max-height: none !important;
      overflow: visible !important;
      font-size: 26px !important;
      line-height: ${LOGO_H}px !important;
    }
    /* Only reached with images OFF, where the client draws the alt string using
       the image's own styles — which are inline, and therefore light. */
    .tb-logo-dark img { color: ${DARK.text} !important; background-color: ${DARK.cardBg} !important; }
  }
</style>
</head>
<body class="tb-body" style="margin:0;padding:0;width:100%;background-color:${COLORS.pageBg}">
<div style="display:none;font-size:1px;color:${COLORS.pageBg};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${esc(preheader)}${PREHEADER_PAD}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="tb-page" style="background-color:${COLORS.pageBg}">
  <tr>
    <td align="center" style="padding:24px 12px">
      <!--[if mso]><table role="presentation" align="center" width="${CONTENT_WIDTH}"><tr><td><![endif]-->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="tb-card" style="max-width:${CONTENT_WIDTH}px;margin:0 auto;background-color:${COLORS.white};border-radius:6px">
        <tr>${header()}</tr>
        <tr>
          <td class="tb-pad tb-cell" style="padding:8px 32px 8px;background-color:${COLORS.white}">
${body}
          </td>
        </tr>
        <tr>${footer()}</tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`

  return { subject: t.subject(props), text: t.text(props), html }
}
