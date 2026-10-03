// Elevation and weather at a moment on the timeline (#23, #24): the pure half,
// eval'd by test/conditions.test.ts. conditions-strip.js is the DOM.
//
// Samples come from src/maps/conditions.ts addressed by LEG AND FRACTION, the same
// terms activeAt() answers in, so `leg + f` is one ordered key along the route and
// nothing here measures a distance of its own.
(function (window) {
  "use strict";

  const FT_PER_M = 3.28084;

  /** Where on the road a resolved moment is, as `{ leg, f }`, or null. */
  function roadPosition(route, a) {
    if (!a) return null;
    if (a.legIndex != null) return { leg: a.legIndex, f: a.legFraction == null ? 0 : a.legFraction };
    if (a.pointIndex == null) return null;
    const legs = (route && route.legs && route.legs.length) || 0;
    if (a.pointIndex < legs) return { leg: a.pointIndex, f: 0 };
    return legs ? { leg: legs - 1, f: 1 } : null;
  }

  const key = (s) => s.leg + s.f;

  /** `{ e, grade }` interpolated at a position, grade as a fraction; null off the samples. */
  function elevationAt(samples, pos) {
    if (!samples || !samples.length || !pos) return null;
    const k = pos.leg + pos.f;
    if (k <= key(samples[0])) return { e: samples[0].e, grade: gradeOf(samples[0], samples[1]) };
    for (let i = 1; i < samples.length; i++) {
      const b = samples[i];
      if (k <= key(b)) {
        const a = samples[i - 1];
        const span = key(b) - key(a);
        const t = span > 0 ? (k - key(a)) / span : 0;
        return { e: a.e + (b.e - a.e) * t, grade: gradeOf(a, b) };
      }
    }
    const last = samples[samples.length - 1];
    return { e: last.e, grade: gradeOf(samples[samples.length - 2], last) };
  }

  function gradeOf(a, b) {
    if (!a || !b || !(b.d > a.d)) return 0;
    return (b.e - a.e) / (b.d - a.d);
  }

  /** The forecast hour a moment falls in. Both sides are local wall clock, so the
   *  UTC digits of a route's clock ARE the hour — see route-clock.js. */
  function hourKey(momentS) {
    return new Date(momentS * 1000).toISOString().slice(0, 13) + ":00";
  }

  /** The nearest forecast point's values for that hour, or null. */
  function weatherAt(points, pos, momentS) {
    if (!points || !points.length || !pos || momentS == null) return null;
    const k = pos.leg + pos.f;
    let best = points[0];
    for (const p of points) if (Math.abs(key(p) - k) < Math.abs(key(best) - k)) best = p;
    const i = best.time.indexOf(hourKey(momentS));
    if (i < 0) return null;
    return {
      tempC: best.tempC[i] ?? null,
      rainPct: best.rainPct[i] ?? null,
      windKmh: best.windKmh[i] ?? null,
      code: best.code[i] ?? null,
    };
  }

  // WMO weather interpretation codes, as a rider would say them.
  function weatherWord(code) {
    if (code == null) return null;
    if (code === 0) return "Clear";
    if (code <= 2) return "Partly cloudy";
    if (code === 3) return "Overcast";
    if (code <= 48) return "Fog";
    if (code <= 57) return "Drizzle";
    if (code <= 67) return "Rain";
    if (code <= 77) return "Snow";
    if (code <= 82) return "Showers";
    if (code <= 86) return "Snow showers";
    return "Thunderstorms";
  }

  const metric = (units) => units === "metric";

  function fmtWeather(w, units) {
    if (!w) return "";
    const parts = [];
    const word = weatherWord(w.code);
    if (word) parts.push(word);
    if (w.tempC != null) {
      parts.push(metric(units) ? Math.round(w.tempC) + "°C" : Math.round((w.tempC * 9) / 5 + 32) + "°F");
    }
    if (w.rainPct != null && w.rainPct >= 10) parts.push(Math.round(w.rainPct) + "% rain");
    if (w.windKmh != null && w.windKmh >= 25) {
      parts.push(metric(units) ? "wind " + Math.round(w.windKmh) + " km/h" : "wind " + Math.round(w.windKmh / 1.609344) + " mph");
    }
    return parts.join(", ");
  }

  function fmtElevation(e, units) {
    const n = metric(units) ? e : e * FT_PER_M;
    return Math.round(n).toLocaleString("en-US") + (metric(units) ? " m" : " ft");
  }

  function fmtGrade(g) {
    const pct = Math.round(g * 100);
    return (pct > 0 ? "+" : pct < 0 ? "−" : "") + Math.abs(pct) + "%";
  }

  window.TBConditions = {
    roadPosition,
    elevationAt,
    hourKey,
    weatherAt,
    weatherWord,
    fmtWeather,
    fmtElevation,
    fmtGrade,
  };
})(typeof window !== "undefined" ? window : this);
