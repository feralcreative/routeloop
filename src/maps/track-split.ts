// Turning one imported track into the legs a builder can edit.
//
// THE PROBLEM. An imported day was stored as a single `route_legs` row holding
// the entire track, however many points sat along it. The builder's model is N
// points and exactly N−1 legs, one per consecutive pair, and `daySchema` in
// ride-graph.ts enforces it — so an imported ride could never be opened, saved
// or exported as valid native JSON. That is the whole reason `/builder/:id`
// answered 409 for imports, and it is what this file removes.
//
// THE APPROACH. Project each point onto the track, then slice the track at those
// vertices. Nothing is re-routed and no coordinate is invented: the legs are cut
// from the imported geometry, so concatenating them gives back the original
// track element-for-element. Re-routing would replace a recorded line with
// Google's guess, which is the one thing importing exists to avoid.
//
// BOTH KINDS ARE PROJECTED, as of 2026-08-24. A POI used to be passed through
// untouched, because a POI sat beside the route and anchored no leg; it is on the
// route now, so it takes a boundary like any other point. Leaving POIs out would
// append them after the last stop, which draws a road out to a viewpoint that was
// actually halfway along the day.
//
// Legs SHARE their joint vertex — leg k is `track[i_k .. i_{k+1}]` inclusive, so
// leg k's last coordinate is leg k+1's first. That is the form the builder
// already produces and every read path already expects: concatLegs() in
// export.ts, the span walk in index.tsx and trackAndSpans() in builder.js all
// drop consecutive duplicates, so the joint collapses back to one vertex on the
// way out. See the invariant spelled out in public/js/route-shape.js.
//
// Pure: no database, no DOM, no network. test/track-split.test.ts drives it.
import { haversineM, nearestVertexIndex, trackMeters, type ExtractedPoint, type Track } from './kml'

export type SplitLeg = { geometry: Track; distanceM: number }

export type SplitDay = {
  /**
   * Every point, both kinds, in along-track order — which is the order their
   * legs connect them in. One list, matching `day.points` everywhere else.
   */
  points: ExtractedPoint[]
  legs: SplitLeg[]
  /** True when this file named no point at that end and one was invented. */
  synthesizedStart: boolean
  synthesizedEnd: boolean
}

// How near a track's end a stop has to be to count AS that end rather than
// prompting an invented one.
//
// Without a tolerance, a route file whose first waypoint sits one vertex in —
// which is most of them, since the waypoint is a street address and the track
// starts at the curb — would get a synthesized "Start" a few meters away from
// the stop the rider actually named. Two pins on top of each other, one of them
// invented, is worse than none.
//
// 100 m is a street address's worth of slack and far below the distance between
// two stops anybody plans separately.
const ENDPOINT_TOLERANCE_M = 100

const START_NAME = 'Start'
const FINISH_NAME = 'Finish'

function pointAt(track: Track, i: number, name: string): ExtractedPoint {
  return { lat: track[i][1], lng: track[i][0], name, description: null, roles: [], kind: 'stop' }
}

const metersBetween = (a: Track[number], p: { lat: number; lng: number }) => haversineM(a[1], a[0], p.lat, p.lng)

/**
 * Split one day's track into the legs its points imply.
 *
 * `points` is the mixed list the parsers produce, and BOTH KINDS are placed.
 * They come back in ALONG-TRACK order, which is not necessarily the order they
 * appeared in the file: GPX writes `<wpt>` elements at document level with
 * nothing tying them to a track, so their order is whatever the exporting tool
 * felt like. That was already true of stops and is just as true of POIs.
 */
