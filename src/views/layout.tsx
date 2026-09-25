// The one HTML shell. Chrome pages and full-bleed map pages used to build their
// documents separately — four near-identical heads, two disjoint stylesheets,
// and no header at all on the builder or viewer, which is why there was no way
// back to the site from a map. `variant` is what that split collapses into.
import type { UserRow } from '../db/schema'
import { alphaSplash } from './splash'
import { SPLASH_CLIPS } from './splash-clips'
import { stage } from './stage'

export { esc } from './esc'
import { esc } from './esc'
import { raw } from 'hono/html'
import { wordmark } from './logo'
import { asset } from './assets'
import { THEME_COLOR } from './sw'
import { DEFAULT_VOCAB, Wd, Wds, aWd, clientTerms, vocabOf, wds, wordsFor, type Words } from './vocab'
import { IS_DEV, IS_STAGE } from '../config'
import { APP_VERSION, BUILD_SHA, IS_DEV_BUILD, commitUrl } from '../version'
import { icon } from './icon'
import { content } from './content'
import { faqAnswer } from '../feedback/faq'
import { faqTokens } from './faq-tokens'
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

// jsonScript() lived here until 2026-09-17 and moved to its own module when
// views/analytics.ts became a second caller; re-exported so nothing that imports
// it from here has to know. See json-script.ts for the escaping it does.
export { jsonScript } from './json-script'
import { jsonScript } from './json-script'
import { analyticsMarkup } from './analytics'

// Google's inline bootstrap loader, verbatim from their docs, which defines
// google.maps.importLibrary() and nothing else. Map pages emit this instead of a
// plain <script src=…&callback=…> because the engine imports "maps", "marker" and
// "places" separately and on demand. The key is public by design but still goes
// through JSON.stringify, so a malformed value cannot break out of the literal.
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
  // 'rides' IS BACK, set by /rides and carried by the first item of the Rides group.
  // Removing it when /rides folded into / was the point rather than tidiness: a key
  // no NavItem carries is an aria-current state that is wired and can never fire.
  // The rule stands — the member returns only because an item carries it again.
  | 'rides'
  | 'builder'
  | 'import'
  | 'places'
  // No 'friends' member either: /friends became a tab of the riders screen (#179)
  // and both its URLs set 'riders'.
  // 'profile' AND 'settings' NAME TWO DOORS INTO ONE PAGE (#269). The menu carried
  // an item for each until #320 folded them into My Account, which carries
  // 'settings'; 'profile' survives because /profile still SETS it, and a page entered
  // by that door must not light My Account as though it were Preferences.
  | 'profile'
  | 'settings'
  // ONE ADMIN KEY, NOT FOUR. `approvals`, `invites` and `survey-results` went with
  // the four-item admin block in the account menu, and had to under this union's own
  // rule. The three pages set 'admin' now, so the one item highlights across the
  // whole admin section.
  | 'admin'
  | 'survey'
  | 'feedback'
  | 'board'
  | 'notifications'

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
  /**
   * The rider's palette. **Almost nothing passes these** — they come off `user`,
   * which the session already carries, so every page is themed without its route
   * knowing. They exist as an override for the one case that needs it: the
   * preferences page previewing a choice before it is saved.
   */
  theme?: string
  scheme?: string
  motion?: string
  /**
   * Serialized to window.TB via jsonScript.
   *
   * `version` is merged in by page() and does not belong here — feedback.js has
   * always read `window.TB.version` into a bug report's diagnostics and nothing ever
   * set it, so every report filed so far names no build. That is also why TB is
   * emitted on EVERY page now.
   */
  tb?: Record<string, unknown>
  /**
   * The words for this page (#321). Almost nothing passes this — page()
   * resolves them from `user` — but a page ABOUT ONE RIDE passes
   * `wordsFor(vocabOf(user), ride)` so the ride's own vehicle wins, and the
   * same pair is sent to the client as `TBVocabData.ride`.
   */
  words?: Words
  ride?: { vehicle?: string | null; power?: string | null } | null
  /** Set false to suppress the alpha modal on a page. */
  splash?: boolean
  /**
   * Set false to emit no analytics on a page. A page view sends the page's
   * address to Google, so a page whose PATH carries a secret — the invite page,
   * `/i/:token` — opts out. Absence is on; see src/views/analytics.ts.
   */
  analytics?: boolean
  /** Plain message; page() supplies the <noscript> wrapper and markup. */
  noscript?: string
  /**
   * Pre-fills `?area=` on the floating bug button, so screen 3 of the report can
   * offer a one-tap confirm instead of eight cold chips.
   *
   * **It no longer decides whether the buttons appear** — they are site chrome and
   * render on every page a signed-in rider can reach.
   *
   * Still opt-in rather than inferred: `areaFromPath()` is the ONE inference
   * mechanism and it is reached from the request, where page() never sees a path.
   */
  /** Kept although the dock that read it is gone: several pages pass it, the
   *  intake still accepts `?area=`, and removing it would be a churn of call
   *  sites for a field that costs nothing. */
  feedbackArea?: string
}

// The menu, exactly as docs/main-menu.md specifies it. That file is the spec and
// this is the implementation; change the spec first.
//
// Home leads the group. It was deliberately absent because the logo already goes to
// `/` — sound while `/` was a landing page and wrong once it became the dashboard.
// The giveaway sat in this file: `NavKey` has always included 'home' and home.tsx
// has always set it, but no item carried the key.
type NavItem = { key: NavKey; href: string; label: string }

// OUT OF THE RIDES GROUP AND FIRST IN THE BAR (#184). It was "Your rides" at the
// head of RIDES_LINKS, under a comment arguing that "Home" names a location rather
// than a purpose. **That argument was right and its premise is what changed**:
// outside the group the label has no "Rides" above it, so "Your rides" competes
// with the three verbs still in the menu.
//
// THE KEY STAYS `home`. `/dash` AND NOT `/` SINCE 2026-09-17: `/` sends a phone to
// /rides, so a Dash item pointing at `/` would be a link a phone could never
// follow. The wordmark keeps `/` — for a thumb, home is the list.
const DASH_LINK: NavItem = { key: 'home', href: '/dash', label: 'Dash' }

