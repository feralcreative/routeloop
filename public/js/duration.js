// The browser's copy of src/maps/duration.ts.
//
// Two implementations again, for the same reason twist.js and filename.js are:
// the server owns the rule and the builder needs it live, while the rider is
// still typing. There is no round trip to ask the server what "1h 30m" means.
//
// test/duration.test.ts runs both over the same fixtures and fails if they ever
// disagree, so change one and change the other. If that test fails the fix is to
// bring the two back into line, never to loosen the assertion.
//
// Read the header of src/maps/duration.ts for WHY any of this exists and why the
// three formats are the three. This file carries only what the browser needs and
// deliberately repeats none of that reasoning — one copy of an explanation is
// easier to keep true than two.
window.TBDuration = (function () {
  "use strict";

  const FORMATS = ["hours", "hm", "minutes"];
  const DEFAULT_FORMAT = "hours";
  // Mirrors MAX_DURATION_MIN in src/maps/duration.ts, which mirrors the
  // ride-graph schema's .max(43200). Over it clamps; see that file for why.
  const MAX_MIN = 43200;

  function toFormat(v) {
    return FORMATS.indexOf(v) === -1 ? DEFAULT_FORMAT : v;
  }

  function hoursMinutes(minutes) {
    const total = Math.max(0, Math.round(minutes));
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h > 0 ? h + "h " + m + "m" : m + "m";
  }

  function decimalHours(minutes) {
    return (Math.max(0, minutes) / 60).toFixed(1);
  }

  function format(minutes, fmt) {
    // Null is not zero — see the server file. A blank field means the rider did
    // not stop, which is the common case for a POI.
    if (minutes == null || !isFinite(minutes)) return "";
    if (fmt === "hm") return hoursMinutes(minutes);
    if (fmt === "minutes") return String(Math.max(0, Math.round(minutes)));
    return decimalHours(minutes);
  }

  // Compound first, or "1h 30m" matches the hours-only rule and loses the 30.
  const COMPOUND = /^(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?\s*(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?$/i;
  const CLOCK = /^(\d+):([0-5]?\d)$/;
  const HOURS_ONLY = /^(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?$/i;
  const MINUTES_ONLY = /^(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?$/i;
  const BARE = /^(\d+(?:\.\d+)?)$/;

  function parse(text, fmt) {
    const s = String(text == null ? "" : text).trim();
    if (s === "") return null;

    const round = (n) => (isFinite(n) ? Math.min(MAX_MIN, Math.max(0, Math.round(n))) : null);

    const compound = COMPOUND.exec(s);
    if (compound) return round(Number(compound[1]) * 60 + Number(compound[2]));

    const clock = CLOCK.exec(s);
    if (clock) return round(Number(clock[1]) * 60 + Number(clock[2]));

    const hours = HOURS_ONLY.exec(s);
    if (hours) return round(Number(hours[1]) * 60);

    const mins = MINUTES_ONLY.exec(s);
    if (mins) return round(Number(mins[1]));

    const bare = BARE.exec(s);
    if (bare) return round(fmt === "hours" ? Number(bare[1]) * 60 : Number(bare[1]));

    return null;
  }

  function placeholder(fmt) {
    if (fmt === "hm") return "0h 0m";
    if (fmt === "minutes") return "min";
    return "hrs";
  }

  function unitName(fmt) {
    if (fmt === "hm") return "hours and minutes";
    if (fmt === "minutes") return "minutes";
    return "hours";
  }

  function inputMode(fmt) {
    if (fmt === "hm") return "text";
    if (fmt === "minutes") return "numeric";
    return "decimal";
  }

  return { FORMATS, DEFAULT_FORMAT, MAX_MIN, toFormat, format, parse, placeholder, unitName, inputMode };
})();
