// Single source for env-derived constants. Before this existed, MAPBOX_TOKEN was
// read independently in src/index.ts and src/routes/rides.ts, and the Mapbox GL
// version was a const in index.ts but a hardcoded string twice in rides.ts —
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

export const MAPBOX_TOKEN = env('MAPBOX_TOKEN', '')
export const MAPBOX_GL_VERSION = 'v3.10.0'

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

// Magic-link delivery. A credential entirely separate from the OAuth client
// above — mail is sent by the server from its own address, never as the
// signed-in user, so no Gmail scope belongs on the sign-in consent screen.
export const SMTP_HOST = env('SMTP_HOST', 'smtp.gmail.com')
export const SMTP_PORT = Number(env('SMTP_PORT', '587'))
export const SMTP_USER = env('SMTP_USER', '')
export const SMTP_PASS = env('SMTP_PASS', '')
export const MAIL_FROM = env('MAIL_FROM', SMTP_USER)

// Feature flag by omission, matching how turnstile.ts already behaves: with no
// credentials the magic-link form is not offered rather than offered and broken.
export const MAGIC_LINK_ENABLED = Boolean(SMTP_USER && SMTP_PASS && MAIL_FROM)

// Alpha splash links. These deliberately keep `??` rather than env(): for these
// three, empty is a meaningful value that omits the link instead of rendering a
// dead one, so collapsing '' to the default would remove the only way to turn
// one off. They are also never written by the deploy, so the empty-string
// hazard env() exists for cannot reach them.
export const ALPHA_GITHUB_URL =
  process.env.ALPHA_GITHUB_URL ?? 'https://github.com/feralcreative/tankbag/issues'
export const ALPHA_SIGNAL_URL = process.env.ALPHA_SIGNAL_URL ?? 'https://feral.ly/signal'
export const ALPHA_DISCORD_URL = process.env.ALPHA_DISCORD_URL ?? 'https://discord.gg/5wqFRxqzxN'
