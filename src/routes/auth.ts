// Cloudflare Access owns authentication and the allowlist at the edge. Only
// /auth/cloudflare needs an Access policy; public ride URLs remain public.
import { Hono } from 'hono'
import { currentUser, requireAuth, type AuthEnv } from '../auth/middleware'
import { APP_ORIGIN, accessEmail, isAllowedOrigin, resolveAccessUser } from '../auth/access'
import { clearSessionCookie, createSession, invalidateSession, setSessionCookie } from '../auth/session'
import { ALPHA_DISCORD_URL, ALPHA_GITHUB_URL, ALPHA_SIGNAL_URL } from '../config'
import { esc, page } from '../views/layout'

export const authRoutes = new Hono<AuthEnv>()

authRoutes.get('/login', (c) => {
  if (c.get('user')) return c.redirect('/', 302)

  // The clip is decoration, so the whole layer is hidden from assistive tech.
  // `src` is deliberately absent — site.js assigns it from data-src only when
  // motion is welcome, which keeps the fetch off reduced-motion and no-JS
  // visitors; both keep the poster frame the CSS paints underneath.
  return c.html(
    page({
      title: 'Sign in',
      user: null,
      variant: 'splash',
      body: `<div class="splash-media" aria-hidden="true">
        <video class="splash-video" data-src="/video/routeloop-intro.mp4"
               autoplay loop muted playsinline preload="none"
               disablepictureinpicture disableremoteplayback></video>
       </div>
       <main class="splash">
       <img class="splash-logo" src="/img/logo-routeloop-vert-dark.svg" alt="routeloop" width="368" height="208">
       <p class="eyebrow">Plan the whole ride</p>
       <h1>Every stop. Every day. One map.</h1>
       <p class="splash-copy">Build motorcycle rides and road trips, organize the places that matter, and share the complete plan with the group.</p>
       <div class="providers">
         <a class="provider" href="/auth/cloudflare">Sign in</a>
         <p class="provider-alt">Not a member yet? <a href="/auth/cloudflare">Sign up</a></p>
       </div>
       </main>`,
    }),
  )
})

// Both links above go here. Access owns the Google flow either way, so signing
// up and signing in are the same request — the difference is only that a new
// address arrives without an account, and resolveAccessUser creates one as
// 'pending'. The copy is the whole distinction.
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
      body: `<div class="splash-media" aria-hidden="true">
        <video class="splash-video" data-src="/video/routeloop-intro.mp4"
               autoplay loop muted playsinline preload="none"
               disablepictureinpicture disableremoteplayback></video>
       </div>
       <main class="splash">
       <img class="splash-logo" src="/img/logo-routeloop-vert-dark.svg" alt="routeloop" width="368" height="208">
       <p class="eyebrow">You're on the list</p>
       <h1>Hang tight.</h1>
       <p class="splash-copy">routeloop is in a closed alpha, so accounts are approved by hand. Yours is waiting — you'll be able to sign in and start planning once it's through.</p>
       <ul class="welcome-links">${links}</ul>
       <form method="post" action="/logout"><button class="linkbtn" type="submit">Sign out</button></form>
       </main>`,
    }),
  )
})

// Cloudflare Access must protect this path in stage/prod. The injected email
// is trusted because the origin is reachable only through Cloudflare Tunnel.
authRoutes.get('/auth/cloudflare', async (c) => {
  const email = accessEmail(c)
  if (!email) {
    console.error('[auth] missing Cf-Access-Authenticated-User-Email header')
    return c.text('Cloudflare Access did not provide an authenticated identity.', 403)
  }

  const user = await resolveAccessUser(email)
  setSessionCookie(c, await createSession(user.id))
  return c.redirect('/', 302)
})

authRoutes.post('/logout', async (c) => {
  const origin = c.req.header('Origin')
  if (origin && !isAllowedOrigin(origin)) return c.text('Bad origin', 403)

  const sessionId = c.get('sessionId')
  if (sessionId) await invalidateSession(sessionId)
  clearSessionCookie(c)

  // Cloudflare serves this path at the edge and clears its application cookie.
  // Locally there is no Access cookie, so return directly to the splash page.
  return c.redirect(APP_ORIGIN.startsWith('https://') ? '/cdn-cgi/access/logout' : '/login', 302)
})
