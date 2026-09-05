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
import {
  divertMi,
  proposeGroupMeet,
  proposeRendezvous,
  worstDivertMi,
  type FuelCandidate,
  type GroupRoute,
} from '../src/subgroups/rendezvous'
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

  // #239, AND THE REASON EVERY TEST ABOVE MISSED IT. The trunk they run on is a
  // straight line of latitude, so its road length and its straight-line length
  // are the same number and the two ways of measuring the remainder cannot be
  // told apart. Real roads bend. The divert used to add the remainder ALONG THE
  // TRUNK to a straight-line direct, so every curve after the candidate was
  // billed to the joining group as a detour they had chosen — on a trunk of
  // ordinary sinuosity that is tens of miles against a 25-mile budget, and the
  // whole route gets refused.
  const zigzag = (fromLng: number, toLng: number, lat = 40, amp = 0.35): Track => {
    const out: Track = []
    let i = 0
    for (let lng = fromLng; lng <= toLng + 1e-9; lng += 0.05, i++) {
      out.push([Math.round(lng * 1e6) / 1e6, lat + (i % 2 === 0 ? amp : -amp)])
    }
    return out
  }

  it('does not bill the trunk’s own bends to the joining group', () => {
    const bent = zigzag(-122, -117)
    // The same origin as the straight case: a little south of the trunk, a
    // third of the way along. Joining here is nearly free either way — the
    // group is going east regardless — and it is the ROAD that wanders, not
    // them.
    const out = proposeRendezvous(bent, [-120.5, 39.5])
    expect(out.length).toBeGreaterThan(0)
    expect(divertMi(out[0])).toBeLessThan(15)
  })

  it('never reports a negative divert, on any trunk', () => {
    // The dogleg cost of going via a point instead of straight past it, which
    // the triangle inequality puts at or above zero. A mixed-metric formula has
    // no such floor and can hand a rider a meeting point that saves them miles.
    for (const trunk of [TRUNK, zigzag(-122, -117)]) {
      for (const origin of [
        [-120, 39.6],
        [-121.8, 39.0],
        [-119, 40.2],
      ] as [number, number][]) {
        for (const r of proposeRendezvous(trunk, origin)) {
          expect(r.divertM).toBeGreaterThanOrEqual(0)
        }
      }
    }
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

// Meeting the MAIN group on their own road — the question a planner actually
// has. Everyone is going to the same place from different places, the main
// group's route is the ride, and the others join it.
//
// THE GEOMETRY IS A Y. The main group sets off from the west at 40°N and rides
// due east to the destination. A second group starts at 39°N and its road bends
// up to join that line at the fork, which is the point most of these are about.
describe('proposeGroupMeet', () => {
  /** Straight line between two points, one vertex every ~1 km, end included. */
  const leg = (a: [number, number], b: [number, number]): Track => {
    const out: Track = []
    const steps = 120
    for (let k = 0; k <= steps; k++) out.push([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps])
    return out
  }

  const DEST: [number, number] = [-117, 40]
  const FORK: [number, number] = [-119, 40]

  const north: GroupRoute = { id: 'n', origin: [-122, 40], track: leg([-122, 40], DEST) }
  const south: GroupRoute = {
    id: 's',
    origin: [-122, 39],
    // West to the fork by way of a bend, then the shared road east.
    track: [...leg([-122, 39], FORK), ...leg(FORK, DEST)],
  }

  // THE EARLIEST ACCEPTABLE POINT, NOT THE CHEAPEST — the point of a group ride
  // is to ride as a group, so what is minimized is the distance covered apart.
  // The divert is a limit on what that may cost somebody, not the goal.
  it('proposes the earliest meeting point everybody can still reach', () => {
    const out = proposeGroupMeet(north, [south])
    expect(out.length).toBeGreaterThan(0)
    // WEST of the fork at -119: the southern group pays a few miles to join
    // sooner rather than riding to where the roads happen to converge.
    expect(out[0].at[0]).toBeLessThan(-119.5)
    expect(worstDivertMi(out[0])).toBeLessThanOrEqual(25)
    // Ordered earliest-first, which is what makes the first row the one to take.
    for (let i = 1; i < out.length; i++) expect(out[i].alongM).toBeGreaterThan(out[i - 1].alongM)
  })

  // AND THE CONVERGENCE IS STILL FOUND when nothing earlier is affordable —
  // which is the case the scoring used to reach by default. Tightening the
  // allowance is what proves the fork is chosen on its merits rather than
  // because it happened to be cheapest.
  it('falls back to where the roads already converge, at no cost to anybody', () => {
    const out = proposeGroupMeet(north, [south], [], { maxDivertMi: 0.5 })
    expect(out.length).toBeGreaterThan(0)
    // The fork, give or take the sampler's 2 km step.
    expect(out[0].at[0]).toBeGreaterThan(-119.2)
    expect(out[0].at[0]).toBeLessThan(-118.6)
    expect(worstDivertMi(out[0])).toBe(0)
    // Both groups ride through it, which is what makes it free. A convergence
    // detector was not needed to find this — it falls out of the scoring.
    expect(out[0].diverts.every((d) => d.onRoute)).toBe(true)
  })

  // THE MAIN GROUP CAN NEVER BE THE ONE JOINING, which the signature enforces
  // rather than the body: they are two arguments, so there is no list a feeder's
  // road could win from. Asserted through the behavior anyway — every candidate
  // lies on the main group's own track, and they never pay a divert.
  it('only ever proposes points on the main group’s road', () => {
    const out = proposeGroupMeet(north, [south])
    expect(out.length).toBeGreaterThan(0)
    for (const m of out) {
      expect(m.alongM).toBeGreaterThan(0)
      // Due east at 40°N is the main group's line, and nothing else is on it.
      expect(m.at[1]).toBeCloseTo(40, 6)
      expect(m.diverts.find((d) => d.id === 'n')).toEqual({ id: 'n', divertM: 0, approachDeg: 0, onRoute: true })
    }
  })

  // THE FAIRNESS TERM, AND IT IS THE ONE THAT MUST BE ON THE WORST GROUP. A
  // budget spent in TOTAL lets several groups' convenience be paid for by one,
  // which is the silent unfairness #67 asks the app not to commit on the
  // planner's behalf.
  it('caps the worst single group rather than the total', () => {
    // Far to the south, so joining the northern road at all is a long haul.
    const far: GroupRoute = { id: 'f', origin: [-121, 36], track: leg([-121, 36], DEST) }
    for (const m of proposeGroupMeet(north, [far])) {
      expect(worstDivertMi(m)).toBeLessThanOrEqual(25)
    }
    // Tightening the allowance is what proves the refusal is this constraint:
    // the same pair, offerable at 25 miles and not at 1.
    expect(proposeGroupMeet(north, [far], [], { maxDivertMi: 1 })).toEqual([])
  })

  // A MEETING POINT SHOULD BE A GAS STATION. Everyone arrives needing fuel and a
  // forecourt is somewhere you can actually wait, so a station on the road beats
  // the anonymous stretch of highway it snapped to.
  it('offers a station as itself, not as the road vertex beside it', () => {
    // A few hundred metres north of the main group's line, which is inside
    // ON_ROUTE_M, so it snaps to the road for ranking and keeps its own place.
    const station: FuelCandidate = {
      at: [-120.5, 40.004],
      roles: ['gas'],
      name: 'Shell',
      address: '1 Main St, Somewhere, CA 90000',
    }
    // `fuelOnly`, which is how the route asks: the ranking prefers the earliest
    // viable point, so without it a station further along the road is crowded
    // out by plain vertices and "no station here" is reported for a road that
    // has one.
    const out = proposeGroupMeet(north, [south], [station], { fuelOnly: true })
    const fuel = out.find((m) => m.isFuel)
    expect(fuel).toBeTruthy()
    // Nothing BUT stations under that flag.
    expect(out.every((m) => m.isFuel)).toBe(true)
    // THE FORECOURT, not the carriageway: a rider sent to a station has to be
    // sent to the station.
    expect(fuel!.at).toEqual([-120.5, 40.004])
    expect(fuel!.name).toBe('Shell')
    expect(fuel!.address).toBe('1 Main St, Somewhere, CA 90000')
    // Ranked by distance along the ROAD, which comes from the snapped vertex.
    expect(fuel!.alongM).toBeGreaterThan(0)
  })

  it('ignores a station that is not on the main group’s road', () => {
    // Two degrees of latitude off the line is not a detour, it is a different
    // county — dropped by ON_ROUTE_M rather than offered and ranked last.
    const far: FuelCandidate = { at: [-120.5, 42], roles: ['gas'], name: 'Far Shell' }
    expect(proposeGroupMeet(north, [south], [far], { fuelOnly: true })).toEqual([])
  })

  it('has no question to answer when nobody is joining', () => {
    expect(proposeGroupMeet(north, [])).toEqual([])
  })

  // The main group's road IS the road. With no route on it there is nowhere to
  // put a meeting point, however well planned the joining groups are — the
  // caller says so in its own words rather than reporting "nowhere works".
  it('has nothing to offer when the main group has not planned a route', () => {
    const bare: GroupRoute = { id: 'n', origin: [-122, 40], track: [[-122, 40]] }
    expect(proposeGroupMeet(bare, [south])).toEqual([])
  })

  // A JOINING GROUP CONTRIBUTES A STARTING POINT AND NOTHING ELSE, so where its
  // own track happens to end is not consulted. That is usually the last place
  // they have got round to planning — on the ride this was first tried against,
  // the second group's day ended at a coffee shop in their own town, and a
  // filter that dropped them for it made the whole ride answer "nowhere works".
  it('ignores where a joining group’s own route ends', () => {
    // Same origin as `south`, but its road wanders off to the south-east and
    // stops nowhere near the destination.
    const wandering: GroupRoute = { id: 'w', origin: [-122, 39], track: leg([-122, 39], [-119, 37]) }
    const out = proposeGroupMeet(north, [wandering])
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].diverts.map((d) => d.id)).toContain('w')
  })

  // What DOES refuse them is the ordinary cap, with a number behind it: a group
  // whose start is genuinely nowhere near the main group's road cannot be given
  // a meeting point on it at any price.
  it('refuses a joining group whose start is too far off the road', () => {
    const distant: GroupRoute = { id: 'd', origin: [-121, 30], track: [[-121, 30]] }
    expect(proposeGroupMeet(north, [distant])).toEqual([])
  })

  it('leaves real road ahead of every meet it offers', () => {
    for (const m of proposeGroupMeet(north, [south])) {
      expect(m.sharedFraction).toBeGreaterThanOrEqual(0.2)
    }
  })

  // A JOINING group with one point and no legs is a day somebody started and has
  // not planned. It has an origin, so it is still somebody who has to get there
  // and is still scored — dropping it would propose a meeting point the other
  // groups love and this one cannot reach.
  it('still counts an unrouted joining group’s divert', () => {
    const bare: GroupRoute = { id: 'b', origin: [-121, 38], track: [[-121, 38]] }
    const out = proposeGroupMeet(north, [south, bare])
    expect(out.length).toBeGreaterThan(0)
    for (const m of out) expect(m.diverts.map((d) => d.id)).toContain('b')
    // And it moves the answer: the third group is south-east of the fork, so the
    // meet the other two would have had to themselves is pulled along the main
    // group's road toward somewhere all three can reach.
    const pair = proposeGroupMeet(north, [south])
    expect(out[0].at[0]).toBeGreaterThan(pair[0].at[0])
  })
})
