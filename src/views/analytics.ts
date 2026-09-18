// Usage analytics: Google Analytics 4 and the Cloudflare Web Analytics beacon,
// on every rendered page, IN PRODUCTION ONLY. Ziad's call, 2026-09-17, and the
// stance it encodes is his: measuring how the site is used, in order to improve
// it, is expected and fine; the numbers are never sold, traded, shared or
// monetized, there is no advertising, and the rider is not the product. The
// privacy page says all of that in the rider's terms; this file is what makes
// it true in the markup.
//
// TWO HALVES, RULE FROM QUERY, the src/access/policy.ts arrangement. Everything
// above `viewerCountry()` is a function of its arguments and is what
// test/analytics.test.ts pins; the two functions below it read the config and
// the request and are the only wired part.
//
// THE CONSENT RULE. In the EU, EEA, UK, and Switzerland — and over Tor, where
// Cloudflare cannot say — GA is not loaded until the visitor says yes to a bar
// at the top of the page; everyone else gets no prompt and no bar, because
// nobody else's law asks and the cookie bar is the thing everybody hates. The
// Cloudflare beacon is cookieless, holds no identifier, and loads for everyone
// without asking. The choice is remembered in localStorage and never reaches
// the server, which is why the SERVER's answer is only ever "ask" or "do not
// ask" and never "granted": `consent.js` is the one place that reads the
// choice, in both modes, so a stored "No thanks" is honored wherever the rider
// opens the site from.
//
// VALIDATION IS THE ESCAPING. Nothing here escapes the id or the token, on the
// strength of the character classes config.ts admits them through — see the
// comment above `isGaMeasurementId` there. Every builder in this file returns
// '' for a value that fails them, so a test can hand them `</script>` and
// assert on emptiness rather than on an escape.
import { tryGetContext } from 'hono/context-storage'
import {
  ANALYTICS_DEV_COUNTRY,
  CF_BEACON_TOKEN,
  GA_MEASUREMENT_ID,
  IS_PROD,
  isCfBeaconToken,
  isGaMeasurementId,
} from '../config'
import { asset } from './assets'
import { jsonScript } from './json-script'

export type GaMode = 'direct' | 'consent' | 'off'
export type AnalyticsPlan = { ga: GaMode; cf: boolean }

// EU27, then the three EEA states, then the UK and Switzerland, then T1 — the
// code Cloudflare sends for a Tor exit, where the country is unknowable and the
// only honest answer is to ask. Uppercase ISO 3166-1 alpha-2, which is what the
// CF-IPCountry header carries.
const EU27 = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'
const EEA = 'IS LI NO'
export const CONSENT_COUNTRIES: ReadonlySet<string> = new Set(`${EU27} ${EEA} GB CH T1`.split(' '))

/** Does the law where this visitor is ask before an analytics cookie is set? */
export function isConsentCountry(code: string): boolean {
  return CONSENT_COUNTRIES.has(code.trim().toUpperCase())
}

/**
 * What to emit, decided once per render. `country` is the raw header value —
 * '' when there is none, 'XX' when Cloudflare could not say — and both of those
 * read as "not a consent country", because prod only ever answers from behind
 * Cloudflare and a missing header there is a proxy fault, not a visitor.
 */
export function analyticsPlan(i: { prod: boolean; country: string; gaId: string; cfToken: string }): AnalyticsPlan {
  if (!i.prod) return { ga: 'off', cf: false }
  const ga: GaMode = !isGaMeasurementId(i.gaId) ? 'off' : isConsentCountry(i.country) ? 'consent' : 'direct'
  return { ga, cf: isCfBeaconToken(i.cfToken) }
}

/**
 * The GA bootstrap: the id and whether to ask, handed to consent.js, which is
 * the one loader in both modes. Deliberately NOT Google's inline snippet even
 * when nobody is asked — that would be a second loader to keep in step with the
 * first, and it could not honor a "No thanks" stored on an earlier visit.
 */
export function gaBootstrap(id: string, ask: boolean): string {
  if (!isGaMeasurementId(id)) return ''
  return `${jsonScript('TBConsent', { gaId: id, ask })}\n<script src="${asset('/js/consent.js')}" defer></script>`
}

