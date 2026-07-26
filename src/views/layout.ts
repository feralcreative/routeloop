// The one HTML shell. Chrome pages and full-bleed map pages used to build their
// documents separately — four near-identical heads, two disjoint stylesheets,
// and no header at all on the builder or viewer, which is why there was no way
// back to the site from a map. `variant` is what that split collapses into.
import { MAPBOX_GL_VERSION } from '../config'
import type { UserRow } from '../db/schema'
import { alphaSplash } from './splash'

export { esc } from './esc'
import { esc } from './esc'

export const SITE_ICON_LINKS = `<link rel="icon" type="image/png" href="/img/favicon-96x96.png" sizes="96x96">
  <link rel="icon" type="image/svg+xml" href="/img/favicon.svg">
  <link rel="shortcut icon" href="/favicon.ico">
  <link rel="apple-touch-icon" sizes="180x180" href="/img/apple-touch-icon.png">
  <link rel="manifest" href="/img/site.webmanifest">`

// Inlining JSON into a <script> is only safe if the payload cannot close the
// tag. `</script>` inside any string would end the block and drop the rest of
// the document into HTML; U+2028/2029 are literal newlines to a JS parser.
export function jsonScript(varName: string, value: unknown): string {
  const json = JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `<script>window.${varName} = ${json};</script>`
}

// Mapbox pages pass this as `head`. Kept here so the version stays pinned to
// the same constant the <script> tag uses.
export const MAPBOX_CSS_LINK = `<link href="https://api.mapbox.com/mapbox-gl-js/${MAPBOX_GL_VERSION}/mapbox-gl.css" rel="stylesheet">`

export type PageVariant = 'chrome' | 'map' | 'splash'
export type NavKey = 'home' | 'rides' | 'builder' | 'places'

export type PageOpts = {
  /** Without the " — routeloop" suffix; page() appends it. */
  title: string
  user: UserRow | null
  body: string
  /**
   * 'map' drops the reading-width wrapper and floats the header. 'splash' keeps
   * the wrapper but renders no header at all — it is the landing surface, where
   * the nav would only offer the page you are already on.
   */
  variant?: PageVariant
  bodyClass?: string
  navKey?: NavKey
  /**
   * Extra <link>/<meta> for the head. Engine-specific assets belong here, not
   * behind `variant` — the legacy Google viewer is a map page that must not
   * load the Mapbox stylesheet. Use MAPBOX_CSS_LINK for the Mapbox pages.
   */
  head?: string
  /** Extra <script> tags, emitted last. */
  scripts?: string
  /** Serialized to window.TB via jsonScript. */
  tb?: Record<string, unknown>
  /** Set false to suppress the alpha modal on a page. */
  splash?: boolean
  /** Plain message; page() supplies the <noscript> wrapper and markup. */
  noscript?: string
}

const NAV_LINKS: { key: NavKey; href: string; label: string }[] = [
  { key: 'home', href: '/', label: 'Home' },
  { key: 'builder', href: '/builder', label: 'Plan a ride' },
  { key: 'rides', href: '/dashboard', label: 'Your rides' },
]

function navLink(item: { key: NavKey; href: string; label: string }, navKey?: NavKey): string {
  const current = item.key === navKey ? ' aria-current="page"' : ''
  return `<a href="${item.href}"${current}>${esc(item.label)}</a>`
}

function siteHeader(user: UserRow | null, navKey?: NavKey): string {
  const links = user
    ? `${NAV_LINKS.map((l) => navLink(l, navKey)).join('')}
      <hr>
      <span class="nav-user">${esc(user.displayName)}</span>
      <form method="post" action="/logout"><button class="linkbtn" type="submit">Sign out</button></form>`
    : `${navLink(NAV_LINKS[0], navKey)}<a href="/login">Sign in</a>`

  return `<header class="site-header" id="site-header">
  <a class="site-logo" href="/"><img src="/img/logo-routeloop-horiz.svg" alt="routeloop" width="849" height="104"></a>
  <button class="nav-toggle" type="button" aria-label="Menu" aria-expanded="false" aria-controls="site-nav">
    <span class="nav-bars" aria-hidden="true"></span>
  </button>
  <nav class="site-nav" id="site-nav" hidden>
    ${links}
    <hr>
    <button type="button" class="linkbtn" data-open-alpha>About this alpha</button>
  </nav>
</header>`
}

// The floating map panel scaffold, previously copy-pasted into all three map
// shells. map-common.js binds the collapse toggle by these class names.
export function panelShell(o: { title?: string; extraClass?: string; contents: string }): string {
  const cls = o.extraClass ? ` ${o.extraClass}` : ''
  return `<div id="info-panel" class="floating-panel${cls}">
    <button class="collapse-toggle" aria-label="Collapse panel">
      <img src="/img/icons/icon-collapse.svg" alt="Collapse" class="collapse-icon">
    </button>
    ${o.title ? `<h1 class="panel-title">${esc(o.title)}</h1>` : ''}
    <div class="panel-contents-wrapper">
      <div class="panel-content">
${o.contents}
      </div>
    </div>
  </div>`
}

export function page(opts: PageOpts): string {
  const variant: PageVariant = opts.variant ?? 'chrome'
  const isMap = variant === 'map'
  const htmlClass = isMap ? ' class="map-page"' : ''
  const bodyClass = [
    isMap ? 'map-page' : '',
    variant === 'splash' ? 'splash-page' : '',
    opts.bodyClass ?? '',
  ]
    .filter(Boolean)
    .join(' ')
  const title = `${esc(opts.title)} — routeloop`
  const body = isMap ? opts.body : `<div class="page-wrap">\n${opts.body}\n</div>`

  return `<!doctype html>
<html lang="en-US"${htmlClass}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${SITE_ICON_LINKS}
  <meta property="og:title" content="${title}">
  <meta property="og:type" content="website">
  <meta property="og:image" content="/img/logo-routeloop-horiz@2x.png">
  <meta name="twitter:card" content="summary_large_image">
  <link href="https://fonts.googleapis.com/css?family=Lato:300,400,700,900" rel="stylesheet">
  <link rel="stylesheet" href="/style/main.min.css">${opts.head ? `\n  ${opts.head}` : ''}
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${variant === 'splash' ? '' : siteHeader(opts.user, opts.navKey)}
${body}
${opts.splash === false ? '' : alphaSplash()}
${opts.noscript ? `<noscript><p style="padding:1em">${esc(opts.noscript)}</p></noscript>` : ''}
${opts.tb ? jsonScript('TB', opts.tb) : ''}
<script src="/js/site.js" defer></script>
${opts.scripts ?? ''}
</body>
</html>`
}
