// The browser's copy of src/maps/alternates.ts.
//
// Two implementations for the same reason twist.js, filename.js and duration.js
// are: the server owns the rule and the builder needs it live, while the rider
// is still dragging days around. There is no round trip to ask the server which
// alternate is active or what the ride's mileage now reads.
//
// test/alternates.test.ts runs both over the same fixtures and fails if they
// ever disagree, so change one and change the other. If that test fails the fix
// is to bring the two back into line, never to loosen the assertion — a
// disagreement here is a builder showing one total while the database stores
// another, with nothing raised.
//
// Read the header of src/maps/alternates.ts for WHY the grouping rides in the
// payload rather than being a table. This file carries only what the browser
// needs and deliberately repeats none of that reasoning.
//
// ONE FUNCTION IS NOT MIRRORED: rideRollup, at the bottom. It is the builder's
// live totals arithmetic and has no server counterpart — the server's own
// version is rideTotals() in src/maps/ride-graph.ts, which produces a different
// shape for different columns. It lives here because the part of it that can be
// got wrong is the part that skips alternates, and here it gets a test instead
// of a browser pass.
window.TBAlt = (function () {
  "use strict";

  const METERS_PER_MILE = 1609.344;

  function resolveAltGroups(days) {
    for (const d of days) {
      if (d.altGroup == null) {
        d.altGroup = null;
        d.altActive = true;
      }
    }

    const order = [];
    const members = new Map();
    for (const d of days) {
      if (d.altGroup == null) continue;
      let m = members.get(d.altGroup);
      if (!m) {
        m = [];
        members.set(d.altGroup, m);
        order.push(d.altGroup);
      }
      m.push(d);
    }

    let next = 0;
    for (const key of order) {
      const m = members.get(key);

      if (m.length < 2) {
        for (const d of m) {
          d.altGroup = null;
          d.altActive = true;
        }
        continue;
      }

      let elected = false;
      for (const d of m) {
        if (d.altActive && !elected) {
          elected = true;
          continue;
        }
        d.altActive = false;
      }
      if (!elected) m[0].altActive = true;

      const id = next++;
      for (const d of m) d.altGroup = id;
    }
  }

  function activeDays(days) {
    return days.filter((d) => d.altGroup == null || d.altActive);
  }

  function activeDayCount(days) {
    let n = 0;
    for (const d of days) if (d.altGroup == null || d.altActive) n++;
    return n;
  }

  function ghostSuffix(n) {
    return n < 25 ? String.fromCharCode(98 + n) : "z" + (n - 23);
  }

  function dayOrdinals(days) {
    const out = new Array(days.length).fill("");
    const groupNumber = new Map();
    let n = 0;

    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      if (d.altGroup != null && !d.altActive) continue;
      out[i] = String(++n);
      if (d.altGroup != null) groupNumber.set(d.altGroup, n);
    }

    const rank = new Map();
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      if (d.altGroup == null || d.altActive) continue;
      const k = rank.get(d.altGroup) || 0;
      rank.set(d.altGroup, k + 1);
      const base = groupNumber.get(d.altGroup);
      out[i] = base == null ? String(++n) : String(base) + ghostSuffix(k);
    }

    return out;
  }

  function dayOrdinal(days, i) {
    return dayOrdinals(days)[i] || "";
  }

  // Fold per-day totals into the ride's. Takes the totals of the days that
  // COUNT — callers pass activeDays(state.days).map(routeTotals) — so a losing
  // alternate's miles never reach it.
  //
  // Twistiness across days is a distance-weighted mean, not an average of the
  // days' figures: it is degrees over miles, so the ride's value is the sum of
  // the degrees over the sum of the miles. Averaging the per-day numbers would
  // let a 30-mile breakfast ride count as much as a 300-mile transit day.
  //
  // The ride's best stretch is the best any single day has, not a sum:
  // "somewhere in this ride there are twenty miles like that".
  function rideRollup(totals) {
    const acc = {
      meters: 0,
      riding: 0,
      stopped: 0,
      estimated: false,
      twistDeg: 0,
      twistMeters: 0,
      twistBest: 0,
      twistBestMiles: 0,
    };
    for (const t of totals) {
      acc.meters += t.meters;
      acc.riding += t.riding;
      acc.stopped += t.stopped;
      acc.estimated = acc.estimated || t.estimated;
      acc.twistDeg += t.twist ? (t.twist.dpm * t.meters) / METERS_PER_MILE : 0;
      acc.twistMeters += t.twist ? t.meters : 0;
      if (t.twist && t.twist.bestDpm > acc.twistBest) {
        acc.twistBestMiles = t.twist.bestMiles;
        acc.twistBest = t.twist.bestDpm;
      }
    }
    acc.twist =
      acc.twistMeters > 0
        ? {
            dpm: Math.round(acc.twistDeg / (acc.twistMeters / METERS_PER_MILE)),
            bestDpm: acc.twistBest,
            bestMiles: acc.twistBestMiles,
          }
        : null;
    return acc;
  }

  return { resolveAltGroups, activeDays, activeDayCount, dayOrdinals, dayOrdinal, rideRollup, METERS_PER_MILE };
})();
