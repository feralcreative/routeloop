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
  const routeStoppedS = (route) => route.stops.reduce((n, s) => n + (s.durationMin || 0) * 60, 0);
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

  // A day, as the timeline sees it: parked at stops[0], riding legs[0], parked
  // at stops[1], riding legs[1], and so on. The two summed are routeElapsedS(),
  // so this walk and the derived end time cannot drift apart.
  //
  // A moment spent at a stop is on no leg at all, and says so. Highlighting the
  // leg just ridden (or the one about to be) would put a line on the map that
  // claims the rider is somewhere they are not.
  function activeAt(route, offsetS) {
    let t = 0;
    for (let i = 0; i < route.stops.length; i++) {
      const dwell = (route.stops[i].durationMin || 0) * 60;
      if (offsetS < t + dwell) return { legIndex: null, stopIndex: i };
      t += dwell;
      const leg = route.legs[i];
      if (!leg) break;
      const riding = legDurationS(leg);
      if (offsetS < t + riding) return { legIndex: i, stopIndex: null };
      t += riding;
    }
    // Past the end of the day: parked at the final stop.
    return { legIndex: null, stopIndex: route.stops.length ? route.stops.length - 1 : null };
  }

  // Which day and leg a moment falls in. A moment in the gap between two days —
  // the overnight — belongs to neither, and returns nulls rather than being
  // rounded into the nearest day.
  function activeAtMoment(routes, momentS) {
    for (let d = 0; d < routes.length; d++) {
      const route = routes[d];
      const start = routeStartS(route);
      if (start == null) continue;
      if (momentS < start || momentS > routeEndS(route)) continue;
      const a = activeAt(route, momentS - start);
      return { dayIndex: d, legIndex: a.legIndex, stopIndex: a.stopIndex };
    }
    return { dayIndex: null, legIndex: null, stopIndex: null };
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
    tripSpan,
    activeAt,
    activeAtMoment,
    fmtMoment,
  };
})();
