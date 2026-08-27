// Proposing a meeting point.
//
// Built on a synthetic trunk running due east along a line of latitude, because
// the properties under test are geometric and a real route's wiggle would make
// every expectation a magic number nobody could check by eye. A degree of
// longitude at 40°N is about 85 km, which is what the distances below are in
// terms of.
//
// The three cases that matter are the ones that REFUSE: a group coming at the
// trunk from in front of it backtracks, a group too far off it diverts, and a
// trunk running away from everybody has no answer at all. A proposer that
// always returns something is worse than one that sometimes says no.
import { describe, expect, it } from 'vitest'
import { divertMi, proposeRendezvous, type FuelCandidate } from '../src/subgroups/rendezvous'
import type { Track } from '../src/maps/kml'

/** Due east along 40°N, one vertex every 0.05° — roughly every 4.3 km. */
const eastward = (fromLng: number, toLng: number, lat = 40): Track => {
  const out: Track = []
  for (let lng = fromLng; lng <= toLng + 1e-9; lng += 0.05) out.push([Math.round(lng * 1e6) / 1e6, lat])
  return out
}

// About 425 km of trunk, from -122 to -117.
const TRUNK = eastward(-122, -117)

const fuel = (lng: number, lat = 40): FuelCandidate => ({ at: [lng, lat], roles: ['gas'] })

describe('proposeRendezvous', () => {
  it('offers points on the trunk, ordered, never its own endpoints', () => {
    // Due south of the middle of the trunk and a little way off it.
    const out = proposeRendezvous(TRUNK, [-120, 39.6])
    expect(out.length).toBeGreaterThan(0)
    for (const r of out) {
      expect(r.alongM).toBeGreaterThan(0)
      expect(r.alongM).toBeLessThan(430_000)
      expect(r.at[1]).toBe(40)
    }
    expect([...out].sort((a, b) => a.score - b.score)).toEqual(out)
  })

  // The joining group is going where the trunk is going either way. What the
  // meet costs them is the difference from riding straight there — measured
  // against zero, the trunk's own start would win every time, which is not a
  // meeting point, it is the whole ride.
  it('measures the divert against going direct to the destination', () => {
    const out = proposeRendezvous(TRUNK, [-120, 39.6])
    // Sitting just south of the trunk, joining it costs almost nothing.
    expect(divertMi(out[0])).toBeLessThan(15)
    expect(out[0].divertM).toBeGreaterThanOrEqual(0)
  })

  it('prefers joining at a shallow angle over arriving perpendicular', () => {
    // Well to the south-west, so the shallowest approach is a point further
    // east rather than the nearest one due north.
    const out = proposeRendezvous(TRUNK, [-121.8, 39.0])
    expect(out[0].approachDeg).toBeLessThan(90)
  })

  // #67's thumb on the scale: a fuel stop is where a group wants to regather
  // anyway, and preferring one costs nothing.
  it('prefers an existing gas stop over a bare vertex nearby', () => {
    const plain = proposeRendezvous(TRUNK, [-120, 39.6])
    const withFuel = proposeRendezvous(TRUNK, [-120, 39.6], [fuel(plain[0].at[0])])
    expect(withFuel[0].isFuel).toBe(true)
    expect(withFuel[0].score).toBeLessThan(plain[0].score)
  })

  it('ignores a stop that is not a gas stop', () => {
    const out = proposeRendezvous(TRUNK, [-120, 39.6], [{ at: [-120, 40], roles: ['food', 'hotel'] }])
    expect(out.some((r) => r.isFuel)).toBe(false)
  })

  // --- the refusals ---------------------------------------------------------

  it('refuses a backtrack: a group arriving at the trunk from in front of it', () => {
    // Far to the EAST of the trunk's end, so every candidate would mean riding
    // west past the meeting point and turning around.
    expect(proposeRendezvous(TRUNK, [-115, 40])).toEqual([])
  })

  it('refuses a divert bigger than the allowance', () => {
    // Tightening the allowance rather than hunting for a geometry that happens
    // to fail: the same origin, offerable at 25 miles and not at 2, which is
    // what proves the refusal is this constraint and not something else. The
    // cheapest candidate here costs about 1.9 miles, which is why the tight
    // bound is 1 rather than a rounder number.
    const origin: [number, number] = [-121.8, 39.0]
    expect(proposeRendezvous(TRUNK, origin, [], { maxDivertMi: 25 }).length).toBeGreaterThan(0)
    expect(proposeRendezvous(TRUNK, origin, [], { maxDivertMi: 1 })).toEqual([])
  })

  // THE CASE A FAILING TEST FOUND, and the reason minSharedFraction exists. A
  // group far off the trunk gets its smallest divert by meeting a few miles
  // short of the destination — going direct and going to a point just short of
  // it are nearly the same ride — so pure divert-minimising proposes a
  // rendezvous where the two groups ride together for twenty minutes.
  it('refuses a meet so late that nobody rides together', () => {
    const late = proposeRendezvous(TRUNK, [-120, 33])
    expect(late).toEqual([])
    // Lowering the floor is what lets it through, which is what proves the
    // refusal was this constraint and not the divert one.
    const allowed = proposeRendezvous(TRUNK, [-120, 33], [], { minSharedFraction: 0.01 })
    expect(allowed.length).toBeGreaterThan(0)
    expect(allowed[0].sharedFraction).toBeLessThan(0.2)
  })

  it('leaves real road ahead of every meet it does offer', () => {
    for (const r of proposeRendezvous(TRUNK, [-120, 39.6])) {
      expect(r.sharedFraction).toBeGreaterThanOrEqual(0.2)
    }
  })

  it('returns nothing rather than the least bad thing', () => {
    // Stated as its own case because "always return something" is the tempting
    // shape and it is wrong: two origins on opposite sides of a trunk running
    // away from both has no sensible answer, and offering one is worse than
    // saying so.
    expect(proposeRendezvous(TRUNK, [-115, 40], [fuel(-119)])).toEqual([])
  })

  // --- degenerate input -----------------------------------------------------

  it('has nothing to say about a trunk of fewer than three vertices', () => {
    expect(
      proposeRendezvous(
        [
          [-122, 40],
          [-121, 40],
        ],
        [-121.5, 39.5],
      ),
    ).toEqual([])
    expect(proposeRendezvous([], [-121.5, 39.5])).toEqual([])
  })

  it('has nothing to say about a zero-length trunk', () => {
    expect(
      proposeRendezvous(
        [
          [-122, 40],
          [-122, 40],
          [-122, 40],
        ],
        [-121.5, 39.5],
      ),
    ).toEqual([])
  })
})

describe('near-duplicates', () => {
  it('spreads its answers out rather than offering five points in one place', () => {
    const out = proposeRendezvous(TRUNK, [-120, 39.6], [], {}, 3)
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(Math.abs(out[i].alongM - out[j].alongM)).toBeGreaterThanOrEqual(10_000)
      }
    }
  })

  it('honors the limit', () => {
    expect(proposeRendezvous(TRUNK, [-120, 39.6], [], {}, 1)).toHaveLength(1)
  })
})
