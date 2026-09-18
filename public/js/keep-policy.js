// Which of a rider's rides a phone should hold: the rule behind the "On this
// phone" switch on /rides (Ziad's call, 2026-09-17). Pure, so
// test/keep-policy.test.ts can pin it the way go-progress.js is pinned; the
// switch itself and the keeping are in rides.js.
//
// A POLICY NAMES A SET, BY WHEN A RIDE LAST CHANGED. "Last 30 days" and "This
// year" both read the ride's updatedAt — not its date — because the question
// the switch answers is "which rides am I likely to want on the road," and the
// ride touched last week is the one being planned. "None" holds nothing;
// "All" holds everything. The set is re-derived on every visit to /rides, so
// a ride that ages out of the window leaves the phone on the next visit and
// one that changes comes back; rides the rider kept by hand are never touched
// by a policy, and rides.js keeps that book in the registry row's `via`.
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

  window.TBKeepPolicy = {
    POLICIES: POLICIES,
    LABELS: LABELS,
    STORE_KEY: STORE_KEY,
    RECENT_MS: RECENT_MS,
    isPolicy: isPolicy,
    matches: matches,
  };
})(window);
