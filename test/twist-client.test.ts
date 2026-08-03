// The client port of the twistiness metric must agree with the server's.
//
// There are two implementations on purpose — the server computes at save time,
// the builder needs a live figure while the rider is still editing — and two
// copies of a numeric algorithm drift silently. This is the thing that stops
// that: identical inputs, identical outputs, to the integer.
//
// If this fails, the fix is to bring the two back into line, NOT to loosen the
// assertion. A tolerance here would defeat the entire point of the file.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { twistiness as serverTwistiness, twistLabel as serverLabel, TWIST_BANDS } from '../src/maps/twist'
import { distFromStartAlongTrack as serverDistFromStart } from '../src/maps/kml'
import type { Track } from '../src/maps/kml'

let C: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/twist.js', 'utf8'))(win)
  C = win.TBTwist
})

const R_EARTH = 6371000
const DEG_PER_M_LAT = 180 / (Math.PI * R_EARTH)

function arc(radiusM: number, sweepDeg: number, step = 20, lat = 37): Track {
  const out: Track = []
  const arcLen = radiusM * sweepDeg * (Math.PI / 180)
  const lonScale = 1 / Math.cos((lat * Math.PI) / 180)
  for (let d = 0; d <= arcLen; d += step) {
    const th = d / radiusM
    out.push([
      -120 + radiusM * Math.sin(th) * DEG_PER_M_LAT * lonScale,
      lat + radiusM * (1 - Math.cos(th)) * DEG_PER_M_LAT,
    ])
  }
  return out
}

function straight(meters: number, step = 20, lat = 37): Track {
  const out: Track = []
  const degPerM = DEG_PER_M_LAT / Math.cos((lat * Math.PI) / 180)
  for (let d = 0; d <= meters; d += step) out.push([-120 + d * degPerM, lat])
  return out
}

// Named so a failure says which shape disagreed rather than "fixture 3".
const FIXTURES: [string, Track][] = [
  ['a hairpin', arc(50, 180)],
  ['a tight corner', arc(100, 180)],
  ['a mountain curve', arc(200, 180)],
  ['a sweeper', arc(400, 180)],
  ['a gentle sweeper', arc(800, 180)],
  ['a motorway bend', arc(1500, 180)],
  ['a short straight', straight(5000)],
  ['a long straight', straight(200000)],
  ['a full circle', arc(300, 360)],
  ['switchbacks then slab', [...arc(80, 720, 10), ...straight(80000)]],
]

describe('the two implementations agree', () => {
  it.each(FIXTURES)('on %s', (_name, track) => {
    expect(C.twistiness(track)).toEqual(serverTwistiness(track))
  })

  it('on the degenerate cases, including which ones are null', () => {
    for (const t of [[], [[-120, 37]], [[-120, 37], [-119, 37]]] as Track[]) {
      expect(C.twistiness(t)).toEqual(serverTwistiness(t))
    }
  })

  it('on every label boundary', () => {
    for (const dpm of [0, 39, 40, 89, 90, 149, 150, 239, 240, 5000]) {
      expect(C.twistLabel(dpm)).toBe(serverLabel(dpm))
    }
    expect(C.twistLabel(null)).toBe(serverLabel(null))
  })

  it('on the constants themselves, so a tuned threshold cannot land on one side only', () => {
    // Read back out of the module rather than retyped here — a copy in this file
    // would just be a third place to drift.
    expect(C.BANDS).toEqual(TWIST_BANDS)
    expect(C.SPACING_M).toBe(25)
    expect(C.DEADBAND_DEG).toBe(1)
    expect(C.WINDOW_MI).toBe(20)
  })
})

describe('routeTwistiness', () => {
  // distanceM is optional because the client's cache signature reads it
  // (`l.distanceM || 0`), so the tests that exercise the cache have to be able
  // to set it. Untyped until now, which the tsconfig did not check.
  const route = (legs: { geometry: Track; distanceM?: number }[]) => ({ legs })

  it('concatenates legs before measuring, so a leg join is not a corner', () => {
    const whole = arc(200, 180)
    const half = Math.floor(whole.length / 2)
    const split = route([{ geometry: whole.slice(0, half) }, { geometry: whole.slice(half) }])
    expect(C.routeTwistiness(split)!.dpm).toBe(serverTwistiness(whole)!.dpm)
  })

  it('is null for a day with no legs at all', () => {
    expect(C.routeTwistiness(route([]))).toBeNull()
    expect(C.routeTwistiness(null)).toBeNull()
  })

  it('caches when nothing changed', () => {
    const r = route([{ geometry: arc(200, 180), distanceM: 100 }])
    const first = C.routeTwistiness(r)
    expect(C.routeTwistiness(r)).toBe(first) // same object, not merely equal
  })

  it('recomputes when the legs are mutated IN PLACE, which is what the builder does', () => {
    // The whole reason the cache is keyed on a signature and not on the legs
    // array's identity. `route.legs[i] = leg` when the router answers, and
    // `legs.splice()` on a delete, both leave the array object untouched — an
    // identity-keyed cache would serve the pre-reroute figure forever.
    const r: any = route([{ geometry: arc(600, 180), distanceM: 1000 }])
    const before = C.routeTwistiness(r).dpm
    r.legs[0] = { geometry: arc(80, 180), distanceM: 200 }
    const after = C.routeTwistiness(r).dpm
    expect(after).not.toBe(before)
    expect(after).toBe(serverTwistiness(arc(80, 180))!.dpm)
  })
})

describe('POI distances agree with the server', () => {
  const straightTrack = straight(20000, 50)
  // Three points sitting on the line at roughly 25%, 50% and 75% along.
  const at = (f: number) => {
    const p = straightTrack[Math.floor((straightTrack.length - 1) * f)]
    return { lng: p[0], lat: p[1] }
  }

  it('matches distFromStartAlongTrack exactly', () => {
    const pts = [at(0.25), at(0.5), at(0.75)]
    expect(C.distFromStartAlongTrack(straightTrack, pts)).toEqual(
      serverDistFromStart(straightTrack, pts),
    )
  })

  it('matches on a curved track, and off it', () => {
    const curve = arc(300, 270)
    // Deliberately off-route: nearest-vertex has to pick the same vertex in
    // both implementations or ordering could differ between builder and server.
    const off = curve.map((p) => ({ lng: p[0] + 0.01, lat: p[1] - 0.01 })).filter((_, i) => i % 40 === 0)
    expect(C.distFromStartAlongTrack(curve, off)).toEqual(serverDistFromStart(curve, off))
  })

  it('matches on an empty track', () => {
    const pts = [{ lng: -120, lat: 37 }]
    expect(C.distFromStartAlongTrack([], pts)).toEqual(serverDistFromStart([], pts))
  })

  it('orders POIs along the route, which is what the interleaved list needs', () => {
    const r: any = {
      legs: [{ geometry: straightTrack, distanceM: 20000 }],
      pois: [at(0.75), at(0.25), at(0.5)],
    }
    const d = C.routePoiDistances(r)
    expect(d[1]).toBeLessThan(d[2])
    expect(d[2]).toBeLessThan(d[0])
  })

  it('recomputes when a POI moves, which changes neither array length nor identity', () => {
    const r: any = {
      legs: [{ geometry: straightTrack, distanceM: 20000 }],
      pois: [at(0.25)],
    }
    const before = C.routePoiDistances(r)[0]
    r.pois[0] = at(0.9)
    expect(C.routePoiDistances(r)[0]).toBeGreaterThan(before)
  })
})
