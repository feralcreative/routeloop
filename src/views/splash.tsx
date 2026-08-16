// The "this is an alpha" modal, injected into every page by page(). Behavior
// (show/dismiss/remember) lives in public/js/site.js.
import { ALPHA_DISCORD_URL, ALPHA_GITHUB_URL, ALPHA_SIGNAL_URL } from '../config'

type Link = { url: string; label: string }

const LINKS: Link[] = [
  { url: ALPHA_GITHUB_URL, label: 'Report an issue on GitHub' },
  { url: ALPHA_SIGNAL_URL, label: 'Message me on Signal' },
  { url: ALPHA_DISCORD_URL, label: 'Vampires MC Discord' },
]

export function alphaSplash(): string {
  // An unset URL drops its row rather than rendering a link that goes nowhere,
  // and if all three are unset the list disappears with them. Filtering before
  // the map rather than returning '' per row, because JSX has no equivalent of
  // "render nothing" that also removes the empty <ul>.
  const links = LINKS.filter((l) => l.url)

  return (
    <div class="modal-backdrop" id="alpha-splash" hidden>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="alpha-title" aria-describedby="alpha-body">
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
                  <a href={l.url} target="_blank" rel="noopener">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <label class="modal-dismiss">
          <input type="checkbox" id="alpha-hide" /> Don’t show this again
        </label>
        <button type="button" class="btn" data-close-alpha>
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
