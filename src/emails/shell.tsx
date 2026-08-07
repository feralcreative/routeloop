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
// Templates supply a body fragment and nothing else. Everything from the doctype
// to the footer lives here once, so no two emails can drift apart.
import { APP_ORIGIN } from '../config'
import { esc } from '../views/esc'
import { CONTENT_WIDTH, COLORS, FONT_STACK } from './theme'
import type { EmailTemplate, Rendered } from './types'

// --- Primitives -------------------------------------------------------------
//
// Bodies are written from these rather than raw tags, so the Outlook-safe
// details (explicit line-height, mso-line-height-rule, color paired with a
// background) are decided once instead of per template.

const TEXT_BASE = `margin:0 0 16px;color:${COLORS.text};background-color:${COLORS.white};font-family:${FONT_STACK};font-size:16px;line-height:24px;mso-line-height-rule:exactly`

export function P({ children }: { children?: unknown }) {
  return <p style={TEXT_BASE}>{children}</p>
}

/** Secondary text. Smaller and quieter, for the line after the point. */
export function Muted({ children }: { children?: unknown }) {
  return (
    <p
      style={`margin:0 0 16px;color:${COLORS.muted};background-color:${COLORS.white};font-family:${FONT_STACK};font-size:14px;line-height:21px;mso-line-height-rule:exactly`}
    >
      {children}
    </p>
  )
}

/** An inline link. Always paired with a background-color — see the file header. */
export function A({ href, children }: { href: string; children?: unknown }) {
  return (
    <a href={href} style={`color:${COLORS.url};background-color:${COLORS.white};text-decoration:underline`}>
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

/**
 * The wordmark, as styled text rather than an image.
 *
 * Deliberate, and worth not "fixing" without reading this. A remote image is
 * blocked by default in a large share of clients, so a logo is the one element
 * guaranteed not to render on first open — and a transparent-background PNG
 * additionally vanishes in clients that force-invert the cell behind it. Text
 * always renders, in the brand color, at the right size, in dark mode, at any
 * width, and costs nothing.
 *
 * If this becomes an image it needs a NEW asset: ~360x104, opaque background,
 * PNG (no client renders SVG in email). The existing
 * public/img/logo-tankbag-horiz-light@2x.png is 2911x852 and 84 KB, which is an
 * absurd payload to put in every inbox. Whatever replaces this must still read
 * correctly with images disabled, which means alt text carrying the wordmark and
 * no information of any kind living only in the picture.
 */
function header(): string {
  return `<td style="padding:28px 32px 8px;background-color:${COLORS.white}">
        <a href="${APP_ORIGIN}" style="color:${COLORS.text};background-color:${COLORS.white};font-family:${FONT_STACK};font-size:26px;line-height:32px;font-weight:900;letter-spacing:-0.02em;text-decoration:none;mso-line-height-rule:exactly">tankbag<span style="color:${COLORS.url};background-color:${COLORS.white}">.</span></a>
      </td>`
}

function footer(): string {
  return `<td style="padding:8px 32px 32px;background-color:${COLORS.white};border-top:1px solid ${COLORS.grey}">
        <p style="margin:16px 0 0;color:${COLORS.muted};background-color:${COLORS.white};font-family:${FONT_STACK};font-size:13px;line-height:20px;mso-line-height-rule:exactly">
          Tankbag — plan the whole ride.<br>
          <a href="${APP_ORIGIN}" style="color:${COLORS.muted};background-color:${COLORS.white};text-decoration:underline">${APP_ORIGIN.replace(/^https?:\/\//, '')}</a>
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
     may be load-bearing. */
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  a { color: ${COLORS.url}; }
  @media only screen and (max-width: 620px) {
    .tb-pad { padding-left: 20px !important; padding-right: 20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:${COLORS.pageBg}">
<div style="display:none;font-size:1px;color:${COLORS.pageBg};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${esc(preheader)}${PREHEADER_PAD}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${COLORS.pageBg}">
  <tr>
    <td align="center" style="padding:24px 12px">
      <!--[if mso]><table role="presentation" align="center" width="${CONTENT_WIDTH}"><tr><td><![endif]-->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:${CONTENT_WIDTH}px;margin:0 auto;background-color:${COLORS.white};border-radius:6px">
        <tr>${header()}</tr>
        <tr>
          <td class="tb-pad" style="padding:8px 32px 8px;background-color:${COLORS.white}">
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
