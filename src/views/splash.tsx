// The "this is an alpha" modal, injected into every page by page(). Behavior
// (show/dismiss/remember) lives in public/js/site.js, which also carries the
// ?alpha=1 design hook that pins this open on a local host.
import { raw } from 'hono/html'
import { ALPHA_DISCORD_URL, ALPHA_GITHUB_URL, ALPHA_SIGNAL_URL, ALPHA_VMC_URL } from '../config'
import { icon } from './icon'

// `name` is both the icon file (`icon-<name>.svg`) and the CSS hook that gives
// the mark its brand color, so the two cannot drift apart.
//
// Two labels rather than one: `label` is the caption under the mark and has to
// stay short enough that four of them fit across a 460px modal, while `title`
// is the full sentence the row used to read as. The long one is not discarded —
// it becomes the accessible name and the tooltip, so nothing is lost by the
// caption being a word or two.
//
// `embed` picks how the mark reaches the page, and it is a property of the
// artwork rather than a preference. The first three are a disc in
// `currentColor` with the glyph knocked out, so they have to be IN the document
// for the color to reach them. The Vampires MC mark carries its own colors on
// its own black disc, needs nothing inherited, and is 64 KB of path data — this
// modal is injected into EVERY page, so inlining it would put 64 KB on every
// HTML response, uncacheable, to draw one 44px logo. As an <img> the browser
// fetches it once and caches it.
type Link = { url: string; name: string; label: string; title: string; embed: 'inline' | 'img' }

const LINKS: Link[] = [
  { url: ALPHA_GITHUB_URL, name: 'github', label: 'GitHub', title: 'Report an issue on GitHub', embed: 'inline' },
  { url: ALPHA_SIGNAL_URL, name: 'signal', label: 'Signal', title: 'Message me on Signal', embed: 'inline' },
  { url: ALPHA_DISCORD_URL, name: 'discord', label: 'Discord', title: 'Vampires MC Discord', embed: 'inline' },
  { url: ALPHA_VMC_URL, name: 'vmc', label: 'Vampires MC', title: 'Vampires MC', embed: 'img' },
]

export function alphaSplash(): string {
  // An unset URL drops its row rather than rendering a link that goes nowhere,
  // and if all three are unset the list disappears with them. Filtering before
  // the map rather than returning '' per row, because JSX has no equivalent of
  // "render nothing" that also removes the empty <ul>.
  const links = LINKS.filter((l) => l.url)

  return (
    <div class="modal-backdrop" id="alpha-splash" hidden>
      {/*
        tabindex="-1" so site.js can move focus to the DIALOG on open rather than
        to the first control inside it. Focusing the first control ringed the
        GitHub mark every time the modal appeared, which reads as a selection
        nobody made. Programmatically focusable, never tab-focusable — the -1 is
        what keeps it out of the tab order and out of FOCUSABLE in site.js.
      */}
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="alpha-title"
        aria-describedby="alpha-body"
        tabindex={-1}
      >
        {/* .modal is $white, so this takes the dark artwork, not the reversed one. */}
        <img class="modal-logo" src="/img/logo-routeloop.svg" alt="" width="920" height="518" />
        <h2 id="alpha-title">This is an alpha</h2>
        <div id="alpha-body" class="modal-body">
          <p>
            Routeloop is an early build of something I’m making. Expect rough edges, missing pieces, and the occasional
            data reset. Feedback is the whole point.
          </p>
          {links.length > 0 && (
            <ul class="modal-links">
              {links.map((l) => (
                <li>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener"
                    class={`modal-link is-${l.name}`}
                    title={l.title}
                    aria-label={l.title}
                  >
                    {l.embed === 'inline' ? (
                      raw(icon(l.name))
                    ) : (
                      <img src={`/img/icons/icon-${l.name}.svg`} alt="" width="1000" height="1000" />
                    )}
                    <span>{l.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <label class="modal-dismiss">
          <input type="checkbox" id="alpha-hide" /> Don’t show this again
        </label>
        {/*
          The guide-sign treatment with a flanking pair of up arrows —
          `arrow-both` puts one at each end and `arrow-n` points them both north.
          Ziad's call, 2026-08-21.
        */}
        <button type="button" class="btn btn-sign arrow-both arrow-n" data-close-alpha>
          Got it
        </button>
      </div>
    </div>
  ).toString()
}

// --- The full-bleed page chrome ---------------------------------------------

// The splash pages — sign in, choose a name, the holding page, and the invite
// landing — share this. It was three copies of the same markup before, differing
// only in the eyebrow, the heading and what sits under them.
//
// Moved here from routes/auth.tsx when the invite page became the fourth: a
// route module importing chrome from another route module is the wrong shape,
// and this file is already where the splash-surface views live.
function SplashMedia() {
  return (
    <div class="splash-media" aria-hidden="true">
      <video
        class="splash-video"
        data-src="/video/routeloop-intro.mp4"
        autoplay
        loop
        muted
        playsinline
        preload="none"
        disablepictureinpicture
        disableremoteplayback
      ></video>
    </div>
  )
}

export function SplashPage({ eyebrow, heading, children }: { eyebrow: string; heading: string; children?: unknown }) {
  return (
    <>
      <SplashMedia />
      <main class="splash">
        {/*
          The reversed lockup — `-dk` names the ground it sits on, not the ink.
          This is over the darkened video, and it was the dark artwork here until
          2026-08-09, at 1456x426 against a file that was actually 1595x456, so
          it was both invisible and stretched 2%.

          The STACKED mark, where every other splash-era version of this was the
          horizontal one. That lockup is now 8.15:1, and nothing this page can do
          with width buys back the height a logo needs to hold its own beside the
          headline: at the 420px it used to occupy it renders 52px tall against
          the old 123px. The stacked mark gets there at 240px wide.
        */}
        <img class="splash-logo" src="/img/logo-routeloop-dk.svg" alt="Routeloop" width="920" height="518" />
        <p class="eyebrow">{eyebrow}</p>
        <h1>{heading}</h1>
        {children}
      </main>
    </>
  )
}
