// Keeping a ride on this phone: the one place the kept cache is written or
// read. Lived inside go.js from the day #69 landed until 2026-09-17, when the
// ride list grew a Keep sign of its own and two copies of "write the registry
// row first, then fetch every file, then write it again with the size" was one
// too many. go.js and rides.js both call this; neither opens the cache itself.
//
// WHAT A KEPT RIDE IS. One registry row per ride at `/_kept/<slug>` — a
// synthetic entry in the same cache as the files, so the page and the record
// of the page cannot come apart — plus the go page, the roadbook and the GPX
// (KML and the Routeloop file rode along until 2026-09-17 and were the same
// geometry twice more), each stored under the exact URL the pages reference. The service
// worker (public/js/sw.js) serves a ride from cache ONLY when its registry row
// exists, which is why the row goes in FIRST: the worker's own network-first
// pass on the fetches below then lands them in the cache as well, and a ride
// nobody pressed Keep on leaves nothing behind.
//
// A MANIFEST IS THE SIX FIELDS THE ROW HOLDS: slug, title, updatedAt, pageUrl,
// roadbookUrl, files (each with a url). The go page builds one into
// `window.TB.go`; the ride list fetches one from `/m/<slug>/keep.json` when a
// sign is pressed, so a list of forty rides does not carry forty manifests.
//
// NOTHING HERE TOUCHES THE DOM. Progress and errors are handed back to the
// caller, which knows what it is painting.
(function (window) {
  "use strict";

  var KEPT_CACHE = "routeloop-kept";
  var REGISTRY_PREFIX = "/_kept/";

  var canCache = typeof window.caches !== "undefined" && "serviceWorker" in navigator;

  function openKept() {
    return window.caches.open(KEPT_CACHE);
  }

  function registryUrl(slug) {
    return REGISTRY_PREFIX + encodeURIComponent(slug);
  }

  function readRegistry(cache, slug) {
    return cache.match(registryUrl(slug)).then(function (res) {
      return res
        ? res.json().catch(function () {
            return null;
          })
        : null;
    });
  }

  function writeRegistry(cache, row) {
    var body = JSON.stringify(row);
    return cache.put(registryUrl(row.slug), new Response(body, { headers: { "Content-Type": "application/json" } }));
  }

  function urlsOf(m) {
    return [m.pageUrl, m.roadbookUrl].concat(
      (m.files || []).map(function (f) {
        return f.url;
      }),
    );
  }

  // `via` is who asked: "hand" for a press on a sign, "policy" for the "On this
  // phone" switch on /rides. The switch removes only what it added, so a ride
  // a rider kept by hand outlives a change of policy — that book is kept here,
  // on the row, and nowhere else.
  function rowOf(m, bytes, via) {
    return {
      slug: m.slug,
      title: m.title,
      keptAt: new Date().toISOString(),
      updatedAt: m.updatedAt,
      pageUrl: m.pageUrl,
      roadbookUrl: m.roadbookUrl,
      files: m.files,
      bytes: bytes,
      via: via === "policy" ? "policy" : "hand",
    };
  }

  // Resolves to the finished registry row; rejects with the first failure.
  // `onProgress(done, total)` is called as each file lands.
  function keep(m, onProgress, via) {
    var urls = urlsOf(m);
    var bytes = 0;
    var done = 0;
    var cache;
    if (onProgress) onProgress(0, urls.length);
    return openKept()
      .then(function (c) {
        cache = c;
        return writeRegistry(cache, rowOf(m, 0, via));
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
                if (onProgress) onProgress(done, urls.length);
              });
          }),
        );
      })
      .then(function () {
        var row = rowOf(m, bytes, via);
        return writeRegistry(cache, row).then(function () {
          return row;
        });
      })
      .then(function (row) {
        // Ask the browser not to evict this on its own. Best effort: Safari
        // says no unless the app is on the Home Screen, and says so silently.
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
        return row;
      });
  }

  function forget(m) {
    return openKept().then(function (cache) {
      return Promise.all(
        urlsOf(m)
          .concat([registryUrl(m.slug)])
          .map(function (u) {
            return cache.delete(u, { ignoreSearch: false });
          }),
      );
    });
  }

  function readRow(slug) {
    return openKept().then(function (cache) {
      return readRegistry(cache, slug);
    });
  }

  // Every registry row this phone holds, newest first.
  function listRows() {
    return openKept()
      .then(function (cache) {
        return cache.keys().then(function (reqs) {
          var rows = reqs.filter(function (r) {
            return new URL(r.url).pathname.indexOf(REGISTRY_PREFIX) === 0;
          });
          return Promise.all(
            rows.map(function (r) {
              return cache.match(r).then(function (res) {
                return res
                  ? res.json().catch(function () {
                      return null;
                    })
                  : null;
              });
            }),
          );
        });
      })
      .then(function (rows) {
        return rows.filter(Boolean).sort(function (a, b) {
          return Date.parse(b.keptAt) - Date.parse(a.keptAt);
        });
      });
  }

  window.TBKeep = {
    canCache: canCache,
    keep: keep,
    forget: forget,
    readRow: readRow,
    listRows: listRows,
    urlsOf: urlsOf,
  };
})(window);
