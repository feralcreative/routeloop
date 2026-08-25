// The ride's time model, shared by the builder and the viewer. Exposes
// window.TBTime.
//
// It lives apart from both because they have to agree: the builder decides what
// is active at a moment from the legs it holds in memory, the viewer decides it
// from the legs ride.json sends, and the same ride must resolve identically in
// each. Two copies of this walk would drift, and the drift would show up as a
// map highlighting a different road than the one the planner saw.
//
// TWO DAY SHAPES REACH THIS MODULE, and it accepts both rather than making
// either caller reshape first. The builder holds one ordered `points` array with
// a `kind` on each element (2026-08-23); `ride.json` still sends `stops` and
// `pois` as two arrays, deliberately, because the viewer never renders points as
// a sequence. stopsOf/poisOf below are the only place that difference is known,
// and every other line here reads through them.
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

  // The shape bridge. A day either carries `points` with per-element kinds, or
  // the older pair of arrays. Nothing below this line tests for which.
  const stopsOf = (day) => (day.points ? day.points.filter((p) => p.kind === "stop") : day.stops || []);
  const poisOf = (day) => (day.points ? day.points.filter((p) => p.kind === "poi") : day.pois || []);

  const dayRidingS = (day) => day.legs.reduce((n, l) => n + legDurationS(l), 0);
  // Stops AND POIs. A POI is not a routing anchor and never splits a leg, but a
  // rider who spends forty minutes at a viewpoint has spent forty minutes, and
  // the day ends forty minutes later. Most POIs carry no duration at all — you
  // rode past — and contribute nothing.
  const dwellS = (p) => (p.durationMin || 0) * 60;
  const dayStoppedS = (day) =>
    stopsOf(day).reduce((n, s) => n + dwellS(s), 0) + poisOf(day).reduce((n, p) => n + dwellS(p), 0);
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

  // The day as an ordered list of segments: parked at a stop, riding part of a
  // leg, paused at a POI, riding the rest of that leg, and so on.
  //
  // This used to be a walk that alternated stop-dwell and leg-riding, which had
  // no place to put a POI. A POI is not a routing anchor — it splits no leg and
  // the router never sees it — so a pause at one falls *inside* a leg, at
  // whatever fraction of the way along it the POI sits. Building the day as data
  // rather than as control flow is what makes that expressible, and it is
  // testable in a way the walk was not.
  //
  // POI distances are supplied by the caller because the two callers know them
  // differently: the viewer reads distFromStartMi straight out of ride.json,
  // while the builder computes them live from the current geometry (see
  // dayPoiDistances in twist.js). Omitting the argument falls back to the
  // stored value, which is what the viewer wants.
  //
  // A POI with no duration is left out entirely: riding past something changes
  // nothing about when the day ends.
  function daySchedule(day, poiDistsM) {
    const segs = [];
    const prefix = [0];
    for (const l of day.legs) prefix.push(prefix[prefix.length - 1] + (l.distanceM || 0));

    const stops = poisOf(day)
      .map((p, i) => ({
        i,
        dur: dwellS(p),
        d: poiDistsM
          ? poiDistsM[i] || 0
          : p.distFromStartMi != null
            ? p.distFromStartMi * 1609.344
            : 0,
      }))
      .filter((p) => p.dur > 0)
      .sort((a, b) => a.d - b.d);

    let t = 0;
    let poiIdx = 0;
    const dayStops = stopsOf(day);
    for (let i = 0; i < dayStops.length; i++) {
      const dwell = dwellS(dayStops[i]);
      if (dwell > 0) segs.push({ kind: "stop", index: i, start: t, end: t + dwell });
      t += dwell;

      // CONTINUE, NOT BREAK, and the difference was a real bug worth naming.
      //
      // This used to `break` on the first missing leg, which silently abandoned
      // every remaining stop — their dwell vanished from the schedule while
      // dayElapsedS, which sums the stops independently, went on counting it.
      // The two then disagreed, and the invariant that the last segment's end
      // equals dayElapsedS — the one this file's tests call the one that matters
      // most — was quietly false.
      //
      // It was reachable for real: an imported ride was stored as ONE leg
      // holding the whole track however many stops sat along it, so on every
      // imported ride with more than two stops the timeline ran short by the
      // sum of all their dwell. Imports carry proper legs now
      // (src/maps/track-split.ts) and the builder fills any gap on load, so the
      // shape should not arrive here from either direction — but a schedule that
      // simply stops early is the kind of wrong that nothing reports, so it
      // absorbs the shape rather than trusting that.
      const leg = day.legs[i];
      if (!leg) continue;
      const riding = legDurationS(leg);
      const from = prefix[i];
      const span = prefix[i + 1] - from;

      // Emit the leg in pieces, pausing wherever a POI falls inside it.
      let ridden = 0;
      while (poiIdx < stops.length && stops[poiIdx].d < prefix[i + 1]) {
        const p = stops[poiIdx];
        const frac = span > 0 ? Math.max(0, Math.min(1, (p.d - from) / span)) : 0;
        const at = riding * frac;
        if (at > ridden) {
          segs.push({ kind: "leg", index: i, start: t, end: t + (at - ridden) });
          t += at - ridden;
          ridden = at;
        }
        segs.push({ kind: "poi", index: p.i, start: t, end: t + p.dur });
        t += p.dur;
        poiIdx++;
      }
      if (riding > ridden) {
        segs.push({ kind: "leg", index: i, start: t, end: t + (riding - ridden) });
        t += riding - ridden;
      }
    }

    // A POI projected past the end of the last leg — off-route, or on a day
    // whose track stops short. It still takes its time; it takes it at the end.
    while (poiIdx < stops.length) {
      const p = stops[poiIdx++];
      segs.push({ kind: "poi", index: p.i, start: t, end: t + p.dur });
      t += p.dur;
    }

    return segs;
  }

  // Where the rider is at a given offset into the day.
  //
  // A moment spent at a stop or a POI is on no leg at all, and says so.
  // Highlighting the leg just ridden (or the one about to be) would put a line
  // on the map claiming the rider is somewhere they are not.
  function activeAt(day, offsetS, poiDistsM) {
    const none = { legIndex: null, stopIndex: null, poiIndex: null };
    for (const seg of daySchedule(day, poiDistsM)) {
      if (offsetS < seg.end) {
        if (seg.kind === "leg") return { ...none, legIndex: seg.index };
        if (seg.kind === "stop") return { ...none, stopIndex: seg.index };
        return { ...none, poiIndex: seg.index };
      }
    }
    // Past the end of the day: parked at the final stop.
    return { ...none, stopIndex: stopsOf(day).length ? stopsOf(day).length - 1 : null };
  }

  // Which day and leg a moment falls in. A moment in the gap between two days —
  // the overnight — belongs to neither, and returns nulls rather than being
  // rounded into the nearest day.
  function activeAtMoment(days, momentS, poiDistsM) {
    for (let d = 0; d < days.length; d++) {
      const day = days[d];
      // `continue`, so `d` stays the index into the caller's own array.
      if (isLosingAlt(day)) continue;
      const start = dayStartS(day);
      if (start == null) continue;
      if (momentS < start || momentS > dayEndS(day)) continue;
      const a = activeAt(day, momentS - start, poiDistsM && poiDistsM[d]);
      return { dayIndex: d, legIndex: a.legIndex, stopIndex: a.stopIndex, poiIndex: a.poiIndex };
    }
    return { dayIndex: null, legIndex: null, stopIndex: null, poiIndex: null };
  }

  const fmtMoment = (s) =>
    new Date(s * 1000).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  window.TBTime = {
    NOMINAL_SPEED_MS,
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
    rideSpan,
    activeAt,
    activeAtMoment,
    fmtMoment,
  };
})();
