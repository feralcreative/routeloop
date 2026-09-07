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
  // duration at all — gets a plausible span instead of a zero-length route.
  const legIsEstimated = (leg) => leg.durationS <= 0 && leg.distanceM > 0;
  const legDurationS = (leg) => (legIsEstimated(leg) ? Math.round(leg.distanceM / NOMINAL_SPEED_MS) : leg.durationS);

  // Every point of the route, in the rider's order. `legs[i]` joins `pointsOf(route)[i]`
  // to `pointsOf(route)[i+1]`, whatever kind either of them is.
  const pointsOf = (route) => route.points || [];

  // Kept for the surfaces that still care which points are stops — the stop
  // count on a ride card, the roadbook's numbered rows, the hand-off to Google
  // Maps. It has nothing to do with the leg math any more.
  const stopsOf = (route) => pointsOf(route).filter((p) => p.kind === "stop");

  const routeRidingS = (route) => route.legs.reduce((n, l) => n + legDurationS(l), 0);
  // BOTH KINDS, from the one list. A rider who spends forty minutes at a
  // viewpoint has spent forty minutes, and the route ends forty minutes later.
  // Most POIs carry no duration at all — you rode past — and contribute nothing.
  const dwellS = (p) => (p.durationMin || 0) * 60;
  const routeStoppedS = (route) => pointsOf(route).reduce((n, p) => n + dwellS(p), 0);
  const routeIsEstimated = (route) => route.legs.some(legIsEstimated);

  // How long a route actually occupies: riding plus every planned stop. This is
  // what the end time is derived from — a two-hour lunch ends the route two hours
  // later than the legs alone say. Deliberately not the same number as the
  // server's routes.duration_s, which caches riding time only.
  const routeElapsedS = (route) => routeRidingS(route) + routeStoppedS(route);

  const routeStartS = (route) => (route.startAt ? Math.floor(new Date(route.startAt).getTime() / 1000) : null);

  // A route that lost its alternate group. It is not on the schedule: two
  // alternates for the same Thursday cover the same hours, and without this the
  // timeline puts the rider on both at once and picks whichever comes first in
  // the array.
  //
  // SKIPPED INSIDE THIS FILE, NEVER BY FILTERING THE ARRAY AT A CALL SITE, and
  // the distinction is the whole reason it is here. `activeAtMoment` returns
  // `routeIndex`, which both clients feed straight back into `state.routes[i]`,
  // `setLegHighlight(map, i, …)` and `setActive(i)` — those are indices into the
  // FULL array. Hand it a filtered array and every index past the first ghost is
  // off by one, silently, and the map highlights the wrong road.
  const isLosingAlt = (route) => route.altGroup != null && !route.altActive;

  // endAt is normally kept in step by the builder, but a route can carry a start
  // with no end (a stored row we deliberately do not overwrite), so the elapsed
  // figure is the fallback rather than treating the route as instantaneous.
  function routeEndS(route) {
    const start = routeStartS(route);
    if (start == null) return null;
    if (!route.endAt) return start + routeElapsedS(route);
    const end = Math.floor(new Date(route.endAt).getTime() / 1000);
    return Number.isNaN(end) ? start + routeElapsedS(route) : end;
  }

  // One route's extent, which is what the builder's timeline scrubs by default.
  //
  // A LOSING ALTERNATE HAS ONE HERE AND HAS NONE IN rideSpan, and the difference
  // is deliberate. rideSpan answers "how long is this ride", so a route the rider
  // decided against must not stretch it. This answers "what am I looking at",
  // and a rider who has clicked into an alternate to work on it is looking at
  // exactly that route — refusing it a span would hide the timeline on the one route
  // they are editing.
  //
  // Same null contract as rideSpan: an undated route, or one whose end does not
  // come after its start, has no span rather than a zero-width one. A slider
  // whose min equals its max is a control that cannot move.
  function routeSpan(route) {
    const from = routeStartS(route);
    if (from == null) return null;
    const to = routeEndS(route);
    return to == null || to <= from ? null : { from, to };
  }

  // The ride's whole extent. Undated routes sit outside it rather than stretching
  // it — a rider who has dated route 2 only gets a timeline over route 2.
  function rideSpan(routes) {
    let from = null;
    let to = null;
    routes.forEach((route) => {
      if (isLosingAlt(route)) return;
      const s = routeStartS(route);
      if (s == null) return;
      const e = routeEndS(route);
      from = from == null ? s : Math.min(from, s);
      to = to == null ? e : Math.max(to, e);
    });
    return from == null || to == null || to <= from ? null : { from, to };
  }

  // The route as an ordered list of segments: parked at a point, riding the leg
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
  function routeSchedule(route) {
    const segs = [];
    const points = pointsOf(route);
    let t = 0;
    for (let i = 0; i < points.length; i++) {
      const dwell = dwellS(points[i]);
      if (dwell > 0) {
        segs.push({ kind: "point", index: i, start: t, end: t + dwell });
        t += dwell;
      }

      // A MISSING LEG IS ABSORBED, not treated as the end of the route. This used
      // to `break`, which silently abandoned every remaining point — their dwell
      // vanished from the schedule while routeElapsedS, which sums the points
      // independently, went on counting it. The two then disagreed, and the
      // invariant that the last segment's end equals routeElapsedS — the one this
      // file's tests call the one that matters most — was quietly false.
      //
      // Every route should arrive here with exactly points-1 legs: fillMissingLegs
      // supplies them in the builder and routeSchema refuses a payload without
      // them. So this guards a malformed shape rather than a real one, but a
      // schedule that simply stops early is the kind of wrong nothing reports.
      const leg = route.legs[i];
      if (!leg) continue;
      const riding = legDurationS(leg);
      if (riding > 0) {
        segs.push({ kind: "leg", index: i, start: t, end: t + riding });
        t += riding;
      }
    }
    return segs;
  }

  /**
   * Seconds from a route's departure until the rider ARRIVES at point `i`.
   *
   * The dwell of every point before it plus the riding time of every leg before
   * it — and deliberately NOT the dwell of `i` itself, because arriving is the
   * moment the group is there and what a meeting point is agreed on. Including
   * it would answer "when do they leave the meeting point", which nobody is
   * synchronizing.
   *
   * IT IS A WALK, NOT A LOOKUP INTO routeSchedule(). That function omits a
   * zero-length segment entirely — a point with no dwell, a leg with no duration
   * — so its indices are not point indices, and finding "the segment for point
   * i" in it is the same off-by-one this file already warns about twice.
   *
   * Null when `i` is out of range, which is a real answer rather than a guard: a
   * caller asking about a point that is not there is holding a stale index, and
   * returning 0 would read as "they arrive at the moment they set off".
   */
  function elapsedToPointS(route, i) {
    const points = pointsOf(route);
    if (!Number.isInteger(i) || i < 0 || i >= points.length) return null;
    let t = 0;
    for (let k = 0; k < i; k++) {
      t += dwellS(points[k]);
      const leg = route.legs && route.legs[k];
      if (leg) t += legDurationS(leg);
    }
    return t;
  }

  /**
   * Seconds into a route at which the clock next reads `minuteOfDay`.
   *
   * WALL CLOCK THROUGHOUT, with no zone anywhere: `startAt` is a time at the
   * departure point carried as UTC, and `minuteOfDay` is "four in the afternoon"
   * meaning four where the bike is. Reading either in the browser's zone is the
   * bug route-clock.js exists to prevent.
   *
   * WRAPS TO THE NEXT DAY when the target has already passed at departure — a
   * route setting off at 6pm reaches 4pm twenty-two hours later, not two hours
   * ago. That matters less for a bed than it looks: the caller checks the answer
   * against the route's own length, and a twenty-two-hour offset simply falls off
   * the end of every real route, which is the correct outcome rather than a
   * special case.
   *
   * Null when the route has no departure time, because there is nothing to count
   * from — not zero, which would read as "at the moment they set off".
   */
  function offsetAtClock(route, minuteOfDay) {
    var start = routeStartS(route);
    if (start == null) return null;
    if (!Number.isFinite(minuteOfDay)) return null;
    var startedAt = new Date(start * 1000);
    var startMin = startedAt.getUTCHours() * 60 + startedAt.getUTCMinutes();
    var delta = (Math.round(minuteOfDay) - startMin + 1440) % 1440;
    return delta * 60 - startedAt.getUTCSeconds();
  }

  /**
   * Where the rider is when the clock reads `minuteOfDay`, or null when the route
   * ends before it does.
   *
   * NULL IS THE COMMON ANSWER AND IS NOT A FAILURE. A route that finishes at 2pm
   * never reaches 4pm, and the honest thing is to say so rather than pinning the
   * marker to the last point — which would put "look for a bed here" on the
   * hotel they already arrived at.
   */
  function clockMoment(route, minuteOfDay) {
    var offset = offsetAtClock(route, minuteOfDay);
    if (offset == null || offset < 0) return null;
    if (offset > routeElapsedS(route)) return null;
    return { offsetS: offset, at: activeAt(route, offset) };
  }

  // Where the rider is at a given offset into the route.
  //
  // A moment spent at a point is on no leg at all, and says so. Highlighting the
  // leg just ridden (or the one about to be) would put a line on the map
  // claiming the rider is somewhere they are not.
  //
  // ONE INDEX INTO `route.points`, where this used to return a `stopIndex` and a
  // `poiIndex` that each indexed their own FILTERED array. That is the same
  // off-by-one trap the isLosingAlt comment above warns about, one level down: a
  // caller holding the ordered list had to filter it the same way to read the
  // answer, and a single index into the list they already have cannot drift.
  //
  // `legFraction` is HOW FAR THROUGH THAT LEG, 0..1, and null at a point. It is
  // what lets a caller put the rider somewhere on the road rather than only on
  // one of its ends: distance into the route is the legs before this one plus
  // this fraction of it, which is a coordinate through pointAtDistance(). A
  // caller that only wants the leg ignores it and reads the same shape it read
  // before, which is why it is an added field rather than a new function.
  //
  // Fraction of TIME, not of distance, and the two differ on a leg whose speed
  // is not constant — which is every real one. Time is the axis the scrubber
  // moves along, so it is the honest one here: an hour into a two-hour leg puts
  // the dot at the halfway mark, and the alternative would have the dot lag or
  // race the clock the rider is reading beside it.
  function activeAt(route, offsetS) {
    const none = { legIndex: null, pointIndex: null, legFraction: null };
    for (const seg of routeSchedule(route)) {
      if (offsetS < seg.end) {
        if (seg.kind === "leg") {
          const span = seg.end - seg.start;
          // A zero-length segment never satisfies the test above, so `span` is
          // positive here; the guard is for a malformed schedule rather than a
          // real one, and 0 is the only answer such a leg has.
          const t = span > 0 ? (offsetS - seg.start) / span : 0;
          return { ...none, legIndex: seg.index, legFraction: Math.max(0, Math.min(1, t)) };
        }
        return { ...none, pointIndex: seg.index };
      }
    }
    // Past the end of the route: parked at the final point.
    const n = pointsOf(route).length;
    return { ...none, pointIndex: n ? n - 1 : null };
  }

  /**
   * The ride's riding hours as a set of disjoint wall-clock intervals — every
   * route's span, with the overnights between them left out.
   *
   * WHAT THE RIDE-SCOPE SLIDER TRAVELS. rideSpan() is first-departure to
   * last-arrival, so on a nine-route ride most of the slider's travel is nights
   * in hotels: a rider dragging it spends more of the gesture in "between routes"
   * than on the road, and the map shows nothing for all of it.
   *
   * OVERLAPS ARE MERGED, NOT CONCATENATED, and that is the subtle half. Real
   * rides have routes sharing a date — four alternates for one Thursday, or a
   * subgroup's feeder running alongside the trunk — and activeAtMoment()
   * resolves a wall-clock moment to the FIRST route covering it. Concatenating
   * overlapping spans would give the slider two positions that mean the same
   * instant and therefore resolve to the same route, so the second copy would be
   * unreachable travel showing a route the rider is not scrubbing. Merging keeps
   * one position per instant, which is exactly what the resolver can answer.
   *
   * Losing alternates are dropped, matching rideSpan() rather than routeSpan():
   * the ride's length must not include a route the rider decided against.
   */
  function rideSegments(routes) {
    const spans = [];
    for (const route of routes || []) {
      if (isLosingAlt(route)) continue;
      const s = routeSpan(route);
      if (s) spans.push(s);
    }
    spans.sort((a, b) => a.from - b.from);
    const out = [];
    for (const s of spans) {
      const last = out[out.length - 1];
      // `<=` rather than `<`, so a route starting exactly when the previous one
      // ends joins it instead of leaving a zero-length gap the slider would
      // have to step over.
      if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
      else out.push({ from: s.from, to: s.to });
    }
    return out;
  }

  /** Total riding time across the segments, which is the slider's range. */
  const segmentsTotalS = (segs) => (segs || []).reduce((a, s) => a + (s.to - s.from), 0);

  /**
   * The wall-clock moment `offsetS` into the segments, skipping the gaps.
   *
   * The slider's value is an OFFSET in ride scope and an epoch second in route
   * scope, but `state.moment` is always an epoch second — everything
   * downstream, activeAtMoment and fmtMoment included, reads wall clock. This
   * and offsetAtMoment are the only conversion, and they are here rather than
   * in each client so the builder and the viewer cannot disagree about where a
   * given drag lands.
   */
  function momentAtOffset(segs, offsetS) {
    if (!segs || !segs.length) return null;
    let o = Math.max(0, offsetS);
    for (const s of segs) {
      const len = s.to - s.from;
      // STRICTLY LESS, so the boundary offset belongs to the LATER route.
      //
      // One offset means two instants there — the end of route N and the start of
      // route N+1 — and only one can win. The next route's start wins because it is
      // a real, labeled time the rider typed into the Starts field, while route
      // N's final second is visually identical to its second-to-last. Taken the
      // other way the round trip through offsetAtMoment breaks, and with the
      // slider's 60-second step every route after the first became unreachable at
      // its own departure time.
      //
      // A zero-length route consumes no travel, correctly: `o < 0` is never true.
      if (o < len) return s.from + o;
      o -= len;
    }
    return segs[segs.length - 1].to;
  }

  /**
   * Where a moment sits on that compressed axis. A moment inside an overnight
   * lands at the START of the gap rather than the end of it: the gap has no
   * travel of its own, and rounding forward would jump a rider who has just
   * clicked into the next route back to the previous one's last second.
   */
  function offsetAtMoment(segs, momentS) {
    let acc = 0;
    for (const s of segs || []) {
      if (momentS < s.from) return acc;
      if (momentS <= s.to) return acc + (momentS - s.from);
      acc += s.to - s.from;
    }
    return acc;
  }

  // Which route and leg a moment falls in. A moment in the gap between two routes —
  // the overnight — belongs to neither, and returns nulls rather than being
  // rounded into the nearest route.
  function activeAtMoment(routes, momentS) {
    for (let d = 0; d < routes.length; d++) {
      const route = routes[d];
      // `continue`, so `d` stays the index into the caller's own array.
      if (isLosingAlt(route)) continue;
      const start = routeStartS(route);
      if (start == null) continue;
      if (momentS < start || momentS > routeEndS(route)) continue;
      const a = activeAt(route, momentS - start);
      return { routeIndex: d, legIndex: a.legIndex, pointIndex: a.pointIndex, legFraction: a.legFraction };
    }
    return { routeIndex: null, legIndex: null, pointIndex: null, legFraction: null };
  }

  // UTC, because a route's clock is a WALL CLOCK at the departure point and is
  // carried as UTC — see the header of public/js/route-clock.js. Formatting in the
  // browser's zone is what made the timeline and the printed roadbook disagree
  // by the viewer's offset.
  //
  // `pref` IS PASSED IN RATHER THAN READ OFF `document`, because this module is
  // one of the fourteen pure client helpers — it is eval'd by its own test with
  // no DOM at all, and a `document.documentElement` here would take that test
  // with it. builder.js reads it from TBFmt and hands it over; an absent one
  // leaves both fields undefined, which is the browser locale and exactly what
  // this did before the preference existed.
  const fmtMoment = (s, pref) =>
    new Date(s * 1000).toLocaleString((pref && pref.locale) || undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: pref && pref.hour12,
      timeZone: "UTC",
    });

  window.TBTime = {
    NOMINAL_SPEED_MS,
    pointsOf,
    stopsOf,
    legIsEstimated,
    legDurationS,
    routeRidingS,
    routeStoppedS,
    routeIsEstimated,
    routeElapsedS,
    routeStartS,
    routeEndS,
    isLosingAlt,
    routeSchedule,
    elapsedToPointS,
    offsetAtClock,
    clockMoment,
    routeSpan,
    rideSpan,
    rideSegments,
    segmentsTotalS,
    momentAtOffset,
    offsetAtMoment,
    activeAt,
    activeAtMoment,
    fmtMoment,
  };
})();
