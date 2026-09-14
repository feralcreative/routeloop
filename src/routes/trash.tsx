// The recycle bin — where a rider's deleted things wait out their thirty days.
//
// SERVER-RENDERED FORMS, NOT THE JSON API, and that is a choice about this page
// rather than a rule about the app. The bin has exactly two verbs, both of which
// are a button press with no state to keep in sync, and a redirect back to the
// list is the whole interaction. A fetch layer here would be a client module,
// an error surface and a re-render, all to avoid a page load nobody notices.
// The JSON routes in maps.ts and places.ts stay where they are for the callers
// that genuinely are JavaScript.
//
// THE BIN HAS NO PAGE OF ITS OWN SINCE #343. Ziad's call, 2026-09-13: binned
// things sit beside the list they left — the rides on the dashboard's last
// Rides tab, the places and groups under the list on /places — so `/trash`
// redirects to the dashboard's bin tab (the purge-warning email links to it)
// and the two fragments below are what those pages render. The verbs stay
// here, and each carries its caller back to where it pressed the button.
//
// There is deliberately NO "empty the bin" and no per-item "delete forever".
// Leaving something here costs nothing — the quota is already freed and the
// files are already small — so the only thing such a button buys is a
// confirmation dialog that destroys data for good. The purge is the only thing
// that destroys, and it does it on a schedule nobody has to press.
import { Hono } from 'hono'
import { currentUser, requireActive, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { RESTORE_REFUSAL_MESSAGES } from '../trash/policy'
import { restoreGroup, restorePlace, restoreRide, trashRide } from '../trash/service'
import type { RestoreResult } from '../trash/service'
import { PLACES_BIN, RIDES_BIN } from '../views/bin'

export const trashRoutes = new Hono<AuthEnv>()

// The old page's address. The purge-warning email and any bookmark land here;
// the error query rides along so a refusal is still shown.
trashRoutes.get('/trash', requireActive, (c) => {
  const error = c.req.query('error')
  return c.redirect(error ? `${RIDES_BIN}&error=${encodeURIComponent(error)}` : RIDES_BIN, 302)
})

/** Turns an id path param into a number, or null. Same shape as every other
 *  route that takes one — a non-numeric id is a 404, not a 400. */
const idOf = (raw: string): number | null => {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

// The refusal is carried back in the query string rather than a flash cookie:
// there is no session store for one-shot messages, and the bin is a page a
// rider lands on directly anyway. `encodeURIComponent` because the messages are
// prose with apostrophes in them.
// WHERE A VERB RETURNS TO IS WHAT THE FORM SAYS, WITHIN LIMITS. The rides bin
// is on the dashboard and the places bin on /places, so one fixed address is
// the wrong one for half the callers. The form's `back` is honored only as a
// path — one leading slash, no scheme, no host — so a forged value cannot send
// a rider off-site; anything else falls back to the rides bin. The error rides
// on the query, joined with `&` when the path already carries one.
const backOf = (raw: unknown, fallback = RIDES_BIN): string =>
  typeof raw === 'string' && /^\/(?!\/)/.test(raw) ? raw : fallback
const withError = (path: string, message?: string): string =>
  message ? `${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(message)}` : path

/**
 * A refusal as prose.
 *
 * `not-found` is handled HERE rather than in RESTORE_REFUSAL_MESSAGES because it
 * is not a refusal — it is the same answer a stranger's id gets, and the message
 * has to read that way rather than explaining anything. Everything else comes
 * from policy.ts so the page and the JSON API cannot describe the same refusal
 * two different ways.
 */
function refusalText(result: Extract<RestoreResult, { ok: false }>, noun: string): string {
  if (result.reason === 'not-found') return `That ${noun} is not in the bin.`
  return RESTORE_REFUSAL_MESSAGES[result.reason]
}

/**
 * Puts a ride in the bin from the dashboard.
 *
 * NO CONFIRMATION DIALOG, on purpose. "Are you sure?" earns its place when the
 * answer to "no" is unrecoverable — here the bin IS the confirmation, and it
 * holds the ride for thirty days with a button to undo. Asking twice for a
 * reversible action trains riders to click through the one that matters.
 *
 * Answers with a redirect rather than JSON because the caller is a form. The
 * JSON route in maps.ts does the same work for callers that are JavaScript.
 */
trashRoutes.post('/trash/rides/:id/bin', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = idOf(c.req.param('id'))
  if (id) await trashRide(user.id, id)
  // Home either way. A missing id means the ride was already gone, which is the
  // state the rider was asking for.
  return c.redirect('/', 302)
})

trashRoutes.post('/trash/rides/:id/restore', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const back = backOf((await c.req.parseBody()).back, RIDES_BIN)
  const id = idOf(c.req.param('id'))
  if (!id) return c.redirect(withError(back, 'That ride is not in the bin.'), 302)

  const result = await restoreRide(user.id, id)
  return c.redirect(result.ok ? back : withError(back, refusalText(result, 'ride')), 302)
})

trashRoutes.post('/trash/places/:id/restore', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const back = backOf((await c.req.parseBody()).back, PLACES_BIN)
  const id = idOf(c.req.param('id'))
  if (!id) return c.redirect(withError(back, 'That place is not in the bin.'), 302)
  const ok = await restorePlace(user.id, id)
  return c.redirect(ok ? back : withError(back, 'That place is not in the bin.'), 302)
})

trashRoutes.post('/trash/place-groups/:id/restore', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const back = backOf((await c.req.parseBody()).back, PLACES_BIN)
  const id = idOf(c.req.param('id'))
  if (!id) return c.redirect(withError(back, 'That group is not in the bin.'), 302)

  const result = await restoreGroup(user.id, id)
  return c.redirect(result.ok ? back : withError(back, refusalText(result, 'group')), 302)
})
