// Which of a rider's rides a phone should hold: the rule behind the "On this
// phone" switch on /rides (Ziad's call, 2026-09-17). Pure, so
// test/keep-policy.test.ts can pin it the way go-progress.js is pinned; the
// switch itself and the keeping are in rides.js.
//
// A POLICY NAMES A SET, BY WHEN A RIDE LAST CHANGED. "Last 30 days" and "This
// year" both read the ride's updatedAt — not its date — because the question
// the switch answers is "which rides am I likely to want on the road," and the
// ride touched last week is the one being planned. "None" holds nothing;
// "All" holds everything. The set is re-derived on every visit to /rides, but
// since 2026-10-04 nothing is downloaded or removed until the rider taps for
// it (see plan below); rides the rider kept by hand are never touched by a
// policy, and rides.js keeps that book in the registry row's `via`.
(function (window) {
  "use strict";

  var POLICIES = ["none", "recent", "year", "all"];
  var LABELS = { none: "None", recent: "Last 30 days", year: "This year", all: "All" };
  var STORE_KEY = "routeloop.keepPolicy";
  var RECENT_MS = 30 * 86400000;

  function isPolicy(v) {
    return POLICIES.indexOf(v) !== -1;
  }

  // `updatedAt` is an ISO string as the server sends it; `now` is a ms epoch.
  // An unparseable date matches nothing but "all" — a ride with no answer to
  // "when did it change" is not "changed recently".
  function matches(policy, updatedAt, now) {
    if (policy === "all") return true;
    if (policy === "none") return false;
    var t = Date.parse(updatedAt);
    if (!Number.isFinite(t)) return false;
    if (policy === "recent") return now - t <= RECENT_MS;
    if (policy === "year") return new Date(t).getFullYear() === new Date(now).getFullYear();
    return false;
  }

  // WHAT A POLICY WOULD DO, WITHOUT DOING IT (2026-10-04). The switch used to
  // act the moment it was pressed: narrowing deleted every ride the policy had
  // kept that fell outside it, and widening started downloading. On the road,
  // on a metered connection, both are expensive to undo, so the switch now
  // shows this plan and the rider taps for each half. `rides` is the list from
  // /rides/keep.json (slug, updatedAt, estBytes); `rows` is the registry;
  // `isChanged(row, ride)` says whether a kept copy is behind the ride.
  // `fetch` is what would be downloaded and `bytes` its estimated size;
  // `remove` is what the policy kept and no longer wants. Hand-kept rides are
  // never in `remove`.
  function plan(policy, rides, rows, now, isChanged) {
    var kept = {};
    (rows || []).forEach(function (r) {
      kept[r.slug] = r;
    });
    var want = {};
    var fetch = [];
    var bytes = 0;
    (rides || []).forEach(function (ride) {
      if (!matches(policy, ride.updatedAt, now)) return;
      want[ride.slug] = true;
      var row = kept[ride.slug];
      if (!row || isChanged(row, ride)) {
        fetch.push(ride);
        bytes += Number.isFinite(ride.estBytes) && ride.estBytes > 0 ? ride.estBytes : 0;
      }
    });
    var remove = (rows || []).filter(function (r) {
      return r.via === "policy" && !want[r.slug];
    });
    return { fetch: fetch, remove: remove, bytes: bytes };
  }

  window.TBKeepPolicy = {
    POLICIES: POLICIES,
    LABELS: LABELS,
    STORE_KEY: STORE_KEY,
    RECENT_MS: RECENT_MS,
    isPolicy: isPolicy,
    matches: matches,
    plan: plan,
  };
})(window);
