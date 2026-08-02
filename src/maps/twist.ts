// How twisty a day's riding is, as one number derived from the route's shape.
//
// This replaces "time stopped" in the builder's totals line. It exists because
// the thing a rider actually wants to know about a road — is it any good — was
// nowhere in the panel, while a figure nobody asked for was.
//
// It is NOT a turn count. A turn count would have to come from the router's
// per-step maneuvers, which means a bigger Routes API field mask (the mask is
// what Google prices the call on) and would still be blank for every imported
// ride, since GPX and KML rides never touch the router. This needs geometry
// alone, so it works everywhere.
//
// It is also NOT sinuosity (path length over straight-line distance). That was
// measured against the dev corpus and rejected: it tells you whether a ride
// loops back near where it started, not whether the road bends. One day scored
// 34.15 sinuosity at 113°/mi while the twistiest day in the set scored 1.76 at
// 214°/mi.
import { haversineM, METERS_PER_MILE, type Track } from './kml'

// Resample spacing. Google's polyline vertex density is deliberately uneven —
// dense through curves, sparse on straights — so summing raw vertex-to-vertex
// bearing changes would count a curvy stretch twice: once for being curvy, and
// again for having more vertices to be curvy at.
//
// 25m, and the upper bound is the binding one: at 100m a chord across a 50m
// hairpin is wider than the corner, so the resampled path cuts the corner off
// and a switchback scores ZERO. Verified against synthetic arcs — 100m spacing
// reports 0°/mi for a continuous R=50m arc.
const SPACING_M = 25

// Bearing changes below this are treated as straight, suppressing polyline
// wobble on a road that is not actually bending.
//
// This was originally 5°, chosen because it gave the widest spread between the
// twistiest and flattest day in the dev corpus. That was the wrong test, and it
// hid a serious bug: the deadband is a magnitude threshold, so at 25m spacing it
// silently discards every curve gentler than
//
//     R = SPACING_M * 57.3 / DEADBAND_DEG
//
// which at 5° is 286m. Every sweeper — precisely the roads this metric exists to
// find — scored zero. A continuous 400m-radius arc, which geometry says must
// score 231°/mi, came out as 0.
//
// 1° puts that ceiling at 1432m, and synthetic arcs confirm the metric now
// tracks true curvature from R=800m down to R=50m. It is safely above the noise
// floor: geometry is stored at 6 decimal places (~0.11m), which over a 25m chord
// is 0.25° of jitter, and a synthetic straight line scores 0.0 at this setting.
// The cost is that the flattest desert day in the corpus rises from 10 to 16°/mi
// — real gentle interstate bends, correctly counted rather than discarded.
const DEADBAND_DEG = 1

// The window for "the best stretch of the day". Per-day averaging buries a good
// road: 40 great miles and 200 of slab reads "mostly straight", which is true
// and useless.
//
// 20 miles, and it has to be this long. At 5 miles — the obvious choice, and the
// one this was first written with — the window does not find the best road, it
// finds the nearest TOWN. Street corners are far denser than any road bend, so
// on the dev corpus every single day scored between 122 and 1010, desert
// interstates included, and the number discriminated nothing. Capping the
// per-sample contribution barely dented it, which is what ruled out "one bad
// U-turn" as the explanation.
//
// At 20 miles a town is diluted back to its real weight and the figure separates
// properly: the desert days fall to 35-63 while genuinely twisty ones hold
// 300-493. 40 miles over-smooths, and is longer than some whole days.
const WINDOW_MI = 20

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

