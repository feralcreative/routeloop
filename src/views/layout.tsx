// The one HTML shell. Chrome pages and full-bleed map pages used to build their
// documents separately — four near-identical heads, two disjoint stylesheets,
// and no header at all on the builder or viewer, which is why there was no way
// back to the site from a map. `variant` is what that split collapses into.
import type { UserRow } from '../db/schema'
import { alphaSplash } from './splash'

export { esc } from './esc'
import { esc } from './esc'
import { raw } from 'hono/html'
import { asset } from './assets'

// A function rather than a const so each icon carries a fresh content hash. The
// root /favicon.ico is requested by browsers directly and cannot be versioned.
export function siteIconLinks(): string {
  return `<link rel="icon" type="image/png" href="${asset('/img/favicon/favicon-96x96.png')}" sizes="96x96">
  <link rel="icon" type="image/svg+xml" href="${asset('/img/favicon/favicon.svg')}">
  <link rel="shortcut icon" href="/favicon.ico">
  <link rel="apple-touch-icon" sizes="180x180" href="${asset('/img/favicon/apple-touch-icon.png')}">
  <link rel="manifest" href="${asset('/img/site.webmanifest')}">`
}

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

// Google's inline bootstrap loader, verbatim from their docs, which defines
// google.maps.importLibrary() and nothing else. Map pages emit this instead of
// a plain <script src=…&callback=…> because the engine imports "maps", "marker"
// and "places" separately and on demand — the marker library in particular is
// what Advanced Markers need and what the old callback form could not defer.
//
// The key is public by design (it ships in page source; the referrer allow-list
// is the only control on it), but it still goes through JSON.stringify so a
// malformed value cannot break out of the string literal.
export function googleMapsLoader(key: string): string {
  return `<script>
  (g=>{var h,a,k,p="The Google Maps JavaScript API",c="google",l="importLibrary",q="__ib__",m=document,b=window;b=b[c]||(b[c]={});var d=b.maps||(b.maps={}),r=new Set,e=new URLSearchParams,u=()=>h||(h=new Promise(async(f,n)=>{await (a=m.createElement("script"));e.set("libraries",[...r]+"");for(k in g)e.set(k.replace(/[A-Z]/g,t=>"_"+t[0].toLowerCase()),g[k]);e.set("callback",c+".maps."+q);a.src=\`https://maps.\${c}apis.com/maps/api/js?\`+e;d[q]=f;a.onerror=()=>h=n(Error(p+" could not load."));a.nonce=m.querySelector("script[nonce]")?.nonce||"";m.head.append(a)}));d[l]?console.warn(p+" only loads once. Ignoring:",g):d[l]=(f,...n)=>r.add(f)&&u().then(()=>d[l](f,...n))})({
    key: ${JSON.stringify(key).replace(/</g, '\\u003c')},
    v: "weekly",
  });
  </script>`
}

export type PageVariant = 'chrome' | 'map' | 'splash'
export type NavKey = 'home' | 'explore' | 'riders' | 'rides' | 'builder' | 'import' | 'places' | 'profile' | 'admin'

export type PageOpts = {
  /** Without the " — Tankbag" suffix; page() appends it. */
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
   * Extra <link>/<meta> for the head, for anything a single page needs and the
   * rest do not.
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
  { key: 'explore', href: '/explore', label: 'Explore' },
  { key: 'riders', href: '/riders', label: 'Riders' },
  { key: 'builder', href: '/builder', label: 'Plan a ride' },
  { key: 'import', href: '/import', label: 'Import a route' },
  { key: 'rides', href: '/dashboard', label: 'Your rides' },
  { key: 'profile', href: '/profile', label: 'Your profile' },
]

function NavLink({ item, navKey }: { item: { key: NavKey; href: string; label: string }; navKey?: NavKey }) {
  return (
    <a href={item.href} aria-current={item.key === navKey ? 'page' : undefined}>
      {item.label}
    </a>
  )
}

function SiteHeader({ user, navKey, isMap = false }: { user: UserRow | null; navKey?: NavKey; isMap?: boolean }) {
  // A map page gives the header a floating badge in the corner rather than a
  // full-width bar, and the stacked mark suits that shape: at a legible height
  // it is 62px wide against the horizontal lockup's 102px, so it takes less of
  // the map. Both are the light (black-on-transparent) artwork, which is what
  // the panel backing in _nav.scss exists to keep legible over terrain.
  const logo = isMap
    ? { src: '/img/logo-tankbag-vert-light.svg', w: 871, h: 618 }
    : { src: '/img/logo-tankbag-horiz-light.svg', w: 1414, h: 426 }

  return (
    <header class="site-header" id="site-header">
      <a class="site-logo" href="/">
        <img src={logo.src} alt="Tankbag" width={logo.w} height={logo.h} />
      </a>
      <button class="nav-toggle" type="button" aria-label="Menu" aria-expanded="false" aria-controls="site-nav">
        <span class="nav-bars" aria-hidden="true"></span>
      </button>
      <nav class="site-nav" id="site-nav" hidden>
        {user ? (
          <>
            {NAV_LINKS.map((l) => (
              <NavLink item={l} navKey={navKey} />
            ))}
            {/*
              Rider management is the only nav item that is capability-gated
              rather than shown to every signed-in rider, so it is appended here
              instead of living in the static NAV_LINKS list.
            */}
            {user.canManageRiders && (
              <NavLink item={{ key: 'admin', href: '/admin', label: 'Riders' }} navKey={navKey} />
            )}
            <hr />
            <span class="nav-user">{user.displayName}</span>
            <form method="post" action="/logout">
              <button class="linkbtn" type="submit">
                Sign out
              </button>
            </form>
          </>
        ) : (
          <>
            <NavLink item={NAV_LINKS[0]} navKey={navKey} />
            {/*
              "Join the beta", not "Sign in". Nobody can sign themselves in —
              alpha is developers and beta is invite-only — so a nav that offers
              sign-in contradicts the page it links to. Approved riders returning
              from a signed-out session land on the same page through the same
              controls, and /login says so directly under them.
            */}
            <a href="/login">Join the beta</a>
          </>
        )}
        <hr />
        <NavAboutMenu />
      </nav>
    </header>
  )
}

