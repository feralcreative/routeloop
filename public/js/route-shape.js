// The arithmetic behind drag-to-shape.
//
// A route is drawn as ONE polyline — the concatenated geometry of all its legs —
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

  // Which leg owns a vertex of the route's flat track?
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
  // flies — a switchback can bring two legs within meters of each other.
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

  // Where on a routed road does a shaping point actually sit?
  //
  // A shaping point is dropped wherever the rider's pointer lands, which is a
  // coordinate in a field, on a river, or fifty meters into the wrong side of a
  // divided highway. Routes then snaps it to WHATEVER road is nearest and routes
  // through that — so the road that comes back can be a frontage road, the
  // opposite side of a divided highway, or an entirely different street, and the handle left
  // sitting in the field says nothing about which. The rider sees a route that
  // does not match the hint they gave and has no way to tell why.
  //
  // The fix is free, because the answer is already in hand: the routed geometry
  // IS the road Google chose, so projecting the dropped point onto it gives the
  // coordinate the router actually used. Nothing new is requested and no second
  // API is spoken — see the note in builder.js's computeLeg for why this runs
  // after the response rather than before the request.
  //
  // PROJECTED ONTO THE NEAREST SEGMENT, NOT SNAPPED TO THE NEAREST VERTEX. A
  // routed polyline is sparse on a long straight — vertices can be miles apart
  // on an interstate — so a vertex snap can move a handle further than the
  // original error and put it past an interchange the rider was aiming at. The
  // perpendicular foot is on the road either way and is the nearest such point.
  //
  // `fromSegment` is the order floor. Vias are sent to the router in array order
  // and the order IS the route, so two of them that snap out of order make the
  // leg double back — the bow tie viaInsertIndex exists to prevent, arriving by
  // another door. Snapping each in turn from where the last one landed keeps the
  // list monotonic along the road.
  //
  // Squared degrees with a cosine correction, for the reason nearestVertexIndex
  // uses them: this ranks candidate segments against each other over a few
  // miles, where a real haversine buys nothing and costs a trig call per vertex.
  function snapToTrack(track, lngLat, fromSegment) {
    if (!track || track.length < 2) return null;
    const [lng, lat] = lngLat;
    const k = Math.cos((lat * Math.PI) / 180);
    const lo = Math.max(0, Math.min(fromSegment || 0, track.length - 2));
    let best = null;
    let bestD = Infinity;
    for (let i = lo; i < track.length - 1; i++) {
      const ax = track[i][0] * k;
      const ay = track[i][1];
      const bx = track[i + 1][0] * k;
      const by = track[i + 1][1];
      const vx = bx - ax;
      const vy = by - ay;
      const len2 = vx * vx + vy * vy;
      // A zero-length segment is a duplicated vertex; its foot is the vertex.
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((lng * k - ax) * vx + (lat - ay) * vy) / len2));
      const px = ax + t * vx;
      const py = ay + t * vy;
      const dx = px - lng * k;
      const dy = py - lat;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = {
          // Back out of the cosine correction: the projection was done in a
          // scaled x, so the longitude it produces is scaled too.
          lngLat: [+(px / k).toFixed(6), +py.toFixed(6)],
          segmentIndex: i,
          t,
        };
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

  // Where on the track is a given distance from its start?
  //
  // Added for drag-to-reorder a POI. A POI has no stored order — ride-graph.ts
  // writes `position: null` for every one of them and its place in the list is
  // its projected distance along the route's track — so dragging one has nothing
  // to reorder. It moves the pin instead: dropped between two stops, the POI
  // relocates to the point on the road between them. This is the half that turns
  // "between those two rows" back into a coordinate.
  //
  // The walk is by real haversine rather than the squared-degree approximation
  // above, because this produces a POSITION rather than ranking candidates —
  // the cosine shortcut is fine for "which of these is nearest" and wrong for
  // "how far along is this".
  //
  // Interpolation within a segment is plain linear in lng/lat. Adjacent track
  // vertices are meters apart, so great-circle curvature between them is far
  // below the six decimal places a coordinate is stored to.
  function pointAtDistance(track, targetM) {
    if (!track || track.length === 0) return null;
    if (track.length === 1 || !(targetM > 0)) return track[0].slice();
    let acc = 0;
    for (let i = 1; i < track.length; i++) {
      const seg = haversineM(track[i - 1], track[i]);
      if (acc + seg >= targetM) {
        // A zero-length segment cannot be interpolated into and would divide by
        // zero; its start is the only answer it has.
        const t = seg === 0 ? 0 : (targetM - acc) / seg;
        return [
          track[i - 1][0] + (track[i][0] - track[i - 1][0]) * t,
          track[i - 1][1] + (track[i][1] - track[i - 1][1]) * t,
        ];
      }
      acc += seg;
    }
    // Past the end — a drop below the last row asks for the end of the route.
    return track[track.length - 1].slice();
  }

  /**
   * The stretch of `track` between two distances along it, as its own path.
   *
   * BOTH ENDS ARE INTERPOLATED rather than snapped to the nearest vertex. The
   * distances this is called with are fuel arithmetic — where a tank runs out,
   * where the next pump is — and snapping would move a wall by up to the length
   * of one segment, which on a sparse imported track is miles.
   *
   * Returns a path of at least two points, or null when there is nothing to
   * draw: an empty track, or a span with no length. A caller drawing a polyline
   * needs two points and a one-point path renders nothing, so the null is what
   * keeps that check in one place.
   */
  function sliceBetween(track, fromM, toM) {
    if (!track || track.length < 2) return null;
    if (fromM == null || toM == null || !(toM > fromM)) return null;
    var out = [pointAtDistance(track, fromM)];
    var acc = 0;
    for (var i = 1; i < track.length; i++) {
      var seg = haversineM(track[i - 1], track[i]);
      acc += seg;
      // Strictly inside, so the interpolated ends are never doubled by a vertex
      // that happens to sit exactly on one of them.
      if (acc > fromM && acc < toM) out.push(track[i].slice());
      if (acc >= toM) break;
    }
    out.push(pointAtDistance(track, toM));
    return out.length >= 2 ? out : null;
  }

  /**
   * A closed ring of points `radiusM` from `center`, as a path.
   *
   * FOR DRAWING A CIRCLE AS A POLYLINE, which is the only way to get a dashed
   * or dotted one: google.maps.Circle has strokeWeight, strokeColor and
   * strokeOpacity and no dash support at all, while a Polyline can carry
   * repeating icons — the same mechanism dashIcons() uses for a ghosted route.
   *
   * Geodesic rather than a flat ellipse, so it stays a true constant-distance
   * ring at any latitude. The last point repeats the first, so the caller draws
   * it without having to close it.
   */
  function circlePath(center, radiusM, steps) {
    if (!center || !(radiusM > 0)) return null;
    var n = steps || 72;
    var rad = Math.PI / 180;
    var R = 6371008.8;
    var d = radiusM / R;
    var lat1 = center[1] * rad;
    var lng1 = center[0] * rad;
    var sinLat1 = Math.sin(lat1);
    var cosLat1 = Math.cos(lat1);
    var out = [];
    for (var i = 0; i <= n; i++) {
      var brg = ((i % n) / n) * 2 * Math.PI;
      var lat2 = Math.asin(sinLat1 * Math.cos(d) + cosLat1 * Math.sin(d) * Math.cos(brg));
      var lng2 = lng1 + Math.atan2(Math.sin(brg) * Math.sin(d) * cosLat1, Math.cos(d) - sinLat1 * Math.sin(lat2));
      out.push([lng2 / rad, lat2 / rad]);
    }
    return out;
  }

  // Mirrors haversineTrack() in builder.js and the constant in twist.js. Both
  // use the IUGG mean radius; keep the three in step.
  // Which original legs make up each leg of a route after some points are removed?
  //
  // Leg k joins points k and k+1, so a route of n points has n-1 legs. Take some
  // points out and the survivors are re-joined in order: the leg between
  // survivors S[j] and S[j+1] covers every original leg from S[j] through
  // S[j+1]-1. A span of ONE is a leg the removal never touched — same two
  // points, same road, keep it whole rather than paying the router to be told
  // so. A span of more than one is a merge, and the shaping points of every leg
  // it swallowed are still hints about a road between two points that both
  // survive, so they are carried across in order.
  //
  // Returned as index pairs rather than as legs: building a leg needs a distance
  // and a placeholder geometry, which is builder.js's business and not this
  // file's. `removed` may be in any order and may repeat.
  function rejoinSpans(nPoints, removed) {
    const gone = new Set(removed || []);
    const kept = [];
    for (let i = 0; i < nPoints; i++) if (!gone.has(i)) kept.push(i);
    const spans = [];
    for (let j = 0; j < kept.length - 1; j++) spans.push({ from: kept[j], to: kept[j + 1] - 1 });
    return spans;
  }

  function haversineM(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad;
    const dLng = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
  }

  // haversineM is exported so range-circle.js can measure the straight line
  // between two points on a track without keeping a fourth copy of the formula.
  window.TBShape = {
    legAtVertex,
    nearestVertexIndex,
    snapToTrack,
    viaInsertIndex,
    pointAtDistance,
    sliceBetween,
    circlePath,
    haversineM,
    rejoinSpans,
  };
})(typeof window !== "undefined" ? window : this);
