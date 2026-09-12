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
  var TYPE_MS = 60;
  var CARET_LEAD_MS = 700;
  var SETTLE_MS = 400;
  // How long a demonstration gets before the card gives up and offers Next
  // anyway. A frame is one save; the split is a save and two writes.
  var DEMO_TIMEOUT_MS = 20000;

  // The keyframes, in story order. A step names the one it lands on, and
  // "done" for a demonstrating step is "that frame, or a later one, has been
  // applied" — kept in the saved position rather than read off the DOM,
  // because thirteen predicates over the route list would each be a second
  // description of what a frame contains.
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
    "group",
    "gas",
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
    groupName: "San Jose crew",
    groupStart: "San Jose",
    splitName: "Heading home",
    splitDest: "Redwood City",
  };

  // ——— The parts ———
  //
  // **FIVE PARTS A RIDER CAN TAKE IN ANY ORDER OR SKIP AT WILL.** Every card
  // carries Skip this part beside Next, the welcome and closing cards offer the
  // parts as buttons, and `jump()` is the one way between them. Fuel comes
  // before the meet on purpose: the proposer only offers a meeting point a
  // group can reach on the tank it leaves with, so the ring has to exist
  // before a proposal can be explained.
  var PARTS = [
    { n: 1, name: "The route", blurb: "Name it, add points, shape the road, say what each stop is for." },
    { n: 2, name: "The clock", blurb: "A start time, the arrival at every point, and the scrubber along the map." },
    { n: 3, name: "The people", blurb: "Groups, the roster, who rides which route, and where friends come from." },
    { n: 4, name: "Fuel", blurb: "The paddock, the range ring, where a tank runs dry, and the gas stop that fixes it." },
    { n: 5, name: "Meet and split", blurb: "Where two groups meet, one group heading home early, and sharing the ride." },
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
  // rider comes back to the builder for.
  var STEPS = [
    {
      id: "welcome",
      title: "This is where a ride gets planned",
      text: "Five short parts, a few minutes each: the route, the clock, the people, fuel, and meeting up. Take them in order, jump to one, or skip any of them. Everything you are about to see is real—a real ride, planned in front of you with three riders who exist for exactly this—and it goes in the bin when you are done, so nothing here is homework.",
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
      title: "The builder is two halves. This is the first",
      text: "The panel: your routes, every point on them, how long you stop, when you leave. It is a list, and the order of the list is the order you ride. Everything the map cannot say in a picture is said here.",
    },
    {
      id: "map",
      part: 1,
      at: "#map",
      side: "left",
      title: "The map is the other half",
      text: "Everything in the panel is drawn over here, and most of it can be done from either side—click the map to add a point, drag a road to reshape it. Neither half is the real one; they are the same ride, twice.",
    },
    {
      id: "route",
      part: 1,
      at: ".route-head",
      title: "A ride is made of routes",
      text: "Each of these is one stretch of the trip—usually a day, sometimes one group’s morning. It has a name, a color on the map, and its own start time. A weekend is two of them. A week away is seven, and the panel will happily hold more.",
    },
    {
      id: "first-point",
      part: 1,
      at: ".point-row",
      title: "Every route starts somewhere",
      text: "The first point is where you set off, and it is already here: Jack London Square in Oakland, where this run begins. You would type a place into the box below it—a town, a café, an address—and pick it from the list, or press + Point and click anywhere on the map. A new ride of your own starts from your home base, if you have set one.",
    },
    {
      id: "second-point",
      part: 1,
      at: ".add-row",
      extra: ["#map"],
      title: "Add a second, and a road appears",
      text: "A restaurant up on Skyline, typed into the search. The moment it lands a road is drawn between the two: that line is the leg, and every number in the builder comes from it. Watch.",
      running: "Finding a place…",
      frame: "point2",
      demo: function () {
        return typeSearch(TYPED.alices).then(function () {
          return apply("point2");
        });
      },
    },
    {
      id: "more-points",
      part: 1,
      at: ".add-row",
      extra: ["#map"],
      title: "Then the coast, then the far end",
      text: "Pescadero for lunch, and Santa Cruz to finish. Each new point goes at the bottom of the list and the road extends to reach it; drop one between two others and the road bends to pass through it instead. Drag a point in the list and the road is redrawn.",
      running: "Finding two more…",
      frame: "point4",
      demo: function () {
        return typeSearch(TYPED.pescadero)
          .then(function () {
            return apply("point3");
          })
          .then(function () {
            return typeSearch(TYPED.santaCruz);
          })
          .then(function () {
            return apply("point4");
          });
      },
    },
    {
      id: "leg",
      part: 1,
      at: "totals-ride",
      side: "bottom",
      title: "Ride totals and stats",
      text: "Distance, riding time, and how twisty the road is, worked out from the road itself rather than guessed. Change anything about the route and these change with it.",
    },
    {
      id: "via",
      part: 1,
      at: "#map",
      side: "left",
      title: "Drag the road onto a better one",
      text: "The router took Highway 1 from Pescadero. Grab the line and drop it on the road you meant—inland, through the redwoods at Big Basin—and the leg is redrawn through that spot. This is a shaping point: it bends the road without becoming a stop.",
      running: "Dragging the road…",
      frame: "via",
      demo: function () {
        return slideOntoVia().then(function () {
          return apply("via");
        });
      },
    },
    {
      id: "via-row",
      part: 1,
      at: ".via-row",
      title: "A shaping point is not a stop",
      text: "It gets a line in the list under the point its leg leaves, with no number and no time, because you are not stopping there—you are riding through it. Delete it from here or from its handle on the map and the road goes back to the router’s choice.",
    },
    {
      id: "category",
      part: 1,
      at: ".point-row",
      nth: 3,
      title: "Say what a place is for",
      text: "Fuel, food, a bed, a view. The dot beside each point opens the list, and a point can carry up to four of them. Tagging a place promotes it to a numbered stop—Pescadero becomes lunch, Alice’s becomes coffee, Santa Cruz becomes the finish—and the icons land on the map. Gas is the one that matters most: it is how the builder knows where you fill up.",
      running: "Picking a category…",
      frame: "category",
      demo: function () {
        return pressRoles(3).then(function () {
          return apply("category");
        });
      },
    },
    {
      id: "dwell",
      part: 1,
      at: "row-dur",
      nth: 3,
      title: "Stops take time, and the builder knows it",
      text: "Type how long you will be off the bike—lunch, a quick photo, a night in a motel. Forty-five minutes at Pescadero, thirty for coffee at Alice’s. Everything after a stop moves later, which is how the arrival at the far end stays honest.",
      running: "Typing the stops…",
      frame: "dwell",
      demo: function () {
        return typeSilently(anchor("row-dur", 3), "45m")
          .then(function () {
            return typeSilently(anchor("row-dur", 2), "30m");
          })
          .then(function () {
            return apply("dwell");
          });
      },
    },
    {
      id: "menu",
      part: 1,
      at: "route-menu",
      title: "Everything else is behind the dots",
      text: "Duplicate a route, reverse it, split it at a stop, offer it as an alternative for a vote. The same three dots on a point row do the same for a point—including notes only you can see, like a confirmation number or a gate code.",
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
      text: "Part 1 gave the ride a road. This part gives it a clock: a start time on the route, an arrival time at every point worked out from it, an end that follows on its own, a slider along the bottom of the map, and an hour to start looking for a bed. Set one time and the rest appears.",
    },
    {
      id: "when",
      part: 2,
      at: ".route-start",
      title: "Give the route a start time",
      text: "Pick the day and the hour you set off. Every point gets an arrival time from it, the end of the route works itself out, and a slider appears along the bottom of the map. Saturday at nine.",
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
      at: "timeline",
      side: "top",
      title: "This is the time scrubber",
      text: "Drag it and the dot on the map shows where you would be at that moment, with the leg you would be on lit up. On a ride with several routes a Route | Ride switch beside it lets the slider run over one day or the whole trip. Let me run it out to the coast.",
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
      text: "Start time, plus the riding, plus every stop along the way. Type over it if you know better—a hard deadline at the far end—or clear it to hand it back to the builder.",
    },
    {
      id: "bed",
      part: 2,
      at: "ride-stop-by",
      title: "When to start looking for a bed",
      text: "Set an hour here and any route still going at that time gets a band across its list at the point it reaches it, with how much riding is still left after. It is advice, not a limit—riding past four is your call, and this puts the consequence beside the choice. Four o’clock; this run is home by two, so the band stays away, and on a long day it does not.",
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

    // ——— Part 3: the people ———
    {
      id: "intro-3",
      part: 3,
      intro: true,
      needs: "bed",
      title: "Next: the people",
      text: "A ride is rarely one person. This part is the riders on it: groups for people who set off from different places, the roster of who is coming, which route each of them is on, and where friends come from in the first place. Three riders are about to join this one.",
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
      text: "Name it and say where they set off from. Two friends are coming up from San Jose, so that is a second group with its own starting point; the builder gives it a route of its own, and later it will work out where the two groups should meet.",
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
      id: "roster",
      part: 3,
      page: "roster",
      at: ".roster-list",
      title: "The roster: who is coming",
      text: "This is the ride’s own page, and everybody on it. Sam, Priya, and Diego are the three riders who exist for this tour—they are on every tour ride, and nowhere else. Each rider says whether they are in, which bike they are bringing, and, once there are groups, which group they set off with.",
    },
    {
      id: "roster-invite",
      part: 3,
      page: "roster",
      at: ".roster-invite",
      title: "Adding a rider",
      text: "You add riders here, and only friends: somebody already on Routeloop who has said yes to riding with you. That is the whole invite mechanism—no links, no email addresses, nothing to forward. Pick a friend, choose what they may do to the ride, and press Add.",
    },
    {
      id: "riders-tab",
      part: 3,
      at: "#tab-riders",
      tab: "tab-riders",
      side: "bottom",
      needs: "group",
      title: "The same people, in the builder",
      text: "The Riders tab is the roster as the plan sees it: who is on which approach, and what each of them rides. Sam and Priya are coming from San Jose, so they go in the San Jose crew; Diego rides out of Oakland with you. Their bikes’ ranges are what the fuel warnings are built from, and the smallest tank on the ride is the one that counts.",
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
      part: 3,
      at: "route-groups",
      tab: "tab-routes",
      title: "Who rides which route",
      text: "This pill on each route says who is on it. Leave it alone and everybody rides everything; tick a group here to say somebody joins or peels off at this point, and the roadbook and every export follow. Part 5 does this for real.",
    },
    {
      id: "friends",
      part: 3,
      page: "riders",
      at: ".page-tabs",
      title: "Where friends come from",
      text: "Every rider on Routeloop is listed here by handle, and a friend request is one press. Until somebody accepts, you cannot put them on a ride—which is what keeps a roster a list of people who chose to be there. The tour’s three guides are not on this page; real riders are.",
    },

    // ——— Part 4: fuel ———
    {
      id: "intro-4",
      part: 4,
      intro: true,
      needs: "group",
      title: "Next: fuel",
      text: "Every bike has a tank, and the builder plans around the smallest one on the ride. This part is where that number lives, the ring on the map that shows how far it reaches, the mark where it runs dry, and the gas stop that fixes it.",
    },
    {
      id: "paddock",
      part: 4,
      page: "profile",
      at: "#paddock",
      title: "The paddock: your bikes and their range",
      text: "Each bike you ride, with how far a tank takes it. This is the only place a range is typed; everything else reads it. Yours is empty—the tour adds nothing here—so on the tour ride it is the guides’ bikes that count: Sam’s KTM at 200 miles, Priya’s Triumph at 190, and Diego’s Ducati at 120, which is the tank the ride is planned around.",
    },
    {
      id: "ring",
      part: 4,
      at: "range-ring",
      side: "top",
      title: "The range ring",
      text: "The dotted ring on the map is how far the smallest tank reaches from the last fill—green through the first half, orange past it, red near the end. Its edge passes through the point where the tank runs dry, so it shrinks as you ride toward that point and vanishes when you get there. This button turns the whole fuel overlay off if you want the map back.",
    },
    {
      id: "empty",
      part: 4,
      at: "#map",
      side: "left",
      title: "Where the tank runs dry",
      text: "Diego’s 120 miles run out in the redwoods, twenty miles short of Santa Cruz. The red E is the point, and the road past it is painted red with white dashes: you can ride it, you just cannot get there on the fuel you have. Scrubbing out to it shows the ring closing in.",
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
      part: 4,
      at: ".point-row",
      nth: 3,
      title: "A gas stop fixes it",
      text: "Pescadero has a station, so lunch is also a fill-up: open the categories on that row and add Gas. The tank starts over from there, the E goes, and the ring is drawn from Pescadero instead. On a ride with no station in reach, the Gas chip under a route searches for one along the road.",
      running: "Adding a gas stop…",
      frame: "gas",
      demo: function () {
        return pressRoles(3).then(function () {
          return apply("gas");
        });
      },
    },

    // ——— Part 5: meet and split ———
    {
      id: "intro-5",
      part: 5,
      intro: true,
      needs: "gas",
      title: "Next: meet and split",
      text: "Two groups setting off from two towns want one road together. This part asks the builder where they should meet, takes its answer, sends one rider home early, and ends on the page you would share with everybody else.",
    },
    {
      id: "meet-find",
      part: 5,
      at: "#sg-meet",
      tab: "tab-groups",
      title: "Ask where to meet",
      text: "One press. The builder walks the main group’s road looking for the earliest gas station every other group can reach on the tank they leave with, within the detour you allow, and offers the best few—each with how far out of their way the joining group comes.",
      running: "Working out where to meet…",
      done: function () {
        return !!document.querySelector(".sg-take");
      },
      demo: function () {
        var btn = document.getElementById("sg-meet");
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
      id: "meet-take",
      part: 5,
      at: ".sg-take",
      tab: "tab-groups",
      title: "Take one",
      text: "A Chevron in Hayward, sixteen miles into the main road, with the San Jose crew fourteen miles out of their way. Taking it puts the station on both groups’ routes, cuts the main road there so everything after it is ridden together, and sets the San Jose crew’s departure so both groups roll in at the same time.",
      running: "Taking the first one…",
      frame: "meet",
      demo: function () {
        var btn = document.querySelector(".sg-take");
        if (btn) showCaret(btn);
        return sleep(CARET_LEAD_MS).then(function () {
          hideCaret();
          return apply("meet");
        });
      },
    },
    {
      id: "meet-result",
      part: 5,
      at: ".route-head",
      tab: "tab-routes",
      title: "Three routes where there was one",
      text: "Oakland to the Chevron for your group, San Jose to the Chevron for theirs—leaving nineteen minutes earlier, because they have farther to ride—and one shared route from the Chevron to Santa Cruz that everybody is on. The meet needs no flag: a group’s own route followed by a shared one is what a meet is.",
    },
    {
      id: "split",
      part: 5,
      at: function () {
        return rowNamed("Pescadero");
      },
      tab: "tab-routes",
      title: "Somebody heads home early",
      text: "Diego is turning for home at Pescadero, over 84. The row menu’s Split a group off here asks who is leaving and where they are going, cuts the shared route at the stop, and gives the leavers a route of their own from there. Everybody else carries on to Santa Cruz.",
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
      text: "The last point of the route they left carries a line naming the group and where they went. Press it to jump to their route. Who is on every route, and who leaves where, is what the roadbook and each rider’s own export are built from.",
    },
    {
      id: "share",
      part: 5,
      page: "viewer",
      at: ".qr-share",
      title: "This is the page you share",
      text: "The ride as everybody else sees it: the map, the routes, the times, and the roster link. Its address is the share link, and the QR code under here opens it from a phone camera. Who can open it is the visibility setting in the builder—private, friends, unlisted, or public.",
    },
    {
      id: "exports",
      part: 5,
      page: "viewer",
      at: ".route-table",
      title: "Take it with you",
      text: "Each route can be handed to Google Maps for turn-by-turn, printed as a roadbook, or downloaded in six formats for whatever is on your bars. Every rider gets the routes they are on—Diego’s file ends at Redwood City, yours at Santa Cruz.",
    },

    {
      id: "done",
      page: "viewer",
      title: "That is the whole idea",
      text: "A route, a clock, the people, fuel, and where to meet. Done bins this ride—it was the tour’s, not yours—and the three guides go back to waiting for the next rider. Everything you plan from here on is yours and saves as you go. Point at any control and it tells you what it is for, and the tour is under the menu whenever you want it again. Have a good ride.",
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
    if (p === "/profile" || p === "/settings") return "profile";
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
        return "/profile";
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
              return { geometry: src.geometry, distanceM: src.distanceM, durationS: src.durationS, viaPoints: l.viaPoints || [] };
            });
            if (r.startAt) r.startAt = new Date(Date.parse(r.startAt) + delta).toISOString();
          });
          fx.frames[f.id] = ride;
        });
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
  function apply(id) {
    if (!window.TBBuilder || !window.TBBuilder.apply) return Promise.resolve(false);
    return fixture()
      .then(function (fx) {
        var ride = fx.frames[id];
        if (!ride) throw new Error("no frame " + id);
        return window.TBBuilder.apply({ id: id, ride: ride });
      })
      .then(function (ok) {
        if (ok !== false && !hasFrame(id)) patchProgress({ frame: id });
        return ok;
      })
      .catch(function (e) {
        console.warn("[tour] frame " + id + ":", e);
        return false;
      });
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

  function titleCase(s) {
    return s.replace(/\b[a-z]/g, function (c) {
      return c.toUpperCase();
    });
  }

  /** "Part 2 of 5 · The Clock · 3 of 4", rendered above the body. An intro
   *  carries the first two and not the counter. */
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
      classes: step.part ? "tour-part-" + step.part : "",
      title: step.title,
      text: function () {
        var body = typeof step.text === "function" ? step.text() : step.text;
        return partLine(step) + "<p>" + body + "</p>" + (step.chooser ? chooserHtml() : "");
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
        return ensure(step.needs);
      },
      when: {
        show: function () {
          keepTabInside(this.getTarget());
          if (!step.demo) return;
          if (this.el) this.el.classList.remove("is-satisfied");
          if (stepDone(step)) {
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

    if (step.extra) opts.extraHighlights = step.extra;

    if (step.at) {
      opts.attachTo = {
        element: function () {
          var el = anchor(step.at, step.nth);
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

  function runDemo(step, shepherdStep) {
    demoStep = step;
    var finished = function () {
      hideCaret();
      if (demoStep === step) demoStep = null;
      if (!stillOn(step)) return;
      if (shepherdStep.el) shepherdStep.el.classList.add("is-satisfied");
      // A frame re-renders the list, and the row this card was pinned to may
      // now be a different node, or out of the way of the routes the frame
      // added. Re-showing resolves a fresh target; `stepDone` holds, so the
      // demonstration is not run twice.
      var target = step.at ? shepherdStep.getTarget() : null;
      if (step.at && (!target || !target.isConnected || !target.getBoundingClientRect().height)) shepherdStep.show();
    };
    var timer = setTimeout(finished, DEMO_TIMEOUT_MS);
    Promise.resolve()
      .then(function () {
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
    caretNode();
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

  /** The cursor at a page coordinate, for the map. */
  function caretAt(x, y) {
    var el = caretNode();
    caretHost = null;
    el.style.left = x + "px";
    el.style.top = y - 9 + "px";
    el.style.height = "18px";
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
  function typeText(input, text, silent) {
    var step = demoStep;
    if (!input) return Promise.resolve();
    input.value = "";
    if (!silent) input.dispatchEvent(new Event("input", { bubbles: true }));
    showCaret(input);
    return sleep(CARET_LEAD_MS).then(function () {
      var i = 0;
      return new Promise(function (resolve) {
        (function next() {
          if (!input.isConnected || (step && !stillOn(step))) return resolve();
          if (i >= text.length) return sleep(SETTLE_MS).then(resolve);
          input.value += text.charAt(i++);
          if (!silent) input.dispatchEvent(new Event("input", { bubbles: true }));
          placeCaret();
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
   *  see the search restricted to. */
  function typeSearch(query) {
    return fixture().then(function (fx) {
      if (window.TBBuilder && window.TBBuilder.fitTo && fx.boxes && fx.boxes.peninsula) {
        try {
          window.TBBuilder.fitTo(fx.boxes.peninsula);
        } catch (e) {
          /* the frame lands either way */
        }
      }
      var input = anchor(".add-row .add-search");
      return sleep(SETTLE_MS).then(function () {
        return typeSilently(input, query);
      });
    });
  }

  /** Presses the category dot on the nth point row — for real, because opening
   *  the picker costs nothing — then leaves it open for a beat. */
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
      try {
        B.fitTo(box);
      } catch (e) {
        /* the frame lands either way */
      }
      return sleep(900).then(function () {
        var map = document.getElementById("map");
        var from = B.project(mid);
        var to = B.project(via);
        if (!map || !from || !to) return;
        var r = map.getBoundingClientRect();
        var start = [r.left + from[0], r.top + from[1]];
        var end = [r.left + to[0], r.top + to[1]];
        caretAt(start[0], start[1]);
        return sleep(CARET_LEAD_MS).then(function () {
          var t0 = performance.now();
          var ms = 1400;
          return new Promise(function (resolve) {
            (function frame(now) {
              var f = Math.min(1, (now - t0) / ms);
              var e = f < 0.5 ? 2 * f * f : -1 + (4 - 2 * f) * f;
              caretAt(start[0] + (end[0] - start[0]) * e, start[1] + (end[1] - start[1]) * e);
              if (f < 1) requestAnimationFrame(frame);
              else sleep(SETTLE_MS).then(resolve);
            })(t0);
          });
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
          return api(base + fx.split.peel.routeUid, { __put: { riders: resolve(fx.split.peel.riders) } }).then(function () {
            return api(base + fx.split.onward.routeUid, { __put: { riders: resolve(fx.split.onward.riders) } });
          });
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
    // `html.tour-active` is for the stylesheet: the place-search dropdown and
    // the split dialog sit at z-indexes that lose to Shepherd's overlay, and
    // _tour.scss lifts them while a tour is running.
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
  // node that no longer exists slides to the top-left corner. Watch the list,
  // and when the current step's target is gone show the step again so it
  // resolves a fresh one. `getTarget()` is public API.
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

  function blankRide() {
    return window.location.pathname.replace(/\/+$/, "") === "/builder";
  }

  /**
   * Called once Shepherd's import has resolved. Three doors: `?tour` on the
   * builder is somebody asking; a saved position on its own page is a tour in
   * progress; `data-tour="new"` on a blank builder is a rider who has never
   * been offered it, and the whole tour starts unasked.
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
    if (resume()) return;
    var isNew = document.documentElement.getAttribute("data-tour") === "new";
    if (isNew && blankRide()) start();
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
    get tour() {
      return tour;
    },
  };
})();
