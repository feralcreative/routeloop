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

  // 'closed' when the route's date is in season, 'seasonal' when the route is
  // undated, null when it is dated outside the season.
  function seasonVerdict(season, routeStart, routeEnd) {
    if (!routeStart) return "seasonal";
    const days = [mmddOf(routeStart)];
    if (routeEnd) days.push(mmddOf(routeEnd));
    return days.some((d) => inSeason(season.start, season.end, d)) ? "closed" : null;
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
