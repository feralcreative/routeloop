// Seasonal closures (#53): the pure half the map pages share, eval'd by
// test/road-season.test.ts against src/road-reports/policy.ts so the two agree.
// A season is two month-days as MMDD and may wrap the new year.
(function (window) {
  "use strict";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function inSeason(start, end, mmdd) {
    return start <= end ? mmdd >= start && mmdd <= end : mmdd >= start || mmdd <= end;
  }

  // A route's clock is a wall clock carried as UTC, so the UTC fields are its date.
  function mmddOf(d) {
    return (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  }

  // Whole calendar days from one route date to another, by their UTC dates.
  function calendarDays(from, to) {
    const day = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000;
    return day(to) - day(from);
  }

  // 'closed' when the route's span overlaps the season, 'seasonal' when the route
  // is undated, null when it is dated wholly outside the season. Overlap, not "either
  // end is in season" (#447): a short closure inside a long route counts. Both are
  // arcs that may wrap the new year, and two arcs meet when either one's start lies
  // inside the other; a span of a year or more covers every month-day. Mirrors
  // seasonVerdict() in src/road-reports/policy.ts.
  function seasonVerdict(season, routeStart, routeEnd) {
    if (!routeStart) return "seasonal";
    let from = routeStart;
    let to = routeEnd || routeStart;
    if (to.getTime() < from.getTime()) [from, to] = [to, from];
    if (calendarDays(from, to) >= 365) return "closed";
    const a = mmddOf(from);
    const b = mmddOf(to);
    const meets = inSeason(season.start, season.end, a) || inSeason(a, b, season.start);
    return meets ? "closed" : null;
  }

  function fmtMmdd(mmdd) {
    return MONTHS[Math.floor(mmdd / 100) - 1] + " " + (mmdd % 100);
  }

  // A date input's "YYYY-MM-DD" as MMDD; the year is discarded.
  function mmddFromInput(v) {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(v || "");
    return m ? Number(m[1]) * 100 + Number(m[2]) : null;
  }

  window.TBRoadSeason = { inSeason, mmddOf, seasonVerdict, fmtMmdd, mmddFromInput };
})(typeof window !== "undefined" ? window : globalThis);
