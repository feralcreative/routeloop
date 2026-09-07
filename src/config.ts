// Single source for env-derived constants. Before this existed, MAPBOX_TOKEN was
// read independently in src/index.ts and the builder's route module, and the
// Mapbox GL version was a const in index.ts but a hardcoded string twice there —
// so the viewer and the builder could silently load different library versions.
import 'dotenv/config'

// `??` only falls back on undefined, and a deploy writes every optional variable
// into the container's env whether or not it has a value — so an unset one
// arrives as the empty string and silently defeats the default below it. That
// is not hypothetical: shipping `OWNER_EMAIL=` made OWNER_EMAIL '', no address
// could ever equal it, and the owner's own account was created `pending` with
// no way to approve itself. Read every defaulted variable through this.
function env(name: string, fallback: string): string {
  const v = process.env[name]
  return v === undefined || v.trim() === '' ? fallback : v
}

export const PORT = Number(env('PORT', '6686'))

// The public origin of THIS environment. It builds the OAuth redirect URI, backs
// the CSRF gate, and decides the Secure flag on session cookies, so an https
// value is required in stage and prod.
export const APP_ORIGIN = env('APP_ORIGIN', 'http://127.0.0.1:6686')
export const IS_HTTPS_ORIGIN = APP_ORIGIN.startsWith('https://')

// "Is this someone's laptop?" Asked of APP_ORIGIN rather than NODE_ENV, which
// nothing in this project sets, and deliberately the same signal DEV_LOGIN_ENABLED
// calls its strongest gate below: stage and prod must set an https origin or
// OAuth redirects and the session cookie's Secure flag break, so this cannot be
// quietly true in a deployed environment. Gates the live-reload endpoint and the
// snippet that talks to it (src/dev/livereload.ts).
export const IS_DEV = !IS_HTTPS_ORIGIN

// Which deployed environment this is, written by utils/deploy/deploy.sh from its
// own DEPLOY_ENV. It is an OPTIONAL key — in the printf block and both compose
// color blocks, deliberately NOT in REMOTE_ENV_KEYS — because promoting it there
// makes its absence a hard failure, and the next CI deploy would refuse until
// `deploy-utils.sh push-env` had put the value on every server.
//
// So it arrives empty on any server whose .env predates it, and the APP_ORIGIN
// fallback is what covers that gap: stage is the only environment whose origin
// is a `stage.` host, and APP_ORIGIN is already required, verified and shipped to
// both colors. The variable states the answer; the origin infers it. Having both
// means the banner is correct on the deploy that introduces the key, not the one
// after it.
export const APP_ENV = env('APP_ENV', '')
export const IS_STAGE = APP_ENV === 'stage' || (APP_ENV === '' && APP_ORIGIN.startsWith('https://stage.'))

// Production is strict. In development the map libraries want localhost while
// APP_ORIGIN may say 127.0.0.1, so accept both names on the same port.
//
// This lives here rather than in an auth module because the CSRF gate, the OAuth
// redirect and the cookie flags all need it, and the module it used to live in
// (auth/access.ts) was deleted along with Cloudflare Access.
const ALLOWED_ORIGINS: ReadonlySet<string> = (() => {
  const set = new Set<string>([APP_ORIGIN])
  if (!IS_HTTPS_ORIGIN) {
    try {
      const port = new URL(APP_ORIGIN).port
      const suffix = port ? `:${port}` : ''
      set.add(`http://localhost${suffix}`)
      set.add(`http://127.0.0.1${suffix}`)
    } catch {
      // An invalid APP_ORIGIN falls back to exact matching only.
    }
  }
  return set
})()

export function isAllowedOrigin(origin: string | undefined | null): boolean {
  return origin != null && ALLOWED_ORIGINS.has(origin)
}

// The one account that is never left waiting for approval. Both databases have
// been rebuilt from empty before, and without this the owner would come back
// 'pending' after the next rebuild with nobody able to approve them.
export const OWNER_EMAIL = env('OWNER_EMAIL', 'ziad@feralcreative.co').trim().toLowerCase()

