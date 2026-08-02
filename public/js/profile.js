// Resolves both address blocks to coordinates so the builder never has to
// geocode. The form works fine without this: a failed or skipped lookup just
// leaves the hidden coordinate fields empty, and the server stores the address
// as text.
//
// Goes through POST /api/geocode rather than calling a provider directly. The
// key that may call Geocoding is IP-restricted to the server, so a browser
// cannot use it — the same reason POST /api/route exists. This is what retired
// the last Mapbox dependency.
(function () {
  "use strict";

  const form = document.querySelector(".profile-form");
  if (!form) return;

  // Two addresses now: home, and the public starting point a shared ride begins
  // from instead. They geocode identically, so the whole thing is a factory
  // rather than two copies that drift.
  const BLOCKS = [
    { fields: ["addressLine", "city", "state", "postalCode"], lat: "f-homeLat", lng: "f-homeLng", status: "geocode-status" },
    {
      fields: ["startAddressLine", "startCity", "startState", "startPostalCode"],
      lat: "f-startLat",
      lng: "f-startLng",
      status: "start-geocode-status",
    },
  ];

  function wire(block) {
  const status = document.getElementById(block.status);
  const latEl = document.getElementById(block.lat);
  const lngEl = document.getElementById(block.lng);
  const parts = block.fields.map((n) => document.getElementById("f-" + n));
  if (!status || !latEl || !lngEl || parts.some((el) => !el)) return;

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
      const res = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: q }),
      });
      if (mine !== seq) return;

      // 404 is "no match", which is a normal answer rather than a failure: the
      // address is still saved as text and the rider is told so.
      if (res.status === 404) {
        resolvedFor = q;
        clearCoords("Could not place that address. It will still be saved as text.");
        return;
      }
      if (!res.ok) throw new Error("geocode failed: " + res.status);

      const hit = await res.json();
      if (mine !== seq) return;

      lngEl.value = String(hit.lng);
      latEl.value = String(hit.lat);
      resolvedFor = q;
      status.textContent = "Matched: " + (hit.label || q);
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
  }

  BLOCKS.forEach(wire);
})();
