// Show me around — the tooltip layer. #133.
//
// **THE TABLE HOLDS THE BODY AND NOT THE HEADLINE, WHICH IS WHAT MAKES DRIFT
// IMPOSSIBLE.** The obvious shape is `{headline, body}` per control, and it is
// wrong here: the headline already exists, in the markup, as the `title` this
// layer replaces. Storing it twice means two strings that have to agree, in two
// files, one of which is assembled as a JavaScript string ten thousand lines
// into builder.js — so they would agree until the first time somebody reworded
// a button. The headline is READ OFF THE ELEMENT at hover time instead, and the
// only thing written down here is the sentence the native tooltip had nowhere
// to put.
//
// **WHICH IS ALSO WHY `off` IS LITERALLY THE NATIVE TOOLTIP.** With the mode off
// this file installs nothing and touches no attribute: `title` is still in the
// markup, the browser still shows it, and a page with no JavaScript at all
// behaves the same way. There is no second rendering path to keep in step, and
// nothing to go wrong on the surface a rider chose because they wanted less.
//
// **A `data-tip` KEY IS A LABEL, NEVER OVERFLOW.** Half the `title` attributes
// in this app are a place to put dynamic text that would not fit — a stop's
// note, a rider's twistiness figure, who is holding a route. Those stay native
// and get no key: they are already the whole content, and a headline-plus-body
// treatment of a truncated note is furniture around a string.
//
// **THE STRIP RUNS ON HOVER, NOT ON LOAD, BECAUSE THE BUILDER RE-RENDERS.**
// `renderRoutes()` replaces innerHTML on every edit, so any attribute this file
// removed at init would be back a keystroke later. Delegating at the document
// and stripping when a control is actually pointed at means a re-render needs
// no re-init and there is nothing to subscribe to. It wins the race with the
// native tooltip comfortably — `pointerover` fires on entry and the browser
// waits about a second before drawing.
//
// **REMOVING `title` CAN REMOVE AN ACCESSIBLE NAME, AND THAT IS THE ONE TRAP
// HERE.** `title` is the last fallback in the accessible name computation, so a
// control whose only name was its `title` becomes an unnamed button the moment
// this file takes it away — silently, and only for the riders who can least
// afford it. `nameless()` is the check and the stashed headline goes back on as
// an `aria-label` when it fires.
(function () {
  "use strict";

  // One sentence, occasionally two, per control. What the thing IS and why a
  // rider would touch it — never a restatement of the label above it, which is
  // the failure mode this whole feature exists to fix.
  var BODY = {
    // ——— The route header ———
    "route-drag":
      "Routes ride in the order they are listed. Drag this to move one earlier or later, or tab to it and use the up and down arrow keys—the keys work whether or not the drag library loaded.",
    "route-twirl":
      "Folds a route down to its header. Nothing is removed and nothing stops counting; it is just out of the way while you work on another one.",
    "route-color":
      "The color this route is drawn in on the map, and on its row in the timeline. Pick something you can tell apart from the route beside it.",
    "route-rev":
      "Turns the route around, so the last stop becomes the first. Every leg is routed again from scratch, because the road back is not always the road out.",
    "route-menu": "Duplicate the route, make it an alternative, split it at a stop, or throw it away.",
    "route-end":
      "Worked out for you from the start time, the riding, and how long you stop. Type over it if you know better, or clear it to hand it back.",
    "route-alt":
      "Two routes can cover the same stretch as alternatives, and only one of them counts toward the ride’s distance and time. This says which one you are looking at.",
    "route-groups":
      "Who is on this stretch of road. Leave it alone and the route is ridden by everyone who was on the route before it; tick a group to say somebody joins or peels off here.",

    // ——— A point row ———
    "row-drag":
      "Drag to move this point earlier or later in the route, or tab to it and use the up and down arrow keys. The legs either side are re-routed once you let go.",
    "row-dur":
      "How long you are off the bike here. It pushes everything after it later, which is how the arrival time at the far end knows about your lunch.",
    "row-roles":
      "What this place is for—fuel, food, a bed, a view. Giving a point a category also promotes it to a stop, because a reason to be somewhere is a reason to stop.",
    "row-detail-flag":
      "This stop has details only you can see—a confirmation number, a gate code, a phone number. They are never shared and never exported.",
    "row-menu": "Rename the point, open its details, split the route here, move it to another route, or remove it.",
    "row-splitoff": "Some riders leave the group at this stop. This jumps to the route they take from here.",
    "row-dist-dry":
      "On the smallest tank in the group, the fuel runs out before this point. Put a fuel stop in ahead of it, or the map draws the road closed from where you go dry.",

    // ——— Adding to a route ———
    "insert-slot":
      "Slips a new point in between these two rather than at the end. Whatever you search for here is searched along this leg, not across the whole route.",
    "via-del":
      "Removes a shaping point—one of the handles you dragged the road onto. The leg is routed again without it and the stops either side are untouched.",
    "map-add": "Arms the map. Click anywhere on it and a point lands there. Press again to disarm.",
    "scope-btn":
      "Whether a search looks at the piece of map you can see or at the whole road this route takes. Along the route is what finds fuel three hours ahead.",

    // ——— Groups and riders ———
    "sg-drag":
      "The first group is the main group: the one whose road everybody else joins, and whose departure time the others are worked out from. Drag another one over it to hand that over.",
    "sg-del": "Removes the group. The riders in it stay on the ride and the routes they were on are untouched.",
    "rider-del": "Takes them off the ride. Anything they wrote stays, attributed to them, and you can add them back.",
    "totals-ride":
      "The whole ride—distance, riding time, and how twisty the roads are. Alternatives you are not riding are left out of it.",

    // ——— The bar above the panel ———
    "route-add": "Starts another route. A route is one leg of the trip, usually a day, and a ride is made of several.",
    "ride-name": "What the ride is called, everywhere it appears. Click it and type.",
    "ride-visibility":
      "Who can open the link. Private is you and the people on the ride, unlisted is anyone holding the link, and public puts it on the explore page.",
    "ride-stop-by":
      "The hour you would rather start looking for a bed. Set it and each route gets a band across the list at the point it reaches that time, with how much riding is left after it.",
    undo: "Takes back the last change to the ride. Every edit here is undoable, including deleting a route.",
    redo: "Puts a change back after you have undone it. Available until you make a different edit, which is the point the old path stops existing.",

    // ——— The timeline, on both map pages ———
    "time-scope":
      "Whether the slider runs over this route or the whole ride. Route gives an hour of Saturday afternoon real room to scrub through; Ride shows where everybody is across all of it.",
    "range-ring":
      "Shows or hides the fuel overlay: the ring around where you are, the red stretch you cannot reach, and the E marks where the smallest tank runs dry. The dot marking where you are stays either way.",

    // ——— The viewer ———
    "viewer-edit": "Opens the same ride in the builder, where you can move stops, add points, and change the dates.",
    "viewer-clone":
      "Copies the ride into your own account so you can change it without touching the original. The owner is not told, and the two rides stay separate from then on.",
    "viewer-roster":
      "Everybody on the ride and whether they said they are coming. Only riders on the roster can see it; a share link shows the route and nothing about people.",
    "viewer-qr":
      "The link to this ride as a code a phone camera can read. Hold your screen up at a meeting point and the whole group gets the route without typing anything.",
    "viewer-arrows":
      "Draws small arrows along the line so you can tell which way the route runs. Useful on a loop, where the start and the end are the same place.",
    "route-dl":
      "Every format here loses something on the way into another app except the Routeloop one, which comes back as the same ride. GPX is the safe pick for a GPS; the roadbook is the one you print.",
    "route-zip":
      "One file per route, named so they land back in the right order and dated, because a GPX or KML has nowhere inside it to carry a date.",

    // ——— The dashboard ———
    "ride-delete":
      "Moves the ride to the recycle bin, where it sits for thirty days with a button to put it back. There is no are-you-sure step because the bin is that step.",
    "rides-friends":
      "Rides your friends have set to be visible to friends. Being friends is what unlocks them; a public ride shows up under Public for everyone.",
    "rides-following":
      "Public and unlisted rides from the riders you follow, newest first. Following is one-way and grants nothing—it is a feed, not a key.",

    // ——— The footer ———
    "whats-new":
      "Opens the release notes without leaving the page. The version is the minute this build was committed, in Pacific time.",
    "build-commit":
      "The exact commit this page was built from, on GitHub. Handy when a bug report needs to say which build it happened on.",

    // ——— Elsewhere ———
    timeline:
      "Scrubs through the ride. The map shows where you would be at that moment, and which leg you would be on.",
    "import-move-up": "Files import in the order shown, and the order becomes the route order. This moves one earlier.",
    "import-move-down": "Moves this file later in the order the routes will be created in.",
    "import-drop": "Leaves this file out. Nothing is uploaded for a row you drop.",
  };

  // WHERE THE POINTER HAS TO REST BEFORE ANYTHING APPEARS. Shorter than the
  // browser's own roughly one second, which is the "faster" half of what #133
  // asks for — a tooltip that arrives after a rider has given up and clicked is
  // a tooltip nobody reads. Not zero: a bubble that follows the pointer across a
  // toolbar is worse than no bubble at all.
  var HOVER_MS = 220;
  // The gap between the control and the bubble, and the gutter kept at the edge
  // of the window. Pixels rather than ems because both are about the pointer and
  // the screen rather than about type.
  var GAP = 8;
  var EDGE = 8;

  var el = null; // the bubble, built once and reused
  var host = null; // the control it is currently describing
  var timer = 0;
  var pending = null; // the control the timer is counting down for
  var seq = 0; // makes each show's id unique for aria-describedby

  function on() {
    // ABSENCE IS ON. There is no `data-tips="on"` — see src/views/tips.ts for
    // why this inverts the rule `data-motion` and `data-scheme` follow.
    return document.documentElement.getAttribute("data-tips") !== "off";
  }

  /**
   * Does this control have a name that survives losing its `title`?
   *
   * The accessible name computation takes `aria-labelledby`, then `aria-label`,
   * then the element's own content, then `title` — so anything with one of the
   * first three keeps its name and anything else is about to lose it.
   */
  function nameless(node) {
    if (node.getAttribute("aria-labelledby")) return false;
    if (node.getAttribute("aria-label")) return false;
    if (node.tagName === "INPUT" || node.tagName === "SELECT" || node.tagName === "TEXTAREA") {
      // A form control takes its name from a <label>, never from its contents.
      return !(node.labels && node.labels.length);
    }
    return !(node.textContent || "").trim();
  }

  /**
   * Takes the `title` off a control and hands back what it said.
   *
   * Stashed on the element rather than in a closure so a re-render — which
   * throws the element away and builds a new one carrying `title` again — starts
   * from a clean state instead of from a stale note about an element that no
   * longer exists.
   */
  function headOf(node) {
    var t = node.getAttribute("title");
    if (t) {
      node.setAttribute("data-tip-head", t);
      // The name has to be replaced BEFORE the title is removed, or there is a
      // frame in which the control is anonymous.
      if (nameless(node)) {
        node.setAttribute("aria-label", t);
        node.setAttribute("data-tip-named", "");
      }
      node.removeAttribute("title");
    }
    return node.getAttribute("data-tip-head") || "";
  }

  function build() {
    if (el) return el;
    el = document.createElement("div");
    el.className = "tip-bubble";
    el.setAttribute("role", "tooltip");
    el.hidden = true;
    document.body.appendChild(el);
    return el;
  }

  function hide() {
    clearTimeout(timer);
    timer = 0;
    pending = null;
    if (host) {
      host.removeAttribute("aria-describedby");
      host = null;
    }
    if (el) el.hidden = true;
  }

  /** Puts the bubble under the control, or over it when there is no room. */
  function place(node) {
    var r = node.getBoundingClientRect();
    // Measured after the content is in and while it is visible, or every box is
    // zero and the flip below never fires.
    var w = el.offsetWidth;
    var h = el.offsetHeight;

    var left = r.left + r.width / 2 - w / 2;
    if (left + w > window.innerWidth - EDGE) left = window.innerWidth - EDGE - w;
    if (left < EDGE) left = EDGE;

    var below = r.bottom + GAP;
    var above = r.top - GAP - h;
    // Below by default and above only when below genuinely does not fit —
    // preferring whichever has more room flips the bubble across the control
    // halfway down the page for no reason a rider can see.
    var top = below + h <= window.innerHeight - EDGE ? below : above >= EDGE ? above : below;

    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
  }

  function show(node) {
    var key = node.getAttribute("data-tip");
    var body = BODY[key];
    if (!body) return; // an unknown key keeps its native title—see wire()

    // A CONTROL WITH NO BOX GETS NOTHING. The timeline is `display: none` on an
    // undated ride and the scope button hides on a one-route ride, so the tree
    // routinely holds a marked control that is not on screen — and `place()`
    // would put its bubble in the top-left corner of the window, pointing at
    // nothing. A real pointer cannot reach a hidden element, but a synthetic
    // event can and so, one refactor from now, could a focus call.
    var box = node.getBoundingClientRect();
    if (!box.width && !box.height) return;

    build();
    var head = headOf(node);
    el.innerHTML = "";
    if (head) {
      var b = document.createElement("b");
      b.className = "tip-head";
      b.textContent = head;
      el.appendChild(b);
    }
    var p = document.createElement("span");
    p.className = "tip-body";
    p.textContent = body;
    el.appendChild(p);

    el.hidden = false;
    // `aria-describedby` RATHER THAN aria-hidden, which is what the field-help
    // bubble uses. That one is a popover a rider deliberately opens; this one
    // appears on focus, so leaving it out of the accessibility tree would mean a
    // keyboard user is the one person the feature never reaches. Described-by is
    // read AFTER the name and only when the tooltip is up, which is the shape
    // this is.
    el.id = "tip-" + ++seq;
    node.setAttribute("aria-describedby", el.id);
    host = node;
    place(node);
  }

  function armed(e) {
    var node = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;
    return node && BODY[node.getAttribute("data-tip")] ? node : null;
  }

  function wire() {
    // A KEY WITH NO COPY KEEPS ITS NATIVE TOOLTIP, which is the deliberate
    // fallback rather than an oversight: `armed()` refuses a control the table
    // does not know, so nothing is stripped and nothing is drawn, and the
    // control behaves exactly as it did before this file existed. An empty
    // bubble would be a worse answer than the browser's own.
    //
    // test/tips.test.ts is what stops that fallback becoming permanent — it
    // fails on a `data-tip` in the tree with no entry here.
    document.addEventListener(
      "pointerover",
      function (e) {
        // TOUCH IS EXCLUDED. A tap fires pointerover with nothing to follow it,
        // so a bubble opened here would sit on screen until something else
        // closed it — and the control underneath has already been pressed.
        if (e.pointerType === "touch") return;
        var node = armed(e);
        // MOVING WITHIN A CONTROL MUST NOT RESTART THE COUNTDOWN. pointerover
        // fires again for every child element crossed, and a button here is
        // routinely a glyph inside a span — so without this the delay never
        // elapses on exactly the controls that have any structure to them.
        if (!node || node === host || node === pending) return;
        hide();
        pending = node;
        timer = setTimeout(function () {
          show(node);
        }, HOVER_MS);
      },
      true,
    );

    document.addEventListener(
      "pointerout",
      function (e) {
        // `relatedTarget` is where the pointer went. Staying inside the same
        // control is not leaving it, and reading `e.target` alone would hide the
        // bubble every time the pointer crossed from a button to its own glyph.
        var node = armed(e);
        if (!node) return;
        var to = e.relatedTarget;
        if (to && node.contains(to)) return;
        hide();
      },
      true,
    );

    // NO DELAY ON FOCUS. A rider who has tabbed to a control has committed to
    // it, where a pointer crossing one has not.
    document.addEventListener(
      "focusin",
      function (e) {
        var node = armed(e);
        hide();
        if (node) show(node);
      },
      true,
    );
    document.addEventListener("focusout", hide, true);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") hide();
    });
    // A press means the rider is doing the thing rather than reading about it.
    document.addEventListener("pointerdown", hide, true);
    // Capture, because the builder's panel and the point list scroll inside the
    // page and neither of those scroll events reaches the window.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
  }

  // **READ ONCE, AT LOAD, AND `autosave.js` DELIBERATELY DOES NOT RE-STAMP IT.**
  // The appearance preference had to be re-stamped when /settings started
  // autosaving, because the palette IS the page and storing a choice that
  // changed nothing on screen is a page lying about what it holds. This one is
  // the opposite case: /settings carries no `data-tip` control at all — its `?`
  // dots are `fieldHelp`, a different mechanism — so there is nothing on that
  // page for a re-stamp to change. The setting applies on the next page a rider
  // opens, which is the builder, which is where the tips are.
  //
  // Making it live would mean checking the attribute per event AND putting every
  // stripped `title` back, which is real machinery for a state nobody can see.
  if (on()) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
    else wire();
  }

  // Exported for the test that pins the table against the `data-tip` keys in the
  // source, and for nothing else — no page calls this.
  window.TBTips = { BODY: BODY };
})();
