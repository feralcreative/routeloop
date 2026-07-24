// OAuth entry points and callbacks. The state check and the PKCE verifier are
// handled here on purpose rather than inside a middleware, since they are the
// security-critical part of the flow.
import * as arctic from 'arctic'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AuthEnv } from '../auth/middleware'
import {
  github,
  githubProfile,
  google,
  googleProfile,
  enabledProviders,
  resolveUser,
  isAllowedOrigin,
  type Provider,
} from '../auth/oauth'
import {
  clearSessionCookie,
  createSession,
  invalidateSession,
  setOAuthCookie,
  setSessionCookie,
  takeOAuthCookie,
} from '../auth/session'
import { esc, page } from '../views/layout'

export const authRoutes = new Hono<AuthEnv>()

const STATE_COOKIE = (p: Provider) => `oauth_state_${p}`
const VERIFIER_COOKIE = 'oauth_verifier_google'

const PROVIDER_LABEL: Record<Provider, string> = {
  google: 'Continue with Google',
  github: 'Continue with GitHub',
}

authRoutes.get('/login', (c) => {
  if (c.get('user')) return c.redirect('/dashboard', 302)

  const available = enabledProviders()
  const buttons = available.map((p) => `<a class="provider" href="/auth/${p}">${PROVIDER_LABEL[p]}</a>`).join('')

  const body = available.length
    ? `<h1>Sign in</h1>
       <div class="sub">Sign in to upload and manage your route maps.</div>
       ${buttons}`
    : `<h1>Sign in</h1>
       <p class="note">No sign-in provider is configured on this server yet.
       Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET or GITHUB_CLIENT_ID /
       GITHUB_CLIENT_SECRET and restart.</p>`

  return c.html(page({ title: 'Sign in — tankbag', user: null, body }))
})

// --- Google ---------------------------------------------------------------

authRoutes.get('/auth/google', (c) => {
  if (!google) return c.text('Google sign-in is not configured', 503)

  const state = arctic.generateState()
  const codeVerifier = arctic.generateCodeVerifier()
  setOAuthCookie(c, STATE_COOKIE('google'), state)
  setOAuthCookie(c, VERIFIER_COOKIE, codeVerifier)

  const url = google.createAuthorizationURL(state, codeVerifier, ['openid', 'email', 'profile'])
  return c.redirect(url.toString(), 302)
})

authRoutes.get('/auth/google/callback', async (c) => {
  if (!google) return c.text('Google sign-in is not configured', 503)

  const code = c.req.query('code') ?? ''
  const state = c.req.query('state') ?? ''
  const expectedState = takeOAuthCookie(c, STATE_COOKIE('google'))
  const codeVerifier = takeOAuthCookie(c, VERIFIER_COOKIE)

  // A missing or mismatched state means this callback was not initiated by us.
  if (!code || !state || !expectedState || state !== expectedState || !codeVerifier) {
    return c.text('Sign-in request expired or was tampered with. Please try again.', 400)
  }

  try {
    const tokens = await google.validateAuthorizationCode(code, codeVerifier)
    const profile = googleProfile(tokens.idToken())
    const user = await resolveUser(profile)
    setSessionCookie(c, await createSession(user.id))
    return c.redirect('/dashboard', 302)
  } catch (e) {
    return oauthFailure(c, 'google', e)
  }
})

// --- GitHub ---------------------------------------------------------------
// GitHub OAuth Apps do not implement PKCE, so this flow carries state only.

authRoutes.get('/auth/github', (c) => {
  if (!github) return c.text('GitHub sign-in is not configured', 503)

  const state = arctic.generateState()
  setOAuthCookie(c, STATE_COOKIE('github'), state)

  const url = github.createAuthorizationURL(state, ['user:email'])
  return c.redirect(url.toString(), 302)
})

authRoutes.get('/auth/github/callback', async (c) => {
  if (!github) return c.text('GitHub sign-in is not configured', 503)

  const code = c.req.query('code') ?? ''
  const state = c.req.query('state') ?? ''
  const expectedState = takeOAuthCookie(c, STATE_COOKIE('github'))

  if (!code || !state || !expectedState || state !== expectedState) {
    return c.text('Sign-in request expired or was tampered with. Please try again.', 400)
  }

  try {
    const tokens = await github.validateAuthorizationCode(code)
    const profile = await githubProfile(tokens.accessToken())
    const user = await resolveUser(profile)
    setSessionCookie(c, await createSession(user.id))
    return c.redirect('/dashboard', 302)
  } catch (e) {
    return oauthFailure(c, 'github', e)
  }
})

// --- Logout ---------------------------------------------------------------
// POST, so a link or a prefetch cannot sign anyone out. The Origin check plus a
// SameSite=Lax session cookie covers the cross-site case.
authRoutes.post('/logout', async (c) => {
  const origin = c.req.header('Origin')
  if (origin && !isAllowedOrigin(origin)) return c.text('Bad origin', 403)

  const sessionId = c.get('sessionId')
  if (sessionId) await invalidateSession(sessionId)
  clearSessionCookie(c)
  return c.redirect('/', 302)
})

// Log the real cause server-side; show the user something that leaks nothing.
function oauthFailure(c: Context<AuthEnv>, provider: Provider, e: unknown): Response {
  if (e instanceof arctic.OAuth2RequestError) {
    console.error(`[auth] ${provider} rejected the authorization code:`, e.code, e.message)
  } else if (e instanceof arctic.ArcticFetchError) {
    console.error(`[auth] ${provider} token request could not be sent:`, e.cause)
  } else {
    console.error(`[auth] ${provider} sign-in failed:`, e)
  }
  return c.html(
    page({
      title: 'Sign-in failed — tankbag',
      user: null,
      body: `<h1>Sign-in failed</h1>
             <p class="note">Something went wrong talking to ${esc(provider)}. Please <a href="/login">try again</a>.</p>`,
    }),
    500,
  )
}
