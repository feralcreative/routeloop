// The guided tour's two endpoints: start, and done.
//
// THE TOUR BUILDS A REAL RIDE. Ziad's call, 2026-09-11: everything the tour
// shows is real — a real roster, a real bike's range, a real split — because
// every surface it visits reads the tables, and the alternative is a second
// rendering path per surface that has to be kept in step. What makes that
// affordable is that the ride is BINNED at the end: on Finish, on Skip, on the
// next start, and by the hourly sweep if a tab was simply closed.
//
// START IS ALSO WHERE THE GUIDE RIDERS ARE CREATED — lazily, on the first tour
// a deployment sees, never at boot. See src/tour/guides.ts for why.
import { Hono } from 'hono'
import { db } from '../db/index'
import { rideMembers, rides } from '../db/schema'
import { currentUser, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { insertRideGraph, rideTotals } from '../maps/ride-graph'
import { generateSlug } from '../maps/slug'
import { seedOwner } from '../members/service'
import { DEFAULT_PERM } from '../members/policy'
import { seedMainGroup } from '../subgroups/service'
import { trashRide } from '../trash/service'
import { ensureGuideRiders } from '../tour/guides'
import { seedPayload } from '../tour/seed'
import { stampTour, tourRideOf } from '../tour/service'

export const tourRoutes = new Hono<AuthEnv>()

/** Bins the rider's previous tour ride if it is still live. A ride binned by
 *  hand already is a no-op here — trashRide is narrowed by LIVE_RIDE. */
async function binPrevious(userId: number): Promise<void> {
  const prev = await tourRideOf(userId)
  if (prev) await trashRide(userId, prev)
}

/**
 * Start the tour: bin the last tour ride, make a fresh one from keyframe
 * zero, put the three guides on it, and remember it.
 *
 * THE GUIDES ARE INVITED IN THE SAME TRANSACTION AS THE RIDE, through the
 * ordinary `ride_members` insert. `invite()` in members/service.ts already
 * admits a guide without a friendship, so this is not a second write path —
 * it is the same row, written where the ride is created so a tour ride never
 * exists for a moment with an empty roster. Their perm is the invitation
 * default, exactly what the roster page's form would grant.
 */
tourRoutes.post('/api/tour/start', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  let guides
  try {
    guides = await ensureGuideRiders()
  } catch (err) {
    console.error('[tour] could not seed the guide riders', err)
    return c.json({ error: 'the tour’s guide riders could not be created' }, 503)
  }
  await binPrevious(user.id)

  const p = seedPayload()
  const created = await db.transaction(async (tx) => {
    const [ride] = await tx
      .insert(rides)
      .values({
        ownerId: user.id,
        slug: generateSlug(),
        title: p.title,
        description: null,
        visibility: 'private',
        source: 'native',
        ...rideTotals(p),
      })
      .returning()
    await insertRideGraph(tx, ride.id, p)
    await seedOwner(tx, ride.id, user.id)
    await seedMainGroup(tx, ride.id)
    await tx
      .insert(rideMembers)
      .values(
        guides.map((g) => ({ rideId: ride.id, riderId: g.id, role: 'rider' as const, perm: DEFAULT_PERM, invitedBy: user.id })),
      )
      .onConflictDoNothing({ target: [rideMembers.rideId, rideMembers.riderId] })
    return ride
  })
  await stampTour(user.id, c.req.header('Accept-Language'), { tourRideId: created.id })
  console.log(`[tour] user ${user.id} started the tour on ride ${created.id}`)
  return c.json({ id: created.id, slug: created.slug, guides: guides.map((g) => g.username) }, 201)
})

/**
 * The tour has been finished or skipped (#133).
 *
 * ONE ENDPOINT FOR BOTH OUTCOMES, deliberately. `tour_done_at` answers "has
 * this rider been offered the tour", and a rider who pressed Skip at step one
 * has been — offering it again on the next load is what makes a tour hated,
 * and the account menu keeps a way back in. The ride is binned ONLY when it
 * is the one this rider's profile names: a stray id from a stale tab must not
 * bin a ride the rider is keeping. Idempotent — a second call finds no tour
 * ride and stamps the date again, which is the same answer.
 */
tourRoutes.post('/api/tour/done', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const body = (await c.req.json().catch(() => ({}))) as { rideId?: unknown }
  const asked = typeof body.rideId === 'number' && Number.isInteger(body.rideId) ? body.rideId : null
  const held = await tourRideOf(user.id)
  if (held && (asked === null || asked === held)) await trashRide(user.id, held)
  await stampTour(user.id, c.req.header('Accept-Language'), { tourDoneAt: new Date(), tourRideId: null })
  return c.json({ ok: true })
})
