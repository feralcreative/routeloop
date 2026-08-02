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
import { db } from '../db/index'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { checkAvailability, claimUsername, usernameSchema } from '../auth/username'
import { allow, clientIp } from '../auth/ratelimit'
import { z } from 'zod'
import { sanitizeText } from '../maps/kml'

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

  // The mark is decorative — the button's own text carries the meaning — so it
  // takes an empty alt rather than repeating "Google" to a screen reader. Its
  // intrinsic size is the file's true viewBox, not a square: the artwork is
  // 268x274, and claiming otherwise is what makes a squashed logo.
  const googleButton = GOOGLE_ENABLED
    ? `<a class="provider provider-google" href="/auth/google">
         <img class="provider-mark" src="/img/logos/google.svg" alt="" width="268" height="274">
         <span>Sign in with Google</span>
       </a>`
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
       <img class="splash-logo" src="/img/logo-tankbag-horiz-dark.svg" alt="TankBag" width="1456" height="426">
       <p class="eyebrow">Plan the whole ride</p>
       <h1>Every stop. Every day. One map.</h1>
       <p class="splash-copy">Build motorcycle rides and road trips, organize the places that matter, and share the complete plan with the group.</p>
       ${notice ? `<p class="notice">Check your email — if that address has access, a sign-in link is on its way.</p>` : ''}
       ${failed ? `<p class="notice is-error">${esc(failed === 'link' ? 'That link is invalid, already used, or expired. Request a new one.' : 'Sign-in failed. Please try again.')}</p>` : ''}
       <div class="providers">
         ${magicForm}
         ${googleButton}
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

// --- Choose a name ----------------------------------------------------------

// Every rider names themselves; nothing is inherited from the provider they
// signed in with. Both fields start blank on purpose — a prefilled real name is
// the thing this page exists to avoid.
//
// The path has a hyphen, which is why it needs no entry in RESERVED_USERNAMES:
// the username charset is letters, numbers and underscores, so no rider can
// ever claim a name that shadows it.
const nameFields = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1, 'display name is required').max(255),
})

function chooseNameHtml(
  user: { displayName: string },
  values: { username: string; displayName: string },
  errors: Record<string, string>,
): string {
  const field = (name: 'username' | 'displayName', label: string, hint: string, max: number): string => `
       <label class="name-field">
         <span class="name-label">${esc(label)}</span>
         <input name="${name}" type="text" maxlength="${max}" autocomplete="off" required
                value="${esc(values[name])}"${errors[name] ? ' aria-invalid="true"' : ''}>
         <span class="name-hint">${esc(errors[name] || hint)}</span>
       </label>`

  return page({
    title: 'Choose your name',
    user: null, // the nav would otherwise show the placeholder name this page replaces
    variant: 'splash',
    splash: false,
    body: `${SPLASH_MEDIA}
       <main class="splash">
       <img class="splash-logo" src="/img/logo-tankbag-horiz-dark.svg" alt="TankBag" width="1456" height="426">
       <p class="eyebrow">One more thing</p>
       <h1>What should we call you?</h1>
       <p class="splash-copy">Pick a handle and the name you want other riders to see. Both are yours to change later.</p>
       <form class="name-form" method="post" action="/choose-name">
         ${field('username', 'Username', 'Letters, numbers and underscores. This is your handle.', 30)}
         ${field('displayName', 'Display name', 'Shown to other riders. Spaces are fine.', 255)}
         <button class="btn" type="submit">Continue</button>
       </form>
       </main>`,
  })
}

authRoutes.get('/choose-name', requireAuth, (c) => {
  const user = currentUser(c)
  if (user.username) return c.redirect('/', 302)
  return c.html(chooseNameHtml(user, { username: '', displayName: '' }, {}))
})

authRoutes.post('/choose-name', requireAuth, async (c) => {
  const origin = c.req.header('Origin')
  if (origin && !isAllowedOrigin(origin)) return c.text('Bad origin', 403)

  const user = currentUser(c)
  if (user.username) return c.redirect('/', 302)

  // Username availability is an enumeration surface: each submission reveals
  // whether a handle is taken or held. Cheap to walk without this.
  if (!allow('username-check', clientIp(c.req.raw.headers), { max: 30 })) {
    return c.html(chooseNameHtml(user, { username: '', displayName: '' }, { username: 'too many tries—wait a few minutes' }))
  }

  const raw = Object.fromEntries(await c.req.formData()) as Record<string, string>
  const values = { username: String(raw.username ?? ''), displayName: String(raw.displayName ?? '') }
  const parsed = nameFields.safeParse(values)
  if (!parsed.success) {
    const errors: Record<string, string> = {}
    for (const issue of parsed.error.issues) errors[String(issue.path[0])] = issue.message
    return c.html(chooseNameHtml(user, values, errors))
  }

  const free = await checkAvailability(parsed.data.username, user.id)
  if (!free.ok) {
    const message =
      free.reason === 'taken'
        ? 'that username is taken'
        : `that username was recently released and is held until ${free.until.toISOString().slice(0, 10)}`
    return c.html(chooseNameHtml(user, values, { username: message }))
  }

  try {
    await db.transaction(async (tx) => {
      await claimUsername(tx, user, parsed.data.username)
      await tx
        .update(users)
        .set({ displayName: sanitizeText(parsed.data.displayName), updatedAt: new Date() })
        .where(eq(users.id, user.id))
    })
  } catch (err) {
    // uq_username_lower is the real guard: checkAvailability above is advisory
    // and two riders can clear it in the same instant. Only one wins the write.
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('uq_username_lower')) {
      return c.html(chooseNameHtml(user, values, { username: 'that username was just taken' }))
    }
    throw err
  }
  return c.redirect('/', 302)
})

// --- Holding page -----------------------------------------------------------

authRoutes.get('/welcome', requireAuth, (c) => {
  const user = currentUser(c)
  if (!user.username) return c.redirect('/choose-name', 302)
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
       <img class="splash-logo" src="/img/logo-tankbag-horiz-dark.svg" alt="TankBag" width="1456" height="426">
       <p class="eyebrow">You're on the list</p>
       <h1>Hang tight.</h1>
       <p class="splash-copy">TankBag is in a closed alpha, so accounts are approved by hand. Yours is waiting—you'll be able to sign in and start planning once it's through.</p>
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
