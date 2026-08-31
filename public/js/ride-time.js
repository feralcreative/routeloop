// The ride's time model, shared by the builder and the viewer. Exposes
// window.TBTime.
//
// It lives apart from both because they have to agree: the builder decides what
// is active at a moment from the legs it holds in memory, the viewer decides it
// from the legs ride.json sends, and the same ride must resolve identically in
// each. Two copies of this walk would drift, and the drift would show up as a
// map highlighting a different road than the one the planner saw.
//
// ONE DAY SHAPE REACHES THIS MODULE: an ordered `points` array with a `kind` on
// each element, and `legs[i]` joining `points[i]` to `points[i+1]`. It used to
// accept a second shape as well, because `ride.json` sent `stops` and `pois` as
// two separate arrays — that split was fine while a POI was beside the route and
// took no part in the schedule. A POI is ON the route now (2026-08-24), so the
// walk below needs the interleaved order and two arrays cannot supply it.
(function () {
  "use strict";

  // Fallback riding speed for a leg the router never answered for, matching the
  // 20 m/s (~45 mph) the demo seeder uses. Rough twice over — it is applied to a
  // haversine distance, which is shorter than the road — so anything derived
  // from it is labeled an estimate rather than presented as a duration.
  const NOMINAL_SPEED_MS = 20;

  // A leg with distance but no duration never came back from the router, so its
  // time is estimated from distance. Deriving this rather than storing a flag
  // means a reloaded ride reports the same figures as the session that built it,
  // and an imported ride — which carries its whole track as one leg with no
  // duration at all — gets a plausible span instead of a zero-length day.
  const legIsEstimated = (leg) => leg.durationS <= 0 && leg.distanceM > 0;
  const legDurationS = (leg) =>
    legIsEstimated(leg) ? Math.round(leg.distanceM / NOMINAL_SPEED_MS) : leg.durationS;

  // Every point of the day, in the rider's order. `legs[i]` joins `pointsOf(day)[i]`
  // to `pointsOf(day)[i+1]`, whatever kind either of them is.
  const pointsOf = (day) => day.points || [];

  // Kept for the surfaces that still care which points are stops — the stop
  // count on a ride card, the roadbook's numbered rows, the hand-off to Google
  // Maps. It has nothing to do with the leg math any more.
  const stopsOf = (day) => pointsOf(day).filter((p) => p.kind === "stop");

  const dayRidingS = (day) => day.legs.reduce((n, l) => n + legDurationS(l), 0);
  // BOTH KINDS, from the one list. A rider who spends forty minutes at a
  // viewpoint has spent forty minutes, and the day ends forty minutes later.
  // Most POIs carry no duration at all — you rode past — and contribute nothing.
  const dwellS = (p) => (p.durationMin || 0) * 60;
  const dayStoppedS = (day) => pointsOf(day).reduce((n, p) => n + dwellS(p), 0);
  const dayIsEstimated = (day) => day.legs.some(legIsEstimated);

  // How long a day actually occupies: riding plus every planned stop. This is
  // what the end time is derived from — a two-hour lunch ends the day two hours
  // later than the legs alone say. Deliberately not the same number as the
  // server's days.duration_s, which caches riding time only.
  const dayElapsedS = (day) => dayRidingS(day) + dayStoppedS(day);

  const dayStartS = (day) => (day.startAt ? Math.floor(new Date(day.startAt).getTime() / 1000) : null);

  // A day that lost its alternate group. It is not on the schedule: two
  // alternates for the same Thursday cover the same hours, and without this the
  // timeline puts the rider on both at once and picks whichever comes first in
  // the array.
  //
  // SKIPPED INSIDE THIS FILE, NEVER BY FILTERING THE ARRAY AT A CALL SITE, and
  // the distinction is the whole reason it is here. `activeAtMoment` returns
  // `dayIndex`, which both clients feed straight back into `state.days[i]`,
  // `setLegHighlight(map, i, …)` and `setActive(i)` — those are indices into the
  // FULL array. Hand it a filtered array and every index past the first ghost is
  // off by one, silently, and the map highlights the wrong road.
  const isLosingAlt = (day) => day.altGroup != null && !day.altActive;

  // endAt is normally kept in step by the builder, but a day can carry a start
  // with no end (a stored row we deliberately do not overwrite), so the elapsed
  // figure is the fallback rather than treating the day as instantaneous.
  function dayEndS(day) {
    const start = dayStartS(day);
    if (start == null) return null;
    if (!day.endAt) return start + dayElapsedS(day);
    const end = Math.floor(new Date(day.endAt).getTime() / 1000);
    return Number.isNaN(end) ? start + dayElapsedS(day) : end;
  }

  // One day's extent, which is what the builder's timeline scrubs by default.
  //
  // A LOSING ALTERNATE HAS ONE HERE AND HAS NONE IN rideSpan, and the difference
  // is deliberate. rideSpan answers "how long is this ride", so a day the rider
  // decided against must not stretch it. This answers "what am I looking at",
  // and a rider who has clicked into an alternate to work on it is looking at
  // exactly that day — refusing it a span would hide the timeline on the one day
  // they are editing.
  //
  // Same null contract as rideSpan: an undated day, or one whose end does not
  // come after its start, has no span rather than a zero-width one. A slider
  // whose min equals its max is a control that cannot move.
  function daySpan(day) {
    const from = dayStartS(day);
    if (from == null) return null;
    const to = dayEndS(day);
    return to == null || to <= from ? null : { from, to };
  }

  // The ride's whole extent. Undated days sit outside it rather than stretching
  // it — a rider who has dated day 2 only gets a timeline over day 2.
  function rideSpan(days) {
    let from = null;
    let to = null;
    days.forEach((day) => {
      if (isLosingAlt(day)) return;
      const s = dayStartS(day);
      if (s == null) return;
      const e = dayEndS(day);
      from = from == null ? s : Math.min(from, s);
      to = to == null ? e : Math.max(to, e);
    });
    return from == null || to == null || to <= from ? null : { from, to };
  }

  // The day as an ordered list of segments: parked at a point, riding the leg
  // out of it, parked at the next, and so on.
  //
  // A PLAIN WALK, because every point is on the road now. This used to project
  // each POI onto the concatenated track, sort the POIs by that distance, and
  // emit a leg in pieces so a pause could fall *inside* it at whatever fraction
  // of the way along the POI sat. All of that existed because a POI anchored no
  // leg and so had no place of its own in the sequence. It has one now —
  // `legs[i]` runs from `points[i]` to `points[i+1]` whatever kind either end is
  // — so a pause at a POI lands on a leg boundary like every other pause, and
  // the projection, the sort and the `poiDistsM` argument every caller had to
  // thread through are all gone with it.
  function daySchedule(day) {
    const segs = [];
    const points = pointsOf(day);
    let t = 0;
    for (let i = 0; i < points.length; i++) {
      const dwell = dwellS(points[i]);
      if (dwell > 0) {
        segs.push({ kind: "point", index: i, start: t, end: t + dwell });
        t += dwell;
      }

      // A MISSING LEG IS ABSORBED, not treated as the end of the day. This used
      // to `break`, which silently abandoned every remaining point — their dwell
      // vanished from the schedule while dayElapsedS, which sums the points
      // independently, went on counting it. The two then disagreed, and the
      // invariant that the last segment's end equals dayElapsedS — the one this
      // file's tests call the one that matters most — was quietly false.
      //
      // Every day should arrive here with exactly points-1 legs: fillMissingLegs
      // supplies them in the builder and daySchema refuses a payload without
      // them. So this guards a malformed shape rather than a real one, but a
      // schedule that simply stops early is the kind of wrong nothing reports.
      const leg = day.legs[i];
      if (!leg) continue;
      const riding = legDurationS(leg);
      if (riding > 0) {
        segs.push({ kind: "leg", index: i, start: t, end: t + riding });
        t += riding;
      }
    }
    return segs;
  }

  // Where the rider is at a given offset into the day.
  //
  // A moment spent at a point is on no leg at all, and says so. Highlighting the
  // leg just ridden (or the one about to be) would put a line on the map
  // claiming the rider is somewhere they are not.
  //
  // ONE INDEX INTO `day.points`, where this used to return a `stopIndex` and a
  // `poiIndex` that each indexed their own FILTERED array. That is the same
  // off-by-one trap the isLosingAlt comment above warns about, one level down: a
  // caller holding the ordered list had to filter it the same way to read the
  // answer, and a single index into the list they already have cannot drift.
  function activeAt(day, offsetS) {
    const none = { legIndex: null, pointIndex: null };
    for (const seg of daySchedule(day)) {
      if (offsetS < seg.end) {
        if (seg.kind === "leg") return { ...none, legIndex: seg.index };
        return { ...none, pointIndex: seg.index };
      }
    }
    // Past the end of the day: parked at the final point.
    const n = pointsOf(day).length;
    return { ...none, pointIndex: n ? n - 1 : null };
  }

  // Which day and leg a moment falls in. A moment in the gap between two days —
  // the overnight — belongs to neither, and returns nulls rather than being
  // rounded into the nearest day.
  function activeAtMoment(days, momentS) {
    for (let d = 0; d < days.length; d++) {
      const day = days[d];
      // `continue`, so `d` stays the index into the caller's own array.
      if (isLosingAlt(day)) continue;
      const start = dayStartS(day);
      if (start == null) continue;
      if (momentS < start || momentS > dayEndS(day)) continue;
      const a = activeAt(day, momentS - start);
      return { dayIndex: d, legIndex: a.legIndex, pointIndex: a.pointIndex };
    }
    return { dayIndex: null, legIndex: null, pointIndex: null };
  }

  // UTC, because a day's clock is a WALL CLOCK at the departure point and is
  // carried as UTC — see the header of public/js/day-clock.js. Formatting in the
  // browser's zone is what made the timeline and the printed roadbook disagree
  // by the viewer's offset.
  const fmtMoment = (s) =>
    new Date(s * 1000).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    });

  window.TBTime = {
    NOMINAL_SPEED_MS,
    pointsOf,
    stopsOf,
    legIsEstimated,
    legDurationS,
    dayRidingS,
    dayStoppedS,
    dayIsEstimated,
    dayElapsedS,
    dayStartS,
    dayEndS,
    isLosingAlt,
    daySchedule,
    daySpan,
    rideSpan,
    activeAt,
    activeAtMoment,
    fmtMoment,
  };
})();
