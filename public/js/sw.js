// The service worker (#69). Served at /sw.js by a route in src/index.tsx, which
// fills in the two placeholders below; it lives under public/js/ so the Docker
// build minifies it with everything else, and it is never served from there.
//
// WHAT IT IS FOR, AND ALL IT IS FOR: an installable Routeloop whose on-the-road
// page, roadbook and files open with no signal for the rides a rider has
// explicitly KEPT. It is not push — notifications.js raises Chrome's own
// notifications from a live page and that has not changed — and it is not a
// general cache of the site.
//
// TWO CACHES, AND ONLY ONE OF THEM IS THE WORKER'S TO DROP.
//
//   routeloop-shell-<build>   the app shell: the stylesheet, the scripts the go
//                             page loads, the fonts, the icons, /offline. Keyed
//                             on the build, replaced whole at activate.
//   routeloop-kept            the rides a rider kept: the go page, the roadbook,
//                             the files, and a registry row per ride. RIDER
//                             DATA. It survives every deploy and is never
//                             touched here except to serve from and refresh.
//
// ONLY A KEPT RIDE IS EVER SERVED FROM CACHE. The registry row `/_kept/<slug>`
// is written by go.js when the rider presses Keep, and a ride URL whose slug has
// no row is handed straight to the network with nothing stored — so a private
// ride opened on a borrowed phone leaves nothing behind. go.js writes the row
// FIRST so the worker's own network-first pass fills the cache too.
//
// THE DENYLIST IS THE OTHER HALF OF THAT PROMISE. The builder's API, the
// notification poll, admin, sign-in and every non-public API never pass
// through here at all: an early `return` with no respondWith is the browser's
// default behavior, exactly as if there were no worker. test/sw.test.ts pins
// the list.
//
// SHELL ASSETS FALL BACK BY PATH. Every asset URL carries `?v=<hash>` (see
// src/views/assets.ts), and a kept go page references the hashes of the deploy
// it was kept under. After the next deploy that shell is gone; offline, the
// request for `main.min.css?v=old` matches the new stylesheet by path instead.
// A slightly newer stylesheet under a slightly older page beats an unstyled
// page, and the page itself is refreshed by the network-first rule on the next
// online visit.
//
// Classic script. No importScripts, no modules, and the placeholders are
// string literals so esbuild leaves them alone.
/* eslint-disable no-restricted-globals */
(function (self) {
  "use strict";

  var BUILD = "__RL_BUILD__";
  var PRECACHE = "__RL_PRECACHE__";
  var SHELL = "routeloop-shell-" + BUILD;
  var KEPT = "routeloop-kept";
  var OFFLINE = "/offline";
  var REGISTRY_PREFIX = "/_kept/";

  // What the worker never touches. Anchored at the path start; `api/(?!public/)`
  // is every API but the by-slug public one.
  var DENY = /^\/(api\/(?!public\/)|admin|login|logout|auth|account|healthz|sw\.js|dev|build|import|export|settings|profile|riders|friends|notifications|feedback)(\/|$)/;

  // The shell: things the go page loads by path. Matched with ignoreSearch so a
  // hashed URL from an older page still finds the file.
  var SHELL_PATH = /^\/(js|style|font|img\/favicon)\/|^\/img\/site\.webmanifest$/;

  // A kept ride's own URLs: the page, the roadbook, the by-slug files.
  var RIDE_PAGE = /^\/m\/([^/]+)\/(go|roadbook)$/;
  var RIDE_FILE = /^\/api\/public\/maps\/([^/]+)\//;

  function precacheList() {
    try {
      var list = typeof PRECACHE === "string" ? JSON.parse(PRECACHE) : PRECACHE;
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  self.addEventListener("install", function (event) {
    event.waitUntil(
      caches
        .open(SHELL)
        .then(function (cache) {
          // addAll is atomic: one missing file fails the install, which is the
          // loud failure test/sw.test.ts exists to prevent in the first place.
          return cache.addAll(precacheList());
        })
        .then(function () {
          return self.skipWaiting();
        }),
    );
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(
      caches
        .keys()
        .then(function (names) {
          return Promise.all(
            names
              .filter(function (n) {
                // Old shells only. KEPT is rider data and is not ours to drop.
                return n.indexOf("routeloop-shell-") === 0 && n !== SHELL;
              })
              .map(function (n) {
                return caches.delete(n);
              }),
          );
        })
        .then(function () {
          return self.clients.claim();
        }),
    );
  });

  function slugOf(path) {
    var m = RIDE_PAGE.exec(path) || RIDE_FILE.exec(path);
    return m ? m[1] : null;
  }

  function isKept(slug) {
    return caches.open(KEPT).then(function (cache) {
      return cache.match(REGISTRY_PREFIX + encodeURIComponent(slug)).then(function (res) {
        return Boolean(res);
      });
    });
  }

  function offlinePage() {
    return caches.open(SHELL).then(function (cache) {
      return cache.match(OFFLINE, { ignoreSearch: true });
    });
  }

  function fromShell(request) {
    return caches.open(SHELL).then(function (cache) {
      return cache.match(request).then(function (hit) {
        if (hit) return hit;
        return cache.match(request, { ignoreSearch: true }).then(function (byPath) {
          return byPath || fetch(request);
        });
      });
    });
  }

  // Network first, cache on success, cache on failure. The page a rider opens
  // with signal refreshes its own kept copy; the one they open without it is
  // answered from that copy.
  function keptRide(request) {
    return caches.open(KEPT).then(function (cache) {
      return fetch(request)
        .then(function (res) {
          if (res && res.ok) cache.put(request, res.clone()).catch(function () {});
          return res;
        })
        .catch(function () {
          return cache.match(request, { ignoreSearch: true }).then(function (hit) {
            if (hit) return hit;
            if (request.mode === "navigate") {
              return offlinePage().then(function (page) {
                return page || Response.error();
              });
            }
            return Response.error();
          });
        });
    });
  }

  self.addEventListener("fetch", function (event) {
    var request = event.request;
    if (request.method !== "GET") return;
    var url;
    try {
      url = new URL(request.url);
    } catch (e) {
      return;
    }
    if (url.origin !== self.location.origin) return;
    var path = url.pathname;
    if (DENY.test(path)) return;

    if (SHELL_PATH.test(path)) {
      event.respondWith(fromShell(request));
      return;
    }

    var slug = slugOf(path);
    if (slug) {
      event.respondWith(
        isKept(slug).then(function (kept) {
          if (kept) return keptRide(request);
          // Not kept: the network, and nothing stored. A navigation with no
          // network still deserves the offline page rather than the browser's.
          return fetch(request).catch(function () {
            if (request.mode === "navigate") {
              return offlinePage().then(function (page) {
                return page || Response.error();
              });
            }
            return Response.error();
          });
        }),
      );
      return;
    }

    // Every other navigation, INCLUDING /rides — the manifest's start_url since
    // 2026-09-15. A signed-in page is never stored, and it is deliberately not
    // in DENY: this branch is what turns an installed app opened with no
    // signal into the offline page listing the kept rides, where a denied
    // path would get the browser's own error page.
    if (request.mode === "navigate") {
      event.respondWith(
        fetch(request).catch(function () {
          return offlinePage().then(function (page) {
            return page || Response.error();
          });
        }),
      );
      return;
    }
    // Everything else: the browser's own behavior, untouched.
  });
})(self);