/**
 * Cloudflare's beacon, verbatim from their JS-snippet setup. No SRI: the script
 * is unversioned, the same reason Turnstile's tag in routes/import.tsx has none.
 * A snippet the site ships rather than one Cloudflare injects at the edge — so
 * it is in view-source, it is in the repo, and it does not depend on the edge
 * rewriting HTML, which a `no-transform` header would silently stop.
 */
export function cfBeaconSnippet(token: string): string {
  if (!isCfBeaconToken(token)) return ''
  return `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${token}"}'></script>`
}

/**
 * The consent bar, rendered HIDDEN. consent.js un-hides it only when no choice
 * is stored, so a rider who has answered never sees it flash. It borrows the
 * staging banner's construction (`.tb-banner`, fixed at the top, height fed to
 * `--banner-h` by site.js) and takes the blue sign field: it is information,
 * not a warning — amber on every first visit would say something is wrong
 * about a site that is fine. `.consent-row` carries the flex layout and the
 * banner itself sets no `display`, or `hidden` would stop working on it.
 * `role="region"` rather than a live region: a landmark with two buttons is a
 * thing a screen reader can find and return to, where announcing it would
 * interrupt whatever the page was reading.
 */
export function consentBarHtml(): string {
  return `<div id="consent-bar" class="tb-banner is-consent" role="region" aria-label="Analytics choice" hidden>
  <div class="consent-row">
    <span class="consent-text">Routeloop counts how the site is used so it can be made better. Nothing is sold or shared, ever, and <a href="/privacy">the privacy page says exactly what is counted</a>.</span>
    <span class="consent-actions">
      <button type="button" class="btn" data-consent="granted">Fine by me</button>
      <button type="button" class="btn btn-quiet" data-consent="denied">No thanks</button>
    </span>
  </div>
</div>`
}

// --- Wired -------------------------------------------------------------------

/**
 * The visitor's country, as Cloudflare reports it on every request that comes
 * through the edge. THE ONE PLACE A VIEW READS THE REQUEST. page() is
 * `(opts) => string` with three dozen call sites that never pass the context,
 * and threading a country through all of them for one boolean was rejected;
 * Hono's contextStorage() (registered in src/index.tsx) makes the current
 * context reachable from anywhere under the request, and this is the only
 * reader. It asks one header one question. Do not add a second reader without
 * a recorded call — the comment above page() that it never sees a path is what
 * keeps routing out of the view layer.
 *
 * `tryGetContext()` is undefined outside a request — a test, a script — and
 * that reads as '' → not a consent country → in dev, off anyway. The dev knob
 * is consulted only when no header arrived, so a real header always wins.
 */
export function viewerCountry(): string {
  const fromHeader = tryGetContext()?.req.header('cf-ipcountry')
  return (fromHeader ?? ANALYTICS_DEV_COUNTRY).trim().toUpperCase()
}

/**
 * Everything page() emits for analytics: `bar` goes in the staging banner's
 * slot at the top of <body>, `scripts` at the tail. Both are '' unless this is
 * production (or the dev knob is set) and at least one key is configured.
 * `enabled: false` is the opt-out for a page whose PATH carries a secret — the
 * invite page — because a page view sends the address to Google.
 */
export function analyticsMarkup(opts: { enabled?: boolean } = {}): { bar: string; scripts: string } {
  if (opts.enabled === false) return { bar: '', scripts: '' }
  const plan = analyticsPlan({
    prod: IS_PROD || ANALYTICS_DEV_COUNTRY !== '',
    country: viewerCountry(),
    gaId: GA_MEASUREMENT_ID,
    cfToken: CF_BEACON_TOKEN,
  })
  const scripts: string[] = []
  if (plan.cf) scripts.push(cfBeaconSnippet(CF_BEACON_TOKEN))
  if (plan.ga !== 'off') scripts.push(gaBootstrap(GA_MEASUREMENT_ID, plan.ga === 'consent'))
  return { bar: plan.ga === 'consent' ? consentBarHtml() : '', scripts: scripts.join('\n') }
}
