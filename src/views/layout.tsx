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
import { IS_DEV } from '../config'
import { liveReloadScript } from '../dev/livereload'

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
export type NavKey =
  | 'home'
  | 'explore'
  | 'riders'
  | 'rides'
  | 'builder'
  | 'import'
  | 'places'
  | 'profile'
  | 'settings'
  | 'admin'
  | 'approvals'
  | 'invites'
  | 'survey'
  | 'survey-results'

export type PageOpts = {
  /** Without the " – Tankbag" suffix; page() appends it. */
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

// The menu, exactly as docs/main-menu.md specifies it. That file is the spec and
// this is the implementation; change the spec first.
//
// No Home entry on purpose — the logo goes there and duplicating it spends a
// slot in the bar on the one destination nobody has to be told about.
type NavItem = { key: NavKey; href: string; label: string }

const RIDES_LINKS: NavItem[] = [
  { key: 'rides', href: '/dashboard', label: 'Your rides' },
  { key: 'builder', href: '/builder', label: 'Plan a ride' },
  { key: 'explore', href: '/explore', label: 'Find a ride' },
  { key: 'import', href: '/import', label: 'Import / Export' },
]

const ADMIN_LINKS: NavItem[] = [
  { key: 'admin', href: '/admin', label: 'Admin' },
  { key: 'approvals', href: '/admin/approvals', label: 'Approvals' },
  { key: 'invites', href: '/admin/invites', label: 'Invitations' },
  { key: 'survey-results', href: '/admin/survey', label: 'Survey results' },
]

const RIDERS_LINK: NavItem = { key: 'riders', href: '/riders', label: 'Riders' }

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
  // it is 131px wide against the horizontal lockup's 168px, so it takes less of
  // the map.
  //
  // Both are the unsuffixed artwork. The suffix names the *background*, not the
  // ink: no suffix is the black lockup for a light ground, `-dark` is the
  // reversed white one for a dark ground. It reads backwards at a glance, which
  // is why it is written down — but it is the convention src/emails/shell.tsx
  // was already using, so the alternative was two conventions instead of one.
  const logo = isMap
    ? { src: '/img/logo-tankbag-vert.svg', w: 920, h: 648 }
    : { src: '/img/logo-tankbag-horiz.svg', w: 1595, h: 456 }

  return (
    <header class="site-header" id="site-header">
      <a class="site-logo" href="/">
        <img src={logo.src} alt="Tankbag" width={logo.w} height={logo.h} />
      </a>
      {/*
        A <details>, not a button plus a script. The browser owns open/closed,
        which means the menu works with no JavaScript at all — the whole nav used
        to vanish if site.js failed to load, on every page at once.

        One markup tree for both shapes. Below 992px this is the drawer; at 992
        and up _nav.scss reveals the same <nav> in flow as a bar and hides the
        summary, so the desktop nav needs neither the disclosure nor any script.
      */}
      <details class="site-menu">
        <summary class="nav-toggle" aria-label="Menu">
          <span class="nav-bars" aria-hidden="true"></span>
        </summary>
        <nav class="site-nav" id="site-nav">
          <div class="nav-primary">
            {user ? (
              <>
                <NavGroup label="Rides" items={RIDES_LINKS} navKey={navKey} />
                <NavLink item={RIDERS_LINK} navKey={navKey} />
                <NavAboutMenu user={user} navKey={navKey} />
                {user.canManageRiders && <NavGroup label="Admin" items={ADMIN_LINKS} navKey={navKey} />}
              </>
            ) : (
              <>
                <NavLink item={{ ...RIDES_LINKS[2] }} navKey={navKey} />
                <NavLink item={RIDERS_LINK} navKey={navKey} />
                <NavAboutMenu user={null} navKey={navKey} />
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
          </div>
          <div class="nav-end">{user && <NavAccountMenu user={user} navKey={navKey} />}</div>
        </nav>
      </details>
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
// One group in the bar: a summary that opens a panel of links.
const NavGroup = ({ label, items, navKey }: { label: string; items: NavItem[]; navKey?: NavKey }) => (
  <details class="nav-sub">
    <summary>{label}</summary>
    <div class="nav-sub-items">
      {items.map((i) => (
        <NavLink item={i} navKey={navKey} />
      ))}
    </div>
  </details>
)

// About. Privacy and Terms are deliberately not here — the footer carries them
// on every chrome page and the splash carries them signed out, so repeating them
// would make this the longest menu in the bar for the two links hardest to lose.
// "About this app" stays because it is the alpha modal's only trigger.
const NavAboutMenu = ({ user, navKey }: { user: UserRow | null; navKey?: NavKey }) => (
  <details class="nav-sub">
    <summary>About</summary>
    <div class="nav-sub-items">
      <NavLink item={{ key: 'places', href: '/faq', label: 'FAQ' }} navKey={navKey} />
      {user?.surveyInvitedAt && (
        <NavLink item={{ key: 'survey', href: '/survey', label: 'Rider survey' }} navKey={navKey} />
      )}
      <button type="button" class="linkbtn" data-open-alpha>
        About this app
      </button>
    </div>
  </details>
)

// The person, not the product: who you are signed in as, and the things that act
// on that account. Pinned right, away from the four destination groups.
//
// The avatar falls back to initials on a tinted disc: avatar_url is populated
// from Google sign-in, so every rider who came in through a magic link has none,
// and a broken image in the header would be the most visible bug on the site.
const NavAccountMenu = ({ user, navKey }: { user: UserRow; navKey?: NavKey }) => {
  const initials = user.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')

  return (
    <details class="nav-sub nav-account">
      <summary>
        {user.avatarUrl ? (
          <img class="nav-avatar" src={user.avatarUrl} alt="" width="24" height="24" />
        ) : (
          <span class="nav-avatar is-initials" aria-hidden="true">
            {initials || '?'}
          </span>
        )}
        <span class="nav-account-name">{user.displayName}</span>
      </summary>
      <div class="nav-sub-items">
        <NavLink item={{ key: 'profile', href: '/profile', label: 'Your profile' }} navKey={navKey} />
        <NavLink item={{ key: 'settings', href: '/settings', label: 'Settings' }} navKey={navKey} />
        <hr />
        <form method="post" action="/logout">
          <button class="linkbtn" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </details>
  )
}

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
  // A spaced EN dash, not an em dash. Em dashes are tight everywhere in this
  // product, and "Coast Run—Tankbag" reads as one compound word rather than a
  // page inside a site. A title separator is the case the en dash exists for.
  const title = `${esc(opts.title)} – Tankbag`
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
  <!--
    A composed 1280x640 card, not a crop of the logo. twitter:card below asks
    for a large image, and what used to sit here was the bare horizontal lockup
    at 2911x852 — a 3.4:1 strip that every scraper letterboxed into a 1.91:1
    slot, so most of the preview was padding. The wordmark on this card is the
    pre-dot artwork and wants redrawing.
  -->
  <meta property="og:image" content="${asset('/img/og-card.png')}">
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
${IS_DEV ? liveReloadScript() : ''}
</body>
</html>`
}
