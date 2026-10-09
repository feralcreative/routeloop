// The two cookies a personal ride link (#428) sets.
//
// THE VIEW COOKIE IS A CREDENTIAL, UNLIKE THE BETA INVITE'S. It carries the
// tokens of the links this browser has opened, and grantsFor() turns a live one
// into permission to see and download that ride — which is the point: joining is
// optional, and somebody who only wants the GPX should not have to make an
// account to get it. What bounds it is the link's own liveness: declining,
// joining or the organizer removing them kills it server-side, whatever the
// browser still holds.
//
// THE JOIN COOKIE IS A REDIRECT HINT, exactly like routeloop_invite: it only
// decides where afterSignIn() sends the browser back to, and joining is still a
// POST the person has to make.
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { tryGetContext } from 'hono/context-storage'
import { SECURE_COOKIES } from '../auth/session'
import { parseViewTokens, serializeViewTokens, withViewToken } from './policy'

export const RIDE_VIEW_COOKIE = 'routeloop_ride_view'
export const RIDE_JOIN_COOKIE = 'routeloop_ride_join'

// A quarter. A ride is planned months out, and an invitee who opens the link the
// week it is sent and comes back for the GPX the morning of should still get it.
const VIEW_TTL_S = 90 * 24 * 60 * 60
// The beta invite's hour, for the beta invite's reason: sign-in round trips.
const JOIN_TTL_S = 60 * 60

// Lax on both: each is read on a top-level navigation that arrives from a mail
// client or back from Google, and Strict would drop it on exactly those.
export function addViewToken(c: Context, token: string): void {
  const next = withViewToken(parseViewTokens(getCookie(c, RIDE_VIEW_COOKIE) ?? ''), token)
  setCookie(c, RIDE_VIEW_COOKIE, serializeViewTokens(next), {
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: 'Lax',
    path: '/',
    maxAge: VIEW_TTL_S,
  })
}

/**
 * The tokens this browser holds, read off the request in flight.
 *
 * THROUGH tryGetContext(), AND THAT IS THE SECOND READER OF IT. The first is
 * viewerCountry() in src/views/analytics.ts, whose comment asks for a recorded
 * call before a second: this is that call. The view grant is decided inside
 * viewableRide(), which a dozen routes call with a slug and a viewer and no
 * context — threading the cookie through every one of them is the alternative,
 * and it is a dozen chances to forget it on exactly the export a person came for.
 * Outside a request (a test, a script) there is no cookie and no grant.
 */
export function viewTokensInFlight(): string[] {
  const c = tryGetContext()
  if (!c) return []
  return parseViewTokens(getCookie(c, RIDE_VIEW_COOKIE) ?? '')
}

export function setJoinCookie(c: Context, token: string): void {
  setCookie(c, RIDE_JOIN_COOKIE, token, {
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: 'Lax',
    path: '/',
    maxAge: JOIN_TTL_S,
  })
}

export const readJoinCookie = (c: Context): string => getCookie(c, RIDE_JOIN_COOKIE) ?? ''

export const clearJoinCookie = (c: Context): void => {
  deleteCookie(c, RIDE_JOIN_COOKIE, { path: '/', secure: SECURE_COOKIES })
}
