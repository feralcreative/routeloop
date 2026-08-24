// Cutting an imported track into the legs a builder can edit.
//
// The load-bearing assertion is the first one: concatenating the split legs has
// to give back the original track, element for element. Everything downstream —
// the map line, all four track-based export formats, twistiness — reads that
// concatenation, so as long as it is identical none of them can notice the split
// happened. If that test fails, nothing else here matters.
//
// BOTH KINDS ARE PLACED as of 2026-08-24. A POI is part of the route, so it takes
// a leg boundary like any other point and the split returns ONE ordered list.
import { describe, expect, it } from 'vitest'
import { concatSplitLegs, relegDay, splitDayTrack } from '../src/maps/track-split'
import { trackMeters, type ExtractedPoint, type Track } from '../src/maps/kml'

// A track heading north along a meridian, one point every ~111 m.
const line = (n: number, lng = -122): Track =>
  Array.from({ length: n }, (_, i) => [lng, Number((37 + i * 0.001).toFixed(6))] as [number, number])

const stop = (lng: number, lat: number, name = 'x'): ExtractedPoint => ({
  lat,
  lng,
  name,
  description: null,
  roles: [],
})

const poi = (lng: number, lat: number, name = 'p'): ExtractedPoint => ({ ...stop(lng, lat, name), kind: 'poi' })

// A stop sitting exactly on track vertex i.
const at = (track: Track, i: number, name = `s${i}`) => stop(track[i][0], track[i][1], name)

describe('the concatenation is the original track', () => {
  it('reproduces it element for element', () => {
    const track = line(50)
    const out = splitDayTrack(track, [at(track, 0), at(track, 17), at(track, 31), at(track, 49)])
    expect(out.legs).toHaveLength(3)
    expect(concatSplitLegs(out.legs)).toEqual(track)
  })

  it('holds when the ends had to be invented', () => {
    const track = line(40)
    const out = splitDayTrack(track, [at(track, 12), at(track, 27)])
    expect(out.synthesizedStart).toBe(true)
    expect(out.synthesizedEnd).toBe(true)
    // The head and tail are the part a naive split drops on the floor.
    expect(concatSplitLegs(out.legs)).toEqual(track)
  })

  it('holds with no points at all, which is most GPX files', () => {
    const track = line(30)
    const out = splitDayTrack(track, [])
    expect(out.points).toHaveLength(2)
    expect(out.legs).toHaveLength(1)
    expect(concatSplitLegs(out.legs)).toEqual(track)
  })

  it('holds on the shortest track that can be split', () => {
    const track = line(2)
    const out = splitDayTrack(track, [])
    expect(out.legs).toHaveLength(1)
    expect(out.legs[0].geometry).toHaveLength(2)
    expect(concatSplitLegs(out.legs)).toEqual(track)
  })
})

describe('legs', () => {
  it('shares the joint vertex between consecutive legs', () => {
    // The invariant route-shape.js depends on: leg k ends where leg k+1 starts.
    const track = line(20)
    const { legs } = splitDayTrack(track, [at(track, 0), at(track, 9), at(track, 19)])
    expect(legs[0].geometry[legs[0].geometry.length - 1]).toEqual(legs[1].geometry[0])
  })

  it('never emits a leg with fewer than two vertices', () => {
    // legSchema.geometry requires min(2); a 1-vertex leg fails the whole ride.
    const track = line(12)
    const crowded = [at(track, 0), at(track, 5), at(track, 5), at(track, 5), at(track, 11)]
    const { legs } = splitDayTrack(track, crowded)
    for (const leg of legs) expect(leg.geometry.length).toBeGreaterThanOrEqual(2)
    expect(concatSplitLegs(legs)).toEqual(track)
  })

  it('sums to the whole track within rounding', () => {
    const track = line(60)
    const { legs } = splitDayTrack(track, [at(track, 0), at(track, 20), at(track, 40), at(track, 59)])
    const summed = legs.reduce((n, l) => n + l.distanceM, 0)
    // One rounding per leg, and the joints are shared so nothing is counted
    // twice.
    expect(Math.abs(summed - trackMeters(track))).toBeLessThan(legs.length)
  })

  it('produces exactly points - 1 legs, which is what daySchema demands', () => {
    const track = line(40)
    for (const n of [0, 1, 2, 5, 9]) {
      const pts = Array.from({ length: n }, (_, i) => at(track, 1 + i * 3))
      const out = splitDayTrack(track, pts)
      expect(out.legs).toHaveLength(out.points.length - 1)
    }
  })

  it('counts a POI as a boundary, so it splits the leg it sits on', () => {
    const track = line(30)
    const withoutPoi = splitDayTrack(track, [at(track, 0), at(track, 29)])
    const withPoi = splitDayTrack(track, [at(track, 0), poi(-122, 37.015, 'viewpoint'), at(track, 29)])
    expect(withoutPoi.legs).toHaveLength(1)
    expect(withPoi.legs).toHaveLength(2)
    // And the road is the same road either way — only where it is cut changed.
    expect(concatSplitLegs(withPoi.legs)).toEqual(concatSplitLegs(withoutPoi.legs))
  })
})

