// The elevation strip above the timeline and the weather in its readout (#23, #24),
// shared by the builder and the viewer. The arithmetic is conditions.js.
//
// The host owns the axis and the moment; this owns the data and the drawing. The
// host hands over three functions rather than its state so neither page's `state`
// leaks here: `routes()`, the slider's `axis()` as `{ min, max, momentAt(v) }`, and
// `resolve(momentS)` → `{ route, a }` or null, which is how the builder's route scope
// (activeAt on the route being edited) and the viewer's ride scope stay each page's
// own call.
//
// FETCHED A ROUTE AT A TIME, IN ORDER, and never twice for the same road: Open-Meteo's
// free tier allows about 600 coordinates a minute, so a long ride fills in over a
// minute rather than failing whole.
(function (window) {
  "use strict";

  const C = window.TBConditions;
  const COLUMNS = 240;
  const SHOW_KEY = "routeloop.profile";
  const RETRIES = 5;
  const RETRY_MS = 65_000;

  function create(opts) {
    const data = new Map(); // uid → { sig, elevation, weather }
    let queue = Promise.resolve();
    let columns = null;
    let show = readShow();
    const strip = document.getElementById("time-profile");
    const toggle = document.getElementById("time-profile-toggle");

    if (toggle) {
      toggle.addEventListener("click", () => {
        show = !show;
        writeShow(show);
        paint();
      });
    }

    // A route's road, cheaply: when this changes the stored samples are stale.
    function sigOf(route) {
      return (route.legs || []).map((l) => l.distanceM || 0).join(",") + "|" + (route.startAt || "");
    }

    /** Fetch whatever the routes need and do not have. Call after a load or a save. */
    function load() {
      for (const route of opts.routes()) {
        if (!route.uid || !(route.legs && route.legs.length)) continue;
        const sig = sigOf(route);
        const have = data.get(route.uid);
        if (have && have.sig === sig) continue;
        data.set(route.uid, { sig, elevation: have ? have.elevation : [], weather: have ? have.weather : [], pending: true });
        queue = queue.then(() => fetchOne(route.uid, sig));
      }
      return queue;
    }

    async function fetchOne(uid, sig) {
      try {
        const res = await fetch(opts.url(uid), { credentials: "same-origin" });
        if (!res.ok) return;
        const body = await res.json();
        const got = body.routes && body.routes[uid];
        const cur = data.get(uid);
        if (!got || !cur || cur.sig !== sig) return;
        data.set(uid, { sig, elevation: got.elevation || [], weather: got.weather || [], tries: (cur.tries || 0) + 1 });
        columns = null;
        opts.onData && opts.onData();
        // Throttled partway: the free tier's minute resets, so ask again after it.
        if (got.complete === false && (cur.tries || 0) < RETRIES) {
          setTimeout(() => {
            queue = queue.then(() => fetchOne(uid, sig));
          }, RETRY_MS);
        }
      } catch (e) {
        // A picture beside the plan; an outage leaves it blank.
      }
    }

    function samplesFor(route, kind) {
      const d = route && data.get(route.uid);
      return d ? d[kind] : null;
    }

    function at(momentS) {
      const r = momentS == null ? null : opts.resolve(momentS);
      if (!r) return null;
      const pos = C.roadPosition(r.route, r.a);
      return { route: r.route, pos };
    }

    /** Rebuild the profile. Call when the axis, the scope or the routes change. */
    function refresh() {
      columns = null;
      paint();
    }

    function buildColumns() {
      const axis = opts.axis();
      if (!axis || !(axis.max > axis.min)) return [];
      const out = [];
      for (let i = 0; i < COLUMNS; i++) {
        const v = axis.min + ((axis.max - axis.min) * i) / (COLUMNS - 1);
        const hit = at(axis.momentAt(v));
        const el = hit ? C.elevationAt(samplesFor(hit.route, "elevation"), hit.pos) : null;
        out.push(el ? el.e : null);
      }
      return out;
    }

    function paint() {
      if (!strip) return;
      if (!columns) columns = buildColumns();
      const any = columns.some((e) => e != null);
      if (toggle) {
        toggle.hidden = !any;
        toggle.setAttribute("aria-pressed", String(show));
      }
      strip.hidden = !(any && show);
      if (strip.hidden) return;
      const vals = columns.filter((e) => e != null);
      let lo = Math.min(...vals);
      let hi = Math.max(...vals);
      // A flat ride drawn edge to edge would read as mountains.
      if (hi - lo < 150) {
        const mid = (hi + lo) / 2;
        lo = mid - 75;
        hi = mid + 75;
      }
      const y = (e) => 96 - ((e - lo) / (hi - lo)) * 88;
      let line = "";
      let area = "";
      let run = [];
      const flush = () => {
        if (run.length > 1) {
          const pts = run.map(([x, e]) => x.toFixed(1) + "," + y(e).toFixed(1));
          line += "M" + pts.join("L");
          area += "M" + run[0][0].toFixed(1) + ",100L" + pts.join("L") + "L" + run[run.length - 1][0].toFixed(1) + ",100Z";
        }
        run = [];
      };
      columns.forEach((e, i) => {
        if (e == null) return flush();
        run.push([(i / (COLUMNS - 1)) * 1000, e]);
      });
      flush();
      strip.innerHTML =
        '<svg class="time-profile-svg" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">' +
        '<path class="time-profile-area" d="' +
        area +
        '"/><path class="time-profile-line" d="' +
        line +
        '" vector-effect="non-scaling-stroke"/>' +
        '<line class="time-profile-cursor" x1="0" x2="0" y1="0" y2="100" vector-effect="non-scaling-stroke"/></svg>' +
        '<span class="time-profile-label"></span>';
      moment(opts.moment());
    }

    /** Move the cursor and the label. Cheap; call on every scrub. */
    function moment(momentS) {
      if (!strip || strip.hidden) return;
      const axis = opts.axis();
      const cursor = strip.querySelector(".time-profile-cursor");
      const label = strip.querySelector(".time-profile-label");
      const hit = at(momentS);
      const el = hit ? C.elevationAt(samplesFor(hit.route, "elevation"), hit.pos) : null;
      if (cursor) {
        const v = momentS == null || !axis ? null : opts.valueAt(momentS);
        const x = v == null || !(axis.max > axis.min) ? -10 : ((v - axis.min) / (axis.max - axis.min)) * 1000;
        cursor.setAttribute("x1", x);
        cursor.setAttribute("x2", x);
      }
      if (label) {
        label.textContent = el ? C.fmtElevation(el.e, opts.units) + " · " + C.fmtGrade(el.grade) : "";
      }
    }

    /** The forecast at a moment as a readout fragment, or "". */
    function weatherText(momentS) {
      const hit = at(momentS);
      if (!hit) return "";
      return C.fmtWeather(C.weatherAt(samplesFor(hit.route, "weather"), hit.pos, momentS), opts.units);
    }

    return { load, refresh, moment, weatherText };
  }

  function readShow() {
    try {
      return window.localStorage.getItem(SHOW_KEY) !== "0";
    } catch (e) {
      return true;
    }
  }

  function writeShow(on) {
    try {
      window.localStorage.setItem(SHOW_KEY, on ? "1" : "0");
    } catch (e) {
      /* lasts as long as the page does */
    }
  }

  window.TBConditionsStrip = { create };
})(window);
