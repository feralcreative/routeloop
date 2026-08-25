// CRUD for a rider's saved-place library.
//
// A JSON API rather than server-rendered forms, because both consumers are
// already JavaScript: the profile page manages the library, and the builder
// reads it to offer places when adding a stop. Neither is a document.
//
// **There is no public surface here, and there should never be one.** A place
// library holds a rider's home address and the phone numbers of places they
// stay. Every route is behind `requireActiveApi`, and every query in
// `service.ts` folds the owner id into its WHERE clause — so a missing gate
// returns nothing rather than someone else's library. Both layers, deliberately:
// this is the kind of data where one check is not enough.
import { Hono } from 'hono'
import { currentUser, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { canAddGroup, canAddPlace, groupInput, groupPlaces, MAX_GROUPS, MAX_PLACES, placeInput } from '../places/policy'
import {
  countGroups,
  countPlaces,
  createGroup,
  createPlace,
  deleteGroup,
  deletePlace,
  listPlaces,
  renameGroup,
  updatePlace,
} from '../places/service'

export const placesRoutes = new Hono<AuthEnv>()

// The library, already arranged for rendering: groups in the rider's order, each
// with its places, and the ungrouped ones as a final section. The arrangement is
// groupPlaces() in policy.ts, which is where its tests are.
placesRoutes.get('/api/places', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const { groups, places } = await listPlaces(user.id)
  return c.json({
    sections: groupPlaces(groups, places).map((s) => ({
      group: s.group ? { id: s.group.id, name: s.group.name } : null,
      places: s.places,
    })),
    // Sent so the client can disable its own "add" affordance rather than
    // discovering the cap by being refused.
    limits: { places: MAX_PLACES, groups: MAX_GROUPS, placeCount: places.length, groupCount: groups.length },
  })
})

placesRoutes.post('/api/places', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const parsed = placeInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid place' }, 400)
  if (!canAddPlace(await countPlaces(user.id))) return c.json({ error: `Place limit reached (${MAX_PLACES})` }, 409)
  return c.json(await createPlace(user.id, parsed.data), 201)
})

placesRoutes.put('/api/places/:id', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not found' }, 404)
  const parsed = placeInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid place' }, 400)
  const row = await updatePlace(user.id, id, parsed.data)
  // Undefined covers both "no such place" and "not yours", and answers the same
  // way for each — a 403 would confirm the row exists.
  return row ? c.json(row) : c.json({ error: 'not found' }, 404)
})

placesRoutes.delete('/api/places/:id', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not found' }, 404)
  return (await deletePlace(user.id, id)) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

placesRoutes.post('/api/place-groups', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const parsed = groupInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid group' }, 400)
  if (!canAddGroup(await countGroups(user.id))) return c.json({ error: `Group limit reached (${MAX_GROUPS})` }, 409)
  const row = await createGroup(user.id, parsed.data)
  // onConflictDoNothing returns nothing when the rider already has a group by
  // that name. 409 rather than 400: the request was well-formed and the answer
  // is "you already have one".
  return row ? c.json(row, 201) : c.json({ error: 'You already have a group with that name' }, 409)
})

placesRoutes.put('/api/place-groups/:id', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not found' }, 404)
  const parsed = groupInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid group' }, 400)
  const row = await renameGroup(user.id, id, parsed.data)
  return row ? c.json(row) : c.json({ error: 'not found' }, 404)
})

// Deleting a group keeps its places and makes them ungrouped — see the note on
// deleteGroup in service.ts. The client says so before it asks.
placesRoutes.delete('/api/place-groups/:id', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not found' }, 404)
  return (await deleteGroup(user.id, id)) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})
