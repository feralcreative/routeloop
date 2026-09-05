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
  /**
   * Offer ONLY fuel candidates, never a bare point on the road.
   *
   * THE FILTER HAS TO BE HERE AND NOT AT THE CALL SITE, which is the whole
   * reason this option exists. Scoring everything and keeping the fuel ones
   * afterwards does not work: the ranking prefers the EARLIEST viable point and
   * only the best few survive, so a station a little further along is crowded
   * out by plain vertices before a caller ever sees it — and "no station on this
   * road" would be reported for a road with several.
   */
  fuelOnly?: boolean
}

const DEFAULTS = { maxDivertMi: 25, maxApproachDeg: 110, minSharedFraction: 0.2, sampleM: 2000, fuelOnly: false }

/**
 * A place offered as a candidate in its own right.
 *
 * TWO SOURCES, ONE SHAPE. A stop already on the ride carrying the `gas` role,
 * and a station found by searching the road — see the route. The second is why
 * `name` and `address` are here: a meeting point at a forecourt should be that
 * forecourt, named, not the anonymous stretch of highway beside it.
 */
export type FuelCandidate = {
  at: [number, number]
  roles: string[]
  name?: string
  address?: string
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
 *
 * ALL THREE LEGS OF THAT COMPARISON ARE STRAIGHT LINES, AND MIXING IN THE ROAD
 * DISTANCE IS THE BUG #239 WAS HALF OF. The remainder used to be measured ALONG
 * THE TRUNK while `directM` was a straight line, so every bend in the road after
 * the candidate was charged to the joining group as though they had chosen it:
 * on Los Gatos → Shasta Lake, a trunk of ordinary sinuosity 1.15, that invented
 * 13 miles of divert at Tracy and 9 at Sacramento. Since the budget is 25, it
 * pushed every proposal LATE — the module's own `minSharedFraction` cheat,
 * reintroduced by arithmetic after being closed by a constraint — and on a
 * twistier trunk it rejects the whole route. Straight lines on both sides make
 * the divert a real dogleg cost and, by the triangle inequality, never negative.
 * `sharedFraction` below is the one term that genuinely wants the road distance:
 * it asks how much of the ROUTE is left, not how far away anything is.
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
  const remainingDirectM = haversineM(at[1], at[0], trunkEnd[1], trunkEnd[0])
  const directM = haversineM(origin[1], origin[0], trunkEnd[1], trunkEnd[0])
  const divertM = toMeetM + remainingDirectM - directM

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

// --- Meeting without a spine ------------------------------------------------
//
// EVERYTHING ABOVE ASKS "WHERE DOES THIS GROUP JOIN THAT ROUTE". THIS ASKS THE
// QUESTION A PLANNER ACTUALLY HAS: everyone is going to the same place, they
// are setting off from different ones, where should they meet?
//
// THE MAIN GROUP'S ROUTE IS THE ROUTE, AND EVERY OTHER GROUP JOINS IT. Ziad's
// call, 2026-09-03. The main group is `rides.primary_subgroup_id`, which already
// defaults to the first group created — so there is nothing to nominate and no
// loop to break: a planner does not pick a spine, they just have a main group,
// because the first group they made is the ride.
//
// THE MAIN GROUP CAN NEVER BE THE ONE JOINING, which is what the signature says
// rather than a rule the body checks. It takes the primary and the joiners as
// two arguments for exactly that reason: a single list plus an id is one typo
// away from proposing that the main group ride out of its way to meet a feeder,
// and there is no shape of that answer a planner wants.
//
// The rejected version is recorded because it read well and was worse. It took
// every group symmetrically and tried each one's road as a spine, which is
// fairer in the abstract and wrong in practice: the answer moved depending on
// which groups existed, a feeder's road could win, and the main group would be
// told to divert onto it.

/** One group's planned run to the shared destination. */
export type GroupRoute = {
  /** The subgroup's uid — what the client and the route both address it by. */
  id: string
  /** Where this group sets off. */
  origin: [number, number]
  /** Their routed track, origin to the destination everybody shares. */
  track: Track
}

/** What one group pays for a proposed meeting point. */
export type GroupDivert = {
  id: string
  divertM: number
  /** Degrees between their approach and the spine's direction there. */
  approachDeg: number
  /** True when their own route already passes through this point, which is what
   *  makes a natural convergence cost nothing. */
  onRoute: boolean
}

export type GroupMeet = {
  /** Where to meet. THE STATION'S OWN POSITION when this is a fuel candidate,
   *  not the road vertex it snapped to — a rider told to meet at a Shell should
   *  be sent to the forecourt, and the point added to every group's day is this
   *  coordinate. `alongM` still comes from the snapped vertex, because ranking
   *  is about distance along the road. */
  at: [number, number]
  /** Metres along the MAIN group's track, so the caller can cut it here. There
   *  is no "which group's track" field: it is always the main group's, which is
   *  the whole point of the shape. */
  alongM: number
  /** One entry per group, including the spine's own at zero. */
  diverts: GroupDivert[]
  /** The most any single group is asked to ride out of their way. THE FAIRNESS
   *  TERM: a total alone lets one group absorb everybody else's convenience. */
  worstDivertM: number
  totalDivertM: number
  /** How much of the spine is left to ride together, 0 to 1. */
  sharedFraction: number
  isFuel: boolean
  /** The place's name and street address when it came from one. Empty for a
   *  bare point on the road, which has neither. */
  name?: string
  address?: string
  score: number
}

/**
 * How close a group's own track has to pass for the meet to cost them nothing.
 *
 * Measured to the nearest VERTEX rather than the nearest segment, which is
 * approximate on a sparsely sampled import — and gracefully so: a group whose
 * road genuinely passes through the point but whose nearest vertex is further
 * off than this is scored by the dogleg formula instead, which for a point
 * essentially on their line returns nearly zero anyway. The failure is a small
 * number where zero was right, not a rejection.
 */
const ON_ROUTE_M = 1000

/**
 * Propose where the joining groups should meet the main group, on the main
 * group's own road to the destination everybody shares.
 *
 * Returns the best few, or an empty list, which is a real answer here for the
 * same reason it is above: groups approaching a destination from opposite sides
 * have no sensible meeting point short of it, and offering the least bad one
 * would be worse than saying so.
 *
 * NOTHING IS RE-ROUTED AND NO ROUTER IS CALLED, exactly as above. The candidate
 * is a point on a road the main group is already riding, so the road to it
 * exists; what the others ride to reach it is measured straight-line, and is
 * replaced by a real routed number the moment the planner accepts.
 */
export function proposeGroupMeet(
  primary: GroupRoute,
  joining: GroupRoute[],
  fuelStops: FuelCandidate[] = [],
  options: RendezvousOptions = {},
  limit = 3,
): GroupMeet[] {
  const opts = { ...DEFAULTS, ...options }
  // Nobody to meet. Not an error and nothing to explain — there is no question.
  if (joining.length === 0) return []
  // No road to put a meeting point on. The caller distinguishes this from
  // "nowhere works" before ever getting here, because the two send a planner to
  // completely different places.
  if (primary.track.length < 3) return []

  const pre = prefix(primary.track)
  const totalM = pre[pre.length - 1]
  if (totalM <= 0) return []

  // THE DESTINATION IS WHERE THE MAIN GROUP'S ROUTE ENDS, which is the whole
  // reason no new column was added for it: their day already says where they are
  // going, and a second place to state it is a second place for it to be wrong.
  //
  // A JOINING GROUP CONTRIBUTES A STARTING POINT AND NOTHING ELSE. Ziad's call,
  // 2026-09-03: the main group rides start to finish, the others say where they
  // set off, and where they meet is what the app is for. So only `origin` is read
  // below, and where a joining group's own track happens to end is not consulted
  // — that is usually the last place they have got round to planning rather than
  // a statement about where they are going.
  //
  // A filter dropping groups whose route ended elsewhere was written and removed
  // the same hour. It is recorded because it reads as careful and is not: on the
  // ride it was first tried against, the second group's day ended at a coffee
  // shop in their own town, so they were dropped and the ride answered "nowhere
  // works". Nothing is lost by keeping them — a group genuinely riding to another
  // city gets a divert far past `maxDivertMi` and is refused by the ordinary cap,
  // which is a number behind a decision rather than a rule in front of one.
  const dest = primary.track[primary.track.length - 1]

  const found: GroupMeet[] = []
  // `place` is the fuel candidate this vertex stands for, or null for a bare
  // point on the road. When it is set, the candidate IS the place — its own
  // coordinates, its name and its address — and the vertex only supplies
  // `alongM`.
  const consider = (i: number, place: FuelCandidate | null) => {
    const scored = scoreGroupMeet(primary, i, pre, totalM, joining, dest, place, opts)
    if (scored) found.push(scored)
  }

  // Bare points on the road, sampled. Skipped entirely under `fuelOnly` rather
  // than scored and filtered later — see the option.
  if (!opts.fuelOnly) {
    let nextAt = opts.sampleM
    for (let i = 1; i < primary.track.length - 1; i++) {
      if (pre[i] < nextAt) continue
      nextAt = pre[i] + opts.sampleM
      consider(i, null)
    }
  }

  // Existing fuel stops on the main group's road, snapped to it, offered whether
  // or not the sampler landed on them. Same thumb on the scale as above.
  for (const stop of fuelStops) {
    if (!stop.roles.includes('gas')) continue
    let best = -1
    let bestD = Infinity
    for (let i = 1; i < primary.track.length - 1; i++) {
      const d = haversineM(stop.at[1], stop.at[0], primary.track[i][1], primary.track[i][0])
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    // Only when the stop is actually ON the road. Snapping a station three
    // counties away to its nearest vertex would offer a meeting point nobody is
    // riding past.
    if (best > 0 && bestD <= ON_ROUTE_M) consider(best, stop)
  }

  found.sort((a, b) => a.score - b.score)

  // NEAR-DUPLICATES DROPPED, because a 2 km sampler on a long road offers five
  // candidates within a mile of each other and a planner reads that as the app
  // having nothing to say. One per ten kilometres, by `alongM` — every candidate
  // is on the same track now, so the distances are comparable.
  const kept: GroupMeet[] = []
  for (const c of found) {
    if (kept.some((k) => Math.abs(k.alongM - c.alongM) < 10_000)) continue
    kept.push(c)
    if (kept.length === limit) break
  }
  return kept
}

/** Score one point on the main group's road as a meeting place. `null` when any
 *  joining group is refused it. */
function scoreGroupMeet(
  primary: GroupRoute,
  vertexIndex: number,
  pre: number[],
  totalM: number,
  joining: GroupRoute[],
  dest: [number, number],
  place: FuelCandidate | null,
  opts: Required<RendezvousOptions>,
): GroupMeet | null {
  // THE PLACE'S OWN POSITION WHERE THERE IS ONE. It sits within ON_ROUTE_M of
  // the vertex by construction, so every distance below is unchanged to within
  // that — and the coordinate the rider is actually sent to is the forecourt
  // rather than the carriageway outside it.
  const at = place ? place.at : primary.track[vertexIndex]
  const isFuel = place !== null
  const alongM = pre[vertexIndex]

  // Real road left to ride together, or the meet achieves nothing. Same floor
  // and same reasoning as the single-spine version — see minSharedFraction.
  const sharedFraction = (totalM - alongM) / totalM
  if (sharedFraction < opts.minSharedFraction) return null

  const next = primary.track[Math.min(vertexIndex + 1, primary.track.length - 1)]
  const prev = primary.track[Math.max(vertexIndex - 1, 0)]
  const spineBearing = bearing(prev, next)

  const toDestM = haversineM(at[1], at[0], dest[1], dest[0])

  // The main group rides through here by construction, and is listed at zero so
  // the panel can name every group rather than silently omitting the one whose
  // road it is.
  const diverts: GroupDivert[] = [{ id: primary.id, divertM: 0, approachDeg: 0, onRoute: true }]

  for (const g of joining) {
    // A group whose own road already passes through this point pays nothing,
    // which is what lets a route that genuinely converges with the main one be
    // found by this function rather than needing a second one beside it.
    let nearest = Infinity
    for (const v of g.track) {
      const d = haversineM(v[1], v[0], at[1], at[0])
      if (d < nearest) nearest = d
    }
    if (nearest <= ON_ROUTE_M) {
      diverts.push({ id: g.id, divertM: 0, approachDeg: 0, onRoute: true })
      continue
    }

    // Straight lines on all three legs, for the reason the single-spine version
    // records at length: mixing a road distance into this comparison bills the
    // road's own bends to whoever is joining.
    const toMeetM = haversineM(g.origin[1], g.origin[0], at[1], at[0])
    const directM = haversineM(g.origin[1], g.origin[0], dest[1], dest[0])
    const divertM = toMeetM + toDestM - directM
    const approachDeg = Math.abs(turn(bearing(g.origin, at), spineBearing))
    // Arriving at the meeting point from in front of it: they would ride past it
    // and turn around. Refused for the whole candidate rather than for one
    // group, because a meeting point one group cannot use is not one.
    if (approachDeg > opts.maxApproachDeg) return null
    diverts.push({ id: g.id, divertM, approachDeg, onRoute: false })
  }

  const totalDivertM = diverts.reduce((n, d) => n + d.divertM, 0)
  const worstDivertM = diverts.reduce((n, d) => Math.max(n, d.divertM), 0)
  // THE CAP IS ON THE WORST GROUP, NOT ON THE TOTAL. A budget spent in total
  // lets three groups' convenience be paid for by a fourth, which is exactly the
  // silent unfairness #67 asks the app not to commit on the planner's behalf.
  // The main group is never the one it protects — they ride their own road — so
  // it is entirely a limit on what a feeder can be asked to do.
  if (worstDivertM > opts.maxDivertMi * METERS_PER_MILE) return null

  // THE EARLIEST ACCEPTABLE MEETING POINT WINS, NOT THE CHEAPEST. Ziad's call,
  // 2026-09-03, and it reverses what the weights said an hour earlier. The point
  // of a group ride is to ride as a group, so the thing being minimized is the
  // distance covered APART; the divert is a limit on what that may cost
  // somebody, not the goal.
  //
  // MEASURED, BECAUSE THE OLD WEIGHTS WERE NOT OBVIOUSLY WRONG. On ride 34 —
  // Oakland to Bakersfield with a second group starting in Santa Cruz, which
  // sits west of the road — divert falls monotonically the further south the
  // meet is: 101 miles at Oakland, 25 near Los Banos, 2.4 near Bakersfield. So a
  // score led by divert always picked the LAST viable point and the two groups
  // rode 200 miles separately to a ride they were doing together. Choosing the
  // earliest instead unites them about ninety minutes sooner.
  //
  // `alongM` REPLACES the old `-sharedFraction * 5` rather than joining it:
  // shared fraction is `(total - along) / total`, so the two say the same thing
  // and keeping both would just double the weight of one term.
  //
  // THE CONSEQUENCE TO STATE RATHER THAN TREAT AS A BUG: an earliest-subject-to-
  // a-limit rule always lands near the limit, so `maxDivertMi` stops being a
  // guard against nonsense and becomes the actual dial. It has no control and
  // this is where it would need one.
  //
  // Divert survives at a TENTH of a mile per mile, which only ever separates
  // candidates that are nearly the same distance along — near-ties, where "and
  // it costs them less" is the right reason to prefer one. The approach angle
  // and the fuel bonus keep their weights; note the fuel bonus is now worth two
  // miles of ROUTE rather than two miles of detour, which is a smaller thumb
  // than it was and still enough to prefer a pump over a bare vertex beside it.
  const approachPenalty = diverts.reduce((n, d) => n + (d.approachDeg / 90) * 1, 0)
  const score = alongM / METERS_PER_MILE + (totalDivertM / METERS_PER_MILE) * 0.1 + approachPenalty - (isFuel ? 2 : 0)

  return {
    at,
    alongM,
    diverts,
    worstDivertM,
    totalDivertM,
    sharedFraction,
    isFuel,
    name: place?.name,
    address: place?.address,
    score,
  }
}

/** The worst single group's divert in miles — the one number that says whether a
 *  proposal is fair, rounded the way every other distance in the app is. */
export const worstDivertMi = (m: GroupMeet): number => Math.round((m.worstDivertM / METERS_PER_MILE) * 10) / 10
