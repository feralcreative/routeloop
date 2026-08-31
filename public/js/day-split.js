// Cutting one day into two.
//
// ONE MECHANIC SERVING TWO ISSUES. #49 asks for it explicitly — "pick a stop and
// split there, or split by distance or riding time" — and #54 asks for it by
// another name: marking where you are sleeping ends the day there and starts the
// next one from it. They are the same operation with two different triggers, so
// they are one function rather than two that would drift about what a boundary
// means.
//
// **THE SPLIT POINT BELONGS TO BOTH DAYS.** You ride TO the hotel and you set off
// FROM the hotel, so it is the last point of the first day and the first point of
// the second. That is what makes the result look like a ride somebody planned
// rather than two halves of a line — and it is the same shape addDay() already
// produces, which seeds a new day from the previous day's last point.
//
// NOTHING IS RE-ROUTED. `legs[i]` joins `points[i]` to `points[i+1]`, so cutting
// at point i hands legs 0..i-1 to the first day and i.. to the second and every
// leg keeps the road it was already drawn on. #49 says this outright and it is
// the reason the whole operation is free: a split that re-routed would spend a
// Routes call per leg and could come back with a different road than the rider
// drew.
//
// PURE, AND THE uid MINTER IS AN ARGUMENT. The copy of the split point needs an
// identity of its own — `points.uid` is what survives the delete-and-reinsert of
// every save, and two points sharing one would collide — but minting it here
// would drag crypto into a module whose whole job is arithmetic and make the
// result untestable.
(function (window) {
  "use strict";

  var pointsOf = function (day) {
    return (day && day.points) || [];
  };

  /**
   * Where a day may be cut.
   *
   * NOT THE FIRST POINT AND NOT THE LAST. Splitting at either produces a day
   * with one point and no legs on one side — a day that goes nowhere, which the
   * API refuses and payload() drops whole. Refusing up front is better than
   * producing something that vanishes on save.
   */
  function canSplitAt(day, i) {
    var n = pointsOf(day).length;
    return Number.isInteger(i) && i > 0 && i < n - 1;
  }

  /** Every index this day could be cut at, for a caller offering a choice. */
  function splitPoints(day) {
    var out = [];
    for (var i = 1; i < pointsOf(day).length - 1; i++) out.push(i);
    return out;
  }

  /**
   * Cut `day` in two at point `i`. Returns `{ first, second }`, or null when the
   * cut is not a legal one.
   *
   * Both halves are new objects; the input is not touched. Everything that is a
   * fact about the DAY rather than about its shape — color, subgroup, alt
   * grouping, the clock — is left for the caller, because those answers need the
   * rest of the ride to decide and this module can only see one day.
   *
   * THE COPY CARRIES NO ROLES, and that is deliberate rather than an omission.
   * The hotel you slept at is a fact recorded once, on the day that rode to it;
   * duplicating the tag would double-count it everywhere roles are summed — the
   * dashboard's category chart, the roadbook's numbered rows, the fuel math in
   * day-distance.js, which would read the copy as a second refuelling stop. What
   * the copy keeps is where it is and what it is called, which is what a rider
   * needs to recognise where their morning starts.
   *
   * `kind` is forced to "stop" on the copy. Every day needs at least one, the
   * schema refuses a day of nothing but POIs, and the first point of a day is a
   * place you are by definition setting off from.
   */
  function splitDayAt(day, i, mintUid) {
    if (!canSplitAt(day, i)) return null;
    var points = pointsOf(day);
    var legs = (day && day.legs) || [];
    var at = points[i];

    var first = Object.assign({}, day, {
      points: points.slice(0, i + 1),
      legs: legs.slice(0, i),
    });

    var carried = {
      uid: mintUid(),
      kind: "stop",
      lat: at.lat,
      lng: at.lng,
      name: at.name,
      description: "",
      roles: [],
      durationMin: null,
    };

    var second = Object.assign({}, day, {
      uid: mintUid(),
      points: [carried].concat(points.slice(i + 1)),
      legs: legs.slice(i),
      // A SPLIT NEVER INHERITS AN ALT GROUPING. Two alternates are two answers
      // to the same stretch of road; cutting one in half would leave a group
      // whose members no longer cover the same ground, and the day that lost is
      // still the day that lost. The caller decides what the new day is, and a
      // plain day is the only honest default.
      altGroup: null,
      altActive: true,
      // Times are the caller's: the second day begins the morning after the
      // first one ends, and the first one's end is derived from a schedule this
      // module cannot see.
      startAt: null,
      endAt: null,
      endManual: false,
    });

    return { first: first, second: second };
  }

  /**
   * The best point to cut at to get about `targetM` meters into the first day.
   *
   * NEAREST, NOT FIRST-PAST. A rider asking for "about 300 miles" and holding a
   * day with points at 290 and 340 means the one at 290; a first-past rule hands
   * them 340 and a 50-mile overshoot on a number they chose deliberately.
   *
   * Returns null when the day cannot be cut at all, so a caller never has to
   * check both this and canSplitAt.
   */
  function splitIndexAtDistance(day, targetM, cumulativeM) {
    var legal = splitPoints(day);
    if (!legal.length) return null;
    var cum = cumulativeM(day);
    var best = legal[0];
    var bestGap = Math.abs(cum[best] - targetM);
    for (var k = 1; k < legal.length; k++) {
      var gap = Math.abs(cum[legal[k]] - targetM);
      // A METER OF SLACK, so a tie keeps the EARLIER point. A bare `<` reads as
      // doing that and does not: every distance here is a float sum of leg
      // meters, so two points genuinely equidistant from the target come out
      // differing in the twelfth decimal and whichever way that noise falls
      // decides it. Measured — 100mi and 200mi against a 150mi target picked the
      // LATER point. A meter is far below anything a rider could mean by "about
      // 300 miles" and makes the rule real.
      //
      // Earlier, because a shorter first day is the recoverable mistake: the
      // rider adds to it. The longer one means riding past where they meant to
      // stop.
      if (gap < bestGap - 1) {
        best = legal[k];
        bestGap = gap;
      }
    }
    return best;
  }

  window.TBSplit = {
    canSplitAt: canSplitAt,
    splitPoints: splitPoints,
    splitDayAt: splitDayAt,
    splitIndexAtDistance: splitIndexAtDistance,
  };
})(typeof window !== "undefined" ? window : this);
