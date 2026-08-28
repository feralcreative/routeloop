// Comments on a ride, and on the points in it. #190.
//
// JSON only — the surface is the builder's own panel, which is a client-rendered
// page already. There is no server-rendered comments page and no form fallback,
// which is a deliberate difference from the roster: the roster is a page a rider
// can be sent a link to, and this is a drawer inside an app that does not run
// without JavaScript at all.
//
// EVERY ROUTE HERE IS ROSTER-GATED AND NONE OF THEM CONSULTS VISIBILITY. A share
// link is permission to SEE a route, not to write on it — the same call
// /m/:slug/riders and voting both make. See canPost in ../comments/policy.
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, type RideRow } from '../db/schema'
import { currentUser, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { canViewAsMember } from '../members/policy'
import { canPost } from '../comments/policy'
import { membershipOf } from '../members/service'
import { commentsOn, deleteComment, postComment, resolveComment } from '../comments/service'
import { LIVE_RIDE } from '../trash/service'

export const commentRoutes = new Hono<AuthEnv>()

/** The ride and the viewer's roster row, or undefined. The same resolver shape
 *  the builder uses — a ride first, a roster second — because a comment is not
 *  an owner power and `ownRide()` would answer the wrong question. */
async function commentableRide(
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

/** Reading needs `view`; writing needs `comment`, which postComment checks for
 *  itself. 404 rather than 403 throughout — a 403 confirms a ride exists to
 *  somebody holding a guessed id. */
commentRoutes.get('/api/rides/:id/comments', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const found = await commentableRide(user.id, c.req.param('id'))
  if (!found || !canViewAsMember(found.member)) return c.json({ error: 'not found' }, 404)
  const rows = await commentsOn(found.ride.id)
  return c.json({
    // The viewer's own id, so the client can render Delete on their own
    // comments without a second request or a rule of its own. The SERVER is
    // still the gate — canDelete runs on every delete whatever the page drew.
    viewerId: user.id,
    canPost: canPost(found.member),
    comments: rows.map((r) => ({
      id: r.id,
      authorId: r.authorId,
      authorName: r.authorName,
      authorHandle: r.authorHandle,
      pointUid: r.pointUid,
      pointLabel: r.pointLabel,
      body: r.body,
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
  })
})

commentRoutes.post('/api/rides/:id/comments', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const found = await commentableRide(user.id, c.req.param('id'))
  if (!found || !canViewAsMember(found.member)) return c.json({ error: 'not found' }, 404)

  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  const b = (raw ?? {}) as Record<string, unknown>
  // THE LABEL IS TAKEN FROM WHAT THE CLIENT IS LOOKING AT, on purpose. The
  // point may not be saved yet — the builder mints a uid client-side and the row
  // exists in the panel before it exists in the database — so there is nothing
  // on the server to read the name off. It is a record of what the commenter saw,
  // which is exactly what it is for.
  const pointUid = typeof b.pointUid === 'string' && b.pointUid.length > 0 ? b.pointUid : null
  const pointLabel = pointUid && typeof b.pointLabel === 'string' ? b.pointLabel.slice(0, 200) : null
  const res = await postComment(found.ride.id, user.id, b.body, { pointUid, pointLabel })
  if (!res.ok) return c.json({ error: res.reason }, res.reason === 'refused' ? 403 : 400)
  return c.json({ id: res.id })
})

commentRoutes.post('/api/rides/:id/comments/:cid/resolve', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const found = await commentableRide(user.id, c.req.param('id'))
  if (!found || !canViewAsMember(found.member)) return c.json({ error: 'not found' }, 404)
  const cid = Number(c.req.param('cid'))
  if (!Number.isInteger(cid)) return c.json({ error: 'not found' }, 404)
  let open = false
  try {
    const b = (await c.req.json()) as Record<string, unknown>
    open = b.open === true
  } catch {
    // A resolve with no body means close, which is the common press.
  }
  const ok = await resolveComment(found.ride.id, user.id, cid, open)
  return ok ? c.json({ ok: true }) : c.json({ error: 'refused' }, 403)
})

commentRoutes.post('/api/rides/:id/comments/:cid/delete', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const found = await commentableRide(user.id, c.req.param('id'))
  if (!found || !canViewAsMember(found.member)) return c.json({ error: 'not found' }, 404)
  const cid = Number(c.req.param('cid'))
  if (!Number.isInteger(cid)) return c.json({ error: 'not found' }, 404)
  const ok = await deleteComment(found.ride.id, user.id, cid)
  return ok ? c.json({ ok: true }) : c.json({ error: 'refused' }, 403)
})
