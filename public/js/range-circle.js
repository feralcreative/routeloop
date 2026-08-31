// Where the rider is at a scrubbed moment, and how much fuel is left there.
//
// **THE RADIUS IS THE FUEL IN THE TANK: the bike's range minus the miles
// ridden since the last fill.** Ziad's call, 2026-08-31. It shrinks
// continuously as the rider scrubs forward, resets to full at every fuel stop,
// and on a day with no fuel stop planned it shrinks to nothing exactly at the
// binding bike's max range — which is the moment worth seeing, and the reason
// the ring exists at all.
//
// THE RANGE IS THE SHORTEST TANK IN THE GROUP, not the planner's own. That is
// what groupRange() already answers and what #52 was for: the ride is bounded
// by the bike that has to stop first.
//
// A REJECTED VERSION IS WORTH RECORDING, because it looks more rigorous and is
// worse to use. The radius was briefly the straight-line distance from the
// rider to the point they run dry, on the reasoning that a plain range circle
// overclaims — roads bend, so a rider cannot actually reach the edge of a
// circle drawn at their remaining range. True, but it made the ring a
// measurement of the ROAD'S shape rather than of the TANK: on a twisty day it
// collapsed while the tank was still half full, it grew again once the rider
// passed the dry point, and it jumped between targets. Nobody reading it could
// tell what it was counting. A ring that means "this much fuel, as the crow
// flies" is a claim a rider can hold in their head, and the dry marker on the
// route is what says where that lands on the actual road.
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
   * The fuel left at `distM` into the day, in meters of range. The ring's
   * radius, and null when there is no ring to draw.
   *
   * NULL RATHER THAN ZERO WHEN NO RANGE IS KNOWN, and the two must not collapse
   * into one: zero means the tank is empty, which is a fact worth drawing
   * nothing for, and null means nobody measured it, which is a different reason
   * to draw nothing. A caller that treats them alike will eventually treat one
   * of them as a number.
   *
   * Clamped at zero rather than going negative. Past the point they run dry the
   * rider is not carrying negative fuel; the ring is simply gone, and the dry
   * marker is what still says where it happened.
   */
  function remainingM(day, distM, cum, fuelRole, rangeM) {
    if (distM == null || !cum || !cum.length) return null;
    if (!(rangeM > 0)) return null;
    var since = distM - lastFillM(day, distM, cum, fuelRole);
    return Math.max(0, rangeM - since);
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
    remainingM: remainingM,
    dryDistanceM: dryDistanceM,
    isRefuel: isRefuel,
  };
})(typeof window !== "undefined" ? window : this);
