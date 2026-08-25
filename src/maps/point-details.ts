// Reading a ride's private stop details.
//
// **This is the only module that reads `point_details`, and that is the whole
// privacy design.** Gate codes, confirmation numbers and phone numbers live in
// their own table precisely so that no ordinary `select()` over `points` can
// carry them to a public viewer by accident. Keeping every read behind these two
// functions means the boundary is greppable: if a surface shows private detail,
// it imports from here, and there is one place to check who it lets in.
//
// The rule, stated once: **details reach the ride's OWNER and nobody else.** Not
// a rider with the share link, not an unlisted viewer, not a clone. When ride
// membership ships (item 13) this is the function that grows an invited-rider
// branch, and it is the only one that should.
import { eq } from 'drizzle-orm'
import { db } from '../db/index'
import { pointDetails } from '../db/schema'
import type { UserRow } from '../db/schema'

/** The shape a client receives. Dates go out as ISO strings, like every other date in the payload. */
export type PointDetailsOut = {
  confirmation: string
  checkInAt: string | null
  checkOutAt: string | null
  phone: string
  address: string
  links: Array<{ label: string; url: string }>
  notes: string
}

/**
 * Every detail row on a ride, keyed by point uid.
 *
 * Deliberately takes the ride's `ownerId` and the viewer rather than being
 * callable with just a ride id. A function that returns private data for any
 * ride you name is one careless call away from a leak; this one cannot be
 * misused without passing a viewer, and passing the wrong viewer is visible at
 * the call site.
 *
 * Returns an empty map — not null, not a throw — for a non-owner. A viewer with
 * no details and a viewer forbidden from seeing them render identically, which
 * is what stops the presence of details being a signal in itself.
 */
export async function detailsForViewer(
  rideId: number,
  ownerId: number,
  viewer: UserRow | null,
): Promise<Map<string, PointDetailsOut>> {
  if (!canSeeDetails(ownerId, viewer)) return new Map()
  return detailsForOwner(rideId)
}

/**
 * Who may see a ride's private stop details. **Owner only.**
 *
 * Split out from the query above so `test/point-details.test.ts` can pin it with
 * no database — the same rule-from-query split the invites, survey, stats and
 * feedback modules use, and it matters more here than in any of them: this
 * predicate is the entire privacy boundary for gate codes and confirmation
 * numbers, and an untested boundary is one someone widens by accident.
 *
 * Deliberately does NOT consult `visibility`. A public ride's details are as
 * private as a private ride's — sharing a route is not sharing a reservation —
 * and taking visibility as an argument would invite exactly that confusion.
 */
export function canSeeDetails(ownerId: number, viewer: { id: number } | null): boolean {
  return viewer != null && viewer.id === ownerId
}

/**
 * Every detail row on a ride, with no permission check.
 *
 * For callers that have ALREADY established ownership — the builder's own load
 * behind `ownRide()`, and the native JSON export, which only ever serializes a
 * ride the requester owns. Anything reached by a share link must use
 * `detailsForViewer` instead.
 */
export async function detailsForOwner(rideId: number): Promise<Map<string, PointDetailsOut>> {
  const rows = await db.select().from(pointDetails).where(eq(pointDetails.rideId, rideId))
  return new Map(
    rows.map((r) => [
      r.uid,
      {
        confirmation: r.confirmation ?? '',
        checkInAt: r.checkInAt?.toISOString() ?? null,
        checkOutAt: r.checkOutAt?.toISOString() ?? null,
        phone: r.phone ?? '',
        address: r.address ?? '',
        links: r.links,
        notes: r.notes ?? '',
      },
    ]),
  )
}

/** True when anything is actually filled in — what the builder uses to badge a stop. */
export function hasDetails(d: PointDetailsOut | null | undefined): boolean {
  if (!d) return false
  return Boolean(d.confirmation || d.checkInAt || d.checkOutAt || d.phone || d.address || d.notes || d.links.length > 0)
}
