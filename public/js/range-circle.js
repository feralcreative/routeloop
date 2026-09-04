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
    // THE TANK THE RIDER IS ON, not the one they run out of — deliberately NOT
    // dryDistanceM(). The ring answers "how far does this fill get me", so it
    // must reset at the next pump rather than looking past it; the wall answers
    // "where does the ride stop", which is a different question and is why the
    // two are separate functions.
    if (distM == null || !cum || !cum.length) return null;
    if (!(rangeM > 0)) return null;
    return Math.min(lastFillM(day, distM, cum, fuelRole) + rangeM, cum[cum.length - 1]);
  }

  /**
   * How much of the CURRENT tank has been burned at this moment, 0..1.
   *
   * THE TANK, NOT THE DAY — the same distinction fuelReachM() makes and for the
   * same reason: this resets at every pump the rider actually stops at, so it
   * answers "how much fuel is in the bike right now" rather than "how far
   * through the ride are you". A rider who fills at halfway is back to a full
   * green ring on the far side of it.
   *
   * Null when nothing can say: no moment, no range on file. That is not zero —
   * zero is a full tank, which is a claim, and no bike on file is the common
   * case rather than the edge one.
   */
  function tankUsed(day, distM, cum, fuelRole, rangeM) {
    if (distM == null || !cum || !cum.length) return null;
    if (!(rangeM > 0)) return null;
    var burned = distM - lastFillM(day, distM, cum, fuelRole);
    if (!(burned > 0)) return 0;
    // Capped, because past the dry point the ring has no radius to draw anyway
    // and a fraction over 1 would only be a number nothing reads.
    return Math.min(1, burned / rangeM);
  }

  /**
   * What color the ring takes at that fraction: "go", "warning" or "stop".
   *
   * Ziad's call, 2026-09-02, and it REFINES the 2026-08-31 decision that the
   * whole fuel overlay is $stop red rather than reversing it. The E markers and
   * the closed stretch stay red because they are verdicts — you cannot ride
   * this. The ring became a GAUGE, and a gauge that is red at a full tank is
   * telling the rider nothing they can act on.
   *
   * GREEN THROUGH THE FIRST HALF, orange past it, red from three quarters. The
   * boundaries go to the calmer color: at exactly half a tank a rider has half a
   * tank, which is not yet a thing to worry about.
   *
   * A NAME RATHER THAN A COLOR, so this file spends no opinion on which red —
   * map-common.js resolves it against the live palette, which is what keeps the
   * six themes working.
   */
  function ringTone(used) {
    // No range on file draws no ring at all, so this is only reached with a real
    // fraction; "stop" is the safe answer rather than the expected one.
    if (used == null) return "stop";
    if (used <= 0.5) return "go";
    // $fuel-low, WHICH IS A TOKEN OF ITS OWN BECAUSE BOTH NEIGHBORS WERE TRIED
    // AND BOTH WERE WRONG. $warning (#ffac00) is an amber tuned to be read as
    // text on a white card and washes out as a thin dotted ring over pale busy
    // map tiles; $detour (#f56100) fixed that and read as too red for "you have
    // half a tank left", which is advice rather than a verdict. $fuel-low is
    // mixed halfway between them in _palette.scss, so it follows all three sign
    // palettes instead of sitting still while its neighbors move. Ziad's call,
    // 2026-09-02, after seeing both on the map.
    if (used < 0.75) return "fuel-low";
    return "stop";
  }

  /**
   * EVERY point along the day where the tank would run out, in order.
   *
   * ONE WALL PER TANKFUL, not just the next one. #220 is about knowing where
   * fuel stops have to go, and a single marker only ever answers that for the
   * first one — on a 700-mile day with no pumps a rider needs to see all six,
   * not be told about the first and left to divide.
   *
   * The walk refills at two kinds of place. A PUMP the current tank can reach
   * is a real fill and becomes the new origin. A WALL is a notional one: the
   * rider has to stop there, so the tank after it starts there, and the next
   * wall is a full range beyond. That is what makes the intervals read as "you
   * need fuel roughly here, here and here" rather than as one fact repeated.
   *
   * It terminates because `tank` advances by at least `rangeM` on every pass —
   * a wall is always `tank + rangeM` — so the list is bounded by the day's
   * length over the range.
   *
   * Empty rather than null for no range, no position, or a day the tank covers:
   * a caller draws one marker per entry and an empty list is no markers, which
   * is the same code path as every other day.
   */
  function dryDistancesM(day, distM, cum, fuelRole, rangeM) {
    if (distM == null || !cum || !cum.length) return [];
    if (!(rangeM > 0)) return [];

    var points = pointsOf(day);
    var total = cum[cum.length - 1];

    // Ascending, because `cum` is and the points are in order.
    var pumps = [];
    for (var i = 0; i < points.length; i++) {
      if (isRefuel(points[i], fuelRole)) pumps.push(cum[i]);
    }

    var out = [];
    var tank = lastFillM(day, distM, cum, fuelRole);
    var p = 0;
    for (;;) {
      while (p < pumps.length && pumps[p] <= tank) p++;
      // Each pump within reach refills and becomes the new origin. The first
      // one out of reach is where the ride actually stops, and the loop leaves
      // it alone rather than skipping to one beyond it.
      while (p < pumps.length && pumps[p] <= tank + rangeM) {
        tank = pumps[p];
        p++;
      }
      var dry = tank + rangeM;
      if (dry > total) break;
      out.push(dry);
      tank = dry;
    }
    return out;
  }

  /**
   * The FIRST point the tank runs dry, or null when it does not run dry before
   * the day ends. What the red stretch starts from — see dryStretch().
   */
  function dryDistanceM(day, distM, cum, fuelRole, rangeM) {
    var all = dryDistancesM(day, distM, cum, fuelRole, rangeM);
    return all.length ? all[0] : null;
  }

  /**
   * The stretch the rider cannot make on the fuel they have: from where the
   * tank runs out to where they can next fill up. `{ from, to }` in meters
   * along the day, or null when there is no such stretch.
   *
   * TO THE END OF THE DAY WHEN THERE IS NO PUMP AFTER IT, because that is the
   * honest answer — they do not make it, and the whole remainder is the part
   * they cannot ride. A stretch that stopped at the dry point would say the
   * problem was a point rather than a distance.
   *
   * It moves as the rider refuels, because `dryDistanceM()` does: passing a
   * pump pushes the dry point forward and the stretch with it, or removes both.
   */
  function dryStretch(day, distM, cum, fuelRole, rangeM) {
    var from = dryDistanceM(day, distM, cum, fuelRole, rangeM);
    if (from == null) return null;
    var points = pointsOf(day);
    var to = cum[cum.length - 1];
    for (var i = 0; i < points.length; i++) {
      if (isRefuel(points[i], fuelRole) && cum[i] > from) {
        to = cum[i];
        break;
      }
    }
    return to > from ? { from: from, to: to } : null;
  }

  window.TBRange = {
    distanceAtMoment: distanceAtMoment,
    lastFillM: lastFillM,
    fuelReachM: fuelReachM,
    dryDistanceM: dryDistanceM,
    dryDistancesM: dryDistancesM,
    dryStretch: dryStretch,
    tankUsed: tankUsed,
    ringTone: ringTone,
    isRefuel: isRefuel,
  };
})(typeof window !== "undefined" ? window : this);
