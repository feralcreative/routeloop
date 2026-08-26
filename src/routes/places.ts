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
  listPlaces,
  renameGroup,
  updatePlace,
} from '../places/service'
import { RESTORE_REFUSAL_MESSAGES } from '../trash/policy'
import { restoreGroup, restorePlace, trashGroup, trashPlace } from '../trash/service'

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

// Deleting a place MOVES IT TO THE RECYCLE BIN, same as a ride. The verb and
// the path are unchanged so every existing caller gets the reversible behavior.
placesRoutes.delete('/api/places/:id', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not found' }, 404)
  const trashed = await trashPlace(user.id, id)
  return trashed
    ? c.json({ ok: true, purgeAfter: trashed.purgeAfter.toISOString() })
    : c.json({ error: 'not found' }, 404)
})

// A place costs no quota, so the only way this fails is that it is not there.
placesRoutes.post('/api/places/:id/restore', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not found' }, 404)
  return (await restorePlace(user.id, id)) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
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

// Binning a group keeps its places and makes them ungrouped — see the note on
// trashGroup in trash/service.ts. The client says so before it asks. Restoring
// therefore brings back an EMPTY group, which the client should say too.
placesRoutes.delete('/api/place-groups/:id', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not found' }, 404)
  const trashed = await trashGroup(user.id, id)
  return trashed
    ? c.json({ ok: true, purgeAfter: trashed.purgeAfter.toISOString() })
    : c.json({ error: 'not found' }, 404)
})

// Refuses with 409 when the rider has since made another group by that name —
// the partial unique index frees a binned group's name on the spot, which is the
// behavior they want and the reason this collision exists at all.
placesRoutes.post('/api/place-groups/:id/restore', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not found' }, 404)
  const result = await restoreGroup(user.id, id)
  if (result.ok) return c.json({ ok: true })
  if (result.reason === 'not-found') return c.json({ error: 'not found' }, 404)
  return c.json({ error: RESTORE_REFUSAL_MESSAGES[result.reason] ?? 'cannot restore' }, 409)
})
