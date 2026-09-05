// Global chrome behavior: the nav drawer and the alpha splash. Loaded on every
// page, including the two legacy Google Maps pages, so it must not assume
// Mapbox, window.TB, or any other script is present.
(function () {
  "use strict";

  // Bump to re-show the splash for everyone who already dismissed it.
  const ALPHA_SPLASH_VERSION = "1";
  const ALPHA_KEY = "routeloop.alphaSplash";
  const VIDEO_KEY = "routeloop.splashVideo";

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

  // Design-hook hosts. `npm run dev` serves on localhost:6686; the .local name
  // is what a phone on the LAN reaches it by, which is the whole point of
  // testing a layout on real hardware.
  const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.local)$/.test(window.location.hostname);

  // Query-string read, wrapped for the same reason the storage helpers are: a
  // malformed search string must read as "absent", not take the page down.
  function readParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (e) {
      return null;
    }
  }

  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';

  // --- Nav --------------------------------------------------------------
  // The drawer and both dropdowns are native <details>, so opening and closing
  // is the browser's job and the whole nav works with this file absent. What is
  // left is the three things <details> does not do on its own.
  //
  // Deliberately NOT a focus trap: a menu is not modal, so Tab should leave it.
  function initNav() {
    const header = document.getElementById("site-header");
    const menu = header && header.querySelector(".site-menu");
    if (!header || !menu) return;

    const subs = () => menu.querySelectorAll("details.nav-sub");
    const closeSubs = (except) => {
      subs().forEach((d) => {
        if (d !== except) d.open = false;
      });
    };

    // 1. One dropdown at a time. Two open panels overlap in the bar, and make a
    //    long list longer in the drawer. `toggle` does not bubble, hence capture.
    menu.addEventListener(
      "toggle",
      (e) => {
        const d = e.target;
        if (d instanceof HTMLDetailsElement && d.open && d.classList.contains("nav-sub")) closeSubs(d);
      },
      true,
    );

    // 2. Clicking away closes everything. The drawer is a disclosure, not a
    //    dialog, so nothing dismisses it for us.
    document.addEventListener("click", (e) => {
      if (e.target.closest("#site-header")) return;
      closeSubs();
      menu.open = false;
    });

    // 3. Escape, innermost first: shut the panel you are in, then the drawer.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const openSub = menu.querySelector("details.nav-sub[open]");
      if (openSub) {
        openSub.open = false;
        const summary = openSub.querySelector("summary");
        if (summary) summary.focus();
      } else if (menu.open) {
        menu.open = false;
        const toggle = menu.querySelector(".nav-toggle");
        if (toggle) toggle.focus();
      }
    });

    // A link navigates and a new page arrives closed, but the alpha-splash
    // button opens a modal on top of a drawer that would otherwise stay open.
    menu.addEventListener("click", (e) => {
      if (e.target.closest("summary")) return;
      if (e.target.closest("a,button")) {
        closeSubs();
        menu.open = false;
      }
    });
  }

  // TWO DIALOGS SHARE `body.modal-open`, so neither may clear it on its own —
  // closing one while the other is up would unlock scrolling behind a modal
  // that is still on screen. Barely reachable today (the alpha modal opens on
  // load and its backdrop covers the openers behind it) but it costs one query
  // to be correct, and the third dialog will not be so lucky.
  function syncModalOpen() {
    const open = Array.prototype.some.call(document.querySelectorAll(".modal-backdrop"), function (el) {
      return !el.hidden;
    });
    document.body.classList.toggle("modal-open", open);
  }

  // --- Alpha splash --------------------------------------------------------
  function initSplash() {
    const backdrop = document.getElementById("alpha-splash");
    if (!backdrop) return;
    const dialog = backdrop.querySelector(".modal");
    const hideBox = document.getElementById("alpha-hide");
    let lastFocus = null;

    // Design hook: ?alpha=1 pins the modal open. It ignores a stored dismissal,
    // reopens on every load so the SCSS watcher's live reload brings it straight
    // back, and makes close a no-op so nothing you click dismisses what you are
    // styling. It also never writes the dismissal key, so a styling session
    // cannot poison the real one. Drop the param for normal behavior.
    //
    // Local hosts only. Ungated, a link carrying the param would pin an
    // undismissable modal on any rider who opened it — petty rather than
    // dangerous, but there is no reason to leave it reachable. The check is on
    // hostname and not on window.TB because this file is loaded by the two
    // legacy map pages too and must not assume TB exists.
    const pinned = IS_LOCAL && readParam("alpha") === "1";

    function open() {
      lastFocus = document.activeElement;
      backdrop.hidden = false;
      syncModalOpen();
      // The dialog itself, not the first control in it. Focus has to move inside
      // for the trap below and for a screen reader to announce the dialog, but
      // focusing the first LINK drew a focus ring on the GitHub mark every time
      // the modal opened, which reads as a selection the rider did not make.
      // The container carries tabindex="-1" for exactly this.
      dialog.focus();
    }

    // Only an explicitly checked box persists. Otherwise the modal returns on
    // the next load, which is the requested behavior.
    function close() {
      if (pinned) return;
      if (hideBox && hideBox.checked) writeStore(ALPHA_KEY, ALPHA_SPLASH_VERSION);
      backdrop.hidden = true;
      syncModalOpen();
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
      // `|| dialog` because focus starts on the container, which is deliberately
      // not in `items` — without it, the first shift+Tab of a freshly opened
      // modal escapes to the browser chrome instead of wrapping to the last
      // control.
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
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

    if (pinned || readStore(ALPHA_KEY) !== ALPHA_SPLASH_VERSION) open();
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
    // Through TBMotion since #174, so the in-app setting suppresses the clip the
    // same way the OS one does. Note what that means and it is the strongest
    // version of this feature: a rider who chose "never animate" never DOWNLOADS
    // the video, because the src is assigned below and not in the markup.
    if (!window.TBMotion || window.TBMotion.reduced()) return;

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

  // --- Release notes -------------------------------------------------------
  //
  // Its own function rather than a second copy of initSplash: the two dialogs
  // share markup and keyboard behavior, but the alpha modal owns a dismissal
  // key, a design pin and an auto-open on load, and none of that belongs here.
  // What IS shared is the focus trap, and it is small enough that a second
  // honest copy beats a shared abstraction with two callers pulling in different
  // directions.
  function initNotes() {
    const backdrop = document.getElementById("release-notes");
    if (!backdrop) return;
    const dialog = backdrop.querySelector(".modal");
    const body = document.getElementById("rn-body");
    let lastFocus = null;
    let loaded = false;

    // FETCHED ON FIRST OPEN, then kept. The notes only ever get longer and this
    // modal is on every page, so inlining them would put a growing file on every
    // HTML response for a dialog most riders never open.
    //
    // A failure leaves the fallback link that shipped in the markup, which goes
    // to the same content server-rendered. That is the whole error path: there
    // is nothing useful to say about a fetch that failed, and a rider who wants
    // the notes can still read them.
    function load() {
      if (loaded) return;
      loaded = true;
      const url = body && body.dataset.src;
      if (!url) return;
      fetch(url, { headers: { Accept: "text/html" } })
        .then(function (r) {
          if (!r.ok) throw new Error(String(r.status));
          return r.text();
        })
        .then(function (html) {
          body.innerHTML = html;
        })
        .catch(function () {
          // Left as it was — the fallback link is still in there.
          loaded = false;
        });
    }

    function open() {
      lastFocus = document.activeElement;
      load();
      backdrop.hidden = false;
      syncModalOpen();
      dialog.focus();
    }

    function close() {
      backdrop.hidden = true;
      syncModalOpen();
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop || e.target.closest("[data-close-notes]")) close();
    });

    backdrop.addEventListener("keydown", function (e) {
      if (e.key === "Escape") return close();
      if (e.key !== "Tab") return;
      const items = Array.prototype.filter.call(dialog.querySelectorAll(FOCUSABLE), function (el) {
        return el.offsetParent !== null;
      });
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      // `|| dialog` for the same reason as the alpha modal: focus starts on the
      // container, which is deliberately not in `items`.
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    // Delegated, because the openers are in two places — the item inside the
    // help launcher and the version string in every footer.
    document.addEventListener("click", function (e) {
      if (e.target.closest("[data-open-notes]")) {
        e.preventDefault();
        markNotesSeen();
        open();
      }
    });
  }

  // What build this rider has already read the notes for.
  //
  // Per browser, deliberately: it answers "have I seen this" for the person
  // looking at the screen, and the server has no business knowing which dialogs
  // someone opened. Every access is guarded — a private window, cleared site
  // data, or a browser set to block storage all THROW here rather than
  // returning null, and an unread dot is not worth a broken page.
  const NOTES_SEEN_KEY = "rl.notes.seen";

  function currentBuild() {
    return (window.TB && window.TB.version) || "";
  }

  function notesSeen() {
    try {
      return window.localStorage.getItem(NOTES_SEEN_KEY);
    } catch (_) {
      return null;
    }
  }

  function markNotesSeen() {
    const badge = document.querySelector("[data-fab-badge]");
    if (badge) badge.hidden = true;
    try {
      window.localStorage.setItem(NOTES_SEEN_KEY, currentBuild());
    } catch (_) {
      /* Nothing to do. The dot comes back next load, which is the harmless half
         of the failure—the alternative is not showing it to anyone. */
    }
  }

  // The launcher: one control that opens a short menu, which is the shape every
  // support widget a tester has met already uses.
  function initFab() {
    const dock = document.querySelector("[data-fab-dock]");
    if (!dock) return;
    const launcher = dock.querySelector(".fab-launcher");
    const menu = dock.querySelector(".fab-menu");
    const badge = dock.querySelector("[data-fab-badge]");

    // UNREAD, not "new". The dot means "this build is one you have not opened
    // the notes for", so a rider who has read them sees nothing until the next
    // deploy. An empty stored value is a first visit, which counts as unread —
    // it is how a tester finds the notes at all.
    if (badge && currentBuild() && notesSeen() !== currentBuild()) badge.hidden = false;

    function setOpen(on) {
      menu.hidden = !on;
      dock.classList.toggle("is-open", on);
      launcher.setAttribute("aria-expanded", on ? "true" : "false");
    }

    launcher.addEventListener("click", function () {
      const willOpen = menu.hidden;
      setOpen(willOpen);
      if (willOpen) {
        const first = menu.querySelector(FOCUSABLE);
        if (first) first.focus();
      }
    });

    // Deliberately NOT a focus trap. This is a menu, not a dialog: tabbing out
    // of it should land on the page behind, and trapping would strand a
    // keyboard user in a two-item popover.
    dock.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || menu.hidden) return;
      setOpen(false);
      launcher.focus();
    });

    document.addEventListener("click", function (e) {
      if (!menu.hidden && !dock.contains(e.target)) setOpen(false);
    });

    // Closes on the way to whatever the item does, so the menu is not still
    // hanging open behind the notes dialog or over the page /feedback lands on.
    menu.addEventListener("click", function () {
      setOpen(false);
    });

    dock.addEventListener("focusout", function (e) {
      if (!menu.hidden && !dock.contains(e.relatedTarget)) setOpen(false);
    });
  }

  // Tell the layout how tall the page-top banner is, so the map and the drawer
  // move down instead of being painted over.
  //
  // IT LIVES HERE RATHER THAN IN builder.js, WHICH IS WHERE IT WAS UNTIL THE
  // STAGE BANNER LANDED. The viewer is a map page too and loads no copy of
  // builder.js, so a banner there had nothing to push the map down — and every
  // chrome page needs the same number now that a banner can appear on all of
  // them. One writer to --banner-h, one place to fix it: two functions setting
  // one custom property is the same trap as two previewOf()s in map-common.js.
  //
  // MEASURED, not declared. `html.has-stage-banner` seeds a plausible one-line
  // height in _map.scss so the first paint is close, but the recovery text
  // wraps to two lines in a narrow drawer and the maps-misconfigured banner is
  // longer again, so no constant is right for long. Re-measured on resize, and
  // by a ResizeObserver where there is one — a banner can also change height
  // without the window moving, which is exactly what the recovery bar does when
  // its text is written into it.
  //
  // Reads 0 when the banner is hidden or absent, which is what most pages get
  // and what makes the calc()s in _map.scss a no-op by default.
  //
  // IT ONLY ACTS ON A CHANGE, AND THAT IS WHAT STOPS IT RECURSING FOREVER.
  // This function dispatches a resize, and it is itself a resize listener, so
  // dispatching unconditionally called it again from inside itself: a
  // RangeError every time a banner appeared, thrown out of offerRecovery() and
  // straight through the builder's init(). Everything after that line was then
  // never wired — clicking the map added nothing and the route could not be
  // dragged into shape — so a rider with an unsaved draft got a builder that
  // looked normal and did not work, with one console error nobody was looking
  // at. Comparing against the last value fixes it at the source rather than
  // with a re-entry flag: the nested call measures the same height, changes
  // nothing and returns.
  let bannerH = null;
  function refreshBanner() {
    const bar = document.querySelector(".tb-banner:not([hidden])");
    const h = bar ? Math.ceil(bar.getBoundingClientRect().height) : 0;
    if (h === bannerH) return;
    bannerH = h;
    document.documentElement.style.setProperty("--banner-h", h + "px");
    // A map's own viewport changed size, and Google only notices on a resize
    // event. Without this the tiles keep the old height and the controls sit
    // off the bottom edge until something else nudges it. Harmless on a page
    // with no map, which is why this does not ask whether there is one.
    if (h) window.dispatchEvent(new Event("resize"));
  }

  // Named for the feature rather than for its shape, so the next helper that
  // lands in this file cannot silently replace it.
  window.TBBanner = { refresh: refreshBanner };

  function initBanner() {
    refreshBanner();
    window.addEventListener("resize", refreshBanner);
    const bar = document.querySelector(".tb-banner");
    if (bar && window.ResizeObserver) new ResizeObserver(refreshBanner).observe(bar);
  }

  function init() {
    initNav();
    initSplash();
    initNotes();
    initFab();
    initSplashVideo();
    initFaq();
    initBanner();
  }

  // `defer` normally guarantees DOM readiness, but this file is also safe to
  // load without it.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
