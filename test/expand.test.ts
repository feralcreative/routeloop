// Expand places shaping points where a router could plausibly wander. Turns
// first, because a junction taken left is one a router could take straight
// through. Then whatever budget is left goes into breaking up the longest
// unpinned runs, because curvature cannot see the other way a route diverges:
// a parallel road that looks just as straight.
import { describe, expect, it } from 'vitest'
import { expandTrack } from '../src/maps/expand'
import { haversineM, trackMeters, type Track } from '../src/maps/kml'

// Roughly meters-to-degrees at 37°N, good enough to build fixtures with.
const M_LAT = 1 / 111_320
const M_LNG = 1 / (111_320 * Math.cos(37 * (Math.PI / 180)))

// A straight run east, `n` points `stepM` apart.
function straight(n: number, stepM = 100, lat = 37, lng0 = -122): Track {
  return Array.from({ length: n }, (_, i) => [lng0 + i * stepM * M_LNG, lat] as [number, number])
}

// Straight east, then a right-angle turn north, then straight again.
function elbow(armM = 3000, stepM = 100): Track {
  const out: Track = []
  const corner = -122 + armM * M_LNG
  for (let d = 0; d <= armM; d += stepM) out.push([-122 + d * M_LNG, 37])
  for (let d = stepM; d <= armM; d += stepM) out.push([corner, 37 + d * M_LAT])
  return out
}

// Alternating east/north arms, so corners recur along the whole length.
function zigzagTrack(corners: number, armM = 800): Track {
  const out: Track = [[-122, 37]]
  let [lng, lat] = [-122, 37]
  for (let c = 0; c < corners; c++) {
    for (let d = 100; d <= armM; d += 100) {
      if (c % 2 === 0) out.push([lng + d * M_LNG, lat])
      else out.push([lng, lat + d * M_LAT])
    }
    const last = out[out.length - 1]
    lng = last[0]
    lat = last[1]
  }
  return out
}

const nearest = (t: Track, p: [number, number]) =>
  Math.min(...t.map((q) => haversineM(p[1], p[0], q[1], q[0])))

describe('where the points go', () => {
  it('falls back to even spacing on a road with no corners', () => {
    // There is no turn to prefer, so the budget goes into halving the longest
    // runs — which lands close to evenly spaced.
    const t = straight(120) // 12 km
    const { points, totalM } = expandTrack(t, { maxPoints: 7 })
    expect(points.length).toBeGreaterThan(0)
    const along = points.map((p) => haversineM(37, -122, p[1], p[0])).sort((a, b) => a - b)
    const gaps = along.map((d, i) => (i === 0 ? d : d - along[i - 1]))
    const spread = Math.max(...gaps) / Math.min(...gaps)
    // Within a factor of three of each other, rather than clustered.
    expect(spread).toBeLessThan(3)
    expect(Math.max(...along)).toBeLessThan(totalM)
  })

  it('pins the corner of an elbow', () => {
    const t = elbow()
    const { points } = expandTrack(t, { maxPoints: 9 })
    expect(points.length).toBeGreaterThan(0)
    // Every point sits on the route, not somewhere invented. Compared against
    // the nearest stored vertex rather than the line itself, and candidates are
    // interpolated every 100 m, so a point genuinely on the line can still be
    // tens of meters from the closest vertex.
    for (const p of points) expect(nearest(t, p)).toBeLessThan(60)
  })

  it('puts the point on the approach, not in the junction', () => {
    // A point at the apex is the classic cause of a phantom U-turn.
    const armM = 3000
    const t = elbow(armM)
    const corner = t.find((p) => p[1] === 37 && Math.abs(p[0] - (-122 + armM * M_LNG)) < 1e-9)!
    const { points } = expandTrack(t, { maxPoints: 1 })
    expect(points).toHaveLength(1)
    const off = haversineM(points[0][1], points[0][0], corner[1], corner[0])
    expect(off).toBeGreaterThan(50)
    expect(off).toBeLessThan(300)
  })

  it('prefers a turn inside its slot, but does not chase one outside it', () => {
    // Coverage is what is being bought and the turn is a bonus. A point will
    // slide within its own slot to land on a corner; it will not abandon the
    // slot to reach a sharper corner elsewhere, because that is what clustered
    // sixty points into one canyon and left 38 miles unpinned on a real ride.
    const t: Track = []
    for (let d = 0; d <= 1800; d += 100) t.push([-122 + d * M_LNG, 37])
    const cornerAt: [number, number] = t[t.length - 1]
    for (let d = 100; d <= 2200; d += 100) t.push([cornerAt[0], 37 + d * M_LAT]) // corner near the middle
    const { points } = expandTrack(t, { maxPoints: 1 })
    expect(points).toHaveLength(1)
    // The only corner sits near the midpoint, so the single slot snaps to it.
    expect(haversineM(points[0][1], points[0][0], cornerAt[1], cornerAt[0])).toBeLessThan(400)
  })

  it('spaces points so no stretch is left long', () => {
    // The property that actually defends a route: measured on a real 185-mile
    // ride, sharpest-first left 87 miles unpinned at a 9-point budget and this
    // leaves 27.7.
    const t = zigzagTrack(24)
    for (const cap of [4, 9, 20]) {
      const e = expandTrack(t, { maxPoints: cap })
      const even = e.totalM / (cap + 1)
      // Within twice the ideal even spacing, allowing for the separation floor
      // and for slots sliding onto turns.
      expect(e.longestGapM).toBeLessThan(even * 2)
    }
  })
})