export function splitDayTrack(track: Track, points: ExtractedPoint[]): SplitDay {
  // No geometry to cut. A CSV import lands here by design — it is a list of
  // points with no line, and saying so is better than joining them with straight
  // lines and reporting a distance no motorcycle can ride.
  if (track.length < 2) {
    return { points, legs: [], synthesizedStart: false, synthesizedEnd: false }
  }

  const last = track.length - 1

  // Project, then sort along the track. Stable, so two points on the same vertex
  // keep their file order relative to each other.
  const placed = points
    .map((point, order) => ({ point, order, at: nearestVertexIndex(track, point) }))
    .sort((a, b) => a.at - b.at || a.order - b.order)

  // NO OVERFLOW CASE, where there used to be one. A track could only carry as
  // many STOPS as it had vertices, because every leg needed two of its own, so
  // the excess were demoted to POIs — which worked precisely because a POI
  // consumed no vertex. POIs consume one now, so demotion would buy nothing and
  // the cap has to go somewhere else.
  //
  // It goes into the leg: two points landing on the same vertex get a leg of
  // `[v, v]`, which is two coordinates and satisfies legSchema, zero meters
  // long. That is the honest reading — two points in the same place have no road
  // between them — and it is the same degenerate leg the builder already writes
  // when a rider duplicates a point. See the slice below.

  // Anchor both ends of the track.
  //
  // The head and tail are real road that was ridden. If the outermost points sit
  // somewhere in the middle, slicing only between them would silently discard
  // everything before the first and after the last — so either a point already
  // stands at each end, or one is invented there.
  //
  // A synthesized endpoint is a STOP, not a POI. It is where the day begins or
  // ends, the at-least-one-stop rule has to be satisfiable, and `start`/`finish`
  // mean something only on a stop.
  let synthesizedStart = false
  let synthesizedEnd = false

  const first = placed[0]
  if (!first || (first.at !== 0 && metersBetween(track[0], first.point) > ENDPOINT_TOLERANCE_M)) {
    placed.unshift({ point: pointAt(track, 0, START_NAME), order: -1, at: 0 })
    synthesizedStart = true
  } else {
    first.at = 0
  }

  const tail = placed[placed.length - 1]
  if (placed.length < 2 || (tail.at !== last && metersBetween(track[last], tail.point) > ENDPOINT_TOLERANCE_M)) {
    placed.push({ point: pointAt(track, last, FINISH_NAME), order: Infinity, at: last })
    synthesizedEnd = true
  } else {
    tail.at = last
  }

  // NON-DECREASING, not strictly increasing. The sort already guarantees it;
  // this is here so a caller reading the slice below can rely on it without
  // re-deriving it, and so a hand-built `placed` cannot produce a backwards
  // slice.
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].at < placed[i - 1].at) placed[i].at = placed[i - 1].at
  }

  // A DAY NEEDS A STOP, and a file of nothing but POIs would leave it without
  // one — the payload refine would reject the whole import. The first point is
  // promoted, which is the same rule the builder applies to the first point of
  // every day.
  if (!placed.some((p) => p.point.kind !== 'poi')) {
    placed[0] = { ...placed[0], point: { ...placed[0].point, kind: 'stop' } }
  }

  return {
    points: placed.map((p) => p.point),
    legs: sliceAt(
      track,
      placed.map((p) => p.at),
    ),
    synthesizedStart,
    synthesizedEnd,
  }
}

/**
 * Cut a track at a list of vertex indices, one leg per consecutive pair.
 *
 * `at` must be non-decreasing. A pair on the same vertex yields a zero-length
 * `[v, v]` leg rather than the one-coordinate slice `legSchema` would refuse —
 * the duplicate collapses again in every reader's concatenation, so the track
 * comes back element-for-element either way.
 */
function sliceAt(track: Track, at: number[]): SplitLeg[] {
  const legs: SplitLeg[] = []
  for (let i = 0; i < at.length - 1; i++) {
    const from = at[i]
    const to = at[i + 1]
    const geometry = to > from ? track.slice(from, to + 1) : [track[from], track[from]]
    legs.push({ geometry, distanceM: Math.round(trackMeters(geometry)) })
  }
  return legs
}

/**
 * Re-cut a day's legs for a list of points whose ORDER IS ALREADY RIGHT.
 *
 * This is the restore path for a native file written before 2026-08-24, when a
 * day carried `stops - 1` legs. The points are all there and in the order the
 * rider put them in; what the file lacks is a leg per pair. Concatenating what it
 * does have gives the day's track back, and cutting that at every point produces
 * the missing legs without inventing a coordinate or asking the router.
 *
 * The rider's order is KEPT rather than re-derived, which is what separates this
 * from splitDayTrack above. In a v4 file a POI's place in the list was the
 * rider's own choice — they could drag it — so sorting along the track would
 * quietly rearrange a day they had arranged. A point that projects behind its
 * predecessor is clamped forward to it instead, which costs a zero-length leg and
 * keeps the sequence.
 *
 * Both ends are forced onto the track's ends: the outermost points anchored legs
 * in every older version, so the whole recorded line belongs between them, and
 * anything outside would be silently dropped.
 */
export function relegDay(track: Track, points: Array<{ lat: number; lng: number }>): SplitLeg[] {
  if (track.length < 2 || points.length < 2) return []
  const at = points.map((p) => nearestVertexIndex(track, p))
  at[0] = 0
  at[at.length - 1] = track.length - 1
  for (let i = 1; i < at.length; i++) if (at[i] < at[i - 1]) at[i] = at[i - 1]
  return sliceAt(track, at)
}

/**
 * The track a split day renders as — the same concatenation every reader does,
 * dropping the duplicate at each joint.
 *
 * Here so the tests can assert the round trip in the reader's own terms rather
 * than reimplementing it, and so anything that needs the whole line back has one
 * obvious way to ask.
 */
export function concatSplitLegs(legs: Array<{ geometry: Track }>): Track {
  const out: Track = []
  for (const leg of legs) {
    for (const pt of leg.geometry) {
      const prev = out[out.length - 1]
      if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) out.push(pt)
    }
  }
  return out
}
