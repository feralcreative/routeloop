// Authentication is the app's own concern now. Cloudflare Access was billed per
// seat, which made it unusable the moment signups opened; it and its trusted
// identity header are gone. Two ways in — Google OAuth and an emailed link —
// both landing in the same session model, with users.status still deciding who
// is actually allowed through.
import { Hono } from 'hono'
import { currentUser, requireAuth, type AuthEnv } from '../auth/middleware'
import { completeGoogleLogin, GoogleAuthError, GOOGLE_ENABLED, startGoogleLogin } from '../auth/google'
import { resolveUser } from '../auth/identity'
import { MagicLinkError, normalizeEmail, redeemMagicLink, requestMagicLink } from '../auth/magic'
import { clearSessionCookie, createSession, invalidateSession, setSessionCookie } from '../auth/session'
import {
  ALPHA_DISCORD_URL,
  ALPHA_GITHUB_URL,
  ALPHA_SIGNAL_URL,
  MAGIC_LINK_ENABLED,
  isAllowedOrigin,
} from '../config'
import { esc, page } from '../views/layout'

export const authRoutes = new Hono<AuthEnv>()

const SPLASH_MEDIA = `<div class="splash-media" aria-hidden="true">
        <video class="splash-video" data-src="/video/tankbag-intro.mp4"
               autoplay loop muted playsinline preload="none"
               disablepictureinpicture disableremoteplayback></video>
       </div>`

// --- Sign in ----------------------------------------------------------------

// Signing up and signing in are the same request: an address Google verifies
// either has an account or gets one created as 'pending'. The copy is the whole
// distinction, which is why both controls point at the same route.
authRoutes.get('/login', (c) => {
  if (c.get('user')) return c.redirect('/', 302)

  const notice = c.req.query('sent') === '1'
  const failed = c.req.query('error')

  const googleButton = GOOGLE_ENABLED
    ? `<a class="provider" href="/auth/google">Sign in with Google</a>`
    : `<p class="note">Google sign-in is not configured.</p>`

  // Offered only when a sender exists — a form that always fails is worse than
  // no form. Same reasoning as turnstile.ts's feature flag.
  const magicForm = MAGIC_LINK_ENABLED
    ? `<form class="magic-form" method="post" action="/auth/magic">
         <label class="visually-hidden" for="magic-email">Email address</label>
         <input id="magic-email" name="email" type="email" required
                autocomplete="email" placeholder="you@example.com">
         <button class="btn" type="submit">Email me a link</button>
       </form>`
    : ''

  return c.html(
    page({
      title: 'Sign in',
      user: null,
      variant: 'splash',
      body: `${SPLASH_MEDIA}
       <main class="splash">
       <img class="splash-logo" src="/img/logo-tankbag-vert-dark.svg" alt="TankBag" width="864" height="618">
       <p class="eyebrow">Plan the whole ride</p>
       <h1>Every stop. Every day. One map.</h1>
       <p class="splash-copy">Build motorcycle rides and road trips, organize the places that matter, and share the complete plan with the group.</p>
       ${notice ? `<p class="notice">Check your email — if that address has access, a sign-in link is on its way.</p>` : ''}
       ${failed ? `<p class="notice is-error">${esc(failed === 'link' ? 'That link is invalid, already used, or expired. Request a new one.' : 'Sign-in failed. Please try again.')}</p>` : ''}
       <div class="providers">
         ${googleButton}
         ${magicForm}
         <p class="provider-alt">Not a member yet? Signing in creates your account.</p>
       </div>
       </main>`,
    }),
  )
})

// --- Google -----------------------------------------------------------------

authRoutes.get('/auth/google', (c) => {
  if (!GOOGLE_ENABLED) return c.text('Google sign-in is not configured.', 503)
  if (c.get('user')) return c.redirect('/', 302)
  return c.redirect(startGoogleLogin(c), 302)
})

