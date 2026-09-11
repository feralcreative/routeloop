// Show me around — the guided tour of the builder. #133.
//
// **A TOUR, NOT A TOOLTIP.** tips.js explains one control when a rider points
// at it; this walks a NEW rider through building their first route, in order,
// and three of its steps do not move on until the rider has actually done the
// thing — named the ride, added a point, added a second so a road draws. Those
// three are the ones that do not land unless you do them, and they are the only
// three that cannot get stuck, because each one spotlights exactly where to act.
//
// **THE WAITS WATCH THE DOM, NOT BUILDER STATE, AND NOT CLICKS.** Shepherd's
// own `advanceOn` binds to a DOM event on a selector, and a click is not the
// thing being waited for: a map click does not mean a point landed (the Routes
// call can fail, the click can miss), and the rider may add the point by search
// instead. `state` in builder.js is not reachable from here and should not be.
// So each wait is a MutationObserver on the route list plus a predicate over
// what is on screen — a `.point-row` exists, two exist — which is exactly what
// the rider is looking at, and it cannot disagree with them.
//
// **SHEPHERD ARRIVES AS A MODULE AND THIS FILE IS NOT ONE.** Shepherd 12+ ships
// ESM only and cdnjs stops hosting its JS at 11, so it comes from jsdelivr
// through a `<link rel="modulepreload" integrity>` in routes/builder.ts — the
// one place an integrity hash can ride on a module — and this file `import()`s
// the preload's own href after load, so the URL is written once. If the CDN
// fails, the import rejects, `boot()` never runs, the tour is simply absent,
// and the builder is untouched: the SortableJS arrangement. See the note on
// the script block in routes/builder.ts for why this is a dynamic import from a
// classic script and not an inline module.
//
// **IT REUSES THE `data-tip` KEYS AS ANCHORS**, which is what makes the two
// features one vocabulary: a step attaches to `[data-tip="route-add"]` rather
// than to a class name, so a control that moves keeps its step, and the test
// that pins tips.js's table against the tree pins these anchors with it.
(function () {
  "use strict";

  var DONE_URL = "/api/tour/done";
  // How far right an attached card is pushed on a desktop — see build().
  var DESKTOP_NUDGE_PX = 20;

  // ——— The steps ———
  //
  // `at` is a data-tip key (or a CSS selector when it starts with a `.` or
  // `#`); null centers the card. `wait` is a predicate the step polls through a
  // MutationObserver on the route list — the step shows no Next while it is
  // false, and advances itself the moment it is true.
  var STEPS = [
    {
      id: "welcome",
      title: "This is where a ride gets planned",
      text: "Two minutes, and you can leave at any time—the tour is always under the menu if you want it back. Everything you do here is real: by the end you will have a route you could ride tomorrow.",
    },
    {
      id: "name",
      at: "ride-name",
      title: "Give it a name",
      text: "Click the big title and type. Anything—“Coast run”, “Dad’s birthday”, the name of the town at the far end—then press Enter. You can change it whenever you like.",
      wait: function () {
        // A NEW RIDE OPENS ALREADY NAMED "Untitled ride" — builder.js seeds it so
        // the ride can save from the first pin — so "has a name" is "has a name
        // that is not the seed". Compared against the placeholder AND the
        // literal, because they only agree on `/builder/:id`: a fresh `/builder`
        // says "Plan a ride" in the placeholder and "Untitled ride" in the field,
        // and comparing against the placeholder alone skipped this step for
        // exactly the rider it exists for. A rider who genuinely named a ride
        // "Untitled ride" is asked to name it again, which costs them a second.
        var t = document.getElementById("ride-title");
        if (!t) return false;
        var v = t.value.trim();
        return !!v && v !== (t.placeholder || "").trim() && v !== "Untitled ride";
      },
      waiting: "Waiting for a name…",
    },
    {
      id: "map",
      at: "#map",
      title: "The map is the other half",
      text: "Everything in this panel is drawn over there, and most of it can be done from either side—click the map to add a point, drag a road to reshape it. The panel is for the details the map cannot show.",
      side: "left",
    },
    {
      id: "route",
      at: ".route-head",
      title: "A ride is made of routes",
      text: "Each of these is one stretch of the trip—usually a day. It has a name, a color on the map, and its own start time. A weekend is two of them. A week away is seven, and the panel will happily hold more.",
    },
    {
      id: "first-point",
      at: ".add-row",
      extra: ["#map"],
      title: "Add your first point",
      text: "Type a place here—a town, a café, an address—and pick it from the list. Or press + Point and click anywhere on the map. Either way it lands here, as the start of the route.",
      wait: function () {
        return document.querySelectorAll("#route-list .point-row").length >= 1;
      },
      waiting: "Waiting for a point…",
    },
    {
      id: "second-point",
      at: ".add-row",
      extra: ["#map"],
      title: "And a second",
      text: "One more, somewhere you would actually ride to. As soon as it lands, a road is drawn between the two—that line is the leg, and every number in the builder comes from it.",
      wait: function () {
        return document.querySelectorAll("#route-list .point-row").length >= 2;
      },
      waiting: "Waiting for a second point…",
    },
    {
      id: "leg",
      at: "totals-ride",
      side: "bottom",
      title: "That is a route",
      text: "Distance, riding time, and how twisty the road is, worked out from the road itself. Add a third point and the road bends to pass through it; drag a point in the list and the road is redrawn.",
    },
    {
      id: "stop",
      at: "row-dur",
      title: "Stops take time, and the builder knows it",
      text: "Type how long you will be off the bike—lunch, a photo, a night in a motel. Everything after it moves later, which is how the arrival time at the far end stays honest.",
    },
    {
      id: "category",
      at: "row-roles",
      title: "Say what a place is for",
      text: "Fuel, food, a bed, a view. The dot beside each point opens the list. It puts the right icon on the map and it is how the builder knows where you can fill up—which matters more than it sounds in eastern Nevada.",
    },
    {
      id: "when",
      at: ".route-start",
      title: "Give it a date, and the clock starts",
      text: "Set when the route starts and every point gets an arrival time. A slider appears along the bottom of the map, and dragging it shows where you would be at any moment of the day.",
    },
    {
      id: "menu",
      at: "route-menu",
      title: "Everything else is behind the dots",
      text: "Duplicate a route, reverse it, split it at a stop, offer it as an alternative for a vote. The same three dots on a point row do the same for a point—including the details only you can see, like a confirmation number.",
    },
    {
      id: "done",
      title: "That is the whole idea",
      text: "Routes, points, stops, times. Everything saves as you go. Point at any control and it will tell you what it is for, and the tour is under the menu whenever you want it again. Have a good ride.",
    },
  ];

  var tour = null;
  var Shepherd = null;

  /** The element a step attaches to, resolved at show time because the route
   *  list is re-rendered on every edit and a reference taken earlier is a
   *  reference to a node that no longer exists. */
  function anchor(at) {
    if (!at) return null;
    var sel = /^[.#]/.test(at) ? at : '[data-tip="' + at + '"]';
    // THE FIRST VISIBLE MATCH, NOT THE FIRST MATCH. The route list renders an
    // `.add-search` inside every collapsed insert slot as well as in the
    // route's own add-row, so `querySelector` answers with a hidden one — and
    // Floating UI positions the card against a zero-size box at the top-left
    // corner while the overlay cuts a hole of nothing. Seen on the
    // second-point step, which is the one a new rider spends longest on.
    var all = document.querySelectorAll(sel);
    for (var i = 0; i < all.length; i++) {
      var r = all[i].getBoundingClientRect();
      if (r.width || r.height) return all[i];
    }
    return null;
  }

  function done() {
    // Fire-and-forget. A rider who finished the tour does not need to wait on
    // a write, and a failed one costs a second offer next time, not data.
    try {
      fetch(DONE_URL, { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "fetch" } }).catch(
        function () {},
      );
    } catch (e) {
      /* nothing to do */
    }
    document.documentElement.removeAttribute("data-tour");
  }

  /**
   * Builds the Shepherd step options for one of ours.
   *
   * A waiting step gets no Next button at all: the only way through it is to
   * do the thing, and a button that is disabled with a spinner beside it is a
   * promise that something is loading. The observer below is what advances it.
   */
  function stepOptions(step, i) {
    var last = i === STEPS.length - 1;
    var buttons = [];
    if (i > 0)
      buttons.push({
        text: "Back",
        classes: "btn btn-quiet",
        action: function () {
          tour.back();
        },
      });
    if (step.wait) {
      buttons.push({ text: step.waiting, classes: "tour-waiting", disabled: true, action: function () {} });
    } else {
      // `btn` and nothing else: the guide-sign rule in _chrome.scss outranks
      // Shepherd's own button by specificity, so Next is the house sign with
      // no help from _tour.scss. Back is the flat variant and does need help.
      buttons.push({
        text: last ? "Done" : "Next",
        classes: "btn",
        action: function () {
          if (last) tour.complete();
          else tour.next();
        },
      });
    }

    var opts = {
      id: step.id,
      title: step.title,
      text: step.text,
      buttons: buttons,
      // Bringing the control on screen ourselves rather than letting Shepherd
      // scroll: its default is `scrollIntoView` on the element, which on the
      // builder scrolls the PANEL — fine — and on `#map` tries to scroll a
      // fixed element, which does nothing and logs nothing.
      scrollTo: false,
      cancelIcon: { enabled: true },
      when: {
        show: function () {
          if (!step.wait) return;
          // Already satisfied — a rider re-running the tour on a real ride has
          // a name and points, so the wait resolves at once rather than asking
          // them to add a third point to a route that has nine.
          if (step.wait()) {
            tour.next();
            return;
          }
          watch(step);
        },
        hide: unwatch,
        cancel: unwatch,
      },
    };

    // **THE OVERLAY BLOCKS EVERY CLICK OUTSIDE THE CUT-OUT, SO A STEP THAT
    // OFFERS TWO WAYS IN HAS TO CUT TWO HOLES.** The point steps say "type a
    // place here, or press + Point and click the map" — so the spotlight is the
    // whole add-row (search box, chips and the + Point button together) and
    // `extra` cuts a second hole over the map. Without the second one the copy
    // promised a click the overlay swallowed.
    if (step.extra) opts.extraHighlights = step.extra;

    if (step.at) {
      opts.attachTo = {
        element: function () {
          var el = anchor(step.at);
          if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest" });
          return el;
        },
        on: step.side || "auto",
      };
    }
    return opts;
  }

  // ——— The waits ———
  //
  // One observer at a time, on the route list and on the title, because those
  // are the only two things a wait reads. `input` covers the title; the
  // observer covers everything the builder renders.
  var mo = null;
  var onInput = null;

  function watch(step) {
    unwatch();
    var check = function () {
      if (!step.wait()) return;
      unwatch();
      // Let the builder finish its own render before the next card measures
      // the element it attaches to.
      setTimeout(function () {
        if (tour && tour.isActive() && tour.getCurrentStep().id === step.id) tour.next();
      }, 350);
    };
    var list = document.getElementById("route-list");
    if (list && window.MutationObserver) {
      mo = new MutationObserver(check);
      mo.observe(list, { childList: true, subtree: true });
    }
    // `change`, NOT `input`. The name step advanced on the first keystroke that
    // differed from the seed — a rider who was told to type "Coast run" got as
    // far as "Coast" before the spotlight moved and focus went with it. `change`
    // fires when the field is COMMITTED: on blur, and on Enter, which the title
    // field turns into a blur. The MutationObserver above is already a commit
    // signal for the point steps, since a row lands once.
    onInput = check;
    document.addEventListener("change", onInput, true);
  }

  function unwatch() {
    if (mo) {
      mo.disconnect();
      mo = null;
    }
    if (onInput) {
      document.removeEventListener("change", onInput, true);
      onInput = null;
    }
  }

  function build() {
    if (tour) return tour;
    tour = new Shepherd.Tour({
      tourName: "builder",
      useModalOverlay: true,
      exitOnEsc: true,
      keyboardNavigation: true,
      defaultStepOptions: {
        classes: "tour-step",
        modalOverlayOpeningPadding: 6,
        modalOverlayOpeningRadius: 8,
        // Shepherd deep-merges `floatingUIOptions` over its own, and deepmerge
        // CONCATENATES arrays — so this middleware is appended after Shepherd's
        // flip and shift rather than replacing them. (An empty array here was
        // the first draft's mistake for the opposite reason: it still merged,
        // to nothing useful, and a card near an edge was cut off.)
        //
        // **THE CARD SITS 20px FURTHER RIGHT ON A DESKTOP.** Ziad's call,
        // 2026-09-10: attached to a control in the drawer, the card landed
        // with its left edge inside the panel, over the row it was pointing
        // at. A plain nudge rather than a placement change, because every
        // step wants the same amount and Floating UI's own `offset` is along
        // the placement axis, which is the wrong axis for a card placed
        // "auto". Hand-written because Shepherd bundles Floating UI and
        // exports none of it. Not on a phone, where the card is centered and
        // 20px is a fifth of the gutter.
        floatingUIOptions: {
          middleware: [
            {
              name: "desktop-nudge",
              fn: function (state) {
                if (!window.matchMedia("(min-width: 992px)").matches) return {};
                return { x: state.x + DESKTOP_NUDGE_PX };
              },
            },
          ],
        },
      },
    });
    STEPS.forEach(function (s, i) {
      tour.addStep(stepOptions(s, i));
    });
    tour.on("complete", done);
    tour.on("cancel", done);
    tour.on("active", reanchorOn);
    tour.on("inactive", reanchorOff);
    // `html.tour-active` is for the stylesheet: the place-search dropdown is
    // `position: fixed` at z-index 1001, which beats the drawer and loses to
    // Shepherd's overlay at 9997 — so on the second-point step the list a rider
    // was told to pick from opened UNDER the backdrop. _tour.scss lifts it
    // between the overlay and the card while a tour is running, and only then.
    // Shepherd 15 no longer adds a body class of its own, so this is ours.
    tour.on("active", function () {
      document.documentElement.classList.add("tour-active");
    });
    tour.on("inactive", function () {
      document.documentElement.classList.remove("tour-active");
    });
    return tour;
  }

  // ——— Surviving a re-render ———
  //
  // **THE BUILDER REPLACES THE ROUTE LIST ON EVERY EDIT, AND A CARD PINNED TO
  // A NODE THAT NO LONGER EXISTS SLIDES TO THE TOP-LEFT CORNER.** Shepherd
  // re-resolves `attachTo` on each show, which is right, and then Floating UI
  // keeps positioning against the element it was handed — so the autosave
  // after the rider types a name re-renders the list, the search box the card
  // was pointing at is detached, its box reads as zero, and the card lands at
  // (0,0) with the spotlight cut down to nothing. Seen on the second-point
  // step, which is where a new rider waits longest.
  //
  // The fix is the one tips.js uses for the same problem: watch the list, and
  // when the current step's target is no longer in the document, show the
  // step again so it resolves a fresh one. `getTarget()` is public API.
  var listMo = null;
  var reanchorQueued = false;

  function reanchor() {
    reanchorQueued = false;
    if (!tour || !tour.isActive()) return;
    var step = tour.getCurrentStep();
    if (!step || !step.options.attachTo) return;
    var target = step.getTarget();
    if (target && target.isConnected) return;
    step.show();
  }

  function reanchorOn() {
    var list = document.getElementById("route-list");
    if (!list || !window.MutationObserver || listMo) return;
    listMo = new MutationObserver(function () {
      // One re-show per frame, however many mutations a render produced.
      if (reanchorQueued) return;
      reanchorQueued = true;
      requestAnimationFrame(reanchor);
    });
    listMo.observe(list, { childList: true, subtree: true });
  }

  function reanchorOff() {
    if (listMo) {
      listMo.disconnect();
      listMo = null;
    }
  }

  function start() {
    if (!Shepherd) return false;
    build();
    if (tour.isActive()) return true;
    tour.start();
    return true;
  }

  /**
   * Called by the inline module in routes/builder.ts once Shepherd's import has
   * resolved. Starts the tour unasked for a rider the server stamped as new —
   * `data-tour="new"` on <html> — and otherwise only wires the button.
   */
  function boot(S) {
    Shepherd = S;
    // TWO WAYS IN, AND THEY ARE DIFFERENT RIDERS. `data-tour="new"` is the
    // server saying this rider has never been offered it; `?tour` is the
    // account menu's Take the tour, which is a real link to a fresh ride so it
    // works from any page — a tour that started on the dashboard would have
    // nothing to point at. The query is stripped after reading so a reload
    // does not start it again.
    var asked = /(?:\?|&)tour(?:=|&|$)/.test(window.location.search);
    if (asked && window.history.replaceState) {
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    }
    var isNew = asked || document.documentElement.getAttribute("data-tour") === "new";
    if (isNew) start();
  }

  // ON THE BUILDER, Take the tour starts in place rather than opening a fresh
  // ride: a rider who wants a reminder on the ride they are looking at should
  // get one on that ride. The item is a real link to `/builder?tour` either
  // way, so with Shepherd missing the click falls through to navigation and
  // the fresh ride's own boot() gets a second chance at the CDN.
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("[data-tour-start]") : null;
    if (!b || !Shepherd) return;
    e.preventDefault();
    start();
  });

  // AFTER `load`, NOT ON DOMContentLoaded: the builder draws on
  // DOMContentLoaded and nothing here may sit ahead of it. By `load` the map
  // and the route list both exist for the first attached step to point at.
  function load() {
    var link = document.getElementById("shepherd-module");
    if (!link || !link.href) return;
    import(link.href)
      .then(function (m) {
        boot(m.default);
      })
      .catch(function () {
        /* the CDN did not answer; the builder is unaffected */
      });
  }
  if (document.readyState === "complete") load();
  else window.addEventListener("load", load);

  window.TBTour = {
    boot: boot,
    start: start,
    STEPS: STEPS,
    // The live Shepherd tour, for the console and for nothing in the app.
    get tour() {
      return tour;
    },
  };
})();
