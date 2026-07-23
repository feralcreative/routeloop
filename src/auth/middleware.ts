// Session resolution for every request, plus the gates for owner-only pages
// and the owner API.
import type { Context, MiddlewareHandler } from 'hono'
import type { UserRow } from '../db/schema'
import { APP_ORIGIN } from './oauth'
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

export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.get('user')) return c.redirect('/login', 302)
  await next()
}

// API flavor: a fetch() caller wants a 401, not a redirect to an HTML page.
export const requireAuthApi: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'authentication required' }, 401)
  await next()
}

// CSRF gate for state-changing API calls. Stricter than the /logout check: the
// Origin header must be present AND match — same-origin fetch always sends it,
// so only cross-site (or non-browser) requests are turned away.
export const requireSameOrigin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (c.req.header('Origin') !== APP_ORIGIN) return c.json({ error: 'bad origin' }, 403)
  await next()
}

// Non-null accessor for routes already behind requireAuth.
export function currentUser(c: Context<AuthEnv>): UserRow {
  const u = c.get('user')
  if (!u) throw new Error('currentUser() called outside requireAuth')
  return u
}
