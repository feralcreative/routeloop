// The error ring buffer and the diagnostics shaper. Exposes window.TBBuffer.
//
// Split out of feedback.js so it can be tested — test/feedback-buffer.test.ts
// evals this file the way test/ride-time.test.ts evals ride-time.js, which is
// the house pattern for a pure client helper (twist.js, route-shape.js,
// builder-history.js, duration.js, alts.js).
//
// **This is a crash handler, so it must not be able to crash.** Every read of a
// browser API in here is feature-detected, and the one that bites is
// `navigator.connection`: it is absent on Safari and Firefox, and a bare read
// inside an error reporter takes the page down at precisely the moment the page
// was already in trouble. Same for `localStorage`, which throws outright in
// private-mode Safari.
//
// Nothing here reads a coordinate. Geolocation appears as a permission state or
// not at all — a rider filing a bug from a gas stop must not hand us where they
// stopped.
(function () {
  "use strict";

  // Matches DIAG_ERRORS_MAX / DIAG_NET_MAX in src/feedback/policy.ts, which is
  // the authority — the server truncates to those regardless, so a mismatch here
  // only wastes bytes on the wire.
  const ERRORS_MAX = 25;
  const NET_MAX = 10;

  /**
   * A fixed-size ring. Keeps the OLDEST entries once full, deliberately: the
   * first error is almost always the cause and the twenty after it are the
   * consequences. A buffer that keeps the newest would reliably discard the one
   * line worth reading.
   */
  function makeRing(max) {
    const items = [];
    return {
      push: function (item) {
        if (items.length < max) items.push(item);
        return items.length;
      },
      list: function () {
        return items.slice();
      },
      get length() {
        return items.length;
      },
      clear: function () {
        items.length = 0;
      },
    };
  }

  /** One error entry, flattened to primitives. `at` is a millisecond timestamp
   *  so the server never has to parse a date out of this. */
  function errorEntry(kind, message, stack, at) {
    const e = { kind: String(kind || "error"), at: typeof at === "number" ? at : 0 };
    if (message != null) e.message = String(message).slice(0, 2000);
    if (stack != null) e.stack = String(stack).slice(0, 4000);
    return e;
  }

  /** One request entry. `path` keeps its query string here and is stripped
   *  server-side by src/feedback/diagnostics.ts — the client is not the
   *  authority on redaction, and a redaction only the client applies is one a
   *  hand-built POST skips. */
  function netEntry(method, path, status, ms, at) {
    return {
      at: typeof at === "number" ? at : 0,
      method: String(method || "GET").slice(0, 10),
      path: String(path || ""),
      status: Number(status) || 0,
      ms: Math.round(Number(ms) || 0),
    };
  }

  /** True when a request is worth recording: it failed, or it was slow enough
   *  that a rider would have noticed. Everything else is noise that would push
   *  the interesting entry out of a 10-slot buffer. */
  const SLOW_MS = 3000;
  function worthRecording(status, ms) {
    return Number(status) === 0 || Number(status) >= 400 || Number(ms) >= SLOW_MS;
  }

  /**
   * A value read from a browser API that may not exist.
   *
   * The whole reason this function exists: `navigator.connection.effectiveType`
   * is three property accesses, two of which are absent on Safari, inside code
   * that runs when something has already gone wrong.
   */
  function safe(fn, fallback) {
    try {
      const v = fn();
      return v === undefined || v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  /**
   * Assemble the payload from the parts.
   *
   * Pure: every browser fact arrives as an argument rather than being read here,
   * which is what makes the assembly testable and the collection replaceable.
   * feedback.js does the reading.
   */
  function buildPayload(parts) {
    const p = parts || {};
    const out = {};
    if (p.app) out.app = p.app;
    if (p.device) out.device = p.device;
    if (p.prefs) out.prefs = p.prefs;
    if (p.health) out.health = p.health;
    if (p.map) out.map = p.map;
    if (p.permissions) out.permissions = p.permissions;
    if (p.errors && p.errors.length) out.errors = p.errors.slice(0, ERRORS_MAX);
    if (p.net && p.net.length) out.net = p.net.slice(0, NET_MAX);
    return out;
  }

  /**
   * A URL reduced to the route pattern it matches.
   *
   * The single most useful field in the whole payload: it is what lets six
   * unrelated-looking reports be recognized as one broken screen. A raw URL
   * cannot do that, because every one of them carries a different ride slug.
   *
   * Kept as a table rather than derived, because the server's route definitions
   * are not available to the browser and guessing at "which segment is an id"
   * would turn /rides into /:slug.
   */
  const PATTERNS = [
    [/^\/build\/[^/]+/, "/build/:slug"],
    [/^\/build$/, "/build"],
    [/^\/m\/[^/]+\/roadbook/, "/m/:slug/roadbook"],
    [/^\/m\/[^/]+\/send/, "/m/:slug/send"],
    [/^\/m\/[^/]+/, "/m/:slug"],
    [/^\/feedback\/[^/]+/, "/feedback/:publicId"],
    [/^\/i\/[^/]+/, "/i/:token"],
  ];

  function routePattern(pathname) {
    const p = String(pathname || "/").split(/[?#]/)[0];
    for (let i = 0; i < PATTERNS.length; i++) {
      if (PATTERNS[i][0].test(p)) return PATTERNS[i][1];
    }
    // Not a pattern we know. The path itself is safe to send only because
    // anything with an id in it is matched above; the server re-checks with
    // PATTERN_OK either way.
    return p;
  }

  window.TBBuffer = {
    makeRing: makeRing,
    errorEntry: errorEntry,
    netEntry: netEntry,
    worthRecording: worthRecording,
    buildPayload: buildPayload,
    routePattern: routePattern,
    safe: safe,
    ERRORS_MAX: ERRORS_MAX,
    NET_MAX: NET_MAX,
    SLOW_MS: SLOW_MS,
  };

  // --- The recorder ----------------------------------------------------------

  // Installed on EVERY page, not just the feedback flow, and that is the whole
  // point: by the time a rider decides to file a report, the error that prompted
  // it happened minutes ago. A buffer that starts when the form opens has
  // nothing in it.
  //
  // Guarded so this file stays evaluable with a bare object as `window`, which
  // is how test/feedback-buffer.test.ts loads it — the same arrangement
  // test/ride-time.test.ts uses.
  if (typeof window.addEventListener !== "function") return;

  const errors = makeRing(ERRORS_MAX);
  const net = makeRing(NET_MAX);
  const log = {
    errors: errors.list(),
    net: net.list(),
    permissions: null,
    wasRestored: false,
  };

  // Rebuilt on read rather than kept in sync, so there is exactly one copy of
  // each list and no chance of the exported view going stale.
  window.TBFeedbackLog = {
    get errors() {
      return errors.list();
    },
    get net() {
      return net.list();
    },
    get permissions() {
      return log.permissions;
    },
    get wasRestored() {
      return log.wasRestored;
    },
  };

  const started = Date.now();
  const stamp = function () {
    return Date.now() - started;
  };

  window.addEventListener("error", function (ev) {
    errors.push(errorEntry("error", ev && ev.message, ev && ev.error && ev.error.stack, stamp()));
  });

  window.addEventListener("unhandledrejection", function (ev) {
    const r = ev && ev.reason;
    errors.push(errorEntry("rejection", r && (r.message || r), r && r.stack, stamp()));
  });

  // console.error is wrapped rather than replaced: the original still runs, so
  // the devtools console a developer is reading is unchanged.
  if (window.console && typeof window.console.error === "function") {
    const original = window.console.error;
    window.console.error = function () {
      try {
        const parts = Array.prototype.map
          .call(arguments, function (a) {
            return a && a.stack ? a.stack : String(a);
          })
          .join(" ");
        errors.push(errorEntry("console", parts, null, stamp()));
      } catch (e) {
        // Never let the reporter break the thing it is reporting on.
      }
      return original.apply(window.console, arguments);
    };
  }

  // fetch is wrapped for failures and slow calls only. Recording every request
  // would push the interesting one out of a ten-slot buffer within seconds of
  // opening the builder.
  if (typeof window.fetch === "function") {
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
      const at = stamp();
      const t0 = Date.now();
      const method = (init && init.method) || (input && input.method) || "GET";
      const url = typeof input === "string" ? input : input && input.url ? input.url : "";
      return originalFetch.apply(window, arguments).then(
        function (res) {
          const ms = Date.now() - t0;
          if (worthRecording(res.status, ms)) net.push(netEntry(method, url, res.status, ms, at));
          return res;
        },
        function (err) {
          net.push(netEntry(method, url, 0, Date.now() - t0, at));
          throw err;
        },
      );
    };
  }

  // A tab that was evicted and restored is one of the most common causes of "it
  // lost my route", and nothing else records that it happened.
  window.addEventListener("pageshow", function (ev) {
    if (ev && ev.persisted) log.wasRestored = true;
  });

  // Permission STATES, never a position, and asked for rather than triggered —
  // query() does not prompt. Absent on older Safari, hence the guard.
  safe(function () {
    if (!navigator.permissions || typeof navigator.permissions.query !== "function") return;
    navigator.permissions
      .query({ name: "geolocation" })
      .then(function (status) {
        log.permissions = { geolocation: status.state };
      })
      .catch(function () {});
  }, null);
})();
