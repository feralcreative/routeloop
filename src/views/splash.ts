// The "this is an alpha" modal, injected into every page by page(). Behavior
// (show/dismiss/remember) lives in public/js/site.js.
import { ALPHA_DISCORD_URL, ALPHA_GITHUB_URL, ALPHA_SIGNAL_URL } from '../config'
import { esc } from './layout'

type Link = { url: string; label: string }

// An unset URL drops its row rather than rendering a link that goes nowhere.
function linkRow({ url, label }: Link): string {
  if (!url) return ''
  return `<li><a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a></li>`
}

export function alphaSplash(): string {
  const links = [
    { url: ALPHA_GITHUB_URL, label: 'Report an issue on GitHub' },
    { url: ALPHA_SIGNAL_URL, label: 'Message me on Signal' },
    { url: ALPHA_DISCORD_URL, label: 'Vampires MC Discord' },
  ]
    .map(linkRow)
    .join('')

  return `<div class="modal-backdrop" id="alpha-splash" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="alpha-title" aria-describedby="alpha-body">
    <img class="modal-logo" src="/img/logo-tankbag-vert-light.svg" alt="" width="864" height="618">
    <h2 id="alpha-title">This is an alpha</h2>
    <div id="alpha-body" class="modal-body">
      <p>TankBag is an early build of something I'm making. Expect rough edges,
         missing pieces, and the occasional data reset. Feedback is the whole point.</p>
      ${links ? `<ul class="modal-links">${links}</ul>` : ''}
    </div>
    <label class="modal-dismiss">
      <input type="checkbox" id="alpha-hide"> Don't show this again
    </label>
    <button type="button" class="btn" data-close-alpha>Got it</button>
  </div>
</div>`
}
