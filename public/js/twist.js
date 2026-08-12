// Twistiness in the browser: degrees of heading change per mile.
//
// This is a second implementation of src/maps/twist.ts, and that is deliberate
// rather than an oversight. The server computes the figure at save time from the
// geometry it is storing; the builder needs it *while the rider is still
// editing*, when the stored figure is by definition stale — you add a mountain
// pass and the panel has to say so before you press save, not after.
//
// Two copies of a numeric algorithm drift silently, so test/twist-client.test.ts
// runs both over the same fixtures and fails if they ever disagree. Change one,
// change the other; the test is what makes that safe. Same arrangement as
// ride-time.js, which is loaded and evaluated the same way.
//
// The viewer deliberately does NOT use this — a published ride is not being
// edited, so it reads the stored value out of ride.json instead.
window.TBTwist = (function () {
  "use strict";

  // Every one of these mirrors a constant in src/maps/twist.ts. See that file
  // for why each is the value it is — in particular why the deadband is 1° and
  // not the 5° it started as, and why the window is 20 miles and not 5.
  const SPACING_M = 25;
  const DEADBAND_DEG = 1;
  const WINDOW_MI = 20;
  const METERS_PER_MILE = 1609.344;
  const EARTH_RADIUS_M = 6371008.8;

  const RAD = Math.PI / 180;
  const DEG = 180 / Math.PI;

  const BANDS = [
    { min: 240, label: "Very twisty" },
    { min: 150, label: "Twisty" },
    { min: 90, label: "Some curves" },
    { min: 40, label: "Mostly straight" },
    { min: 0, label: "Straight" },
  ];

  function twistLabel(dpm) {
    if (dpm == null) return null;
    for (const b of BANDS) if (dpm >= b.min) return b.label;
    return null;
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * RAD;
    const dLon = (lon2 - lon1) * RAD;
    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
  }

  function bearing(a, b) {
    const la1 = a[1] * RAD;
    const la2 = b[1] * RAD;
    const dLng = (b[0] - a[0]) * RAD;
    const y = Math.sin(dLng) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
    return (Math.atan2(y, x) * DEG + 360) % 360;
  }

  const turn = (from, to) => ((to - from + 540) % 360) - 180;

  function resample(track, spacing) {
    const out = [track[0]];
    let carry = 0;
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1];
      const b = track[i];
      const seg = haversineM(a[1], a[0], b[1], b[0]);
      if (seg === 0) continue;
      let t = spacing - carry;
      while (t <= seg) {
        const f = t / seg;
        out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
        t += spacing;
      }
      carry = (carry + seg) % spacing;
    }
    return out;
  }

  // Null, never 0, for a track with nothing to measure. Zero would claim the
  // road is straight; null admits nothing has looked.
  function twistiness(track) {
    if (!track || track.length < 3) return null;

    const s = resample(track, SPACING_M);
    if (s.length < 3) return null;

    const changes = new Array(s.length - 2);
    let total = 0;
    for (let i = 2; i < s.length; i++) {
      const d = Math.abs(turn(bearing(s[i - 2], s[i - 1]), bearing(s[i - 1], s[i])));
      const kept = d >= DEADBAND_DEG ? d : 0;
      changes[i - 2] = kept;
      total += kept;
    }

    const miles = ((s.length - 1) * SPACING_M) / METERS_PER_MILE;
    if (miles <= 0) return null;

    const windowSamples = Math.max(1, Math.round((WINDOW_MI * METERS_PER_MILE) / SPACING_M));
    let bestSum = 0;
    let bestSpan = changes.length;
    if (changes.length <= windowSamples) {
      bestSum = total;
    } else {
      let running = 0;
      for (let i = 0; i < changes.length; i++) {
        running += changes[i];
        if (i >= windowSamples) running -= changes[i - windowSamples];
        if (i >= windowSamples - 1 && running > bestSum) bestSum = running;
      }
      bestSpan = windowSamples;
    }
    const bestMiles = (bestSpan * SPACING_M) / METERS_PER_MILE;

    return {
      dpm: Math.round(total / miles),
      bestDpm: bestMiles > 0 ? Math.round(bestSum / bestMiles) : 0,
      bestMiles: Math.round(bestMiles * 10) / 10,
    };
  }

  // Both figures below are expensive enough to need caching — roughly 19,000
  // samples for a 300-mile day, recomputed by renderTotals() on every keystroke
  // — and both are invalidated by a *signature* rather than by array identity.
  //
  // Identity looked like the obvious key and is wrong here: the builder mutates
  // these arrays in place (`day.legs[i] = leg` when the router answers,
  // `legs.splice()` on a delete, `pois.push()` on an add), so the array object
  // never changes and a cache keyed on it would serve the pre-reroute answer
  // forever. The signatures are O(n) over the leg or POI list, which is nothing
  // beside the walk they are protecting.
  const legsSignature = (day) => {
    let sig = day.legs.length + ":";
    for (const l of day.legs) sig += (l.distanceM || 0) + "," + ((l.geometry && l.geometry.length) || 0) + ";";
    return sig;
  };

  const cache = new WeakMap();
  function dayTwistiness(day) {
    if (!day || !day.legs || day.legs.length === 0) return null;
    const sig = legsSignature(day);
    const hit = cache.get(day);
    if (hit && hit.sig === sig) return hit.value;
    const track = [];
    for (const leg of day.legs) for (const p of leg.geometry || []) track.push(p);
    const value = twistiness(track);
    cache.set(day, { sig, value });
    return value;
  }

  // Where each POI falls along the day, in metres from the start.
  //
  // A port of distFromStartAlongTrack() in src/maps/kml.ts, and pinned to it by
  // test/twist-client.test.ts for the same reason twistiness() is: the server
  // computes this at save time, but the builder has to order the list while the
  // rider is still adding stops, when the stored figure does not exist yet.
  //
  // Nearest *vertex*, not nearest segment — matching the server exactly matters
  // more here than the fraction of a metre a proper projection would gain, and
  // the ordering is unaffected either way.
  function distFromStartAlongTrack(track, pts) {
    if (!track || track.length === 0) return pts.map(() => 0);
    const prefix = new Array(track.length);
    prefix[0] = 0;
    for (let i = 1; i < track.length; i++) {
      prefix[i] = prefix[i - 1] + haversineM(track[i - 1][1], track[i - 1][0], track[i][1], track[i][0]);
    }
    return pts.map((p) => {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < track.length; i++) {
        // Squared degrees, not metres: only the ordering of the comparison
        // matters, and this is the cheap version the server also uses.
        const d = (track[i][1] - p.lat) ** 2 + (track[i][0] - p.lng) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return Math.round(prefix[best]);
    });
  }

  // O(track x pois): about 380,000 comparisons for a long day with twenty POIs.
  // Depends on the POI positions as well as the track, so the signature covers
  // both — dragging a POI marker changes neither array's identity nor its
  // length.
  const poiCache = new WeakMap();
  function dayPoiDistances(day) {
    if (!day || !day.pois || day.pois.length === 0) return [];
    let sig = legsSignature(day) + "|" + day.pois.length + ":";
    for (const p of day.pois) sig += p.lng + "," + p.lat + ";";
    const hit = poiCache.get(day);
    if (hit && hit.sig === sig) return hit.dists;
    const track = [];
    for (const leg of day.legs || []) for (const p of leg.geometry || []) track.push(p);
    const dists = distFromStartAlongTrack(track, day.pois);
    poiCache.set(day, { sig, dists });
    return dists;
  }

  return {
    twistiness,
    twistLabel,
    dayTwistiness,
    distFromStartAlongTrack,
    dayPoiDistances,
    SPACING_M,
    DEADBAND_DEG,
    WINDOW_MI,
    BANDS,
  };
})();
