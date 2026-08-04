// Expand: densify a route so a hand-off stays on your roads.
//
// Hand a nav app your stops and it picks its own roads between them, which are
// often not the ones you rode out here for. Expand pins the route down by
// adding shaping points along the geometry you already planned, so whatever the
// rider navigates with has no room to form its own opinion.
//
// Why this is not verified against a router
// -----------------------------------------
// The tempting design is to ask the router for A→B, diff it against the
// intended line, and insert a point wherever they disagree. It does not work.
// `route_legs.geometry` is already Routes API output, so asking the Routes API
// to reproduce it is close to tautological — it agrees, and the exercise costs
// dozens of calls to discover that.
//
// It also defends against the wrong thing. The router that ruins a route is
// never ours: it is the Google Maps app carrying the rider's own avoid
// settings, a Garmin recomputing after a missed turn, Sygic. You cannot verify
// against a router you do not control, so the only defence is leaving it no
// room. That means density, and density is geometry — free, offline, and
// computed from what is already stored.
//
// Where the points go
// -------------------
// Turns first. The places a router can plausibly diverge are the places the
// route turned — a junction taken left is a junction it could take straight
// through — so points are scored by heading change and the sharpest win. That
// is the same signal `twist.ts` scores a day's roads by, asked a different
// question.
//
// Then the leftovers go into the longest unpinned runs. Curvature cannot see
// the second way a route diverges: a parallel road that looks just as straight,
// a frontage road, the other side of a valley. Nothing in the geometry
// distinguishes those, and only proximity defends against them, so any budget
// the turns did not want is spent halving the widest gaps.
import { haversineM, trackMeters, type Track } from './kml'
import { bearing, resample, turn } from './twist'

// Candidates are taken every 100 m and then chosen among. Finer than any
// spacing worth emitting, so the choice is not constrained by the sampling.
const CANDIDATE_SPACING_M = 100

// Two points closer together than this are pinning the same corner twice. At
// 150 m a router has no meaningful freedom between them anyway.
const MIN_SEPARATION_M = 150

// A point dropped at the apex of a turn, or at the junction itself, is the
// classic cause of a phantom U-turn — the device decides you meant to approach
// from the other side. Backing off onto the approach the router already agrees
// with gets the same constraint without the ambiguity.
const APPROACH_OFFSET_M = 120

export type ExpandOptions = {
  // Hard ceiling on points added. Google Maps takes 9 waypoints per link, so a
  // caller batching into links passes a small number; a GPX export has no cap
  // and can be generous.
  maxPoints: number
  // Never place two points closer than this.
  minSeparationM?: number
}

export type Expansion = {
  points: Track
  // What the caller can honestly claim afterwards: the longest stretch left
  // unpinned. On a 250-mile day with 9 points this is ~25 miles, which is not
  // a guarantee of anything and should not be presented as one.
  longestGapM: number
  // Total route length, so a caller can put the gap in proportion.
  totalM: number
}

// Heading change at each candidate, in degrees. The first and last carry zero:
// they are the route's own ends, already pinned by origin and destination.
function turnScores(pts: Track): number[] {
  const scores = new Array<number>(pts.length).fill(0)
  for (let i = 1; i < pts.length - 1; i++) {
    scores[i] = Math.abs(turn(bearing(pts[i - 1], pts[i]), bearing(pts[i], pts[i + 1])))
  }
  return scores
}

// Cumulative distance along a polyline, so separation and gap arithmetic is
// along the road rather than as the crow flies.
function cumulative(pts: Track): number[] {
  const out = [0]
  for (let i = 1; i < pts.length; i++) {
    out.push(out[i - 1] + haversineM(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]))
  }
  return out
}

// Walk back along the line from `index` by roughly APPROACH_OFFSET_M and return
// that position, so the shaping point sits on the approach rather than in the
// junction.
function approachPoint(pts: Track, dist: number[], index: number): [number, number] {
  const target = dist[index] - APPROACH_OFFSET_M
  if (target <= 0) return pts[index]
  let i = index
  while (i > 0 && dist[i] > target) i--
  return pts[i]
}

/**
 * Shaping points for one leg's geometry, sharpest turns first, thinned so no
 * two crowd each other and capped at what the consumer can carry.
 *
 * Returns points only — the caller decides whether they become `<rtept>`
 * shaping points in a GPX or plain waypoints in a Google Maps link, because
 * that distinction belongs to the format rather than to this.
 */
export function expandTrack(track: Track, opts: ExpandOptions): Expansion {
  const totalM = trackMeters(track)
  if (!track || track.length < 3 || opts.maxPoints <= 0) {
    return { points: [], longestGapM: totalM, totalM }
  }

  const candidates = resample(track, CANDIDATE_SPACING_M)
  if (candidates.length < 3) return { points: [], longestGapM: totalM, totalM }

  const dist = cumulative(candidates)
  const scores = turnScores(candidates)
  const minSep = opts.minSeparationM ?? MIN_SEPARATION_M

  // Coverage first, curvature second — and that order was decided by
  // measurement, not taste. Taking the sharpest turns first clusters the whole
  // budget in one canyon: on a real 185-mile ride at 190 dpm, sixty
  // sharpest-first points still left 38 miles with nothing pinning them,
  // because a hairpin section holds dozens of hard turns and the highway
  // holds none.
  //
  // Sharpness was the wrong proxy anyway. A hairpin is not a decision point —
  // on a canyon road there is one road and the router takes it. A gentle fork
  // on a highway is a decision point and scores near zero. Geometry cannot
  // tell those apart, so the honest objective is the one it can serve: leave
  // no stretch long enough for a router to have an opinion, and prefer a turn
  // when there happens to be one nearby.
  const totalLen = dist[dist.length - 1]
  const target = totalLen / (opts.maxPoints + 1)
  // How far a point may slide from its slot to land on a turn. A third keeps
  // slots from trading places, which would undo the even coverage.
  const window = target / 3

  const chosen: number[] = []
  for (let k = 1; k <= opts.maxPoints; k++) {
    const at = k * target
    let best = -1
    let bestScore = -1
    let fallback = -1
    let fallbackD = Infinity
    for (let i = 1; i < candidates.length - 1; i++) {
      const off = Math.abs(dist[i] - at)
      if (off > window) continue
      if (chosen.some((j) => Math.abs(dist[i] - dist[j]) < minSep)) continue
      if (scores[i] > bestScore) {
        bestScore = scores[i]
        best = i
      }
      if (off < fallbackD) {
        fallbackD = off
        fallback = i
      }
    }
    // A slot with no turn worth snapping to still gets its point: even spacing
    // is the thing being bought, and the turn is a bonus.
    const pick = bestScore > 0 ? best : fallback
    if (pick >= 0) chosen.push(pick)
  }

  chosen.sort((a, b) => a - b)

  // The honest number: the longest run of road with nothing pinning it, ends
  // included, because the gap from the start to the first shaping point is
  // just as unconstrained as one in the middle.
  const marks = [0, ...chosen.map((i) => dist[i]), totalM]
  let longestGapM = 0
  for (let i = 1; i < marks.length; i++) longestGapM = Math.max(longestGapM, marks[i] - marks[i - 1])

  return { points: chosen.map((i) => approachPoint(candidates, dist, i)), longestGapM, totalM }
}
