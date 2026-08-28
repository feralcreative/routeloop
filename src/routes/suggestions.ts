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
import { rides, type RideRow } from '../db/schema'
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
      dayUid: r.dayUid,
      note: r.note,
      state: r.state,
      createdAt: r.createdAt.toISOString(),
    })),
  })
})

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
  const dayUid = typeof b.dayUid === 'string' ? b.dayUid : ''
  if (!dayUid) return c.json({ error: 'no-such-day' }, 400)
  const note = typeof b.note === 'string' ? b.note : null
  const res = await propose(found.ride.id, user.id, dayUid, b.day, note)
  if (!res.ok) return c.json({ error: res.reason }, res.reason === 'refused' ? 403 : 400)
  return c.json({ id: res.id })
})

/** Accept, discard or withdraw. One route because they are one decision with
 *  three answers, and each verb re-reads the roster and the day's fingerprint
 *  for itself. */
suggestionRoutes.post('/api/rides/:id/suggestions/:sid/:verb', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const found = await suggestableRide(user.id, c.req.param('id'))
  if (!found || !canViewAsMember(found.member)) return c.json({ error: 'not found' }, 404)
  const sid = Number(c.req.param('sid'))
  if (!Number.isInteger(sid)) return c.json({ error: 'not found' }, 404)
  const verb = c.req.param('verb')

  const res =
    verb === 'accept'
      ? await accept(found.ride.id, user.id, sid, found.ride)
      : verb === 'discard'
        ? await discard(found.ride.id, user.id, sid)
        : verb === 'withdraw'
          ? await withdraw(found.ride.id, user.id, sid)
          : ({ ok: false, reason: 'not-found' } as const)

  if (res.ok) return c.json({ ok: true })
  return c.json({ error: res.reason }, res.reason === 'not-found' ? 404 : res.reason === 'stale' ? 409 : 403)
})
