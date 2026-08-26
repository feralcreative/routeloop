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
// There is deliberately NO "empty the bin" and no per-item "delete forever".
// Leaving something here costs nothing — the quota is already freed and the
// files are already small — so the only thing such a button buys is a
// confirmation dialog that destroys data for good. The purge is the only thing
// that destroys, and it does it on a schedule nobody has to press.
import { Hono } from 'hono'
import { currentUser, requireActive, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { daysUntilPurge, RESTORE_REFUSAL_MESSAGES, TRASH_HOLD_DAYS } from '../trash/policy'
import { listBin, restoreGroup, restorePlace, restoreRide, trashRide } from '../trash/service'
import { page } from '../views/layout'
import { fmtDateFull } from '../views/date-format'
import { dateFormatFor } from '../views/prefs'
import type { DateFormat } from '../views/date-format'
import type { PlaceGroupRow, PlaceRow, RideRow } from '../db/schema'
import type { RestoreResult } from '../trash/service'

export const trashRoutes = new Hono<AuthEnv>()

/** The countdown, phrased for someone deciding whether to act. `daysUntilPurge`
 *  rounds up, so the last partial day still reads as "1 day left". */
function Countdown({ purgeAfter, dateFormat }: { purgeAfter: Date | null; dateFormat: DateFormat }) {
  if (!purgeAfter) return <span class="trash-when">Scheduled</span>
  const days = daysUntilPurge({ deletedAt: null, purgeAfter }, new Date())
  return (
    <span class="trash-when">
      {days === 0 ? 'Goes today' : `${days} ${days === 1 ? 'day' : 'days'} left`} · destroyed{' '}
      {fmtDateFull(purgeAfter, dateFormat)}
    </span>
  )
}

function RestoreForm({ action, label }: { action: string; label: string }) {
  return (
    <form method="post" action={action} class="trash-restore">
      <button class="btn arrow-left" type="submit">
        {label}
      </button>
    </form>
  )
}

trashRoutes.get('/trash', requireActive, async (c) => {
  const user = currentUser(c)
  const [bin, dateFormat] = await Promise.all([listBin(user.id), dateFormatFor(c)])
  const error = c.req.query('error')
  const total = bin.rides.length + bin.places.length + bin.groups.length

  const body = (
    <>
      <h1>Recycle bin</h1>
      <p class="lede">
        Anything you delete waits here for {TRASH_HOLD_DAYS} days, then is destroyed for good. Put something back and
        the {TRASH_HOLD_DAYS} days start again from&nbsp;scratch.
      </p>

      {error && <p class="notice is-error">{error}</p>}

      {total === 0 ? (
        <p class="empty">Nothing in here. Deleting a ride, a saved place or a group puts it in the bin first.</p>
      ) : (
        <>
          {bin.rides.length > 0 && (
            <>
              <h2>Rides</h2>
              {/* Storage is freed the moment a ride is binned, so this is worth
                  saying plainly — a rider looking at the bin while up against
                  their limit should not think these are still costing them. */}
              <p class="sub">
                These no longer count against your storage. Their share links are dead until you put them&nbsp;back.
              </p>
              <ul class="cards trash-list">
                {bin.rides.map((ride: RideRow) => (
                  <li>
                    <div>
                      <strong>{ride.title}</strong>
                      <Countdown purgeAfter={ride.purgeAfter} dateFormat={dateFormat} />
                    </div>
                    <RestoreForm action={`/trash/rides/${ride.id}/restore`} label="Put it back" />
                  </li>
                ))}
              </ul>
            </>
          )}

          {bin.places.length > 0 && (
            <>
              <h2>Saved places</h2>
              <ul class="cards trash-list">
                {bin.places.map((place: PlaceRow) => (
                  <li>
                    <div>
                      <strong>{place.name}</strong>
                      <Countdown purgeAfter={place.purgeAfter} dateFormat={dateFormat} />
                    </div>
                    <RestoreForm action={`/trash/places/${place.id}/restore`} label="Put it back" />
                  </li>
                ))}
              </ul>
            </>
          )}

          {bin.groups.length > 0 && (
            <>
              <h2>Groups</h2>
              {/* Stated up front rather than discovered afterwards: the places
                  were ungrouped the moment the group went, which is what
                  deleting a group has always done. */}
              <p class="sub">
                The places that were in these are still in your library, just&nbsp;ungrouped. Putting a group back gives
                you an empty&nbsp;group.
              </p>
              <ul class="cards trash-list">
                {bin.groups.map((group: PlaceGroupRow) => (
                  <li>
                    <div>
                      <strong>{group.name}</strong>
                      <Countdown purgeAfter={group.purgeAfter} dateFormat={dateFormat} />
                    </div>
                    <RestoreForm action={`/trash/place-groups/${group.id}/restore`} label="Put it back" />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  ).toString()

  return c.html(page({ title: 'Recycle bin', user, navKey: 'trash', body }))
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
const back = (message?: string): string => (message ? `/trash?error=${encodeURIComponent(message)}` : '/trash')

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
  const id = idOf(c.req.param('id'))
  if (!id) return c.redirect(back('That ride is not in the bin.'), 302)

  const result = await restoreRide(user.id, id)
  return c.redirect(result.ok ? back() : back(refusalText(result, 'ride')), 302)
})

trashRoutes.post('/trash/places/:id/restore', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = idOf(c.req.param('id'))
  if (!id) return c.redirect(back('That place is not in the bin.'), 302)
  const ok = await restorePlace(user.id, id)
  return c.redirect(ok ? back() : back('That place is not in the bin.'), 302)
})

trashRoutes.post('/trash/place-groups/:id/restore', requireActive, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = idOf(c.req.param('id'))
  if (!id) return c.redirect(back('That group is not in the bin.'), 302)

  const result = await restoreGroup(user.id, id)
  return c.redirect(result.ok ? back() : back(refusalText(result, 'group')), 302)
})
