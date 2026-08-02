// The trip's time model, shared by the builder and the viewer. Exposes
// window.TBTime.
//
// It lives apart from both because they have to agree: the builder decides what
// is active at a moment from the legs it holds in memory, the viewer decides it
// from the legs ride.json sends, and the same ride must resolve identically in
// each. Two copies of this walk would drift, and the drift would show up as a
// map highlighting a different road than the one the planner saw.
//
// Everything here works on the shape both sides already use — a route with
// `startAt` / `endAt`, `legs[{ durationS, distanceM }]` and
// `stops[{ durationMin }]` — so neither side has to reshape its data first.
(function () {
  "use strict";

  // Fallback riding speed for a leg the router never answered for, matching the
  // 20 m/s (~45 mph) the demo seeder uses. Rough twice over — it is applied to a
  // haversine distance, which is shorter than the road — so anything derived
  // from it is labelled an estimate rather than presented as a duration.
  const NOMINAL_SPEED_MS = 20;

  // A leg with distance but no duration never came back from the router, so its
  // time is estimated from distance. Deriving this rather than storing a flag
  // means a reloaded ride reports the same figures as the session that built it,
  // and an imported ride — which carries its whole track as one leg with no
  // duration at all — gets a plausible span instead of a zero-length day.
  const legIsEstimated = (leg) => leg.durationS <= 0 && leg.distanceM > 0;
  const legDurationS = (leg) =>
    legIsEstimated(leg) ? Math.round(leg.distanceM / NOMINAL_SPEED_MS) : leg.durationS;

  const routeRidingS = (route) => route.legs.reduce((n, l) => n + legDurationS(l), 0);
  // Stops AND POIs. A POI is not a routing anchor and never splits a leg, but a
  // rider who spends forty minutes at a viewpoint has spent forty minutes, and
  // the day ends forty minutes later. Most POIs carry no duration at all — you
  // rode past — and contribute nothing.
  const dwellS = (p) => (p.durationMin || 0) * 60;
  const routeStoppedS = (route) =>
    route.stops.reduce((n, s) => n + dwellS(s), 0) + (route.pois || []).reduce((n, p) => n + dwellS(p), 0);
  const routeIsEstimated = (route) => route.legs.some(legIsEstimated);

  // How long a day actually occupies: riding plus every planned stop. This is
  // what the end time is derived from — a two-hour lunch ends the day two hours
  // later than the legs alone say. Deliberately not the same number as the
  // server's routes.duration_s, which caches riding time only.
  const routeElapsedS = (route) => routeRidingS(route) + routeStoppedS(route);

  const routeStartS = (route) => (route.startAt ? Math.floor(new Date(route.startAt).getTime() / 1000) : null);

  // endAt is normally kept in step by the builder, but a route can carry a start
  // with no end (a stored row we deliberately do not overwrite), so the elapsed
  // figure is the fallback rather than treating the day as instantaneous.
  function routeEndS(route) {
    const start = routeStartS(route);
    if (start == null) return null;
    if (!route.endAt) return start + routeElapsedS(route);
    const end = Math.floor(new Date(route.endAt).getTime() / 1000);
    return Number.isNaN(end) ? start + routeElapsedS(route) : end;
  }

  // The trip's whole extent. Undated days sit outside it rather than stretching
  // it — a rider who has dated day 2 only gets a timeline over day 2.
  function tripSpan(routes) {
    let from = null;
    let to = null;
    routes.forEach((route) => {
      const s = routeStartS(route);
      if (s == null) return;
      const e = routeEndS(route);
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
  // routePoiDistances in twist.js). Omitting the argument falls back to the
  // stored value, which is what the viewer wants.
  //
  // A POI with no duration is left out entirely: riding past something changes
  // nothing about when the day ends.
  function routeSchedule(route, poiDistsM) {
    const segs = [];
    const prefix = [0];
    for (const l of route.legs) prefix.push(prefix[prefix.length - 1] + (l.distanceM || 0));

    const stops = (route.pois || [])
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
    for (let i = 0; i < route.stops.length; i++) {
      const dwell = dwellS(route.stops[i]);
      if (dwell > 0) segs.push({ kind: "stop", index: i, start: t, end: t + dwell });
      t += dwell;

      const leg = route.legs[i];
      if (!leg) break;
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
  function activeAt(route, offsetS, poiDistsM) {
    const none = { legIndex: null, stopIndex: null, poiIndex: null };
    for (const seg of routeSchedule(route, poiDistsM)) {
      if (offsetS < seg.end) {
        if (seg.kind === "leg") return { ...none, legIndex: seg.index };
        if (seg.kind === "stop") return { ...none, stopIndex: seg.index };
        return { ...none, poiIndex: seg.index };
      }
    }
    // Past the end of the day: parked at the final stop.
    return { ...none, stopIndex: route.stops.length ? route.stops.length - 1 : null };
  }

  // Which day and leg a moment falls in. A moment in the gap between two days —
  // the overnight — belongs to neither, and returns nulls rather than being
  // rounded into the nearest day.
  function activeAtMoment(routes, momentS, poiDistsM) {
    for (let d = 0; d < routes.length; d++) {
      const route = routes[d];
      const start = routeStartS(route);
      if (start == null) continue;
      if (momentS < start || momentS > routeEndS(route)) continue;
      const a = activeAt(route, momentS - start, poiDistsM && poiDistsM[d]);
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
    routeRidingS,
    routeStoppedS,
    routeIsEstimated,
    routeElapsedS,
    routeStartS,
    routeEndS,
    routeSchedule,
    tripSpan,
    activeAt,
    activeAtMoment,
    fmtMoment,
  };
})();
