// Show me around — the guided tour of the builder. #133.
//
// **A TOUR, NOT A TOOLTIP.** tips.js explains one control when a rider points
// at it; this walks a NEW rider through building their first route, in order,
// and four of its steps DO THE THING IN FRONT OF THEM — name the ride, add a
// point, add a second so a road draws, set a start time. Ziad's call,
// 2026-09-11, reversing the 2026-09-10 shape where those four WAITED for the
// rider to act: the only interaction a tour asks for now is Next, Back and
// Skip, and everything else is demonstrated with a flashing cursor typing into
// the real field. What that produces is real — the ride is named, the points
// land, the road is routed — because the tour runs on a blank ride and the
// builder saves from the first pin; the closing card says so and tells the
// rider to rename it or bin it.
//
// **A DEMONSTRATION WATCHES THE DOM, NOT BUILDER STATE.** It types into the
// title and into the add-row's own search box, dispatching the events the
// builder listens for, and reads its result off what is on screen — a
// `.point-row` exists, two exist — which is exactly what the rider is looking
// at and cannot disagree with them. `state` in builder.js is not reachable
// from here and should not be; the one door is `TBBuilder.fitTo`, because the
// typed search is restricted to the visible map and the two places have to be
// on screen before the first one is typed.
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

  // ——— The ride the tour builds ———
  //
  // A REAL PAIR OF PLACES ON A REAL ROAD, not somewhere near wherever the map
  // happens to be: a demonstration that lands two random pins in a random town
  // draws a two-mile hop and teaches nothing about what the numbers mean. Alice’s
  // to Pescadero is a classic Bay Area motorcycle run — Skyline to the coast —
  // and the typed search is restricted to the visible map, so `fitTo(BOX)`
  // brings both on screen before the first name is typed. The queries carry the
  // town so Autocomplete's first hit is the place and not a namesake.
  var DEMO = {
    name: "Coast run",
    box: [
      [-122.45, 37.2],
      [-122.15, 37.45],
    ],
    points: ["Alice’s Restaurant, Woodside", "Pescadero"],
  };
  // Typing rhythm: per character, the cursor blinking alone before the first
  // one, and a beat after the last so the word is read before anything moves.
  var TYPE_MS = 60;
  var CARET_LEAD_MS = 700;
  var SETTLE_MS = 400;
  // How long a demonstration gets before the card gives up and offers Next
  // anyway. Long, because a point is two Google calls and a Routes request.
  var DEMO_TIMEOUT_MS = 15000;

  // ——— The steps, in three parts ———
  //
  // **THREE PARTS A RIDER CAN TAKE IN ANY ORDER OR SKIP AT WILL.** Ziad's
  // call, 2026-09-10: the route, the clock, and the people. Every card carries
  // a "Skip this part" beside Next, the welcome and closing cards offer the
  // three parts as buttons, and `jump()` is the one way between them — so a
  // rider who only came for meeting points is two clicks from them.
  //
  // `at` is a data-tip key (or a CSS selector when it starts with a `.` or
  // `#`); null centers the card. `demo` is an async function that does the
  // step's thing in front of the rider — the card shows a status line in place
  // of Next until it settles — and `done` is the predicate that says whether
  // it already happened, so Back and a second pass do not do it twice. `tab`
  // is a panel tab to open before the step shows, because a control on a shut
  // tab has no box.
  var PARTS = [
    { n: 1, name: "The route", blurb: "Name it, add two points, watch the road draw." },
    { n: 2, name: "The clock", blurb: "Dates, arrival times, and the slider along the bottom of the map." },
    { n: 3, name: "The people", blurb: "Groups, who rides which route, and where to meet." },
  ];

  var STEPS = [
    {
      id: "welcome",
      title: "This is where a ride gets planned",
      text: "Three short parts, each a couple of minutes. Take them in order, jump to one, or skip any of them—the tour is always under the menu if you want it back. It builds a real ride as it goes, so by the end you will have a route you could ride tomorrow.",
      chooser: true,
    },

    // ——— Part 1: the route ———
    {
      id: "name",
      part: 1,
      at: "ride-name",
      title: "Give it a name",
      text: "The big title is the ride’s name. Click it and type anything—the town at the far end, whose birthday it is—and press Enter. Let me name this one.",
      running: "Typing a name…",
      done: function () {
        // A NEW RIDE OPENS ALREADY NAMED "Untitled ride" — builder.js seeds it so
        // the ride can save from the first pin — so "has a name" is "has a name
        // that is not the seed". Compared against the placeholder AND the
        // literal, because they only agree on `/builder/:id`: a fresh `/builder`
        // says "Plan a ride" in the placeholder and "Untitled ride" in the field.
        var t = document.getElementById("ride-title");
        if (!t) return false;
        var v = t.value.trim();
        return !!v && v !== (t.placeholder || "").trim() && v !== "Untitled ride";
      },
      demo: function () {
        var t = document.getElementById("ride-title");
        if (!t) return Promise.resolve();
        return typeInto(t, DEMO.name).then(function () {
          // Enter is how the field commits — builder.js turns it into a blur.
          t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          t.dispatchEvent(new Event("change", { bubbles: true }));
        });
      },
    },
    {
      id: "panel",
      part: 1,
      at: "#info-panel",
      side: "right",
      title: "The builder is two halves. This is the first",
      text: "The panel: your routes, every point on them, how long you stop, when you leave. It is a list, and the order of the list is the order you ride. Everything the map cannot say in a picture is said here.",
    },
    {
      id: "map",
      part: 1,
      at: "#map",
      title: "The map is the other half",
      text: "Everything in the panel is drawn over here, and most of it can be done from either side—click the map to add a point, drag a road to reshape it. Neither half is the real one; they are the same ride, twice.",
      side: "left",
    },
    {
      id: "route",
      part: 1,
      at: ".route-head",
      title: "A ride is made of routes",
      text: "Each of these is one stretch of the trip—usually a day. It has a name, a color on the map, and its own start time. A weekend is two of them. A week away is seven, and the panel will happily hold more.",
    },
    {
      id: "first-point",
      part: 1,
      at: ".add-row",
      extra: ["#map"],
      title: "Add your first point",
      // A FUNCTION, because a rider with a home base on their profile opens
      // every new ride with it already sitting here as point 1 — builder.js
      // seeds it — so for them there is nothing to type and the card says what
      // the row is instead. `done` is true for them from the start, so the
      // demonstration below never runs; a rider with no home base watches a
      // restaurant on Skyline get typed in.
      text: function () {
        var seeded = document.querySelectorAll("#route-list .point-row").length >= 1;
        return seeded
          ? "Your home base is already here as the start—every new ride begins there, and it moves or deletes like any other point. Otherwise you would type a place here—a town, a café, an address—and pick it from the list, or press + Point and click the map."
          : "Type a place here—a town, a café, an address—and pick it from the list. Or press + Point and click anywhere on the map. Either way it lands here, as the start of the route. Watch: a restaurant up on Skyline.";
      },
      running: "Finding a place…",
      done: function () {
        return document.querySelectorAll("#route-list .point-row").length >= 1;
      },
      demo: function () {
        return addPlace(DEMO.points[0], 1);
      },
    },
    {
      id: "second-point",
      part: 1,
      at: ".add-row",
      extra: ["#map"],
      title: "And a second",
      text: "One more, a destination—the coast. As soon as it lands, a road is drawn between the two: that line is the leg, and every number in the builder comes from it.",
      running: "Finding a place…",
      done: function () {
        return document.querySelectorAll("#route-list .point-row").length >= 2;
      },
      demo: function () {
        return addPlace(DEMO.points[1], 2);
      },
    },
    {
      id: "leg",
      part: 1,
      at: "totals-ride",
      side: "bottom",
      title: "Ride totals and stats",
      text: "Distance, riding time, and how twisty the road is, worked out from the road itself. Add a third point and the road bends to pass through it; drag a point in the list and the road is redrawn.",
    },
    {
      id: "stop",
      part: 1,
      at: "row-dur",
      title: "Stops take time, and the builder knows it",
      text: "Type how long you will be off the bike—lunch, a quick photo, a night in a motel. Everything after it moves later, which is how the arrival time at the far end stays honest.",
    },
    {
      id: "category",
      part: 1,
      // **THE WHOLE ROW, NOT THE DOT, AND THAT IS WHAT KEEPS THE PICKER OUT
      // FROM UNDER THE BACKDROP.** The picker opens as a child of `.point-row`,
      // and Shepherd’s overlay cuts its hole from the TARGET’s box — so with
      // the step attached to the dot, the grid the rider had just been told to
      // open landed outside the cut-out and read as dimmed. It cannot be lifted
      // with a z-index the way `#search-results` is: that list is a child of
      // <body>, where this one is inside `#info-panel`, which is fixed at 1000
      // and so is a stacking context nothing inside it can escape. Attaching to
      // the row puts the open picker inside the spotlight instead. Opening it
      // re-renders the route list, so `reanchor()` re-shows the step against the
      // taller row and the hole grows with it.
      at: ".point-row",
      title: "Say what a place is for",
      text: "Fuel, food, a bed, a view. The dot beside each point opens the list, and a point can carry up to four of them—gas and lunch and a photo at the same stop. They put the right icons on the map, and they are how the builder knows where you fuel up and what your range will be from there.",
    },
    {
      id: "menu",
      part: 1,
      at: "route-menu",
      title: "Everything else is behind the dots",
      text: "Duplicate a route, reverse it, split it at a stop, offer it as an alternative for a vote. The same three dots on a point row do the same for a point—including the details only you can see, like a confirmation number.",
    },

    // ——— Part 2: the clock ———
    //
    // **AN INTERSTITIAL OPENS EACH PART AFTER THE FIRST.** Ziad's call,
    // 2026-09-11. A part's first card used to be a control with a wait on it,
    // so a rider finishing part 1 was dropped straight onto "give the route a
    // start time" with nothing saying the subject had changed. The welcome
    // card already does this job for part 1, which is why there is no third
    // one. `intro` centers the card, drops the step counter from the part line
    // and labels Next "Start part N"; `jump()` lands on it too, so a rider
    // picking a part from the chooser is introduced to it the same way.
    {
      id: "intro-2",
      part: 2,
      intro: true,
      title: "Next: the clock",
      text: "Part 1 gave the ride a road. This part gives it a clock: a start time on the route, an arrival time at every point worked out from it, an end that follows on its own, a slider along the bottom of the map, and an hour to start looking for a bed. Set one time and the rest appears.",
    },
    {
      id: "when",
      part: 2,
      at: ".route-start",
      title: "Give the route a start time",
      text: "Pick the day and the hour you set off. Every point gets an arrival time from it, the end of the route works itself out, and a slider appears along the bottom of the map. Let me make it Saturday at nine.",
      running: "Setting a start time…",
      done: function () {
        var el = anchor(".route-start");
        return !!(el && el.value);
      },
      demo: function () {
        var el = anchor(".route-start");
        if (!el) return Promise.resolve();
        // A date field cannot be typed a character at a time, so the cursor
        // blinks on it for a beat and the value lands whole. `change` is what
        // builder.js listens for on this field.
        showCaret(el);
        return sleep(CARET_LEAD_MS + SETTLE_MS).then(function () {
          el.value = nextSaturdayAtNine();
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          hideCaret();
          return sleep(SETTLE_MS);
        });
      },
    },
    {
      id: "timeline",
      part: 2,
      at: "timeline",
      side: "top",
      title: "This is the time scrubber",
      // A FUNCTION, because the slider only exists once a route has a start
      // time AND a road — one point and a date is still nothing to scrub. A
      // rider who jumped straight to this part on a bare ride gets the card
      // centered, and the copy has to say why there is nothing under it.
      text: function () {
        var base =
          "Drag it and the dot on the map shows where you would be at that moment, with the leg you would be on lit up. On a ride with several routes a Route | Ride switch beside it lets the slider run over one day or all of them.";
        return anchor("timeline")
          ? base
          : base +
              " It appears along the bottom of the map once a route has a start time and at least two points—add a second point in part 1 and it will be here.";
      },
    },
    {
      id: "route-end",
      part: 2,
      at: "route-end",
      title: "The end is worked out for you",
      text: "Start time, plus the riding, plus every stop along the way. Type over it if you know better—a hard deadline at the far end—or clear it to hand it back to the builder.",
    },
    {
      id: "bed",
      part: 2,
      at: "ride-stop-by",
      title: "When to start looking for a bed",
      text: "Set an hour here and every route gets a band across its list at the point it reaches that time, with how much riding is still left after it. It is advice, not a limit—riding past four is your call, and this puts the consequence beside the choice.",
    },

    // ——— Part 3: the people ———
    {
      id: "intro-3",
      part: 3,
      intro: true,
      title: "Next: the people",
      text: "A ride is rarely one person. This part is the riders on it: groups for people who set off from different places, the roster of who is coming, and which route each of them is on. With two or more groups the builder will propose where to meet.",
    },
    {
      id: "groups",
      part: 3,
      at: "#tab-groups",
      tab: "tab-groups",
      side: "bottom",
      title: "Groups are where riders set off from",
      text: "Every ride has one group to start with—yours. The first in the list is the main group: its road is the road everybody else joins, and its departure is what the other groups’ times are worked out from. Drag another group above it to hand that over.",
    },
    {
      id: "groups-add",
      part: 3,
      at: "#sg-add",
      tab: "tab-groups",
      title: "Add a group for riders starting somewhere else",
      text: "Name it and say where they set off from. Each group gets its own approach route, and with two or more groups the builder can propose where to meet—a fuel stop everybody can reach on the tank they leave with, as early on the main group’s road as the detour allows.",
    },
    {
      id: "riders",
      part: 3,
      at: "#tab-riders",
      tab: "tab-riders",
      side: "bottom",
      title: "Who is coming",
      text: "The roster. Riders are added from the ride’s page, friends only, and each says whether they are in. Their bikes’ ranges are what the fuel warnings are built from, so the smallest tank on the ride is the one that counts.",
    },
    {
      id: "riders-routes",
      part: 3,
      at: "route-groups",
      tab: "tab-routes",
      title: "Who rides which route",
      text: "This pill on each route says who is on it. Leave it alone and everybody rides everything; tick a group here to say somebody joins or peels off at this point, and the roadbook and every export follow.",
    },

    {
      id: "done",
      title: "That is the whole idea",
      text: "Routes, points, stops, times, and the people on them. The ride the tour built is yours—rename it, add to it, or bin it. Everything saves as you go. Point at any control and it tells you what it is for, and the tour is under the menu whenever you want it again. Have a good ride.",
      chooser: true,
      tab: "tab-routes",
    },
  ];

  var tour = null;
  var Shepherd = null;
  // Which way the rider is moving, set at the tour's own `show` — which fires
  // before the step's — by comparing indices. Shepherd's `back()` passes a
  // direction into `show()` but hands it to no event.
  var lastIndex = -1;
  var backward = false;

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
   * A demonstrating step shows a status line where Next would be until its
   * demonstration settles; then Next appears. Nothing advances on its own.
   */
  // ——— Parts ———

  /** The id of the first step of part `n`, or of the closing card past the
   *  last part. */
  function partStart(n) {
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].part === n) return STEPS[i].id;
    return "done";
  }

  /** Jumps to a part. `tour.show()` takes an id, so this is the whole thing. */
  function jump(n) {
    tour.show(partStart(n));
  }

  /**
   * Title Case for the part line only. The chooser's own rows keep the
   * sentence-case name, because there they are headings rather than a
   * position line. "of" is authored in the surrounding literal and stays
   * lowercase on its own; this only reaches the part's name.
   */
  function titleCase(s) {
    return s.replace(/\b[a-z]/g, function (c) {
      return c.toUpperCase();
    });
  }

  /**
   * "Part 2 of 3 · The Clock · 3 of 4", rendered above the body. An intro card
   * carries the first two and not the counter — it is the door to the part,
   * not a step of it, and counting it would make "1 of 5" a card with no
   * control on it.
   */
  function partLine(step) {
    if (!step.part) return "";
    var part = PARTS[step.part - 1];
    var inPart = STEPS.filter(function (s) {
      return s.part === step.part && !s.intro;
    });
    var i = inPart.indexOf(step) + 1;
    return (
      '<small class="tour-part">Part ' +
      part.n +
      " of " +
      PARTS.length +
      " · " +
      esc(titleCase(part.name)) +
      (step.intro ? "" : " · " + i + " of " + inPart.length) +
      "</small>"
    );
  }

  /** The three part buttons, for the welcome and closing cards. */
  function chooserHtml() {
    return (
      '<ul class="tour-parts">' +
      PARTS.map(function (p) {
        return (
          '<li><button type="button" class="tour-part-btn" data-tour-part="' +
          p.n +
          '"><b>' +
          p.n +
          ". " +
          esc(p.name) +
          "</b><span>" +
          esc(p.blurb) +
          "</span></button></li>"
        );
      }).join("") +
      "</ul>"
    );
  }

  function esc(v) {
    return String(v).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

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
    // **SKIP THIS PART ON EVERY CARD INSIDE A PART**, not only on the first: a
    // rider who realizes three cards in that they know this already should
    // not have to Back out to leave. It lands on the next part's first card,
    // or on the closing card after the last part.
    if (step.part)
      buttons.push({
        text: "Skip this part",
        classes: "btn btn-quiet",
        action: function () {
          jump(step.part + 1);
        },
      });
    if (step.demo) {
      buttons.push({ text: step.running, classes: "tour-waiting", disabled: true, action: function () {} });
      // **THE CARD CARRIES BOTH A STATUS LINE AND A NEXT, and `is-satisfied`
      // on the element decides which is drawn** — see _tour.scss. The line
      // shows while the demonstration runs; Next replaces it when the thing
      // is done, or was already done (a rider pressing Back onto this card,
      // or forward onto it a second time, is not shown the typing twice).
      // Nothing advances on its own: what was typed deserves a look.
      buttons.push({
        text: "Next",
        classes: "btn tour-next-done",
        action: function () {
          tour.next();
        },
      });
    } else {
      // `btn` and nothing else: the guide-sign rule in _chrome.scss outranks
      // Shepherd's own button by specificity, so Next is the house sign with
      // no help from _tour.scss. Back is the flat variant and does need help.
      buttons.push({
        text: last ? "Done" : step.chooser ? "Start at part 1" : step.intro ? "Start part " + step.part : "Next",
        classes: "btn",
        action: function () {
          if (last) tour.complete();
          else tour.next();
        },
      });
    }

    var opts = {
      id: step.id,
      // Merged with the tour-level `tour-step` by Shepherd, not replaced. The
      // stylesheet keys the card's color band and the part line's swatch on
      // it — red, yellow, green for the three parts. Ziad's call, 2026-09-10.
      classes: step.part ? "tour-part-" + step.part : "",
      title: step.title,
      // Shepherd inserts `text` as HTML. The part line is markup and the copy
      // is trusted — it is this file — so nothing here needs escaping.
      text: function () {
        var body = typeof step.text === "function" ? step.text() : step.text;
        return partLine(step) + "<p>" + body + "</p>" + (step.chooser ? chooserHtml() : "");
      },
      buttons: buttons,
      // Bringing the control on screen ourselves rather than letting Shepherd
      // scroll: its default is `scrollIntoView` on the element, which on the
      // builder scrolls the PANEL — fine — and on `#map` tries to scroll a
      // fixed element, which does nothing and logs nothing.
      scrollTo: false,
      cancelIcon: { enabled: true },
      // A CONTROL ON A SHUT TAB HAS NO BOX, so a step that lives on the Groups
      // or Riders tab opens it first, through the tab's own click handler in
      // tabs.js. The closing card puts Routes back, which is where a rider
      // finishing the tour expects to be.
      beforeShowPromise: function () {
        if (step.tab) {
          var tab = document.getElementById(step.tab);
          if (tab && tab.getAttribute("aria-selected") !== "true") tab.click();
        }
        return Promise.resolve();
      },
      when: {
        show: function () {
          keepTabInside(this.getTarget());
          if (!step.demo) return;
          if (this.el) this.el.classList.remove("is-satisfied");
          if (step.done()) {
            if (this.el) this.el.classList.add("is-satisfied");
            return;
          }
          runDemo(step, this);
        },
        hide: function () {
          releaseTab();
          hideCaret();
        },
        cancel: function () {
          releaseTab();
          hideCaret();
        },
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

  // ——— Tab inside a date field ———
  //
  // **SHEPHERD HIJACKS TAB ON THE TARGET, AND ON A DATE FIELD TAB IS HOW YOU
  // GET FROM THE YEAR TO THE HOUR.** Shepherd binds its keyboard handler to the
  // attached element as well as to the card, and when focus is on the last
  // focusable thing inside the target it takes Tab and moves focus to the
  // card's first button — the cancel X. That is a sensible trap for a text
  // box, whose Tab leaves it anyway. On `datetime-local` Tab is segment
  // navigation, so a rider typing a start time got as far as the year and was
  // dropped on the X. Reported 2026-09-10 on the Part 2 wait.
  //
  // A capture listener on the same element, registered later, still runs
  // FIRST at the target — capture-phase listeners fire before bubble-phase
  // ones on the target itself — so stopping the event here is what keeps it
  // from Shepherd's. Only for the inputs whose Tab means something inside
  // them; everything else keeps Shepherd's trap.
  var tabHost = null;

  function swallowTab(e) {
    if (e.key === "Tab") e.stopImmediatePropagation();
  }

  function keepTabInside(target) {
    releaseTab();
    if (!target || target.tagName !== "INPUT") return;
    if (!/^(datetime-local|date|time|month|week)$/.test(target.type)) return;
    tabHost = target;
    tabHost.addEventListener("keydown", swallowTab, true);
  }

  function releaseTab() {
    if (!tabHost) return;
    tabHost.removeEventListener("keydown", swallowTab, true);
    tabHost = null;
  }

  // ——— The demonstrations ———
  //
  // ONE AT A TIME, KEYED ON THE STEP. A demonstration is async and the rider
  // can press Back, Skip or the X while it runs, so every callback checks that
  // the tour is still on the step that started it before touching the card —
  // and the typing loop stops itself the moment it is not, or a name would go
  // on being typed into a field the rider has moved away from.
  var demoStep = null;

  function stillOn(step) {
    return !!(tour && tour.isActive() && tour.getCurrentStep() && tour.getCurrentStep().id === step.id);
  }

  function runDemo(step, shepherdStep) {
    demoStep = step;
    var finish = function () {
      hideCaret();
      if (demoStep === step) demoStep = null;
      if (!stillOn(step)) return;
      if (shepherdStep.el) shepherdStep.el.classList.add("is-satisfied");
    };
    // The timeout is the floor under a Google outage: Next is offered anyway,
    // with the card's own copy still telling the rider how to do it by hand.
    var timer = setTimeout(finish, DEMO_TIMEOUT_MS);
    Promise.resolve()
      .then(function () {
        return step.demo();
      })
      .catch(function () {
        /* the copy on the card says how to do it by hand */
      })
      .then(function () {
        clearTimeout(timer);
        finish();
      });
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /** Resolves true when `pred()` holds, false at the deadline. Polled rather
   *  than observed: the things it waits for — a dropdown unhiding, a row
   *  landing — are cheap to read and a 100ms poll is invisible. */
  function until(pred, ms) {
    var deadline = Date.now() + ms;
    return new Promise(function (resolve) {
      (function tick() {
        if (pred()) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 100);
      })();
    });
  }

  // ——— The cursor ———
  //
  // A REAL ELEMENT LAID OVER THE FIELD, not the field's own caret. The native
  // one only draws while the field has focus, and Shepherd manages focus for
  // the card; it is also thin, quiet and easy to miss — the thing being asked
  // for is a cursor a rider notices. Placed at the end of the typed text by
  // measuring it in the field's own font, and re-placed after every character.
  var caretEl = null;
  var caretHost = null;

  function showCaret(input) {
    if (!caretEl) {
      caretEl = document.createElement("span");
      caretEl.className = "tour-caret";
      caretEl.setAttribute("aria-hidden", "true");
      document.body.appendChild(caretEl);
    }
    caretHost = input;
    placeCaret();
    caretEl.hidden = false;
  }

  function hideCaret() {
    if (caretEl) caretEl.hidden = true;
    caretHost = null;
  }

  function placeCaret() {
    if (!caretEl || !caretHost || !caretHost.isConnected) return;
    var r = caretHost.getBoundingClientRect();
    var cs = getComputedStyle(caretHost);
    var x = r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth) + textWidth(caretHost, cs);
    // Inside the field, whatever the text measures — a long name in a narrow
    // field scrolls, and the cursor should sit at the visible end.
    x = Math.min(x, r.right - parseFloat(cs.paddingRight) - 2);
    var h = parseFloat(cs.fontSize) * 1.15;
    caretEl.style.left = x + "px";
    caretEl.style.top = r.top + (r.height - h) / 2 + "px";
    caretEl.style.height = h + "px";
  }

  var measureCtx = null;
  function textWidth(input, cs) {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = cs.font || [cs.fontWeight, cs.fontSize, cs.fontFamily].join(" ");
    // A date field holds no text a cursor sits after; it blinks at the start.
    return input.type === "text" || input.tagName === "TEXTAREA" ? measureCtx.measureText(input.value).width : 0;
  }

  /** Types `text` into `input` one character at a time, with the cursor
   *  leading, dispatching `input` per character so the builder sees exactly
   *  what a keyboard would have given it. */
  function typeInto(input, text) {
    var step = demoStep;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    showCaret(input);
    return sleep(CARET_LEAD_MS).then(function () {
      var i = 0;
      return new Promise(function (resolve) {
        (function next() {
          if (!input.isConnected || (step && !stillOn(step))) return resolve();
          if (i >= text.length) return sleep(SETTLE_MS).then(resolve);
          input.value += text.charAt(i++);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          placeCaret();
          setTimeout(next, TYPE_MS);
        })();
      });
    });
  }

  /** Types a place into the route's add-row search and picks the first hit,
   *  then waits for the row to land. `n` is how many rows that makes. */
  function addPlace(query, n) {
    // Both places on screen first, or the typed search — restricted to the
    // visible map — answers "no matches on screen". Once is enough; the
    // second call is a no-op on a map already showing the box.
    if (window.TBBuilder && window.TBBuilder.fitTo) {
      try {
        window.TBBuilder.fitTo(DEMO.box);
      } catch (e) {
        /* the search may still find it */
      }
    }
    var input = anchor(".add-row .add-search");
    if (!input) return Promise.resolve();
    return sleep(SETTLE_MS)
      .then(function () {
        return typeInto(input, query);
      })
      .then(function () {
        return until(function () {
          var list = document.getElementById("search-results");
          return !!(list && !list.hidden && list.querySelector("li.hit-google, li.hit-saved"));
        }, 6000);
      })
      .then(function (found) {
        hideCaret();
        if (!found) return;
        var list = document.getElementById("search-results");
        var li = list && list.querySelector("li.hit-google, li.hit-saved");
        if (!li) return;
        li.click();
        return until(function () {
          return document.querySelectorAll("#route-list .point-row").length >= n;
        }, 8000).then(function () {
          return sleep(SETTLE_MS);
        });
      });
  }

  /** The coming Saturday at 09:00, as a `datetime-local` value — a wall clock,
   *  which is what the builder stores (see route-clock.js). */
  function nextSaturdayAtNine() {
    var d = new Date();
    d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
    var pad = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T09:00";
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
    tour.on("show", function (e) {
      var i = tour.steps.indexOf(e.step);
      backward = i < lastIndex;
      lastIndex = i;
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
   * **THE TOUR RUNS ON A BLANK RIDE AND NOWHERE ELSE.** Ziad's call,
   * 2026-09-11. Part 1 asks the rider to name the ride, add a first point and
   * add a second, and all three waits are predicates over what is on screen —
   * so on a stored ride they are satisfied before the card is drawn, and a
   * tour that skips its own three teaching steps is the tour not running.
   * `/builder` IS the fresh ride and `/builder/:id` is a stored one, so the
   * path is the whole test — read at the moment it is asked rather than kept,
   * because the first pin replaces it with `/builder/<id>` (the replaceState
   * in builder.js) and the ride stops being blank at exactly that moment.
   */
  function blankRide() {
    return window.location.pathname.replace(/\/+$/, "") === "/builder";
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
    // **`?tour` ON A STORED RIDE OPENS A FRESH ONE RATHER THAN REFUSING**: the
    // query is somebody explicitly asking for the tour, and the blank ride it
    // needs is one navigation away. Nothing in the app links it that way — the
    // menu's href is `/builder?tour` on every surface — so this is the
    // hand-typed URL, and the bookmark of one.
    if (asked && !blankRide()) {
      window.location.replace("/builder?tour");
      return;
    }
    if (asked && window.history.replaceState) {
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    }
    var isNew = asked || document.documentElement.getAttribute("data-tour") === "new";
    // The unasked start is gated the same way, and this is the door the rule
    // arrived through: `data-tour="new"` is stamped on EVERY page for a rider
    // who has never been offered the tour, so a new rider whose first act is
    // opening an imported ride had the tour start on top of it. It is not
    // taken away from them — the next fresh builder offers it, which is where
    // it can actually be followed.
    if (isNew && blankRide()) start();
  }

  // The three part buttons on the welcome and closing cards.
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("[data-tour-part]") : null;
    if (!b || !tour || !tour.isActive()) return;
    jump(Number(b.getAttribute("data-tour-part")));
  });

  // **Take the tour STARTS IN PLACE ONLY ON A BLANK RIDE, AND THAT REVERSES
  // THE RECORDED CALL.** It used to start in place wherever it was pressed, on
  // the reasoning that a rider wanting a reminder on the ride in front of them
  // should get one there. What that produced is the thing this file is built
  // around: the ride already has a name and points, so part 1's three waits
  // are met before their cards are drawn and the tour skips the three steps a
  // rider took it for. On a blank builder starting in place is identical to
  // navigating and costs no page load, so the interception survives for
  // exactly that case; everywhere else the click falls through to the link's
  // own `/builder?tour`. The item is a real link either way, so with Shepherd
  // missing the navigation still happens and the fresh ride's own boot() gets
  // a second chance at the CDN.
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("[data-tour-start]") : null;
    if (!b || !Shepherd || !blankRide()) return;
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
    PARTS: PARTS,
    // The live Shepherd tour, for the console and for nothing in the app.
    get tour() {
      return tour;
    },
  };
})();
