// The 404 page.
//
// A PHOTOGRAPH OF A CLOSED ROAD, FULL BLEED, WITH THE ORDINARY CHROME OVER IT.
// Ziad's call, 2026-09-10. The chrome is the half that matters: a dead end whose
// only way out is one link is a second dead end, and the rider who lands here
// most often is the one who followed a share link to a ride that has since been
// binned — they want the nav, not a poster.
//
// `variant: 'chrome'` rather than 'map', although the map pages are the app's
// other surface with chrome floating over arbitrary imagery. The map variant
// drops `.page-wrap` and brings a dozen layout custom properties this page has
// no use for; what is borrowed from it is the ANSWER to legibility over
// imagery — see style/_not-found.scss, which reuses the drawer-at-every-width
// shape below 992px and lights the bar's ink above it.
import { page } from './layout'
import type { UserRow } from '../db/schema'

/**
 * `detail` is the one sentence that changes by caller.
 *
 * The catch-all cannot say anything true about WHY — an unmatched URL is a
 * typo as often as it is a dead link — so it passes nothing and the page says
 * only what it knows. The ride viewer passes the sentence a rider following a
 * share link actually needs, which is that a ride can stop being reachable
 * without anybody having removed the link.
 */
export function notFoundPage(user: UserRow | null, detail?: string): string {
  return page({
    title: 'Road closed',
    user,
    bodyClass: 'notfound-page',
    // `.toString()` for the reason views/account-page.tsx does it: a JSX tree
    // holding a conditional child types as `HtmlEscapedString | Promise<…>`, and
    // page() takes a string. Nothing here is async, so the string is already
    // resolved.
    body: (
      <div class="notfound">
        <div class="notfound-card">
          {/*
            The shield IS the heading: it already says Error, Page not found
            and 404, so the old eyebrow and headline would only repeat it.
          */}
          <h1 class="notfound-head">
            <img class="notfound-shield" src="/img/404.svg" alt="Error 404: page not found" width="2207" height="1818" />
          </h1>
          <p class="notfound-lede">This one doesn’t go through.</p>
          {detail ? <p class="notfound-detail">{detail}</p> : ''}
          <p class="notfound-actions">
            {/*
              One button, and it is `/` for a signed-out reader too — that route
              renders the splash rather than refusing, so the label is the only
              thing that has to know who is reading.

              `.arrow-left` puts the guide sign's arrow on the left pointing
              west, which is the one bearing that means what this button does.
            */}
            <a class="btn arrow-left" href="/">
              {user ? 'Back to your dashboard' : 'Back to the start'}
            </a>
          </p>
        </div>
      </div>
    ).toString(),
  })
}
