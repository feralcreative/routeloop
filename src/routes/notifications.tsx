// What an open page should raise, over HTTP.
//
// **ONE ENDPOINT, AND IT IS A POST BECAUSE IT CLAIMS.** Reading this list stamps
// `delivered_at` on every row it returns — that is what stops two tabs raising
// the same notification twice — so it is not a safe method, however much it
// reads like one. A GET would also be prefetchable by a browser or a link
// scanner, which for an endpoint that consumes its own results means a
// notification a rider never saw.
//
// **NO `requireSameOrigin`, DELIBERATELY, AND `requireActiveApi` IS WHY THAT IS
// SAFE.** The CSRF gate exists to stop another site making a state-changing
// request with the rider's cookie; the state this changes is "shown to you", it
// returns nothing an attacker could not already get by being signed in as them,
// and a cross-origin page cannot READ the response anyway. What it would cost is
// real: `fetch` from a page restored out of the back/forward cache does not
// always carry an Origin header, and a poll that 403s intermittently is a
// notification system that silently stops. The other API writes take the gate
// because they change a ride.
//
// The rules and the claim are src/notifications/service.ts; this only decides
// who may ask.
import { Hono } from 'hono'
import { currentUser, requireActive, requireActiveApi, type AuthEnv } from '../auth/middleware'
import { claimPending, markAllRead, recentNotifications } from '../notifications/service'
import { eventDef } from '../notifications/catalog'
import { raw } from 'hono/html'
import { icon } from '../views/icon'
import { fmtDateNumeric, fmtClock } from '../views/date-format'
import { clockFor, dateFormatFor } from '../views/prefs'
import { page } from '../views/layout'

export const notificationRoutes = new Hono<AuthEnv>()

/**
 * The notifications this rider has not been shown yet, claimed in the asking.
 *
 * Capped, because a rider who has been away for a fortnight would otherwise be
 * handed thirty toasts at once — Chrome stacks them and the last few are all
 * anybody reads. The rest are claimed on the next poll, a minute later, which
 * spreads a backlog instead of dumping it.
 *
 * **AN EMPTY ARRAY IS THE OVERWHELMING MAJORITY OF RESPONSES** and must stay
 * cheap: the partial index on `notifications` covers exactly this predicate, so
 * the common answer costs an index probe that finds nothing.
 */
notificationRoutes.post('/api/notifications/pending', requireActiveApi, async (c) => {
  const user = currentUser(c)
  return c.json({ notifications: await claimPending(user.id) })
})

/**
 * The notification centre.
 *
 * **A RECORD, NOT AN INBOX.** There is nothing to reply to, nothing to archive
 * and nothing to file: every row already happened somewhere else in the app, and
 * the only two things a rider does here are read the list and follow one to the
 * thing it is about. So there is no per-row dismiss, no bulk select, and no
 * unread toggle — opening the page IS the read, which is what makes the badge
 * mean "since you last looked" rather than "since you last remembered to tidy".
 *
 * **THE LIST IS READ BEFORE ANYTHING IS MARKED**, or a rider would arrive to a
 * page where nothing is ever new — the stamping would land before the render
 * every single time, and the badge would be counting things they could not then
 * pick out. See markAllRead().
 *
 * Rows are pruned after a fortnight by the poll, so this is recent activity
 * rather than an archive. That is deliberate and it is why `notifications` is
 * excluded from the account export with the reason "transport, not a record" —
 * what a rider owns is the ride, the comment or the report each one points at,
 * and all of those ARE exported.
 */
notificationRoutes.get('/notifications', requireActive, async (c) => {
  const user = currentUser(c)
  const [rows, dateFormat, clock] = await Promise.all([recentNotifications(user.id), dateFormatFor(c), clockFor(c)])
  // AFTER the read. See the note above.
  await markAllRead(user.id)

  const when = (d: Date) => `${fmtDateNumeric(d, dateFormat)} ${fmtClock(d, dateFormat, clock)}`

  const body = (
    <>
      <h1>Notifications</h1>
      <p class="lede">
        What has happened on your rides and around your account. Everything here is kept for a fortnight — the ride, the
        comment or the report each one points at is kept as long as you&nbsp;are.
      </p>

      {rows.length === 0 ? (
        <p class="empty-note">
          Nothing yet. When somebody comments on a ride you own, puts you on one, or answers a report you filed, it
          shows up&nbsp;here.
        </p>
      ) : (
        <ul class="notif-feed">
          {rows.map((n) => {
            const def = eventDef(n.event)
            // `is-new` is what the rider came to see, and it is computed from
            // the values read BEFORE markAllRead ran — by the time this renders
            // the rows are stamped, which is why the flag cannot be re-derived.
            const row = (
              <>
                {/* THE MARK IS INLINE SVG, NOT AN <img>. These are two-tone —
                    a disc in `currentColor` with the glyph knocked out in white
                    — so an external image has no inherited color to resolve
                    against and paints black, and a CSS mask flattens the
                    knockout into a silhouette. See src/views/icon.ts.

                    `data-tone` is what carries the COLOR and it is not the
                    mark: the storage disc is shared by a quota warning and two
                    destructions, which are advice and a verdict. Keyed as an
                    attribute rather than a class per event so a tone renamed in
                    the catalog matches nothing and loses its color loudly
                    instead of inheriting somebody else's — the same keying the
                    feedback kind cards use. */}
                <span class="notif-mark" data-mark={def ? def.icon : 'info'} data-tone={def ? def.tone : 'info'}>
                  {raw(icon(def ? def.icon : 'info'))}
                </span>
                <span class="notif-feed-title">{n.title}</span>
                <span class="notif-feed-body">{n.body}</span>
                <span class="notif-feed-meta">
                  {def ? def.label : n.event} · {when(n.createdAt)}
                </span>
              </>
            )
            return (
              <li class={`notif-feed-item${n.readAt === null ? ' is-new' : ''}`}>
                {/* A LINK ONLY WHERE THERE IS SOMEWHERE TO GO. `url` is null for
                    anything whose subject has no page of its own, and a link to
                    nothing is worse than plain text. */}
                {n.url ? <a href={n.url}>{row}</a> : <div class="notif-feed-plain">{row}</div>}
              </li>
            )
          })}
        </ul>
      )}
    </>
  ).toString()

  return c.html(page({ title: 'Notifications', user, navKey: 'notifications', body, feedbackArea: 'account' }))
})
