// Session resolution for every request, plus the gates for owner-only pages
// and the owner API.
import type { Context, MiddlewareHandler } from 'hono'
import type { UserRow } from '../db/schema'
import { isAllowedOrigin } from './access'
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

// Session only. Cloudflare Access admits any Google account, so having a session
// no longer means being allowed to use the app — almost every page wants
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
  if (user.status !== 'active') return c.redirect('/welcome', 302)
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