authRoutes.get('/auth/google/callback', async (c) => {
  if (!GOOGLE_ENABLED) return c.text('Google sign-in is not configured.', 503)

  try {
    const identity = await completeGoogleLogin(c)
    const user = await resolveUser(identity)
    setSessionCookie(c, await createSession(user.id))
    return c.redirect('/', 302)
  } catch (err) {
    if (err instanceof GoogleAuthError) {
      // Details go to the log, not the page — the reasons are all things a
      // caller probing the endpoint would like to know.
      console.warn('[auth] google sign-in failed:', err.message)
      return c.redirect('/login?error=google', 302)
    }
    throw err
  }
})

// --- Magic link -------------------------------------------------------------

authRoutes.post('/auth/magic', async (c) => {
  if (!MAGIC_LINK_ENABLED) return c.text('Email sign-in is not configured.', 503)

  const origin = c.req.header('Origin')
  if (origin && !isAllowedOrigin(origin)) return c.text('Bad origin', 403)

  const body = await c.req.parseBody()
  const email = normalizeEmail(String(body.email ?? ''))

  // Everything below returns the same redirect. A different response for a
  // missing account, a rate limit, or a send failure would turn this endpoint
  // into a way to enumerate who has an account.
  if (email) {
    try {
      await requestMagicLink(email, c.req.header('cf-connecting-ip') ?? 'local')
    } catch (err) {
      console.error('[auth] magic link request failed:', err instanceof Error ? err.message : err)
    }
  }

  return c.redirect('/login?sent=1', 302)
})

authRoutes.get('/auth/magic/:token', async (c) => {
  try {
    const user = await redeemMagicLink(c.req.param('token'))
    setSessionCookie(c, await createSession(user.id))
    return c.redirect('/', 302)
  } catch (err) {
    if (err instanceof MagicLinkError) return c.redirect('/login?error=link', 302)
    throw err
  }
})

// --- Holding page -----------------------------------------------------------

authRoutes.get('/welcome', requireAuth, (c) => {
  const user = currentUser(c)
  if (user.status === 'active') return c.redirect('/', 302)

  const links = [
    ALPHA_GITHUB_URL && `<li><a href="${esc(ALPHA_GITHUB_URL)}" target="_blank" rel="noopener">GitHub issues</a></li>`,
    ALPHA_SIGNAL_URL && `<li><a href="${esc(ALPHA_SIGNAL_URL)}" target="_blank" rel="noopener">Signal</a></li>`,
    ALPHA_DISCORD_URL &&
      `<li><a href="${esc(ALPHA_DISCORD_URL)}" target="_blank" rel="noopener">Vampires MC Discord</a></li>`,
  ]
    .filter(Boolean)
    .join('')

  // Deliberately identical for 'pending' and 'blocked'. Telling someone which
  // one they are turns this page into an oracle, and there is nothing they could
  // do with the answer anyway.
  return c.html(
    page({
      title: 'Thanks for signing up',
      user,
      variant: 'splash',
      splash: false,
      body: `${SPLASH_MEDIA}
       <main class="splash">
       <img class="splash-logo" src="/img/logo-tankbag-vert-dark.svg" alt="TankBag" width="864" height="618">
       <p class="eyebrow">You're on the list</p>
       <h1>Hang tight.</h1>
       <p class="splash-copy">TankBag is in a closed alpha, so accounts are approved by hand. Yours is waiting — you'll be able to sign in and start planning once it's through.</p>
       <ul class="welcome-links">${links}</ul>
       <form method="post" action="/logout"><button class="linkbtn" type="submit">Sign out</button></form>
       </main>`,
    }),
  )
})

// --- Sign out ---------------------------------------------------------------

authRoutes.post('/logout', async (c) => {
  const origin = c.req.header('Origin')
  if (origin && !isAllowedOrigin(origin)) return c.text('Bad origin', 403)

  const sessionId = c.get('sessionId')
  if (sessionId) await invalidateSession(sessionId)
  clearSessionCookie(c)

  // No /cdn-cgi/access/logout any more: there is no edge session to clear, only
  // this app's own cookie.
  return c.redirect('/login', 302)
})
