// Where to send the browser after it comes back from signing in.
//
// A REDIRECT HINT, NOT A CREDENTIAL, and the distinction is the whole reason
// this is three lines rather than a token store. Holding this cookie grants
// nothing: the most a stale or stolen one can do is land someone on an invite
// page, where accepting is a deliberate POST they still have to make. See
// routes/invites.tsx for why redemption must never be a side effect.
//
// It exists because the invite has to survive a round trip the app does not
// control — out to Google and back, or out to a mail client and back — and a
// cookie is the only carrier that spans both. The OAuth `state` param would
// solve Google alone, and its whole job is CSRF equality-comparison; putting
// structure in it means parsing attacker-supplied structure out of the one field
// the handshake's integrity rests on.
//
// Lives here rather than in the route so auth.tsx can read it without one route
// module importing another.
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { SECURE_COOKIES } from '../auth/session'

export const INVITE_COOKIE = 'tankbag_invite'

// 60 minutes, not the 10 the OAuth handshake uses. The magic-link path is
// request, go to your mail app, come back — and the link itself is good for 15
// of those minutes, so anything tighter expires the hint while the rider is
// doing exactly what the page told them to.
const TTL_S = 60 * 60

// SameSite=Lax is load-bearing on both paths: the browser has to send this on
// the top-level navigation back from Google, and on a click out of a mail
// client. Strict would silently break both — the same failure auth/google.ts
// documents for the session cookie.
export function setInviteCookie(c: Context, token: string): void {
  setCookie(c, INVITE_COOKIE, token, {
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: 'Lax',
    path: '/',
    maxAge: TTL_S,
  })
}

export const readInviteCookie = (c: Context): string => getCookie(c, INVITE_COOKIE) ?? ''

export const clearInviteCookie = (c: Context): void => {
  deleteCookie(c, INVITE_COOKIE, { path: '/', secure: SECURE_COOKIES })
}
