// Miles or kilometers, on the client.
//
// MIRRORS src/views/units.ts AND HAS TO STAY IN STEP, the same arrangement as
// duration.js/duration.ts and filename.js/filename.ts. test/units-client.test.ts
// is what holds the two together — it asserts both implementations agree on the
// same inputs, because a builder that says 399 km while the roadbook says 402
// is a disagreement nobody would think to look for.
//
// The value arrives as `window.TB.units` and is the rider's stored preference,
// already coerced server-side. Anything else here defaults to imperial, which is
// the column default, so a page that forgot to pass it reads as it always did.
(function (window) {
  "use strict";

  var METERS_PER_MILE = 1609.344;
  var METERS_PER_KM = 1000;

  function toUnits(v) {
    return v === "metric" ? "metric" : "imperial";
  }

  /** How far, in the rider's own unit, from a distance in METERS. */
  function distanceFrom(meters, units) {
    return meters / (toUnits(units) === "metric" ? METERS_PER_KM : METERS_PER_MILE);
  }

  /** How far, in the rider's own unit, from a distance already in MILES. */
  function distanceFromMiles(miles, units) {
    return toUnits(units) === "metric" ? (miles * METERS_PER_MILE) / METERS_PER_KM : miles;
  }

  /**
   * Degrees per mile to degrees per the rider's own unit.
   *
   * A CONVERSION, NOT A RE-MEASUREMENT, and it goes the way that looks wrong: a
   * kilometer is SHORTER than a mile, so the same road accumulates FEWER degrees
   * in one and the metric figure is smaller. Multiplying instead would make every
   * metric rider's roads read about 1.6x twistier than they are.
   *
   * The BAND LABEL is not converted with it — TWIST_BANDS are thresholds on
   * degrees per mile, so the label is looked up from the mile figure and only the
   * printed number moves. See rollUpTwist() in src/stats/shape.ts.
   */
  function twistFrom(dpm, units) {
    return toUnits(units) === "metric" ? dpm / (METERS_PER_MILE / METERS_PER_KM) : dpm;
  }

  function distanceUnit(units) {
    return toUnits(units) === "metric" ? "km" : "mi";
  }

  function twistUnit(units) {
    return toUnits(units) === "metric" ? "°/km" : "°/mi";
  }

  window.TBUnits = {
    toUnits: toUnits,
    distanceFrom: distanceFrom,
    distanceFromMiles: distanceFromMiles,
    twistFrom: twistFrom,
    distanceUnit: distanceUnit,
    twistUnit: twistUnit,
    METERS_PER_MILE: METERS_PER_MILE,
    METERS_PER_KM: METERS_PER_KM,
  };
})(typeof window !== "undefined" ? window : this);
