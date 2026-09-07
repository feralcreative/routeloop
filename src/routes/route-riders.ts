// Who is on which stretch of road, over HTTP.
//
// The rules are `src/route-riders/policy.ts` and the queries `src/riders/service.ts`;
// this file only decides who may ask and who may answer.
//
// TWO ROUTES AND NOT ONE PER RIDER. Membership is a per-ROUTE fact — "these
// people are on this stretch" — so the unit of a write is a route's whole set,
// which is also what makes an empty list mean "go back to inheriting" rather
// than "this route has nobody on it". A per-rider toggle would need a third
// state to say that and there is nowhere to put it.
//
// SCOPED UNDER /api/rides/:id/route-riders RATHER THAN /api/rides/:id/routes/…
// deliberately: `GET /api/rides/:id` already swallows any `/api/rides/<word>`
// added later, and a nested `:uid` under a segment that reads like a collection
// is one reorder away from the same trap. See the filename.ts gotcha.
import { Hono } from 'hono'
import { currentUser, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { ownRide } from './maps'
import { roster } from '../members/service'
import { subgroupsOf } from '../subgroups/service'
import { resolvedRoutes, setRouteRiders } from '../route-riders/service'
import { groupsOnRoute, riderJunctions } from '../route-riders/policy'

export const routeRiderRoutes = new Hono<AuthEnv>()

/**
 * The one shape both the read and the write answer with.
 *
 * **THE WRITE HAS TO RETURN WHAT THE READ DOES, AND RETURNING LESS WAS A REAL
 * BUG.** The PUT answered with bare `routes`, so the derived `groups` were
 * absent from its response — and the panel, which renders its checkboxes from
 * that field, drew every route as "Nobody yet" the moment a planner ticked
 * anything. One builder means the two cannot drift again.
 *
 * **HOME GROUPS ARE WHAT THE TICKS ARE DERIVED FROM.** Once a group merges, its
 * riders' stored group on that route is null, so ticking from stored values
 * would tick nothing. `groupsOnRoute()` reads which group each rider BELONGS to
 * instead, which is what lets a shared route say "VMCSF, VMCSC" while a third
 * group is still on its approach rather than claiming everybody.
 */
async function payloadFor(rideId: number) {
  const [routes, members, groups] = await Promise.all([resolvedRoutes(rideId), roster(rideId), subgroupsOf(rideId)])
  const home = new Map(members.map((m) => [m.riderId, m.subgroupId]))
  return {
    routes: routes.map((r) => ({ ...r, groups: groupsOnRoute(r, home) })),
    junctions: riderJunctions(routes),
    riders: members.map((m) => ({ riderId: m.riderId, displayName: m.displayName, group: m.subgroupId })),
    groups: groups.map((g) => ({ id: g.id, uid: g.uid, name: g.name, color: g.color })),
  }
}

/**
 * Every route with the riders on it, the junctions that fall out, and the roster
 * to render a picker from.
 *
 * THE JUNCTIONS RIDE ALONG rather than being a second request. They are derived
 * from the same resolution in the same tick, so computing them here costs
 * nothing and guarantees the panel cannot show a set and a junction that
 * disagree — which is the whole reason they are derived and never stored.
 */
routeRiderRoutes.get('/api/rides/:id/route-riders', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)

  return c.json(await payloadFor(ride.id))
})

/**
 * Say exactly who is on one route.
 *
 * AN EMPTY LIST CLEARS THE OVERRIDE. A route ridden by nobody is not a thing
 * anyone means, so "nobody" is how a planner says "inherit from the route before
 * this one" — the only way to undo an answer, and what makes the absence of rows
 * unambiguous everywhere else.
 *
 * `ownRide` IS THE GATE AND IT IS DELIBERATELY NOT `canDecide`. Saying who rides
 * a stretch is planning, which is what an edit-level member is trusted with —
 * the same trust that lets them move a stop. It is not the roster: nobody is
 * added to or removed from the RIDE here, and a rider who is not a member is
 * filtered out by the service rather than refused, because the honest answer to
 * "put a stranger on route 3" is that they are not on the ride at all.
 */
routeRiderRoutes.put('/api/rides/:id/route-riders/:uid', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)

  // `riders` is [{id, group}]; `group` null means riding as the MAIN group,
  // which is what everybody on a shared stretch is. A bare id list is still
  // accepted and read as "all riding as the main group", because that is what a
  // rider picker with no group control was saying.
  const body = (await c.req.json().catch(() => null)) as { riders?: unknown; riderIds?: unknown } | null
  const raw = Array.isArray(body?.riders) ? body.riders : body?.riderIds
  if (!Array.isArray(raw)) return c.json({ error: 'bad request' }, 400)
  const riders: Array<{ id: number; group: number | null }> = []
  for (const item of raw) {
    const id = typeof item === 'number' ? item : Number((item as { id?: unknown })?.id)
    if (!Number.isInteger(id)) return c.json({ error: 'bad request' }, 400)
    const g = typeof item === 'number' ? null : (item as { group?: unknown })?.group
    const group = g == null ? null : Number(g)
    if (group !== null && !Number.isInteger(group)) return c.json({ error: 'bad request' }, 400)
    riders.push({ id, group })
  }

  await setRouteRiders(ride.id, c.req.param('uid'), riders)
  // The RESOLVED state back, not an ok. One route's override changes every
  // route after it that inherits, so a client patching its own copy from the
  // request it just sent would be wrong from the next route on.
  return c.json(await payloadFor(ride.id))
})
