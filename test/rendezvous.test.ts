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
  alongTrackM,
  clampDivert,
  DEFAULT_DIVERT_MI,
  divertMi,
  PLACE_NUDGE_MI,
  placeNudgeMi,
  proposeGroupMeet,
  proposeRendezvous,
  rankByRoad,
  worstDivertMi,
  type FuelCandidate,
  type GroupMeet,
  type GroupRoute,
  type RoadMeasure,
} from '../src/subgroups/rendezvous'
import type { Track } from '../src/maps/kml'
import { parseTerms } from '../src/places/ranking'

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
  // it are nearly the same ride — so pure divert-minimizing proposes a
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
// THE DIVERT BUDGET IS A RIDER-FACING NUMBER SINCE 2026-09-06, so it arrives
// over HTTP and has to be treated as hostile. Empty is the one that matters: a
// number box the rider cleared posts "", and Number("") is 0, which would refuse
// every candidate on the ride and read as the feature being broken.
describe('clampDivert', () => {
  it('leaves a sane number alone, from either a form or JSON', () => {
    expect(clampDivert(25)).toBe(25)
    expect(clampDivert('40')).toBe(40)
    expect(clampDivert(' 12 ')).toBe(12)
  })

  it('holds the floor and the ceiling', () => {
    expect(clampDivert(0)).toBe(1)
    expect(clampDivert(-500)).toBe(1)
    expect(clampDivert(9000)).toBe(200)
  })

  it('is undefined for anything unusable, so the caller keeps its own default', () => {
    expect(clampDivert('')).toBeUndefined()
    expect(clampDivert('   ')).toBeUndefined()
    expect(clampDivert(undefined)).toBeUndefined()
    expect(clampDivert(null)).toBeUndefined()
    expect(clampDivert('twenty')).toBeUndefined()
    expect(clampDivert(NaN)).toBeUndefined()
    expect(clampDivert({})).toBeUndefined()
  })

  // THIS TEST PASSED FOR A YEAR WHILE PINNING NOTHING. Its first fixture put the
  // joining group close enough to the road that no candidate ever reached the
  // cap, so a cap that was silently OFF gave the same answer as one at 25 — and
  // it WAS off: a plain spread carries an explicit `undefined` through, the cap
  // became NaN, and `worst > NaN` refused nobody. The group is far enough off
  // the road now that an uncapped answer differs, which is what a pin is.
  it('spreads as a no-op when it declines, leaving DEFAULTS in place', () => {
    // The shape the route actually builds. `{ maxDivertMi: undefined }` must not
    // override the proposer's own default.
    const straight = (a: [number, number], b: [number, number]): Track => {
      const out: Track = []
      for (let k = 0; k <= 120; k++) out.push([a[0] + ((b[0] - a[0]) * k) / 120, a[1] + ((b[1] - a[1]) * k) / 120])
      return out
    }
    const main: GroupRoute = { id: 'n', origin: [-122, 40], track: straight([-122, 40], [-117, 40]) }
    const join: GroupRoute = { id: 's', origin: [-122, 39], track: straight([-122, 39], [-117, 40]) }
    const declined = proposeGroupMeet(main, [join], [], { maxDivertMi: clampDivert('') })
    const plain = proposeGroupMeet(main, [join])
    const uncapped = proposeGroupMeet(main, [join], [], { maxDivertMi: 200 })
    expect(plain.length).toBeGreaterThan(0)
    expect(declined.map((m) => m.alongM)).toEqual(plain.map((m) => m.alongM))
    // The fixture is one where the cap decides, or the line above proves nothing.
    expect(uncapped[0].alongM).toBeLessThan(plain[0].alongM)
    for (const m of declined) expect(m.worstExtraM).toBeLessThanOrEqual(DEFAULT_DIVERT_MI * 1609.344)
  })

  // THE DIAL ACTUALLY MOVES THE ANSWER, which is the whole reason it got a
  // control: an earliest-acceptable rule lands NEAR its limit, so widening the
  // budget should bring the meeting point earlier along the main group's road.
  it('a wider budget buys an earlier meeting point', () => {
    const straight = (a: [number, number], b: [number, number]): Track => {
      const out: Track = []
      for (let k = 0; k <= 120; k++) out.push([a[0] + ((b[0] - a[0]) * k) / 120, a[1] + ((b[1] - a[1]) * k) / 120])
      return out
    }
    const main: GroupRoute = { id: 'n', origin: [-122, 40], track: straight([-122, 40], [-117, 40]) }
    // Well south of the road, so joining it early is expensive and joining it
    // late is cheap — the shape the budget is a dial on.
    const join: GroupRoute = { id: 's', origin: [-121, 39], track: straight([-121, 39], [-117, 40]) }
    const tight = proposeGroupMeet(main, [join], [], { maxDivertMi: clampDivert(10) })
    const wide = proposeGroupMeet(main, [join], [], { maxDivertMi: clampDivert(60) })
    expect(tight.length).toBeGreaterThan(0)
    expect(wide.length).toBeGreaterThan(0)
    expect(wide[0].alongM).toBeLessThan(tight[0].alongM)
  })
})

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

  // A MILE OUT OF THE WAY HAS TO BUY A MILE AND A HALF TOGETHER, and this is the
  // shape where it does: the southern group sits well off to one side of a
  // road heading away from them, so each mile earlier along it costs them about
  // half a mile of extra divert. The trade sends them earlier — up to the
  // allowance — rather than to where the roads happen to converge.
  it('meets earlier than the convergence when each mile earlier is cheap', () => {
    const out = proposeGroupMeet(north, [south])
    expect(out.length).toBeGreaterThan(0)
    // WEST of the fork at -119: the southern group pays a few miles to join
    // sooner rather than riding to where the roads happen to converge.
    expect(out[0].at[0]).toBeLessThan(-119.5)
    expect(worstDivertMi(out[0])).toBeLessThanOrEqual(DEFAULT_DIVERT_MI)
    // Ordered earliest-first, which is what makes the first row the one to take.
    for (let i = 1; i < out.length; i++) expect(out[i].alongM).toBeGreaterThan(out[i - 1].alongM)
  })

  // #370, AND THE SHAPE MOST FEEDERS HAVE. A group whose own road joins the main
  // one a short ride from where they start — epim's ride, San Francisco onto 580
  // at Castro Valley — was being sent a dozen miles BACK along the main road to
  // meet and a dozen forward again, because the earliest point under the cap
  // won and 25 miles of cap bought 12 miles of road. Behind the junction every
  // mile of road gained costs them about two miles of riding, so the trade keeps
  // them at the junction, and the allowance is set wide to prove it is the
  // ranking and not the cap that does.
  it('meets a group where its own road joins, not behind it', () => {
    const junction: [number, number] = [-119.8, 40]
    // Fourteen miles south of the road, joining it a little to the east.
    const feeder: GroupRoute = {
      id: 'f',
      origin: [-120, 39.8],
      track: [...leg([-120, 39.8], junction), ...leg(junction, DEST)],
    }
    const out = proposeGroupMeet(north, [feeder], [], { maxDivertMi: 25 })
    expect(out.length).toBeGreaterThan(0)
    // At the junction to within a sample, and on their own road, so it costs
    // them nothing.
    expect(out[0].at[0]).toBeCloseTo(junction[0], 1)
    expect(out[0].diverts.find((d) => d.id === 'f')?.onRoute).toBe(true)
    expect(worstDivertMi(out[0])).toBe(0)
    // The points behind it were offerable under the cap and lost on the trade:
    // rule the junction out with the shared-road floor and one of them wins.
    const behind = proposeGroupMeet(north, [feeder], [], { maxDivertMi: 25, minSharedFraction: 0.6 })
    expect(behind.length).toBeGreaterThan(0)
    expect(behind[0].alongM).toBeLessThan(out[0].alongM)
    expect(worstDivertMi(behind[0])).toBeGreaterThan(0)
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
      expect(m.diverts.find((d) => d.id === 'n')).toEqual({
        id: 'n',
        divertM: 0,
        extraM: 0,
        approachDeg: 0,
        onRoute: true,
      })
    }
  })

  // **A JOINING GROUP'S TRACK MUST NOT BE THE MAIN GROUP'S ROAD**, and this test
  // exists because the route handler handed it exactly that. `routeFor()` built a
  // group's track from its STRAND — its own routes plus every SHARED one — and a
  // shared route is precisely the road they have not ridden yet, the road they
  // are joining. So on a ride whose main route was tagged "everybody", each
  // satellite's track was the main road, every candidate fell within ON_ROUTE_M
  // of it, every divert came out at zero, and the earliest acceptable point won:
  // the start.
  //
  // Seen on stage, 2026-09-06, Oakland to Ensenada — both satellites offered gas
  // stations in Oakland, each labeled "on their way". The same shape worked when
  // the main route happened to be TAGGED rather than shared, because then it was
  // in nobody else's strand, which is what made it look like a data problem.
  it('does not treat the main group’s road as a joining group’s own', () => {
    const far: GroupRoute = { id: 'f', origin: [-121, 36], track: leg([-121, 36], DEST) }
    // What the handler should build: the joining group has no road of its own yet.
    const honest = proposeGroupMeet(north, [{ ...far, track: [] }])
    // What it used to build: their "track" is the main group's road.
    const asStrand = proposeGroupMeet(north, [{ ...far, track: north.track }])

    expect(honest.length).toBeGreaterThan(0)
    expect(asStrand.length).toBeGreaterThan(0)
    // Handed the main road, the group pays nothing anywhere and the earliest
    // point wins — which is the start.
    expect(worstDivertMi(asStrand[0])).toBe(0)
    expect(asStrand[0].alongM).toBeLessThan(honest[0].alongM)
    // Told the truth, they pay a real divert and meet somewhere sensible.
    expect(worstDivertMi(honest[0])).toBeGreaterThan(0)
  })

  // THE FAIRNESS TERM, AND IT IS THE ONE THAT MUST BE ON THE WORST GROUP. A
  // budget spent in TOTAL lets several groups' convenience be paid for by one,
  // which is the silent unfairness #67 asks the app not to commit on the
  // planner's behalf. Two groups on opposite sides of the road, each paying
  // about the same: the total runs past the allowance where neither does.
  it('caps the worst single group rather than the total', () => {
    const above: GroupRoute = { id: 'a', origin: [-121, 40.8], track: leg([-121, 40.8], DEST) }
    const below: GroupRoute = { id: 'b', origin: [-121, 39.2], track: leg([-121, 39.2], DEST) }
    const out = proposeGroupMeet(north, [above, below], [], { maxDivertMi: 25 })
    expect(out.length).toBeGreaterThan(0)
    const cap = 25 * 1609.344
    for (const m of out) expect(m.worstExtraM).toBeLessThanOrEqual(cap)
    // And at least one offered candidate would have been refused by a cap on
    // the total, which is what proves the cap is on the worst group.
    const extras = (m: (typeof out)[number]) => m.diverts.reduce((n, d) => n + d.extraM, 0)
    expect(out.some((m) => extras(m) > cap)).toBe(true)
  })

  // THE CAP IS MEASURED FROM EACH GROUP'S CHEAPEST MEET, NOT FROM ZERO. Ziad's
  // call, 2026-09-19 (#370). A group whose road never comes within the
  // allowance of the main group's used to be refused outright, which is a fact
  // about the two roads and not about the meet; now they are offered their
  // cheapest point and anything within the allowance of it.
  it('measures the allowance from the cheapest meet, so a distant group still gets one', () => {
    // Far to the south, so joining the northern road at all is a long haul.
    const far: GroupRoute = { id: 'f', origin: [-121, 36], track: leg([-121, 36], DEST) }
    const out = proposeGroupMeet(north, [far])
    expect(out.length).toBeGreaterThan(0)
    for (const m of out) {
      // More than the allowance out of their way in absolute terms…
      expect(worstDivertMi(m)).toBeGreaterThan(DEFAULT_DIVERT_MI)
      // …and within it of the least they could possibly pay.
      expect(m.worstExtraM).toBeLessThanOrEqual(DEFAULT_DIVERT_MI * 1609.344)
    }
    // The cheapest point itself is always offerable, at any allowance.
    const tight = proposeGroupMeet(north, [far], [], { maxDivertMi: 1 })
    expect(tight.length).toBeGreaterThan(0)
    expect(tight[0].worstExtraM).toBeLessThanOrEqual(1609.344)
  })

  // A MEETING POINT SHOULD BE A GAS STATION. Everyone arrives needing fuel and a
  // forecourt is somewhere you can actually wait, so a station on the road beats
  // the anonymous stretch of highway it snapped to.
  it('offers a station as itself, not as the road vertex beside it', () => {
    // A few hundred meters north of the main group's line, which is inside
    // ON_ROUTE_M, so it snaps to the road for ranking and keeps its own place.
    const station: FuelCandidate = {
      at: [-119.5, 40.004],
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
    // THE FORECOURT, not the highway: a rider sent to a station has to be
    // sent to the station.
    expect(fuel!.at).toEqual([-119.5, 40.004])
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

  // `fuelOnly` READS THE ROAD'S FLOOR, NOT THE STATIONS'. The cheapest meet is a
  // fact about the geometry, so a station well out of a group's way must not
  // pass the cap just because it is the only station — which is what a floor
  // taken over the offered candidates alone would let it do.
  it('holds a lone station to the same allowance as the road', () => {
    const far: GroupRoute = { id: 'f', origin: [-121, 36], track: leg([-121, 36], DEST) }
    // Near the start, where this group's divert is at its worst; their cheapest
    // meet is a couple of hundred miles further on.
    const early: FuelCandidate = { at: [-121.5, 40], roles: ['gas'], name: 'Early Shell' }
    expect(proposeGroupMeet(north, [far], [early], { fuelOnly: true })).toEqual([])
    // The same station is offered once the allowance covers the difference.
    expect(proposeGroupMeet(north, [far], [early], { fuelOnly: true, maxDivertMi: 200 }).length).toBe(1)
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
  // the second group's route ended at a coffee shop in their own town, and a
  // filter that dropped them for it made the whole ride answer "nowhere works".
  it('ignores where a joining group’s own route ends', () => {
    // Same origin as `south`, but its road wanders off to the south-east and
    // stops nowhere near the destination.
    const wandering: GroupRoute = { id: 'w', origin: [-122, 39], track: leg([-122, 39], [-119, 37]) }
    const out = proposeGroupMeet(north, [wandering])
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].diverts.map((d) => d.id)).toContain('w')
  })

  // What DOES refuse them is a backtrack, not distance: a group whose start is
  // nowhere near the main group's road is still offered its cheapest point on
  // it, because the allowance is measured from there. Refusing them for being
  // far away was the old absolute cap, and it answered "nowhere works" for a
  // fact about where they live.
  it('still offers a joining group whose start is far off the road its cheapest meet', () => {
    const distant: GroupRoute = { id: 'd', origin: [-121, 30], track: [[-121, 30]] }
    const out = proposeGroupMeet(north, [distant])
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].worstExtraM).toBeLessThanOrEqual(DEFAULT_DIVERT_MI * 1609.344)
  })

  it('leaves real road ahead of every meet it offers', () => {
    for (const m of proposeGroupMeet(north, [south])) {
      expect(m.sharedFraction).toBeGreaterThanOrEqual(0.2)
    }
  })

  // A JOINING group with one point and no legs is a route somebody started and has
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

// THE STRAIGHT LINE CANNOT SEE A BAY. #370's repro: a group leaving San
// Francisco to join a ride running up 680 from San Jose to 580. On paper the
// dogleg to a station in Fremont is short because the line crosses the water;
// by road it is 880 south and 680 north again. The re-rank uses the roads the
// route has already fetched, and the order the rider sees is that one.
describe('rankByRoad', () => {
  const mi = 1609.344
  const trunkTotalM = 150 * mi
  const meet = (alongMi: number, extraMi: number, name: string, isFuel = true): GroupMeet => ({
    at: [-122 + alongMi / 60, 40],
    alongM: alongMi * mi,
    diverts: [
      { id: 'n', divertM: 0, extraM: 0, approachDeg: 0, onRoute: true },
      { id: 'sf', divertM: extraMi * mi, extraM: extraMi * mi, approachDeg: 30, onRoute: false },
    ],
    worstDivertM: extraMi * mi,
    worstExtraM: extraMi * mi,
    totalDivertM: extraMi * mi,
    sharedFraction: 1 - alongMi / 150,
    isFuel,
    name,
    score: alongMi + 1.5 * extraMi - 2,
  })
  // Fremont looks cheap on paper (9.6) and is 40 road miles from SF; the two
  // Livermore stations sit past the 580/680 junction, about 45 and 50 road
  // miles from SF, on the road SF would take anyway.
  const fremont = meet(45, 9.6, 'Shell Fremont')
  const rubyHills = meet(65, 3.9, 'Ruby Hills Chevron')
  const lasPositas = meet(72, 2.4, 'Shell Las Positas')
  // JOINING GROUPS ONLY in the map, as the route builds it: the main group
  // rides the whole trunk whatever is chosen, so it has no road to a candidate
  // and no extra to measure.
  const roads = (m: GroupMeet, sfMi: number): RoadMeasure => ({ meet: m, toMeetM: new Map([['sf', sfMi * mi]]) })

  it('demotes a station the straight line liked once the road says otherwise', () => {
    // Straight-line order, as the shortlist arrives.
    const out = rankByRoad([roads(fremont, 40), roads(rubyHills, 45), roads(lasPositas, 50)], trunkTotalM, 25)
    // Ruby Hills first on the trade — seven miles earlier for two — and
    // Fremont's seventeen still beats Las Positas's further seven along.
    expect(out.map((m) => m.name)).toEqual(['Ruby Hills Chevron', 'Shell Fremont', 'Shell Las Positas'])
    // And the number beside the group is the road extra over their cheapest,
    // which here is Las Positas at 50 + (150 − 72) = 128: Ruby Hills costs two
    // more, Fremont 40 + (150 − 45) − 128 = 17.
    const sf = (m: GroupMeet) => Math.round(m.diverts.find((d) => d.id === 'sf')!.extraM / mi)
    expect(sf(out[0])).toBe(2)
    expect(sf(out[1])).toBe(17)
    expect(sf(out[2])).toBe(0)
  })

  it('applies the allowance to the road extra, and never refuses the cheapest', () => {
    const out = rankByRoad([roads(fremont, 40), roads(rubyHills, 45), roads(lasPositas, 50)], trunkTotalM, 10)
    expect(out.map((m) => m.name)).toEqual(['Ruby Hills Chevron', 'Shell Las Positas'])
    // At one mile only the cheapest survives — whichever it is, there is one.
    expect(rankByRoad([roads(fremont, 40), roads(rubyHills, 45)], trunkTotalM, 1)).toHaveLength(1)
  })

  it('sends a candidate nobody measured to the back, in the order it came', () => {
    const unmeasured: RoadMeasure = { meet: meet(30, 20, 'Guess'), toMeetM: new Map([['sf', null]]) }
    const out = rankByRoad([unmeasured, roads(fremont, 40), roads(rubyHills, 45)], trunkTotalM, 25)
    expect(out.map((m) => m.name)).toEqual(['Ruby Hills Chevron', 'Shell Fremont', 'Guess'])
    // Untouched: its straight-line numbers are what it still carries.
    expect(out[2].diverts[1].extraM).toBe(20 * mi)
  })

  it('still meets earlier when the road says each mile earlier is cheap', () => {
    // Ride 34's shape in road miles: Santa Cruz is 90 road miles from Los
    // Banos and 200 from the cheapest point near the end of the ride, and
    // Los Banos is 150 trunk miles earlier. Extra = 90 + 150 − 200 = 40 for a
    // gain of 150, which the trade takes at any weight under 3.75.
    const losBanos = meet(50, 25, 'Los Banos')
    const nearEnd = meet(200, 2.4, 'Near the end')
    const out = rankByRoad([roads(losBanos, 90), roads(nearEnd, 200)], 250 * mi, 60)
    expect(out[0].name).toBe('Los Banos')
  })

  it('measures a group’s road to a point on its own track without a request', () => {
    const track: Track = [
      [-122, 40],
      [-121.5, 40],
      [-121, 40],
    ]
    // Roughly 85 km per degree at 40°N, so the middle vertex is about 43 km in.
    expect(alongTrackM(track, [-121.5, 40.001])).toBeGreaterThan(40_000)
    expect(alongTrackM(track, [-121.5, 40.001])).toBeLessThan(46_000)
    expect(alongTrackM(track, [-122, 40])).toBe(0)
  })
})

// THE RIDER'S PLACE LISTS REACH THE PROPOSAL AS A NUDGE, NEVER A FILTER.
// Ziad's call, 2026-09-19, reversing the 2026-09-07 rule that they must not
// reach it at all — having been handed a Costco as the meeting point with
// Costco Gas on his avoid list and a Shell four miles on.
describe('the avoid and favor lists', () => {
  const mi = 1609.344
  const trunkTotalM = 150 * mi
  const station = (alongMi: number, name: string): GroupMeet => ({
    at: [-122 + alongMi / 60, 40],
    alongM: alongMi * mi,
    diverts: [
      { id: 'n', divertM: 0, extraM: 0, approachDeg: 0, onRoute: true },
      { id: 'sf', divertM: 0, extraM: 0, approachDeg: 0, onRoute: true },
    ],
    worstDivertM: 0,
    worstExtraM: 0,
    totalDivertM: 0,
    sharedFraction: 1 - alongMi / 150,
    isFuel: true,
    name,
    score: 0,
  })
  const onRoad = (m: GroupMeet, sfMi: number): RoadMeasure => ({ meet: m, toMeetM: new Map([['sf', sfMi * mi]]) })
  const lists = { favor: parseTerms('Shell'), avoid: parseTerms('Costco gas, ARCO') }

  it('nudges a named candidate by a few miles of score, favor winning a tie', () => {
    expect(placeNudgeMi('Costco Gas Station', lists.favor, lists.avoid)).toBe(PLACE_NUDGE_MI)
    expect(placeNudgeMi('Shell', lists.favor, lists.avoid)).toBe(-PLACE_NUDGE_MI)
    expect(placeNudgeMi('Shell at the Costco', lists.favor, lists.avoid)).toBe(-PLACE_NUDGE_MI)
    expect(placeNudgeMi('Chevron', lists.favor, lists.avoid)).toBe(0)
    expect(placeNudgeMi(undefined, lists.favor, lists.avoid)).toBe(0)
  })

  it('puts a Costco at the junction behind the station six miles on', () => {
    const costco = station(56, 'Costco Gas Station')
    const chevron = station(62, 'Chevron')
    // Without the lists, earlier wins.
    expect(rankByRoad([onRoad(costco, 45), onRoad(chevron, 51)], trunkTotalM, 10)[0].name).toBe('Costco Gas Station')
    // With them, the avoided station loses six miles of road but not twelve.
    expect(rankByRoad([onRoad(costco, 45), onRoad(chevron, 51)], trunkTotalM, 10, lists)[0].name).toBe('Chevron')
    const farChevron = station(70, 'Chevron')
    expect(rankByRoad([onRoad(costco, 45), onRoad(farChevron, 59)], trunkTotalM, 10, lists)[0].name).toBe(
      'Costco Gas Station',
    )
  })

  it('still offers a lone avoided station, because a nudge is not a filter', () => {
    const costco = station(56, 'Costco Gas Station')
    expect(rankByRoad([onRoad(costco, 45)], trunkTotalM, 10, lists).map((m) => m.name)).toEqual(['Costco Gas Station'])
  })

  it('applies the same nudge in the straight-line shortlist', () => {
    const leg = (a: [number, number], b: [number, number]): Track => {
      const out: Track = []
      for (let k = 0; k <= 120; k++) out.push([a[0] + ((b[0] - a[0]) * k) / 120, a[1] + ((b[1] - a[1]) * k) / 120])
      return out
    }
    const DEST: [number, number] = [-117, 40]
    const north: GroupRoute = { id: 'n', origin: [-122, 40], track: leg([-122, 40], DEST) }
    const south: GroupRoute = {
      id: 's',
      origin: [-122, 39],
      track: [...leg([-122, 39], [-119, 40]), ...leg([-119, 40], DEST)],
    }
    // Two stations on the shared road, the avoided one a little earlier. On
    // vertices of BOTH tracks (the main road samples every 5/120 of a degree,
    // the joining one every 2/120), or ON_ROUTE_M drops them as off the road.
    const costco: FuelCandidate = { at: [-122 + (5 * 74) / 120, 40.002], roles: ['gas'], name: 'Costco Gas Station' }
    const shell: FuelCandidate = { at: [-122 + (5 * 76) / 120, 40.002], roles: ['gas'], name: 'Shell' }
    const plain = proposeGroupMeet(north, [south], [costco, shell], { fuelOnly: true })
    const nudged = proposeGroupMeet(north, [south], [costco, shell], { fuelOnly: true, ...lists })
    expect(plain[0].name).toBe('Costco Gas Station')
    expect(nudged[0].name).toBe('Shell')
    // Both are still offered either way.
    expect(nudged.map((m) => m.name).sort()).toEqual(['Costco Gas Station', 'Shell'])
  })
})
