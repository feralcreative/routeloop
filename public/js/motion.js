// Does this rider want motion? One answer, for every script that asks.
//
// The CSS half of this lives in style/_motion.scss and the two have to agree —
// a page whose animation is stopped by the stylesheet but still driven by a
// script is doing the work and hiding the result.
//
// **THE SAME THREE CASES AS THE MIXIN**, in the same order and for the same
// reasons. `data-motion` is stamped on <html> by src/views/layout.tsx:
//
//   never   the rider said so. Nothing else is consulted.
//   always  the rider wants motion even though the machine may say reduce.
//   absent  `system` — no attribute, so the media query answers. This is what
//           the app did everywhere before the setting existed.
//
// Kept out of site.js on purpose: map-common.js, dashboard.js and feedback.js
// all need it and none of them loads site.js. A copy in each is four chances to
// get the precedence backwards, and getting it backwards fails silently in the
// direction that matters — a rider who asked for stillness still gets motion.
(function (window) {
  "use strict";

  var doc = window.document;

  /**
   * True when animation should be suppressed.
   *
   * READ ON EVERY CALL RATHER THAN CACHED. Both inputs can change inside one
   * page's life: the OS setting is a live media query, and the attribute is one
   * `setAttribute` away from a preview. A value captured at load would be stale
   * for the rest of the session, and the failure would look like the setting not
   * working rather than like a cache.
   */
  function reduced() {
    var el = doc && doc.documentElement;
    var said = el && el.getAttribute("data-motion");
    if (said === "never") return true;
    if (said === "always") return false;
    // `system`, or a signed-out page that stamps nothing. The machine answers.
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  window.TBMotion = { reduced: reduced };
})(typeof window !== "undefined" ? window : this);
