// Show me around — the guided tour. #133, and the real one as of 2026-09-11.
//
// **AN INSTRUCTIONAL VIDEO ABOUT A PLANNING SESSION, THE SAME EVERY TIME.**
// Ziad's call, 2026-09-11. A new rider watches one story unfold — a coast run
// out of Oakland with three friends — and the only thing they press is Next,
// Back, or Skip. Everything else is demonstrated: a flashing cursor types into
// the real fields, the road draws, a shaping point is dragged onto another
// highway, a start time lands, a second group is added, three riders arrive
// on the roster, a fuel ring runs dry and a gas stop fixes it, a meeting point
// is proposed and taken, a group splits off. Five parts, about thirty cards.
//
// **EVERYTHING IS CANNED AND NOTHING IS ROUTED LIVE.** The ride was planned
// once by utils/build-tour-ride.ts, the routing calls were made once, and the
// result is public/tour/coast-run.json: thirteen KEYFRAMES, each a whole ride
// payload, plus the recorded meeting-point proposal. Every demonstrating step
// does its typing for show and then hands the next frame to
// `TBBuilder.apply()`, which loads it through the builder's own load path and
// saves it through the ordinary PUT. Zero Google spend per run; the cursor
// still types into the search box, because watching the search work is the
// point, but no `input` event is dispatched into a box that would call
// Google on it.
//
// **THE RIDE IS REAL AND IT IS BINNED AT THE END.** POST /api/tour/start makes
// it (and the three guide riders, the first time), and /api/tour/done bins it
// on Finish and on the X. What the rider takes away is the knowledge, not a
// ride called Coast run they never planned.
//
// **IT FOLLOWS THE RIDER ACROSS PAGES.** The roster lives on the ride's page,
// the paddock on /profile, friends on /riders, and the share link on the
// viewer, so a step carries a `page` and showing one that is not this page
// saves where the tour is in sessionStorage, settles the builder, and
// navigates; the next page's boot() resumes at that step. The saved position
// is trusted ONLY when `<html data-tour-ride>` — the session's own record of
// which ride the tour is building — names the same ride, so a tour that ended
// on another tab, or somebody else signing in on this one, is dropped rather
// than followed into a 404.
//
// **A DEMONSTRATION WATCHES THE DOM AND CALLS `TBBuilder`, NEVER `state`.** The
// hooks in builder.js are the one door: apply, settled, showMeet, openSplit,
// setMoment, project, and fitTo. The tour reads its results off what is on
// screen or off its own record of which frame it last applied.
//
// **SHEPHERD ARRIVES AS A MODULE AND THIS FILE IS NOT ONE.** See the note in
// routes/builder.ts and views/tour-assets.ts: a `<link rel="modulepreload">`
// carries the integrity hash and this file `import()`s its href after load.
// If the CDN fails the tour is absent and every page is untouched.
(function () {
  "use strict";

  var START_URL = "/api/tour/start";
  var DONE_URL = "/api/tour/done";
  var FIXTURE_URL = "/tour/coast-run.json";
  var STORE_KEY = "routeloop.tour";
  // How far right an attached card is pushed on a desktop — see build().
  var DESKTOP_NUDGE_PX = 20;

  // Typing rhythm: per character, the cursor blinking alone before the first
  // one, and a beat after the last so the word is read before anything moves.
  // TYPE_LEAD_MS is the pause before the first character; CARET_LEAD_MS is
  // the pointer's, before a press, and stays longer because a press is one
  // moment where typing is many. The first few cards were measured at 2.3s,
  // 3.8s and 5.3s on 2026-09-13 and most of it was pauses, not letters.
  var TYPE_MS = 45;
  var TYPE_LEAD_MS = 400;
  var CARET_LEAD_MS = 700;
  var SETTLE_MS = 400;
  // True while the camera sits on the story's box from a search; any fit
  // that frames the whole ride clears it.
  var boxHeld = false;
  // How long a demonstration gets before the card gives up and offers Next
  // anyway. A frame is one save; the split is a save and two writes.
  var DEMO_TIMEOUT_MS = 20000;

  // The keyframes, in story order. A step names the one it lands on, and
  // "done" for a demonstrating step is "that frame, or a later one, has been
  // applied" — kept in the saved position rather than read off the DOM,
  // because thirteen predicates over the route list would each be a second
  // description of what a frame contains.
  // What the ride is called before the first card names it — TOUR_SEED.title
  // in src/tour/seed.ts, pinned by test/tips.test.ts.
  var SEED_TITLE = "Untitled ride";

  var FRAMES = [
    "named",
    "point2",
    "point3",
    "point4",
    "via",
    "category",
    "dwell",
    "start",
    "bed",
    "gas",
    "group",
    "meet",
    "split",
  ];

  // What the cursor types, for show, into the boxes that would otherwise call
  // Google. Curly apostrophe on purpose — the quote sweep would curl it anyway.
  var TYPED = {
    name: "Coast run",
    alices: "Alice’s Restaurant, Woodside",
    pescadero: "Pescadero",
    santaCruz: "Santa Cruz",
    groupName: "Livermore crew",
    groupStart: "Livermore",
    splitName: "Heading home",
    splitDest: "Redwood City",
  };

  // ——— The parts ———
  //
  // **FIVE PARTS A RIDER CAN TAKE IN ANY ORDER OR SKIP AT WILL.** Every card
  // carries Skip this part beside Next, the welcome and closing cards offer the
  // parts as buttons, and `jump()` is the one way between them. Fuel comes
  // before the people (Ziad's call, 2026-09-12: the ring is already on the
  // map by the clock, so it is explained next rather than two parts later)
  // and before the meet on purpose: the proposer only offers a meeting point
  // a group can reach on the tank it leaves with.
  var PARTS = [
    {
      n: 1,
      name: "Route",
      blurb:
        "A <b>route</b> generally represents a day of riding (unless it’s a feeder route to a meeting point). Multiple routes together make up a complete <b>ride</b>.",
    },
    { n: 2, name: "Clock", blurb: "A start time, the arrival at every point, and the scrubber along the map." },
    {
      n: 3,
      name: "Fuel",
      blurb: "The paddock, a group’s range ring, where the first tank runs dry, and the fuel stop that fixes it.",
    },
    { n: 4, name: "People", blurb: "Groups, the roster, who rides which route, and where friends come from." },
    { n: 5, name: "Meet", blurb: "Where two groups meet, one group heading home early, and sharing the ride." },
  ];

  // ——— The steps ———
  //
  // `at` is a data-tip key, a CSS selector (leading `.` or `#`), or a function
  // returning the element; null centers the card. `nth` picks the nth visible
  // match. `page` is which page the step lives on (builder when absent). `tab`
  // is a panel tab to open first. `demo` is an async function that does the
  // step's thing in front of the rider; `frame` is the keyframe it lands on
  // and doubles as its "already done" test; `running` is the status line shown
  // in place of Next until it settles. `needs` is a frame applied silently
  // before a card that assumes it — an intro reached by Skip, or a card the
  // rider comes back to the builder for. `then` is where the spotlight moves
  // once the demonstration has landed: a card about adding a point starts on
  // the search box and ends on the row the point became, or the rider is left
  // looking at a lit search box under a row that appeared by itself. `press`
  // is a control clicked before the anchor resolves, for a card pinned to
  // something that only exists once a button has been pressed — a menu.
  // `open` is a list of <details> opened before the card and closed after.
  // `prep` runs after the reset and before the anchor resolves, for a plain
  // card about something a reset clears.
  var STEPS = [
    {
      id: "welcome",
      title: "This is where a ride gets planned",
      text: "Five short parts—skip whatever you don’t care about. The <b>ride</b> you are about to see is just an example and goes in the bin when you are done.",
      chooser: true,
    },

    // ——— Part 1: the route ———
    {
      id: "name",
      part: 1,
      at: "ride-name",
      title: "Name your ride",
      text: "Click the title, type a name, press Enter. Let me name this one.",
      running: "Typing a name…",
      frame: "named",
      demo: function () {
        var t = document.getElementById("ride-title");
        if (!t) return apply("named");
        return typeInto(t, TYPED.name).then(function () {
          t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          t.dispatchEvent(new Event("change", { bubbles: true }));
          return apply("named");
        });
      },
    },
    {
      id: "panel",
      part: 1,
      at: "#info-panel",
      side: "right",
      title: "This is the builder",
      text: "Your routes, every point on them, how long you stop, when you leave. The order of the list is the order you ride, and the map draws it.",
    },
    {
      id: "vocabulary",
      part: 1,
      at: ".route-section",
      side: "right",
      title: "Points → Legs → Routes → Ride",
      text: "A point is a location on a map. Two points make a leg, a series of points with a start and finish make a route, and a collection of routes makes up a complete ride.",
    },
    {
      id: "route",
      part: 1,
      at: ".route-head",
      title: "A route has a name, color, and start time",
      text: "A route is one stretch of the ride, usually a day. It has a name, a color on the map, and its own start time.",
    },
    {
      id: "first-point",
      part: 1,
      at: ".point-row",
      title: "Every route starts somewhere",
      text: "The first point is where you set off—here, Jack London Square in Oakland. Type a place into the box below it, or press + Point and click the map.",
    },
    {
      id: "second-point",
      part: 1,
      at: ".add-row",
      extra: ["#map"],
      title: "Add a second, and a route line appears",
      text: "A restaurant on Skyline, typed into the search. The moment it lands a line is drawn between the two.",
      running: "Finding a place…",
      frame: "point2",
      fits: true,
      then: function () {
        return rowNamed("Alice");
      },
      demo: function () {
        return typeSearch(TYPED.alices).then(function () {
          return apply("point2", { fit: false });
        });
      },
    },
    {
      id: "more-points",
      part: 1,
      at: ".add-row",
      extra: ["#map"],
      title: "Then the coast, then the far end",
      text: "Pescadero for lunch, Santa Cruz to finish. New points go at the bottom; drag one in the list and the route line is redrawn.",
      running: "Finding two more…",
      frame: "point4",
      fits: true,
      then: function () {
        return rowNamed("Santa Cruz");
      },
      demo: function () {
        return typeSearch(TYPED.pescadero)
          .then(function () {
            return apply("point3", { fit: false });
          })
          .then(function () {
            return typeSearch(TYPED.santaCruz);
          })
          .then(function () {
            return apply("point4", { fit: false });
          });
      },
    },
    {
      id: "leg",
      part: 1,
      at: "totals-ride",
      side: "bottom",
      title: "Ride totals and stats",
      text: "Distance, riding time, and how twisty the road is, worked out from the route itself. Change the route and these follow.",
    },
    {
      id: "via",
      part: 1,
      // The map until the demonstration has framed the drag, then the patch
      // of map the drag crosses — `.tour-spot`, a box slideOntoVia() lays
      // over it — so the spotlight guides the eye to the road being moved
      // rather than to the whole map. Ziad's call, 2026-09-12.
      at: function () {
        return document.querySelector(".tour-spot") || document.getElementById("map");
      },
      side: "left",
      title: "The route line can be dragged onto a better road",
      text: "The router took Highway 1. Dragging the line onto another road—inland through Big Basin—redraws the leg through that spot. Watch.",
      running: "Dragging the road…",
      frame: "via",
      // The demonstration frames the drag itself, and the frame must not
      // refit the map afterwards: the spotlight box is in screen pixels.
      fits: true,
      demo: function () {
        return slideOntoVia().then(function () {
          return apply("via", { fit: false });
        });
      },
    },
    {
      id: "via-row",
      part: 1,
      at: ".via-row",
      title: "A shaping point is not a stop",
      text: "That is a shaping point: it bends the leg without being a stop, so it gets a line in the list with no number and no time. Delete it and the leg goes back to the router’s choice.",
    },
    {
      id: "category",
      part: 1,
      at: ".point-row",
      nth: 3,
      title: "Give a stop a raison d’être (or four)",
      text: "The icon next to a point says what it’s for—fuel, food, drinks, a bed, or what the hell, all four. Tagging a place makes it a numbered stop, and gas is the one that matters most: it is how the builder knows where you fill up.",
      running: "Picking a category…",
      frame: "category",
      // The picker is opened, scrolled through and back so the rider sees
      // how many kinds there are, and it STAYS OPEN until Next: the frame's
      // re-render closes it (state.rolesOpen is cleared on every render), so
      // `hold` reopens it after the frame and after any later re-render.
      // Ziad's call, 2026-09-12.
      demo: function () {
        var step = this;
        return pressRoles(3)
          .then(function () {
            // From here the list watcher reopens the picker inside the same
            // task as any re-render that closes it, so no closed state is
            // ever painted — reopening after apply() resolved blinked.
            step.holding = true;
            return scrollThrough(anchor(".row-roles"), 900);
          })
          .then(function () {
            return apply("category");
          });
      },
      hold: function () {
        holdRoles(3);
      },
      release: function () {
        this.holding = false;
        if (anchor(".row-roles")) {
          var b = anchor("row-roles", 3);
          if (b) b.click();
        }
      },
    },
    {
      id: "dwell",
      part: 1,
      // Both rows the demonstration types into, as one spotlight — the
      // second field typed behind the backdrop when only the first was lit.
      at: function () {
        return document.querySelector(".tour-spot") || anchor("row-dur", 3);
      },
      title: "Stops take time, and the builder knows it",
      text: "Type how long you are off the bike. Forty-five minutes at Pescadero, thirty at Alice’s. Everything after a stop moves later.",
      running: "Typing the stops…",
      frame: "dwell",
      demo: function () {
        spotlightOver([rowNamed("Alice"), rowNamed("Pescadero")], 4);
        return typeSilently(anchor("row-dur", 3), "45")
          .then(function () {
            return typeSilently(anchor("row-dur", 2), "30");
          })
          .then(function () {
            return apply("dwell");
          });
      },
    },
    {
      id: "menu",
      part: 1,
      // The menu itself, opened by pressing the dots first — a card about
      // what is behind them shows what is behind them. Ziad's call, 2026-09-12.
      // The menu alone: a second cut-out for the dots overlaps this one by
      // the overlay padding, and the overlap paints as a dim strip.
      at: ".row-menu",
      press: "route-menu",
      side: "right",
      title: "Everything else is behind the dots",
      text: "The three dots hold the rest: duplicate or reverse a route, split it at a stop, offer it for a vote, and on a point, notes only you can see.",
    },

    // ——— Part 2: the clock ———
    //
    // **AN INTERSTITIAL OPENS EACH PART AFTER THE FIRST.** Ziad's call,
    // 2026-09-11: a rider finishing one part is told the subject has changed
    // before the next control is pointed at. The welcome card does this job
    // for part 1. `intro` centers the card, drops the counter from the part
    // line and labels Next "Start part N"; `jump()` lands on it too. `needs`
    // is what a rider who skipped here sees: the ride as the previous part
    // left it, applied silently.
    {
      id: "intro-2",
      part: 2,
      intro: true,
      needs: "dwell",
      title: "Next: the clock",
      text: "Part 1 gave the ride a route. This part gives it a clock: set one start time and every arrival, the end, and a slider along the map follow from it.",
    },
    {
      id: "when",
      part: 2,
      at: ".route-start",
      title: "Give the route a start time",
      text: "Pick the day and hour you set off. Every point gets an arrival time and a slider appears under the map. Saturday at nine.",
      running: "Setting a start time…",
      frame: "start",
      demo: function () {
        var el = anchor(".route-start");
        if (el) {
          showCaret(el);
          el.value = nextSaturdayAtNine();
        }
        return sleep(CARET_LEAD_MS + SETTLE_MS).then(function () {
          hideCaret();
          return apply("start");
        });
      },
    },
    {
      id: "timeline",
      part: 2,
      // The whole map is the spotlight, the bar included, and it stays live:
      // this is the one card where the rider is invited to touch the thing —
      // after the demonstration has run it through once. Pinned to the map
      // rather than the bar because the bar lies INSIDE the map's box, and
      // two overlapping cut-outs paint the overlap dark. Ziad's call,
      // 2026-09-12. The card sits at the bar's left end — `tour-over-bar` in
      // _tour.scss — so it covers as little of the map as it can.
      at: "#map",
      clickable: true,
      classes: "tour-over-bar",
      title: "This is the time scrubber",
      text: "Drag it and the dot on the map is where you would be at that moment. Try it. On a ride with several routes the Route | Ride switch runs it over one day or the whole trip. The ring around the dot is fuel—next part.",
      running: "Riding it through…",
      // A scrub is worth watching twice, so Back re-runs it.
      done: function () {
        return false;
      },
      demo: function () {
        return scrub(0, 1, 3200);
      },
    },
    {
      id: "route-end",
      part: 2,
      at: "route-end",
      title: "The end is worked out for you",
      text: "Start time plus the riding plus every stop. Type over it if you know better, or clear it to hand it back.",
    },
    {
      id: "bed",
      part: 2,
      at: "ride-stop-by",
      title: "When to start looking for a place to stop for the night",
      text: "Set an hour here and any route still going at that time gets a band across its list where it reaches it. Advice, not a limit. Four o’clock; this run is home by two, so no band.",
      running: "Setting the hour…",
      frame: "bed",
      demo: function () {
        var el = document.getElementById("ride-stop-by");
        if (el) {
          showCaret(el);
          el.value = "16:00";
        }
        return sleep(CARET_LEAD_MS + SETTLE_MS).then(function () {
          hideCaret();
          return apply("bed");
        });
      },
    },

    // ——— Part 3: fuel ———
    {
      id: "intro-3",
      part: 3,
      intro: true,
      needs: "bed",
      title: "Next: fuel",
      text: "Every bike has a tank, and the builder plans around the smallest one on the ride. This part is the ring that shows how far it reaches, the mark where it runs dry, and the fuel stop that fixes it.",
    },
    {
      id: "to-paddock",
      part: 3,
      // How you get there, before the tour goes there: the header menu, then
      // your name, then My Account. Both disclosures are opened for the card and
      // closed after it. Ziad's call, 2026-09-12.
      open: [".site-menu", ".nav-account"],
      at: function () {
        return document.querySelector('.nav-account a[href="/account"]');
      },
      side: "bottom",
      title: "Your bikes live on your account",
      text: "The menu, then your name, then My Account: the Paddock tab is where your bikes are. A bike’s range is typed there once and read everywhere. Let me open it.",
    },
    {
      id: "paddock",
      part: 3,
      page: "profile",
      at: "#paddock",
      title: "The paddock: your bikes and their range",
      text: "A name and a range is all a bike needs; that range is what the fuel planning reads. On this ride the guides’ bikes count: Sam’s KTM at 200 miles, Priya’s Triumph at 190, Diego’s Ducati at 120—the tank the ride is planned around.",
      running: "Adding a bike…",
      // A REAL BIKE, FOR THE LENGTH OF THE CARD. The add goes through the
      // paddock's own button, so the rider sees the row appear; the range is
      // typed for show. The bike is deleted the moment the card is left —
      // the paddock is theirs and the tour adds nothing to it that lasts.
      // Ziad's call, 2026-09-12. `done` is never true, so Back re-runs it
      // against whatever the page holds.
      done: function () {
        return false;
      },
      demo: function () {
        return addTourBike();
      },
      release: function () {
        dropTourBike();
      },
    },
    {
      id: "ring",
      part: 3,
      // The map, lit, with the bar inside it and left live — the scrubber
      // card's arrangement. The demonstration scrubs out to the dry mark at
      // once; after that the rider can scrub as they like. Ziad's call,
      // 2026-09-12, merging the ring card and the run-dry card.
      at: "#map",
      clickable: true,
      classes: "tour-over-bar",
      title: "The range ring, and where it runs dry",
      text: "The dotted ring is how far the smallest tank reaches—green, then orange, then red. Diego’s 120 miles run out in the redwoods, twenty miles short of Santa Cruz: the red E, and the route past it painted red. Scrub it yourself; the Range button turns the overlay off.",
      running: "Riding out to the mark…",
      done: function () {
        return false;
      },
      demo: function () {
        return scrub(0, 0.88, 2600);
      },
    },
    {
      id: "gas",
      part: 3,
      at: ".point-row",
      nth: 3,
      title: "A fuel stop fixes it",
      text: "Pescadero has a station, so tag that row Gas. The tank—or the battery—starts over from there and the E goes. With nothing in reach, the Gas chip under a route searches along the route.",
      running: "Adding a gas stop…",
      frame: "gas",
      demo: function () {
        return pressRoles(3).then(function () {
          return apply("gas");
        });
      },
    },

    // ——— Part 4: the people ———
    {
      id: "intro-4",
      part: 4,
      intro: true,
      needs: "gas",
      title: "Next: the people",
      text: "This part is the people: groups for riders who set off from different places, the roster of who is coming, and which route each of them is on. Three riders are about to join.",
    },
    {
      id: "groups",
      part: 4,
      at: "#tab-groups",
      tab: "tab-groups",
      side: "bottom",
      title: "Groups are where riders set off from",
      text: "Every ride starts with one group—yours. The first in the list is the main group: its route is the one everybody else joins. Drag another above it to hand that over.",
    },
    {
      id: "groups-add",
      part: 4,
      at: "#sg-add",
      tab: "tab-groups",
      title: "Add a group for riders starting somewhere else",
      text: "Name a group and say where it sets off from. Two friends are coming over from Livermore, so they get a group and a route of their own.",
      running: "Adding a group…",
      frame: "group",
      demo: function () {
        return typeSilently(document.getElementById("sg-new-name"), TYPED.groupName)
          .then(function () {
            return typeSilently(document.getElementById("sg-new-start"), TYPED.groupStart);
          })
          .then(function () {
            return apply("group");
          });
      },
    },
    {
      id: "to-roster",
      part: 4,
      // How you get to the ride's own page before the tour goes there: the
      // Riders tab's link at the bottom. Ziad's call, 2026-09-12.
      tab: "tab-riders",
      at: function () {
        return document.querySelector('#riders-body .tab-actions a[href$="/riders"]');
      },
      // The tab itself is lit too, so the rider sees which tab this is.
      extra: ["#tab-riders"],
      side: "right",
      title: "The ride has a page of its own",
      text: "The Riders tab is the plan’s view of who is coming. Roster opens the ride’s own page, where riders are invited and say whether they are in. Let me open it.",
    },
    {
      id: "roster",
      part: 4,
      page: "roster",
      at: ".roster-list",
      title: "The roster: who is coming",
      text: "The ride’s own page, and everybody on it. Sam, Priya, and Diego exist for this tour and are on every tour ride. Each rider says whether they are in and which bike they are bringing.",
    },
    {
      id: "roster-invite",
      part: 4,
      page: "roster",
      at: ".roster-invite",
      title: "Adding a rider",
      text: "Riders are added here, and only friends—no links, no email addresses. Pick one, choose what they may do to the ride, press Add.",
    },
    {
      id: "riders-tab",
      part: 4,
      at: "#tab-riders",
      tab: "tab-riders",
      side: "bottom",
      needs: "group",
      title: "The same people, in the builder",
      text: "The roster as the plan sees it. Sam and Priya go in the Livermore crew; Diego rides out of Oakland with you. Their bikes’ ranges drive the fuel warnings, and the smallest tank counts.",
      running: "Putting riders in their groups…",
      done: function () {
        var p = progress();
        return !!(p && p.members);
      },
      demo: function () {
        return assignMembers();
      },
    },
    {
      id: "riders-routes",
      part: 4,
      at: "route-groups",
      tab: "tab-routes",
      title: "Who rides which route",
      text: "This pill says who is on the route. Leave it alone and everybody rides everything; tick a group to say who joins or peels off here. Part 5 does this for real.",
    },
    {
      id: "friends",
      part: 4,
      page: "riders",
      at: ".page-tabs",
      title: "Where friends come from",
      text: "Every rider on Routeloop is listed here by handle, and a friend request is one press. Until they accept, they cannot be put on a ride.",
    },

    // ——— Part 5: meet and split ———
    {
      id: "intro-5",
      part: 5,
      intro: true,
      needs: "group",
      title: "Next: meet and split",
      text: "Two groups from two towns want one route together. This part asks the builder where to meet, takes its answer, sends one rider home early, and ends on the page you share.",
    },
    {
      id: "meet-find",
      part: 5,
      at: "#sg-meet-all",
      tab: "tab-groups",
      title: "Find meeting points",
      text: "One press and the builder walks the main group’s route for gas stations every other group can reach on their tank, weighs riding together sooner against the extra detour it costs, and offers the best options.",
      running: "Working out where to meet…",
      done: function () {
        return !!document.querySelector(".sg-take");
      },
      demo: function () {
        var btn = document.getElementById("sg-meet-all");
        if (btn) showCaret(btn);
        return sleep(CARET_LEAD_MS)
          .then(fixture)
          .then(function (fx) {
            hideCaret();
            if (window.TBBuilder && window.TBBuilder.showMeet) window.TBBuilder.showMeet(fx.meet);
            return sleep(SETTLE_MS);
          });
      },
    },
    {
      id: "meet-options",
      part: 5,
      at: "#sg-meet-out",
      // The map too: the candidates are numbered dots on it and each one's
      // feeder route is drawn from Livermore, so the list and the picture
      // are lit together. Ziad's call, 2026-09-12.
      extra: ["#map"],
      tab: "tab-groups",
      side: "right",
      // Reached by Back from a taken meet, the reset has cleared the
      // proposal this card is about; draw it again first. Either way the
      // map is framed on the feeder routes and the candidates.
      prep: function () {
        return fixture().then(function (fx) {
          var B = window.TBBuilder;
          if (B && B.showMeet && !document.querySelector(".sg-take")) B.showMeet(fx.meet);
          var pts = [];
          (fx.meet.groups || []).forEach(function (g) {
            (g.candidates || []).forEach(function (c) {
              pts.push([c.lng, c.lat]);
              (c.approach || []).forEach(function (q) {
                pts.push(q);
              });
            });
          });
          if (B && B.fitTo && pts.length) {
            try {
              B.fitTo(pts);
            } catch (e) {
              /* the card shows either way */
            }
          }
        });
      },
      title: "The options",
      text: "Each one is a real station on the main group’s route: how far out of their way the joining group comes, and how much of the ride is left to ride together. The first is the best trade between the two; the dots on the map are the same list.",
    },
    {
      id: "meet-take",
      part: 5,
      at: ".sg-take",
      tab: "tab-groups",
      title: "Take one",
      text: "A Chevron in Hayward, with the Livermore crew three miles out of their way. Taking it puts the station on both routes, cuts the main route there, and sets the Livermore departure so both groups arrive together.",
      running: "Taking the first one…",
      frame: "meet",
      // The Take button is gone once it has been pressed; the spotlight
      // moves to the map, where the three routes it made are drawn.
      then: function () {
        return document.getElementById("map");
      },
      demo: function () {
        // On Back the reset put the ride back to the gas frame, which clears
        // the proposal this card points at; draw it again and re-pin first.
        var shown = document.querySelector(".sg-take")
          ? Promise.resolve()
          : fixture().then(function (fx) {
              if (window.TBBuilder && window.TBBuilder.showMeet) window.TBBuilder.showMeet(fx.meet);
              repinCurrent();
            });
        return shown.then(function () {
          var btn = document.querySelector(".sg-take");
          if (btn) showCaret(btn);
          return sleep(CARET_LEAD_MS).then(function () {
            hideCaret();
            return apply("meet");
          });
        });
      },
    },
    {
      id: "meet-result",
      part: 5,
      // The whole list, which is the subject — and a node the re-renders
      // that follow the meet's save never replace, so the card holds still.
      // Pinned to the first route head it was rebuilt on every re-render and
      // scrolled the panel each time. The routes are folded for the card so
      // all three headers are in view — open, the third sat below the fold
      // and the card said three over a panel showing two — and unfolded on
      // the way out, since the split card needs a row in the third one.
      at: "#route-list",
      side: "right",
      tab: "tab-routes",
      prep: function () {
        foldRoutes();
        // The card sits over the left of the map, where the meet frame's
        // fit put the Chevron; refit with that strip excluded so the three
        // routes and the meeting point are all clear of it.
        return fixture().then(function (fx) {
          var pts = [];
          (fx.frames.meet.routes || []).forEach(function (route) {
            (route.legs || []).forEach(function (l) {
              (l.geometry || []).forEach(function (q) {
                pts.push(q);
              });
            });
          });
          fitClearOfCard(pts);
        });
      },
      release: function () {
        unfoldRoutes();
      },
      title: "Three routes where there was one",
      text: "Oakland to the Chevron, Livermore to the Chevron—leaving twenty-one minutes earlier—and one shared route from there to Santa Cruz. A group’s own route followed by a shared one is what a meet is.",
    },
    {
      id: "split",
      part: 5,
      at: function () {
        return rowNamed("Pescadero");
      },
      tab: "tab-routes",
      title: "Somebody heads home early",
      text: "Diego turns for home at Pescadero. Split a group off here on the row menu asks who is leaving and where to, cuts the shared route there, and gives them a route of their own.",
      running: "Splitting a group off…",
      frame: "split",
      demo: function () {
        return splitOff();
      },
    },
    {
      id: "splitoff-row",
      part: 5,
      at: ".row-splitoff",
      tab: "tab-routes",
      title: "And the list says so",
      text: "The last point of the route they left names the group and where they went; press it to jump to their route. The roadbook and each rider’s export follow this.",
    },
    {
      id: "share",
      part: 5,
      page: "viewer",
      at: ".qr-share",
      title: "This is the page you share",
      text: "The ride as everybody else sees it. Its address is the share link, and the QR code opens it from a phone. Who can open it is the visibility setting in the builder.",
    },
    {
      id: "exports",
      part: 5,
      page: "viewer",
      at: ".route-table",
      title: "Take it with you",
      text: "Each route can go to Google Maps for turn-by-turn, print as a roadbook, or download in six formats. Every rider gets the routes they are on—Diego’s file ends at Redwood City.",
    },

    {
      id: "done",
      page: "viewer",
      title: "That is the whole idea",
      text: "A route, a clock, the people, fuel, and where to meet. Done bins this ride; everything you plan from here is yours. Point at any control and it tells you what it is for. Have a good ride.",
      chooser: true,
    },
  ];

  var tour = null;
  var Shepherd = null;
  var lastIndex = -1;
  var backward = false;

  // ——— Anchors ———

  /** The element a step attaches to, resolved at show time because the route
   *  list is re-rendered on every edit and a reference taken earlier is a
   *  reference to a node that no longer exists. `nth` is 1-based. */
  function anchor(at, nth) {
    if (!at) return null;
    if (typeof at === "function") return at();
    var sel = /^[.#]/.test(at) ? at : '[data-tip="' + at + '"]';
    // THE nTH VISIBLE MATCH, NOT THE nTH MATCH. The route list renders an
    // `.add-search` inside every collapsed insert slot as well as in the
    // route's own add-row, so `querySelector` answers with a hidden one — and
    // Floating UI positions the card against a zero-size box at the top-left
    // corner while the overlay cuts a hole of nothing.
    var all = document.querySelectorAll(sel);
    var want = nth || 1;
    for (var i = 0; i < all.length; i++) {
      var r = all[i].getBoundingClientRect();
      if (r.width || r.height) {
        if (--want === 0) return all[i];
      }
    }
    return null;
  }

  /** The visible point row whose name is `name`, first match. */
  function rowNamed(name) {
    var rows = document.querySelectorAll("#route-list .point-row");
    var first = null;
    for (var i = 0; i < rows.length; i++) {
      var n = rows[i].querySelector(".row-name");
      var text = n ? n.value : "";
      if (!text || text.trim().indexOf(name) !== 0) continue;
      // A visible one over one in a collapsed route, which has no box.
      var r = rows[i].getBoundingClientRect();
      if (r.width || r.height) return rows[i];
      if (!first) first = rows[i];
    }
    return first;
  }

  // ——— Pages ———

  function currentPage() {
    var p = window.location.pathname.replace(/\/+$/, "");
    if (p === "/builder" || p.indexOf("/builder/") === 0) return "builder";
    if (/^\/m\/[^/]+\/riders$/.test(p)) return "roster";
    if (/^\/m\/[^/]+$/.test(p)) return "viewer";
    if (p === "/riders" || p === "/friends") return "riders";
    // One page at four URLs (#319); the paddock card lands on its own tab.
    if (p === "/account" || p === "/profile" || p === "/settings" || p === "/places" || p === "/paddock")
      return "profile";
    return "";
  }

  var pageOf = function (step) {
    return step.page || "builder";
  };

  function urlFor(page, p) {
    switch (page) {
      case "roster":
        return "/m/" + p.slug + "/riders";
      case "viewer":
        return "/m/" + p.slug;
      case "riders":
        return "/riders";
      case "profile":
        return "/paddock";
      default:
        return "/builder/" + p.rideId;
    }
  }

  /** Whether this page IS the saved position's page for its ride — the
   *  builder on the tour ride, the ride's own pages by slug. */
  function onTourPage(page, p) {
    var path = window.location.pathname.replace(/\/+$/, "");
    if (page === "builder") return path === "/builder/" + p.rideId;
    if (page === "roster" || page === "viewer") return path.indexOf("/m/" + p.slug) === 0;
    return currentPage() === page;
  }

  // ——— The saved position ———
  //
  // `{ rideId, slug, stepId, frame, members }` in sessionStorage: the tab's
  // own, gone when the tab closes, and trusted only against <html
  // data-tour-ride>, which the server stamps from the session's record of
  // which ride the tour is building. Wrapped in try/catch because storage can
  // be absent or throw in a private window, and a tour that cannot save its
  // position still runs on the page it is on.
  function progress() {
    try {
      var raw = window.sessionStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveProgress(p) {
    try {
      window.sessionStorage.setItem(STORE_KEY, JSON.stringify(p));
    } catch (e) {
      /* the tour still runs on this page */
    }
  }

  function clearProgress() {
    try {
      window.sessionStorage.removeItem(STORE_KEY);
    } catch (e) {
      /* nothing to clear */
    }
  }

  function tourRideId() {
    var v = document.documentElement.getAttribute("data-tour-ride");
    return v ? Number(v) : null;
  }

  function valid(p) {
    return !!(p && p.rideId && p.slug && p.rideId === tourRideId());
  }

  function patchProgress(fields) {
    var p = progress();
    if (!p) return;
    for (var k in fields) p[k] = fields[k];
    saveProgress(p);
  }

  // ——— The fixture ———

  var fixturePromise = null;

  /** The fixture, fetched once: legs inflated back into each frame, and every
   *  time shifted from the authoring anchor to the coming Saturday at nine —
   *  the same wall clock `nextSaturdayAtNine()` types into the field, so the
   *  two never disagree. */
  function fixture() {
    if (fixturePromise) return fixturePromise;
    fixturePromise = fetch(FIXTURE_URL, { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("fixture " + r.status);
        return r.json();
      })
      .then(function (fx) {
        var delta = Date.parse(nextSaturdayAtNine() + ":00.000Z") - Date.parse(fx.t0);
        fx.frames = {};
        fx.keyframes.forEach(function (f) {
          var ride = f.ride;
          ride.routes.forEach(function (r) {
            r.legs = r.legs.map(function (l) {
              var src = fx.legs[l.ref];
              return {
                geometry: src.geometry,
                distanceM: src.distanceM,
                durationS: src.durationS,
                viaPoints: l.viaPoints || [],
              };
            });
            if (r.startAt) r.startAt = new Date(Date.parse(r.startAt) + delta).toISOString();
          });
          fx.frames[f.id] = ride;
        });
        // Frame zero is not in the fixture: it is what POST /api/tour/start
        // inserts, and it differs from "named" by the title alone. Derived
        // here so Back from the first card can put the untitled ride back.
        fx.frames.seed = JSON.parse(JSON.stringify(fx.frames.named));
        fx.frames.seed.title = SEED_TITLE;
        return fx;
      });
    return fixturePromise;
  }

  var frameRank = function (id) {
    return FRAMES.indexOf(id);
  };

  /** Whether `id`, or a later frame, has been applied on this ride. */
  function hasFrame(id) {
    var p = progress();
    return !!(p && p.frame && frameRank(p.frame) >= frameRank(id));
  }

  /** Applies a keyframe through the builder and records it. Resolves either
   *  way; a failed apply leaves the card's copy to say what would have
   *  happened, which is the same floor every demonstration has. */
  function apply(id, opts) {
    if (!window.TBBuilder || !window.TBBuilder.apply) return Promise.resolve(false);
    var t0 = t1();
    return fixture()
      .then(function (fx) {
        var ride = fx.frames[id];
        if (!ride) throw new Error("no frame " + id);
        var fit = !(opts && opts.fit === false);
        if (fit) boxHeld = false;
        return window.TBBuilder.apply({ id: id, ride: ride, fit: fit });
      })
      .then(function (ok) {
        // `false` is the builder's saveNow() giving up after three seconds
        // of the ride refusing to settle — twice per frame, so a frame that
        // cannot save is a six-second hole in the tour. Say so.
        if (ok === false) console.warn("[tour] frame " + id + " did not settle: " + (t1() - t0).toFixed(0) + "ms");
        if (ok !== false && (!hasFrame(id) || (opts && opts.force))) patchProgress({ frame: id });
        return ok;
      })
      .catch(function (e) {
        console.warn("[tour] frame " + id + ":", e);
        return false;
      });
  }

  function t1() {
    return performance.now();
  }

  /** The frame a card assumes, applied silently when the rider skipped to it. */
  function ensure(id) {
    if (!id || hasFrame(id) || currentPage() !== "builder") return Promise.resolve();
    return apply(id);
  }

  // ——— Ending ———

  /** Finish or Skip: bin the ride, forget the position, and land on the
   *  dashboard — never on a viewer page for a ride that just stopped being
   *  viewable. Settles the builder first so beforeunload has nothing to hold
   *  the rider for. */
  var finishing = false;
  function finish() {
    if (finishing) return;
    finishing = true;
    var p = progress();
    var rideId = p && p.rideId;
    dropTourBike();
    clearProgress();
    document.documentElement.removeAttribute("data-tour");
    hideCaret();
    var settled = window.TBBuilder && window.TBBuilder.settled ? window.TBBuilder.settled() : Promise.resolve();
    Promise.resolve(settled)
      .catch(function () {})
      .then(function () {
        return fetch(DONE_URL, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
          body: JSON.stringify({ rideId: rideId || null }),
        }).catch(function () {});
      })
      .then(function () {
        window.location.assign("/");
      });
  }

  // ——— Parts ———

  function partStart(n) {
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].part === n) return STEPS[i].id;
    return "done";
  }

  function jump(n) {
    tour.show(partStart(n));
  }

  function skipLabel(part) {
    var next = PARTS[part];
    if (!next) return "Exit";
    return "Skip to " + next.name;
  }

  /** A thin red bar along the top edge of the card: how far through the tour
   *  this step is, over every step that shows a card. It replaced "Part 2 of
   *  5 · The Clock · 3 of 4", Ziad's call, 2026-09-12 — two counters on one
   *  line was arithmetic the rider had to do, and a bar is read at a glance.
   *  The chooser cards carry none: the welcome is before the tour and the
   *  close is after it. */
  function progressBar(step) {
    if (step.chooser) return "";
    var shown = STEPS.filter(function (s) {
      return !s.chooser;
    });
    var pct = Math.round(((shown.indexOf(step) + 1) / shown.length) * 100);
    return '<div class="tour-progress" aria-hidden="true"><i style="width:' + pct + '%"></i></div>';
  }

  function chooserHtml() {
    return (
      '<ul class="tour-parts">' +
      PARTS.map(function (p) {
        return (
          '<li><button type="button" class="tour-part-btn" data-tour-part="' +
          p.n +
          '"><i>' +
          p.n +
          "</i><b>" +
          esc(p.name) +
          // The blurb is our own string and may carry <b> around a term.
          "</b><span>" +
          p.blurb +
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

  var stepDone = function (step) {
    if (step.done) return step.done();
    if (step.frame) return hasFrame(step.frame);
    return false;
  };

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
    // "Skip to the clock" rather than "Skip this part": the button names
    // where it lands, so a rider never has to know which part they are in.
    // Past the last part it lands on the closing card.
    if (step.part)
      buttons.push({
        text: skipLabel(step.part),
        classes: "btn btn-quiet",
        action: function () {
          // Past the last part the button says Exit, and it does: the
          // closing card is the reward for finishing, not a place to skip to.
          if (PARTS[step.part]) jump(step.part + 1);
          else tour.complete();
        },
      });
    if (step.demo) {
      buttons.push({ text: step.running, classes: "tour-waiting", disabled: true, action: function () {} });
      // The card carries both a status line and a Next, and `is-satisfied` on
      // the element decides which is drawn — see _tour.scss. Nothing advances
      // on its own: what was demonstrated deserves a look.
      buttons.push({
        text: "Next",
        classes: "btn tour-next-done",
        action: function () {
          tour.next();
        },
      });
    } else {
      buttons.push({
        text: last ? "Done" : step.chooser ? "Start" : step.intro ? "Part " + step.part : "Next",
        // An intro's button wears its part's color — see _tour.scss.
        classes: step.intro ? "btn tour-start" : "btn",
        action: function () {
          if (last) tour.complete();
          else tour.next();
        },
      });
    }

    var opts = {
      id: step.id,
      classes: (step.part ? "tour-part-" + step.part : "") + (step.classes ? " " + step.classes : ""),
      title: step.title,
      text: function () {
        var body = typeof step.text === "function" ? step.text() : step.text;
        return progressBar(step) + "<p>" + body + "</p>" + (step.chooser ? chooserHtml() : "");
      },
      buttons: buttons,
      scrollTo: false,
      cancelIcon: { enabled: true },
      // **A STEP ON ANOTHER PAGE NAVIGATES, AND THE PROMISE NEVER RESOLVES.**
      // The position is saved first so the next page's boot() lands here; the
      // builder is settled so its beforeunload guard has nothing to hold. A
      // step on this page opens its tab, applies what it assumes, and shows.
      beforeShowPromise: function () {
        var page = pageOf(step);
        var p = progress();
        if (page !== currentPage() && valid(p)) {
          p.stepId = step.id;
          saveProgress(p);
          var settled = window.TBBuilder && window.TBBuilder.settled ? window.TBBuilder.settled() : null;
          Promise.resolve(settled)
            .catch(function () {})
            .then(function () {
              window.location.assign(urlFor(page, p));
            });
          return new Promise(function () {});
        }
        if (step.tab) {
          var tab = document.getElementById(step.tab);
          if (tab && tab.getAttribute("aria-selected") !== "true") tab.click();
        }
        // A plain card resets before it is shown, so its anchor resolves
        // against the right rows; a demonstrating one resets inside runDemo,
        // so the card is up while the reset and the demo play out.
        return ensure(step.needs)
          .then(function () {
            return step.demo ? undefined : resetFor(step);
          })
          .then(function () {
            // `prep` puts back something the reset took away and the card
            // is about — a proposal — before the anchor is resolved.
            return step.prep ? step.prep() : undefined;
          })
          .then(function () {
            (step.open || []).forEach(function (sel) {
              var d = document.querySelector(sel);
              if (d) d.open = true;
            });
            if (step.press && !anchor(step.at)) {
              var b = anchor(step.press);
              if (b) b.click();
            }
          })
          .then(function () {
            // A tab filled by a fetch (Riders) may not hold the anchor yet;
            // give it a moment rather than showing a centered card. Only
            // where a tab was opened: elsewhere a missing anchor is a state
            // the demonstration is about to change, not a load in flight.
            // Never on a re-pin after the demonstration: by then the anchor
            // may be gone for good (a taken proposal), and the wait was a
            // three-second hole between the meet landing and the next card.
            return step.tab && !repinning && !stepDone(step) ? awaitAnchor(step, 3000) : undefined;
          });
      },
      when: {
        show: function () {
          keepTabInside(this.getTarget());
          // A re-pin (below) rebuilds the card; skip Shepherd's fade so the
          // rebuilt card lands where the old one was with no flash.
          if (repinning && this.el) this.el.classList.add("tour-repin");
          if (!step.demo) return;
          if (this.el) this.el.classList.remove("is-satisfied");
          // A re-pin — the list re-rendered under a running demonstration,
          // or the demonstration finished and moved the spotlight — must not
          // start it again; that is the one case a satisfied card is shown.
          if (demoStep === step || repinning) {
            if (repinning && stepDone(step) && this.el) this.el.classList.add("is-satisfied");
            return;
          }
          runDemo(step, this);
        },
        hide: function () {
          releaseTab();
          hideCaret();
          clearSpotlight();
          if (step.release) {
            // The release itself re-renders the list, and the watcher must
            // not put the thing straight back.
            releasing = true;
            step.release();
            releasing = false;
          }
          (step.open || []).forEach(function (sel) {
            var d = document.querySelector(sel);
            if (d) d.open = false;
          });
          // What `press` opened, closed on the way out — the button toggles.
          if (step.press && anchor(step.at)) {
            var b = anchor(step.press);
            if (b) b.click();
          }
        },
        cancel: function () {
          releaseTab();
          hideCaret();
          clearSpotlight();
        },
      },
    };

    if (step.extra) opts.extraHighlights = step.extra;
    // The default is false — see build() — and a card that hands the control
    // to the rider says so.
    if (step.clickable) opts.canClickTarget = true;

    if (step.at) {
      opts.attachTo = {
        element: function () {
          // `then` answers once the demonstration is done — and while it is
          // running, for a re-pin after the frame has taken the original
          // target away (the Take button goes with the proposal), so the
          // card moves once, to where it ends up, instead of via the center.
          var el = (step.then && (stepDone(step) || demoStep === step) && step.then()) || anchor(step.at, step.nth);
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
  // Shepherd binds its keyboard handler to the target as well as the card and
  // takes Tab from the last focusable inside it, which on a `datetime-local` is
  // the year-to-hour move. A capture listener registered later still runs
  // first at the target, so stopping the event here keeps it from Shepherd's.
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
  // and the typing loop stops itself the moment it is not.
  var demoStep = null;

  function stillOn(step) {
    return !!(tour && tour.isActive() && tour.getCurrentStep() && tour.getCurrentStep().id === step.id);
  }

  /** **THE SCENE A CARD IS SHOWN AGAINST: THE RIDE AS IT WAS WHEN THE CARD
   *  WAS FIRST REACHED.** For a demonstrating step that is the frame before
   *  its own; for any other step, the frame the last demonstration before it
   *  in the list landed on — or the seed, ahead of the first. */
  function sceneOf(step) {
    if (step.frame) {
      var i = frameRank(step.frame);
      return i > 0 ? FRAMES[i - 1] : "seed";
    }
    for (var j = STEPS.indexOf(step) - 1; j >= 0; j--) if (STEPS[j].frame) return STEPS[j].frame;
    return "seed";
  }

  /** **A CARD DOES THE SAME THING ARRIVED AT FROM EITHER DIRECTION.** Ziad's
   *  call, 2026-09-12. Back used to land on a card already satisfied — the
   *  frame was applied, so it offered Next and showed nothing — where the
   *  rider pressing Back wants to see it again, and a plain card about the
   *  first point was shown over a ride that already had three. So a card
   *  reached with a LATER frame applied puts the ride back to its scene
   *  first (typed name gone, points gone); forward, the ride is already there
   *  and this costs nothing. Only backward: a card reached ahead of its scene
   *  is the `needs` case, handled by ensure(). `force` records the rollback,
   *  or hasFrame() would still say the later frame holds and the card's
   *  anchors would resolve to rows that are no longer on the page. */
  function resetFor(step) {
    if (currentPage() !== "builder") return Promise.resolve();
    var scene = sceneOf(step);
    var p = progress();
    var now = (p && p.frame) || "seed";
    if (frameRank(now) <= frameRank(scene)) return Promise.resolve();
    // A demonstration that frames the map itself (the searches) keeps the
    // camera through the reset, or Back zooms to one point and out again.
    return apply(scene, { force: true, fit: !step.fits });
  }

  function runDemo(step, shepherdStep) {
    demoStep = step;
    var finished = function () {
      hideCaret();
      if (demoStep === step) demoStep = null;
      if (!stillOn(step)) return;
      if (shepherdStep.el) shepherdStep.el.classList.add("is-satisfied");
      // A frame re-renders the list, and the row this card was pinned to may
      // now be a different node, or out of the way of the routes the frame
      // added. Re-showing resolves a fresh target; `repinning` is what stops
      // when.show starting the demonstration a second time.
      var target = step.at ? shepherdStep.getTarget() : null;
      if (step.then || (step.at && (!target || !target.isConnected || !target.getBoundingClientRect().height)))
        repin(shepherdStep);
    };
    var timer = setTimeout(finished, DEMO_TIMEOUT_MS);
    Promise.resolve()
      .then(function () {
        return resetFor(step);
      })
      .then(function () {
        if (!stillOn(step)) return;
        return step.demo();
      })
      .catch(function (e) {
        console.warn("[tour] " + step.id + ":", e);
      })
      .then(function () {
        clearTimeout(timer);
        finished();
      });
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  // ——— Re-pinning ———
  //
  // **A FRAME REPLACES THE ROUTE LIST'S CHILDREN, AND THE CARD IS PINNED TO
  // ONE OF THEM.** renderRoutes() rewrites innerHTML on every edit, so the
  // moment a frame lands the row a card points at is a detached node: the
  // spotlight hole collapses, Floating UI positions the card against a 0×0
  // box at the top-left, and when the demo finally re-shows the card it fades
  // back in from nothing. Seen as "flashing and jumping" between cards 7 and
  // 8, where two frames land in one demonstration.
  //
  // The observer watches the list; the instant it is rewritten while a card
  // is pinned inside it, the card is re-shown — Shepherd resolves the target
  // afresh — with the fade suppressed, all inside the same task, so nothing
  // is painted in between. `repinning` is read by `when.show` above.
  // **COUNTED, NOT TIMED.** This was a boolean cleared on a setTimeout(0),
  // and a beforeShowPromise that took longer than a task — the anchor wait,
  // a tab click — let when.show run with the flag already down: it took the
  // re-pin for a fresh arrival, ran the demonstration again, which reset the
  // ride and re-applied the frame, whose re-render re-pinned, and so on
  // forever, alternating two frames a second. Seen live on "Take one",
  // 2026-09-12. Step.show() returns a promise that settles after _show, so
  // the count comes down exactly when the show it belongs to is over.
  var repinning = 0;

  function repin(shepherdStep) {
    repinning++;
    Promise.resolve(shepherdStep.show())
      .catch(function () {})
      .then(function () {
        repinning--;
      });
  }

  /** Re-pins whatever card is up, for a demonstration that has just put its
   *  own target back on the page. */
  function repinCurrent() {
    var st = tour && tour.isActive() && tour.getCurrentStep();
    if (st && st.options.attachTo) repin(st);
  }

  var releasing = false;

  function awaitAnchor(step, ms) {
    if (!step.at) return Promise.resolve();
    var t0 = performance.now();
    return new Promise(function (resolve) {
      (function poll() {
        if (anchor(step.at, step.nth) || performance.now() - t0 > ms) return resolve();
        setTimeout(poll, 100);
      })();
    });
  }

  /** Folds every open route section, remembering which, so a card about
   *  the list as a whole can show every header; unfoldRoutes() puts them
   *  back. The twirl is a class toggle in builder.js, so this re-renders
   *  nothing. */
  var folded = [];

  // Fit the map to `pts` with the strip under the tour card left empty. The
  // card is anchored to the panel's right edge, over the map, so a plain fit
  // centers the story under it; padding the left by the card's width keeps
  // the road in the part of the map a rider can see.
  function fitClearOfCard(pts) {
    var B = window.TBBuilder;
    if (!B || !B.fitTo || !pts.length) return;
    var card = document.querySelector(".shepherd-element");
    var w = card ? card.getBoundingClientRect().width : 448;
    try {
      B.fitTo(pts, { top: 60, bottom: 60, right: 60, left: w + 80 });
    } catch (e) {
      /* the card shows either way */
    }
  }

  function foldRoutes() {
    folded = [];
    document.querySelectorAll("#route-list .route-section:not(.is-shut)").forEach(function (sec) {
      var b = sec.querySelector(".route-twirl");
      if (!b) return;
      folded.push(sec.dataset.route);
      b.click();
    });
  }

  function unfoldRoutes() {
    folded.forEach(function (r) {
      var sec = document.querySelector('#route-list .route-section.is-shut[data-route="' + r + '"]');
      var b = sec && sec.querySelector(".route-twirl");
      if (b) b.click();
    });
    folded = [];
  }

  function stepById(id) {
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].id === id) return STEPS[i];
    return null;
  }

  // ——— The cursor ———
  //
  // A REAL ELEMENT LAID OVER THE FIELD, not the field's own caret: the native
  // one only draws while the field has focus, and Shepherd holds focus for the
  // card. Placed at the end of the typed text by measuring it in the field's
  // own font, and re-placed after every character.
  var caretEl = null;
  var caretHost = null;

  function caretNode() {
    if (!caretEl) {
      caretEl = document.createElement("span");
      caretEl.className = "tour-caret";
      caretEl.setAttribute("aria-hidden", "true");
      document.body.appendChild(caretEl);
    }
    return caretEl;
  }

  function showCaret(input) {
    caretNode().classList.remove("is-pointer");
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
    x = Math.min(x, r.right - parseFloat(cs.paddingRight) - 2);
    var h = parseFloat(cs.fontSize) * 1.15;
    caretEl.style.left = x + "px";
    caretEl.style.top = r.top + (r.height - h) / 2 + "px";
    caretEl.style.height = h + "px";
  }

  /** The cursor at a page coordinate, for the map — drawn as a pointer
   *  arrow rather than the text caret, whose 2px bar vanishes over tiles.
   *  The arrow's tip is its top-left corner, so it sits on the point. */
  function caretAt(x, y) {
    var el = caretNode();
    caretHost = null;
    el.classList.add("is-pointer");
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.style.height = "";
    el.hidden = false;
  }

  var measureCtx = null;
  function textWidth(input, cs) {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = cs.font || [cs.fontWeight, cs.fontSize, cs.fontFamily].join(" ");
    return input.type === "text" || input.tagName === "TEXTAREA" ? measureCtx.measureText(input.value).width : 0;
  }

  /** Types `text` into `input` one character at a time, with the cursor
   *  leading. `silent` sets the value and dispatches nothing — for a box whose
   *  `input` handler would call Google; the frame that follows is what
   *  actually lands the place. */
  function typeText(target, text, silent) {
    var step = demoStep;
    // `target` is the field, or a function that finds it afresh. The route
    // list is re-rendered under a demonstration more than once — the frame,
    // then the riders reload that follows its save — and a field held by
    // reference is a detached node after the first, so the typing stopped
    // dead and the caret sat in an empty box. Re-resolving each character
    // carries the typed text onto whichever node is live.
    var live = typeof target === "function" ? target : null;
    var input = live ? live() : target;
    if (!input) return Promise.resolve();
    var typed = "";
    var put = function () {
      var el = live ? live() : input;
      if (el && el !== input) {
        input = el;
        showCaret(input);
      }
      if (!input || !input.isConnected) return false;
      input.value = typed;
      if (!silent) input.dispatchEvent(new Event("input", { bubbles: true }));
      placeCaret();
      return true;
    };
    put();
    showCaret(input);
    return sleep(TYPE_LEAD_MS).then(function () {
      var i = 0;
      return new Promise(function (resolve) {
        (function next() {
          if (step && !stillOn(step)) return resolve();
          if (i >= text.length) return sleep(SETTLE_MS).then(resolve);
          typed += text.charAt(i++);
          if (!put() && !live) return resolve();
          setTimeout(next, TYPE_MS);
        })();
      });
    });
  }

  var typeInto = function (input, text) {
    return typeText(input, text, false);
  };
  var typeSilently = function (input, text) {
    return typeText(input, text, true);
  };

  /** Types a place into the active route's add-row search, for show. The map
   *  is fitted to the story's box first, because that is what a rider would
   *  see the search restricted to — and the frame that follows is applied
   *  with `fit: false`, so the camera holds there across cards 7 and 8
   *  instead of zooming to the ride and back out for each search. */
  function typeSearch(query) {
    return fixture().then(function (fx) {
      var input = function () {
        return anchor(".add-row .add-search");
      };
      // The second search of a card finds the camera already on the box —
      // the frame between them was applied with `fit: false` — so the fit
      // is a no-op and the wait for it is skipped; it is still made, in case
      // the rider dragged the map between the two.
      var held = boxHeld;
      if (window.TBBuilder && window.TBBuilder.fitTo && fx.boxes && fx.boxes.peninsula) {
        try {
          window.TBBuilder.fitTo(fx.boxes.peninsula);
          boxHeld = true;
        } catch (e) {
          /* the frame lands either way */
        }
      }
      return sleep(held ? 0 : SETTLE_MS).then(function () {
        return typeSilently(input, query);
      });
    });
  }

  /** Presses the category dot on the nth point row — for real, because opening
   *  the picker costs nothing — then leaves it open for a beat. */
  /** Keeps the nth row's category picker open across re-renders. */
  function holdRoles(nth) {
    if (anchor(".row-roles")) return;
    var b = anchor("row-roles", nth);
    if (b) b.click();
  }

  /** Scrolls a box to the bottom and back to the top, `ms` each way. */
  function scrollThrough(el, ms) {
    if (!el) return Promise.resolve();
    var max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return sleep(SETTLE_MS);
    var ease = function (f) {
      return f < 0.5 ? 2 * f * f : -1 + (4 - 2 * f) * f;
    };
    var leg = function (from, to) {
      var t0 = performance.now();
      return new Promise(function (resolve) {
        (function frame(now) {
          var f = Math.min(1, (now - t0) / ms);
          el.scrollTop = from + (to - from) * ease(f);
          if (f < 1) requestAnimationFrame(frame);
          else resolve();
        })(t0);
      });
    };
    return leg(0, max)
      .then(function () {
        return sleep(300);
      })
      .then(function () {
        return leg(max, 0);
      })
      .then(function () {
        return sleep(SETTLE_MS);
      });
  }

  function pressRoles(nth) {
    var btn = anchor("row-roles", nth);
    if (!btn) return Promise.resolve();
    showCaret(btn);
    return sleep(CARET_LEAD_MS).then(function () {
      hideCaret();
      btn.click();
      return sleep(900);
    });
  }

  /** The cursor sliding across the map from the middle of the last leg to
   *  where the shaping point lands, the way a drag would. */
  /** A box over the map covering both points plus `pad`, for the overlay to
   *  cut its hole around; the card re-pins to it. Removed on hide. */
  function spotlight(a, b, pad, stretch) {
    var el = document.querySelector(".tour-spot");
    if (!el) {
      el = document.createElement("div");
      el.className = "tour-spot";
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);
    }
    var x = Math.min(a[0], b[0]) - pad;
    var y = Math.min(a[1], b[1]) - pad;
    var w = Math.abs(a[0] - b[0]) + pad * 2;
    el.style.left = x + "px";
    el.style.top = y + "px";
    // `stretch` widens to the right — 1.6 on the drag, where the road being
    // dragged onto runs on that side.
    el.style.width = w * (stretch || 1.6) + "px";
    el.style.height = Math.abs(a[1] - b[1]) + pad * 2 + "px";
    repinCurrent();
  }

  /** A spotlight over the union of some elements' boxes. */
  function spotlightOver(els, pad) {
    var boxes = els.filter(Boolean).map(function (el) {
      return el.getBoundingClientRect();
    });
    if (!boxes.length) return;
    var edge = function (key, fn) {
      return fn.apply(
        null,
        boxes.map(function (box) {
          return box[key];
        }),
      );
    };
    spotlight(
      [edge("left", Math.min), edge("top", Math.min)],
      [edge("right", Math.max), edge("bottom", Math.max)],
      pad,
      1,
    );
  }

  function clearSpotlight() {
    var el = document.querySelector(".tour-spot");
    if (el) el.remove();
  }

  /** The pointer eased from one page point to another over `ms`. */
  function glide(from, to, ms) {
    var t0 = performance.now();
    return new Promise(function (resolve) {
      (function frame(now) {
        var f = Math.min(1, (now - t0) / ms);
        var e = f < 0.5 ? 2 * f * f : -1 + (4 - 2 * f) * f;
        caretAt(from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e);
        if (f < 1) requestAnimationFrame(frame);
        else resolve();
      })(t0);
    });
  }

  function slideOntoVia() {
    return fixture().then(function (fx) {
      var B = window.TBBuilder;
      if (!B || !B.project) return;
      var before = fx.frames.point4.routes[0].legs[2];
      var after = fx.frames.via.routes[0].legs[2];
      var via = after.viaPoints && after.viaPoints[0];
      var mid = before.geometry[Math.floor(before.geometry.length / 2)];
      if (!via || !mid) return;
      var box = [
        [Math.min(mid[0], via[0]) - 0.15, Math.min(mid[1], via[1]) - 0.1],
        [Math.max(mid[0], via[0]) + 0.15, Math.max(mid[1], via[1]) + 0.1],
      ];
      // The pointer is on screen from the first moment — mid-map, while the
      // camera settles on the leg — and glides to the road from there. It
      // used to appear only after the fit, which read as a card doing
      // nothing for a second.
      var map = document.getElementById("map");
      if (!map) return;
      var r = map.getBoundingClientRect();
      var here = [r.left + r.width / 2, r.top + r.height / 2];
      caretAt(here[0], here[1]);
      try {
        B.fitTo(box);
      } catch (e) {
        /* the frame lands either way */
      }
      return sleep(900).then(function () {
        var from = B.project(mid);
        var to = B.project(via);
        if (!from || !to) return;
        r = map.getBoundingClientRect();
        var start = [r.left + from[0], r.top + from[1]];
        var end = [r.left + to[0], r.top + to[1]];
        spotlight(start, end, 90);
        return glide(here, start, 500)
          .then(function () {
            return sleep(CARET_LEAD_MS);
          })
          .then(function () {
            return glide(start, end, 1400);
          })
          .then(function () {
            return sleep(SETTLE_MS);
          });
      });
    });
  }

  /** Runs the time slider from one fraction of its travel to another,
   *  dispatching `input` as a drag would. */
  function scrub(fromF, toF, ms) {
    var s = document.getElementById("time-slider");
    if (!s || s.closest("[hidden]")) return Promise.resolve();
    var min = Number(s.min);
    var max = Number(s.max);
    if (!(max > min)) return Promise.resolve();
    var step = demoStep;
    var t0 = performance.now();
    return new Promise(function (resolve) {
      (function frame(now) {
        if (step && !stillOn(step)) return resolve();
        var f = Math.min(1, (now - t0) / ms);
        var v = min + (max - min) * (fromF + (toF - fromF) * f);
        s.value = String(Math.round(v));
        s.dispatchEvent(new Event("input", { bubbles: true }));
        if (f < 1) requestAnimationFrame(frame);
        else resolve();
      })(t0);
    });
  }

  // ——— The roster writes ———
  //
  // Two demonstrations write to the roster through the same endpoints the
  // Riders tab and the split dialog use: home groups for the guides, and who
  // rides which route after the split. Handles and group uids from the
  // fixture are resolved to ids off /api/rides/:id/riders, because those ids
  // do not exist until the ride is saved and the fixture cannot know them.
  function api(path, body) {
    return fetch(path, {
      method: body === undefined ? "GET" : body && body.__put ? "PUT" : "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: body === undefined ? undefined : JSON.stringify(body.__put ? body.__put : body),
    }).then(function (r) {
      if (!r.ok) throw new Error(path + " " + r.status);
      return r.json();
    });
  }

  // ——— The paddock's demonstration bike ———

  var TOUR_BIKE = "Tour bike";

  function tourBikeRow() {
    var rows = document.querySelectorAll("#paddock .bike[data-id]");
    for (var i = 0; i < rows.length; i++) {
      var f = rows[i].querySelector('[data-field="nickname"]');
      if (f && f.value === TOUR_BIKE) return rows[i];
    }
    return null;
  }

  /** Waits for the paddock to render the added bike, up to a few seconds. */
  function awaitTourBike() {
    var t0 = performance.now();
    return new Promise(function (resolve) {
      (function poll() {
        var row = tourBikeRow();
        if (row || performance.now() - t0 > 4000) return resolve(row);
        setTimeout(poll, 100);
      })();
    });
  }

  function addTourBike() {
    var step = demoStep;
    var existing = tourBikeRow();
    var added = existing
      ? Promise.resolve(existing)
      : typeSilently(document.querySelector("#paddock [data-new-bike]"), TOUR_BIKE).then(function () {
          var btn = document.querySelector('#paddock [data-act="add"]');
          if (!btn) return null;
          showCaret(btn);
          return sleep(CARET_LEAD_MS).then(function () {
            hideCaret();
            btn.click();
            return awaitTourBike();
          });
        });
    return added.then(function (row) {
      if (!row || (step && !stillOn(step))) return;
      patchProgress({ bike: Number(row.getAttribute("data-id")) });
      return typeSilently(row.querySelector('[data-field="usableRangeMi"]'), "150").then(function () {
        return sleep(SETTLE_MS);
      });
    });
  }

  /** Deletes the demonstration bike. `keepalive`, because the card that
   *  releases it is followed by a navigation. */
  function dropTourBike() {
    var p = progress();
    var id = p && p.bike;
    if (!id) return;
    patchProgress({ bike: null });
    fetch("/api/bikes/" + id, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "X-Requested-With": "fetch" },
      keepalive: true,
    }).catch(function () {});
  }

  function rosterIds() {
    var p = progress();
    if (!valid(p)) return Promise.reject(new Error("no tour ride"));
    return api("/api/rides/" + p.rideId + "/riders").then(function (d) {
      var byHandle = {};
      var owner = null;
      (d.riders || []).forEach(function (r) {
        if (r.username) byHandle[r.username] = r.riderId;
        if (r.role === "owner" && owner == null) owner = r.riderId;
      });
      var groupId = {};
      (d.groups || []).forEach(function (g) {
        groupId[g.uid] = g.id;
      });
      return { rideId: p.rideId, byHandle: byHandle, owner: owner, groupId: groupId };
    });
  }

  function assignMembers() {
    return Promise.all([fixture(), rosterIds()])
      .then(function (res) {
        var fx = res[0];
        var ids = res[1];
        return fx.members.reduce(function (chain, m) {
          return chain.then(function () {
            var rider = ids.byHandle[m.guide];
            var group = ids.groupId[m.group];
            if (rider == null || group == null) return;
            return api("/api/rides/" + ids.rideId + "/riders/group", { rider: rider, group: group });
          });
        }, Promise.resolve());
      })
      .then(function () {
        patchProgress({ members: true });
        if (window.TBBuilder && window.TBBuilder.reloadRiders) return window.TBBuilder.reloadRiders();
      })
      .then(function () {
        // The tab caches its roster; opening it again after the reload is
        // what redraws the group column.
        var tab = document.getElementById("tab-riders");
        if (tab) tab.click();
      });
  }

  /** The split: the dialog opened for show and typed into, then closed, then
   *  the frame, then the two route-riders writes in the order
   *  writeSplitRiders() makes them. */
  function splitOff() {
    var B = window.TBBuilder;
    return fixture()
      .then(function (fx) {
        if (!B || !B.openSplit || !B.routeIndexOf) return fx;
        var r = B.routeIndexOf(fx.split.at.routeUid);
        var route = fx.frames.meet.routes.filter(function (x) {
          return x.uid === fx.split.at.routeUid;
        })[0];
        var i = route
          ? route.points
              .map(function (pt) {
                return pt.uid;
              })
              .indexOf(fx.split.at.pointUid)
          : -1;
        if (r < 0 || i < 0) return fx;
        try {
          B.openSplit(r, i);
        } catch (e) {
          return fx;
        }
        var group = document.getElementById("tb-split-group");
        if (group) {
          group.value = "";
          group.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return sleep(SETTLE_MS)
          .then(function () {
            return typeSilently(document.getElementById("tb-split-name"), TYPED.splitName);
          })
          .then(function () {
            return typeSilently(document.getElementById("tb-split-dest"), TYPED.splitDest);
          })
          .then(function () {
            return sleep(SETTLE_MS);
          })
          .then(function () {
            B.closeSplit();
            return fx;
          });
      })
      .then(function (fx) {
        return apply("split").then(function () {
          return fx;
        });
      })
      .then(function (fx) {
        return rosterIds().then(function (ids) {
          var resolve = function (list) {
            return list
              .map(function (x) {
                var id = x.owner ? ids.owner : ids.byHandle[x.guide];
                var group = x.group ? ids.groupId[x.group] : null;
                return id == null ? null : { id: id, group: group == null ? null : group };
              })
              .filter(Boolean);
          };
          var base = "/api/rides/" + ids.rideId + "/route-riders/";
          return api(base + fx.split.peel.routeUid, { __put: { riders: resolve(fx.split.peel.riders) } }).then(
            function () {
              return api(base + fx.split.onward.routeUid, { __put: { riders: resolve(fx.split.onward.riders) } });
            },
          );
        });
      })
      .then(function () {
        if (B && B.reloadRiders) return B.reloadRiders();
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

  // ——— Building and running ———

  function build() {
    if (tour) return tour;
    tour = new Shepherd.Tour({
      tourName: "routeloop",
      useModalOverlay: true,
      exitOnEsc: true,
      keyboardNavigation: true,
      defaultStepOptions: {
        classes: "tour-step",
        // The only interaction is Next, Back and Skip: the spotlit control is
        // shown, never handed over. Shepherd puts pointer-events: none on the
        // target; the demos type and click programmatically, which that does
        // not stop. Ziad's call, 2026-09-12, after a rider could edit the
        // first point while the card about it was up.
        canClickTarget: false,
        modalOverlayOpeningPadding: 6,
        modalOverlayOpeningRadius: 8,
        // Shepherd deep-merges `floatingUIOptions` and deepmerge CONCATENATES
        // arrays, so this middleware is appended after Shepherd's flip and
        // shift. The card sits 20px further right on a desktop, or it lands
        // with its left edge inside the panel over the row it points at.
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
      var p = progress();
      if (valid(p)) {
        p.stepId = e.step.id;
        saveProgress(p);
      }
    });
    tour.on("complete", finish);
    tour.on("cancel", finish);
    tour.on("active", reanchorOn);
    tour.on("inactive", reanchorOff);
    // `html.tour-active` is for the stylesheet — the place-search dropdown
    // and the split dialog sit at z-indexes that lose to Shepherd's overlay,
    // and _tour.scss lifts them while a tour is running — and for tips.js,
    // which shows no bubble while it is stamped.
    tour.on("active", function () {
      document.documentElement.classList.add("tour-active");
      // The alpha splash returns on every load until its box is ticked, and
      // a new rider — the tour's whole audience — has not ticked it. Two
      // modals on one screen is one too many, so the tour closes it through
      // its own button; nothing is written, and it comes back when the tour
      // is over.
      var alpha = document.getElementById("alpha-splash");
      var closeAlpha = alpha && !alpha.hidden ? alpha.querySelector("[data-close-alpha]") : null;
      if (closeAlpha) closeAlpha.click();
    });
    tour.on("inactive", function () {
      document.documentElement.classList.remove("tour-active");
    });
    return tour;
  }

  // ——— Surviving a re-render ———
  //
  // The builder replaces the route list on every edit, and a card pinned to a
  // node that no longer exists slides to the top-left corner. The list is
  // watched while a tour is active, and when the current step's target is
  // gone the card is re-pinned — through repin(), never a bare step.show():
  // a bare show reads to when.show as a fresh arrival and runs the
  // demonstration again, which was the two-frames-a-second loop on "Take
  // one". Synchronous rather than on a frame, so nothing is painted with the
  // card adrift. `getTarget()` is public API.
  var listMo = null;

  function reanchor() {
    if (!tour || !tour.isActive()) return;
    var st = tour.getCurrentStep();
    if (!st || !st.options.attachTo) return;
    var t = st.getTarget();
    if (t && !t.isConnected) repin(st);
    // A step holding something open (a category picker) puts it back after
    // the re-render that closed it — once its own demonstration has opened it.
    var step = stepById(st.id);
    if (step && step.hold && step.holding && !releasing) step.hold();
  }

  function reanchorOn() {
    var list = document.getElementById("route-list");
    if (!list || !window.MutationObserver || listMo) return;
    listMo = new MutationObserver(reanchor);
    listMo.observe(list, { childList: true, subtree: true });
  }

  function reanchorOff() {
    if (listMo) {
      listMo.disconnect();
      listMo = null;
    }
  }

  /**
   * Starts a NEW tour: asks the server for a fresh tour ride (which bins the
   * previous one and, the first time on a deployment, creates the guides),
   * saves the position at the welcome card, and goes to that ride's builder,
   * whose boot() resumes there. Never in place, because the tour is a story
   * about one specific ride and the page in front of the rider is not it.
   */
  var starting = false;
  function start() {
    if (!Shepherd || starting) return false;
    if (tour && tour.isActive()) return true;
    starting = true;
    // A blank builder may already be dirty from its seeded home base; that is
    // not work, and saving it on the way out would create a stray ride.
    if (window.TBBuilder && window.TBBuilder.discard) window.TBBuilder.discard();
    api(START_URL, {})
      .then(function (d) {
        saveProgress({ rideId: d.id, slug: d.slug, stepId: "welcome", frame: null, members: false });
        window.location.assign("/builder/" + d.id);
      })
      .catch(function (e) {
        starting = false;
        console.warn("[tour] could not start:", e);
      });
    return true;
  }

  /** Resumes a saved tour on this page, if the position is for this ride and
   *  this page. Returns whether it did. */
  function resume() {
    var p = progress();
    if (!valid(p)) return false;
    var step = null;
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].id === p.stepId) step = STEPS[i];
    if (!step || !onTourPage(pageOf(step), p)) return false;
    build();
    tour.show(step.id);
    return true;
  }

  /**
   * Called once Shepherd's import has resolved. Two doors: `?tour` on the
   * builder is somebody asking; a saved position on its own page is a tour in
   * progress. THE TOUR NEVER STARTS UNASKED — Ziad's call, 2026-09-13. There
   * was a third door, `data-tour="new"` on a blank builder for a rider who
   * had never been offered it; the stamp survives for the account menu, and
   * nothing here reads it.
   */
  function boot(S) {
    Shepherd = S;
    var asked = /(?:\?|&)tour(?:=|&|$)/.test(window.location.search);
    if (asked && window.history.replaceState) {
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    }
    if (asked) {
      start();
      return;
    }
    resume();
  }

  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("[data-tour-part]") : null;
    if (!b || !tour || !tour.isActive()) return;
    jump(Number(b.getAttribute("data-tour-part")));
  });

  // Take the tour, from the sign or the menu: a real link to `/builder?tour`
  // so it works with the CDN down, intercepted here so it starts without the
  // extra page load when Shepherd is already here.
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("[data-tour-start]") : null;
    if (!b || !Shepherd) return;
    if (tour && tour.isActive()) return;
    e.preventDefault();
    start();
  });

  // AFTER `load`, NOT ON DOMContentLoaded: the builder draws on
  // DOMContentLoaded and nothing here may sit ahead of it.
  function load() {
    var link = document.getElementById("shepherd-module");
    if (!link || !link.href) return;
    import(link.href)
      .then(function (m) {
        boot(m.default);
      })
      .catch(function () {
        /* the CDN did not answer; the page is unaffected */
      });
  }
  if (document.readyState === "complete") load();
  else window.addEventListener("load", load);

  window.TBTour = {
    boot: boot,
    start: start,
    STEPS: STEPS,
    PARTS: PARTS,
    FRAMES: FRAMES,
    SEED_TITLE: SEED_TITLE,
    get tour() {
      return tour;
    },
  };
})();
