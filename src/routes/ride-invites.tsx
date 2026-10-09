// A personal ride link (#428): what somebody an organizer invited by email sees.
//
// THREE CHOICES, AND THE FIRST NEEDS NO ACCOUNT. Look at the ride and take its
// files; join Routeloop and land on it, in the group and on the routes the
// organizer planned them on; or say no. Joining is optional, and the page says so
// before it asks for anything.
//
// THE GET NEVER CHANGES ANYTHING — the rule routes/invites.tsx is built around,
// for its reason: a link in an email is fetched by mail scanners and link
// previews before a person ever sees it. Viewing is a GET because it grants only
// what holding the link already grants; joining and declining are POSTs behind
// an origin check.
import { Hono, type Context } from 'hono'
import { isAllowedOrigin, MAGIC_LINK_ENABLED } from '../config'
import { GOOGLE_ENABLED } from '../auth/google'
import { currentUser, requireAuth, type AuthEnv } from '../auth/middleware'
import { allow, clientIp } from '../auth/ratelimit'
import { sendTemplateDetached } from '../auth/mailer'
import { approvedEmail } from '../emails/index'
import { page } from '../views/layout'
import { SplashPage } from '../views/splash'
import { normalizeInviteToken } from '../invites/policy'
import { declineRideInvite, findRideInvite, joinRideInvite, RideInviteError } from '../ride-invites/service'
import { addViewToken, clearJoinCookie, readJoinCookie, setJoinCookie } from '../ride-invites/cookie'
import { rideInvitePath } from '../ride-invites/policy'
import { notifyInviteDeclined, notifyRideAdded } from '../notifications/senders'

export const rideInviteRoutes = new Hono<AuthEnv>()

