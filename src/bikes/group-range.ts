// The bikes on a ride, and whose tank is the smallest.
//
// #52's whole subject: "#11 covers range for a bike and #12 covers who is on a
// ride. Neither implies the intersection, which is where the actual problem
// lives — a group is limited by its smallest tank, and the rider with a
// 120-mile range is the one who ends up pushing."
//
// ITS OWN FILE RATHER THAN MORE OF ./service.ts, because it answers a question
// about a RIDE and everything in there answers one about a rider's paddock.
// The rule it applies — `bindingRange()` — is already pure and tested in
// ./policy.ts; this only assembles the set to run it over, which is the part
// that needs a database.
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index'
import { bikes, rideMembers, users, type BikeRow } from '../db/schema'
import { bikeLabel, bindingRange, metersToMiles } from './policy'
import { isComing } from '../members/policy'

export type RidingBike = {
  riderId: number
  riderName: string
  /** Null when this rider has no bike on file at all. They are still on the
   *  roster and still coming; the group simply learns nothing from them. */
  bike: BikeRow | null
}

/**
 * Every bike coming on this ride, one per rider.
 *
 * FALLS BACK TO THE RIDER'S DEFAULT when they have not said which they are
 * bringing, which is almost everybody: `ride_members.bike_id` is something a
 * rider opts into on the roster page and most never will. Without the fallback
 * this feature would do nothing until every rider had answered a question
 * nobody asked them, which is the same as not shipping it.
 *
 * DECLINED RIDERS ARE EXCLUDED, via isComing. A rider who has said they cannot
 * make it setting the group's fuel stops is the single most annoying way this
 * could be wrong. A `maybe` COUNTS, for the mirror-image reason: planning for
 * one fewer bike because somebody was honest is the wrong way round.
 */
export async function bikesOnRide(rideId: number): Promise<RidingBike[]> {
  const rows = await db
    .select({
      riderId: rideMembers.riderId,
      riderName: users.displayName,
      rsvp: rideMembers.rsvp,
      role: rideMembers.role,
      chosen: rideMembers.bikeId,
    })
    .from(rideMembers)
    .innerJoin(users, eq(users.id, rideMembers.riderId))
    .where(eq(rideMembers.rideId, rideId))
    .orderBy(users.displayName)

  const coming = rows.filter((r) => isComing({ riderId: r.riderId, role: r.role, rsvp: r.rsvp }))
  const out: RidingBike[] = []
  for (const r of coming) {
    const [bike] = await db
      .select()
      .from(bikes)
      // OWNER-SCOPED EVEN WHEN AN ID WAS CHOSEN, so a stale or forged
      // ride_members.bike_id cannot pull somebody else's bike into the answer —
      // or, worse, leak its nickname onto a page.
      .where(
        r.chosen
          ? and(eq(bikes.id, r.chosen), eq(bikes.ownerId, r.riderId))
          : and(eq(bikes.ownerId, r.riderId), eq(bikes.isDefault, true)),
      )
      .limit(1)
    out.push({ riderId: r.riderId, riderName: r.riderName, bike: bike ?? null })
  }
  return out
}

export type GroupRange = {
  /** Usable range in miles, or null when nothing on the ride has one on file. */
  miles: number | null
  /** Whose tank it is. #52: "surface whose range is binding, since that is the
   *  thing worth knowing before you leave." */
  riderName: string | null
  bikeLabel: string | null
  /** How many riders coming have no range on file. The honesty half: a binding
   *  range computed over two of five bikes is a different claim from one over
   *  all five, and the page has to be able to say which. */
  unknown: number
  /** Riders coming, counted. */
  riders: number
}

/**
 * The range the group is actually limited by.
 *
 * NULL RATHER THAN A GUESS when nothing is known. A fuel plan built on an
 * invented range is worse than no fuel plan because it looks like one — the
 * same argument `null` twistiness makes in AGENTS.md: null means nothing
 * measured it, and a format that guesses is indistinguishable from one that
 * knows.
 */
export async function groupRange(rideId: number): Promise<GroupRange> {
  const riding = await bikesOnRide(rideId)
  const withRange = riding.filter((r) => r.bike?.usableRangeM != null)
  const worst = bindingRange(withRange.map((r) => r.bike!))
  const owner = worst ? (withRange.find((r) => r.bike!.id === worst.id) ?? null) : null
  return {
    // FLOORED, NEVER ROUNDED. A range rounded up is a rider running out of fuel
    // on the strength of a number this app gave them — the same reason
    // MAX_RANGE_MILES floors in policy.ts.
    miles: worst?.usableRangeM == null ? null : Math.floor(metersToMiles(worst.usableRangeM)),
    riderName: owner?.riderName ?? null,
    bikeLabel: worst ? bikeLabel(worst) : null,
    unknown: riding.length - withRange.length,
    riders: riding.length,
  }
}

/** Owner-scoped: a rider says which of THEIR bikes they are bringing, and
 *  `null` hands the choice back to their default. */
export async function setBikeOnRide(rideId: number, riderId: number, bikeId: number | null): Promise<boolean> {
  if (bikeId !== null) {
    const [ok] = await db
      .select({ id: bikes.id })
      .from(bikes)
      .where(and(eq(bikes.id, bikeId), eq(bikes.ownerId, riderId)))
      .limit(1)
    if (!ok) return false
  }
  const done = await db
    .update(rideMembers)
    .set({ bikeId, updatedAt: new Date() })
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.riderId, riderId)))
    .returning({ id: rideMembers.id })
  return done.length > 0
}
