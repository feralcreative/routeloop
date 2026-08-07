// The arithmetic behind drag-to-shape.
//
// A day is drawn as ONE polyline — the concatenated geometry of all its legs —
// so a drag gives back a vertex index into that flat path and nothing else. The
// map layer has no idea where one leg ends and the next begins. Turning that
// index back into "leg 3, between via 1 and via 2" is this file's whole job.
//
// Kept separate from map-common.js and builder.js because it is pure: no DOM,
// no google.maps, no state. test/route-shape.test.ts drives window.TBShape the
// same way twist-client.test.ts drives window.TBTwist. Getting an off-by-one
// wrong here bends a route around the wrong corner, which is exactly the kind
// of thing that should fail in a test rather than on a map.
(function (window) {
  "use strict";

  // Which leg owns a vertex of the day's flat track?
  //
  // `spans` comes from trackAndSpans() and is index-aligned with legs: spans[i]
  // is {startIndex, endIndex} for legs[i], or null when that leg has no
  // geometry yet. Two properties of that array make this less obvious than it
  // looks:
  //
  //   Legs SHARE their joint vertex — spans[i].endIndex === spans[i+1]
  //   .startIndex — because the concatenation drops the duplicate point where
  //   one leg's last coordinate meets the next leg's first. So a vertex sitting
  //   exactly on a joint belongs to both, and which one the rider meant depends
  //   on the segment they grabbed, not the vertex. `edgeForward` says they
  //   grabbed the segment leaving that vertex, which is the later leg.
  //
  //   A leg with no geometry has a null span and consumes no indices, so it
  //   must be skipped without shifting everything after it.
  function legAtVertex(spans, vertexIndex, edgeForward) {
    if (!Array.isArray(spans) || vertexIndex == null || vertexIndex < 0) return null;
    let joint = null;
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      if (!s) continue;
      if (vertexIndex > s.startIndex && vertexIndex < s.endIndex) return i;
      // On a boundary. Remember it and keep looking: the same index is the
      // start of a later leg, and which one wins depends on the edge.
      if (vertexIndex === s.startIndex) {
        // Grabbing the segment leaving this vertex means this leg.
        if (edgeForward || joint === null) return i;
        return joint;
      }
      if (vertexIndex === s.endIndex) joint = i;
    }
    // Past the end of the last leg with geometry, or the track's final vertex.
    return joint;
  }

  // Nearest vertex to a point, searched only within [from, to] so a via on one
  // leg cannot match a vertex on another that happens to be closer as the crow
  // flies — a switchback can bring two legs within metres of each other.
  //
  // Squared degrees with a cosine correction on longitude: this only ever ranks
  // candidates against each other over a few miles, so the accuracy of a real
  // haversine buys nothing and costs a trig call per vertex on a path that can
  // run to thousands of points.
  function nearestVertexIndex(track, lngLat, from, to) {
    if (!track || track.length === 0) return -1;
    const lo = Math.max(0, from == null ? 0 : from);
    const hi = Math.min(track.length - 1, to == null ? track.length - 1 : to);
    if (hi < lo) return -1;
    const [lng, lat] = lngLat;
    const k = Math.cos((lat * Math.PI) / 180);
    let best = lo;
    let bestD = Infinity;
    for (let i = lo; i <= hi; i++) {
      const dx = (track[i][0] - lng) * k;
      const dy = track[i][1] - lat;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  // Where in a leg's existing via list does a newly dropped one belong?
  //
  // Vias are sent to the router in array order, so the order IS the route. Drop
  // a point between two existing vias and append it, and the leg doubles back
  // on itself — out to via 2, back to the new one, forward again. The rider
  // sees a bow tie and has no idea why.
  //
  // Position is judged along the track rather than by distance between vias: a
  // route that loops can put two vias close together in space and far apart in
  // travel, and the track order is the one that matches how the leg is ridden.
  function viaInsertIndex(track, span, vias, dropVertexIndex) {
    if (!vias || vias.length === 0) return 0;
    if (!span) return vias.length;
    let n = 0;
    for (const v of vias) {
      const at = nearestVertexIndex(track, v, span.startIndex, span.endIndex);
      if (at >= 0 && at <= dropVertexIndex) n++;
      else break; // vias are already in track order, so the first one past the
      // drop ends it — anything after is further along too.
    }
    return n;
  }

  window.TBShape = { legAtVertex, nearestVertexIndex, viaInsertIndex };
})(typeof window !== "undefined" ? window : this);