const DEAD: Record<string, string> = {
  invalid: 'That link is not valid. Check you copied all of it, or ask whoever sent it for another.',
  unsent: 'That link is not valid. Check you copied all of it, or ask whoever sent it for another.',
  joined: 'You have already joined this ride with that link. Sign in and it is on your rides list.',
  declined: 'You declined this invitation. If that was a mistake, ask whoever sent it to invite you again.',
  revoked: 'That invitation was withdrawn.',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any route's context
function shell(c: Context<AuthEnv, any>, title: string, body: string) {
  return c.html(
    page({
      title,
      user: c.get('user') ?? null,
      variant: 'splash',
      // The path IS the token, and a page view sends the address to Google.
      analytics: false,
      body,
      head: '<meta name="robots" content="noindex,nofollow">',
    }),
  )
}

rideInviteRoutes.get('/ride-invite/:token', async (c) => {
  const token = normalizeInviteToken(c.req.param('token'))
  const found = token ? await findRideInvite(token) : null
  const user = c.get('user') ?? null

  if (!token || !found || found.liveness !== 'ok') {
    const reason = !found ? 'invalid' : found.liveness
    const body = (
      <SplashPage eyebrow="Invitation" heading="That link is closed.">
        <p class="splash-gate">
          <strong>Sorry:</strong> {DEAD[reason] ?? DEAD.invalid}
        </p>
      </SplashPage>
    ).toString()
    return shell(c, 'Invitation', body)
  }

  // A redirect hint for after sign-in, exactly as /i/:token sets one. Grants nothing.
  setJoinCookie(c, token)
  const path = rideInvitePath(token)
  const greeting = found.placeholderName ? `Hi ${found.placeholderName}: ` : ''

  const body = (
    <SplashPage eyebrow="You’re invited" heading={found.ride.title}>
      <div class="splash-gate">
        <p>
          <strong>{greeting}</strong>
          {found.fromName} is planning this ride and invited you. Have a look at the route and download its files—no
          account needed.
        </p>
      </div>
      <div class="providers">
        <a class="btn" href={`${path}/view`}>
          See the ride
        </a>
      </div>
      <div class="splash-gate">
        <p>
          Want to be on the roster and say whether you’re coming? Join Routeloop and you’ll land on this ride, in the
          group {found.fromName} put you in.
        </p>
      </div>
      {user ? (
        <form class="providers" method="post" action="/ride-invite/join">
          <input type="hidden" name="token" value={token} />
          <button class="btn" type="submit">
            Join this ride
          </button>
        </form>
      ) : (
        <div class="providers">
          {MAGIC_LINK_ENABLED && (
            <form class="magic-form" method="post" action="/auth/magic">
              <label class="visually-hidden" for="ride-invite-email">
                Email address
              </label>
              <input
                id="ride-invite-email"
                name="email"
                type="email"
                required
                autocomplete="email"
                placeholder="you@example.com"
              />
              <button class="btn" type="submit">
                Join with email
              </button>
            </form>
          )}
          {GOOGLE_ENABLED && (
            <a class="provider provider-google" href="/auth/google">
              <img class="provider-mark" src="/img/logos/google.svg" alt="" width="268" height="274" />
              <span>Join with Google</span>
            </a>
          )}
        </div>
      )}
      <form class="providers" method="post" action="/ride-invite/decline">
        <input type="hidden" name="token" value={token} />
        <button class="btn btn-quiet" type="submit">
          I can’t make it
        </button>
      </form>
    </SplashPage>
  ).toString()
  return shell(c, 'You’re invited', body)
})

// SEE THE RIDE. Adds the token to this browser's view cookie and opens the ride,
// which grantsFor() then lets through whatever its visibility. A GET because it
// grants exactly what holding the link already grants, and a scanner that
// follows it gets a cookie it will never send back.
rideInviteRoutes.get('/ride-invite/:token/view', async (c) => {
  const token = normalizeInviteToken(c.req.param('token'))
  const found = token ? await findRideInvite(token) : null
  if (!token || !found || found.liveness !== 'ok') return c.redirect(token ? rideInvitePath(token) : '/', 302)
  addViewToken(c, token)
  return c.redirect(`/m/${found.ride.slug}`, 302)
})

// JOIN. requireAuth, NOT requireActive: a brand-new account is pending, and this
// is the one door that activates it (#428).
rideInviteRoutes.post('/ride-invite/join', requireAuth, async (c) => {
  if (!isAllowedOrigin(c.req.header('Origin'))) return c.text('Bad origin', 403)
  if (!allow('ride-invite-join', clientIp(c.req.raw.headers), { max: 10, windowMs: 60 * 60 * 1000 })) {
    return c.text('Slow down a moment.', 429)
  }
  const user = currentUser(c)
  const body = await c.req.parseBody()
  const token = String(body.token ?? '') || readJoinCookie(c)
  try {
    const res = await joinRideInvite(token, user)
    clearJoinCookie(c)
    if (res.notifyEmail) sendTemplateDetached(res.notifyEmail, approvedEmail, { displayName: res.displayName })
    if (res.by !== null && res.by !== user.id) notifyRideAdded(res.ride.id, user.id, res.by, null)
    // A redirect, so withSession re-reads the row: this request still says pending.
    return c.redirect(`/m/${res.ride.slug}/riders`, 302)
  } catch (err) {
    if (err instanceof RideInviteError) {
      clearJoinCookie(c)
      const t = normalizeInviteToken(token)
      return c.redirect(t ? rideInvitePath(t) : '/', 302)
    }
    throw err
  }
})

// DECLINE. No account needed — the link is the person. Origin-checked like join,
// because a cross-site form that declines somebody's invitation for them is a
// forgery of the one answer the organizer is waiting on.
rideInviteRoutes.post('/ride-invite/decline', async (c) => {
  if (!isAllowedOrigin(c.req.header('Origin'))) return c.text('Bad origin', 403)
  const body = await c.req.parseBody()
  const token = normalizeInviteToken(String(body.token ?? ''))
  if (!token) return c.redirect('/', 302)
  const res = await declineRideInvite(token)
  clearJoinCookie(c)
  if (res) notifyInviteDeclined(res.rideId, res.placeholderId)
  return c.redirect(rideInvitePath(token), 302)
})