// The floating map panel scaffold, previously copy-pasted into all three map
// shells. map-common.js binds the collapse toggle by these class names.
export function panelShell(o: { title?: string; extraClass?: string; contents: string }): string {
  return (
    <div id="info-panel" class={`floating-panel${o.extraClass ? ` ${o.extraClass}` : ''}`}>
      <button type="button" class="collapse-toggle" aria-label="Collapse panel">
        <img src="/img/icons/icon-collapse.svg" alt="Collapse" class="collapse-icon" />
      </button>
      {o.title && <h1 class="panel-title">{o.title}</h1>}
      <div class="panel-contents-wrapper">
        {/* Already-rendered markup from the caller, hence raw(). */}
        <div class="panel-content">{raw(o.contents)}</div>
      </div>
    </div>
  ).toString()
}

// Legal and help links. Rendered on chrome pages as a footer and on the splash
// as a single quiet row — a map page has no room and gets them from the nav
// menu instead. /privacy in particular has to be reachable without signing in:
// Google's consent screen review fetches it anonymously.
const SITE_LINKS: { href: string; label: string }[] = [
  { href: '/faq', label: 'Questions' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
]

// A "?" beside a control, linking to the answer that defines it.
//
// The FAQ already explains what a POI is and what "unlisted" means; before this
// the only way to find that out was to guess the FAQ had an answer, leave the
// builder, and go looking. The ids in pages.ts are a deliberate contract for
// exactly this — see the qa() helper there.
//
// Opens in a new tab, always. Every one of these currently sits in the builder,
// where following a link means abandoning an unsaved ride: the beforeunload
// guard would catch it, but making someone answer "are you sure" to read a
// definition is a bad trade.
export const faqLink = (anchor: string, what: string): string =>
  (
    <a
      class="faq-link"
      href={`/faq#${anchor}`}
      target="_blank"
      rel="noopener"
      title={`What is ${what}?`}
      aria-label={`What is ${what}? Opens the questions page in a new tab`}
    >
      ?
    </a>
  ).toString()

const SiteLinkRow = () => (
  <>
    {SITE_LINKS.map((l) => (
      <a href={l.href}>{l.label}</a>
    ))}
  </>
)

// The same three links plus the alpha modal, folded into one disclosure. The
// nav was a flat run of nine items where the last four are all "about this
// thing" rather than "go somewhere in the app"; grouping them puts the rider's
// own pages at the top and keeps the menu one screen tall.
//
// <details> rather than a JS menu: it is a disclosure, and the platform already
// handles the keyboard and the ARIA for one.
const NavAboutMenu = () => (
  <details class="nav-sub">
    <summary>About</summary>
    <div class="nav-sub-items">
      <button type="button" class="linkbtn" data-open-alpha>
        About this app
      </button>
      <SiteLinkRow />
    </div>
  </details>
)

function siteFooter(splash: boolean): string {
  // The splash is a signed-out landing page over video: it gets the links and
  // nothing else. A closing note there would compete with the sign-in controls.
  return (
    <footer class={`site-footer${splash ? ' is-splash' : ''}`}>
      <nav class="site-footer-links">
        <SiteLinkRow />
      </nav>
      {!splash && <p class="site-footer-note">Tankbag is in a closed alpha.</p>}
    </footer>
  ).toString()
}

export function page(opts: PageOpts): string {
  const variant: PageVariant = opts.variant ?? 'chrome'
  const isMap = variant === 'map'
  const htmlClass = isMap ? ' class="map-page"' : ''
  const bodyClass = [isMap ? 'map-page' : '', variant === 'splash' ? 'splash-page' : '', opts.bodyClass ?? '']
    .filter(Boolean)
    .join(' ')
  const title = `${esc(opts.title)} — Tankbag`
  const body = isMap ? opts.body : `<div class="page-wrap">\n${opts.body}\n${siteFooter(variant === 'splash')}\n</div>`

  return `<!doctype html>
<html lang="en-US"${htmlClass}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${siteIconLinks()}
  <meta property="og:title" content="${title}">
  <meta property="og:type" content="website">
  <meta property="og:image" content="${asset('/img/logo-tankbag-horiz-light@2x.png')}">
  <meta name="twitter:card" content="summary_large_image">
  <link href="https://fonts.googleapis.com/css?family=Lato:300,400,700,900" rel="stylesheet">
  <link rel="stylesheet" href="${asset('/style/main.min.css')}">${opts.head ? `\n  ${opts.head}` : ''}
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${variant === 'splash' ? '' : (<SiteHeader user={opts.user} navKey={opts.navKey} isMap={isMap} />).toString()}
${body}
${opts.splash === false ? '' : alphaSplash()}
${opts.noscript ? `<noscript><p style="padding:1em">${esc(opts.noscript)}</p></noscript>` : ''}
${opts.tb ? jsonScript('TB', opts.tb) : ''}
<script src="${asset('/js/site.js')}" defer></script>
${opts.scripts ?? ''}
</body>
</html>`
}
