// PROPOSING A MEETING POINT: given a trunk route and a subgroup's origin, find
// somewhere sensible for them to join.
//
// @epim's idea, in #143 and now #67, and the thing that turns subgroups from
// bookkeeping into planning: the earlier scope only routed TO a meeting point
// the planner had already picked.
//
// PURE GEOMETRY, AND IT CALLS NO ROUTER. That is a cost decision and a design
// one. Ranking a few dozen candidates through the Routes API would be a Routes
// bill per keystroke on a proxied, cached, per-request SKU — and the proposal is
// a SUGGESTION the planner accepts or ignores, at which point the ordinary
// routing path draws the real road and every number here is replaced by a
// measured one. Straight-line distance is the right precision for "is this a
// sane place to meet"; it is the wrong precision for "how long will it take",
// and this module never claims the second.
//
// Everything here is therefore testable with no database, no network and no
// fixtures beyond a handful of coordinates.

import { haversineM, METERS_PER_MILE, type Track } from '../maps/kml'
import { bearing, turn } from '../maps/twist'

/** A candidate the planner could be offered. */
export type Rendezvous = {
  /** `[lng, lat]`, like every coordinate in this app. */
  at: [number, number]
  /** Metres along the trunk from its start. What makes one candidate earlier
   *  than another, and what the caller needs to cut the trunk at. */
  alongM: number
  /** Extra metres the joining group rides versus going direct to the trunk's
   *  end. The primary ranking term, and the one a planner is shown. */
  divertM: number
  /** Degrees between the joining group's final bearing and the trunk's own at
   *  that point. Zero is arriving parallel; ninety is arriving perpendicular. */
  approachDeg: number
  /** True when the candidate is an existing stop carrying the `gas` role. */
  isFuel: boolean
  /** How much of the trunk is left to ride together after the meet, 0 to 1.
   *  The point of meeting at all. */
  sharedFraction: number
  /** Lower is better. Not shown to a rider — it is a ranking key, and putting a
   *  unitless number in front of somebody invites them to compare two of them. */
  score: number
}

export type RendezvousOptions = {
  /**
   * How far out of their way the joining group may be sent, in miles. A
   * candidate costing more is not offered at all rather than offered and
   * ranked last: #67's constraint is that neither group *significantly*
   * diverts, and a proposal that fails it is not a proposal.
   */
  maxDivertMi?: number
  /**
   * The angle past which the joining group is arriving backwards. Beyond this
   * they would ride past the meeting point and turn around, which is the
   * backtrack #67 rules out.
   */
  maxApproachDeg?: number
  /**
   * How much of the trunk must be left AFTER the meet, as a fraction.
   *
   * WITHOUT THIS THE PROPOSER CHEATS, and it took a failing test to notice. A
   * group a long way off the trunk gets its smallest divert by meeting near the
   * trunk's END — going direct to the destination and going to a point just
   * short of it are nearly the same ride — so pure divert-minimising proposes a
   * rendezvous in the last few miles, where the two groups ride together for
   * twenty minutes and the whole exercise was pointless.
   *
   * #67 asks for the opposite: the joining group should share some road with
   * the trunk BEFORE the destination. This is the floor that says so, and the
   * ranking below prefers more than the floor.
   */
  minSharedFraction?: number
  /** How finely to sample the trunk. 2 km is well under any sane meeting-point
   *  precision and keeps a 500 km trunk to 250 candidates. */
  sampleM?: number
}

const DEFAULTS = { maxDivertMi: 25, maxApproachDeg: 110, minSharedFraction: 0.2, sampleM: 2000 }

/** An existing stop, offered as a candidate in its own right. */
export type FuelCandidate = {
  at: [number, number]
  roles: string[]
}

/**
 * Cumulative distance along a track, one entry per vertex.
 *
 * Shared by both halves below rather than recomputed, because a trunk is
 * routinely tens of thousands of vertices and this is the only O(n) pass either
 * of them needs.
 */
function prefix(track: Track): number[] {
  const out = [0]
  for (let i = 1; i < track.length; i++) {
    out.push(out[i - 1] + haversineM(track[i - 1][1], track[i - 1][0], track[i][1], track[i][0]))
  }
  return out
}

/**
 * Score one candidate on the trunk.
 *
 * `null` means "not offerable" — a backtrack or too big a divert — which the
 * caller drops rather than ranks.
 *
 * THE DIVERT IS MEASURED AGAINST GOING DIRECT TO THE TRUNK'S END, not against
 * zero. A group joining a route is going to that route's destination either
 * way; what the meeting point costs them is the difference between (ride to the
 * meet, then follow the trunk) and (ride straight to where everyone is going).
 * Measuring against zero would rank the trunk's own start best every time, which
 * is not a meeting point, it is the whole ride.
 */
