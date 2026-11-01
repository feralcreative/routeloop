// Where the rider is at a scrubbed moment, and how much fuel is left there.
//
// **THE RING'S EDGE PASSES THROUGH THE POINT THE RIDER RUNS DRY.** The dry point is
// found on the ROAD — the last fill's mileage plus the binding bike's range, walked
// along the route's own polyline — and the radius is then the straight line from the
// rider to it. So the ring is not a range number drawn as a circle, which would
// overclaim on any road that bends; its edge is a place, and it collapses to nothing
// exactly as the rider arrives there.
//
// THE RANGE IS THE SHORTEST TANK IN THE GROUP, not the planner's own: the ride is
// bounded by the bike that has to stop first.
//
// THE HISTORY IS WORTH KEEPING because this shape was tried, rejected, and arrived at
// again. The first version made the ring chase a MOVING target: it jumped to the next
// fuel stop whenever one came before the dry point, and once the rider passed the dry
// point it kept the target and GREW. Nothing about it could be read. Same radius rule,
// and it behaves because the thing it points at holds still.
//
// THE RING'S TARGET AND THE WALL'S ARE TWO DIFFERENT QUESTIONS, which is why there are
// two functions. fuelReachM() is how far the tank gets the rider, CAPPED at the end of
// the route; dryDistanceM() is where they run out, and null when they do not.
//
// NO RANGE MEANS NO RING. Null is not zero and it is not a default: a ring drawn for a
// rider whose bike has no range on file implies somebody checked they could make it.
//
// THE TANK CARRIES FROM ONE ROUTE TO THE NEXT (#451, Ziad's call, 2026-10-31). Every
// function below takes an optional last argument, `carryM`: how far into the current
// tank the group already is when the route begins, worked out by carriesM() from the
// route before it. Zero, the default, is a full tank, which is what every route
// assumed until then, so a group that ended route 1 on fumes and set off on route 2
// without filling up was told nothing. A route that STARTS at a pump starts full,
// because a refuel at point 0 is a fill at 0; a hotel with no pump refills nobody.
(function (window) {
  "use strict";

  var pointsOf = function (route) {
    return (route && route.points) || [];
  };

  /** A leg's distance in meters, treating an unrouted one as zero rather than
   *  as a hole in the sum — the same rule cumulativeM() applies. */
  function legM(route, i) {
    var leg = route && route.legs && route.legs[i];
    var m = leg && leg.distanceM;
    return typeof m === "number" && isFinite(m) && m > 0 ? m : 0;
  }

  /**
      * How far into the route the rider is, in meters, at this moment.
      *
      * `cum` is TBDistance.cumulativeM(route) — passed in rather than recomputed, because
      * a caller redrawing on every slider input already holds it.
      *
      * Null when the moment is on no route at all — the overnight gap between two routes.
      * There is no position to draw then, and drawing the last known one would show a
      * rider riding through the night.
      */
  function distanceAtMoment(route, at, cum) {
    if (!at || !cum || !cum.length) return null;
    if (at.pointIndex != null) return cum[at.pointIndex] != null ? cum[at.pointIndex] : null;
    if (at.legIndex == null) return null;
    var base = cum[at.legIndex];
    if (base == null) return null;
    var f = typeof at.legFraction === "number" ? Math.max(0, Math.min(1, at.legFraction)) : 0;
    return base + legM(route, at.legIndex) * f;
  }

  /** Does this point fill the tank the binding bike actually drinks from?
   *  `gas` and `charge` are the same event seen from two kinds of machine, so
   *  an electric rider passing a Chevron has refuelled nothing. Mirrors
   *  isRefuel() in route-distance.js. */
  function isRefuel(point, fuelRole) {
    if (!point || !fuelRole) return false;
    var roles = point.roles;
    return Array.isArray(roles) && roles.indexOf(fuelRole) !== -1;
  }

  /**
   * How far into the route the last fill was, in meters.
   *
   * AT counts as filled — the tank is full standing at the pump, which is the
   * same reading sinceRefuelM() gives that row in the route list. When nothing
   * before this point refuels it is minus the carry: the tank was last full that
   * far back, on the route before this one, or at this route's start when nothing
   * carried.
   */
  function lastFillM(route, distM, cum, fuelRole, carryM) {
    var points = pointsOf(route);
    var last = carryM > 0 ? -carryM : 0;
    for (var i = 0; i < points.length; i++) {
      if (isRefuel(points[i], fuelRole) && cum[i] <= distM) last = cum[i];
    }
    return last;
  }

  /**
      * The furthest point along the route the tank reaches: the dry point, or the end of
      * the route when the fuel outlasts it. The ring's edge.
      *
      * CAPPED AT THE ROUTE RATHER THAN NULL PAST IT, and that cap is a FIX rather than a
      * refinement. dryDistanceM() returns null once the tank outlasts the route, and the
      * ring was drawn from that, so it vanished for good the moment a rider passed their
      * LAST refuel. The refuel was detected the whole time; there was nothing left to
      * point at.
      *
      * So the ring points at the end of the route instead, which is a true statement, and
      * the wall is what says whether they make it. A ring with no wall inside it means the
      * route is covered.
      */
  function fuelReachM(route, distM, cum, fuelRole, rangeM, carryM) {
    // THE TANK THE RIDER IS ON, not the one they run out of — deliberately NOT
    // dryDistanceM(). The ring answers "how far does this fill get me", so it
    // must reset at the next pump rather than looking past it; the wall answers
    // "where does the ride stop", which is a different question and is why the
    // two are separate functions.
    if (distM == null || !cum || !cum.length) return null;
    if (!(rangeM > 0)) return null;
    return Math.max(0, Math.min(lastFillM(route, distM, cum, fuelRole, carryM) + rangeM, cum[cum.length - 1]));
  }

  /**
      * How much of the CURRENT tank has been burned at this moment, 0..1.
      *
      * THE TANK, NOT THE ROUTE — the same distinction fuelReachM() makes: this resets at
      * every pump the rider actually stops at, so a rider who fills at halfway is back to
      * a full green ring on the far side of it.
      *
      * Null when nothing can say. That is not zero — zero is a full tank, which is a
      * claim, and no bike on file is the common case rather than the edge one.
      */
  function tankUsed(route, distM, cum, fuelRole, rangeM, carryM) {
    if (distM == null || !cum || !cum.length) return null;
    if (!(rangeM > 0)) return null;
    var burned = distM - lastFillM(route, distM, cum, fuelRole, carryM);
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
   * EVERY point along the route where the tank would run out, in order.
   *
   * ONE WALL PER TANKFUL, not just the next one. #220 is about knowing where
   * fuel stops have to go, and a single marker only ever answers that for the
   * first one — on a 700-mile route with no pumps a rider needs to see all six,
   * not be told about the first and left to divide.
   *
   * The walk refills at two kinds of place. A PUMP the current tank can reach
   * is a real fill and becomes the new origin. A WALL is a notional one: the
   * rider has to stop there, so the tank after it starts there, and the next
   * wall is a full range beyond. That is what makes the intervals read as "you
   * need fuel roughly here, here and here" rather than as one fact repeated.
   *
   * It terminates because `tank` advances by at least `rangeM` on every pass —
   * a wall is always `tank + rangeM` — so the list is bounded by the route's
   * length over the range.
   *
   * Empty rather than null for no range, no position, or a route the tank covers:
   * a caller draws one marker per entry and an empty list is no markers, which
   * is the same code path as every other route.
   */
  function dryDistancesM(route, distM, cum, fuelRole, rangeM, carryM) {
    if (distM == null || !cum || !cum.length) return [];
    if (!(rangeM > 0)) return [];

    var points = pointsOf(route);
    var total = cum[cum.length - 1];

    // Ascending, because `cum` is and the points are in order.
    var pumps = [];
    for (var i = 0; i < points.length; i++) {
      if (isRefuel(points[i], fuelRole)) pumps.push(cum[i]);
    }

    var out = [];
    var tank = lastFillM(route, distM, cum, fuelRole, carryM);
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
      // A carried tank can already be empty at the start: the wall is the start.
      out.push(Math.max(0, dry));
      tank = dry;
    }
    return out;
  }

  /**
   * The FIRST point the tank runs dry, or null when it does not run dry before
   * the route ends. What the red stretch starts from — see dryStretch().
   */
  function dryDistanceM(route, distM, cum, fuelRole, rangeM, carryM) {
    var all = dryDistancesM(route, distM, cum, fuelRole, rangeM, carryM);
    return all.length ? all[0] : null;
  }

  /**
   * The stretch the rider cannot make on the fuel they have: from where the
   * tank runs out to where they can next fill up. `{ from, to }` in meters
   * along the route, or null when there is no such stretch.
   *
   * TO THE END OF THE DAY WHEN THERE IS NO PUMP AFTER IT, because that is the
   * honest answer — they do not make it, and the whole remainder is the part
   * they cannot ride. A stretch that stopped at the dry point would say the
   * problem was a point rather than a distance.
   *
   * It moves as the rider refuels, because `dryDistanceM()` does: passing a
   * pump pushes the dry point forward and the stretch with it, or removes both.
   */
  function dryStretch(route, distM, cum, fuelRole, rangeM, carryM) {
    var from = dryDistanceM(route, distM, cum, fuelRole, rangeM, carryM);
    if (from == null) return null;
    var points = pointsOf(route);
    var to = cum[cum.length - 1];
    for (var i = 0; i < points.length; i++) {
      if (isRefuel(points[i], fuelRole) && cum[i] > from) {
        to = cum[i];
        break;
      }
    }
    return to > from ? { from: from, to: to } : null;
  }

  /**
   * How far into the tank each route of a ride starts, in meters: zero for a full
   * tank. One entry per route, aligned with `routes` (#451).
   *
   * EACH GROUP'S TANK FOLLOWS ITS OWN SEQUENCE: a route tagged with a group follows
   * the nearest earlier route that group rides, its own or an untagged one; an
   * untagged route is ridden by everyone, so it starts as low as the LOWEST tank any
   * group arrives with, which is the one that binds. A losing alternate (`isActive`
   * false) is skipped as a predecessor and given no carry of its own. A route that
   * begins at a pump begins full.
   *
   * What a route leaves behind is how far past its last fill it ends, where a fill is
   * a pump the tank reached or a wall, the notional fill dryDistancesM() places
   * where the rider has to stop. So it is always less than one range: a wall says
   * the rider must find fuel there, and the next route is measured as though they
   * did.
   *
   * `cumOf(route)` is TBDistance.cumulativeM, passed in so this file stays free of
   * that one. All zeros with no range or no fuel role: no ring, nothing carried.
   */
  function carriesM(routes, fuelRole, rangeM, cumOf, isActive) {
    var out = [];
    var left = [];
    var i;
    for (i = 0; i < routes.length; i++) out.push(0);
    if (!(rangeM > 0) || !fuelRole) return out;
    var tagOf = function (r) {
      return (r && r.subgroupUid) || null;
    };
    for (i = 0; i < routes.length; i++) {
      var r = routes[i];
      left.push(null);
      if (!isActive(r)) continue;
      var tag = tagOf(r);
      // The sequences this route sits in: its own group's, or, when it is shared,
      // every group that has ridden a route of its own so far. The untagged chain on
      // its own only when no group has split off yet: once groups have their own
      // routes, the shared one before them is not how anybody arrives.
      var tags = [tag];
      if (tag === null) {
        for (var k = 0; k < i; k++) {
          var tk = tagOf(routes[k]);
          if (tk !== null && isActive(routes[k]) && tags.indexOf(tk) === -1) tags.push(tk);
        }
        if (tags.length > 1) tags.shift();
      }
      var carry = 0;
      for (var t = 0; t < tags.length; t++) {
        for (var j = i - 1; j >= 0; j--) {
          if (left[j] == null) continue;
          var tj = tagOf(routes[j]);
          if (tj === null || tj === tags[t]) {
            carry = Math.max(carry, left[j]);
            break;
          }
        }
      }
      if (isRefuel(pointsOf(r)[0], fuelRole)) carry = 0;
      out[i] = carry;
      var cum = cumOf(r);
      if (!cum || !cum.length) {
        left[i] = carry;
        continue;
      }
      var total = cum[cum.length - 1];
      // A wall AT the end is not a fill: the group arrives empty and leaves empty.
      var walls = dryDistancesM(r, 0, cum, fuelRole, rangeM, carry).filter(function (w) {
        return w < total;
      });
      var origin = lastFillM(r, total, cum, fuelRole, carry);
      if (walls.length) origin = Math.max(origin, walls[walls.length - 1]);
      left[i] = Math.max(0, total - origin);
    }
    return out;
  }

  window.TBRange = {
    carriesM: carriesM,
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
