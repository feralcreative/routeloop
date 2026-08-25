// Session resolution for every request, plus the gates for owner-only pages
// and the owner API.
import type { Context, MiddlewareHandler } from 'hono'
import type { UserRow } from '../db/schema'
import { isAllowedOrigin } from '../config'
import { readSessionCookie, validateSessionToken } from './session'

// Typed access to c.get('user') / c.get('sessionId') across the app.
export type AuthEnv = {
  Variables: {
    user: UserRow | null
    sessionId: string | null
  }
}

// Runs on every request so templates can render the right header without each
// route having to ask.
export const withSession: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const found = await validateSessionToken(readSessionCookie(c))
  c.set('user', found?.user ?? null)
  c.set('sessionId', found?.sessionId ?? null)
  await next()
}

// Session only. Anyone can sign in with Google or a magic link, so having a
// session does not mean being allowed to use the app — almost every page wants
// requireActive below. This gate exists for the two routes a pending rider must
// still reach: /welcome and /logout.
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.get('user')) return c.redirect('/login', 302)
  await next()
}

// Session plus authorization. Pending and blocked both land on /welcome and the
// page says the same thing for either, so signing in never reveals which one you
// are.
export const requireActive: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const user = c.get('user')
  if (!user) return c.redirect('/login', 302)
  // Before status, because an unnamed rider carries a display name derived from
  // their address rather than one they chose. /choose-name and /logout run on
  // requireAuth, so neither can loop back into this.
  if (!user.username) return c.redirect('/choose-name', 302)
  // Before status, and that ordering is the point: a rider who was pending or
  // blocked when they asked to leave still needs the page that offers Save Me,
  // not /welcome, whose whole job is to say they cannot use the app. Their
  // status is untouched and comes back with them. /account/gone runs on
  // requireAuth, so it cannot loop back into this.
  if (user.deletionRequestedAt) return c.redirect('/account/gone', 302)
  if (user.status !== 'active') return c.redirect('/welcome', 302)
  await next()
}

// Rider management. Active plus the capability flag. A page gate, so a signed-in
// rider who lacks the flag is sent to their own rides rather than shown a 403 —
// the surface simply is not theirs, and the account is already known-good
// (active), so this is authorization on top of authentication, not either alone.
//
// The target has moved twice and the destination never has. It was /dashboard,
// then /rides, and it is now / — which since 2026-08-24 is both the dashboard and
// the ride list, so "their own rides" and "the dashboard" finally name the same
// page. Sent straight there rather than through /rides, which would redirect:
// a gate that bounces you twice reads as a fault even when it is not.
export const requireManageRiders: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const user = c.get('user')
  if (!user) return c.redirect('/login', 302)
  if (!user.username) return c.redirect('/choose-name', 302)
  if (user.status !== 'active') return c.redirect('/welcome', 302)
  if (!user.canManageRiders) return c.redirect('/', 302)
  await next()
}

// The Rider Survey, which is invite-only and deliberately NOT beta-gated.
//
// It cannot be requireActive, and that is the whole reason this exists. A
// survey-only invite grants no beta access, so its holder stays `pending` —
// requireActive would send them to /welcome, the one page whose job is to say
// they cannot use the app yet. Being asked for an opinion and being given the
// keys are separate things, and an invite can offer either.
//
// Blocked is still blocked. A blocked rider gains nothing from answering, and
// the surface should behave for them exactly as the rest of the app does.
//
// An address is required because a response not tied to a verified email is not
// a response — that is the entire reason this survey lives in the app instead of
// in a form. users.email is nullable, so this is reachable for a legacy row.
export const requireSurvey: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const user = c.get('user')
  if (!user) return c.redirect('/login', 302)
  if (!user.username) return c.redirect('/choose-name', 302)
  if (user.status === 'blocked') return c.redirect('/welcome', 302)
  if (!user.surveyInvitedAt || !user.email) return c.redirect('/welcome', 302)
  await next()
}

// API flavor: a fetch() caller wants a 401, not a redirect to an HTML page.
export const requireAuthApi: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'authentication required' }, 401)
  await next()
}

// 401 means "who are you", 403 means "I know who you are and the answer is no".
// A pending rider holds a perfectly valid session, so 401 would be wrong and
// would send clients into a pointless re-login loop.
export const requireActiveApi: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'authentication required' }, 401)
  // 403 rather than 401 for the same reason a pending rider gets one: the
  // session is perfectly valid and re-logging in would change nothing.
  if (user.deletionRequestedAt) return c.json({ error: 'account scheduled for deletion' }, 403)
  if (user.status !== 'active') return c.json({ error: 'account not approved' }, 403)
  await next()
}

// CSRF gate for state-changing API calls. Stricter than the /logout check: the
// Origin header must be present AND match — same-origin fetch always sends it,
// so only cross-site (or non-browser) requests are turned away.
export const requireSameOrigin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!isAllowedOrigin(c.req.header('Origin'))) return c.json({ error: 'bad origin' }, 403)
  await next()
}

// Non-null accessor for routes already behind one of the gates above.
export function currentUser(c: Context<AuthEnv>): UserRow {
  const u = c.get('user')
  if (!u) throw new Error('currentUser() called outside an auth gate')
  return u
}
