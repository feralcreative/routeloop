// PROPOSING A MEETING POINT: given a trunk route and a subgroup's origin, find
// somewhere sensible for them to join. @epim's idea, in #143 and now #67.
//
// PURE GEOMETRY, AND IT CALLS NO ROUTER. Ranking a few dozen candidates through the
// Routes API would be a Routes bill per keystroke on a per-request SKU — and the
// proposal is a SUGGESTION the planner accepts, at which point the ordinary routing
// path draws the real road and every number here is replaced by a measured one.
// Straight-line distance is the right precision for "is this a sane place to meet"
// and the wrong one for "how long will it take"; this module never claims the second.

import { haversineM, METERS_PER_MILE, type Track } from '../maps/kml'
import { bearing, turn } from '../maps/twist'
import { matchesAny } from '../places/ranking'

/** A candidate the planner could be offered. */
export type Rendezvous = {
  /** `[lng, lat]`, like every coordinate in this app. */
  at: [number, number]
  /** Meters along the trunk from its start. What makes one candidate earlier
   *  than another, and what the caller needs to cut the trunk at. */
  alongM: number
  /** Extra meters the joining group rides versus going direct to the trunk's
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
   * How much FURTHER out of their way than necessary a joining group may be sent, in
   * miles. A candidate costing more is not offered at all rather than ranked last:
   * #67's constraint is that neither group *significantly* diverts.
   *
   * MEASURED FROM EACH GROUP'S CHEAPEST VIABLE MEET, NOT FROM ZERO (#370). An
   * absolute cap answered "nowhere works" for any group whose road never came within
   * it of the main group's, which is a fact about the two roads and not about the
   * meet. The older `proposeRendezvous` still reads it as an absolute cap.
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
   * WITHOUT THIS THE PROPOSER CHEATS, and it took a failing test to notice: a group a
   * long way off the trunk gets its smallest divert by meeting near the trunk's END,
   * where the two ride together for twenty minutes and the exercise was pointless.
   */
  minSharedFraction?: number
  /** How finely to sample the trunk. 2 km is well under any sane meeting-point
   *  precision and keeps a 500 km trunk to 250 candidates. */
  sampleM?: number
  /**
   * The rider's two place lists, already parsed (#271), as a WEIGHTING on a named
   * candidate: `PLACE_NUDGE_MI` down for avoid and up for favor, and a station on
   * both is favored.
   *
   * REVERSES THE 2026-09-07 CALL that these lists must never reach the proposer,
   * after a Costco was handed over as the meeting point with Costco Gas on the avoid
   * list and a Shell four miles on. What the old rule protected survives as the SHAPE
   * of this one — a nudge and never a filter.
   */
  favor?: string[]
  avoid?: string[]
  /**
   * Offer ONLY fuel candidates, never a bare point on the road.
   *
   * THE FILTER HAS TO BE HERE AND NOT AT THE CALL SITE, which is the whole reason
   * this option exists: the ranking prefers the EARLIEST viable point and only the
   * best few survive, so a station a little further along is crowded out by plain
   * vertices before a caller ever sees it — and "no station on this road" would be
   * reported for a road with several.
   */
  fuelOnly?: boolean
}

// TEN MILES OF EXTRA DETOUR BY DEFAULT, down from twenty-five (#370): twenty-five
// was aggressive as an absolute cap and more so as an allowance over the cheapest
// meet. A rider's own default lives in `user_profiles.meet_divert_mi`; this is what
// a rider who never set one gets.
export const DEFAULT_DIVERT_MI = 10
const DEFAULTS = {
  maxDivertMi: DEFAULT_DIVERT_MI,
  maxApproachDeg: 110,
  minSharedFraction: 0.2,
  sampleM: 2000,
  fuelOnly: false,
  favor: [] as string[],
  avoid: [] as string[],
}

/**
 * What a place on the rider's avoid list costs a candidate, and what one on the favor
 * list buys it, in miles of score.
 *
 * EIGHT, WHICH IS ABOUT FIVE MILES OF DETOUR OR EIGHT FURTHER ALONG — "I would
 * rather not stop there" is worth a few miles and not a county. Chosen so a Costco at
 * a junction loses to the Shell six miles on, which is the case it was set by.
 */
