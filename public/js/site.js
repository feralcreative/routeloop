// Global chrome behavior: the nav drawer and the alpha splash. Loaded on every
// page, including the two legacy Google Maps pages, so it must not assume
// Mapbox, window.TB, or any other script is present.
(function () {
  "use strict";

  // Bump to re-show the splash for everyone who already dismissed it.
  const ALPHA_SPLASH_VERSION = "1";
  const ALPHA_KEY = "tankbag.alphaSplash";
  const VIDEO_KEY = "tankbag.splashVideo";

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

    // Open state is a class on the header, not the `hidden` attribute. The same
    // markup is the drawer below 992px and the bar above it, and `hidden` left
    // on the bar would tell assistive tech to skip a nav that is plainly on
    // screen. CSS owns which shape applies; this only says open or closed.
    const isOpen = () => header.classList.contains("open");

    // The two dropdowns inside the nav. Native <details> handles opening; what
    // it does not do is close when you click somewhere else, which is the one
    // behavior people expect from a menu in a bar.
    const subs = () => nav.querySelectorAll("details.nav-sub");
    function closeSubs(except) {
      subs().forEach(function (d) {
        if (d !== except) d.open = false;
      });
    }

    function setOpen(open) {
      header.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      if (open) {
        const first = nav.querySelector(FOCUSABLE);
        if (first) first.focus();
      } else {
        closeSubs();
      }
    }

    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      setOpen(!isOpen());
    });

    // Only one dropdown open at a time. In the bar two open panels would
    // overlap; in the drawer they just make a long list longer.
    nav.addEventListener("toggle", function (e) {
      const d = e.target;
      if (d instanceof HTMLDetailsElement && d.open) closeSubs(d);
    }, true);

    // Any activation inside closes the drawer — links navigate, and the
    // "About this alpha" button opens the modal on top. A <summary> is exempt:
    // it opens the panel the click was aimed at, so closing on it would make
    // the dropdowns unopenable.
    nav.addEventListener("click", function (e) {
      if (e.target.closest("summary")) return;
      if (e.target.closest("a,button")) setOpen(false);
    });

    document.addEventListener("click", function (e) {
      if (e.target.closest("#site-header")) return;
      // At desktop the drawer is never open, but a dropdown can be — so the
      // outside click has to reach both rather than returning early on one.
      if (isOpen()) setOpen(false);
      closeSubs();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      const openSub = nav.querySelector("details.nav-sub[open]");
      if (openSub) {
        // Innermost first: Escape shuts the panel you are in, not the whole nav.
        openSub.open = false;
        const summary = openSub.querySelector("summary");
        if (summary) summary.focus();
      } else if (isOpen()) {
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
  // Play/pause for the background clip, remembered per browser.
  //
  // "Remembered" is stronger than restoring a toggle: a rider who paused it
  // last time never has the file fetched again, which is the same ~3 MB saving
  // the reduced-motion path already takes. src stays unset until the clip is
  // actually wanted.
  const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z"/></svg>';
  const ICON_PAUSE =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';

  function initSplashVideo() {
    const video = document.querySelector(".splash-video");
    if (!video) return;

    const src = video.getAttribute("data-src");
    if (!src) return;

    // Reduced motion means no clip is fetched at all, so there is nothing to
    // offer a control over — the button is not rendered rather than rendered
    // inert.
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduce && reduce.matches) return;

    let paused = readStore(VIDEO_KEY) === "paused";

    // The clip is slowed in the file itself, not via playbackRate. Halving
    // playbackRate on the 25fps master would have shown 12.5fps — the browser
    // holds each frame longer rather than generating new ones, so it reads as
    // choppy. The encode interpolates the intermediate frames instead and stays
    // a true 25fps. See docs/STATUS.md.
    //
    // The autoplay attribute normally covers this; the explicit call catches
    // the cases it doesn't (iOS Low Power Mode among them). A refusal is the
    // poster frame, not an error worth surfacing.
    function start() {
      if (!video.src) video.src = src;
      const started = video.play();
      if (started && started.catch) started.catch(function () {});
    }

    // Deliberately a sibling of .splash-media rather than a child: that wrapper
    // is aria-hidden and pointer-events: none, so a control inside it would be
    // invisible to assistive tech and unclickable besides.
    const button = document.createElement("button");
    button.type = "button";
    button.className = "video-toggle";
    document.body.appendChild(button);

    function paint() {
      const label = paused ? "Play the background video" : "Pause the background video";
      button.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
      button.setAttribute("aria-label", label);
      button.title = label;
    }

    button.addEventListener("click", function () {
      paused = !paused;
      if (paused) video.pause();
      else start();
      writeStore(VIDEO_KEY, paused ? "paused" : "playing");
      paint();
    });

    if (!paused) start();
    paint();
  }

  // --- FAQ accordion -------------------------------------------------------
  // The questions are <details>, so opening and closing is the platform's job.
  // Two things it does not do for us:
  //
  //   1. Expand all, for reading the whole page top to bottom.
  //   2. Reliable deep-linking. Chrome auto-expands a <details> when you
  //      navigate to a fragment inside it; Firefox and Safari do not, so a
  //      /faq#some-id link from elsewhere in the app would land on a collapsed
  //      question and look broken. That is the whole reason this exists — the
  //      links from the builder are useless without it.
  function initFaq() {
    const items = Array.from(document.querySelectorAll("details.qa"));
    if (items.length === 0) return;

    const toggle = document.querySelector("[data-faq-toggle-all]");
    if (toggle) {
      toggle.addEventListener("click", () => {
        // Read the button's own state rather than the items', so a page where
        // the rider has opened a few by hand still has one predictable next
        // action instead of flipping on a majority vote.
        const open = toggle.getAttribute("aria-expanded") !== "true";
        items.forEach((d) => {
          d.open = open;
        });
        toggle.setAttribute("aria-expanded", String(open));
        toggle.textContent = open ? "Collapse all" : "Expand all";
      });
    }

    function openFromHash() {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      const target = document.getElementById(id);
      if (!target || !target.classList.contains("qa")) return;
      target.open = true;
      // The browser already tried to scroll here before the element was open,
      // so it landed short. Do it again now the answer has height.
      target.scrollIntoView({ block: "start", behavior: "smooth" });
    }

    openFromHash();
    window.addEventListener("hashchange", openFromHash);
  }

  function init() {
    initNav();
    initSplash();
    initSplashVideo();
    initFaq();
  }

  // `defer` normally guarantees DOM readiness, but this file is also safe to
  // load without it.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
