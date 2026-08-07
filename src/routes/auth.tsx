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
  DEV_LOGIN_EMAIL,
  DEV_LOGIN_ENABLED,
  MAGIC_LINK_ENABLED,
  isAllowedOrigin,
} from '../config'
import { page } from '../views/layout'
import { db } from '../db/index'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { checkAvailability, claimUsername, usernameSchema } from '../auth/username'
import { allow, clientIp } from '../auth/ratelimit'
import { z } from 'zod'
import { sanitizeText } from '../maps/kml'

export const authRoutes = new Hono<AuthEnv>()

// The three splash pages (sign in, choose a name, holding) share this chrome.
// It was three copies of the same markup before; the only thing that differed
// was the eyebrow, the heading and what sits under them.
function SplashMedia() {
  return (
    <div class="splash-media" aria-hidden="true">
      <video
        class="splash-video"
        data-src="/video/tankbag-intro.mp4"
        autoplay
        loop
        muted
        playsinline
        preload="none"
        disablepictureinpicture
        disableremoteplayback
      ></video>
    </div>
  )
}

function SplashPage({ eyebrow, heading, children }: { eyebrow: string; heading: string; children?: unknown }) {
  return (
    <>
      <SplashMedia />
      <main class="splash">
        <img class="splash-logo" src="/img/logo-tankbag-horiz-dark.svg" alt="TankBag" width="1456" height="426" />
        <p class="eyebrow">{eyebrow}</p>
        <h1>{heading}</h1>
        {children}
      </main>
    </>
  )
}

// --- Sign in, and the beta waiting list -------------------------------------

