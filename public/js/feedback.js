// The intake's client half: collect what the browser knows, shrink the photos,
// and suggest an FAQ answer before a question is sent.
//
// **None of this is load-bearing.** The form is a plain server-rendered POST and
// works with every line of this file absent — that is deliberate, because a
// rider whose JavaScript is broken is exactly the rider we most want to hear
// from, and a bug report lost to the bug it was reporting is the worst possible
// failure for this feature.
//
// Two things it does that matter:
//
// **The canvas re-encode strips EXIF.** Riders attach ride photos, EXIF carries
// GPS, and an idea published with a geotagged photo attached would leak a
// rider's home address. Downscaling is the stated reason; the metadata strip is
// the important one.
//
// **Diagnostics are shaped here and redacted on the server.** Nothing in this
// file is the last line of defense — src/feedback/diagnostics.ts strips query
// strings and refuses anything that is not a permission state, because a
// redaction only the client applies is one a hand-built POST skips.
(function () {
  "use strict";

  const B = window.TBBuffer;
  const form = document.querySelector(".fb-flow");

  // --- Diagnostics -----------------------------------------------------------

  function collect() {
    if (!B) return null;
    const safe = B.safe;
    const nav = window.navigator || {};
    const scr = window.screen || {};
    const store = window.TBFeedbackLog || { errors: [], net: [] };

    const mq = function (q) {
      return safe(function () {
        return window.matchMedia(q).matches;
      }, false);
    };

    return B.buildPayload({
      app: {
        version: safe(function () {
          return (window.TB && window.TB.version) || "";
        }, ""),
        pattern: B.routePattern(window.location.pathname),
        // Sent whole; the server strips the query string and fragment. Kept
        // rather than dropped because "they came from the ride list" is often
        // the difference between a reproducible report and a mystery.
        referrer: String(document.referrer || ""),
      },
      device: {
        ua: String(nav.userAgent || ""),
        platform: safe(function () {
          return nav.userAgentData ? nav.userAgentData.platform : "";
        }, ""),
        mobile: safe(function () {
          return !!(nav.userAgentData && nav.userAgentData.mobile);
        }, false),
        vw: window.innerWidth || 0,
        vh: window.innerHeight || 0,
        sw: scr.width || 0,
        sh: scr.height || 0,
        dpr: window.devicePixelRatio || 1,
        // A PWA behaves differently enough that "it works in the browser but
        // not the app" is a real class of report.
        standalone: mq("(display-mode: standalone)"),
        orientation: safe(function () {
          return scr.orientation ? scr.orientation.type : "";
        }, ""),
      },
      prefs: {
        locale: safe(function () {
          return nav.language || "";
        }, ""),
        tz: safe(function () {
          return Intl.DateTimeFormat().resolvedOptions().timeZone;
        }, ""),
        dark: mq("(prefers-color-scheme: dark)"),
        reducedMotion: mq("(prefers-reduced-motion: reduce)"),
      },
      health: {
        online: safe(function () {
          return nav.onLine !== false;
        }, true),
        // Feature-detected, and this is the read that takes the page down if it
        // is not: navigator.connection is absent on Safari and Firefox.
        conn: safe(function () {
          return nav.connection ? nav.connection.effectiveType : "";
        }, ""),
        // A full quota and a Safari tab eviction are two of the most common
        // causes of "it lost my route", and neither leaves any other trace.
        storeUsed: safe(function () {
          let n = 0;
          for (const k in window.localStorage) {
            if (Object.prototype.hasOwnProperty.call(window.localStorage, k)) {
              n += String(window.localStorage[k] || "").length;
            }
          }
          return n;
        }, -1),
        hidden: safe(function () {
          return !!document.hidden;
        }, false),
        restored: !!window.TBFeedbackLog && !!window.TBFeedbackLog.wasRestored,
      },
      // Read from a plain object the map pages publish on window, naming no
      // vendor API. public/js/map-common.js stays the only file that touches
      // google.maps, and this side of the boundary never learns it exists.
      // Decided 2026-08-16 in preference to adding TBMap.snapshot().
      map: safe(function () {
        return window.TBMapState || null;
      }, null),
      permissions: safe(function () {
        return window.TBFeedbackLog ? window.TBFeedbackLog.permissions : null;
      }, null),
      errors: store.errors || [],
      net: store.net || [],
    });
  }

  // --- Photos ----------------------------------------------------------------

  const LONG_EDGE = 1600;
  const JPEG_QUALITY = 0.82;

  /**
   * One image, downscaled and re-encoded as JPEG.
   *
   * Resolves to the ORIGINAL file on any failure. An unshrunk 12 MB photo that
   * arrives is worth more than a shrunk one that does not, and the server caps
   * the size anyway — this is an optimization with a privacy side effect, not a
   * validation step.
   */
  function shrink(file) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type) || typeof createImageBitmap !== "function") return resolve(file);
      createImageBitmap(file)
        .then(function (bmp) {
          const scale = Math.min(1, LONG_EDGE / Math.max(bmp.width, bmp.height));
          const w = Math.max(1, Math.round(bmp.width * scale));
          const h = Math.max(1, Math.round(bmp.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) return resolve(file);
          ctx.drawImage(bmp, 0, 0, w, h);
          bmp.close && bmp.close();
          canvas.toBlob(
            function (blob) {
              if (!blob) return resolve(file);
              // A new File from the canvas output: no EXIF survives a re-encode,
              // which is the point. The name is replaced too — a rider's photo
              // filename can carry a location or a date.
              resolve(new File([blob], "screenshot.jpg", { type: "image/jpeg" }));
            },
            "image/jpeg",
            JPEG_QUALITY,
          );
        })
        .catch(function () {
          resolve(file);
        });
    });
  }

  function wirePhotos() {
    const input = form && form.querySelector(".fb-file");
    if (!input) return;
    let working = false;

    input.addEventListener("change", function () {
      if (working) return;
      const chosen = Array.prototype.slice.call(input.files || []).slice(0, 3);
      if (!chosen.length) return;
      working = true;
      Promise.all(chosen.map(shrink))
        .then(function (out) {
          const dt = new DataTransfer();
          out.forEach(function (f) {
            dt.items.add(f);
          });
          input.files = dt.files;
        })
        .catch(function () {})
        .then(function () {
          working = false;
        });
    });
  }

  // --- FAQ suggestions -------------------------------------------------------

  // Mirrors matchFaq in src/feedback/faq.ts closely enough to be useful and is
  // NOT pinned to it by a test, because nothing depends on the two agreeing: the
  // server never runs this scoring, and a suggestion strip that ranks slightly
  // differently is not a defect. Contrast alternates.js, where a disagreement
  // silently corrupts a stored total.
  const STOP_WORDS =
    " a an and are be can do does for from how i in is it my of on or the this to what when where why will with you your ";

  function tokens(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[’']/g, "")
      .split(/[^a-z0-9]+/)
      .filter(function (w) {
        return w.length >= 3 && STOP_WORDS.indexOf(" " + w + " ") === -1;
      });
  }

  function wireFaq() {
    const box = document.getElementById("fb-faq");
    const area = form && form.querySelector(".fb-body");
    const entries = (window.TB && window.TB.faq) || [];
    if (!box || !area || !entries.length) return;

    let timer = 0;
    function refresh() {
      const words = tokens(area.value);
      if (!words.length) {
        box.hidden = true;
        return;
      }
      const scored = entries
        .map(function (e) {
          const target = tokens(e.q);
          let score = 0;
          words.forEach(function (w) {
            if (target.indexOf(w) !== -1) score += 2;
            else if (
              target.some(function (t) {
                return t.indexOf(w) === 0 || w.indexOf(t) === 0;
              })
            )
              score += 1;
          });
          return { e: e, score: score };
        })
        .filter(function (s) {
          return s.score >= 2;
        })
        .sort(function (a, b) {
          return b.score - a.score;
        })
        .slice(0, 3);

      if (!scored.length) {
        box.hidden = true;
        return;
      }
      box.innerHTML = "";
      const h = document.createElement("p");
      h.className = "fb-faq-head";
      h.textContent = "This might already be answered:";
      box.appendChild(h);
      const ul = document.createElement("ul");
      scored.forEach(function (s) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = "/faq#" + s.e.id;
        a.target = "_blank";
        a.rel = "noopener";
        // textContent, never innerHTML: the FAQ headings come from our own
        // markup, but building an element from a string here would be a habit
        // worth not having in a file that also handles rider input.
        a.textContent = s.e.q;
        li.appendChild(a);
        ul.appendChild(li);
      });
      box.appendChild(ul);
      box.hidden = false;
    }

    area.addEventListener("input", function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 300);
    });
    refresh();
  }

  // --- Wiring ----------------------------------------------------------------

  function wireDiagnostics() {
    if (!form) return;
    const field = form.querySelector('input[name="diag"]');
    if (!field) return;
    // Filled at submit rather than at load, so an error thrown while the rider
    // was typing is in the payload. Filling it early would capture the state
    // before the thing they are reporting happened.
    form.addEventListener("submit", function () {
      try {
        const payload = collect();
        if (payload) field.value = JSON.stringify(payload);
      } catch (e) {
        // A diagnostics failure must never block a submit.
        field.value = "";
      }
    });
  }

  // Chips are radios under the hood, so the platform owns the keyboard and the
  // grouping. This only carries the selected class, which CSS cannot do from a
  // checked input on an ancestor label.
  function wireChips() {
    document.querySelectorAll(".fb-chips").forEach(function (group) {
      group.addEventListener("change", function () {
        group.querySelectorAll(".fb-chip").forEach(function (chip) {
          const input = chip.querySelector("input");
          chip.classList.toggle("is-on", !!(input && input.checked));
        });
      });
    });
  }

  wireDiagnostics();
  wirePhotos();
  wireChips();
  wireFaq();
})();
