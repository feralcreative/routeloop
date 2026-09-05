// How far into the day each point is, and how far since the last refuel.
//
// #220, in the planner's own words: "to know when to add fuel stops I need to
// know how many miles since the start, and how many since the last fuel stop."
//
// **COMPUTED FROM THE LEGS IN MEMORY, NEVER READ FROM `dist_from_start_m`.**
// That column is the same prefix sum and is the right answer everywhere else —
// exports, the roadbook, the hand-off — but it is written on SAVE, and the
// builder is the one surface that has to be right while a rider is still
// dragging stops around. It is null on every unsaved point (`builder.js` sets it
// so explicitly), so a reader that trusted it would show blanks on exactly the
// day being planned.
//
// METERS THROUGHOUT, and nothing here formats. Miles or kilometers is the
// rider's preference and belongs to units.js at the point of display; a module
// that returned miles would have to be told the preference and would bake one
// rounding into a number three surfaces round differently. Same split the rest
// of this app already makes — `route_legs.distance_m` is meters and
// `rides.total_miles` is a cache.
(function (window) {
  "use strict";

  var pointsOf = function (day) {
    return (day && day.points) || [];
  };
  var legsOf = function (day) {
    return (day && day.legs) || [];
  };

  // A leg with no distance contributes nothing rather than breaking the sum. An
  // unrouted leg is the normal state mid-edit: a stop dropped on the map has no
  // leg until the router answers, and the row it lands in still has to render.
  function legMeters(leg) {
    var m = leg && leg.distanceM;
    return typeof m === "number" && isFinite(m) && m > 0 ? m : 0;
  }

  /**
   * Meters from the start of the day to each point, in order.
   *
   * `legs[i]` joins `points[i]` to `points[i+1]`, so point 0 is always 0 and
   * point i is the sum of the legs before it. BOTH KINDS COUNT — a POI is on the
   * route and anchors a leg, so skipping them would under-report every distance
   * after the first one.
   *
   * Always the same length as `day.points`, so a caller can index it with a row
   * index without checking. A day with more points than legs — which is every
   * complete day, and also a half-routed one — simply stops accumulating.
   */
  function cumulativeM(day) {
    var points = pointsOf(day);
    var legs = legsOf(day);
    var out = [];
    var run = 0;
    for (var i = 0; i < points.length; i++) {
      out.push(run);
      run += legMeters(legs[i]);
    }
    return out;
  }

  /** The whole day, which is the last point's distance. Zero for an empty day
   *  rather than null: a day with no points is zero miles long, and nothing
   *  measured it wrongly. */
  function totalM(day) {
    var c = cumulativeM(day);
    return c.length ? c[c.length - 1] : 0;
  }

  /** A point that puts fuel back in the tank.
   *
   *  GAS AND CHARGE ARE THE SAME EVENT seen from two kinds of bike, which is why
   *  the caller passes which one counts rather than this guessing. `fuel_type` on
   *  the bike is 'gas' | 'electric' and the roles mirror it exactly — an electric
   *  rider passing a Chevron has not refuelled anything. */
  function isRefuel(point, fuelRole) {
    var roles = (point && point.roles) || [];
    return roles.indexOf(fuelRole) >= 0;
  }

  /**
   * Meters since the last refuelling stop at or before each point.
   *
   * **THE STOP ITSELF RESETS TO ZERO, and that is the useful reading.** Standing
   * at the pump you have gone no distance on this tank; the question the rider is
   * asking is how far the NEXT one is, and a row that said 180 at the fuel stop
   * would be answering the previous leg's question in the next leg's row.
   *
   * Before the first refuel it counts from the start of the day, because that is
   * where the tank was last full — near enough. It is not: a rider joining day 3
   * on whatever they had left is not starting full, and this module cannot know
   * that. Stated rather than modelled, because the alternative is asking every
   * rider what is in their tank at the start of every day.
   */
  function sinceRefuelM(day, fuelRole) {
    var points = pointsOf(day);
    var cum = cumulativeM(day);
    var out = [];
    var lastRefuelAt = 0;
    for (var i = 0; i < points.length; i++) {
      if (isRefuel(points[i], fuelRole)) lastRefuelAt = cum[i];
      out.push(cum[i] - lastRefuelAt);
    }
    return out;
  }

  /**
   * The first point the day runs dry at, or null.
   *
   * NULL WHEN NO RANGE IS KNOWN, NEVER A GUESS. A range nobody has measured is
   * `bikes.usable_range_m = null`, and a fuel warning built on an invented
   * number is worse than no warning because it looks like one — the same
   * argument null twistiness makes. Callers must render nothing, not "0 miles".
   *
   * It reports the FIRST breach only. A day that overshoots at point 4 is
   * already wrong there, and every later point inherits the error — flagging all
   * of them turns one problem into a column of red.
   */
  function firstDryPoint(day, fuelRole, rangeM) {
    if (rangeM == null || !(rangeM > 0)) return null;
    var since = sinceRefuelM(day, fuelRole);
    for (var i = 0; i < since.length; i++) {
      if (since[i] > rangeM) return i;
    }
    return null;
  }

  /**
   * Where a point measured at `m` meters into the day belongs in its list.
   *
   * `legs[i]` joins `points[i]` to `points[i+1]`, so a distance falling inside
   * leg i puts the new point between those two — index i+1. Past the end of the
   * day it appends, which is the honest answer rather than a clamp: a meeting
   * point beyond the last leg IS after the last point.
   *
   * It returns the GEOMETRIC answer and applies no floor. "Never before a
   * group's starting point" is a rule about what a meeting point means, not
   * about where a distance falls, and it lives with the caller that knows it.
   *
   * An unrouted leg measures zero — see legMeters — so a half-routed day lands
   * the point at the first leg the router has not answered for yet. That is the
   * same wrong-in-the-safe-direction the rest of this module takes: too early in
   * the list is a drag, too late is a road that doubles back.
   */
  function insertIndexAtM(day, m) {
    var points = pointsOf(day);
    if (points.length === 0) return 0;
    var cum = cumulativeM(day);
    for (var i = 1; i < cum.length; i++) {
      if (m < cum[i]) return i;
    }
    return points.length;
  }

  /**
   * Which day of a strand a distance falls on, and where in that day's list.
   *
   * A STRAND IS THE CALLER'S TO ASSEMBLE — this takes the days already filtered
   * and ordered, the same list the server measured `alongM` along, because the
   * two have to agree about what a group rides and there is exactly one
   * definition of that (strandOf, mirrored client-side by the same filter).
   *
   * Returns `{ index, at }`, where `index` addresses the array it was PASSED
   * rather than `state.days` — the caller did the filtering and is the one that
   * can map back. Null for an empty strand, which is a real state: a group with
   * no day of its own has no road for a point to go on.
   *
   * A distance past the end of the strand lands on the last day. That is not a
   * failure case but a rounding one — the server measures along stored geometry
   * and the builder along the legs in memory, so the two totals differ by meters
   * and a meet at the very end of the road can fall off it.
   */
  function placeAlongStrand(days, m) {
    if (!days || days.length === 0) return null;
    var run = 0;
    for (var i = 0; i < days.length; i++) {
      var total = totalM(days[i]);
      // `<=` rather than `<` so a distance landing exactly on a day boundary
      // goes to the day it ENDS, not the next one's first point — the same
      // choice rideSegments makes in the other direction and for the opposite
      // reason: there the next day's start is a time the rider typed, here the
      // previous day's end is a place they already planned.
      if (m <= run + total || i === days.length - 1) {
        return { index: i, at: insertIndexAtM(days[i], m - run) };
      }
      run += total;
    }
    return null;
  }

  window.TBDistance = {
    cumulativeM: cumulativeM,
    insertIndexAtM: insertIndexAtM,
    placeAlongStrand: placeAlongStrand,
    totalM: totalM,
    sinceRefuelM: sinceRefuelM,
    isRefuel: isRefuel,
    firstDryPoint: firstDryPoint,
  };
})(typeof window !== "undefined" ? window : this);