// "Is this a real database or a throwaway one?", asked of the connection string
// rather than of NODE_ENV, which nothing in this project sets. Anything that
// TRUNCATEs, seeds, or hands out a session without a password checks this first.
// It began as a private guard inside utils/seed-demo-rides.ts; it lives here now
// so the dev sign-in below and the seeders cannot disagree about what "local"
// means.
export function isLocalDatabaseUrl(url: string): boolean {
  return /@(127\.0\.0\.1|localhost|host\.docker\.internal)[:/]/.test(url)
}

export const IS_LOCAL_DATABASE = isLocalDatabaseUrl(process.env.DATABASE_URL ?? '')

/**
 * A connection string safe to print. Used by the guards that refuse to run
 * against a non-local database and need to say *which* database they refused.
 *
 * Was `url.replace(/:\/\/[^@]*@/, '://***@')`, copy-pasted into two scripts, and
 * wrong in both directions:
 *
 *   - **It leaked.** A password in the query string — `?password=…`, which libpq
 *     accepts and some hosted providers hand out — printed in full.
 *   - **It over-redacted.** `[^@]*` crosses the path, so a URL with an `@`
 *     anywhere later (`postgres://host/db?opt=a@b`) had its *host* swallowed:
 *     `postgres://***@b`. That defeats the whole point of printing it, which is
 *     to show you which database you just pointed at.
 */
export function redactDatabaseUrl(url: string): string {
  return url
    // Userinfo only: stop at the first `/` so the path can never be consumed.
    .replace(/:\/\/[^@/]*@/, '://***@')
    // Credentials that travel as query parameters.
    .replace(/([?&](?:password|passwd|pwd|sslpassword)=)[^&]*/gi, '$1***')
}

// --- Dev sign-in -------------------------------------------------------------
//
// A way into a signed-in page without a password. This is a loaded gun, so it is
// gated four ways and every gate has to hold before the route is even registered
// — see src/routes/auth.ts. Note that this codebase had something like it before
// (DEV_AUTH_EMAIL, deleted along with Cloudflare Access) and its removal was
// deliberate; this is a considered re-add, not a restoration.
//
// The gates, weakest to strongest:
//
//   1. DEV_LOGIN_EMAIL names an existing account. Read through env(), so an
//      empty value from a deploy counts as unset.
//   2. The database is local.
//   3. APP_ORIGIN is not https. This is the strongest of the four: stage and
//      prod must set it correctly or OAuth redirects and the cookie Secure flag
//      break, so it cannot be quietly wrong without sign-in failing loudly.
//   4. The request itself came from localhost — checked per request, not here.
export const DEV_LOGIN_EMAIL = env('DEV_LOGIN_EMAIL', '').trim().toLowerCase()

export const DEV_LOGIN_ENABLED = Boolean(DEV_LOGIN_EMAIL) && IS_LOCAL_DATABASE && !IS_HTTPS_ORIGIN


// Whether the account purge actually destroys accounts, OFF unless set.
//
// Every other background job in this app is safe to run unattended. That one
// deletes a person's account and everything they own, and it ships into a
// database where riders have been sitting past their promised deletion date for
// as long as the runner was missing — so its first unattended pass would take
// all of them at once. The flag is the pause between "the code exists" and "it
// is running", and `utils/purge-accounts.ts --dry-run` is what fills it.
//
// Opt-in by exact value rather than truthiness: PURGE_ACCOUNTS=false must not
// enable it, which is what a bare Boolean() on the string would do.
export const PURGE_ACCOUNTS = env('PURGE_ACCOUNTS', '').trim().toLowerCase() === 'on'

// How long a container that has been told to stop will wait for the requests it
// already has before cutting them off. See src/shutdown.ts.
//
// Ten seconds because that is what Docker's own default SIGKILL timeout is, and
// a grace period longer than the runtime's patience is a number that never gets
// used — the process is killed mid-drain and the setting reads as though it did
// something. `stop_grace_period` in docker-compose.prod.yml raises the runtime
// side to 30s so this can be tuned up to about 25 without hitting that wall.
export const DRAIN_GRACE_MS = Number(env('DRAIN_GRACE_MS', '10000'))

// Which half of a blue/green pair this container is, blank everywhere today.
//
// Phase 2 of docs/zero-downtime-deploy.md gives the two colors their own value;
// until then it reports empty, which is the honest answer for a topology with
// one container. It is read only by /healthz, so an environment that never sets
// it loses nothing.
export const APP_COLOR = env('APP_COLOR', '')

