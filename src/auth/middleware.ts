// Session resolution for every request, plus the gate for owner-only pages.
import type { Context, MiddlewareHandler } from 'hono'
import type { UserRow } from '../db/schema'
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

// Non-null accessor for routes already behind requireAuth.
export function currentUser(c: Context<AuthEnv>): UserRow {
  const u = c.get('user')
  if (!u) throw new Error('currentUser() called outside requireAuth')
  return u
}