// The labels, ordered high to low because the lookup takes the first match.
//
// Calibrated against the 19 distinct route-days in the dev database at the
// settings above, whose distribution is min 16, p25 53, median 83, p75 143,
// p90 190, max 252. For scale, a road that is *continuously* 400m-radius
// sweepers scores 226 and one at 200m scores 442, so a whole day at 250 means
// its good sections are a good deal tighter than that — a day always dilutes
// itself with transit.
//
// Those are machine-generated rides between real California towns, not rides
// anyone chose for being good, so real trips will skew twistier and these will
// want moving up. One table, one place to change.
export const TWIST_BANDS: { min: number; label: string }[] = [
  { min: 240, label: 'Very twisty' },
  { min: 150, label: 'Twisty' },
  { min: 90, label: 'Some curves' },
  { min: 40, label: 'Mostly straight' },
  { min: 0, label: 'Straight' },
]

export function twistLabel(dpm: number | null | undefined): string | null {
  if (dpm == null) return null
  return TWIST_BANDS.find((b) => dpm >= b.min)?.label ?? null
}

export type Twistiness = {
  /** Degrees of heading change per mile across the whole day. */
  dpm: number
  /** The same figure over the twistiest WINDOW_MI-mile stretch of it. */
  bestDpm: number
  /** How long that stretch actually was — shorter than the window on a short day. */
  bestMiles: number
}

function bearing(a: [number, number], b: [number, number]): number {
  const la1 = a[1] * RAD
  const la2 = b[1] * RAD
  const dLng = (b[0] - a[0]) * RAD
  const y = Math.sin(dLng) * Math.cos(la2)
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng)
  return (Math.atan2(y, x) * DEG + 360) % 360
}

/** Shortest signed difference between two bearings, -180..180. */
const turn = (from: number, to: number): number => ((to - from + 540) % 360) - 180

/** Walk the polyline emitting a point every `spacing` metres. */
function resample(track: Track, spacing: number): Track {
  const out: Track = [track[0]]
  let carry = 0
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1]
    const b = track[i]
    const seg = haversineM(a[1], a[0], b[1], b[0])
    if (seg === 0) continue
    let t = spacing - carry
    while (t <= seg) {
      const f = t / seg
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
      t += spacing
    }
    carry = (carry + seg) % spacing
  }
  return out
}

/**
 * Null for a track too short to say anything about — an empty ride, or one so
 * brief that a single corner would dominate. Null is deliberately different
 * from zero here: zero claims the road is straight, null admits we do not know.
 */
export function twistiness(track: Track): Twistiness | null {
  if (!track || track.length < 3) return null

  const s = resample(track, SPACING_M)
  if (s.length < 3) return null

  // Heading change contributed at each sample, in degrees, deadband applied.
  const changes = new Array<number>(s.length - 2)
  let total = 0
  for (let i = 2; i < s.length; i++) {
    const d = Math.abs(turn(bearing(s[i - 2], s[i - 1]), bearing(s[i - 1], s[i])))
    const kept = d >= DEADBAND_DEG ? d : 0
    changes[i - 2] = kept
    total += kept
  }

  // Sample spacing is uniform by construction, so distance is just a count —
  // no need to re-measure the resampled path.
  const miles = ((s.length - 1) * SPACING_M) / METERS_PER_MILE
  if (miles <= 0) return null

  // Best window: a fixed number of samples, so a plain sliding sum. Falls back
  // to the whole day when the day is shorter than the window.
  const windowSamples = Math.max(1, Math.round((WINDOW_MI * METERS_PER_MILE) / SPACING_M))
  let bestSum = 0
  let bestSpan = changes.length
  if (changes.length <= windowSamples) {
    bestSum = total
  } else {
    let running = 0
    for (let i = 0; i < changes.length; i++) {
      running += changes[i]
      if (i >= windowSamples) running -= changes[i - windowSamples]
      if (i >= windowSamples - 1 && running > bestSum) bestSum = running
    }
    bestSpan = windowSamples
  }
  const bestMiles = (bestSpan * SPACING_M) / METERS_PER_MILE

  return {
    dpm: Math.round(total / miles),
    bestDpm: bestMiles > 0 ? Math.round(bestSum / bestMiles) : 0,
    bestMiles: Math.round(bestMiles * 10) / 10,
  }
}
