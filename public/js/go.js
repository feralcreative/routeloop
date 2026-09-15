// The on-the-road page (#69), /m/:slug/go — and the /offline page, which is
// the same file listing what this phone has kept.
//
// Everything the page does at a fuel stop happens here: which Google Maps leg
// is current and which is next, the ride's files handed to a nav app, and the
// copy kept on the phone for no signal. The arithmetic lives in go-progress.js
// (window.TBGo) where a test can reach it; this file owns the DOM, localStorage
// and the Cache API.
//
// THREE THINGS THAT WERE VERIFIED RATHER THAN ASSUMED, and each shapes a branch:
//
//   - Safari loses the user gesture at the first `await`. navigator.share()
//     called after a fetch throws NotAllowedError, so the files are fetched on
//     load and held in memory, and the tap calls share() synchronously.
//   - Android Chrome's Web Share permits audio, image, video, pdf and text and
//     nothing else — a GPX or a KML is refused. There the button is a plain
//     download, which lands in Downloads, which is where every nav app's Import
//     looks anyway.
//   - iOS shares the file, but a web-shared GPX does not surface the nav apps in
//     the sheet (WebKit does not map it to the GPX UTI), so the hint says Save
//     to Files and open it from there. To be confirmed on hardware.
//
// THE KEPT COPY IS AN EXPLICIT ACT. Nothing about a ride is cached until the
// rider presses Keep, and the service worker (public/js/sw.js) only ever serves
// from cache for a ride whose registry row exists — so a private ride opened on
// a borrowed phone leaves nothing behind. The registry is a synthetic entry per
// ride, `/_kept/<slug>`, in the same cache as the files, so the page and the
// worker read one thing. The name is the one in sw.js; test/sw.test.ts holds
// the two together.
(function () {
  "use strict";

  var G = window.TBGo;
  if (!G) return;

  var KEPT_CACHE = "routeloop-kept";
  var REGISTRY_PREFIX = "/_kept/";

  function readStore(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* private mode: progress simply does not survive the tab */
    }
  }

  function readJson(key) {
    var raw = readStore(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function readParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (e) {
      return null;
    }
  }

  var canCache = typeof window.caches !== "undefined" && "serviceWorker" in navigator;

  function openKept() {
    return window.caches.open(KEPT_CACHE);
  }

  function registryUrl(slug) {
    return REGISTRY_PREFIX + encodeURIComponent(slug);
  }

  function readRegistry(cache, slug) {
    return cache.match(registryUrl(slug)).then(function (res) {
      return res ? res.json().catch(function () { return null; }) : null;
    });
  }

  function writeRegistry(cache, row) {
    var body = JSON.stringify(row);
    return cache.put(
      registryUrl(row.slug),
      new Response(body, { headers: { "Content-Type": "application/json" } }),
    );
  }

  // ===========================================================================
  // The go page
  // ===========================================================================

  function initGo() {
    var tb = window.TB && window.TB.go;
    if (!tb) return;

    var slug = tb.slug;
    var densitySet = document.querySelector(".go-density-set");
    var blocks = Array.prototype.slice.call(document.querySelectorAll(".go-density"));
    var nextBtn = document.getElementById("go-next");
    var resetBtn = document.getElementById("go-reset");

    // --- Density -------------------------------------------------------------
    //
    // The query wins on first paint (it is in riders' bookmarks from the old
    // page), then the phone's memory, then the server's default. Stored as its
    // own key rather than inside the ride's record because it is a preference
    // about the rider, not about one ride.

    var density = tb.density;
    var fromQuery = readParam("density");
    var remembered = readStore(G.DENSITY_KEY);
    if (G.isDensity(fromQuery)) density = fromQuery;
    else if (G.isDensity(remembered)) density = remembered;

    function legsOf() {
      var block = blocks.filter(function (b) {
        return b.getAttribute("data-density") === density;
      })[0];
      if (!block) return [];
      return Array.prototype.slice.call(block.querySelectorAll(".go-leg"));
    }

    function flatOf(legs) {
      return legs.map(function (a) {
        return { routeUid: a.getAttribute("data-route"), part: Number(a.getAttribute("data-part")) };
      });
    }

    // Where a {routeUid, part} sits in the flat list, or -1.
    function legIndex(flat, leg) {
      if (!leg) return -1;
      for (var i = 0; i < flat.length; i++) {
        if (flat[i].routeUid === leg.routeUid && flat[i].part === leg.part) return i;
      }
      return -1;
    }

    function applyDensity() {
      blocks.forEach(function (b) {
        var on = b.getAttribute("data-density") === density;
        b.hidden = !on;
        b.classList.toggle("is-on", on);
      });
      if (densitySet) {
        Array.prototype.forEach.call(densitySet.querySelectorAll(".go-density-btn"), function (btn) {
          btn.setAttribute("aria-pressed", btn.getAttribute("data-density") === density ? "true" : "false");
        });
      }
      paintProgress();
    }

    if (densitySet) {
      densitySet.addEventListener("click", function (e) {
        var btn = e.target.closest(".go-density-btn");
        if (!btn) return;
        var d = btn.getAttribute("data-density");
        if (!G.isDensity(d) || d === density) return;
        density = d;
        writeStore(G.DENSITY_KEY, d);
        applyDensity();
      });
    }

    // --- Progress ------------------------------------------------------------
    //
    // ONE RECORD PER RIDE, one place per density inside it. Tapping a leg marks
    // it current; everything before it is done. Next opens the leg after the
    // current one and marks it, which is the one tap the page is for.

    function place() {
      return G.placeOf(readJson(G.key(slug)), density);
    }

    function setPlace(state) {
      writeStore(G.key(slug), JSON.stringify(G.withPlace(readJson(G.key(slug)), state)));
    }

    function clearPlace() {
      var rec = readJson(G.key(slug)) || {};
      delete rec[density];
      writeStore(G.key(slug), JSON.stringify(rec));
    }

    function paintProgress() {
      var legs = legsOf();
      var flat = flatOf(legs);
      var state = place();
      legs.forEach(function (a, i) {
        var st = G.statusOf(flat, state, density, i);
        a.classList.toggle("is-done", st === "done");
        a.classList.toggle("is-current", st === "current");
        if (st === "current") a.setAttribute("aria-current", "step");
        else a.removeAttribute("aria-current");
      });
      var next = G.advance(flat, state, density);
      if (nextBtn) {
        if (flat.length === 0) {
          nextBtn.hidden = true;
        } else if (next) {
          var a = legs[legIndex(flat, next)];
          var label = a ? a.querySelector(".go-leg-label") : null;
          nextBtn.hidden = false;
          nextBtn.textContent = (state ? "Next leg: " : "First leg: ") + (label ? label.textContent : "");
        } else {
          nextBtn.hidden = false;
          nextBtn.textContent = "That was the last leg";
          nextBtn.disabled = true;
        }
        if (next) nextBtn.disabled = false;
      }
      if (resetBtn) resetBtn.hidden = !state;
    }

    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest(".go-leg");
      if (!a) return;
      var legs = legsOf();
      var i = legs.indexOf(a);
      if (i < 0) return;
      var state = G.markAt(flatOf(legs), i, density);
      if (state) setPlace(state);
      // The anchor opens Maps on its own; repaint after the click completes.
      setTimeout(paintProgress, 0);
    });

    if (nextBtn) {
      nextBtn.addEventListener("click", function () {
        var legs = legsOf();
        var flat = flatOf(legs);
        var next = G.advance(flat, place(), density);
        var i = legIndex(flat, next);
        if (i < 0) return;
        setPlace(G.markAt(flat, i, density));
        paintProgress();
        // Synchronous, inside the tap, or a popup blocker eats it.
        window.open(legs[i].href, "_blank", "noopener");
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        clearPlace();
        paintProgress();
      });
    }

    applyDensity();

    // --- Send ----------------------------------------------------------------
    //
    // The files are fetched now and held as File objects, because share() has
    // to be called with no await between the tap and the call. Offline, the
    // fetch is answered by the service worker from the kept copy. Until a file
    // is in hand its button is inert rather than a download that would fail.

    var fileBtns = Array.prototype.slice.call(document.querySelectorAll(".go-file"));
    var hintEl = document.getElementById("go-send-hint");
    var held = {};
    var canShareFiles = false;
    try {
      canShareFiles =
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [new File(["x"], "probe.gpx", { type: "application/gpx+xml" })] });
    } catch (e) {
      canShareFiles = false;
    }
    var hint = G.hintFor(navigator.userAgent, canShareFiles);
    // Android is never a share, whatever canShare claims for the probe — the
    // permitted list is the browser's and it has no GPX in it.
    var useShare = canShareFiles && hint !== "android-download";
    if (hintEl) {
      hintEl.textContent = G.HINTS[hint];
      hintEl.hidden = false;
    }

    var preloads = (tb.files || []).map(function (f) {
      var btn = fileBtns.filter(function (b) {
        return b.getAttribute("data-format") === f.format;
      })[0];
      if (btn) {
        btn.setAttribute("aria-disabled", "true");
        btn.dataset.label = btn.textContent;
        btn.textContent = f.label + "—preparing…";
      }
      return fetch(f.url, { credentials: "same-origin" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.blob();
        })
        .then(function (blob) {
          held[f.format] = new File([blob], f.name, { type: f.mime });
          if (btn) {
            btn.removeAttribute("aria-disabled");
            btn.textContent = btn.dataset.label;
          }
          return blob;
        })
        .catch(function () {
          // Leave the button as the plain download link the server rendered;
          // if the network is genuinely gone that fails too, and the hint
          // beside it already said Keep on this phone is the answer.
          if (btn) {
            btn.removeAttribute("aria-disabled");
            btn.textContent = btn.dataset.label;
          }
          return null;
        });
    });

    fileBtns.forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        var file = held[btn.getAttribute("data-format")];
        if (!file) return; // plain download, as rendered
        e.preventDefault();
        if (useShare) {
          var p = navigator.share({ files: [file], title: tb.title });
          p.catch(function (err) {
            // Dismissed: nothing to do. Refused: hand them the download.
            if (err && err.name === "AbortError") return;
            downloadFile(file);
          });
          return;
        }
        downloadFile(file);
      });
    });

    function downloadFile(file) {
      var url = URL.createObjectURL(file);
      var a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 2000);
    }

    // --- Keep ----------------------------------------------------------------

    var keepSection = document.getElementById("go-keep");
    var keepBtn = document.getElementById("go-keep-btn");
    var forgetBtn = document.getElementById("go-forget-btn");
    var keepStatus = document.getElementById("go-keep-status");
    if (!canCache || !keepSection || !keepBtn || !forgetBtn || !keepStatus) {
      initInstall(document.getElementById("go-install"));
      return;
    }
    keepSection.hidden = false;

    function setStatus(text, cls) {
      keepStatus.textContent = text;
      keepStatus.className = "go-keep-status" + (cls ? " " + cls : "");
    }

    function urlsToKeep() {
      return [tb.pageUrl, tb.roadbookUrl].concat(
        (tb.files || []).map(function (f) {
          return f.url;
        }),
      );
    }

    function keep() {
      keepBtn.disabled = true;
      var urls = urlsToKeep();
      var bytes = 0;
      var done = 0;
      var cache;
      setStatus("Keeping… 0 of " + urls.length);
      return openKept()
        .then(function (c) {
          cache = c;
          // The registry row goes in FIRST, so the worker's own network-first
          // pass on any of these fetches also lands in the cache.
          return writeRegistry(cache, {
            slug: slug,
            title: tb.title,
            keptAt: new Date().toISOString(),
            updatedAt: tb.updatedAt,
            pageUrl: tb.pageUrl,
            roadbookUrl: tb.roadbookUrl,
            files: tb.files,
            bytes: 0,
          });
        })
        .then(function () {
          return Promise.all(
            urls.map(function (url) {
              return fetch(url, { credentials: "same-origin", cache: "no-store" })
                .then(function (res) {
                  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
                  return res.blob().then(function (blob) {
                    bytes += blob.size;
                    // Only the headers a reader of the copy needs. The blob is
                    // already decoded, so a Content-Encoding copied across would
                    // describe bytes that are not there.
                    var headers = { "Content-Type": res.headers.get("Content-Type") || "application/octet-stream" };
                    var cd = res.headers.get("Content-Disposition");
                    if (cd) headers["Content-Disposition"] = cd;
                    return cache.put(url, new Response(blob, { status: 200, headers: headers }));
                  });
                })
                .then(function () {
                  done += 1;
                  setStatus("Keeping… " + done + " of " + urls.length);
                });
            }),
          );
        })
        .then(function () {
          return writeRegistry(cache, {
            slug: slug,
            title: tb.title,
            keptAt: new Date().toISOString(),
            updatedAt: tb.updatedAt,
            pageUrl: tb.pageUrl,
            roadbookUrl: tb.roadbookUrl,
            files: tb.files,
            bytes: bytes,
          });
        })
        .then(function () {
          if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
          return describeKept();
        })
        .catch(function (err) {
          setStatus("Could not keep it: " + (err && err.message ? err.message : "unknown error"), "is-error");
          keepBtn.disabled = false;
        });
    }

    function forget() {
      forgetBtn.disabled = true;
      return openKept()
        .then(function (cache) {
          return Promise.all(
            urlsToKeep()
              .concat([registryUrl(slug)])
              .map(function (u) {
                return cache.delete(u, { ignoreSearch: false });
              }),
          );
        })
        .then(describeKept)
        .catch(function () {
          forgetBtn.disabled = false;
        });
    }

    function describeKept() {
      return openKept()
        .then(function (cache) {
          return readRegistry(cache, slug);
        })
        .then(function (row) {
          keepBtn.disabled = false;
          forgetBtn.disabled = false;
          if (!row) {
            forgetBtn.hidden = true;
            keepBtn.textContent = "Keep on this phone";
            setStatus("", "");
            return null;
          }
          forgetBtn.hidden = false;
          keepBtn.textContent = "Keep again";
          var s = G.staleness(row, navigator.onLine ? tb.updatedAt : null, Date.now());
          var size = row.bytes ? " " + String.fromCharCode(0xb7) + " " + G.fmtBytes(row.bytes) : "";
          setStatus((s ? s.text : "Kept") + size, s && s.changed ? "is-stale" : "is-kept");
          if (navigator.storage && navigator.storage.estimate) {
            navigator.storage.estimate().then(function (q) {
              if (q && q.quota) keepStatus.textContent += " " + String.fromCharCode(0xb7) + " " + G.fmtBytes(q.quota - (q.usage || 0)) + " free";
            }).catch(function () {});
          }
          return s;
        });
    }

    keepBtn.addEventListener("click", keep);
    forgetBtn.addEventListener("click", forget);

    // On load: say what is kept, and if the ride has moved on since and we are
    // online, keep it again silently — Keep is a promise the copy is usable.
    describeKept().then(function (s) {
      if (s && s.changed && navigator.onLine) keep();
    });

    initInstall(document.getElementById("go-install"));
  }

  // --- Install -----------------------------------------------------------------
  //
  // Android raises beforeinstallprompt and gets a button; iOS has no such event
  // and gets one line saying where Add to Home Screen is. Both hidden once the
  // page is running installed.

  function initInstall(el) {
    if (!el) return;
    var standalone =
      (window.matchMedia && (window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: minimal-ui)").matches)) ||
      navigator.standalone === true;
    if (standalone) return;
    var ua = navigator.userAgent || "";
    if (/iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))) {
      el.textContent = "Add Routeloop to your Home Screen from Safari’s share menu and this page opens like an app.";
      el.hidden = false;
      return;
    }
    var deferred = null;
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferred = e;
      el.innerHTML = '<button class="btn" type="button" id="go-install-btn">Install Routeloop</button> Opens like an app, with the rides you keep.';
      el.hidden = false;
      var btn = document.getElementById("go-install-btn");
      if (btn) {
        btn.addEventListener("click", function () {
          if (!deferred) return;
          deferred.prompt();
          deferred.userChoice.then(function () {
            deferred = null;
            el.hidden = true;
          });
        });
      }
    });
  }

  // ===========================================================================
  // The /offline page: what this phone has kept
  // ===========================================================================

  function initOffline() {
    var host = document.getElementById("offline-kept");
    if (!host) return;
    if (!canCache) {
      host.innerHTML = '<p class="offline-empty">This browser cannot keep rides for offline use.</p>';
      return;
    }
    openKept()
      .then(function (cache) {
        return cache.keys().then(function (reqs) {
          var rows = reqs.filter(function (r) {
            return new URL(r.url).pathname.indexOf(REGISTRY_PREFIX) === 0;
          });
          return Promise.all(
            rows.map(function (r) {
              return cache.match(r).then(function (res) {
                return res ? res.json().catch(function () { return null; }) : null;
              });
            }),
          );
        });
      })
      .then(function (rows) {
        rows = rows.filter(Boolean).sort(function (a, b) {
          return Date.parse(b.keptAt) - Date.parse(a.keptAt);
        });
        if (rows.length === 0) {
          host.innerHTML = '<p class="offline-empty">No rides are kept on this phone. Open a ride’s On the road page while you have signal and press Keep on this phone.</p>';
          return;
        }
        var now = Date.now();
        host.innerHTML =
          '<ul class="offline-list">' +
          rows
            .map(function (r) {
              var s = G.staleness(r, null, now);
              return (
                '<li><a class="btn offline-ride" href="' +
                esc(r.pageUrl) +
                '"><span><span class="offline-ride-title">' +
                esc(r.title) +
                '</span><span class="offline-ride-when">' +
                esc(s ? s.agoText : "") +
                "</span></span></a></li>"
              );
            })
            .join("") +
          "</ul>";
      })
      .catch(function () {
        host.innerHTML = '<p class="offline-empty">Could not read what this phone has kept.</p>';
      });
  }

  function init() {
    initGo();
    initOffline();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
