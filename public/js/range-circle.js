// Where the rider is at a scrubbed moment, and how far the circle around them
// reaches.
//
// **THE RADIUS IS THE STRAIGHT LINE TO A KNOWN POINT ON THE ROUTE, NOT THE
// REMAINING RANGE.** Ziad's call, 2026-08-31, and it is the whole idea. Drawing
// a circle of radius "142 miles of range left" claims the rider can reach
// anywhere inside it, which is false on any road that bends — and correcting it
// with a winding factor replaces a false number with an invented one, the thing
// this codebase keeps refusing to do.
//
// So the circle is drawn to a point we can locate exactly. The tank runs dry at
// a measurable distance along the day — the last refuel plus the bike's range,
// both in meters, both already stored — and `pointAtDistance()` turns that into
// a coordinate. The radius is then simply the straight line from the rider to
// that coordinate, and the circle's edge passes through it. One true statement
// instead of an approximate one.
//
// It also behaves correctly under scrubbing for free: the target does not move
// while the rider approaches it, so the circle collapses onto the point exactly
// as they arrive, then jumps back out to the next target. Nothing has to
// animate it and nothing has to decide how fast it should shrink.
//
// TWO KINDS OF TARGET, and which one it is decides how it is drawn. Running dry
// is a problem with the plan; reaching the next pump is the plan working. A day
// that is fuelled properly never shows the warning.
//
// NO RANGE MEANS NO CIRCLE. Null is not zero and it is not a default: a circle
// drawn to the next pump for a rider whose bike has no range on file implies
// somebody checked they could make it. Nobody did.
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
   * What the circle reaches to from `distM` into the day: `{ kind, distM }`
   * where kind is "dry" or "fuel", or null when there is nothing to draw to.
   *
   * WHICHEVER COMES FIRST. Running dry is only the target when it happens
   * before the next pump; a day with fuel stops in the right places shows the
   * pumps and never the warning, which is what makes the warning mean
   * something when it does appear.
   *
   * A DRY POINT PAST THE END OF THE DAY IS NOT A TARGET. The rider finishes on
   * the tank they have, so there is nothing to warn about and nothing on the
   * route to point at — the day simply ends first.
   *
   * A DRY POINT ALREADY BEHIND THE RIDER STAYS THE TARGET, and dropping it was
   * a real defect caught on ride 15: the warning appeared for the first 46% of
   * a 259-mile day on a 120-mile tank and then VANISHED, so the map went quiet
   * at exactly the moment the plan was worst. The circle grows behind them
   * instead, and its edge still passes through the point they ran out at.
   *
   * It also outranks a pump beyond it, which looks backwards and is not: a
   * station the rider cannot reach on this tank is not the answer to anything.
   * Where they ran dry is.
   *
   * The refuel search is `> distM` rather than `>=`, so standing AT a pump
   * targets the next one rather than the one underfoot: a zero-radius circle
   * says nothing and the question at the pump is what comes after it.
   */
  function fuelTargetAt(day, distM, cum, fuelRole, rangeM) {
    if (distM == null || !cum || !cum.length) return null;
    if (!(rangeM > 0)) return null;

    var points = pointsOf(day);
    // cum is index-aligned with the points and a day has one fewer leg than it
    // has points, so the last entry already IS the whole day.
    var total = cum[cum.length - 1];

    // The last fill at or before where the rider is. AT counts as filled — the
    // tank is full standing at the pump, which is the same reading
    // sinceRefuelM() gives that row.
    var lastFill = 0;
    var next = null;
    for (var i = 0; i < points.length; i++) {
      if (!isRefuel(points[i], fuelRole)) continue;
      if (cum[i] <= distM) lastFill = cum[i];
      else if (next == null) next = cum[i];
    }

    var dry = lastFill + rangeM;
    var dryReal = dry <= total;

    if (next != null && (!dryReal || next <= dry)) return { kind: "fuel", distM: next };
    if (dryReal) return { kind: "dry", distM: dry };
    return null;
  }

  window.TBRange = {
    distanceAtMoment: distanceAtMoment,
    fuelTargetAt: fuelTargetAt,
    isRefuel: isRefuel,
  };
})(typeof window !== "undefined" ? window : this);
