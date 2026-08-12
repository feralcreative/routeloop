// Sign in with Google, server side, via Arctic's OAuth2 client.
//
// The scope list is exactly openid + email + profile and must stay that way.
// Anything sensitive or restricted turns this into an app that needs Google's
// verification review and caps the whole project at 100 users until it passes —
// see docs/google-cloud-setup.md.
import { Google, generateCodeVerifier, generateState } from 'arctic'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } from '../config'
import { SECURE_COOKIES } from './session'
import type { VerifiedIdentity } from './identity'

export const GOOGLE_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)

const SCOPES = ['openid', 'email', 'profile']

const STATE_COOKIE = 'routeloop_oauth_state'
const VERIFIER_COOKIE = 'routeloop_oauth_verifier'
// Long enough to pick an account and type a password, short enough that an
// abandoned attempt does not leave a usable verifier lying around.
const HANDSHAKE_TTL_S = 10 * 60

const google = new Google(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)

// SameSite must be Lax, not Strict: these cookies have to survive the top-level
// redirect back from accounts.google.com, and Strict would drop them on exactly
// that navigation — the failure looks like a random invalid-state error.
function handshakeCookie(c: Context, name: string, value: string): void {
  setCookie(c, name, value, {
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: 'Lax',
    path: '/',
    maxAge: HANDSHAKE_TTL_S,
  })
}

export function startGoogleLogin(c: Context): string {
  const state = generateState()
  const codeVerifier = generateCodeVerifier()

  handshakeCookie(c, STATE_COOKIE, state)
  handshakeCookie(c, VERIFIER_COOKIE, codeVerifier)

  return google.createAuthorizationURL(state, codeVerifier, SCOPES).toString()
}

export class GoogleAuthError extends Error {}

// `name` is deliberately absent and must not come back. Adopting a rider's real
// name from Google and putting it on a surface they did not choose is the exact
// thing the signup prompt exists to stop; display_name is theirs to pick.
//
// `picture` was never here for the same reason. Note that users.avatar_url
// already exists and is never written, which makes wiring this claim to it look
// like finishing an unfinished job rather than starting a privacy problem.
//
// given_name / family_name are different, and only because of where they land:
// user_profiles, which is private and shown to nobody but the rider. See the
// seeding comment in identity.ts for why that distinction holds.
type GoogleClaims = {
  sub?: string
  email?: string
  email_verified?: boolean
  given_name?: string
  family_name?: string
}

// The id token is a JWT signed by Google and delivered over a TLS connection to
// Google's own token endpoint, so its payload is trustworthy without a local
// signature check. Verifying it properly would mean fetching and caching JWKS;
// that is worth doing only if the token ever starts arriving from somewhere
// other than validateAuthorizationCode.
function decodeIdToken(idToken: string): GoogleClaims {
  const payload = idToken.split('.')[1]
  if (!payload) throw new GoogleAuthError('malformed id token')
  const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  return JSON.parse(json) as GoogleClaims
}

export async function completeGoogleLogin(c: Context): Promise<VerifiedIdentity> {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const storedState = getCookie(c, STATE_COOKIE)
  const codeVerifier = getCookie(c, VERIFIER_COOKIE)

  // Whatever happens next, these are single-use.
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: SECURE_COOKIES })
  deleteCookie(c, VERIFIER_COOKIE, { path: '/', secure: SECURE_COOKIES })

  if (c.req.query('error')) throw new GoogleAuthError(`google returned ${c.req.query('error')}`)
  if (!code || !state || !codeVerifier) throw new GoogleAuthError('missing code, state or verifier')
  // The CSRF check for the OAuth handshake: a callback the browser did not start
  // carries no matching state cookie.
  if (state !== storedState) throw new GoogleAuthError('state mismatch')

  let tokens
  try {
    tokens = await google.validateAuthorizationCode(code, codeVerifier)
  } catch {
    throw new GoogleAuthError('code exchange failed')
  }

  const claims = decodeIdToken(tokens.idToken())
  if (!claims.sub) throw new GoogleAuthError('id token has no subject')

  const email = claims.email?.trim().toLowerCase()
  // An unverified address would let someone claim an account by signing up to
  // Google with an address they do not control. resolveUser() links accounts by
  // email, so this check is load-bearing rather than cosmetic.
  if (!email || claims.email_verified !== true) {
    throw new GoogleAuthError('google account has no verified email')
  }

  return {
    provider: 'google',
    providerUserId: claims.sub,
    email,
    firstName: claims.given_name,
    lastName: claims.family_name,
  }
}
