// The one loader for Google Analytics, in both modes, and the consent bar that
// gates it where the law asks. The server decides only whether to ASK
// (`window.TBConsent.ask`, from the visitor's Cloudflare-reported country) and
// never what was answered: the answer lives in localStorage and nowhere else,
// which is why the server cannot emit Google's inline snippet even for a
// visitor nobody asks — that loader could not honor a "No thanks" stored on an
// earlier visit from somewhere that did ask. One path, one place the choice is
// read. See src/views/analytics.ts for the rule and the privacy page for the
// rider's version of it.
//
//   denied    stored → nothing from Google loads, ever, whatever `ask` says.
//   granted   stored → load.
//   nothing   stored → load if not asked; otherwise show the bar and wait.
//
// The bar is server-rendered HIDDEN (`#consent-bar`, in the staging banner's
// slot) and this file is the only thing that shows it, so a rider who has
// answered never sees it flash. Showing it also adds `has-consent-bar` to
// <html>, which is what reserves its height on a chrome page (_base.scss), and
// calls TBBanner.refresh(), which measures it into --banner-h for the map pages.
//
// Nothing here touches the Cloudflare beacon: it is cookieless, holds no
// identifier, and is emitted by the server for everyone.
(function (window) {
  "use strict";

  var doc = window.document;
  var KEY = "routeloop.consent";
  var cfg = window.TBConsent;
  // The same shape config.ts admits the id through. Belt and braces: the id
  // reached this page through that check already, and a page is not the place
  // to be less careful than the server was.
  if (!cfg || typeof cfg.gaId !== "string" || !/^G-[A-Z0-9]{4,}$/.test(cfg.gaId)) return;
  var id = cfg.gaId;

  function stored() {
    try {
      return window.localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }

  function store(value) {
    try {
      if (value === null) window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, value);
    } catch (e) {
      // Private window, blocked storage: the choice holds for this page and is
      // asked again next time, which is the honest fallback.
    }
  }

  var loaded = false;

  // Google's snippet, verbatim in effect: the async script, the dataLayer, and
  // one config call. Signals and ad personalization are off because the site
  // has no advertising and never will — the privacy page promises both.
  function loadGa() {
    // Cleared BEFORE the once-only guard, or a rider who says no and then yes
    // on the same page has the tag loaded and still disabled until a reload.
    window["ga-disable-" + id] = false;
    if (loaded) return;
    loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag =
      window.gtag ||
      function () {
        window.dataLayer.push(arguments);
      };
    window.gtag("js", new Date());
    window.gtag("config", id, { allow_google_signals: false, allow_ad_personalization_signals: false });
    var s = doc.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
    doc.head.appendChild(s);
  }

  // Google's documented opt-out flag, so a change of mind on /privacy stops the
  // tag in the same page rather than on the next load, and the two cookies it
  // set are expired on both the host and the apex, which is where GA puts them.
  function unloadGa() {
    window["ga-disable-" + id] = true;
    var host = window.location.hostname;
    var apex = host.split(".").slice(-2).join(".");
    var names = [];
    (doc.cookie || "").split(";").forEach(function (c) {
      var name = c.split("=")[0].trim();
      if (name === "_ga" || name.indexOf("_ga_") === 0) names.push(name);
    });
    names.forEach(function (name) {
      [host, "." + host, "." + apex].forEach(function (domain) {
        doc.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=" + domain;
      });
      doc.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    });
  }

  function bar() {
    return doc.getElementById("consent-bar");
  }

  function refresh() {
    if (window.TBBanner && typeof window.TBBanner.refresh === "function") window.TBBanner.refresh();
  }

  function show() {
    var el = bar();
    if (!el) return;
    el.hidden = false;
    doc.documentElement.classList.add("has-consent-bar");
    refresh();
  }

  function hide() {
    var el = bar();
    if (!el) return;
    el.hidden = true;
    doc.documentElement.classList.remove("has-consent-bar");
    refresh();
  }

  function choose(value) {
    store(value);
    hide();
    if (value === "granted") loadGa();
    else unloadGa();
  }

  function init() {
    var choice = stored();
    if (choice === "denied") {
      unloadGa();
    } else if (choice === "granted" || !cfg.ask) {
      loadGa();
    } else {
      show();
    }

    var el = bar();
    if (el) {
      el.addEventListener("click", function (e) {
        var btn = e.target.closest && e.target.closest("[data-consent]");
        if (!btn) return;
        var value = btn.getAttribute("data-consent");
        if (value === "granted" || value === "denied") choose(value);
      });
    }

    // /privacy carries one button about this, shipped hidden so a visitor this
    // file never loads for (dev, stage) is not shown a control that does
    // nothing. Un-hidden here, and only here. Where the bar exists it puts the
    // question back; everywhere else it is a plain opt-out and opt-in, so the
    // choice the EU gets up front is one every rider can make from this page.
    var reset = doc.querySelector("[data-consent-reset]");
    if (reset) {
      reset.hidden = false;
      paintReset(reset);
      reset.addEventListener("click", function () {
        if (cfg.ask && bar()) {
          store(null);
          show();
          var first = bar().querySelector("[data-consent]");
          if (first) first.focus();
        } else {
          choose(stored() === "denied" ? "granted" : "denied");
        }
        paintReset(reset);
      });
    }
  }

  function paintReset(reset) {
    if (cfg.ask) reset.textContent = "Change your analytics choice";
    else reset.textContent = stored() === "denied" ? "Count my visits again" : "Stop counting my visits";
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else init();
})(window);