describe('point ordering', () => {
  it('sorts along the track, not by document order', () => {
    // GPX writes waypoints at document level with nothing tying them to a
    // track, so their order is whatever the exporting tool felt like.
    const track = line(30)
    // Anchored at both ends so nothing is synthesized and the list is purely
    // the reordering.
    const out = splitDayTrack(track, [at(track, 29, 'third'), at(track, 0, 'first'), at(track, 10, 'second')])
    expect(out.points.map((s) => s.name)).toEqual(['first', 'second', 'third'])
    expect(out.synthesizedStart).toBe(false)
    expect(out.synthesizedEnd).toBe(false)
  })

  // POIs used to be passed through untouched and appended after the stops, which
  // put a viewpoint from the middle of the day at the end of the list. Placing
  // them along the track is what keeps the list's order the road's order.
  it('places POIs in the one ordered list, along the track like any other point', () => {
    const track = line(30)
    const out = splitDayTrack(track, [at(track, 29, 'end'), poi(-122, 37.015, 'viewpoint'), at(track, 0, 'start')])
    expect(out.points.map((s) => s.name)).toEqual(['start', 'viewpoint', 'end'])
    expect(out.points.map((s) => s.kind)).toEqual([undefined, 'poi', undefined])
  })

  // A file of nothing but POIs would otherwise leave the day with no stop at all,
  // which daySchema refuses — the same rule the builder applies to a day's first
  // point, applied at the import.
  it('promotes the first point when a file names no stop at all', () => {
    const track = line(30)
    const out = splitDayTrack(track, [poi(track[0][0], track[0][1], 'a'), poi(track[29][0], track[29][1], 'b')])
    expect(out.points[0].kind).toBe('stop')
    expect(out.points[1].kind).toBe('poi')
  })
})

describe('endpoints', () => {
  it('does not invent a stop when one already sits at the end', () => {
    const track = line(25)
    const out = splitDayTrack(track, [at(track, 0), at(track, 24)])
    expect(out.synthesizedStart).toBe(false)
    expect(out.synthesizedEnd).toBe(false)
    expect(out.points).toHaveLength(2)
  })

  it('tolerates a stop near the end rather than doubling it up', () => {
    // The real case: a route file's first waypoint is a street address and the
    // track starts at the curb, tens of meters apart. Two pins on top of each
    // other, one of them invented, is worse than none.
    const track = line(25)
    const nearStart = stop(-122, 37.0003, 'Home') // ~33 m off vertex 0
    const out = splitDayTrack(track, [nearStart, at(track, 24)])
    expect(out.synthesizedStart).toBe(false)
    expect(out.points[0].name).toBe('Home')
    expect(concatSplitLegs(out.legs)).toEqual(track)
  })

  it('invents one when the nearest stop is genuinely far from the end', () => {
    const track = line(60)
    const out = splitDayTrack(track, [at(track, 30), at(track, 59)])
    expect(out.synthesizedStart).toBe(true)
    expect(out.synthesizedEnd).toBe(false)
    expect(out.points[0].name).toBe('Start')
  })

  it('gives a single point a partner so there is a leg at all', () => {
    const track = line(20)
    const out = splitDayTrack(track, [at(track, 0, 'Only')])
    expect(out.points.map((s) => s.name)).toEqual(['Only', 'Finish'])
    expect(out.legs).toHaveLength(1)
  })
})

