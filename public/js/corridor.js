// How far off the route a place is, and what fits inside a corridor around it.
//
// #50: "a how far off route will you go? slider, then surface candidate stops
// inside that corridor". Searching near a ROUTE is a different question from
// searching near a POINT, and the difference is this file — on a long day the
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
   * How far off the route a place is, in meters. Null for a track with nothing
   * in it — an unrouted day has no road to be off.
   *
   * A ONE-POINT TRACK IS NOT AN ERROR: a day with a single point is a real,
   * saveable shape, and the honest answer there is the distance to that point.
   */
  function offRouteM(lngLat, track) {
    if (!track || !track.length) return null;
    var lng = lngLat[0];
    var lat = lngLat[1];
    var s = scaleAt(lat);
    if (track.length === 1) return segmentDistanceM(lng, lat, track[0], track[0], s);
    var best = Infinity;
    for (var i = 1; i < track.length; i++) {
      var d = segmentDistanceM(lng, lat, track[i - 1], track[i], s);
      if (d < best) best = d;
    }
    return best;
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
      var off = offRouteM(ll, track);
      if (off != null && off <= radiusM) out.push({ place: p, offRouteM: off });
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
   * ALONG THE DAY answered \"no gas within 15 mi of this day\" on a route that is
   * lined with gas stations. It failed on every day of every ride from the day
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

  window.TBCorridor = {
    offRouteM: offRouteM,
    withinCorridor: withinCorridor,
    placeLngLat: placeLngLat,
  };
})(typeof window !== "undefined" ? window : this);
