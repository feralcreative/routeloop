// The rules for a rider's saved-place library: what a valid place is, what a
// group may be called, how many of each a rider may keep, and what a place turns
// into when it is dropped into a ride.
//
// Pure — no database, no environment. Split rule-from-query the way
// `src/invites/policy.ts` vs `service.ts` and `src/feedback/policy.ts` vs
// `service.ts` already are, so `test/places.test.ts` can pin every rule with no
// Postgres. `src/places/service.ts` is the half that talks to the database.
import { z } from 'zod'
import { fields } from '../maps/fields'
import { MAX_ROLES_PER_POINT, ROLES } from '../maps/roles'

// Generous rather than tight. These are a backstop against a runaway client or a
// hostile payload, not a product limit anyone should meet: a rider with 200
// saved places is using the feature exactly as intended, and one with 300 has a
// script.
export const MAX_PLACES = 500
export const MAX_GROUPS = 50
export const MAX_LINKS_PER_PLACE = 5

// Same shape a stop's links take, and deliberately the same validation:
// `fields.external_url` is http(s)-only, because these end up as hrefs. See the
// note on links in src/maps/ride-graph.ts.
const linkSchema = z.object({
  label: z.string().max(60).default(''),
  url: fields.external_url.default(''),
})

export const placeInput = z.object({
  name: z.string().trim().min(1, 'A place needs a name').max(255),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  roles: z.array(z.enum(ROLES)).max(MAX_ROLES_PER_POINT).default([]),
  // The durable half of rich stop details. Confirmation numbers and check-in
  // times are absent on purpose — those belong to one trip, not to the place.
  phone: z.string().max(40).default(''),
  address: z.string().max(300).default(''),
  links: z.array(linkSchema).max(MAX_LINKS_PER_PLACE).default([]),
  // null means ungrouped, which is a real state rather than a missing value —
  // see the column comment in src/db/schema.ts for why a group is not required.
  groupId: z.number().int().positive().nullable().default(null),
})

export type PlaceInput = z.infer<typeof placeInput>

export const groupInput = z.object({
  name: z.string().trim().min(1, 'A group needs a name').max(80),
})

export type GroupInput = z.infer<typeof groupInput>

/**
 * What a saved place becomes when a rider drops it into a ride.
 *
 * A COPY, with no link back — see the table comment in src/db/schema.ts. This
 * function is the whole of that decision in code: it reads a place and returns
 * a plain stop, and nothing it returns can be traced back to the row it came
 * from.
 *
 * `details` carries only what is durable. A place's phone number is a fact about
 * the place; a confirmation number is a fact about one trip, so the returned
 * stop has an empty one for the rider to fill in.
 *
 * Returns `details: null` when the place has nothing durable to give, so a bare
 * pin does not create an empty `point_details` row for every ride it lands in.
 */
export function placeToStop(place: {
  name: string
  lat: number
  lng: number
  roles: string[]
  phone: string | null
  address: string | null
  links: Array<{ label: string; url: string }>
}) {
  const hasDurable = Boolean(place.phone || place.address || place.links.length)
  return {
    name: place.name,
    lat: place.lat,
    lng: place.lng,
    roles: place.roles,
    description: '',
    durationMin: null,
    details: hasDurable
      ? {
          confirmation: '',
          checkInAt: null,
          checkOutAt: null,
          phone: place.phone ?? '',
          address: place.address ?? '',
          links: place.links,
          notes: '',
        }
      : null,
  }
}

/**
 * Groups in display order, each with its places, plus the ungrouped ones last.
 *
 * Ungrouped go LAST rather than first: a rider who has organized their library
 * should see the organization before the leftovers, and "everything I have not
 * filed yet" is a footer rather than a headline. It is only rendered at all when
 * it has something in it.
 *
 * Pure so the ordering is testable — the query returns two flat lists and this
 * decides what the page looks like.
 */
export function groupPlaces<
  P extends { groupId: number | null; name: string },
  G extends { id: number; name: string; position: number },
>(groups: G[], places: P[]): Array<{ group: G | null; places: P[] }> {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  const ordered = [...groups].sort((a, b) => a.position - b.position || byName(a, b))

  const out: Array<{ group: G | null; places: P[] }> = ordered.map((group) => ({
    group,
    places: places.filter((p) => p.groupId === group.id).sort(byName),
  }))

  // A place whose group was deleted has `group_id = null` (the FK is `set null`,
  // not cascade), so it lands here rather than disappearing. That is the whole
  // point of not cascading.
  const loose = places.filter((p) => p.groupId == null).sort(byName)
  if (loose.length) out.push({ group: null, places: loose })
  return out
}

/** Whether a rider may add another. Separated so the message and the check cannot disagree. */
export function canAddPlace(count: number): boolean {
  return count < MAX_PLACES
}

export function canAddGroup(count: number): boolean {
  return count < MAX_GROUPS
}