// A destination and three verbs. The destination left the group when the list
// folded into /, and came back first when the list got its own page again.
// A FUNCTION OF THE WORDS since #321: "Plan a ride" is "Plan a trip" to a rider
// whose preset is a car, and the group is labeled with their plural.
const ridesLinks = (w: Words): NavItem[] => [
  { key: 'rides', href: '/rides', label: `Your ${wds(w, 'journey')}` },
  { key: 'builder', href: '/builder', label: `Plan ${aWd(w, 'journey')}` },
  { key: 'explore', href: '/explore', label: `Find ${aWd(w, 'journey')}` },
  { key: 'import', href: '/import', label: 'Import / Export' },
]

// The one entry a signed-out visitor gets from the group above. Found by key rather
// than by index: this was `RIDES_LINKS[2]` inline, which silently became the wrong
// link the moment Home was inserted at the front. Do not undo it while tidying the
// list up — removing that first element again for #184 is exactly the edit that used
// to break this.
const exploreLink = (w: Words): NavItem => ridesLinks(w).find((l) => l.key === 'explore')!

// IN THE ACCOUNT MENU, NOT THE BAR: four links for the one rider who owns the site,
// taking a top-level slot from every rider-facing destination. The account menu
// holds what acts on WHO YOU ARE rather than on what you are planning.
//
// FLATTENED BEHIND AN `<hr>` rather than nested as a second <details>: a menu that
// opens into another menu is two taps to reach a link that was one.
const RIDERS_LINK: NavItem = { key: 'riders', href: '/riders', label: 'Riders' }

/**
 * Which picture a rider has, in precedence order.
 *
 * The uploaded one is served through a route rather than a static path, because
 * src/maps/storage.ts writes outside the web root. No cache-buster: the nav renders
 * on every page and threading the hash through the session for a 24px image is not
 * worth the column. The route answers `max-age=300`, so a changed picture is current
 * within five minutes everywhere and immediately on the profile.
 */
export function avatarSrc(user: { id: number; avatarUrl?: string | null; avatarBytes?: number }): string | null {
  if (user.avatarBytes && user.avatarBytes > 0) return `/profile/avatar/${user.id}`
  return user.avatarUrl ?? null
}

// `badge` renders the same `.nav-badge` the account chip carries (#288): the chip's
// badge says something happened and this one says where to go for it, so a different
// shape would read as a different KIND of thing.
//
// **ZERO RENDERS NOTHING**, per _nav.scss. **THE BADGE IS `aria-hidden` AND THE
// LABEL CARRIES THE COUNT**, so a screen reader hears "Notifications, 3 unread" once
// rather than the digit twice.
function NavLink({
  item,
  navKey,
  badge = 0,
}: {
  item: { key: NavKey; href: string; label: string }
  navKey?: NavKey
  badge?: number
}) {
  return (
    <a href={item.href} aria-current={item.key === navKey ? 'page' : undefined}>
      {item.label}
      {badge > 0 && (
        <span class="nav-badge" aria-hidden="true">
          {badge > 99 ? '99+' : String(badge)}
        </span>
      )}
      {badge > 0 && <span class="visually-hidden">, {badge} unread</span>}
    </a>
  )
}