describe('degenerate input', () => {
  it('keeps the points and makes no legs when there is no track', () => {
    // A CSV import: a list of points with no line. Inventing geometry here would
    // report a distance no motorcycle can ride.
    const out = splitDayTrack([], [stop(-122, 37), stop(-121, 38)])
    expect(out.legs).toEqual([])
    expect(out.points).toHaveLength(2)
    expect(out.synthesizedStart).toBe(false)
  })

  it('treats a one-vertex track as no track', () => {
    const out = splitDayTrack(line(1), [stop(-122, 37)])
    expect(out.legs).toEqual([])
    expect(out.points).toHaveLength(1)
  })

  // This used to DEMOTE the overflow to POIs, which worked because a POI consumed
  // no vertex. They consume one now, so the cap moved into the leg: a pair landing
  // on the same vertex gets a zero-length [v, v] leg, which is two coordinates and
  // satisfies legSchema. Nothing is dropped and nothing is reclassified.
  it('keeps every point when the track is too short to give each its own vertex', () => {
    // Pathological — a four-vertex track with six named points — but rejected at
    // upload and silently truncated are both worse than a leg of zero meters.
    const track = line(4)
    const many = Array.from({ length: 6 }, (_, i) => at(track, Math.min(i, 3), `s${i}`))
    const out = splitDayTrack(track, many)
    expect(out.points).toHaveLength(6)
    expect(out.legs).toHaveLength(5)
    for (const leg of out.legs) expect(leg.geometry.length).toBeGreaterThanOrEqual(2)
    expect(concatSplitLegs(out.legs)).toEqual(track)
  })

  it('survives a track carrying duplicate vertices', () => {
    // Imported tracks carry repeats mid-leg; STATUS.md records one fixture with
    // 33 of them inside a single leg.
    const base = line(20)
    const dupes: Track = [...base.slice(0, 10), base[9], base[9], ...base.slice(10)]
    const out = splitDayTrack(dupes, [at(dupes, 0), at(dupes, 15)])
    // The reader's dedup means the concatenation matches the deduped original,
    // which is what every consumer actually sees.
    expect(concatSplitLegs(out.legs)).toEqual(concatSplitLegs([{ geometry: dupes }]))
  })
})

// The restore path for a native file written before 2026-08-24, when a day
// carried stops - 1 legs. The points are all there and already in the rider's
// order; what the file lacks is a leg per pair.
describe('re-cutting a day whose order is already right', () => {
  it('keeps the rider order rather than re-deriving it', () => {
    const track = line(30)
    // Deliberately NOT in along-track order: a v4 POI's place in the list was the
    // rider's own choice, so sorting would rearrange a day they had arranged.
    const pts = [at(track, 0), at(track, 20), at(track, 10), at(track, 29)]
    const legs = relegDay(track, pts)
    expect(legs).toHaveLength(3)
    // Vertex 10 sits behind vertex 20, so its boundary is clamped forward to 20
    // and the leg into it is zero meters rather than a reversed slice.
    expect(legs[1].distanceM).toBe(0)
    expect(concatSplitLegs(legs)).toEqual(track)
  })

  it('forces both ends onto the track, so nothing recorded is dropped', () => {
    const track = line(40)
    // Neither end named: a naive cut between vertices 12 and 27 would throw the
    // head and the tail on the floor.
    const legs = relegDay(track, [at(track, 12), at(track, 27)])
    expect(concatSplitLegs(legs)).toEqual(track)
  })

  it('gives one leg per pair, whatever the kinds are', () => {
    const track = line(30)
    const pts = [at(track, 0), poi(-122, 37.01, 'v'), at(track, 15), at(track, 29)]
    expect(relegDay(track, pts)).toHaveLength(3)
  })

  it('has nothing to do with fewer than two points, or with no track', () => {
    const track = line(20)
    expect(relegDay(track, [at(track, 0)])).toEqual([])
    expect(relegDay([], [stop(-122, 37), stop(-121, 38)])).toEqual([])
    expect(relegDay(line(1), [stop(-122, 37), stop(-121, 38)])).toEqual([])
  })
})
