// The arithmetic behind the on-the-road page (#69): which leg is current, which
// is next, whether a kept copy is stale, and which hint a phone should read.
//
// Pure — no DOM, no storage, no fetch — for the reason drag-index.js gives:
// everything a rider does at a fuel stop routes through a few lines of index
// arithmetic, and inside go.js's handlers no test could reach them. go.js owns
// the DOM and localStorage and calls these.
//
// A LEG IS NAMED BY {routeUid, part}, never by its position in the flat list.
// The route uid survives every save and the part count is deterministic per
// density, so a rider's place survives a re-render, a reload and a re-kept
// copy — where an index would move the moment a route was reordered.
//
// PROGRESS IS PER DENSITY. Part 3 of 5 at Light is a different piece of road
// from part 3 of 12 at Tight, so a rider who switches density mid-ride is
// shown a fresh list rather than a wrong current leg. Their place at the other
// density is kept, not deleted: switching back restores it.
(function (window) {
  "use strict";

  var KEY_PREFIX = "routeloop.go.";
  var DENSITY_KEY = "routeloop.go.density";
  var DENSITIES = ["off", "light", "tight"];

  function key(slug) {
    return KEY_PREFIX + String(slug);
  }

  // Every leg in ride order, from the per-route part counts the page rendered.
  // `routes` is [{uid, parts}] for ONE density.
  function flatten(routes) {
    var out = [];
    if (!Array.isArray(routes)) return out;
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      if (!r || typeof r.uid !== "string") continue;
      var parts = Math.max(0, Math.floor(Number(r.parts) || 0));
      for (var p = 1; p <= parts; p++) out.push({ routeUid: r.uid, part: p });
    }
    return out;
  }

  // Index of the stored place in a flat list, or -1 when it names no leg in
  // it — a route deleted since, or progress recorded at another density.
  function indexOf(flat, state, density) {
    if (!state || !Array.isArray(flat)) return -1;
    if (state.density !== density) return -1;
    for (var i = 0; i < flat.length; i++) {
      if (flat[i].routeUid === state.routeUid && flat[i].part === state.part) return i;
    }
    return -1;
  }

  // 'done', 'current' or 'todo' for the leg at index i.
  function statusOf(flat, state, density, i) {
    var cur = indexOf(flat, state, density);
    if (cur < 0) return "todo";
    if (i < cur) return "done";
    if (i === cur) return "current";
    return "todo";
  }

  // The leg after the current one, or the first leg when nothing is current,
  // or null when the current leg is the last. Null is a real answer and the
  // caller says "that was the last one" rather than pointing at nothing.
  function advance(flat, state, density) {
    if (!Array.isArray(flat) || flat.length === 0) return null;
    var cur = indexOf(flat, state, density);
    if (cur < 0) return flat[0];
    if (cur + 1 >= flat.length) return null;
    return flat[cur + 1];
  }

  // The state to store when the rider taps the leg at index i.
  function markAt(flat, i, density) {
    if (!Array.isArray(flat) || i < 0 || i >= flat.length) return null;
    return { routeUid: flat[i].routeUid, part: flat[i].part, density: density };
  }

  // Progress is stored as ONE object per ride holding a place per density, so
  // switching density keeps the other one. `read` and `write` are what go.js
  // hands localStorage through; these two only shape the record.
  function placeOf(record, density) {
    if (!record || typeof record !== "object") return null;
    var at = record[density];
    if (!at || typeof at.routeUid !== "string" || !Number.isInteger(at.part)) return null;
    return { routeUid: at.routeUid, part: at.part, density: density };
  }

  function withPlace(record, state) {
    var next = {};
    if (record && typeof record === "object") {
      for (var k in record) if (Object.prototype.hasOwnProperty.call(record, k)) next[k] = record[k];
    }
    if (state && DENSITIES.indexOf(state.density) >= 0) {
      next[state.density] = { routeUid: state.routeUid, part: state.part };
    }
    return next;
  }

  function isDensity(v) {
    return DENSITIES.indexOf(v) >= 0;
  }

  // "just now", "4 min ago", "3 hours ago", "2 days ago". Coarse on purpose:
  // the question is whether the copy is from this trip or last month's.
  function fmtAgo(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    var min = Math.floor(ms / 60000);
    if (min < 1) return "just now";
    if (min < 60) return min + " min ago";
    var h = Math.floor(min / 60);
    if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    var d = Math.floor(h / 24);
    return d + (d === 1 ? " day ago" : " days ago");
  }

  // Whether a kept copy is behind the ride, and the line to say so.
  //
  // `kept` is the registry row {keptAt, updatedAt}; `liveUpdatedAt` is the
  // ride's updated_at as the page just rendered it, or null offline (the
  // rendered page IS the kept copy then, so nothing newer is known).
  function staleness(kept, liveUpdatedAt, now) {
    if (!kept || !Number.isFinite(Date.parse(kept.keptAt))) return null;
    var ago = fmtAgo(now - Date.parse(kept.keptAt));
    var changed = false;
    if (liveUpdatedAt && kept.updatedAt) {
      var live = Date.parse(liveUpdatedAt);
      var had = Date.parse(kept.updatedAt);
      changed = Number.isFinite(live) && Number.isFinite(had) && live > had;
    }
    return {
      changed: changed,
      agoText: "Kept " + ago,
      text: changed ? "Kept " + ago + "—the ride has changed since" : "Kept " + ago,
    };
  }

  // "1.4 MB", "820 kB".
  function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0) return "";
    if (n < 1000) return n + " B";
    if (n < 1000000) return Math.round(n / 1000) + " kB";
    if (n < 1e9) return (n / 1e6).toFixed(1) + " MB";
    return (n / 1e9).toFixed(1) + " GB";
  }

  // Which sentence sits under the Send buttons. Verified rather than hoped:
  // Android Chrome's Web Share refuses .gpx/.kml outright (its permitted list is
  // audio, image, video, pdf and text), so there it is a download; iOS shares
  // the file but the nav apps do not show up in the sheet for a web-shared GPX,
  // so the reliable path is Save to Files and open it from there.
  function hintFor(ua, canShareFiles) {
    var s = String(ua || "");
    var ios = /iP(hone|ad|od)/.test(s) || (/Macintosh/.test(s) && /Mobile/.test(s));
    var android = /Android/.test(s);
    if (ios && canShareFiles) return "ios-share";
    if (ios) return "ios-download";
    if (android) return "android-download";
    if (canShareFiles) return "share";
    return "download";
  }

  var HINTS = {
    "ios-share":
      "Tap a file and pick Save to Files. Then open it from the Files app and choose your nav app—most do not show up in the share sheet directly.",
    "ios-download": "Tap a file and it lands in Downloads in the Files app. Open it from there in your nav app.",
    "android-download": "Tap a file and it lands in Downloads. Import it from there in your nav app, or open it from the download notification.",
    share: "Tap a file to share it to your nav app.",
    download: "Tap a file to download it, then import it in your nav app.",
  };

  window.TBGo = {
    key: key,
    DENSITY_KEY: DENSITY_KEY,
    DENSITIES: DENSITIES,
    flatten: flatten,
    indexOf: indexOf,
    statusOf: statusOf,
    advance: advance,
    markAt: markAt,
    placeOf: placeOf,
    withPlace: withPlace,
    isDensity: isDensity,
    fmtAgo: fmtAgo,
    staleness: staleness,
    fmtBytes: fmtBytes,
    hintFor: hintFor,
    HINTS: HINTS,
  };
})(typeof window !== "undefined" ? window : this);
