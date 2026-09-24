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
      // A tour card is not "away": the tour opens the drawer to show where a
      // page lives, and closes it itself when the card goes.
      if (e.target.closest(".shepherd-element")) return;
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

    // Design hook: ?alpha=1 pins the modal open. It ignores a stored dismissal, reopens
        // on every load so the SCSS watcher's live reload brings it back, makes close a
        // no-op, and never writes the dismissal key.
        //
        // Local hosts only: ungated, a link carrying the param would pin an undismissable
        // modal on any rider who opened it. The check is on hostname and not on window.TB,
        // because this file is loaded by the two legacy map pages too.
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
    // The <video> ships without a src so that honoring prefers-reduced-motion skips the
    // download rather than hiding an already-fetched file. CSS paints the poster frame
    // behind it, so doing nothing degrades to a still image.
    // Play/pause, remembered per browser — stronger than restoring a toggle: a rider
    // who paused it last time never has the file fetched again.
  const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z"/></svg>';
  const ICON_PAUSE =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';

  // --- Splash backdrop: a deck of clips, shuffled and crossfaded ----------
    //
    // **A FOLDER OF CLIPS, NOT ONE FILE.** The page gets the folder's list as
    // window.TB.splashClips, shuffles it, and plays the clips through the two <video>s
    // in .splash-media: one in front playing, the other behind, preloaded with the next
    // clip and paused at its first frame. FADE_S before the front clip ends the back one
    // starts and the two swap opacity. The fade starts on `timeupdate`, never on `ended`
    // — that fires after the last frame is gone and leaves a black gap.
    //
    // **AT MOST MAX_FETCH DISTINCT CLIPS PER VISIT**, which is about the one file this
    // replaced; once the cap is reached the deck is the fetched set, reshuffled, with
    // the one rule that a deck never opens with the clip that just played.
    //
    // What did not change, and each is load-bearing: no src in the markup, so reduced
    // motion, a remembered pause and Save-Data fetch zero bytes; the poster is the
    // layer's background, so those cases and an empty folder render a still; the
    // play/pause button pauses the SYSTEM, not one element; and window.TBSplash is the
    // hook replay.js pauses the backdrop through.
  var FADE_S = 0.8;
  var MAX_FETCH = 6;

  function shuffle(list) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = list[i];
      list[i] = list[j];
      list[j] = t;
    }
    return list;
  }

  function saveData() {
    var c = navigator.connection;
    if (c && c.saveData) return true;
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-data: reduce)").matches);
  }

  function initSplashVideo() {
    var videos = Array.prototype.slice.call(document.querySelectorAll(".splash-video"));
    if (videos.length < 2) return;
    var clips = (window.TB && window.TB.splashClips) || [];
    if (!clips.length) return;

    // Reduced motion means no clip is fetched at all, so there is nothing to
    // offer a control over — the button is not rendered rather than rendered
    // inert. Save-Data is the same rule from the other direction.
    if (!window.TBMotion || window.TBMotion.reduced()) return;
    if (saveData()) return;

    var userPaused = readStore(VIDEO_KEY) === "paused";
    var held = false; // paused by the page—the sneak peek—not the rider

    // The deck.
    var fetched = [];
    var deck = shuffle(clips.slice());
    var pos = 0;
    var lastPlayed = null;

    function pool() {
      return fetched.length >= MAX_FETCH ? fetched.slice() : clips.slice();
    }

    function draw() {
      if (pos >= deck.length) {
        deck = shuffle(pool());
        pos = 0;
        if (deck.length > 1 && deck[0] === lastPlayed) deck.push(deck.shift());
      }
      var clip = deck[pos++];
      // Past the cap, a clip not yet fetched is swapped for one that has been.
      if (fetched.length >= MAX_FETCH && fetched.indexOf(clip) < 0) {
        var have = fetched.filter(function (c) {
          return c !== lastPlayed;
        });
        clip = have[Math.floor(Math.random() * have.length)] || fetched[0];
      }
      if (fetched.indexOf(clip) < 0) fetched.push(clip);
      return clip;
    }

    var front = videos[0];
    var back = videos[1];
    var fading = false;
    var fadeTimer = null;

    function load(el, src) {
      el.classList.remove("is-front");
      el.preload = "auto";
      el.src = src;
      el.load();
    }

    // The autoplay attribute would cover this on the first element only; the
    // explicit call covers both and the cases autoplay does not (iOS Low Power
    // Mode among them). A refusal is the poster frame, not an error.
    function play(el) {
      var started = el.play();
      if (started && started.catch) started.catch(function () {});
    }

    function ready(el) {
      return el.readyState >= 3;
    }

    // The swap: the back clip starts, the opacities cross, and after the
    // fade the old front is rewound and given the clip after next.
    function crossfade() {
      if (fading) return;
      fading = true;
      play(back);
      back.classList.add("is-front");
      front.classList.remove("is-front");
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(function () {
        front.pause();
        var old = front;
        front = back;
        back = old;
        lastPlayed = front.currentSrc || front.src;
        load(back, draw());
        fading = false;
      }, FADE_S * 1000);
    }

    function watch(el) {
      el.addEventListener("timeupdate", function () {
        if (el !== front || fading || userPaused || held) return;
        if (!el.duration || el.duration - el.currentTime > FADE_S) return;
        if (ready(back)) crossfade();
      });
      // The back clip was not ready when the fade was due: hold the last
      // frame and swap the moment it is, a cut rather than a gap.
      el.addEventListener("ended", function () {
        if (el !== front || fading || userPaused || held) return;
        if (ready(back)) crossfade();
        else back.addEventListener("canplay", crossfade, { once: true });
      });
    }
    videos.forEach(watch);

    function begin() {
      load(front, draw());
      front.classList.add("is-front");
      lastPlayed = front.src;
      play(front);
      load(back, draw());
    }

    var begun = false;
    function start() {
      if (!begun) {
        begun = true;
        begin();
        return;
      }
      play(front);
      if (fading) play(back);
    }

    function stop() {
      front.pause();
      back.pause();
    }

    // The page's own hook — replay.js holds the backdrop while the sneak peek
    // is open and lets it go after, and a rider's own pause outranks it.
    window.TBSplash = {
      pause: function () {
        held = true;
        stop();
      },
      resume: function () {
        held = false;
        if (!userPaused) start();
      },
    };

    // Deliberately a sibling of .splash-media rather than a child: that wrapper
    // is aria-hidden and pointer-events: none, so a control inside it would be
    // invisible to assistive tech and unclickable besides.
    var button = document.createElement("button");
    button.type = "button";
    button.className = "video-toggle";
    document.body.appendChild(button);

    function paint() {
      var label = userPaused ? "Play the background video" : "Pause the background video";
      button.innerHTML = userPaused ? ICON_PLAY : ICON_PAUSE;
      button.setAttribute("aria-label", label);
      button.title = label;
    }

    button.addEventListener("click", function () {
      userPaused = !userPaused;
      if (userPaused) stop();
      else if (!held) start();
      writeStore(VIDEO_KEY, userPaused ? "paused" : "playing");
      paint();
    });

    if (!userPaused) start();
    paint();
  }

  // --- FAQ accordion -------------------------------------------------------
    // The questions are <details>, so opening and closing is the platform's job. Two
    // things it does not do for us: expand all, and reliable deep-linking — Chrome
    // auto-expands a <details> when you navigate to a fragment inside it, Firefox and
    // Safari do not, so a /faq#some-id link would land on a collapsed question and look
    // broken. That is the whole reason this exists.
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

  // --- Release notes: open the entry a link names ---------------------------
    //
    // Every entry but the newest is folded into a <details> (#325), and a notification
    // links to `/release-notes#<entry>` — an id on the SECTION, outside the <details>,
    // so the browser's own fragment navigation scrolls to a folded entry and stops. This
    // opens it, which is the one thing the native accordion cannot do for itself.
  function openNotedRelease() {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const section = document.getElementById(id);
    const fold = section && section.classList.contains("rn-release") && section.querySelector("details.rn-fold");
    if (fold) fold.open = true;
  }
  openNotedRelease();
  window.addEventListener("hashchange", openNotedRelease);

  // --- Folded cards remember the fold ---------------------------------------
  //
  // `<details data-fold="name">` (#339): closing one writes
  // `routeloop.fold.<name>` and opening it again clears the key, so absence
  // means open and a new rider never has a write made on their behalf.
  // FOLD_RESTORE in layout.tsx reads it back at the end of the body. Capture,
  // because `toggle` does not bubble.
  document.addEventListener(
    "toggle",
    (e) => {
      const fold = e.target;
      if (!(fold instanceof HTMLDetailsElement) || !fold.dataset.fold) return;
      const key = "routeloop.fold." + fold.dataset.fold;
      try {
        if (fold.open) localStorage.removeItem(key);
        else localStorage.setItem(key, "closed");
      } catch (_) {
        // Private mode or a full store: the fold still works, it just does not stick.
      }
    },
    true,
  );

  // --- Release notes: an opened entry scrolls to its own top ----------------
    //
    // Opening a card thirty entries down puts its title wherever the click happened to
    // be, routinely near the bottom of the screen. And the accordion closes whichever
    // entry was open, usually ABOVE this one, so the page also shifts up as it folds —
    // the scroll waits for that fold to finish, or it lands short by exactly the
    // collapsed height. The wait is read off the fold's own transition, so under
    // `motion.still` the duration is 0s and the scroll is immediate.
    //
    // `toggle` does not bubble, hence capture. The SECTION is what is scrolled to, so
    // the eyebrow and the timeline dot arrive with the title.
    //
    // THE SCROLL IS DRIVEN BY HAND, NOT `scrollIntoView({behavior: "smooth"})`: the
    // browser's smooth scroll runs at one pace and stops dead, which is jarring over a
    // long jump. This one eases out, so the card settles rather than lands.
  const scrollerOf = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const o = getComputedStyle(n).overflowY;
      if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement || document.documentElement;
  };
  const easeScrollTo = (section, ms) => {
    const box = scrollerOf(section);
    const margin = parseFloat(getComputedStyle(section).scrollMarginTop) || 0;
    const boxTop =
      box === document.scrollingElement || box === document.documentElement ? 0 : box.getBoundingClientRect().top;
    const from = box.scrollTop;
    const max = box.scrollHeight - box.clientHeight;
    const to = Math.max(0, Math.min(max, from + section.getBoundingClientRect().top - boxTop - margin));
    if (!ms) {
      box.scrollTop = to;
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      box.scrollTop = from + (to - from) * eased;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  document.addEventListener(
    "toggle",
    (e) => {
      const fold = e.target;
      if (!(fold instanceof HTMLDetailsElement) || !fold.classList.contains("rn-fold") || !fold.open) return;
      const section = fold.closest(".rn-release");
      if (!section) return;
      const dur = parseFloat(getComputedStyle(fold, "::details-content").transitionDuration) || 0;
      if (dur) window.setTimeout(() => easeScrollTo(section, 600), dur * 1000);
      else easeScrollTo(section, 0);
    },
    true,
  );

  // --- Release notes -------------------------------------------------------
    //
    // Its own function rather than a second copy of initSplash: the two dialogs share
    // markup and keyboard behavior, but the alpha modal owns a dismissal key, a design
    // pin and an auto-open on load. What IS shared is the focus trap, and it is small
    // enough that a second honest copy beats a shared abstraction.
  function initNotes() {
    const backdrop = document.getElementById("release-notes");
    if (!backdrop) return;
    const dialog = backdrop.querySelector(".modal");
    const body = document.getElementById("rn-body");
    let lastFocus = null;
    let loaded = false;

    // FETCHED ON FIRST OPEN, then kept. The notes only ever get longer and this modal is
        // on every page, so inlining them would put a growing file on every HTML response.
        //
        // A failure leaves the fallback link that shipped in the markup, which goes to the
        // same content server-rendered. That is the whole error path.
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

  // Tell the layout how tall the page-top banner is, so the map and the drawer move
    // down instead of being painted over.
    //
    // IT LIVES HERE RATHER THAN IN builder.js, WHICH IS WHERE IT WAS UNTIL THE STAGE
    // BANNER LANDED. The viewer is a map page too and loads no copy of builder.js, so a
    // banner there had nothing to push the map down. One writer to --banner-h: two
    // functions setting one custom property is the same trap as two previewOf()s.
    //
    // MEASURED, not declared. `html.has-stage-banner` seeds a plausible one-line height
    // so the first paint is close, but the recovery text wraps to two lines in a narrow
    // drawer. Re-measured on resize, and by a ResizeObserver where there is one — a
    // banner can change height without the window moving.
    //
    // IT ONLY ACTS ON A CHANGE, AND THAT IS WHAT STOPS IT RECURSING FOREVER. This
    // function dispatches a resize and is itself a resize listener, so dispatching
    // unconditionally called it again from inside itself: a RangeError every time a
    // banner appeared, thrown straight through the builder's init(), so everything after
    // that line was never wired and a rider with an unsaved draft got a builder that
    // looked normal and did not work.
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

  // Named for the feature rather than for its shape, so the next helper that lands in
    // this file cannot silently replace it.
    // THE RIDER'S OWN DATE FORMAT AND CLOCK, read once off <html> (#270).
    //
    // WHY THIS EXISTS AT ALL: three client formatters all called toLocaleString with
    // `undefined` as the locale, which is the BROWSER's, not the rider's. So the
    // date-format preference reached the printed roadbook and nothing on screen.
    //
    // HERE RATHER THAN IN A FOURTH CLIENT MODULE because site.js is already loaded by
    // page() on every surface, and a new file needs a <script> line in builder.ts as
    // well — two edits, the second of which fails silently.
    //
    // READ ONCE AND CACHED, WITH A WAY TO FORGET. Both attributes are server-rendered,
    // so on every page but one they cannot change without a load. The exception is
    // /settings, where autosave.js re-stamps <html> and calls forget().
  var fmtPrefs = null;
  function timePrefs() {
    if (fmtPrefs) return fmtPrefs;
    var el = document.documentElement;
    var clock = el.getAttribute("data-clock");
    fmtPrefs = {
      // The tag, for toLocaleString's first argument. Falling back to undefined
      // rather than to "en-US" keeps a page rendered without the stamp — a
      // fragment, a test harness — behaving exactly as it did before.
      locale: el.getAttribute("data-date-format") || undefined,
      // undefined LEAVES THE DECISION WITH THE LOCALE, which is what `locale`
      // means and what the absence of the attribute encodes. It spreads into an
      // options object as a no-op, the same rule hour12For() follows server-side.
      hour12: clock === "h12" ? true : clock === "h24" ? false : undefined,
    };
    return fmtPrefs;
  }

  // A `?` THAT ANSWERS IN PLACE, WITH THE JUMP STILL UNDER IT (#268).
  //
  // Every one of these is a real `<a href="/faq#x">`, and it stays one: this only
  // intercepts a PLAIN LEFT CLICK. A middle click, a ctrl/cmd click, a shift
  // click and "open in new tab" all fall through to the browser and get the FAQ
  // page at the right anchor — which is the behavior a rider expects from
  // anything that looks like a link, and the reason the popover could be added
  // without taking anything away.
  //
  // DELEGATED ON THE DOCUMENT, because the builder rebuilds the panel that holds
  // these on every render and a per-link handler would be lost with it.
  //
  // The popover is the link's next sibling, matched by id rather than by
  // position: the two are written together by faqLink() and nothing moves them,
  // but an id is the thing that stays true if something ever does.
  document.addEventListener("click", function (e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented) return;
    var link = e.target.closest && e.target.closest("a[data-faq]");
    if (!link) return;
    var pop = document.getElementById("faq-" + link.dataset.faq);
    // No popover rendered means the FAQ anchor went missing, and the link is
    // then exactly what it was before this existed. Falling through is the
    // fallback, not a failure.
    if (!pop || typeof pop.showPopover !== "function") return;
    e.preventDefault();
    if (pop.matches(":popover-open")) pop.hidePopover();
    else pop.showPopover();
  });

  window.TBFmt = {
    timePrefs: timePrefs,
    forget: function () {
      fmtPrefs = null;
    },
  };

  window.TBBanner = { refresh: refreshBanner };

  function initBanner() {
    refreshBanner();
    window.addEventListener("resize", refreshBanner);
    // EVERY banner, not the first. The consent bar (consent.js) is the first
    // .tb-banner in the DOM on every page it renders on, so observing only the
    // first would leave the builder's recovery bar unwatched exactly when a
    // rider from the EU opens the builder with a draft to recover.
    if (window.ResizeObserver) {
      document.querySelectorAll(".tb-banner").forEach(function (bar) {
        new ResizeObserver(refreshBanner).observe(bar);
      });
    }
  }

  // The service worker (#69) — what makes a kept ride open with no signal.
  // Registered from here because this file is on every page, and a rider who
  // presses Keep on the go page needs the worker to already be controlling the
  // site by the time they are standing in a gravel lot.
  //
  // SKIPPED ON A DEV HOST unless asked for, because `npm run dev` live-reloads on
  // every save and a worker holding yesterday's stylesheet is an afternoon lost
  // to a cache. `routeloop.sw=1` in localStorage turns it on for testing the
  // feature itself. `updateViaCache: "none"` is the browser-side half of the
  // no-cache header /sw.js sends: the script is re-fetched on every check.
  function initServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (IS_LOCAL && readStore("routeloop.sw") !== "1") return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(function () {
      /* a refused registration is a site with no offline copy, which is what it was before */
    });
  }

  function init() {
    initNav();
    initSplash();
    initNotes();
    initFab();
    initSplashVideo();
    initFaq();
    initBanner();
    initServiceWorker();
  }

  // `defer` normally guarantees DOM readiness, but this file is also safe to
  // load without it.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
