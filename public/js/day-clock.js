// A day's start and end are WALL CLOCK TIMES AT THE DEPARTURE POINT, and this
// file is the only place that converts between one and the string an
// `<input type="datetime-local">` speaks.
//
// THE RULE, Ziad's call 2026-08-24: a time is a time is a time at the departure
// point. A rider who plans a 9am departure means 9am where the bike is, and that
// is true whether they planned it from home, from a hotel in another state, or
// from London two weeks before flying out. Nothing in this app converts a day's
// clock into anyone's local time, ever.
//
// HOW THAT IS CARRIED: the wall clock rides in the ISO string as though it were
// UTC. 9am becomes `2026-08-24T09:00:00.000Z`, `days.start_at` stores
// `09:00:00+00`, and every surface that renders it already asks for
// `timeZone: 'UTC'` — the roadbook (src/views/date-format.ts), the export
// filename (src/maps/filename.ts), and the import preview (public/js/import.js).
// Those three were written that way as a workaround for a bug and are now simply
// correct.
//
// WHY THE COLUMN STAYED `timestamptz` rather than becoming a naive `timestamp`,
// which is what the values now are. Measured against the local database rather
// than assumed: node-postgres parses `timestamp without time zone` in the
// PROCESS's zone, so a stored `09:00` read back on a Pacific machine is
// `16:00Z` — the app's behavior would depend on `TZ` being set, silently and
// differently in dev and in the container. `timestamptz` round-trips the exact
// value in both directions with no type-parser override and no environment
// dependency. The type is a carrier here, not a claim about an instant.
//
// WHY UTC METHODS EVERYWHERE BELOW: UTC has no daylight saving, so every
// conversion in this file is plain arithmetic on the digits the rider typed.
// The local-zone versions of these same functions had to be right about DST
// transitions and were not — a day starting on the morning the clocks went
// forward came back an hour out.
//
// Pure arithmetic, no DOM: test/day-clock.test.ts evals this file, the same
// arrangement as duration.js, twist.js and route-shape.js.
window.TBDayClock = (function () {
  "use strict";

  // What `<input type="datetime-local">` reads and writes. Seconds are optional
  // and the builder never sets `step`, so they arrive only from a browser that
  // volunteers them.
  const INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/;

  const pad = (n) => String(n).padStart(2, "0");

  /**
   * `2026-08-24T09:00:00.000Z` → `2026-08-24T09:00`, for the input's value.
   *
   * UTC getters, so the digits that come out are the digits that went in. The
   * local getters this replaced were the whole bug: a Pacific browser turned a
   * stored 9am into 02:00 in the field.
   */
  function isoToInput(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return (
      d.getUTCFullYear() +
      "-" +
      pad(d.getUTCMonth() + 1) +
      "-" +
      pad(d.getUTCDate()) +
      "T" +
      pad(d.getUTCHours()) +
      ":" +
      pad(d.getUTCMinutes())
    );
  }

  /**
   * `2026-08-24T09:00` → `2026-08-24T09:00:00.000Z`.
   *
   * Built from the digits rather than by handing the string to `new Date()`,
   * which parses an offsetless datetime as local time — that is exactly the
   * conversion this file exists to refuse. Seconds are dropped: the field's
   * resolution is a minute and a day's start is not a stopwatch.
   */
  function inputToIso(value) {
    const m = INPUT_RE.exec(String(value || ""));
    if (!m) return null;
    const [, y, mo, d, hh, mm] = m;
    // Round-trip check, which is what rejects 2026-02-30 and 2026-13-01 — the
    // Date constructor rolls those over silently rather than failing. Same
    // guard, for the same reason, as parseDate() in src/maps/filename.ts.
    const t = Date.UTC(+y, +mo - 1, +d, +hh, +mm);
    const dt = new Date(t);
    if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;
    if (dt.getUTCHours() !== +hh || dt.getUTCMinutes() !== +mm) return null;
    return dt.toISOString();
  }

  /**
   * The first `hour` o'clock strictly after the given moment.
   *
   * Anchoring on the end INSTANT rather than on its calendar date is what keeps
   * a day that runs past midnight sane — "the morning after the end date" would
   * skip a day for a ride finishing at 2am, this does not.
   */
  function nextMorningAfter(iso, hour) {
    if (!iso) return null;
    const end = new Date(iso);
    if (Number.isNaN(end.getTime())) return null;
    const start = new Date(end);
    start.setUTCHours(hour, 0, 0, 0);
    if (start <= end) start.setUTCDate(start.getUTCDate() + 1);
    return start.toISOString();
  }

  return { isoToInput, inputToIso, nextMorningAfter };
})();
