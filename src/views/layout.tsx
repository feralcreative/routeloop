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
  /** Without the " – Routeloop" suffix; page() appends it. */
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
// Home leads the group, added 2026-08-15. It was deliberately absent on the
// grounds that the logo already goes to `/`, which was sound while `/` was a
// landing page and wrong once it became the dashboard: the stats page was
// reachable only by clicking a logo, which nobody reads as "my numbers". The
// giveaway sat in this file — `NavKey` has always included 'home' and home.tsx
// has always set it, but no item carried the key, so the aria-current branch
// below could never fire.
type NavItem = { key: NavKey; href: string; label: string }

const RIDES_LINKS: NavItem[] = [
  { key: 'home', href: '/', label: 'Home' },
  { key: 'rides', href: '/rides', label: 'Your rides' },
  { key: 'builder', href: '/builder', label: 'Plan a ride' },
  { key: 'explore', href: '/explore', label: 'Find a ride' },
  { key: 'import', href: '/import', label: 'Import / Export' },
]

// The one entry a signed-out visitor gets from the group above. Found by key
// rather than by index: this was `RIDES_LINKS[2]` inline, which silently became
// the wrong link the moment Home was inserted at the front — a positional
// reference into a list that other people edit is a trap, and it sprang the
// first time anyone edited the list.
const EXPLORE_LINK: NavItem = RIDES_LINKS.find((l) => l.key === 'explore')!

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
  // it is 114px wide against the horizontal lockup's 228px, so it takes half as
  // much of the map. The gap is much wider than it used to be, because the
  // horizontal lockup is now 8.15:1 where the old one was 3.5:1.
  //
  // Both are the unsuffixed artwork. The suffix names the *background*, not the
  // ink: no suffix is the dark lockup for a light ground, `-dk` is the reversed
  // white one for a dark ground. It reads backwards at a glance, which is why it
  // is written down — but it is the convention src/emails/shell.tsx was already
  // using, so the alternative was two conventions instead of one.
  //
  // `-hz` is the one-line lockup; the stacked one carries no axis suffix at all.
  // Both names are the artwork's own, as delivered.
  // NO LOGO ON A MAP PAGE. It moved into the drawer on 2026-08-16 — see
  // panelShell — because the drawer now runs the full height of the left edge
  // and the floating badge sat exactly on top of its header. What is left of the
  // header on a map page is the hamburger alone, in the opposite corner.
  //
  // The stacked artwork is therefore unused here; the drawer takes the
  // horizontal lockup, which suits a wide, short header far better. Both are the
  // unsuffixed artwork: the suffix names the *background*, not the ink, so no
  // suffix is the dark lockup for a light ground and `-dk` is the reversed white
  // one for a dark ground. It reads backwards at a glance, which is why it is
  // written down — but it is the convention src/emails/shell.tsx was already
  // using, so the alternative was two conventions instead of one.
  return (
    <header class={`site-header${isMap ? ' site-header--map' : ''}`} id="site-header">
      {!isMap && (
        <a class="site-logo" href="/">
          <img src="/img/logo-routeloop-hz.svg" alt="Routeloop" width={1500} height={184} />
        </a>
      )}
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
                <NavLink item={EXPLORE_LINK} navKey={navKey} />
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
//
// `exitHref` is the way OUT of a map page, and it was added because there was
// not one. A map page has no site footer and its header is the floating nav, so
// the only way off the builder was the hamburger in the opposite corner, which
// nobody finds — the builder read as a black hole. The control belongs next to
// collapse rather than in the nav because that corner is where a reader already
// looks to dismiss a panel.
//
// It is deliberately NOT the collapse button, and that distinction is the whole
// point of the pair: collapse keeps you on the map, exit leaves it. They are
// different verbs and now they are different controls. (Note for anyone reading
// issue #91, which describes the existing control as an X: it never was one — it
// renders icon-collapse.svg, a minimize glyph — so only the missing exit was
// real, and the collapse affordance did not have to move.)
//
// `titleHtml` exists for the builder, whose heading is an editable input rather
// than text. The viewer passes a plain `title` and is unchanged.
// IT IS A DRAWER, not a floating card, as of 2026-08-16. It runs the full height
// of the viewport flush against the left edge, the map is sized to the space
// beside it rather than sitting underneath it, and collapsing narrows it to a
// rail instead of shrinking it toward a corner. The `floating-panel` class is
// kept because a handful of unrelated rules still key on it; the shape now comes
// from `.map-drawer`.
//
// The order of the children IS the layout, and three of the four are pinned:
//
//   .drawer-head     the logo and the two controls. Fixed height.
//   .panel-title     the ride name, and #totals under it on the builder.
//   .panel-contents  the ONLY part that scrolls, and it takes whatever height is
//                    left. This is what stops the drawer growing and shrinking
//                    with its own content.
//   .drawer-foot     pinned to the bottom edge. The builder puts the day
//                    scrubber here; the viewer passes nothing and it collapses.
//
// THE LOGO LIVES HERE NOW rather than floating over the map. SiteHeader drops it
// on a map page — see the `isMap` branch there — because a full-height drawer
// occupies exactly the corner the floating badge used to.
export function panelShell(o: {
  title?: string
  titleHtml?: string
  exitHref?: string
  exitLabel?: string
  extraClass?: string
  contents: string
  /** Pinned to the drawer's bottom edge. The builder's day scrubber. */
  footer?: string
  /** Shown only while collapsed, in the rail. The builder's day dots. */
  rail?: string
}): string {
  return (
    <div id="info-panel" class={`floating-panel map-drawer${o.extraClass ? ` ${o.extraClass}` : ''}`}>
      <div class="drawer-head">
        <a class="drawer-logo" href="/" aria-label="Routeloop home">
          <img src="/img/logo-routeloop-hz.svg" alt="Routeloop" width={1500} height={184} />
        </a>
        <div class="panel-controls">
          {/*
            aria-expanded is on the button and only initPanelToggle flips it. It
            ships "true" because the drawer ships open.
          */}
          <button type="button" class="collapse-toggle" aria-label="Collapse panel" aria-expanded="true">
            <img src="/img/icons/icon-collapse.svg" alt="" class="collapse-icon" />
          </button>
          {/*
            The exit is deliberately EMPTY. Its glyph is icon-close.svg, painted
            through a CSS mask on ::before so it can take the control's own color
            — see .panel-exit in _map.scss. aria-label is what names it, which it
            already did while the ✕ character was here: a bare ✕ is announced as
            "multiplication sign".
          */}
          {o.exitHref && (
            <a
              class="panel-exit"
              href={o.exitHref}
              aria-label={o.exitLabel ?? 'Leave the map'}
              title={o.exitLabel ?? 'Leave the map'}
            ></a>
          )}
        </div>
      </div>
      {(o.titleHtml || o.title) && <h1 class="panel-title">{o.titleHtml ? raw(o.titleHtml) : o.title}</h1>}
      <div class="panel-contents-wrapper">
        {/* Already-rendered markup from the caller, hence raw(). */}
        <div class="panel-content">{raw(o.contents)}</div>
      </div>
      {o.footer && <div class="drawer-foot">{raw(o.footer)}</div>}
      {/*
        The rail's own contents, hidden until .collapsed. Rendered even when
        empty so the collapsed drawer has something to be, and aria-hidden while
        expanded so its duplicate day controls are not announced twice.
      */}
      <div class="drawer-rail" aria-hidden="true">
        {o.rail ? raw(o.rail) : ''}
      </div>
    </div>
  ).toString()
}

// The ride timeline, which is a bar across the bottom edge of the map rather
// than a control in the panel.
//
// It is a SIBLING of #map and #info-panel — not a child of either — so callers
// drop it straight into the page body beside them. Both map pages render it, and
// it is one function rather than two copies because the previous arrangement was
// two copies and they had already drifted: the viewer's carried `hidden` and the
// builder's did not.
//
// It ships `hidden`. Both pages' JS unhides it once it knows the ride has a time
// span to scrub — renderTimeline() in builder.js and in viewer.js — so a ride
// with no dates never flashes a dead slider across the map on first paint.
//
// The ids are the contract. builder.js and viewer.js both reach #time-slider and
// #time-readout by getElementById and neither walks up from them, which is the
// entire reason this move cost almost no JS.
export function rideTimeline(): string {
  return (
    <div class="map-timeline" id="ride-timeline" hidden>
      {/* Readout above the slider: the bar is wide and short, so the label reads
          as a caption for the track rather than as a stray line of map text. */}
      <div class="time-readout" id="time-readout"></div>
      <input
        id="time-slider"
        class="time-slider"
        type="range"
        min="0"
        max="0"
        step="60"
        value="0"
        aria-label="Move through the ride in time"
        title="Drag to move through the ride"
      />
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
      {!splash && <p class="site-footer-note">Routeloop is in a closed alpha.</p>}
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
  // product, and "Coast Run—Routeloop" reads as one compound word rather than a
  // page inside a site. A title separator is the case the en dash exists for.
  const title = `${esc(opts.title)} – Routeloop`
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
  <!--
    Overpass is self-hosted — the @font-face rules live in style/_fonts.scss and
    the files in public/font/. There is deliberately no Google Fonts <link> and
    no preconnect to gstatic: nothing about the page reaches a third party for
    type any more.

    This preload is the one thing the stylesheet cannot do for itself. A
    @font-face inside main.min.css is not discovered until the CSS has been
    fetched and parsed, so without this the upright latin file starts one full
    round trip late and every visitor sees the fallback flash. Only the upright
    latin subset is preloaded: latin-ext and the italics are needed by a
    minority of pages, and preloading a file the page never uses is a warning in
    the console and wasted bandwidth on a phone.

    The crossorigin attribute is required even though the file is same-origin.
    Fonts are fetched in CORS mode regardless, and a preload without it is a
    second, separate fetch rather than a warm cache entry.

    Deliberately NOT wrapped in asset(). The URL here has to be byte-identical
    to the one in the @font-face rule, and the stylesheet cannot carry a content
    hash — SCSS emits a static string. A version query on one side and not the
    other gives two different URLs: the preload warms a cache entry nothing asks
    for, the console warns that a preloaded resource went unused, and the font is
    fetched twice. Version a font by renaming the file instead.

    Note for anyone editing this comment: it sits inside a JS template literal,
    so a backtick here is a syntax error, not punctuation.
  -->
  <link rel="preload" href="/font/overpass-latin.woff2" as="font" type="font/woff2" crossorigin>
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
