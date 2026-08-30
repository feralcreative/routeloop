// The live channel for a ride: who else is here, what they are working on, and
// when a day changes under you.
//
// SSE RATHER THAN A WEBSOCKET, and src/dev/livereload.ts is the working
// precedent in this repo. Everything here is one-directional — the server tells
// the room what happened — and the one thing a client sends back is a claim,
// which is an ordinary POST. A socket would buy bidirectionality nothing needs,
// and EventSource reconnects on its own where a socket needs that written.
//
// The registry is src/live/hub.ts. Read its header before changing anything
// here: in particular, nothing in this file prevents data loss, and it must
// never be relied on to.
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, users } from '../db/schema'
import { LIVE_RIDE } from '../trash/service'
import { currentUser, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { memberOrOwner } from '../members/service'
import { canViewAsMember } from '../members/policy'
import { isDraining } from '../shutdown'
import * as hub from '../live/hub'

export const liveRoutes = new Hono<AuthEnv>()

/** Long enough not to be chatter, short enough that a proxy does not decide the
 *  connection is idle. Caddy and the Cloudflare tunnel both sit in front of this
 *  and both will close a stream that says nothing. */
const HEARTBEAT_MS = 20_000

/** The same gate the builder GET uses: a rider who may open the ride may see who
 *  else is in it. Membership, not visibility — who is on a ride is a fact about
 *  people, and a share link is permission to see a route. */
async function liveRide(userId: number, idParam: string) {
  const id = Number(idParam)
  if (!Number.isInteger(id) || id <= 0) return undefined
  const [ride] = await db
    .select()
    .from(rides)
    .where(and(eq(rides.id, id), LIVE_RIDE))
    .limit(1)
  if (!ride) return undefined
  const member = await memberOrOwner(ride, userId)
  if (!canViewAsMember(member)) return undefined
  return ride
}

liveRoutes.get('/api/rides/:id/live', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const ride = await liveRide(user.id, c.req.param('id'))
  // 404 rather than 403 throughout, as everywhere else on a ride: a 403
  // confirms a ride exists to somebody holding a guessed id.
  if (!ride) return c.json({ error: 'not found' }, 404)

  // REFUSED WHILE DRAINING, so a deploy does not open a stream it is about to
  // have to wait on. The client's EventSource reconnects on its own and lands on
  // the new color.
  if (isDraining() || hub.isClosed()) return c.json({ error: 'draining' }, 503)

  const [me] = await db.select({ username: users.username }).from(users).where(eq(users.id, user.id)).limit(1)

  return streamSSE(c, async (stream) => {
    let done = false
    const conn: hub.Conn = {
      id: hub.nextConnId(),
      rideId: ride.id,
      riderId: user.id,
      name: me?.username ?? 'A rider',
      dayUid: null,
      // Fire and forget. writeSSE is async and a publish walks the whole room —
      // awaiting each one would make one slow client stall everybody else's
      // notification. A failed write is a socket that is going away anyway, and
      // the abort check below is what actually removes it.
      send: (event, data) => {
        void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {})
      },
      close: () => {
        done = true
      },
    }

    hub.join(conn)

    try {
      // Two abort checks because they fail independently: `stream.aborted` covers
      // a canceled response body, the request signal covers the socket closing
      // under it. Without both, a closed tab leaves this loop spinning for the
      // life of the process. Same reasoning as livereload.ts.
      while (!done && !stream.aborted && !c.req.raw.signal.aborted) {
        await stream.sleep(HEARTBEAT_MS)
        if (done || stream.aborted || c.req.raw.signal.aborted) break
        // A comment frame: it keeps the connection alive through every proxy in
        // the path and is ignored by EventSource, so no client handler runs.
        await stream.writeSSE({ event: 'ping', data: '1' }).catch(() => {})
      }
    } finally {
      // ALWAYS, including on the shutdown path. A connection left in the room is
      // a rider the others go on being shown forever.
      hub.leave(conn)
    }
  })
})

/**
 * What this rider is working on now.
 *
 * A POST because EventSource cannot send anything, and the claim is genuinely a
 * write. It answers whether the claim was granted rather than assuming: the
 * client greys the day either way, so it has to know which side it is on.
 *
 * ADVISORY, NOT A LOCK. A refused claim does not stop the rider editing and does
 * not stop their save landing — it is the day hash that decides that, on the
 * write. This exists so two riders do not pick up the same day by accident, not
 * so one can be locked out by the other.
 */
liveRoutes.post('/api/rides/:id/live/claim', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const ride = await liveRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)

  let body: { dayUid?: unknown } | null = null
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  const dayUid = typeof body?.dayUid === 'string' && body.dayUid.length <= 12 ? body.dayUid : null

  // Every connection this rider has open on this ride, so a claim made in one
  // tab is not immediately contradicted by a heartbeat from another.
  let granted = true
  let found = false
  for (const conn of hub.roomOf(ride.id)) {
    if (conn.riderId !== user.id) continue
    found = true
    if (!hub.setClaim(conn, dayUid)) granted = false
  }

  // No stream open — the rider has JavaScript running but the channel has not
  // connected, or has dropped. Not an error: the save path does not depend on
  // this, so the honest answer is that nothing was claimed.
  if (!found) return c.json({ granted: false, connected: false })
  return c.json({ granted, connected: true, presence: hub.presenceOf(ride.id) })
})