function scoreCandidate(
  at: [number, number],
  alongM: number,
  trunk: Track,
  trunkPrefix: number[],
  vertexIndex: number,
  origin: [number, number],
  isFuel: boolean,
  opts: Required<RendezvousOptions>,
): Rendezvous | null {
  const trunkEnd = trunk[trunk.length - 1]
  const totalM = trunkPrefix[trunkPrefix.length - 1]

  const toMeetM = haversineM(origin[1], origin[0], at[1], at[0])
  const remainingM = totalM - alongM
  const directM = haversineM(origin[1], origin[0], trunkEnd[1], trunkEnd[0])
  const divertM = toMeetM + remainingM - directM

  if (divertM > opts.maxDivertMi * METERS_PER_MILE) return null

  // TOO LITTLE ROAD LEFT TO RIDE TOGETHER. See minSharedFraction: minimising
  // divert alone proposes a meet in the last few miles for any origin far
  // enough off the trunk, which is a rendezvous that achieves nothing.
  const sharedFraction = remainingM / totalM
  if (sharedFraction < opts.minSharedFraction) return null

  // The trunk's own direction at this point, taken from the segment AFTER the
  // vertex where there is one — the group is about to ride that segment, and
  // the one behind them is not what they are joining.
  const next = trunk[Math.min(vertexIndex + 1, trunk.length - 1)]
  const prev = trunk[Math.max(vertexIndex - 1, 0)]
  const trunkBearing = bearing(prev, next)
  const approachDeg = Math.abs(turn(bearing(origin, at), trunkBearing))

  // BACKTRACK. Arriving at more than a right angle and a bit means the group
  // came at the trunk from in front of it: they would ride past the meeting
  // point and turn around, or sit waiting facing the wrong way.
  if (approachDeg > opts.maxApproachDeg) return null

  // Divert dominates, because miles are what a rider actually pays. Everything
  // else is a nudge measured in miles-equivalent so the weights are readable
  // rather than tuned:
  //
  //   approach angle   up to 1 mile at ninety degrees. Enough to prefer a
  //                    parallel join over a perpendicular one between two
  //                    otherwise similar candidates, not enough to send anybody
  //                    the long way round for a nicer angle.
  //   shared road      up to 5 miles, beyond the floor already enforced above.
  //                    Pulls a proposal back from the destination toward
  //                    somewhere the two groups actually ride together.
  //   fuel             2 miles. `gas` costs nothing to prefer — a fuel stop is
  //                    where a group wants to regather anyway — and #67 is
  //                    explicit that it is a thumb on the scale, not a rule.
  const score = divertM / METERS_PER_MILE + (approachDeg / 90) * 1 - sharedFraction * 5 - (isFuel ? 2 : 0)

  return { at, alongM, divertM, approachDeg, isFuel, sharedFraction, score }
}

/**
 * Propose meeting points along a trunk for one joining group.
 *
 * Returns the best few, ordered, or an empty list when nothing clears the
 * constraints — which is a real answer and has to be rendered as one. Two
 * origins on opposite sides of a trunk running away from both of them have no
 * sensible rendezvous, and offering the least bad one would be worse than
 * saying so.
 *
 * The trunk's own endpoints are excluded as candidates. Its start is not a
 * meeting point, it is the whole ride; its end is not one either, it is
 * everybody arriving separately.
 */
export function proposeRendezvous(
  trunk: Track,
  origin: [number, number],
  fuelStops: FuelCandidate[] = [],
  options: RendezvousOptions = {},
  limit = 3,
): Rendezvous[] {
  const opts = { ...DEFAULTS, ...options }
  if (trunk.length < 3) return []

  const pre = prefix(trunk)
  const totalM = pre[pre.length - 1]
  if (totalM <= 0) return []

  const found: Rendezvous[] = []

  // Sampled vertices. Walking the vertex list rather than interpolating along
  // the line keeps every candidate a real point ON the route, which is what the
  // caller has to cut the trunk at.
  let nextAt = opts.sampleM
  for (let i = 1; i < trunk.length - 1; i++) {
    if (pre[i] < nextAt) continue
    nextAt = pre[i] + opts.sampleM
    const c = scoreCandidate(trunk[i], pre[i], trunk, pre, i, origin, false, opts)
    if (c) found.push(c)
  }

  // Existing fuel stops, offered whether or not the sampler happened to land on
  // them. Snapped to their nearest trunk vertex so `alongM` is comparable and
  // so a stop a hundred metres off the line is still a point on the route.
  for (const stop of fuelStops) {
    if (!stop.roles.includes('gas')) continue
    let best = -1
    let bestD = Infinity
    for (let i = 1; i < trunk.length - 1; i++) {
      const d = haversineM(stop.at[1], stop.at[0], trunk[i][1], trunk[i][0])
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (best < 0) continue
    const c = scoreCandidate(trunk[best], pre[best], trunk, pre, best, origin, true, opts)
    if (c) found.push(c)
  }

  found.sort((a, b) => a.score - b.score)

  // NEAR-DUPLICATES DROPPED, because a 2 km sampler on a 400 km trunk offers
  // five candidates within a mile of each other and a planner reads that as the
  // app having nothing to say. One per ten kilometres of trunk.
  const kept: Rendezvous[] = []
  for (const c of found) {
    if (kept.some((k) => Math.abs(k.alongM - c.alongM) < 10_000)) continue
    kept.push(c)
    if (kept.length === limit) break
  }
  return kept
}

/** The divert in miles, rounded the way every other distance in the app is —
 *  for the one place this number is shown to a rider. */
export const divertMi = (r: Rendezvous): number => Math.round((r.divertM / METERS_PER_MILE) * 10) / 10