// Two Google Maps keys, and they are not interchangeable — the restriction types
// are mutually exclusive. A referrer-restricted key cannot be used server-side
// because a server sends no Referer header for Google to check, and an
// IP-restricted key cannot be used from a browser.
//
// GMAPS_KEY is referrer-restricted and ships in page source. It serves the
// legacy Google viewer today and the Maps JavaScript + Places calls after the
// migration. It is public by design; the referrer list is the only control on
// it.
export const GMAPS_KEY = env('GMAPS_KEY', '')

// IP-restricted to the origin's egress address. Routes, Geocoding and Static
// Maps. This one must never reach page(), window.TB, or any client payload.
// Empty is a supported state: while all Maps calls are made from the browser
// there is nothing for it to do.
export const GMAPS_SERVER_KEY = env('GMAPS_SERVER_KEY', '')

// A Cloud-based map style id. Advanced Markers do not render at all without one
// — they fail with a console warning and no visible marker, which reads as a
// data bug rather than a configuration one.
export const GMAPS_MAP_ID = env('GMAPS_MAP_ID', '')

// Sign in with Google. Scopes are openid + email + profile and must stay that
// way: anything sensitive or restricted drags this client through verification
// and caps the app at 100 users. See docs/google-cloud-setup.md.
export const GOOGLE_CLIENT_ID = env('GOOGLE_CLIENT_ID', '')
export const GOOGLE_CLIENT_SECRET = env('GOOGLE_CLIENT_SECRET', '')
export const GOOGLE_REDIRECT_URI = `${APP_ORIGIN}/auth/google/callback`

// Outbound mail. A credential entirely separate from the OAuth client above —
// mail is sent by the server from its own address, never as the signed-in user,
// so no Gmail scope belongs on the sign-in consent screen. It carries the
// sign-in link and every notification: the waitlist confirmation, the approval
// notice, and the owner's new-signup alert.
export const SMTP_HOST = env('SMTP_HOST', 'smtp.resend.com')
export const SMTP_PORT = Number(env('SMTP_PORT', '587'))
export const SMTP_USER = env('SMTP_USER', '')
export const SMTP_PASS = env('SMTP_PASS', '')

// Defaults to empty, NOT to SMTP_USER, and the difference is load-bearing. Under
// Gmail the SMTP user was the address, so falling back to it was right. Under
// Resend SMTP_USER is the literal string `resend`, so that fallback would make
// MAIL_FROM 'resend' — which is truthy, so MAIL_ENABLED would be true, the
// sign-in form would render, and every send would fail at the server with a 550
// that no local check could have caught.
export const MAIL_FROM = env('MAIL_FROM', '')

// Two flags, deliberately, because they answer different questions.
//
// MAIL_ENABLED is a capability: can this deployment put a message in an inbox at
// all? Every notification asks it, and it is what mailer.ts gates on.
export const MAIL_ENABLED = Boolean(SMTP_USER && SMTP_PASS && MAIL_FROM)

// MAGIC_LINK_ENABLED is a product decision: is emailed sign-in *offered*? The
// same expression today, and kept as its own name so a deployment that wants
// Google-only sign-in while still mailing approvals has something to turn off.
// Feature flag by omission, matching turnstile.ts: with no credentials the form
// is not offered rather than offered and broken.
export const MAGIC_LINK_ENABLED = MAIL_ENABLED

// Alpha splash links. These deliberately keep `??` rather than env(): for these
// four, empty is a meaningful value that omits the link instead of rendering a
// dead one, so collapsing '' to the default would remove the only way to turn
// one off. They are also never written by the deploy, so the empty-string
// hazard env() exists for cannot reach them.
export const ALPHA_GITHUB_URL = process.env.ALPHA_GITHUB_URL ?? 'https://github.com/feralcreative/routeloop/issues'
export const ALPHA_SIGNAL_URL = process.env.ALPHA_SIGNAL_URL ?? 'https://feral.ly/signal'
export const ALPHA_DISCORD_URL = process.env.ALPHA_DISCORD_URL ?? 'https://discord.gg/5wqFRxqzxN'
export const ALPHA_VMC_URL = process.env.ALPHA_VMC_URL ?? 'https://vampiresmc.com'
