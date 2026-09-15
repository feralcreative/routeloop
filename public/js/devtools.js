// Dev markers — a local-only layer for talking about the UI. Ziad's call,
// 2026-09-12: "put magenta numbers on each of the popups so I can easily
// identify them to you." Loaded by page() under IS_DEV alone, beside the live
// reload script, so no deploy ever carries it.
//
// A toggle sits bottom-right; the choice lives in localStorage so it survives
// a reload. While on, every popup that appears gets a #f0f badge:
//
//   - a tour card is numbered by its position in TBTour.STEPS (1-based), which
//     is stable across a session and is what a rider-facing card is called in
//     conversation — "card 7" — with the step id in the badge's title;
//   - a <dialog>, a [popover] and a tip bubble carry their element id, since
//     they have no order to count.
//
// Self-contained on purpose: the stylesheet is injected from here rather than
// living in style/, because a `#f0f` in a partial would be reported by /brand
// as a color somebody reached past the palette for — which it is, and which
// is fine only because it never ships.
(function () {
  "use strict";

  var KEY = "routeloop.devtools";
  var CLASS = "dev-markers";

  var css =
    "html." +
    CLASS +
    " .dev-marker{position:absolute;top:-0.6em;left:-0.6em;z-index:99999;" +
    "min-width:1.6em;padding:0 0.4em;border-radius:0.8em;background:#f0f;color:#000;" +
    "font:700 13px/1.6em system-ui,sans-serif;text-align:center;pointer-events:none;" +
    "box-shadow:0 0 0 2px #000}" +
    ".dev-marker{display:none}html." +
    CLASS +
    " .dev-marker{display:block}" +
    "#dev-toggle{position:fixed;right:12px;bottom:12px;z-index:99998;padding:4px 10px;" +
    "border:2px solid #f0f;border-radius:6px;background:#000;color:#f0f;" +
    "font:700 12px/1.4 system-ui,sans-serif;cursor:pointer;opacity:0.7}" +
    "#dev-toggle:hover{opacity:1}" +
    "html." +
    CLASS +
    " #dev-toggle{background:#f0f;color:#000}" +
    "#dev-scheme{position:fixed;right:64px;bottom:12px;z-index:99998;padding:4px 10px;" +
    "border:2px solid #f0f;border-radius:6px;background:#000;color:#f0f;" +
    "font:700 12px/1.4 system-ui,sans-serif;cursor:pointer;opacity:0.7}" +
    "#dev-scheme:hover{opacity:1}";

  // Light/dark, flipped in place. Ziad's call, 2026-09-14, while lifting the
  // dark ramp: the preference is a saved setting and a round trip, and
  // checking one color in both schemes wants a button. It writes the same
  // `data-scheme` attribute the layout stamps, so every palette rule follows
  // with no reload; the choice is remembered in localStorage and re-applied
  // on boot OVER the server's stamp, for as long as it is set. Note it does
  // not touch the stored preference — Preferences still says what it said.
  var SCHEME_KEY = "routeloop.devScheme";

  function currentScheme() {
    var s = document.documentElement.getAttribute("data-scheme");
    if (s === "dark" || s === "light") return s;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function setScheme(v) {
    document.documentElement.setAttribute("data-scheme", v);
    try {
      localStorage.setItem(SCHEME_KEY, v);
    } catch (e) {}
    var b = document.getElementById("dev-scheme");
    if (b) b.textContent = v === "dark" ? "Dark" : "Light";
  }

  function on() {
    try {
      return localStorage.getItem(KEY) === "on";
    } catch (e) {
      return false;
    }
  }

  function set(v) {
    try {
      localStorage.setItem(KEY, v ? "on" : "off");
    } catch (e) {}
    document.documentElement.classList.toggle(CLASS, v);
    var b = document.getElementById("dev-toggle");
    if (b) b.setAttribute("aria-pressed", String(v));
  }

  function stepNumber(el) {
    var id = el.getAttribute("data-shepherd-step-id");
    var steps = window.TBTour && window.TBTour.STEPS;
    if (!id || !steps) return null;
    for (var i = 0; i < steps.length; i++) if (steps[i].id === id) return { n: i + 1, id: id };
    return null;
  }

  function label(el) {
    if (el.classList.contains("shepherd-element")) {
      var s = stepNumber(el);
      return s ? { text: String(s.n), title: "tour step " + s.id } : null;
    }
    return el.id ? { text: "#" + el.id, title: el.tagName.toLowerCase() } : null;
  }

  function mark(el) {
    if (el.querySelector(":scope > .dev-marker")) return;
    var l = label(el);
    if (!l) return;
    var m = document.createElement("span");
    m.className = "dev-marker";
    m.textContent = l.text;
    m.title = l.title;
    m.setAttribute("aria-hidden", "true");
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    el.appendChild(m);
  }

  var POPUP = ".shepherd-element, dialog, [popover], .tip-bubble";

  function sweep(root) {
    if (!(root instanceof Element)) return;
    if (root.matches(POPUP)) mark(root);
    root.querySelectorAll(POPUP).forEach(mark);
  }

  function boot() {
    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    var b = document.createElement("button");
    b.type = "button";
    b.id = "dev-toggle";
    b.textContent = "Dev";
    b.title = "Toggle dev markers";
    b.addEventListener("click", function () {
      set(!on());
    });
    document.body.appendChild(b);
    set(on());

    var sb = document.createElement("button");
    sb.type = "button";
    sb.id = "dev-scheme";
    sb.title = "Flip light/dark for this browser (dev only)";
    sb.addEventListener("click", function () {
      setScheme(currentScheme() === "dark" ? "light" : "dark");
    });
    document.body.appendChild(sb);
    var saved = null;
    try {
      saved = localStorage.getItem(SCHEME_KEY);
    } catch (e) {}
    setScheme(saved === "dark" || saved === "light" ? saved : currentScheme());

    sweep(document.body);
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        r.addedNodes.forEach(sweep);
        // A tour card is re-rendered in place between steps; its step id
        // changes on the same element, so the badge has to be redone.
        if (r.type === "attributes" && r.target instanceof Element && r.target.matches(".shepherd-element")) {
          var old = r.target.querySelector(":scope > .dev-marker");
          if (old) old.remove();
          mark(r.target);
        }
      });
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-shepherd-step-id"],
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
