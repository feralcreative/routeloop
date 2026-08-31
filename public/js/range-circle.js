// Where the rider is at a scrubbed moment, and how much fuel is left there.
//
// **THE RING'S EDGE PASSES THROUGH THE POINT THE RIDER RUNS DRY.** Ziad's call,
// 2026-08-31. The dry point is found on the ROAD — the last fill's mileage plus
// the binding bike's range, walked along the day's own polyline — and the
// radius is then the straight line from the rider to it. So the ring is not a
// range number drawn as a circle, which would overclaim on any road that bends;
// its edge is a place, and it collapses to nothing exactly as the rider arrives
// there.
//
// THE RANGE IS THE SHORTEST TANK IN THE GROUP, not the planner's own. That is
// what groupRange() already answers and what #52 was for: the ride is bounded
// by the bike that has to stop first.
//
// THE HISTORY IS WORTH KEEPING because this shape was tried, rejected, and
// arrived at again, and the difference between the two attempts is the whole
// lesson. The first version made the ring chase a MOVING target: it jumped to
// the next fuel stop whenever one came before the dry point, and once the rider
// passed the dry point it kept the target and GREW. Nothing about it could be
// read. The target is now only ever the dry point, it never moves while the
// rider approaches it, and past it there is no ring at all. Same radius rule,
// and it behaves because the thing it points at holds still.
//
// THE RING'S TARGET AND THE WALL'S ARE TWO DIFFERENT QUESTIONS, which is why
// there are two functions. fuelReachM() is how far the tank gets the rider,
// CAPPED at the end of the day; dryDistanceM() is where they run out, and null
// when they do not run out at all. Drawing the ring from the second was a real
// defect: past a rider's LAST refuel the tank outlasts the day, so there was no
// dry point, so there was no ring — for the rest of the day, with the refuel
// working perfectly the whole time.
//
// NO RANGE MEANS NO RING. Null is not zero and it is not a default: a ring
// drawn for a rider whose bike has no range on file implies somebody checked
// they could make it. Nobody did.
(function (window) {
  "use strict";

  var pointsOf = function (day) {
    return (day && day.points) || [];
  };

  /** A leg's distance in meters, treating an unrouted one as zero rather than
   *  as a hole in the sum — the same rule cumulativeM() applies. */
  function legM(day, i) {
    var leg = day && day.legs && day.legs[i];
    var m = leg && leg.distanceM;
    return typeof m === "number" && isFinite(m) && m > 0 ? m : 0;
  }

  /**
   * How far into the day the rider is, in meters, at this moment.
   *
   * `at` is what activeAt() / activeAtMoment() returned and `cum` is
   * TBDistance.cumulativeM(day) — passed in rather than recomputed, because a
   * caller redrawing on every slider input already holds it and this runs on
   * every pixel of the drag.
   *
   * Null when the moment is on no day at all — the overnight gap between two
   * days, which activeAtMoment reports as nulls rather than rounding into the
   * nearest day. There is no position to draw then, and drawing the last known
   * one would show a rider riding through the night.
   */
  function distanceAtMoment(day, at, cum) {
    if (!at || !cum || !cum.length) return null;
    if (at.pointIndex != null) return cum[at.pointIndex] != null ? cum[at.pointIndex] : null;
    if (at.legIndex == null) return null;
    var base = cum[at.legIndex];
    if (base == null) return null;
    var f = typeof at.legFraction === "number" ? Math.max(0, Math.min(1, at.legFraction)) : 0;
    return base + legM(day, at.legIndex) * f;
  }

  /** Does this point fill the tank the binding bike actually drinks from?
   *  `gas` and `charge` are the same event seen from two kinds of machine, so
   *  an electric rider passing a Chevron has refuelled nothing. Mirrors
   *  isRefuel() in day-distance.js. */
  function isRefuel(point, fuelRole) {
    if (!point || !fuelRole) return false;
    var roles = point.roles;
    return Array.isArray(roles) && roles.indexOf(fuelRole) !== -1;
  }

  /**
   * How far into the day the last fill was, in meters.
   *
   * AT counts as filled — the tank is full standing at the pump, which is the
   * same reading sinceRefuelM() gives that row in the day list. Zero when
   * nothing before this point refuels, which is the start of the day and is the
   * right answer: the rider set off on a full tank.
   */
  function lastFillM(day, distM, cum, fuelRole) {
    var points = pointsOf(day);
    var last = 0;
    for (var i = 0; i < points.length; i++) {
      if (isRefuel(points[i], fuelRole) && cum[i] <= distM) last = cum[i];
    }
    return last;
  }

  /**
   * The furthest point along the day the tank reaches: the dry point, or the
   * end of the day when the fuel outlasts it. The ring's edge.
   *
   * CAPPED AT THE DAY RATHER THAN NULL PAST IT, and that cap is a FIX rather
   * than a refinement. dryDistanceM() returns null once the tank outlasts the
   * day — correctly, because there is no dry point on the route to mark — and
   * the ring was drawn from that, so it vanished for good the moment a rider
   * passed their LAST refuel. Reported from a test ride with the pump set a few
   * miles past empty: the ring shrank to nothing, the rider rode through the
   * pump, and it never came back. The refuel was detected the whole time; there
   * was simply nothing left to point at.
   *
   * So the ring points at the end of the day instead, which is a true statement
   * — that is as far as this fuel has to get them — and the wall is what says
   * whether they make it. A ring with no wall inside it means the day is
   * covered.
   */
  function fuelReachM(day, distM, cum, fuelRole, rangeM) {
    if (distM == null || !cum || !cum.length) return null;
    if (!(rangeM > 0)) return null;
    return Math.min(lastFillM(day, distM, cum, fuelRole) + rangeM, cum[cum.length - 1]);
  }

  /**
   * How far into the day the tank runs dry, or null when it does not run dry
   * before the day ends.
   *
   * The ring's radius no longer reaches this point — that was the rejected
   * version — so it is a second, independent fact: the ring says how much fuel
   * is left as the crow flies, and this says where that runs out on the road
   * the rider is actually on. The gap between them IS the cost of the bends,
   * which is worth being able to see rather than worth hiding inside a factor.
   */
  function dryDistanceM(day, distM, cum, fuelRole, rangeM) {
    if (distM == null || !cum || !cum.length) return null;
    if (!(rangeM > 0)) return null;
    var dry = lastFillM(day, distM, cum, fuelRole) + rangeM;
    // cum is index-aligned with the points and a day has one fewer leg than it
    // has points, so the last entry already IS the whole day.
    return dry <= cum[cum.length - 1] ? dry : null;
  }

  window.TBRange = {
    distanceAtMoment: distanceAtMoment,
    lastFillM: lastFillM,
    fuelReachM: fuelReachM,
    dryDistanceM: dryDistanceM,
    isRefuel: isRefuel,
  };
})(typeof window !== "undefined" ? window : this);
