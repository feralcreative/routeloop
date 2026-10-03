// The Near me tab on /explore (#37). Asks the browser where the rider is, then fetches
// the list from /api/explore/near and swaps it in. A fetch rather than a page address
// with the coordinates in it, because analytics records page addresses.
(function () {
  "use strict";
  const btn = document.getElementById("explore-near-locate");
  const list = document.getElementById("explore-near-list");
  const status = document.getElementById("explore-near-status");
  if (!btn || !list || !navigator.geolocation) return;
  btn.hidden = false;
  const say = (t) => {
    status.textContent = t;
  };
  btn.addEventListener("click", () => {
    btn.disabled = true;
    say("Finding you…");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const q = new URLSearchParams({ lng: pos.coords.longitude.toFixed(4), lat: pos.coords.latitude.toFixed(4) });
        try {
          const res = await fetch("/api/explore/near?" + q, { credentials: "same-origin" });
          if (!res.ok) throw new Error(String(res.status));
          const data = await res.json();
          list.innerHTML = data.html;
          say(data.count ? "" : "Nothing public passes near you yet.");
        } catch (e) {
          say("That did not load. Try again in a moment.");
        } finally {
          btn.disabled = false;
        }
      },
      (err) => {
        btn.disabled = false;
        say(err && err.code === 1 ? "Location is blocked for this site." : "Could not find your location.");
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 },
    );
  });
})();
