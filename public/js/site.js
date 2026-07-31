// Global chrome behavior: the nav drawer and the alpha splash. Loaded on every
// page, including the two legacy Google Maps pages, so it must not assume
// Mapbox, window.TB, or any other script is present.
(function () {
  "use strict";

  // Bump to re-show the splash for everyone who already dismissed it.
  const ALPHA_SPLASH_VERSION = "1";
  const ALPHA_KEY = "tankbag.alphaSplash";

  // Private-mode Safari throws on storage access. A failure has to read as
  // "not dismissed" rather than taking the page down with it.
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
      /* nothing to do — the modal simply returns next load */
    }
  }

  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';

  // --- Nav drawer ----------------------------------------------------------
  // Deliberately NOT a focus trap: a menu is not modal, so Tab should be able
  // to leave it. Escape and outside-click close it, and focus returns to the
  // toggle so keyboard users don't get dropped at the top of the document.
  function initNav() {
    const header = document.getElementById("site-header");
    const toggle = header && header.querySelector(".nav-toggle");
    const nav = document.getElementById("site-nav");
    if (!header || !toggle || !nav) return;

    function setOpen(open) {
      nav.hidden = !open;
      header.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      if (open) {
        const first = nav.querySelector(FOCUSABLE);
        if (first) first.focus();
      }
    }

    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      setOpen(nav.hidden);
    });

    // Any activation inside the drawer closes it — links navigate, and the
    // "About this alpha" button opens the modal on top.
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a,button")) setOpen(false);
    });

    document.addEventListener("click", function (e) {
      if (!nav.hidden && !e.target.closest("#site-header")) setOpen(false);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !nav.hidden) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  // --- Alpha splash --------------------------------------------------------
  function initSplash() {
    const backdrop = document.getElementById("alpha-splash");
    if (!backdrop) return;
    const dialog = backdrop.querySelector(".modal");
    const hideBox = document.getElementById("alpha-hide");
    let lastFocus = null;

    function open() {
      lastFocus = document.activeElement;
      backdrop.hidden = false;
      document.body.classList.add("modal-open");
      const first = dialog.querySelector(FOCUSABLE);
      if (first) first.focus();
    }

    // Only an explicitly checked box persists. Otherwise the modal returns on
    // the next load, which is the requested behavior.
    function close() {
      if (hideBox && hideBox.checked) writeStore(ALPHA_KEY, ALPHA_SPLASH_VERSION);
      backdrop.hidden = true;
      document.body.classList.remove("modal-open");
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop || e.target.closest("[data-close-alpha]")) close();
    });

    // This one IS modal, so Tab cycles within the dialog.
    backdrop.addEventListener("keydown", function (e) {
      if (e.key === "Escape") return close();
      if (e.key !== "Tab") return;
      const items = Array.prototype.filter.call(dialog.querySelectorAll(FOCUSABLE), function (el) {
        return el.offsetParent !== null;
      });
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    document.addEventListener("click", function (e) {
      if (e.target.closest("[data-open-alpha]")) open();
    });

    if (readStore(ALPHA_KEY) !== ALPHA_SPLASH_VERSION) open();
  }

  // --- Sign-in background clip ---------------------------------------------
  // The <video> ships without a src so that honoring prefers-reduced-motion
  // skips the download rather than hiding an already-fetched 19 MB file. CSS
  // paints the poster frame behind it, so doing nothing here degrades to a
  // still image instead of a blank panel.
  function initSplashVideo() {
    const video = document.querySelector(".splash-video");
    if (!video) return;

    const src = video.getAttribute("data-src");
    if (!src) return;

    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduce && reduce.matches) return;

    video.src = src;

    // The clip is slowed in the file itself, not via playbackRate. Halving
    // playbackRate on the 25fps master would have shown 12.5fps — the browser
    // holds each frame longer rather than generating new ones, so it reads as
    // choppy. The encode interpolates the intermediate frames instead and stays
    // a true 25fps. See docs/STATUS.md.
    //
    // The autoplay attribute normally covers this; the explicit call catches
    // the cases it doesn't (iOS Low Power Mode among them). A refusal is the
    // poster frame, not an error worth surfacing.
    const started = video.play();
    if (started && started.catch) started.catch(function () {});
  }

  function init() {
    initNav();
    initSplash();
    initSplashVideo();
  }

  // `defer` normally guarantees DOM readiness, but this file is also safe to
  // load without it.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
