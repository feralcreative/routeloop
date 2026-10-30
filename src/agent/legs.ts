// Draws the real road for every leg an edit left straight.
//
// Through the exported fetchRouteLeg(), which shares the leg cache with the builder
// and the meeting-point proposer: an agent asking for the leg a rider just drew
// costs nothing. A failure leaves the straight placeholder in place, which is the
// builder's own behavior, and the builder re-routes it on the rider's next edit.
import type { RidePayload } from '../maps/ride-graph'
import { cachedRouteLeg, fetchRouteLeg } from '../routes/routing'
import type { Stale } from './ride-edit'
import type { Budget } from './budget'

export async function routeStale(
  ride: RidePayload,
  stale: Stale[],
  budget: Budget,
): Promise<{ routed: number; skipped: number }> {
  let routed = 0
  let skipped = 0
  // Concurrently, because a turn that inserts a stop into five routes is five
  // independent requests and the rider is watching a spinner.
  await Promise.all(
    stale.map(async ({ route: r, leg: i }) => {
      const route = ride.routes[r]
      const a = route?.points[i]
      const b = route?.points[i + 1]
      const leg = route?.legs[i]
      if (!a || !b || !leg) return
      // CACHED LEGS FIRST AND FOR FREE. Claiming before knowing would let three
      // cached legs near the day's limit be skipped for a budget none of them needed,
      // since every claim here is made before any request returns.
      const hit = cachedRouteLeg([a.lng, a.lat], [b.lng, b.lat], leg.viaPoints, route.routePrefs)
      if (hit) {
        route.legs[i] = { ...hit, viaPoints: leg.viaPoints }
        routed++
        return
      }
      if (!budget.take('leg')) {
        skipped++
        return
      }
      const out = await fetchRouteLeg([a.lng, a.lat], [b.lng, b.lat], leg.viaPoints, route.routePrefs)
      // Only a request that reached Google is spent: a cache hit, or a server with no
      // key, was never billed.
      if ((out.ok && out.cached) || (!out.ok && out.error === 'unconfigured')) budget.refund('leg')
      if (!out.ok) return
      // The edit may have moved on while the request was in flight only if a
      // second tool call raced this one, which the loop never does; the identity
      // check is cheap insurance against routing the wrong pair.
      if (route.points[i] !== a || route.points[i + 1] !== b) return
      route.legs[i] = { ...out.leg, viaPoints: leg.viaPoints }
      routed++
    }),
  )
  return { routed, skipped }
}