function SiteHeader({
  user,
  navKey,
  isMap = false,
  unread = 0,
  words = wordsFor(DEFAULT_VOCAB),
}: {
  user: UserRow | null
  navKey?: NavKey
  isMap?: boolean
  unread?: number
  words?: Words
}) {
  // A map page gives the header a floating badge rather than a full-width bar, and
  // the stacked mark suits that shape — at a legible height it is 114px wide against
  // the horizontal lockup's 228px.
  //
  // Both are the unsuffixed artwork. The suffix names the *background*, not the ink:
  // no suffix is the dark lockup for a light ground, `-dk` the reversed white one.
  // It reads backwards at a glance, which is why it is written down.
  // NO LOGO ON A MAP PAGE: it moved into the drawer, which runs the full height of
  // the left edge. What is left here is the hamburger alone.
  return (
    <header class={`site-header${isMap ? ' site-header--map' : ''}`} id="site-header">
      {!isMap && (
        <a class="site-logo" href="/">
          {raw(wordmark('hz', 'Routeloop'))}
        </a>
      )}
      {/*
                                        A SECOND DOOR INTO THE TOUR, AS A SMALL GUIDE SIGN BESIDE THE ACCOUNT
                                        CHIP: a way back in that lives two clicks deep in a menu is one nobody
                                        finds. Same href and `data-tour-start` hook as the menu item.

                                        A CHILD OF THE HEADER AND NOT OF `.nav-end`, because it has to be on
                                        the builder too, and on a map page `.nav-end` is inside a closed drawer
                                        at every width — the #300 problem.

                                        Shown to every signed-in rider; `hide_tour` is no longer read.
                                      */}
      {user && (
        <a class="nav-tour" href="/builder?tour" data-tour-start aria-label="Take the tour">
          {/* TWO WORDS OF THE THREE HIDE ON A PHONE (_nav.scss): the wordmark,
                                                        this sign and the hamburger did not fit 358px together. The
                                                        accessible name stays "Take the tour" through aria-label. The
                                                        space is a non-breaking one because the sign is inline-flex and
                                                        a plain space at the end of a flex item is collapsed, which
                                                        rendered "Take thetour". */}
          <span class="nav-tour-lead">Take the&nbsp;</span>tour
        </a>
      )}
      {/*
                A <details>, not a button plus a script. The browser owns open/closed, which
                means the menu works with no JavaScript at all — the whole nav used to vanish
                if site.js failed to load, on every page at once.

                One markup tree for both shapes. Below 992px this is the drawer; at 992 and up
                _nav.scss reveals the same <nav> in flow as a bar and hides the summary.
              */}
      <details class="site-menu">
        {/*
                        THE UNREAD DOT, ON THE HAMBURGER BECAUSE THAT IS THE ONLY CHROME A MAP PAGE
                        ALWAYS SHOWS (#300). #288 made the account chip's badge the route to the
                        release notes on the reasoning that the chip renders on every page — true of
                        the DOM and false of the screen: on a map page the nav is the drawer at every
                        width, so the chip sits inside a closed <details> and paints nothing.

                        **THE TWO CAN NEVER BOTH SHOW, AND CSS ALREADY GUARANTEES IT.** The toggle is
                        `display: none` above 992px on a chrome page and always shown on a map page,
                        so this dot appears exactly where the chip's badge cannot.

                        **A DOT AND NOT `.nav-badge`**: that rule made both badges one shape because
                        both NAME the thing, and a hamburger cannot name anything. The count still
                        reaches a screen reader through the label rather than the dot.
                      */}
        <summary class="nav-toggle" aria-label={unread > 0 ? `Menu, ${unread} unread` : 'Menu'}>
          <span class="nav-bars" aria-hidden="true"></span>
          {user && unread > 0 && <span class="nav-toggle-dot" aria-hidden="true"></span>}
        </summary>
        <nav class="site-nav" id="site-nav">
          <div class="nav-primary">
            {/*
                                THE WAY OFF A MAP PAGE, and the only item here not on every page. It
                                replaced an X in the drawer header: the X sat a millimeter from collapse
                                and read as its pair, which the two are not — one keeps you on the map
                                and the other leaves it. First, so it is the first thing under the thumb.
                              */}
            {isMap && (
              <a class="nav-exit-map" href="/">
                Exit map
              </a>
            )}
            {user ? (
              <>
                <NavLink item={DASH_LINK} navKey={navKey} />
                <NavGroup label={Wds(words, 'journey')} items={ridesLinks(words)} navKey={navKey} />
                <NavLink item={{ ...RIDERS_LINK, label: Wds(words, 'person') }} navKey={navKey} />
                <NavAboutMenu user={user} navKey={navKey} />
              </>
            ) : (
              <>
                <NavLink item={exploreLink(words)} navKey={navKey} />
                <NavLink item={{ ...RIDERS_LINK, label: Wds(words, 'person') }} navKey={navKey} />
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
          <div class="nav-end">{user && <NavAccountMenu user={user} navKey={navKey} unread={unread} />}</div>
        </nav>
      </details>
    </header>
  )
}

// The floating map panel scaffold, previously copy-pasted into all three map
// shells. map-common.js binds the collapse toggle by these class names.
//
// THERE IS NO EXIT CONTROL IN THIS HEADER, and it is not an omission: collapse and
// exit are different verbs, and sitting them a millimeter apart made the more
// consequential the easier to hit by accident. The exit is `Exit map`, first in the
// menu.
//
// `titleHtml` exists for the builder, whose heading is an editable input.
// IT IS A DRAWER, not a floating card: it runs the full height of the viewport
// flush against the left edge, the map is sized to the space beside it, and
// collapsing narrows it to a rail. `floating-panel` is kept because unrelated rules
// still key on it.
//
// The order of the children IS the layout, and three of the four are pinned:
//
//   .drawer-head     the logo and the two controls. Fixed height.
//   .panel-title     the ride name, and #totals under it on the builder.
//   .panel-contents  the ONLY part that scrolls, taking whatever height is left.
//   .drawer-foot     pinned to the bottom edge.
export function panelShell(o: {
  title?: string
  titleHtml?: string
  extraClass?: string
  contents: string
  /** Pinned to the drawer's bottom edge. The builder's route scrubber. */
  footer?: string
  /** Shown only while collapsed, in the rail. The builder's route dots. */
  rail?: string
}): string {
  return (
    <div id="info-panel" class={`floating-panel map-drawer${o.extraClass ? ` ${o.extraClass}` : ''}`}>
      <div class="drawer-head">
        <a class="drawer-logo" href="/" aria-label="Routeloop home">
          {raw(wordmark('hz', 'Routeloop'))}
        </a>
        <div class="panel-controls">
          {/*
            aria-expanded is on the button and only initPanelToggle flips it. It
            ships "true" because the drawer ships open.
          */}
          <button type="button" class="collapse-toggle" aria-label="Collapse panel" aria-expanded="true">
            {/*
              Empty: icon-collapse.svg and
              icon-expand.svg are painted through a CSS mask keyed off the
              button's own aria-expanded, so the pair takes the control's color
              on hover. It was an <img> whose src initPanelToggle swapped, which
              worked but could not inherit color — the button's :hover changed
              everything except the glyph inside it.
            */}
            <span class="collapse-icon" aria-hidden="true"></span>
          </button>
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
        expanded so its duplicate route controls are not announced twice.
      */}
      <div class="drawer-rail" aria-hidden="true">
        {o.rail ? raw(o.rail) : ''}
      </div>
      {/*
        THE WIDTH IS THE RIDER'S TO SET (#323). Ziad's call, 2026-09-13: a drag
        handle on the drawer's right edge replaces the collapse icon on desktop.
        A focusable separator rather than a button: it is a divider whose
        position is the value, which is what the role says, and the arrow keys
        move it — initPanelResize() in map-common.js. The phone sheet keeps the
        collapse icon above, since it has no width to set.
      */}
      <div
        class="drawer-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Drawer width"
        aria-valuemin={360}
        aria-valuenow={380}
        tabindex={0}
        title="Drag to resize; click to collapse"
      ></div>
    </div>
  ).toString()
}

// The ride timeline, a bar across the bottom edge of the map rather than a control
// in the panel. A SIBLING of #map and #info-panel. One function rather than two
// copies, because the previous arrangement was two copies and they had already
// drifted — the viewer's carried `hidden` and the builder's did not.
//
// It ships `hidden`, and both pages' JS unhides it once it knows the ride has a span
// to scrub, so a ride with no dates never flashes a dead slider. The ids are the
// contract: both files reach #time-slider and #time-readout by getElementById.
export function rideTimeline(opts: { scopeToggle?: boolean; words?: Words } = {}): string {
  const w = opts.words ?? wordsFor(DEFAULT_VOCAB)
  return (
    <div class="map-timeline" id="ride-timeline" hidden>
      {/* Readout above the slider: the bar is wide and short, so the label reads
          as a caption for the track rather than as a stray line of map text. */}
      <div class="time-head">
        <div class="time-readout" id="time-readout"></div>
        {/* BUILDER ONLY, and the argument is what makes that explicit rather
                                                than a class the viewer has to remember not to style. The builder's
                                                slider spans the route being edited and this widens it to the ride;
                                                the viewer's spans the ride already.

                                                Ships with no label and hidden: renderTimeScope() fills both in,
                                                and leaves it hidden on a one-route ride. */}
        {opts.scopeToggle ? (
          /* A DOUBLE-SIDED PILL, NOT ONE BUTTON THAT RELABELS ITSELF,
                                                                finishing what the 2026-08-31 change started: that one made
                                                                the single button say which scope was ON rather than what a
                                                                click would do, because "Whole ride" while in route scope had
                                                                riders reading "ride" as their state.

                                                                `role="group"` rather than a radiogroup: two buttons each
                                                                carrying `aria-pressed`, where a radio group would promise
                                                                arrow-key roving the bar does not implement. */
          <div class="time-scope-set" id="time-scope" role="group" aria-label="What the slider covers" hidden>
            <button type="button" class="time-seg" data-scope="route" data-tip="time-scope" aria-pressed="true">
              {Wd(w, 'route')}
            </button>
            <button type="button" class="time-seg" data-scope="ride" data-tip="time-scope" aria-pressed="false">
              {Wd(w, 'journey')}
            </button>
          </div>
        ) : (
          ''
        )}
        {/* BOTH SURFACES, unlike the scope button, because the fuel ring is on
                        both and it is the one overlay big enough to be in the way — a 300-mile
                        tank draws a circle wider than the viewport at most useful zooms. Turning
                        it off leaves the dot and the dry marker.

                        Ships hidden with no label. paintMoment() shows it only once there is a
                        ring to talk about: a rider with no bike on file has no range. */}
        <button
          type="button"
          class="time-scope"
          id="range-ring"
          data-tip="range-ring"
          aria-pressed="true"
          hidden
        ></button>
      </div>
      <input
        id="time-slider"
        class="time-slider"
        type="range"
        min="0"
        max="0"
        step="60"
        value="0"
        aria-label="Move through the ride in time"
        data-tip="timeline"
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

// A "?" beside a control, linking to the answer that defines it. The FAQ already
// explains what a POI is and what "unlisted" means; before this the only way to find
// out was to guess the FAQ had an answer and go looking.
//
// Opens in a new tab, always. Every one of these sits in the builder, where
// following a link means abandoning an unsaved ride.
/**
 * A `?` beside one field, holding that field's own instructions.
 *
 * **THE SECOND `?` IN THIS FILE, AND IT IS NOT `faqLink()`.** That one answers a
 * SITE-WIDE question and leaves the page to do it; this answers a question about ONE
 * control, which #268 argues belongs beside the control.
 *
 * **NATIVE `popover`, NO JAVASCRIPT AT ALL**: `popovertarget` gives the toggle,
 * Escape, light-dismiss and the top layer, and the top layer is what makes it immune
 * to being clipped by whatever the field sits inside.
 *
 * **POSITIONED BY CSS ANCHOR POSITIONING WHERE THERE IS ANY, CENTERED WHERE THERE IS
 * NOT.** Firefox has not shipped it, so the `@supports` fallback puts the bubble near
 * the top of the screen. Degraded, not broken.
 *
 * **THE ID HAS TO BE UNIQUE ON THE PAGE**, derived from the field name rather than
 * passed in: a duplicate would make one button open another field's bubble.
 *
 * **IT IS FOR INSTRUCTIONS, NOT FOR DISCLOSURES.** Anything a rider needs to read
 * BEFORE they act stays visible as prose.
 */
export const fieldHelp = (name: string, label: string, text: string): string =>
  (
    // `--anchor` sits on the WRAPPER because both children read it: the button
    // sets `anchor-name` from it and the bubble sets `position-anchor` to it,
    // and an anchor name has to be a dashed-ident unique to this field.
    <span class="field-help" style={`--anchor: --a-${name}`}>
      <button type="button" class="help-dot" popovertarget={`help-${name}`} aria-label={`More about ${label}`}>
        ?
      </button>
      <span class="help-bubble" id={`help-${name}`} popover="auto">
        {text}
      </span>
    </span>
  ).toString()

/**
 * A `?` beside a control the FAQ defines — answered IN PLACE, with the jump as the
 * fallback (#268).
 *
 * **THE ANCHOR IS STILL A REAL LINK AND THAT IS THE WHOLE DESIGN.** Pressing one used
 * to leave the page, which on the builder means abandoning a route mid-edit. It opens
 * a popover now, but it is still an `<a href>`, so no JavaScript, a middle click and
 * a ctrl/cmd click all still get `/faq` at the right anchor.
 *
 * **ONE SOURCE, TWO SURFACES.** The copy stays in `src/content/faq.html` addressed by
 * the anchor the link already used, read through `faqAnswer()`, so the popover and the
 * FAQ entry cannot drift.
 *
 * **IT DEGRADES TO EXACTLY THE OLD BEHAVIOR WHEN THE ANCHOR IS MISSING.** A renamed
 * FAQ id returns null here and the link renders alone, where an empty popover would be
 * a control that opens nothing. `test/faq.test.ts` pins every anchor.
 */
export const faqLink = (anchor: string, what: string): string => {
  const answer = faqAnswer(content('faq.html', faqTokens()), anchor)
  const link = (
    <a class="faq-link" href={`/faq#${anchor}`} data-faq={answer ? anchor : undefined} title={`What is ${what}?`}>
      <span class="visually-hidden">{`What is ${what}?`}</span>
      <span aria-hidden="true">?</span>
    </a>
  ).toString()
  if (!answer) return link
  return `${link}<span class="faq-pop" id="faq-${esc(anchor)}" popover><b class="faq-pop-q">${esc(`What is ${what}?`)}</b>${answer}</span>`
}

const SiteLinkRow = () => (
  <>
    {SITE_LINKS.map((l) => (
      <a href={l.href}>{l.label}</a>
    ))}
  </>
)

// The same three links plus the alpha modal, folded into one disclosure. The nav was
// a flat run of nine items where the last four are all "about this thing" rather
// than "go somewhere in the app".
//
// <details> rather than a JS menu: it is a disclosure, and the platform already
// handles the keyboard and the ARIA for one.
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

// The person, not the product: who you are signed in as, and the things that act on
// that account. Pinned right, away from the four destination groups.
//
// The avatar falls back to initials on a tinted disc: avatar_url is populated from
// Google sign-in, so every rider who came in through a magic link has none, and a
// broken image in the header would be the most visible bug on the site.
/**
 * The account chip, and everything behind it.
 *
 * **A CHIP RATHER THAN A BARE LOCKUP, AND THE BADGE IS WHY.** The avatar and name sat
 * loose in the nav with nothing bounding them, which was fine while they were only a
 * label — a badge needs an edge to sit on, and an unread count floating beside a name
 * reads as part of the name. The chip also makes the whole thing one press target.
 *
 * **THE BADGE IS THE ONLY PIECE OF CHROME IN THE APP THAT DEMANDS ANYTHING**, so it is
 * the only one painted `$stop`. It is rendered only when the count is non-zero — a
 * badge showing 0 teaches people to stop looking at badges.
 */
/**
 * Unread notifications for the badge, off the SESSION user.
 *
 * **NOT A `page()` OPTION, because page() is synchronous and is called from dozens of
 * places** — an option would work until the next call site forgot it, and a forgotten
 * badge is not a visible bug, it is a rider who is never told anything happened.
 * validateSessionToken() counts it on the query it already runs.
 *
 * `UserRow` on its own has no such field, so this reads it defensively and answers 0
 * for anything else.
 */
const unreadOf = (u: UserRow | null): number => {
  // Through `unknown`, because `UserRow` genuinely has no `unread` and TypeScript
  // is right to refuse the direct assertion. The widening happens in
  // validateSessionToken, which page() has no type-level knowledge of.
  const n = (u as unknown as { unread?: unknown } | null)?.unread
  return typeof n === 'number' ? n : 0
}

/**
 * The profile columns the session row carries beyond UserRow, read through
 * `unknown` the way unreadOf() does — page() takes a UserRow and
 * every caller passes the session user, which is one.
 */
const profileOf = (u: UserRow | null): { vehicle?: unknown; power?: unknown; jargon?: unknown } | null =>
  u as unknown as { vehicle?: unknown; power?: unknown; jargon?: unknown } | null

/** The words for a page (#321): passed in for a ride page, resolved from the
 *  rider's own preset otherwise. */
export const wordsOf = (opts: { user: UserRow | null; words?: Words; ride?: PageOpts['ride'] }): Words =>
  opts.words ?? wordsFor(vocabOf(profileOf(opts.user)), opts.ride)


/** Up to two initials for the tinted disc a rider with no picture gets — the
 *  account chip's rule, shared with the rider cards on /riders (#341). */
export const initialsOf = (displayName: string): string =>
  displayName
    .split(/\s+/)
    // A word that opens with a bracket or a symbol lends no initial — "Ziad
    // (Personal)" read "Z(" until the cards made a 40px disc of it.
    .filter((w) => /^[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')

const NavAccountMenu = ({ user, navKey, unread = 0 }: { user: UserRow; navKey?: NavKey; unread?: number }) => {
  const initials = initialsOf(user.displayName)

  return (
    <details class="nav-sub nav-account">
      <summary class="nav-chip">
        {/* THE UPLOAD FIRST, then the provider picture, then initials (#99).
            avatarUrl is write-once from Google sign-in and a magic-link rider has
            never had one — which is the whole reason the upload exists. */}
        {avatarSrc(user) ? (
          <img class="nav-avatar" src={avatarSrc(user)!} alt="" width="24" height="24" />
        ) : (
          <span class="nav-avatar is-initials" aria-hidden="true">
            {initials || '?'}
          </span>
        )}
        <span class="nav-account-name">{user.displayName}</span>
        {/* CAPPED AT 99, because three digits is a different-shaped badge and
            the difference between 100 and 400 unread is not a difference anybody
            acts on. The accessible name says the real number in words, so the
            cap is presentational only. */}
        {unread > 0 && (
          <span class="nav-badge" aria-hidden="true">
            {unread > 99 ? '99+' : String(unread)}
          </span>
        )}
        {unread > 0 && <span class="visually-hidden">{unread} unread notifications</span>}
      </summary>
      <div class="nav-sub-items">
        {/* THE ORDER IS ZIAD'S, 2026-09-07: what happened, then who you are, then
            your things, then the app, then the door. Notifications leads because
            it is the only item that changes on its own. */}
        <NavLink
          item={{ key: 'notifications', href: '/notifications', label: 'Notifications' }}
          navKey={navKey}
          badge={unread}
        />
        {/* ONE ITEM, ONE PAGE (#320), reversing the #269 arrangement of a Profile
                        item and a Preferences item side by side: with Places and the Paddock as
                        tabs too (#319) the page is everything about the rider, and four menu items
                        for four tabs is the rider-has-to-translate problem the merge was for.
                        `/profile` keeps its own NavKey because the page still sets it when entered
                        by that door; the union's rule is that a key nothing SETS is what is not
                        allowed. */}
        <NavLink item={{ key: 'settings', href: '/account', label: 'My Account' }} navKey={navKey} />
        {/* NO RECYCLE BIN ITEM SINCE #343. It sat here because the bin held
            saved places and groups as well as rides; the bin has no page now —
            binned rides are the last tab under Rides on the dashboard and
            binned places a fold on /places — so an item here would be a
            second door to a tab one click away. Ziad's call, 2026-09-13. */}
        <hr />
        {/* THE ONLY WAY IN NOW THAT THE FLOATING SHIELD IS GONE, and renamed to
            match — Ziad's call, 2026-09-07. It was "Tell us something" beside a
            permanent corner button that did the same thing; one affordance
            called what it is beats two called different things. See the note
            where feedbackFab used to be. */}
        <NavLink item={{ key: 'feedback', href: '/feedback', label: 'Feedback' }} navKey={navKey} />
        {/* THE WAY BACK INTO THE GUIDED TOUR (#133). A plain anchor and not a
                        NavLink: it is never the current page, so it carries no key. It is a REAL
                        LINK to a fresh ride because a tour started on the dashboard would have
                        nothing to point at; on the builder itself tour.js intercepts the click and
                        starts in place. `?tour` is read and stripped by tour.js. */}
        <a href="/builder?tour" data-tour-start>
          Take the tour
        </a>
        {/* ONE ADMIN ITEM, NOT FOUR. Approvals, Invitations and Survey results
            are all linked from /admin's own dashboard, and four moderation
            queues in a rider's account menu made the menu about running the site
            rather than about them. */}
        {user.canManageRiders && <NavLink item={{ key: 'admin', href: '/admin', label: 'Admin' }} navKey={navKey} />}
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

// THE FLOATING SHIELD IS GONE, 2026-09-07.
//
// `feedbackFab()` rendered a route shield with an `i` in it, bottom right of every
// signed-in page, opening a two-item menu: What's new, and a bug report. The
// reasoning behind it was sound — a rider who hits something wrong anywhere is
// exactly as stuck as one in the builder — and what changed is that it was a second
// permanent piece of chrome saying the same thing as an account-menu item called
// "Tell us something". The menu item is **Feedback** now and it is the only way in.
//
// WHAT WENT WITH IT: the dock's "What's new" item opened the release-notes modal, and
// it was one of exactly three surfaces carrying the build. **The footer does not
// render on a map page**, so the builder and the viewer now have no release-notes
// affordance at all. That is a real gap rather than a tidy-up.

/**
 * The release-notes modal, injected into every page by page().
 *
 * EMPTY ON ARRIVAL. The notes grow with every release and this modal is on every
 * page, so shipping the copy inline would put a file that only gets longer onto every
 * HTML response. The body is fetched from /api/release-notes the first time it is
 * opened and kept for the life of the page.
 *
 * Same markup contract as the alpha modal so both are driven by the same focus trap
 * and close handling in site.js.
 */
function releaseNotesModal(): string {
  return (
    <div class="modal-backdrop" id="release-notes" hidden>
      <div class="modal modal--notes" role="dialog" aria-modal="true" aria-labelledby="rn-title" tabindex={-1}>
        <button type="button" class="modal-close" data-close-notes aria-label="Close">
          &times;
        </button>
        <h2 id="rn-title" class="rn-title">
          What’s new
        </h2>
        {/* The version a rider is actually running, beside the notes that say
            what it contains. This is the answer to "which build did I see that
            on", and it is why the string is in the footer too. */}
        <p class="rn-version">
          <span class="rn-version-label">You are on</span> <code>{APP_VERSION}</code>
          {BUILD_SHA && (
            <>
              {' '}
              <a class="rn-sha" href={commitUrl(BUILD_SHA)} rel="noreferrer">
                <code>{BUILD_SHA}</code>
              </a>
            </>
          )}
          {IS_DEV_BUILD && <span class="rn-version-dev"> — a local build, not a deploy</span>}
        </p>
        {/* Filled by site.js on first open. The <noscript> is the honest
            fallback rather than a dead dialog: the page it points at is the
            same content, server-rendered. */}
        <div class="modal-body rn-body" id="rn-body" data-src="/api/release-notes">
          <p class="rn-loading">
            <a href="/release-notes">Read what’s new</a>
          </p>
        </div>
      </div>
    </div>
  ).toString()
}

/**
 * "This is staging, do not plan a real ride here."
 *
 * Stage renders identically to production, so the only thing standing between a rider
 * and a lost ride is this bar.
 *
 * ON EVERY PAGE, INCLUDING THE SPLASH AND BOTH MAP PAGES. It is emitted above the
 * `variant === 'splash'` check in page() deliberately: the signed-out landing page is
 * where somebody arrives at the wrong host, and the builder is where they would lose
 * the most. That is also why it cannot be dismissed.
 *
 * `.tb-banner` is the existing page-top banner and `is-stage` a modifier on it. It is
 * `position: fixed`, so the space it takes comes from --banner-h.
 *
 * `role="status"` rather than `alert`: it is a standing fact about the whole site,
 * and `alert` interrupts a screen reader mid-sentence on every page load.
 */
/**
 * **THE COPY REVERSED ON 2026-09-09 AND THAT IS THE POINT OF IT (#305).** It used to
 * read "Rides planned here are wiped whenever this environment is refreshed from
 * production", which was true while stage had a database of its own and became
 * exactly backwards the moment it stopped. That sentence is the one that would talk
 * somebody into deleting a real rider's ride to see what the button did.
 *
 * It stays AMBER rather than going red. The temptation is to escalate now that the
 * stakes are real, and it is the wrong call: this banner renders on every page of
 * every visit, and a red warning that is always present is one nobody reads by the
 * second day. Red is a verdict in this app's vocabulary, and nothing here is broken.
 */
function stageBanner(): string {
  if (!IS_STAGE) return ''
  return (
    <div class="tb-banner is-stage" role="status">
      <strong>Staging, on the live database.</strong> Everything here is real rider data — anything you delete is
      deleted for&nbsp;everyone. <a href="https://routeloop.app">Go to the real&nbsp;site</a>
    </div>
  ).toString()
}

function siteFooter(splash: boolean): string {
  // The splash is a signed-out landing page over video: it gets the links and
  // nothing else. A closing note there would compete with the sign-in controls.
  return (
    <footer class={`site-footer${splash ? ' is-splash' : ''}`}>
      <nav class="site-footer-links">
        <SiteLinkRow />
      </nav>
      {!splash && (
        <p class="site-footer-note">
          Routeloop is in a {stage().phase}.{' '}
          {/* A button, not a link: it opens the modal on the page you are already
                            on, and degrades to the real page when scripting is off.

                            THE SHA IS A SIBLING OF THE BUTTON, NOT INSIDE IT. An anchor nested in a
                            button is invalid, and the browsers that render it anyway give the inner
                            link no keyboard focus. Two controls, two jobs: the date opens the notes,
                            the hash opens the commit. */}
          <button type="button" class="site-footer-version" data-open-notes data-tip="whats-new" title="See what’s new">
            {APP_VERSION}
          </button>
          {BUILD_SHA && (
            <>
              {' · '}
              <a
                class="site-footer-sha"
                href={commitUrl(BUILD_SHA)}
                rel="noreferrer"
                data-tip="build-commit"
                title="See this commit on GitHub"
              >
                {BUILD_SHA}
              </a>
            </>
          )}
        </p>
      )}
    </footer>
  ).toString()
}

// THE DRAWER'S REMEMBERED WIDTH, APPLIED BEFORE FIRST PAINT (#323). It lives in
// localStorage — a width is a fact about this screen, not the rider — and a script
// that ran on DOMContentLoaded would draw the drawer at 380px and jump. This one is
// emitted right after the drawer's markup. Every read is wrapped: a private window
// can refuse storage.
// A FOLDED CARD STAYS FOLDED (#339). Every `<details data-fold="name">` on a chrome
// page ships `open`; site.js writes `routeloop.fold.<name>` = "closed" when a rider
// folds it, and this takes the `open` back off before the page settles. At the end of
// the body rather than in the head because the elements have to exist. Nothing stored
// means open.
const FOLD_RESTORE = `<script>(function(){try{var f=document.querySelectorAll("details[data-fold]");for(var i=0;i<f.length;i++){if(localStorage.getItem("routeloop.fold."+f[i].getAttribute("data-fold"))==="closed")f[i].removeAttribute("open");}}catch(e){}})();</script>`

const DRAWER_RESTORE = `<script>(function(){try{var d=JSON.parse(localStorage.getItem("routeloop.drawer")||"null");if(!d)return;var h=document.documentElement,p=document.getElementById("info-panel");if(d.w>0)h.style.setProperty("--panel-width",d.w+"px");if(d.collapsed&&p){p.classList.add("collapsed");var r=p.querySelector(".drawer-rail");if(r)r.setAttribute("aria-hidden","false");var t=p.querySelector(".collapse-toggle");if(t){t.setAttribute("aria-expanded","false");t.setAttribute("aria-label","Expand panel");}}}catch(e){}})();</script>`

// The browser chrome's color on an installed phone (#69): the page surface, which is
// `$page` — the light gray in a light scheme and the near-black in a dark one. The
// same rule as the appearance attributes: a stamped scheme gets one answer, and an
// unstamped one gets both under `media` so the OS decides. The two values live in
// src/views/sw.ts, pinned to the palette by test/theme-color.test.ts.
function themeColorMeta(scheme: string | undefined): string {
  if (scheme === 'dark') return `<meta name="theme-color" content="${THEME_COLOR.dark}">`
  if (scheme === 'light') return `<meta name="theme-color" content="${THEME_COLOR.light}">`
  return `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${THEME_COLOR.light}">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="${THEME_COLOR.dark}">`
}

export function page(opts: PageOpts): string {
  const variant: PageVariant = opts.variant ?? 'chrome'
  const isMap = variant === 'map'
  // Computed once: the bar goes in the staging banner's slot and the scripts at the
  // tail, and both read the request's country. No html class is set for the consent
  // bar, unlike the stage banner: it renders HIDDEN and consent.js adds
  // `has-consent-bar` only when it shows it, so a reserve at first paint would be a
  // strip of blank page for every rider who has already answered.
  const analytics = analyticsMarkup({ enabled: opts.analytics !== false })
  // `has-stage-banner` is what reserves the space the stage banner occupies,
  // server-rendered rather than set by script for the same reason the three appearance
  // attributes are: the reserve has to be right at the FIRST paint, or every page on
  // stage starts with its header under the banner and jumps once site.js measures.
  const htmlClasses = [isMap ? 'map-page' : '', IS_STAGE ? 'has-stage-banner' : ''].filter(Boolean).join(' ')
  const htmlClass = htmlClasses ? ` class="${htmlClasses}"` : ''

  // THE THREE APPEARANCE ATTRIBUTES, read by style/_theme.scss and the `motion()`
  // mixin. Stamped on <html> rather than <body> because the palettes are emitted on
  // `:root`, and because a custom property has to be defined above everything that
  // reads one — including the page background, which paints from <html>.
  //
  // EACH IS OMITTED WHEN IT WOULD SAY NOTHING, and the two reasons differ. The default
  // theme is the bare `:root` block, so an attribute would be redundant. `system` is
  // load-bearing: there is no `data-scheme="system"` rule and there cannot be one,
  // because the server does not know the reader's OS setting, so absence is what lets
  // `prefers-color-scheme` answer.
  //
  // `data-motion` follows the second reason exactly, and BOTH overrides are stamped,
  // because `always` means "animate even though my machine says reduce".
  //
  // Server-rendered rather than set by script, so there is no flash of the wrong
  // palette before the first paint. Read off the user rather than passed in, so all 32
  // call sites get it without being touched.
  const u = opts.user as
    | (UserRow & {
        theme?: string
        scheme?: string
        motion?: string
        mapScheme?: string
        dateFormat?: string
        clock?: string
        tips?: string
        tourDoneAt?: Date | null
        tourRideId?: number | null
      })
    | null
  const theme = opts.theme ?? u?.theme
  const scheme = opts.scheme ?? u?.scheme
  const motion = opts.motion ?? u?.motion
  const themeAttr_ = theme && theme !== 'default' ? ` data-theme="${esc(theme)}"` : ''
  const schemeAttr_ = scheme && scheme !== 'system' ? ` data-scheme="${esc(scheme)}"` : ''
  const motionAttr_ = motion && motion !== 'system' ? ` data-motion="${esc(motion)}"` : ''
  // The map's own scheme (2026-09-14), read by map-common.js and by nothing
  // in CSS. `follow` is omitted, the `data-clock`/`data-motion` rule: the
  // absence is what sends the map to `data-scheme` and then to the OS.
  const mapScheme = u?.mapScheme
  const mapSchemeAttr_ = mapScheme && mapScheme !== 'follow' ? ` data-map-scheme="${esc(mapScheme)}"` : ''
  // TWO MORE STAMPS, AND THEY ARE FOR THE CLIENT RATHER THAN FOR THE CSS (#270).
  // Three client formatters — fmtClockMin in builder.js, fmtStamp in
  // map-common.js and fmtMoment in ride-time.js — were calling
  // `toLocaleTimeString(undefined, …)`, which is the BROWSER's locale and not
  // the rider's choice, so a rider who asked for 24-hour time got it in the
  // printed roadbook and nowhere else. site.js reads these two off <html> and
  // hands them to all three.
  //
  // `data-clock` IS OMITTED FOR `locale`, the same rule `data-motion` follows
  // for `system`: the absence IS the state, and the date format beside it is
  // what answers instead. `data-date-format` is always stamped, because there is
  // no absent case — every rider has one, from the column or from the header.
  const dateFormat = (opts.user ? u?.dateFormat : undefined) ?? 'en-US'
  const clock = u?.clock
  const localeAttr_ = ` data-date-format="${esc(dateFormat)}"`
  const clockAttr_ = clock && clock !== 'locale' ? ` data-clock="${esc(clock)}"` : ''
  // THE ONE THAT SAYS "NEW". `data-tour`
  // is stamped for a signed-in rider whose `tour_done_at` is null. Absent
  // for everybody else, including a signed-out visitor — there is no builder
  // for them to be toured through. The account menu reads it to decide
  // whether Take the tour is a thing they have seen; public/js/tour.js used
  // to read it too, to start the tour unasked on a blank builder, and no
  // longer does — the tour is manual only, Ziad's call, 2026-09-13.
  const tourAttr_ = opts.user && u?.tourDoneAt === null ? ' data-tour="new"' : ''
  // A FIFTH: WHICH RIDE THE TOUR IS BUILDING. tour.js keeps its position in
  // sessionStorage so it can follow the rider across pages, and this is what
  // it checks that position against — a saved step for a ride this session
  // does not name is stale (the tour finished, or somebody else signed in on
  // this tab) and is dropped rather than resumed into a 404. Stamped on every
  // page because the tour visits several.
  const tourRideAttr_ = opts.user && u?.tourRideId ? ` data-tour-ride="${u.tourRideId}"` : ''
  const bodyClass = [isMap ? 'map-page' : '', variant === 'splash' ? 'splash-page' : '', opts.bodyClass ?? '']
    .filter(Boolean)
    .join(' ')
  // A spaced EN dash, not an em dash. Em dashes are tight everywhere in this
  // product, and "Coast Run—Routeloop" reads as one compound word rather than a
  // page inside a site. A title separator is the case the en dash exists for.
  const title = `${esc(opts.title)} – Routeloop`
  const body = isMap ? opts.body : `<div class="page-wrap">\n${opts.body}\n${siteFooter(variant === 'splash')}\n</div>`

  return `<!doctype html>
<html lang="en-US"${htmlClass}${themeAttr_}${schemeAttr_}${motionAttr_}${mapSchemeAttr_}${localeAttr_}${clockAttr_}${tourAttr_}${tourRideAttr_}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  ${themeColorMeta(scheme)}
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
${stageBanner()}${analytics.bar}
${variant === 'splash' ? '' : (<SiteHeader user={opts.user} navKey={opts.navKey} isMap={isMap} unread={unreadOf(opts.user)} words={wordsOf(opts)} />).toString()}
${body}
${isMap ? DRAWER_RESTORE : FOLD_RESTORE}
${opts.splash === false ? '' : alphaSplash()}
${releaseNotesModal()}
${opts.noscript ? `<noscript><p style="padding:1em">${esc(opts.noscript)}</p></noscript>` : ''}
${jsonScript('TB', { ...(opts.tb ?? {}), ...(variant === 'splash' ? { splashClips: SPLASH_CLIPS } : {}), version: APP_VERSION })}
${jsonScript('TBVocabData', { terms: clientTerms(), profile: vocabOf(profileOf(opts.user)), ride: opts.ride ?? null })}
<!--
  The error ring buffer, on every page and first in the list.

  By the time a rider decides to file a report, the error that prompted it
  happened minutes ago on a different screen. A buffer installed when the
  feedback form opens has nothing in it, which is why this is not loaded
  alongside feedback.js. It is ~4 KB, installs four listeners and wraps
  console.error and fetch, and every read inside it is feature-detected — it is
  a crash handler, so it must not be able to crash.
-->
<!--
  MOTION FIRST, AND ON EVERY PAGE. site.js, dashboard.js and feedback.js all ask
  it whether to animate, and none of them loads the others — so it belongs in the
  shell rather than beside any one of them. ~1 KB, no dependencies, and every
  caller null-checks it, so a page that somehow loads without it degrades to "do
  not animate" rather than to an exception.
-->
<script src="${asset('/js/motion.js')}" defer></script>
<!--
  Beside motion.js and for the same reason: the builder and the viewer both need
  it, neither loads the other, and it is a handful of pure functions with no
  dependencies. Both callers fall back to imperial if it is somehow absent, which
  is the column default and therefore the behavior every page had before #150.
-->
<script src="${asset('/js/units.js')}" defer></script>
<!--
  Beside units.js for the same reason (#321): what the app calls things is
  read by the builder, the viewer, the tips and the paddock, and a page with
  no TBVocabData renders the motorcycle words. See public/js/vocab.js.
-->
<script src="${asset('/js/vocab.js')}" defer></script>
<script src="${asset('/js/feedback-buffer.js')}" defer></script>
<script src="${asset('/js/site.js')}" defer></script>
<!--
  EVERY PAGE BUT THE SPLASH (#133). The controls it explains are on the builder,
  the viewer’s timeline and the import review, and none of those three loads the
  others — so it sits in the shell beside motion.js and units.js rather than in
  any one of their script lists.

  The splash is the exception for the reason notifications.js is: it is the one
  page that has to be small, it carries no control worth a sentence, and this
  file is mostly copy. It also installs NOTHING when the rider has turned the
  mode off — see the head of the file — so the cost on a page that does want it
  is a parse and one attribute read.
-->
${variant === 'splash' ? '' : `<script src="${asset('/js/tips.js')}" defer></script>`}
<!--
  SIGNED-IN PAGES ONLY, because the endpoint it polls is behind requireActiveApi
  and there is nothing for a signed-out visitor to be notified about. It is also
  the reason this is not folded into site.js: that file loads on the splash page,
  and a Notification constructor referenced there is dead weight on the one page
  we most want to be small.

  It raises CHROME’S OWN notifications and is not a push — no service worker, no
  VAPID keys, no dependency — so nothing appears while the site is closed. See
  the file header, and the copy on /settings that says so to the rider.
-->
${opts.user ? `<script src="${asset('/js/notifications.js')}" defer></script>` : ''}
${opts.scripts ?? ''}
<!--
  Usage analytics — the Cloudflare beacon and the GA bootstrap — PROD ONLY and
  empty everywhere else, on every variant including the splash and the 404. In
  the EU the GA half is behind the consent bar at the top of <body>. The id and
  token are interpolated unescaped, which is safe only because config.ts admits
  them through character classes that cannot close a tag; see analytics.ts.
-->
${analytics.scripts}
${IS_DEV ? liveReloadScript() : ''}
${IS_DEV ? `<script src="${asset('/js/devtools.js')}" defer></script>` : ''}
</body>
</html>`
}