describe('the budget', () => {
  const zigzag = zigzagTrack

  it('never exceeds what the consumer can carry', () => {
    for (const cap of [1, 3, 9, 20]) {
      expect(expandTrack(zigzag(30), { maxPoints: cap }).points.length).toBeLessThanOrEqual(cap)
    }
  })

  it('returns nothing when there is no budget', () => {
    expect(expandTrack(elbow(), { maxPoints: 0 }).points).toEqual([])
  })

  it('does not pin the same corner twice', () => {
    const { points } = expandTrack(zigzag(30), { maxPoints: 20, minSeparationM: 500 })
    for (let i = 1; i < points.length; i++) {
      const d = haversineM(points[i - 1][1], points[i - 1][0], points[i][1], points[i][0])
      // Straight-line rather than along-road, so allow slack for a hairpin
      // whose two ends are close as the crow flies.
      expect(d).toBeGreaterThan(100)
    }
  })

  it('keeps the points in route order', () => {
    const t = zigzag(20)
    const { points } = expandTrack(t, { maxPoints: 9 })
    const along = points.map((p) => t.findIndex((q) => q[0] === p[0] && q[1] === p[1]))
    expect(along).toEqual([...along].sort((a, b) => a - b))
  })
})

describe('what it admits to', () => {
  it('reports the longest unpinned stretch, ends included', () => {
    const t = elbow(3000)
    const r = expandTrack(t, { maxPoints: 1 })
    // One point near the corner leaves roughly one arm unpinned at each end.
    expect(r.longestGapM).toBeGreaterThan(2000)
    expect(r.longestGapM).toBeLessThanOrEqual(r.totalM)
  })

  it('shrinks the gap as the budget grows', () => {
    // An elbow has one corner, so everything past the first point comes from
    // gap-filling — which is exactly the case worth asserting: a road that
    // mostly goes straight should still get pinned down when there is budget
    // for it, because a router can take a parallel road that looks just as
    // straight.
    const t = elbow(3000)
    const one = expandTrack(t, { maxPoints: 1, minSeparationM: 150 })
    const many = expandTrack(t, { maxPoints: 12, minSeparationM: 150 })
    expect(many.points.length).toBeGreaterThan(one.points.length)
    expect(many.longestGapM).toBeLessThan(one.longestGapM)
  })

  it('spends leftover budget on the longest runs, not on nothing', () => {
    const t = straight(120) // 12 km, no corners at all
    const none = expandTrack(t, { maxPoints: 0 })
    const some = expandTrack(t, { maxPoints: 8 })
    expect(none.points).toHaveLength(0)
    expect(some.points.length).toBeGreaterThan(0)
    expect(some.longestGapM).toBeLessThan(none.longestGapM / 2)
  })

  it('reports the whole road as the gap when nothing was added', () => {
    const t = straight(60)
    const r = expandTrack(t, { maxPoints: 0 })
    // Saying so is the point: claiming a road is pinned when it is not is the
    // lie this feature exists to avoid.
    expect(r.longestGapM).toBeCloseTo(trackMeters(t), 0)
  })

  it('handles a track too short to say anything about', () => {
    expect(expandTrack([], { maxPoints: 9 }).points).toEqual([])
    expect(expandTrack([[-122, 37]], { maxPoints: 9 }).points).toEqual([])
    expect(
      expandTrack(
        [
          [-122, 37],
          [-121.99, 37],
        ],
        { maxPoints: 9 },
      ).points,
    ).toEqual([])
  })
})