export const PLACE_NUDGE_MI = 8

/** The nudge for one named candidate. Zero for a bare point on the road, which
 *  has no name to match, and favor wins a place named on both lists. */
export function placeNudgeMi(name: string | undefined, favor: string[], avoid: string[]): number {
  if (!name) return 0
  const place = { name }
  if (matchesAny(place, favor)) return -PLACE_NUDGE_MI
  if (matchesAny(place, avoid)) return PLACE_NUDGE_MI
  return 0
}

/**
 * What a divert budget may be, when it comes from outside.
 *
 * THE DIAL IS A RIDER-FACING NUMBER NOW, so it arrives over HTTP and cannot be
 * trusted. It lives here rather than in the route for the reason every rule does: a
 * route is a query and a rule is a rule, and this one is testable with no database.
 *
 * THE FLOOR IS A MILE. THE CEILING IS 200, which is what keeps the word "divert"
 * meaning something: past that every point on the road passes.
 *
 * UNDEFINED FOR ANYTHING UNUSABLE rather than a fallback number, so it spreads into
 * an options object as a no-op and a caller that sends nonsense gets DEFAULTS.
 */
export const MIN_DIVERT_MI = 1
export const MAX_DIVERT_MI = 200

/**
 * The caller's options over DEFAULTS, with an EXPLICIT `undefined` ignored.
 *
 * A plain spread does not do that: `{ ...DEFAULTS, ...{ maxDivertMi: undefined } }`
 * carries the undefined through, the cap becomes NaN, and `worst > NaN` is false for
 * every candidate — so the cap was silently OFF for exactly the shape the route
 * builds when a client sends nothing. The test that claimed to pin this passed on a
 * fixture where the cap never bit.
 */
function withDefaults(options: RendezvousOptions): Required<RendezvousOptions> {
  const opts: Record<string, unknown> = { ...DEFAULTS }
  for (const [k, v] of Object.entries(options)) if (v !== undefined) opts[k] = v
  return opts as Required<RendezvousOptions>
}

export function clampDivert(v: unknown): number | undefined {
  // AN EMPTY STRING IS NOT ZERO, and this is the one case that has to be written out.
  // `Number('')` is 0 and 0 is finite, so a rider who CLEARED the number box would
  // post "" and be clamped up to the one-mile floor — refusing every candidate on the
  // ride and reading as the feature being broken rather than a field left empty.
  const str = typeof v === 'string' ? v.trim() : null
  if (str === '') return undefined
  const n = typeof v === 'number' ? v : str !== null ? Number(str) : NaN
  if (!Number.isFinite(n)) return undefined
  return Math.min(MAX_DIVERT_MI, Math.max(MIN_DIVERT_MI, n))
}

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
 * Score one candidate on the trunk. `null` means "not offerable" — a backtrack or
 * too big a divert — which the caller drops rather than ranks.
 *
 * THE DIVERT IS MEASURED AGAINST GOING DIRECT TO THE TRUNK'S END, not against zero:
 * a group joining a route is going to that destination either way, so the meeting
 * point costs them the difference between (ride to the meet, then follow the trunk)
 * and (ride straight there). Measuring against zero ranks the trunk's own start best
 * every time.
 *
 * ALL THREE LEGS OF THAT COMPARISON ARE STRAIGHT LINES, AND MIXING IN THE ROAD
 * DISTANCE IS THE BUG #239 WAS HALF OF. The remainder used to be measured ALONG THE
 * TRUNK while `directM` was a straight line, so every bend after the candidate was
 * charged to the joining group — on a sinuosity of 1.15 that invented 13 miles of
 * divert against a 25-mile budget. `sharedFraction` below is the one term that
 * genuinely wants the road distance.
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

  // TOO LITTLE ROAD LEFT TO RIDE TOGETHER. See minSharedFraction: minimizing
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

  // Divert dominates, because miles are what a rider actually pays. Everything else is
  // a nudge measured in miles-equivalent so the weights are readable:
  //
  //   approach angle   up to 1 mile at ninety degrees — enough to prefer a parallel
  //                    join between two similar candidates, not enough to send
  //                    anybody the long way round.
  //   shared road      up to 5 miles beyond the floor, pulling a proposal back from
  //                    the destination toward road ridden together.
  //   fuel             2 miles. A fuel stop is where a group wants to regather
  //                    anyway, and #67 is explicit that it is a thumb on the scale.
  const score = divertM / METERS_PER_MILE + (approachDeg / 90) * 1 - sharedFraction * 5 - (isFuel ? 2 : 0)

  return { at, alongM, divertM, approachDeg, isFuel, sharedFraction, score }
}

