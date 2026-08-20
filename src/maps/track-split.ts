// Turning one imported track into the legs a builder can edit.
//
// THE PROBLEM. An imported day was stored as a single `route_legs` row holding
// the entire track, however many stops sat along it. The builder's model is N
// stops and exactly N−1 legs, one per consecutive pair, and `daySchema` in
// ride-graph.ts enforces it — so an imported ride could never be opened, saved
// or exported as valid native JSON. That is the whole reason `/builder/:id`
// answered 409 for imports, and it is what this file removes.
//
// THE APPROACH. Project each stop onto the track, then slice the track at those
// vertices. Nothing is re-routed and no coordinate is invented: the legs are cut
// from the imported geometry, so concatenating them gives back the original
// track element-for-element. Re-routing would replace a recorded line with
// Google's guess, which is the one thing importing exists to avoid.
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
  /** Stops in along-track order, which is the order their legs connect them in. */
  stops: ExtractedPoint[]
  /** Untouched — a POI does not anchor a leg and takes no part in the split. */
  pois: ExtractedPoint[]
  legs: SplitLeg[]
  /** True when this file named no stop at that end and one was invented. */
  synthesizedStart: boolean
  synthesizedEnd: boolean
  /** Stops demoted to POIs because the track was too short to give them a leg. */
  demoted: number
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
 * Split one day's track into the legs its stops imply.
 *
 * `points` is the mixed list the parsers produce — POIs are separated out and
 * passed through untouched. Stops come back in ALONG-TRACK order, which is not
 * necessarily the order they appeared in the file: GPX writes `<wpt>` elements
 * at document level with nothing tying them to a track, so their order is
 * whatever the exporting tool felt like.
 */
export function splitDayTrack(track: Track, points: ExtractedPoint[]): SplitDay {
  const pois = points.filter((p) => p.kind === 'poi')
  const stops = points.filter((p) => p.kind !== 'poi')

  // No geometry to cut. A CSV import lands here by design — it is a list of
  // stops with no line, and saying so is better than joining them with straight
  // lines and reporting a distance no motorcycle can ride.
  if (track.length < 2) {
    return { stops, pois, legs: [], synthesizedStart: false, synthesizedEnd: false, demoted: 0 }
  }

  const last = track.length - 1

  // Project, then sort along the track. Stable, so two stops on the same vertex
  // keep their file order relative to each other.
  const placed = stops
    .map((stop, order) => ({ stop, order, at: nearestVertexIndex(track, stop) }))
    .sort((a, b) => a.at - b.at || a.order - b.order)

  // A track can only carry as many stops as it has vertices — each leg needs at
  // least two, and they share their joints, so N stops need N vertices. Beyond
  // that, a stop cannot be given its own piece of road.
  //
  // The overflow becomes POIs rather than being dropped. That is not a
  // consolation prize: a POI is by definition a point near the route that does
  // not anchor routing, which is exactly what these are. Nothing is lost, and
  // the ride stays a valid graph. Only reachable on a pathological file — a
  // four-vertex track with six named stops — but "pathological" and "rejected
  // at upload" should not be the same thing.
  let demoted = 0
  if (placed.length > track.length) {
    for (const extra of placed.splice(track.length)) {
      pois.push({ ...extra.stop, kind: 'poi' })
      demoted++
    }
  }

  // Anchor both ends of the track.
  //
  // The head and tail are real road that was ridden. If the outermost stops sit
  // somewhere in the middle, slicing only between them would silently discard
  // everything before the first and after the last — so either a stop already
  // stands at each end, or one is invented there.
  let synthesizedStart = false
  let synthesizedEnd = false

  const first = placed[0]
  if (!first || (first.at !== 0 && metersBetween(track[0], first.stop) > ENDPOINT_TOLERANCE_M)) {
    placed.unshift({ stop: pointAt(track, 0, START_NAME), order: -1, at: 0 })
    synthesizedStart = true
  } else {
    first.at = 0
  }

  const tail = placed[placed.length - 1]
  if (placed.length < 2 || (tail.at !== last && metersBetween(track[last], tail.stop) > ENDPOINT_TOLERANCE_M)) {
    placed.push({ stop: pointAt(track, last, FINISH_NAME), order: Infinity, at: last })
    synthesizedEnd = true
  } else {
    tail.at = last
  }

  // Strictly increasing, or a leg ends up with fewer than the two vertices
  // `legSchema.geometry` requires. Two stops projecting to the same vertex is
  // ordinary — a lunch stop and a fuel stop in the same village — so the later
  // one is nudged forward rather than refused. The demotion above guarantees
  // there is room.
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].at <= placed[i - 1].at) placed[i].at = placed[i - 1].at + 1
  }
  // The nudge can only ever push the last boundary past the end when the track
  // is exactly as long as the stop count, so pull the run back from the tail.
  if (placed[placed.length - 1].at > last) {
    placed[placed.length - 1].at = last
    for (let i = placed.length - 2; i >= 0; i--) {
      if (placed[i].at >= placed[i + 1].at) placed[i].at = placed[i + 1].at - 1
    }
  }

  const legs: SplitLeg[] = []
  for (let i = 0; i < placed.length - 1; i++) {
    const geometry = track.slice(placed[i].at, placed[i + 1].at + 1)
    legs.push({ geometry, distanceM: Math.round(trackMeters(geometry)) })
  }

  return { stops: placed.map((p) => p.stop), pois, legs, synthesizedStart, synthesizedEnd, demoted }
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
