// The rule for how long a leg took, on the server.
//
// THIS IS DELIBERATELY NOT THE WHOLE TIME MODEL. `public/js/ride-time.js` holds
// the schedule walk — what is active at a moment, when a day ends, how dwell
// interleaves with riding — and that stays client-only for the reason its own
// header gives: the builder and the viewer both need it live, against legs held
// in memory, with no round trip. Nothing on the server has ever needed to answer
// "where is the rider at 2:15pm".
//
// What the server does need is the one rule underneath it: **a leg with distance
// but no duration never came back from the router, so its time is estimated from
// distance.** The dashboard's saddle-time figure is a sum over every leg a rider
// owns, and without this rule it would report the builder's rides and silently
// count every imported one as zero.
//
// MIRRORED, NOT SHARED, and `test/ride-time-server.test.ts` is what holds the two
// copies together — the same arrangement as twist.ts/twist.js, duration.ts/
// duration.js and filename.ts/filename.js. If that test fails, bring the two back
// into line rather than loosening the assertion.
//
// WHY THE ESTIMATE IS DERIVED RATHER THAN STORED, which is the client file's
// reasoning and holds here for the same reason: a flag would have to be written
// by every path that creates a leg and would be wrong the moment one forgot. A
// leg that has distance and no duration is self-describing, so a reloaded ride
// reports the same figures as the session that built it.

/**
 * Fallback riding speed for a leg the router never answered for, in meters per
 * second. 20 m/s is about 45 mph, matching what the demo seeder assumes.
 *
 * ROUGH TWICE OVER, and both are why anything derived from it is labeled an
 * estimate rather than presented as a duration: the speed is a guess, and it is
 * applied to a stored distance that on an imported ride is a haversine sum
 * rather than a road length, so it is shorter than the road actually is.
 *
 * Must equal NOMINAL_SPEED_MS in public/js/ride-time.js.
 */
export const NOMINAL_SPEED_MS = 20

/** A leg that has a distance but no duration: the router never answered for it. */
export const legIsEstimated = (leg: { durationS: number; distanceM: number }): boolean =>
  leg.durationS <= 0 && leg.distanceM > 0

/**
 * How long a leg took, estimating from distance when nothing measured it.
 *
 * Note what this returns for a leg with neither: zero. That is correct and not a
 * gap — a zero-length leg took no time, and the two points it joins are in the
 * same place. `splitDayTrack` produces those deliberately when two points share a
 * position.
 */
export const legDurationS = (leg: { durationS: number; distanceM: number }): number =>
  legIsEstimated(leg) ? Math.round(leg.distanceM / NOMINAL_SPEED_MS) : leg.durationS