/**
 * Propose meeting points along a trunk for one joining group.
 *
 * Returns the best few, ordered, or an empty list when nothing clears the constraints
 * — a real answer that has to be rendered as one. Two origins on opposite sides of a
 * trunk running away from both of them have no sensible rendezvous, and offering the
 * least bad one would be worse than saying so.
 *
 * The trunk's own endpoints are excluded: its start is not a meeting point, it is the
 * whole ride; its end is everybody arriving separately.
 */
export function proposeRendezvous(
  trunk: Track,
  origin: [number, number],
  fuelStops: FuelCandidate[] = [],
  options: RendezvousOptions = {},
  limit = 3,
): Rendezvous[] {
  const opts = withDefaults(options)
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
  // so a stop a hundred meters off the line is still a point on the route.
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
  // app having nothing to say. One per ten kilometers of trunk.
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
// QUESTION A PLANNER ACTUALLY HAS: everyone is going to the same place from
// different ones, where should they meet?
//
// THE MAIN GROUP'S ROUTE IS THE ROUTE, AND EVERY OTHER GROUP JOINS IT.
// `rides.primary_subgroup_id` already defaults to the first group created, so there
// is nothing to nominate and no loop to break.
//
// THE MAIN GROUP CAN NEVER BE THE ONE JOINING, which the signature says rather than
// the body checking: a single list plus an id is one typo away from proposing that
// the main group ride out of its way to meet a feeder.
//
// The rejected version is recorded because it read well and was worse: taking every
// group symmetrically and trying each road as a spine is fairer in the abstract and
// moves the answer depending on which groups exist.

/** One group's planned run to the shared destination. */
export type GroupRoute = {
  /** The subgroup's uid — what the client and the route both address it by. */
  id: string
  /** Where this group sets off. */
  origin: [number, number]
  /** Their routed track, origin to the destination everybody shares. */
  track: Track
  /** True when `track` is the direct road the route fetched for a group that
   *  had only a starting point — a road nothing on the map draws, so the
   *  stretch of it to an on-route candidate is sent as that candidate's
   *  approach. A group's own drawn route is already on the map. */
  direct?: boolean
}

/** What one group pays for a proposed meeting point. */
export type GroupDivert = {
  id: string
  divertM: number
  /** Meters more than this group's CHEAPEST viable meet anywhere on the road.
   *  Zero at that point, and what the cap is measured against — see
   *  `maxDivertMi`. */
  extraM: number
  /** Degrees between their approach and the spine's direction there. */
  approachDeg: number
  /** True when their own route already passes through this point, which is what
   *  makes a natural convergence cost nothing. */
  onRoute: boolean
}

export type GroupMeet = {
  /** Where to meet. THE STATION'S OWN POSITION when this is a fuel candidate,
   *  not the road vertex it snapped to — a rider told to meet at a Shell should
   *  be sent to the forecourt, and the point added to every group's route is this
   *  coordinate. `alongM` still comes from the snapped vertex, because ranking
   *  is about distance along the road. */
  at: [number, number]
  /** Meters along the MAIN group's track, so the caller can cut it here. There
   *  is no "which group's track" field: it is always the main group's, which is
   *  the whole point of the shape. */
  alongM: number
  /** One entry per group, including the spine's own at zero. */
  diverts: GroupDivert[]
  /** The most any single group is asked to ride out of their way. THE FAIRNESS
   *  TERM: a total alone lets one group absorb everybody else's convenience. */
  worstDivertM: number
  /** The most any single group is asked to ride BEYOND its own cheapest meet.
   *  What the cap is applied to. */
  worstExtraM: number
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
 * approximate on a sparsely sampled import — and gracefully so: a group scored by the
 * dogleg formula instead gets nearly zero anyway for a point essentially on their
 * line. The failure is a small number where zero was right, not a rejection.
 */
const ON_ROUTE_M = 1000

/**
 * A mile out of somebody's way has to buy this many miles of riding together.
 *
 * THE EXCHANGE RATE IS THE RULE, AND THE CAP IS BACK TO BEING A GUARD (#370),
 * REVERSING the 2026-09-03 weighting rather than leaving it to be rediscovered. That
 * version led with `alongM` and let the divert survive at a tenth, on the argument
 * that a group ride minimizes distance ridden apart — true, and it made the earliest
 * point under the cap win every time, so the answer was always AT the cap.
 *
 * SCORED AS A TRADE INSTEAD: moving a meet a mile earlier gains a mile together and
 * costs whatever extra divert the geometry charges, weighted at 1.5. Three
 * straight-road shapes bound the number: a group ON the road pays TWO miles per mile
 * gained (any weight above 0.5 keeps them at their junction), a group WELL OFF to one
 * side of a road heading away pays about HALF (any weight under 2 sends them to the
 * cap), and a group A FEW MILES to one side pays one and lands a little past the foot
 * of the perpendicular.
 *
 * 1.5 rather than 1 because indifference is the wrong default: a rule that sends
 * somebody a mile out of their way to gain exactly a mile has no opinion.
 *
 * THE KNIFE EDGE IS GEOMETRY, NOT A DEFECT. On a straight road there is no elbow, so
 * the answer is the cheapest meet or the cap — which is why the cap survives, and why
 * it is measured from each group's cheapest rather than from zero.
 */
const DIVERT_WEIGHT = 1.5

/** A candidate with every group's cost measured and the two refusals that are
 *  about the POINT already applied — the cap is not, because it is measured
 *  against a floor that is only known once every candidate has been measured. */
type Measured = {
  at: [number, number]
  alongM: number
  sharedFraction: number
  diverts: GroupDivert[]
  place: FuelCandidate | null
  /** False for a bare vertex measured under `fuelOnly`: it sets the floor and
   *  is never returned. */
  offer: boolean
}

/**
 * Propose where the joining groups should meet the main group, on the main group's
 * own road to the destination everybody shares.
 *
 * Returns the best few, or an empty list, which is a real answer: groups approaching
 * a destination from opposite sides have no sensible meeting point short of it.
 *
 * NOTHING IS RE-ROUTED AND NO ROUTER IS CALLED. What the others ride is measured
 * straight-line, and is replaced by a real routed number when the planner accepts.
 */
export function proposeGroupMeet(
  primary: GroupRoute,
  joining: GroupRoute[],
  fuelStops: FuelCandidate[] = [],
  options: RendezvousOptions = {},
  limit = 3,
): GroupMeet[] {
  const opts = withDefaults(options)
  // Nobody to meet. Not an error and nothing to explain — there is no question.
  if (joining.length === 0) return []
  // No road to put a meeting point on. The caller distinguishes this from
  // "nowhere works" before ever getting here, because the two send a planner to
  // completely different places.
  if (primary.track.length < 3) return []

  const pre = prefix(primary.track)
  const totalM = pre[pre.length - 1]
  if (totalM <= 0) return []

  // THE DESTINATION IS WHERE THE MAIN GROUP'S ROUTE ENDS, which is why no column was
  // added for it: their route already says where they are going.
  //
  // A JOINING GROUP CONTRIBUTES A STARTING POINT AND NOTHING ELSE. Only `origin` is
  // read, and where a joining group's own track ends is not consulted — that is
  // usually the last place they have got round to planning.
  //
  // A filter dropping groups whose route ended elsewhere was written and removed the
  // same hour. It is recorded because it reads as careful and is not: the second
  // group's route ended at a coffee shop in their own town, so they were dropped and
  // the ride answered "nowhere works".
  const dest = primary.track[primary.track.length - 1]

  // TWO PASSES, BECAUSE THE CAP IS MEASURED FROM EACH GROUP'S CHEAPEST MEET AND THAT
  // IS NOT KNOWN UNTIL EVERY CANDIDATE HAS BEEN MEASURED. The first pass measures what
  // every group would pay at every candidate and keeps the least any of them pays
  // anywhere viable; the second applies the cap against that floor and scores.
  //
  // `place` is the fuel candidate a vertex stands for, or null for a bare point on the
  // road — when it is set, the candidate IS the place and the vertex only supplies
  // `alongM`.
  const measured: Measured[] = []
  const consider = (i: number, place: FuelCandidate | null, offer: boolean) => {
    const m = measureGroupMeet(primary, i, pre, totalM, joining, dest, place, opts)
    if (m) measured.push({ ...m, offer })
  }

  // Bare points on the road, sampled. UNDER `fuelOnly` THEY ARE STILL MEASURED
  // AND NEVER OFFERED: the floor is a fact about the road's geometry, and a
  // floor taken from the stations alone would let a group's cheapest station
  // — which may itself be well out of their way — pass the cap for free.
  let nextAt = opts.sampleM
  for (let i = 1; i < primary.track.length - 1; i++) {
    if (pre[i] < nextAt) continue
    nextAt = pre[i] + opts.sampleM
    consider(i, null, !opts.fuelOnly)
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
    if (best > 0 && bestD <= ON_ROUTE_M) consider(best, stop, true)
  }

  // EACH GROUP'S CHEAPEST VIABLE MEET, which is the convergence the issue asked
  // for: where their road meets the main group's for a group on it, and the
  // least dogleg the geometry allows for a group off it. Taken over every
  // measured candidate, offered or not, so `fuelOnly` reads the same floor as
  // the plain pass and the two passes cannot disagree about what a station
  // costs.
  const floor = new Map<string, number>()
  for (const m of measured) {
    for (const d of m.diverts) floor.set(d.id, Math.min(floor.get(d.id) ?? Infinity, d.divertM))
  }

  const found: GroupMeet[] = []
  for (const m of measured) {
    if (!m.offer) continue
    const scored = scoreGroupMeet(m, floor, opts)
    if (scored) found.push(scored)
  }

  found.sort((a, b) => a.score - b.score)

  // NEAR-DUPLICATES DROPPED, because a 2 km sampler offers five candidates within a
  // mile of each other and a planner reads that as the app having nothing to say. One
  // per ten kilometers, by `alongM`.
  //
  // STATIONS ARE SPREAD AT THREE KILOMETERS, NOT TEN: a station is a named place, and
  // two four miles apart are a real choice where two bare vertices are the same
  // stretch of highway twice.
  const spreadM = opts.fuelOnly ? 3_000 : 10_000
  const kept: GroupMeet[] = []
  for (const c of found) {
    if (kept.some((k) => Math.abs(k.alongM - c.alongM) < spreadM)) continue
    kept.push(c)
    if (kept.length === limit) break
  }
  return kept
}

/** Measure one point on the main group's road as a meeting place: what every
 *  group pays to get there. `null` when the point itself is refused — too little
 *  road left, or a backtrack for any joining group. */
function measureGroupMeet(
  primary: GroupRoute,
  vertexIndex: number,
  pre: number[],
  totalM: number,
  joining: GroupRoute[],
  dest: [number, number],
  place: FuelCandidate | null,
  opts: Required<RendezvousOptions>,
): Omit<Measured, 'offer'> | null {
  // THE PLACE'S OWN POSITION WHERE THERE IS ONE. It sits within ON_ROUTE_M of
  // the vertex by construction, so every distance below is unchanged to within
  // that — and the coordinate the rider is actually sent to is the forecourt
  // rather than the highway outside it.
  const at = place ? place.at : primary.track[vertexIndex]
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
  const diverts: GroupDivert[] = [{ id: primary.id, divertM: 0, extraM: 0, approachDeg: 0, onRoute: true }]

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
      diverts.push({ id: g.id, divertM: 0, extraM: 0, approachDeg: 0, onRoute: true })
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
    // `extraM` is filled in by the caller once the floor is known.
    diverts.push({ id: g.id, divertM, extraM: 0, approachDeg, onRoute: false })
  }

  return { at, alongM, sharedFraction, diverts, place }
}

/** Apply the cap and the score to a measured candidate, against each group's
 *  cheapest meet. `null` when any joining group is asked for more extra divert
 *  than the cap allows. */
function scoreGroupMeet(
  m: Omit<Measured, 'offer'>,
  floor: Map<string, number>,
  opts: Required<RendezvousOptions>,
): GroupMeet | null {
  const diverts = m.diverts.map((d) => ({ ...d, extraM: Math.max(0, d.divertM - (floor.get(d.id) ?? 0)) }))
  const totalDivertM = diverts.reduce((n, d) => n + d.divertM, 0)
  const worstDivertM = diverts.reduce((n, d) => Math.max(n, d.divertM), 0)
  const worstExtraM = diverts.reduce((n, d) => Math.max(n, d.extraM), 0)
  // THE CAP IS ON THE WORST GROUP, NOT ON THE TOTAL: a budget spent in total lets
  // three groups' convenience be paid for by a fourth, which is the silent unfairness
  // #67 asks the app not to commit on the planner's behalf.
  //
  // AND IT IS MEASURED FROM THAT GROUP'S CHEAPEST MEET, NOT FROM ZERO (#370): a group
  // whose road never comes within thirty miles of the main group's was answered
  // "nowhere works" under an absolute cap of twenty-five.
  if (worstExtraM > opts.maxDivertMi * METERS_PER_MILE) return null

  // THE TRADE. Miles along the road, because every mile earlier is a mile ridden
  // together; plus the divert at DIVERT_WEIGHT, which is the price of each of
  // those miles. The approach angle and the fuel bonus keep their old weights —
  // up to a mile per group at ninety degrees, two miles of score for a pump —
  // and both are nudges between candidates the trade cannot separate.
  const approachPenalty = diverts.reduce((n, d) => n + (d.approachDeg / 90) * 1, 0)
  const isFuel = m.place !== null
  const score =
    m.alongM / METERS_PER_MILE +
    (totalDivertM / METERS_PER_MILE) * DIVERT_WEIGHT +
    approachPenalty -
    (isFuel ? 2 : 0) +
    placeNudgeMi(m.place?.name, opts.favor, opts.avoid)

  return {
    at: m.at,
    alongM: m.alongM,
    diverts,
    worstDivertM,
    worstExtraM,
    totalDivertM,
    sharedFraction: m.sharedFraction,
    isFuel,
    name: m.place?.name,
    address: m.place?.address,
    score,
  }
}

/** The worst single group's divert in miles — the one number that says whether a
 *  proposal is fair, rounded the way every other distance in the app is. */
export const worstDivertMi = (m: GroupMeet): number => Math.round((m.worstDivertM / METERS_PER_MILE) * 10) / 10

// --- Ranking by the road, once the road is known ----------------------------
//
// EVERYTHING ABOVE IS STRAIGHT LINES, AND THE STRAIGHT LINE CANNOT SEE A BAY.
// #370's repro: a group leaving San Francisco to join a ride running up 680. On
// paper the dogleg to a station in Fremont is under ten miles, because the straight
// line crosses the water; by road it is 880 south and 680 north again, fifteen to
// twenty-five miles more than taking 580 to Dublin, where their road meets the main
// group's for nothing. The trade above weighed the paper number.
//
// THE ROADS ARE ALREADY BOUGHT. The route fetches every shortlisted candidate's
// approach to check it against the group's tank and to draw it, so the road miles
// exist for the few candidates a rider is about to be shown. This re-rank costs
// nothing the press was not already spending.
//
// THIS IS NOT THE MIXING #239 WARNS ABOUT. That bug measured the remainder ALONG THE
// TRUNK against a STRAIGHT direct. Here every leg is road, and the trunk is billed
// only BETWEEN candidates: what meeting at M rather than N costs a group is their
// road to M plus the trunk from M to N, less their road to N. The rest of the trunk
// cancels out of every comparison.

/** One candidate with each JOINING group's road to it, in meters — the routed
 *  approach, or the distance along their own track when it passes through the point,
 *  or null when nothing measured it. The main group is not in the map: they ride the
 *  whole trunk whatever is chosen, so an entry for them would bill them the trunk. */
export type RoadMeasure = { meet: GroupMeet; toMeetM: Map<string, number | null> }

/**
 * Distance along a track to the vertex nearest `at`, in meters.
 *
 * For a group whose own road passes through a candidate, this is their road to
 * it — no request needed, and it is the same polyline the on-route test read.
 */
export function alongTrackM(track: Track, at: [number, number]): number {
  const best = nearestVertex(track, at)
  if (best < 0) return 0
  return prefix(track.slice(0, best + 1))[best]
}

/** The index of the track vertex nearest `at`, or -1 for an empty track. */
export function nearestVertex(track: Track, at: [number, number]): number {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < track.length; i++) {
    const d = haversineM(track[i][1], track[i][0], at[1], at[0])
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * Re-rank the shortlist by the roads actually ridden.
 *
 * For each joining group and each measured candidate, what they ride if they meet
 * there is their road to it plus the main group's road from there to the end. The
 * cheapest of those is that group's floor, the extra over it is what the cap is
 * applied to — and because the min is taken over the same list, THE CHEAPEST
 * CANDIDATE ALWAYS SURVIVES THE CAP.
 *
 * A candidate any group has no road for keeps its straight-line numbers and goes to
 * the back, because a guess ranked beside a measurement reads as a measurement.
 *
 * `extraM` on every measured divert becomes the ROAD extra, which is the number a
 * rider is shown beside a group's name.
 */
export function rankByRoad(
  measured: RoadMeasure[],
  trunkTotalM: number,
  maxDivertMi: number,
  lists: { favor: string[]; avoid: string[] } = { favor: [], avoid: [] },
): GroupMeet[] {
  const capM = maxDivertMi * METERS_PER_MILE
  const complete = measured.filter((x) => [...x.toMeetM.values()].every((v) => v !== null))
  const rest = measured.filter((x) => !complete.includes(x)).map((x) => x.meet)

  // Each group's floor: the least they can ride, over the measured candidates.
  const floor = new Map<string, number>()
  for (const { meet, toMeetM } of complete) {
    for (const [gid, road] of toMeetM) {
      const cost = (road as number) + (trunkTotalM - meet.alongM)
      floor.set(gid, Math.min(floor.get(gid) ?? Infinity, cost))
    }
  }

  const ranked: GroupMeet[] = []
  for (const { meet, toMeetM } of complete) {
    const diverts: GroupDivert[] = meet.diverts.map((d) => {
      const road = toMeetM.get(d.id)
      if (road == null) return d
      const extraM = Math.max(0, road + (trunkTotalM - meet.alongM) - (floor.get(d.id) ?? 0))
      return { ...d, extraM }
    })
    const worstExtraM = diverts.reduce((n, d) => Math.max(n, d.extraM), 0)
    // The cap, on the road. Never refuses a group's cheapest candidate, whose
    // extra is zero by construction — so at least one row survives.
    if (worstExtraM > capM) continue
    const totalExtraM = diverts.reduce((n, d) => n + d.extraM, 0)
    const approachPenalty = diverts.reduce((n, d) => n + (d.approachDeg / 90) * 1, 0)
    // THE SAME TRADE AS THE STRAIGHT-LINE PASS, with the extra measured in road.
    // Along the trunk plus DIVERT_WEIGHT times the extra, so a mile out of the
    // way still has to buy a mile and a half together — it is just a real mile
    // now. The fuel bonus stays; every candidate here is a station anyway.
    const score =
      meet.alongM / METERS_PER_MILE +
      (totalExtraM / METERS_PER_MILE) * DIVERT_WEIGHT +
      approachPenalty -
      (meet.isFuel ? 2 : 0) +
      placeNudgeMi(meet.name, lists.favor, lists.avoid)
    ranked.push({ ...meet, diverts, worstExtraM, score })
  }
  ranked.sort((a, b) => a.score - b.score)
  // WITH SEVERAL JOINING GROUPS THE FLOORS CAN DISAGREE — one group's cheapest
  // candidate can be past the cap for another — and then nothing above survives. The
  // least bad measured candidate is kept rather than nothing, because this pass
  // re-orders a list the rider was already going to be shown and must not be the thing
  // that empties it.
  if (ranked.length === 0 && complete.length > 0) {
    const least = complete
      .map(({ meet, toMeetM }) => {
        const worst = Math.max(
          ...[...toMeetM].map(([gid, road]) => (road as number) + (trunkTotalM - meet.alongM) - (floor.get(gid) ?? 0)),
        )
        return { meet, worst }
      })
      .sort((a, b) => a.worst - b.worst)[0]
    ranked.push(least.meet)
  }
  return [...ranked, ...rest]
}
