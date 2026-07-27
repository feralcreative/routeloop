// Resolves the home address to coordinates so the builder never has to geocode.
// The form works fine without this: a failed or skipped lookup just leaves the
// hidden coordinate fields empty, and the server stores the address as text.
//
// The forward-geocode call duplicates the one in builder.js — that file is a
// closed IIFE which exports nothing, and map-common.js is the wrong home because
// it assumes Mapbox GL is loaded, which this page has no reason to do. Worth
// extracting into a shared helper if a third caller ever appears.
(function () {
  "use strict";

  const form = document.querySelector(".profile-form");
  if (!form) return;

  const token = (window.TB && window.TB.token) || "";
  const status = document.getElementById("geocode-status");
  const latEl = document.getElementById("f-homeLat");
  const lngEl = document.getElementById("f-homeLng");
  const parts = ["addressLine", "city", "state", "postalCode"].map((n) => document.getElementById("f-" + n));

  if (!token || !status || !latEl || !lngEl || parts.some((el) => !el)) return;

  // The address the current coordinates belong to. Lets an untouched form keep
  // the saved coordinates instead of re-fetching them on every page load.
  let resolvedFor = parts.map((el) => el.value.trim()).join(", ");
  let timer = null;
  let seq = 0;

  function query() {
    return parts
      .map((el) => el.value.trim())
      .filter(Boolean)
      .join(", ");
  }

  function clearCoords(message) {
    latEl.value = "";
    lngEl.value = "";
    status.textContent = message || "";
  }

  async function resolve() {
    const q = query();
    if (q === resolvedFor) return;

    // Too little to be worth a lookup, and a stale coordinate pair must not
    // survive the address being emptied.
    if (q.length < 6) {
      resolvedFor = q;
      clearCoords("");
      return;
    }

    // Out-of-order responses would otherwise let a slow earlier request
    // overwrite a fast later one.
    const mine = ++seq;
    status.textContent = "Looking up address…";

    try {
      const url =
        "https://api.mapbox.com/search/geocode/v6/forward?q=" +
        encodeURIComponent(q) +
        "&limit=1&access_token=" +
        token;
      const res = await fetch(url);
      if (!res.ok) throw new Error("geocode failed: " + res.status);
      const data = await res.json();
      if (mine !== seq) return;

      const hit = data && data.features && data.features[0];
      if (!hit || !hit.geometry || !hit.geometry.coordinates) {
        resolvedFor = q;
        clearCoords("Could not place that address. It will still be saved as text.");
        return;
      }

      const coords = hit.geometry.coordinates;
      lngEl.value = String(coords[0]);
      latEl.value = String(coords[1]);
      resolvedFor = q;
      status.textContent = "Matched: " + ((hit.properties && hit.properties.full_address) || q);
    } catch (e) {
      if (mine !== seq) return;
      resolvedFor = q;
      clearCoords("Address lookup is unavailable right now. It will still be saved as text.");
    }
  }

  parts.forEach(function (el) {
    el.addEventListener("blur", function () {
      clearTimeout(timer);
      timer = setTimeout(resolve, 150);
    });
  });

  // Catches someone who fills the last field and submits without leaving it. The
  // lookup is not awaited — blocking a save on a network call is exactly the
  // failure mode this whole file is written to avoid.
  form.addEventListener("submit", function () {
    clearTimeout(timer);
  });
})();
