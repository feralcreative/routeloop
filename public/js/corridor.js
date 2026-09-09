// How far off the route a place is, and what fits inside a corridor around it.
//
// #50: "a how far off route will you go? slider, then surface candidate stops
// inside that corridor". Searching near a ROUTE is a different question from
// searching near a POINT, and the difference is this file — on a long route the
// question is never "what is near this pin", it is "what can I reach without
// losing an hour".
//
// **POINT TO SEGMENT, NOT POINT TO VERTEX.** nearestVertexIndex() in
// route-shape.js answers a related question and is the wrong tool here: it
// measures to the nearest drawn VERTEX, which is fine on a routed track whose
// vertices are meters apart and badly wrong on a sparse one. An imported GPX
// leg, or the two-point straight line a leg is before the router answers, can
// run a hundred miles between vertices — and a fuel station halfway along it
// would measure as fifty miles off a road it is sitting on.
//
// EQUIRECTANGULAR, NOT HAVERSINE, and deliberately. This projects a few degrees
// of the earth onto a flat plane with a cosine correction on longitude, which
// over the tens of miles a corridor spans is accurate to well under a percent —
// and unlike haversine it gives a plane the perpendicular-distance formula can
// work in at all. The alternative is cross-track distance on a sphere, which is
// more trig per segment on a track that can run to thousands of them, to sharpen
// a number the rider is reading as "about ten miles off".
(function (window) {
  "use strict";

  var R = 6371008.8; // IUGG mean radius, matching haversineM in route-shape.js
  var RAD = Math.PI / 180;

  // What /api/places/search accepts, and therefore the real ceiling on how much
  // corridor one search can reach. Not a preference — the proxy rejects more.
  var MAX_RADIUS_M = 50000;
  var MIN_RADIUS_M = 500;

  /** Meters per degree of latitude, and of longitude at this latitude. */
  function scaleAt(lat) {
    return { x: R * RAD * Math.cos(lat * RAD), y: R * RAD };
  }

  /**
   * The shortest distance in meters from a point to a segment.
   *
   * The projection parameter is CLAMPED to [0, 1], which is what makes this a
   * segment rather than an infinite line: a place beyond either end measures to
   * that end, not to where the road would have gone had it continued.
   */
  function segmentDistanceM(lng, lat, a, b, s) {
    var px = (lng - a[0]) * s.x;
    var py = (lat - a[1]) * s.y;
    var vx = (b[0] - a[0]) * s.x;
    var vy = (b[1] - a[1]) * s.y;
    var len2 = vx * vx + vy * vy;
    // A zero-length segment — two points in the same place, which this app
    // produces deliberately when a point is duplicated — is just its endpoint.
    var t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * vx + py * vy) / len2));
    var dx = px - vx * t;
    var dy = py - vy * t;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * The segment of the track a place sits nearest, and how far off it is.
   *
   * SAME WALK AS offRouteM, WHICH NOW CALLS THIS — the projection was already
   * being run to filter the corridor and to render each hit's "· 2.1 mi off"
   * tip, and the only thing missing was WHICH segment won. #266: throwing that
   * away is what left an Along the route hit with nowhere to go but the end of
   * the route, so a coffee stop found at mile 40 landed after the hotel at mile
   * 300 and the road doubled back on itself.
   *
   * `index` is the segment's START vertex, so the segment is
   * `track[index] → track[index + 1]`. That is the shape legAtVertex() reads,
   * which is what turns this into a row position with no distance arithmetic
   * anywhere: spans[i] lines up with legs[i], so the leg a place projects onto
   * IS the pair of points it belongs between. Measuring an along-distance and
   * comparing it against the summed `leg.distanceM` would work too and would
   * be answering the same question twice in two units — the track is drawn
   * geometry and the legs carry the router's road distance, and the two agree
   * only to within meters.
   *
   * A ONE-POINT TRACK HAS NO SEGMENT and answers index 0, which is the same
   * honest non-answer offRouteM gives: the distance to the only point there is.
   */
  function nearestSegment(lngLat, track) {
    if (!track || !track.length) return null;
    var lng = lngLat[0];
    var lat = lngLat[1];
    var s = scaleAt(lat);
    if (track.length === 1) {
      return { offM: segmentDistanceM(lng, lat, track[0], track[0], s), index: 0 };
    }
    var best = Infinity;
    var at = 0;
    for (var i = 1; i < track.length; i++) {
      var d = segmentDistanceM(lng, lat, track[i - 1], track[i], s);
      // Strictly less, so a place equidistant from two consecutive segments
      // takes the EARLIER one. A tie is what a place square-on to a vertex
      // produces, and landing it a row earlier is the direction this whole
      // change is about: too early is a drag, too late is a road that doubles
      // back.
      if (d < best) {
        best = d;
        at = i - 1;
      }
    }
    return { offM: best, index: at };
  }

  /**
   * How far off the route a place is, in meters. Null for a track with nothing
   * in it — an unrouted route has no road to be off.
   *
   * A ONE-POINT TRACK IS NOT AN ERROR: a route with a single point is a real,
   * saveable shape, and the honest answer there is the distance to that point.
   */
  function offRouteM(lngLat, track) {
    var hit = nearestSegment(lngLat, track);
    return hit ? hit.offM : null;
  }

  /**
   * The places inside a corridor of `radiusM` either side of the track, each
   * annotated with how far off it is, nearest first.
   *
   * ANNOTATED RATHER THAN JUST FILTERED, because "3 mi off" is the number the
   * rider is actually deciding on — a list of eight names that are all
   * "somewhere within twenty miles" has thrown away the thing that ranks them.
   *
   * SORTED BY DETOUR, NOT BY WHAT GOOGLE RANKED FIRST. Text Search ranks by its
   * own idea of relevance and prominence, which on this question is close to
   * noise: a rider asking what they can reach without losing an hour wants the
   * closest one at the top, and a busier station eight miles further away is not
   * a better answer.
   *
   * AN UNROUTED DAY LETS EVERYTHING THROUGH rather than filtering everything
   * out. With no track there is no corridor, and a rider who has just dropped
   * their first point and asked for fuel should get the results Google returned
   * rather than an empty list that reads as "there is no fuel here".
   */
  function withinCorridor(places, track, radiusM) {
    var list = places || [];
    if (!track || !track.length) {
      return list.map(function (p) {
        return { place: p, offRouteM: null };
      });
    }
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var ll = placeLngLat(p);
      if (!ll) continue;
      var hit = nearestSegment(ll, track);
      if (hit == null) continue;
      // `atIndex` RIDES ALONG WITH THE DETOUR because it comes from the same
      // projection — see nearestSegment. It is a vertex index into THIS track,
      // so it only means anything to a caller that knows which track it passed:
      // the route's own concatenated one can be mapped back to a row, a single
      // leg's cannot and does not need to be.
      if (hit.offM <= radiusM) out.push({ place: p, offRouteM: hit.offM, atIndex: hit.index });
    }
    out.sort(function (a, b) {
      return a.offRouteM - b.offRouteM;
    });
    return out;
  }

  /**
   * A place's position, from whichever shape it arrived in. Returns null rather
   * than guessing, so a malformed row is skipped instead of landing at null
   * island.
   *
   * **`lngLat` IS THE SHAPE THE APP ACTUALLY SENDS, AND READING ONLY {lng, lat}
   * SILENTLY EMPTIED EVERY CORRIDOR SEARCH.** #232. `/api/places/search`
   * normalizes a hit to `{name, address, lngLat, type}` and every other reader
   * in builder.js takes `h.lngLat` — this function was the one place that
   * expected a loose `{lng, lat}` pair, which nothing produces. So placeLngLat()
   * returned null for every result, withinCorridor() skipped all of them, and
   * ALONG THE DAY answered \"no gas within 15 mi of this route\" on a route that is
   * lined with gas stations. It failed on every route of every ride from the route
   * #50 shipped, and looked like a routing or a radius problem because the
   * arithmetic underneath it is correct. The unit test missed it for the reason
   * these are always missed: its fixture built the shape the helper wanted
   * rather than the shape the caller sends.
   *
   * Both spellings are accepted rather than the loose pair being dropped — a
   * saved place and a builder point are plain {lng, lat} objects, and a helper
   * that reads a position should not care which of the app's two spellings it
   * was handed.
   */
  function placeLngLat(p) {
    if (!p) return null;
    var pair = p.lngLat;
    if (pair && typeof pair.length === "number" && pair.length >= 2) {
      return finitePair(pair[0], pair[1]);
    }
    return finitePair(p.lng, p.lat);
  }

  /** A [lng, lat] pair, or null if either half is not a real number. */
  function finitePair(lng, lat) {
    if (typeof lng !== "number" || typeof lat !== "number") return null;
    if (!isFinite(lng) || !isFinite(lat)) return null;
    return [lng, lat];
  }

  /**
   * Where along a route to run a corridor search, and how wide to bias each one.
   * Returns `[{ atM, radiusM }]`, distances along the track from its start.
   *
   * IN HERE RATHER THAN IN THE CLICK HANDLER, for the reason drag-index.js is a
   * file: it is arithmetic, a test can reach it here and could not reach it
   * inside builder.js, and the cost of getting it wrong is a billed API call per
   * sample. Same rule, same reason.
   *
   * **ONE CALL CANNOT ENUMERATE A LONG CORRIDOR.** Text Search takes a
   * locationBias, which REORDERS rather than restricts, and answers with at most
   * twenty hits. Anchored once at the midpoint of a 300-mile route those twenty
   * are drawn from an area far larger than the corridor, so the stations
   * actually on the road can miss the list while the filter works perfectly.
   *
   * SPACED BY THE CORRIDOR'S OWN DIAMETER, so consecutive samples overlap rather
   * than leaving a gap as wide as the thing being looked for. Each sits at the
   * CENTER of its span, never at distance zero, where half the radius would hang
   * off the back of the route.
   *
   * CAPPED, because Text Search is billed per REQUEST — the cap is the ceiling
   * on what one chip tap can spend, so a route long enough to reach it gets
   * coverage that thins rather than a bill that grows with its length.
   */
  function corridorSamples(totalM, corridorM, maxSamples) {
    if (!(totalM > 0) || !(corridorM > 0)) return [];
    var cap = maxSamples > 0 ? Math.floor(maxSamples) : 1;

    // ENOUGH SAMPLES THAT THE CIRCLES ACTUALLY TOUCH, which is what this
    // function always claimed and stopped doing the moment the clamp was added.
    //
    // The radius wants to be `step / 2 + corridorM` so consecutive circles
    // overlap. The proxy accepts at most 50 km, so past a certain route length the
    // clamp silently cut the reach and left HOLES — measured on a real 593-mile
    // route: six samples 99 miles apart with a radius clamped from 95 miles to 31,
    // so 37 miles between every pair of circles went unsearched and the answer
    // to "gas between Burbank and Anaheim" was nothing at all. The comment above
    // the old radius said the circles overlapped; it had been false for every
    // route over about 190 miles.
    //
    // So the COUNT is derived from the reach rather than the reach being
    // squeezed to fit a fixed count: at most 2 × MAX_RADIUS_M of corridor per
    // sample. A short route needs fewer samples than the old fixed six, which is
    // cheaper as well as more correct — a 300-mile route drops from six searches
    // to five.
    // `want` is the MINIMUM that covers the route given the clamp. The second term
    // is the older, denser rule — one sample per corridor diameter — and it is
    // kept as a floor rather than replaced, because geometric coverage is not
    // the whole story: `locationBias` only REORDERS, so a circle that covers a
    // span still returns its twenty results ranked around the CENTER, and a
    // station near the edge of a sparsely anchored circle can simply not make
    // the list. More anchors is more chances. The cap is what bounds the bill.
    var want = Math.ceil(totalM / (2 * MAX_RADIUS_M));
    var n = Math.max(1, Math.min(cap, Math.max(want, Math.ceil(totalM / (2 * corridorM)))));
    var step = totalM / n;
    // CEIL RATHER THAN ROUND, because the proxy wants an integer and rounding a
    // reach DOWN is exactly what opens the gap this radius exists to close. At a
    // route of precisely 2 × corridorM × cap the two are equal to the meter, and
    // Math.round took a third of a meter off it — invisible in use and wrong in
    // the one direction that matters.
    var radiusM = Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, Math.ceil(step / 2 + corridorM)));
    var out = [];
    for (var i = 0; i < n; i++) out.push({ atM: (i + 0.5) * step, radiusM: radiusM });
    return out;
  }

  /**
   * Whether the samples cover the whole route, or leave gaps between the circles.
   *
   * FALSE IS A REAL ANSWER AND HAS TO BE SHOWN. Even with the count derived
   * above, a long enough route runs into `cap` and the circles stop touching
   * again — and a partly searched route that reports nothing is indistinguishable
   * from a stretch of road with no fuel on it. That was the whole defect: the
   * rider is entitled to know which of the two they are looking at.
   */
  function samplesCoverAll(samples, totalM) {
    if (!samples || !samples.length || !(totalM > 0)) return false;
    var step = totalM / samples.length;
    return 2 * samples[0].radiusM >= step;
  }

  window.TBCorridor = {
    offRouteM: offRouteM,
    nearestSegment: nearestSegment,
    withinCorridor: withinCorridor,
    placeLngLat: placeLngLat,
    corridorSamples: corridorSamples,
    samplesCoverAll: samplesCoverAll,
  };
})(typeof window !== "undefined" ? window : this);