// Joining the list and signing in are the same request, and the copy is the
// only thing that distinguishes them. An address either already has an account
// or gets one created as 'pending' — and 'pending' *is* the waiting list, read
// by /admin, so there is no second store to reconcile against users.
//
// The page has to be honest with a visitor about something the mechanism cannot
// express on its own: **nobody can sign themselves in**. Alpha is developers
// only; beta is invite-only and approved by hand. Before this the page said
// "Not a member yet? Signing in creates your account", which is true in the
// narrow technical sense and reads as an open door — so riders signed in,
// expected the app, and hit /welcome instead. The gate belongs on the way in,
// not after it.
//
// Sign-in is deliberately not removed or hidden behind a second page. Approved
// riders and the owner arrive here too, every one of them through the same two
// controls, and a page that only offered a waiting list would lock out everyone
// who already has an account.
authRoutes.get('/login', (c) => {
  if (c.get('user')) return c.redirect('/', 302)

  const notice = c.req.query('sent') === '1'
  const failed = c.req.query('error')
  const canJoin = MAGIC_LINK_ENABLED || GOOGLE_ENABLED

  return c.html(
    page({
      title: 'Join the beta list',
      user: null,
      variant: 'splash',
      body: (
        <SplashPage eyebrow="Plan the whole ride" heading="Every day. Every detail.">
          <p class="splash-copy">
            Build motorcycle rides and road trips, organize the details that matter, and share the complete plan with
            the whole group.
          </p>
          {/*
            Two blocks, not three. The splash is pinned to one viewport and
            never scrolls — _splash.scss budgets the stack at ~665px and steps
            it down through two height tiers — so every line here is paid for
            out of that budget.
          */}

          <div class="splash-gate">
            <p class="splash-gate-lead">Please note:</p>
            <p>
              TankBag is in <strong>closed alpha</strong>—developers only. <strong>Beta testing is next</strong> and
              it's invite-only, approved by hand a few riders at a time. Getting on the list is what you can do today.{' '}
              <a href="/faq#invites">Why it works this way</a>.
            </p>
          </div>
          {notice && (
            <p class="notice">Check your email — your link is on the way. It works once, within 15 minutes.</p>
          )}
          {failed && (
            <p class="notice is-error">
              {failed === 'link'
                ? 'That link is invalid, already used, or expired. Request a new one.'
                : 'Something went wrong. Please try again.'}
            </p>
          )}
          <div class="providers">
            {/*
              Offered only when a sender exists — a form that always fails is
              worse than no form. Same reasoning as turnstile.ts's feature flag.
            */}
            {MAGIC_LINK_ENABLED && (
              <form class="magic-form" method="post" action="/auth/magic">
                <label class="visually-hidden" for="magic-email">
                  Email address
                </label>
                <input
                  id="magic-email"
                  name="email"
                  type="email"
                  required
                  autocomplete="email"
                  placeholder="you@example.com"
                />
                <button class="btn" type="submit">
                  Join the list
                </button>
              </form>
            )}
            {/*
              The mark is decorative — the button's own text carries the meaning
              — so it takes an empty alt rather than repeating "Google" to a
              screen reader. Its intrinsic size is the file's true viewBox, not a
              square: the artwork is 268x274, and claiming otherwise is what
              makes a squashed logo.
            */}
            {GOOGLE_ENABLED && (
              <a class="provider provider-google" href="/auth/google">
                <img class="provider-mark" src="/img/logos/google.svg" alt="" width="268" height="274" />
                <span>Join with Google</span>
              </a>
            )}
            {/*
              Both flags off means there is no way in and no way onto the list.
              Saying so beats rendering an empty box under a heading that just
              invited someone to join something.
            */}
            {!canJoin && <p class="note">The list is closed on this deployment — no sign-in method is configured.</p>}
            {canJoin && (
              <p class="provider-alt">
                <strong>Already approved?</strong> Same control — it signs you in.
              </p>
            )}
          </div>
        </SplashPage>
      ).toString(),
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
  function Field({
    name,
    label,
    hint,
    max,
  }: {
    name: 'username' | 'displayName'
    label: string
    hint: string
    max: number
  }) {
    return (
      <label class="name-field">
        <span class="name-label">{label}</span>
        <input
          name={name}
          type="text"
          maxlength={max}
          autocomplete="off"
          required
          value={values[name]}
          aria-invalid={errors[name] ? 'true' : undefined}
        />
        <span class="name-hint">{errors[name] || hint}</span>
      </label>
    )
  }

  return page({
    title: 'Choose your name',
    user: null, // the nav would otherwise show the placeholder name this page replaces
    variant: 'splash',
    splash: false,
    body: (
      <SplashPage eyebrow="One more thing" heading="What should we call you?">
        <p class="splash-copy">
          Pick a handle and the name you want other riders to see. Both are yours to change later.
        </p>
        <form class="name-form" method="post" action="/choose-name">
          <Field
            name="username"
            label="Username"
            hint="Letters, numbers and underscores. This is your handle."
            max={30}
          />
          <Field name="displayName" label="Display name" hint="Shown to other riders. Spaces are fine." max={255} />
          <button class="btn" type="submit">
            Continue
          </button>
        </form>
      </SplashPage>
    ).toString(),
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
    return c.html(
      chooseNameHtml(user, { username: '', displayName: '' }, { username: 'too many tries—wait a few minutes' }),
    )
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
    { url: ALPHA_GITHUB_URL, label: 'GitHub issues' },
    { url: ALPHA_SIGNAL_URL, label: 'Signal' },
    { url: ALPHA_DISCORD_URL, label: 'Vampires MC Discord' },
  ].filter((l) => l.url)

  // Deliberately identical for 'pending' and 'blocked'. Telling someone which
  // one they are turns this page into an oracle, and there is nothing they could
  // do with the answer anyway.
  return c.html(
    page({
      title: 'Thanks for signing up',
      user,
      variant: 'splash',
      splash: false,
      body: (
        <SplashPage eyebrow="You're on the list" heading="Hang tight.">
          <p class="splash-copy">
            You're in the queue for <strong>beta testing</strong>. TankBag is in closed alpha right now — developers
            only — and riders are waved in by hand, a few at a time. You'll be able to sign in and start planning once
            yours comes up.
          </p>
          <ul class="welcome-links">
            {links.map((l) => (
              <li>
                <a href={l.url} target="_blank" rel="noopener">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          <form method="post" action="/logout">
            <button class="linkbtn" type="submit">
              Sign out
            </button>
          </form>
        </SplashPage>
      ).toString(),
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

// --- Dev sign-in ------------------------------------------------------------
//
// GET /dev/login signs in as the account named by DEV_LOGIN_EMAIL, no password
// and no mail round-trip. It exists because checking /builder, /welcome or a
// profile page otherwise means minting a session token from a script and pasting
// a cookie by hand, several times an hour.
//
// Three of the four gates are environmental and are checked once, at import, by
// DEV_LOGIN_ENABLED. They decide whether this route is *registered at all* —
// absent from the routing table beats present-and-refusing, because a route that
// refuses still tells a prober it is there. The fourth gate is per-request and
// lives in the handler.
//
// It mints a session through the same createSession/setSessionCookie pair the
// Google and magic-link callbacks use. A parallel path would be free to drift
// from the real one and then this would be testing something nobody ships.
if (DEV_LOGIN_ENABLED) {
  console.warn(`[auth] DEV SIGN-IN IS ON: GET /dev/login signs in as ${DEV_LOGIN_EMAIL}`)

  authRoutes.get('/dev/login', async (c) => {
    // Gate four: the request has to come from this machine. Host carries the
    // name the browser asked for, and it is attacker-controlled — but the three
    // gates above have already established this is a dev box against a local
    // database, so all this has to stop is a request that arrived over the LAN
    // by IP or hostname.
    const host = (c.req.header('Host') ?? '').split(':')[0].toLowerCase()
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return c.notFound()

    const [user] = await db.select().from(users).where(eq(users.email, DEV_LOGIN_EMAIL)).limit(1)

    // Deliberately does not create the account. A backdoor that mints users is a
    // second, quieter signup path, and the seeders already make accounts.
    if (!user) {
      console.warn(`[auth] dev sign-in: no account for ${DEV_LOGIN_EMAIL}`)
      return c.text(`No account for ${DEV_LOGIN_EMAIL}. Create it first, or seed the database.`, 404)
    }

    setSessionCookie(c, await createSession(user.id))
    console.warn(`[auth] DEV SIGN-IN as ${user.email} (#${user.id}, ${user.status})`)
    return c.redirect('/', 302)
  })
}
