// Proposing a change to somebody else's ride, and the owner taking it or leaving
// it. #190.
//
// JSON only, like ../comments: the surface is the builder's panel, which does
// not run without JavaScript in the first place.
//
// EVERY ROUTE IS ROSTER-GATED. Reading needs `view`, proposing needs `suggest`,
// deciding needs to be an owner — and each of those is checked in the service
// against a freshly read roster row, not against whatever the page believed when
// it drew the button.
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index'
import { rideSuggestions, rides, type RideRow } from '../db/schema'
import { notifyRideSuggestion, notifySuggestionDecided } from '../notifications/senders'
import { currentUser, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { canViewAsMember } from '../members/policy'
import { membershipOf } from '../members/service'
import { accept, discard, propose, suggestionsOn, withdraw } from '../suggestions/service'
import { LIVE_RIDE } from '../trash/service'

export const suggestionRoutes = new Hono<AuthEnv>()

async function suggestableRide(
  userId: number,
  idParam: string,
): Promise<{ ride: RideRow; member: Awaited<ReturnType<typeof membershipOf>> } | undefined> {
  const id = Number(idParam)
  if (!Number.isInteger(id) || id <= 0) return undefined
  const [ride] = await db
    .select()
    .from(rides)
    .where(and(eq(rides.id, id), LIVE_RIDE))
    .limit(1)
  if (!ride) return undefined
  return { ride, member: await membershipOf(ride.id, userId) }
}

/** EVERY RIDER ON THE ROSTER SEES EVERY PENDING SUGGESTION. Two riders proposing
 *  the same reroute and neither knowing is the failure this avoids; a rejected
 *  proposal being visible to the group is the accepted cost. */
suggestionRoutes.get('/api/rides/:id/suggestions', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const found = await suggestableRide(user.id, c.req.param('id'))
  if (!found || !canViewAsMember(found.member)) return c.json({ error: 'not found' }, 404)
  const rows = await suggestionsOn(found.ride.id)
  return c.json({
    viewerId: user.id,
    isOwner: found.member?.role === 'owner',
    suggestions: rows.map((r) => ({
      id: r.id,
      authorId: r.authorId,
      authorName: r.authorName,
      routeUid: r.routeUid,
      note: r.note,
      state: r.state,
      createdAt: r.createdAt.toISOString(),
    })),
  })
})

/**
 * What to call the route a suggestion is about.
 *
 * **A TITLE WHERE THERE IS ONE AND THE UID OTHERWISE, NEVER A POSITION.** A
 * position reads far better — "Route 3" is a thing a rider can point at — and it
 * cannot be had at either call site: the propose payload carries ONE route
 * rather than the list, so there is nothing to count along, and by the time a
 * verb runs the list may have moved. A uid is opaque and correct; a position
 * would be readable and, some of the time, wrong about which road is meant.
 */
function routeNameOf(raw: unknown, routeUid: string): string {
  const title = (raw as { title?: unknown } | null)?.title
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : `route ${routeUid}`
}

/**
 * Who proposed it and what it is about, read BEFORE the verb runs.
 *
 * The order is load-bearing: `accept` writes the whole ride through
 * insertRideGraph and both verbs stamp the row's outcome, so a read afterwards
 * is a read of a row that has already been decided — and on a ride whose save
 * churned, of a route the label no longer describes. This is the same
 * before-and-after rule the RSVP change carries, arriving from the other side.
 */
async function proposerOf(rideId: number, id: number) {
  const [row] = await db
    .select({ authorId: rideSuggestions.authorId, payload: rideSuggestions.payload, routeUid: rideSuggestions.routeUid })
    .from(rideSuggestions)
    .where(and(eq(rideSuggestions.rideId, rideId), eq(rideSuggestions.id, id)))
    .limit(1)
  return row ? { proposerId: row.authorId, routeLabel: routeNameOf(row.payload, row.routeUid) } : null
}

suggestionRoutes.post('/api/rides/:id/suggestions', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const found = await suggestableRide(user.id, c.req.param('id'))
  if (!found || !canViewAsMember(found.member)) return c.json({ error: 'not found' }, 404)
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  const b = (raw ?? {}) as Record<string, unknown>
  const routeUid = typeof b.routeUid === 'string' ? b.routeUid : ''
  if (!routeUid) return c.json({ error: 'no-such-route' }, 400)
  const note = typeof b.note === 'string' ? b.note : null
  const res = await propose(found.ride.id, user.id, routeUid, b.route, note)
  if (!res.ok) return c.json({ error: res.reason }, res.reason === 'refused' ? 403 : 400)
  // The route is named by its TITLE where it has one and by its uid otherwise.
  // A position would read better and cannot be had here: the payload carries one
  // route, not the list, so there is nothing to count along.
  notifyRideSuggestion(found.ride.id, user.id, routeNameOf(b.route, routeUid), note)
  return c.json({ id: res.id })
})

/** Accept, discard or withdraw. One route because they are one decision with
 *  three answers, and each verb re-reads the roster and the route's fingerprint
 *  for itself. */
suggestionRoutes.post('/api/rides/:id/suggestions/:sid/:verb', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const found = await suggestableRide(user.id, c.req.param('id'))
  if (!found || !canViewAsMember(found.member)) return c.json({ error: 'not found' }, 404)
  const sid = Number(c.req.param('sid'))
  if (!Number.isInteger(sid)) return c.json({ error: 'not found' }, 404)
  const verb = c.req.param('verb')

  // READ FIRST — see proposerOf. Accept rewrites the ride and both verbs stamp
  // the row, so afterwards there is nothing left that describes what was decided.
  const card = verb === 'accept' || verb === 'discard' ? await proposerOf(found.ride.id, sid) : null

  const res =
    verb === 'accept'
      ? await accept(found.ride.id, user.id, sid, found.ride)
      : verb === 'discard'
        ? await discard(found.ride.id, user.id, sid)
        : verb === 'withdraw'
          ? await withdraw(found.ride.id, user.id, sid)
          : ({ ok: false, reason: 'not-found' } as const)

  if (res.ok) {
    // **WITHDRAW SENDS NOTHING**: the proposer withdrew it, so the message would
    // tell them what they had just done, and suggestion-decided has no third
    // value to say it with. Accept and discard only — see senders.ts.
    if (card && card.proposerId !== user.id) {
      notifySuggestionDecided(found.ride.id, card.proposerId, user.id, card.routeLabel, verb === 'accept')
    }
    return c.json({ ok: true })
  }
  return c.json({ error: res.reason }, res.reason === 'not-found' ? 404 : res.reason === 'stale' ? 409 : 403)
})
