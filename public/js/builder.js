// The ride builder. State mirrors the /api/rides payload: ride meta plus an
// ordered array of routes, each a route/session of ordered stops, unordered POIs,
// and road-routed legs (legs[i] connects stops[i] → stops[i+1]).
//
// Every route is drawn on the map at once, always. The route slider changes which
// one is emphasized and never hides anything — seeing the whole ride on a single
// map is the point of the app, so dimming is the only thing focus does.
(function () {
  "use strict";

  // The interpunct data delimiter and the space around it, mirroring SEP in
  // src/views/sep.ts — read that file for why it is an en space rather than a
  // word space, and why it is written as an escape. test/sep.test.ts fails if
  // the three copies stop agreeing.
  const SEP = "\u2002\u00b7\u2002";
  const {
    esc,
    initMap,
    fitTo,
    onMapClick,
    panTo,
    addRouteLayers,
    removeRouteLayers,
    updateRouteTrack,
    setRouteDim,
    setRouteGhost,
    setLegHighlight,
    setMomentOverlay,
    setSearchPreview,
    highlightSearchPreview,
    setBedtimeMarks,
    setMeetApproaches,
    highlightMeetApproaches,
    clearLegHighlight,
    onRouteShapeDrag,
    consumeShapeClick,
    addMarker,
    removeMarker,
    onMarkerDragEnd,
    searchPlaces,
    mapCenter,
    viewportCircle,
    containerPixel,
    markerElement,
    initPanelToggle,
    initPanelResize,
  } = window.TBMap;

  initPanelToggle(() => state.map);
  initPanelResize(() => state.map);

  // The ride's time model is shared with the viewer so the two can never
  // disagree about what is happening at a given moment. See ride-time.js.
  const {
    legIsEstimated,
    legDurationS,
    routeIsEstimated,
    routeStoppedS,
    routeElapsedS,
    routeStartS,
    elapsedToPointS,
    clockMoment,
    routeSpan,
    rideSpan,
    rideSegments,
    segmentsTotalS,
    momentAtOffset,
    offsetAtMoment,
    activeAt,
    activeAtMoment,
    fmtMoment: fmtMomentRaw,
  } = window.TBTime;

  // ride-time.js is a PURE helper and reads no DOM, so the rider's date format
  // and clock are handed to it rather than looked up inside (#270). One wrapper
  // here keeps all five call sites reading exactly as they did.
  const fmtMoment = (s) => fmtMomentRaw(s, window.TBFmt && window.TBFmt.timePrefs());

  // Twistiness, computed here rather than read from the ride: the stored figure
  // is whatever the geometry looked like at the last save, and this panel has to
  // be right while the rider is still moving stops around. See twist.js for why
  // there are two implementations and what keeps them honest.
  const { routeTwistiness, twistLabel, twistRank, twistScale } = window.TBTwist;

  // Category-vs-name detection and the place-type to role map. See
  // public/js/place-query.js — pure, and pinned by test/place-query.test.ts.
  const QUERY = window.TBQuery;

  // Pure drag-to-shape arithmetic — see route-shape.js.
  const { legAtVertex, nearestVertexIndex, viaInsertIndex, pointAtDistance, snapToTrack } = window.TBShape;
  const { sliceBetween, circlePath, haversineM, rejoinSpans } = window.TBShape;

  // Turning a SortableJS drop into a position in route.points — see drag-index.js.
  const DRAG = window.TBDragIndex;

  const MILE = 1609.344;

  // Miles or kilometers — see public/js/units.js, which mirrors
  // src/views/units.ts and is pinned to it by test/units-client.test.ts.
  const UNITS = window.TBUnits ? window.TBUnits.toUnits(window.TB.units) : "imperial";
  const distUnit = window.TBUnits ? window.TBUnits.distanceUnit(UNITS) : "mi";

  // Cumulative and since-refuel distance — see public/js/route-distance.js. Pure,
  // meters throughout, and it formats nothing: the unit is the rider's, applied
  // here at the point of display.
  const DIST = window.TBDistance;

  // Cutting a route in two — see public/js/route-split.js. Pure, and the uid minter
  // is passed in, so the identity a carried point gets is this file's to mint.
  const SPLIT = window.TBSplit;

  // How far off the route's line a place is — see public/js/corridor.js. Pure
  // geometry; the searching and the spending live below.
  const CORRIDOR = window.TBCorridor;

  // Where the rider would be at a scrubbed moment, and how much fuel is left
  // there. See public/js/range-circle.js.
  const RANGE = window.TBRange;

  /** Meters as the rider's own unit, rounded to a whole one. Distances in the
   *  panel are read at a glance against a tank, so a decimal is noise. */
  const fmtDist = (m) => Math.round(window.TBUnits.distanceFrom(m, UNITS)) + " " + distUnit;
  const MAX_ROUTES = 31; // matches MAX_ROUTES in src/routes/rides.ts
  // Mirrors MAX_POINTS / MAX_STOPS in src/maps/ride-graph.ts. One cap over the
  // whole list, plus a separate ceiling on how many of them may be routing
  // anchors — promoting 400 POIs would be 399 Directions calls.
  const MAX_POINTS = 400;
  const MAX_STOPS = 200;
  const MAX_LINKS = 5;

  // A point's durable identity. Mirrors newUid() in src/maps/uid.ts and is pinned
  // to it by test/point-details.test.ts — same alphabet, same length, or the save
  // 400s.
  //
  // Minted on the CLIENT because a rider can type a confirmation number into a
  // stop before any save has happened, and those details need something to hang
  // on. crypto.getRandomValues over Math.random: a repeat inside one save
  // violates the per-route unique index. Bytes at or above 252 are discarded, or
  // 256 % 36 biases the first four symbols.
  const UID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
  // The group every ride starts with. Named rather than blank because it is
  // rendered in a <select> and in the route pickers, where an unnamed option is
  // an empty row nobody can aim at; the rider renames it if they want to, which
  // is what "optional name" means here.
  function seedGroup() {
    return { uid: uid(), name: "Group 1", color: ROUTE_COLORS[0] };
  }

  function uid() {
    let out = "";
    while (out.length < 12) {
      const buf = new Uint8Array(12);
      crypto.getRandomValues(buf);
      for (const b of buf) {
        if (b >= 252) continue;
        out += UID_ALPHABET[b % 36];
        if (out.length === 12) break;
      }
    }
    return out;
  }

  // A stop or POI as it is born: an identity, and no details until the rider
  // opens the editor. `details: null` rather than an empty object so that
  // "nothing filled in" is one representation rather than two, matching what the
  // server stores and what loadRidePayload sends back.
  /**
    * A ROUTE MUST KEEP A STOP, and this is the one place that rule is applied.
    *
    * `routeSchema` refuses a route with no stop and `payload()` cannot send one, so
    * a route that loses its last one can no longer be saved — with a server message
    * that names an array index and ellipsizes to nothing in the status box. #233.
    *
    * It was five hand-written copies until 2026-09-03, and addRoute() was the one
    * without it: its seed was a bare object with no `kind`, `kind` defaults to
    * `poi`, and addPoint() promotes nothing on a non-empty route — so every route
    * after the first had no stop and every save of that ride failed forever.
    */
  function ensureRouteHasStop(route) {
    if (route && route.points.length > 0 && stopsOf(route).length === 0) route.points[0].kind = "stop";
    return route;
  }

  // `address` is the place's own street address as Google gave it, or "" for a
  // point the rider dropped on the map — nothing geocodes one after the fact.
  // It is PUBLIC and rides in the payload beside the name; the owner-only
  // address a rider types by hand lives on `details` and is a different field.
  function newPoint(lng, lat, name, address) {
    return {
      // THE BASELINE TYPE. Ziad's call, 2026-08-23: a point is a POI until it is
      // promoted, so nothing has to be decided at the moment of creation — which
      // is the moment a rider knows least about the place they just dropped.
      kind: "poi",
      lat: +lat.toFixed(6),
      lng: +lng.toFixed(6),
      name: name || "",
      address: address || "",
      description: "",
      roles: [],
      durationMin: null,
      // Time only a LATE group spends, and meaningful on a meeting point alone
      // — see points.slack_min. Null is not zero: null is nobody set any.
      slackMin: null,
      uid: uid(),
      details: null,
    };
  }

  // --- One ordered list -----------------------------------------------------
  //
  // A route holds ONE array, `points`, in the rider's order, and `kind` says only
  // whether the rider means to STOP there. It replaced `route.stops` and
  // `route.pois`, where stopness was which array an object sat in and a POI had
  // no stored order at all.
  //
  // ONE INDEX SPACE, as of 2026-08-24. `legs[i]` joins `points[i]` to
  // `points[i+1]`, whatever kind either end is, so a point's position IS its leg
  // index. stopIdx() and stopOrdinalAt() are gone with the second index space.
  //
  // stopsOf() survives for the things that genuinely count stops rather than
  // points: the row numbering, the at-least-one-stop guard, and an alternate
  // group's endpoints.
  const stopsOf = (route) => route.points.filter((pt) => pt.kind === "stop");

  // The rider's saved-place library, loaded once when the builder opens.
  //
  // Held in memory rather than re-fetched per keystroke: one rider's own list,
  // bounded at 500 by MAX_PLACES, and matching locally is what puts a saved place
  // in the search list instantly and for free.
  //
  // A failure is silent and non-fatal — saved places are an accelerant, not a
  // dependency.
  let savedPlaces = [];
  async function loadSavedPlaces() {
    try {
      const res = await fetch("/api/places");
      if (!res.ok) return;
      const data = await res.json();
      savedPlaces = (data.sections || []).flatMap((sec) =>
        (sec.places || []).map((pl) => ({ ...pl, groupName: sec.group ? sec.group.name : "" })),
      );
    } catch (e) {
      console.warn("[builder] saved places unavailable:", e);
    }
  }

  // Substring match on name, group and address, cheapest thing that works on a
  // list this size. Matches from ONE character rather than three: the Google
  // search waits for three because each call is billed, and this one costs
  // nothing.
  function matchSavedPlaces(q) {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return savedPlaces
      .filter((pl) => (pl.name + " " + (pl.groupName || "") + " " + (pl.address || "")).toLowerCase().includes(needle))
      .slice(0, 5);
  }

  // The client half of placeToStop() in src/places/policy.ts. A saved place is
  // COPIED into the ride and keeps no reference back — see the table comment in
  // src/db/schema.ts — so this builds a plain point and nothing ties it to the
  // row it came from.
  //
  // Only the DURABLE half of the details travels: a phone number is a fact about
  // the place, a confirmation number is a fact about one trip.
  function stopFromPlace(pl) {
    const durable = Boolean(pl.phone || pl.address || (pl.links || []).length);
    const pt = newPoint(pl.lng, pl.lat, pl.name, pl.address);
    pt.roles = (pl.roles || []).slice();
    if (durable) {
      pt.details = {
        ...blankDetails(),
        phone: pl.phone || "",
        address: pl.address || "",
        links: (pl.links || []).map((l) => ({ ...l })),
      };
    }
    return pt;
  }

  // Saves a stop into the rider's library.
  //
  // Sends only the DURABLE half of its details: a phone number belongs to the
  // place, a confirmation number to one trip, and sending the second would put
  // last September's booking on every future ride.
  //
  // The copy is independent from here on, in both directions — the
  // copy-not-reference decision.
  async function savePointAsPlace(point) {
    if (!point) return;
    if (!point.name.trim()) return toast("Give the stop a name first", true);
    const d = point.details || {};
    try {
      const res = await fetch("/api/places", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: point.name.trim(),
          lat: point.lat,
          lng: point.lng,
          roles: point.roles || [],
          phone: d.phone || "",
          address: d.address || "",
          links: (d.links || []).filter((l) => l.url),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return toast(data.error || "Could not save that place", true);
      // Pushed into the in-memory list rather than re-fetching, so the place is
      // searchable on the very next keystroke without a round trip.
      savedPlaces.push({ ...data, groupName: "" });
      toast("Saved to your places");
    } catch (e) {
      toast("Could not save that place", true);
    }
  }

  function blankDetails() {
    return { confirmation: "", checkInAt: null, checkOutAt: null, phone: "", address: "", links: [], notes: "" };
  }

  // Which detail fields a stop shows, keyed off its roles: a hotel wants check-in
  // and a confirmation number, a food stop a reservation time, and fourteen
  // inputs for a gas stop is how a feature stops being used. Notes and links are
  // on everything.
  //
  // A stop with no roles gets the full set rather than the minimum — an
  // uncategorized stop with fields hidden looks broken.
  const LODGING_ROLES = ["hotel", "camp"];
  const TABLE_ROLES = ["food", "coffee", "drinks", "grocery"];
  function detailFieldsFor(roles) {
    const has = (set) => (roles || []).some((r) => set.indexOf(r) >= 0);
    const base = ["notes", "links"];
    if (has(LODGING_ROLES)) return ["confirmation", "checkInAt", "checkOutAt", "phone", "address"].concat(base);
    if (has(TABLE_ROLES)) return ["confirmation", "checkInAt", "phone", "address"].concat(base);
    if (!roles || roles.length === 0) {
      return ["confirmation", "checkInAt", "checkOutAt", "phone", "address"].concat(base);
    }
    return ["phone", "address"].concat(base);
  }

  // Anything filled in at all — what badges the row so a rider can see which
  // stops carry detail without opening each one.
  function hasDetails(d) {
    if (!d) return false;
    return Boolean(
      d.confirmation || d.checkInAt || d.checkOutAt || d.phone || d.address || d.notes || (d.links || []).length,
    );
  }
  // Matches MAX_VIAS_PER_LEG in src/maps/ride-graph.ts, which the save path
  // enforces. Refusing the 21st here is the difference between a rider being
  // told now and a whole ride failing to save later.
  const MAX_VIAS_PER_LEG = 20;

  // Injected by the page shell from src/maps/palette.ts, the same way
  // window.TB.roles carries the role table. The importer colors the routes of a
  // folder import server-side, so the palette cannot live only in here.
  const ROUTE_COLORS = window.TB.routeColors;

  // How the stop dwell field reads, from the rider's profile — 'hours', 'hm' or
  // 'minutes'. It is a DISPLAY choice and nothing below it stores anything
  // differently: point.durationMin is integer minutes whatever this says, which
  // is what keeps every export, the roadbook and the timeline out of it.
  //
  // Read once at load rather than per row. Changing it is a page load, because it
  // is set on /settings and the builder is a different page.
  const DUR = window.TBDuration;
  const durFormat = DUR.toFormat(window.TB.durationFormat);

  // WHETHER THIS RIDER MAY WRITE. A hint, never the gate — the server refuses a
  // PUT from anybody below `edit` whatever this says (#190). What it buys is a
  // page that does not offer an edit it cannot keep.
  //
  // Defaults to TRUE on a missing value: the new-ride page has no roster, and an
  // older cached page that predates the key must keep working.
  const CAN_EDIT = window.TB.canEdit !== false;

  // WHETHER THIS RIDER MAY PROPOSE A CHANGE. `suggest` is the DEFAULT an
  // invitation grants, so this is the common case for anybody who is not the
  // owner — and it is what makes the read-only builder useful rather than a
  // museum: a rider edits a route locally, presses Suggest, and the owner takes it
  // or leaves it. Nothing they do is saved to the ride.
  const CAN_SUGGEST = window.TB.perm === "suggest" || CAN_EDIT;

  // Alternates: the numbering, the active-route filter and the ride rollup. The
  // builder is the only client that calls resolveAltGroups — it is the one
  // editing routes, and repairing locally is what keeps the panel, the map and
  // the totals agreeing before the next save round trip. The server resolves
  // again on save regardless, and its answer wins.
  const ALT = window.TBAlt;

  const newRoute = (color) => ({
    title: "",
    color: color || ROUTE_COLORS[0],
    startAt: null,
    endAt: null,
    // Session-only: see inferEndManual(). Never part of payload().
    endManual: false,
    // The route's durable identity, minted here the way a point's is. It DOES go
    // in payload() and it DOES come back in loadExisting(); mirror of
    // `routes.uid` in src/db/schema.ts. Votes on an alternate are keyed by it, so
    // a route that loses its uid loses its votes silently.
    uid: uid(),
    // WHOSE DAY THIS IS, by subgroup uid. Null means everyone rides it, which
    // is what a new route always is: tagging one is something a rider does to a
    // route that already exists, the same as grouping it as an alternate.
    subgroupUid: null,
    // Alternates. A new route is always a plain one — grouping is something a
    // rider does to routes that already exist. Both fields DO go in payload() and
    // both come back in loadExisting(); see src/maps/alts.ts for what they mean
    // and why the group id is not stable across a save.
    altGroup: null,
    altActive: true,
    // What this route asks of the router (#29). Null is no preference, which is
    // what a new route always is — the server normalizes {} to null on save, so
    // there is only ever one spelling of it in the column.
    routePrefs: null,
    // One ordered list of both kinds, and legs[i] joins points[i] to points[i+1]
    // whatever kind either end is — see the One ordered list block above.
    points: [],
    legs: [],
  });

  // THE NAME A RIDE HAS BEFORE ANYBODY NAMES IT. Ziad's call, 2026-08-24.
  //
  // A ride used to be unsaveable without a title, so autosave never fired and a
  // rider who dropped three pins and closed the tab lost all three to a naming
  // rule. That is the defect, not the missing name.
  //
  // Visible and pre-filled rather than a placeholder, which would leave `title`
  // genuinely empty and still be refused server-side. The field selects itself on
  // focus, so the first keystroke replaces it.
  const UNTITLED = "Untitled ride";

  // Built before the state literal so the seed's uid can be the main group in
  // the same breath: `primarySubgroup` may never be null, and setting it
  // afterwards is a second statement somebody can forget to keep.
  const SEED_GROUP = seedGroup();

  const state = {
    map: null,
    // Which row has its category picker open, as {route, i}, or null.
    //
    // In state rather than in the DOM because picking a category now changes the
    // point's KIND, which renumbers every stop after it — so the row has to be
    // re-rendered, and a picker whose openness lived only in a `hidden` attribute
    // would slam shut after every icon tap.
    rolesOpen: null,
    // Which gap between two points has its add-row open, as {route, at}, or null.
    // `at` is an index into route.points: 0 is before the first point, and
    // route.points.length would be the bottom row, which is always there anyway.
    insertAt: null,
    rideId: window.TB.rideId || null,
    // WHAT THIS BUILDER'S WORK IS BASED ON. Sent with every save and compared
    // server-side; a mismatch means somebody else wrote to this ride since it
    // was loaded, and the save is refused rather than applied.
    //
    // Null on a ride that has never been loaded from the server — a brand-new
    // one, or a session that predates this — and the server reads a missing rev
    // as unchecked, which is the same behavior the builder had before.
    rev: null,
    // What each route looked like when this builder last saw it, as {uid: hash}.
    // Echoed with every save so the server merges per route instead of refusing the
    // whole ride because somebody renamed route 4.
    //
    // THE WHOLE SET, not a field on each route in state.routes. A route this rider
    // DELETED is absent from the payload, and its base hash is the only thing
    // separating "I deleted this" from "somebody else added this" — which need
    // opposite answers.
    routeBase: {},
    // Set when a save is refused as stale. It STOPS THE AUTOSAVE LOOP: a retry
    // is not a recovery here, it is a second attempt to overwrite whatever the
    // other rider just wrote. Cleared only by reloading the ride.
    conflict: false,
    // The public slug, for the Riders tab's link out to the roster page. Null
    // until the first save mints one — showViewLink() is where it lands, because
    // that is already the one place a slug reaches this file.
    slug: window.TB.slug || null,
    meta: {
      title: "",
      description: "",
      visibility: "private",
      external_url: "",
      // SUBGROUPS ARE RIDE-LEVEL — several routes reference one and a rider is
      // assigned to one across the whole ride. Each is {uid, name, color}; the uid is
      // minted here because the server's ids do not exist until the first save.
      //
      // A RIDE ALWAYS HAS AT LEAST ONE, SEEDED RATHER THAN ASKED FOR. Ziad's call,
      // 2026-09-03: planning a route means a rider is riding it, which is a group of
      // one. The empty list was what made every group feature read as opt-in
      // machinery.
      subgroups: [SEED_GROUP],
      // THE MAIN GROUP, and it is never null. Whose clock is pinned and whose
      // road the other groups join — one setting since #239, see
      // rides.primary_subgroup_id. A uid, always pointing at a group that
      // exists.
      primarySubgroup: SEED_GROUP.uid,
      // Dead since #239 and read by nothing; kept on the payload so a save does
      // not clear a column older rides may still carry.
      trunkSubgroup: null,
      // Which event is pinned: "departure", "meet" or "arrival".
      timeAnchor: "departure",
      // WHEN THE RIDER WANTS TO BE LOOKING FOR A BED, minutes from midnight, or
      // null for "they have not said" — which is most rides, and the whole
      // feature is quiet until they do. A wall clock at the departure point, see
      // rides.stop_by_min.
      stopByMin: null,
      // WHICH VEHICLE THIS RIDE IS FOR (#321), or null for "not said" — the
      // rider's own default, which is what TBVocab resolves to. The words on
      // every rider-facing string in this file follow it through TBVocab.
      vehicle: null,
      power: null,
    },
    routes: [newRoute()],
    // WHICH FEATURE OWNS THE MAP'S PREVIEW DOTS — "search", "meet" or null.
    // The last proposal, whole, so taking one group's meeting point can re-render
    // the sections for the groups still undecided. Null until the button is
    // pressed and again the moment a press fails.
    meet: null,
    // The sentence about the decision just made, held for the same reason the
    // proposal is — the panel that shows it is rebuilt whenever a route changes.
    meetNote: "",
    // `setSearchPreview` is one slot and two features draw into it, so the one
    // that did not put them there must not clear them: see hideSearchResults.
    previewOwner: null,
    // The active route, as a plain index into state.routes. It is where a map click
    // puts a stop and which route the map emphasizes; it is NOT a filter, because
    // every route is on screen at once.
    //
    // It was `focus`, a 0..N slider value with 0 meaning "all routes". Both the
    // off-by-one and the null-means-all case went with the slider.
    active: 0,
    // The timeline's position, in epoch seconds, or null for "no moment
    // chosen". When it is set it is the single source of what is emphasized:
    // the route containing it, and the leg being ridden at it. The route slider
    // does not compete with this — moving it just picks a new moment (that
    // route's start), so there is one model and two ways to drive it. Null falls
    // back to plain route focus, which is what an undated ride always uses.
    moment: null,
    // WHAT THE TIMELINE SPANS: "route" (the active route) or "ride" (all of it).
    //
    // Route by default, which fixes two reports at once. #222: a slider stretched
    // over a 72-hour ride spends most of its travel on the overnights, so an hour
    // of Saturday afternoon came out at a few pixels. #214: the lit route was
    // whichever one the MOMENT fell in, so clicking into route 3 left it dimmed
    // behind wherever the timeline was parked. Scoped to the active route the two
    // cannot disagree.
    //
    // Ride scope stays behind the button in the bar — a real thing to want, just
    // not while building. Session-only: it is a way of looking at the ride for a
    // minute, not a preference about it. Ziad's call, 2026-08-30.
    timeScope: "route",
    // #50's search scope. FALSE means a category chip searches near the route's last
    // point; TRUE means along the whole line, keeping what falls inside CORRIDOR_MI.
    // Session-only and shared across routes, like timeScope.
    // #229's fuel ring, on or off. Session-only and ride-wide for the same reason,
    // and on by default — a rider who finds a 300-mile circle in the way turns it
    // off.
    ringOn: true,
    corridorOn: false,
    // HOW MUCH FURTHER OUT OF THEIR WAY THAN NECESSARY A JOINING GROUP MAY BE
    // SENT, in miles, for the next meeting-point press. Session-only and
    // ride-wide for the same reason as the two above: it is how the planner is
    // asking the question right now. SEEDED FROM THE RIDER'S PREFERENCE (#370)
    // — the page renders the dial from the same number, so the box and the
    // state agree before anybody touches either.
    maxDivertMi: window.TB.maxDivertMi || 10,
    // Who is on which route, resolved server-side. NULL until it loads — the row
    // renderer checks, because a line that guessed "everyone" before the fetch
    // landed would flicker to the truth on exactly the routes where the truth is
    // interesting. Not part of the payload: route_riders is reconciled by uid like
    // votes and point details rather than churned with the graph.
    routeRiders: null,
    // markers[r] = { stops: [{marker, el}], pois: [{marker, el}] }
    markers: [],
    // WHICH DAY IS WAITING FOR A MAP CLICK, or null. Set by a route's "+ Stop"
    // button and cleared by the click that satisfies it.
    //
    // One value rather than a boolean plus a route index: two fields can disagree
    // with each other, and the disagreement here would put a stop on the wrong
    // route silently. Every armed button re-derives its own state from this, so
    // there is no class anybody has to remember to move.
    arm: null,
    dirty: false,
    // A flush is in flight. Declared rather than sprung into existence by the
    // first assignment, because autosave now READS it before any save has run.
    saving: false,
    layersReady: false,
    layerCount: 0, // how many route layers are currently on the map
    legSeq: [], // legSeq[r][i]—stale routing responses are dropped
    // SELECT MODE, or null when off:
    //   { scope: "route" | "point", routes: Set<int>, points: Set<"route:kind:i"> }
    //
    // ON state, DELIBERATELY NOT ON A ROUTE OR A POINT: snapshot() in
    // builder-history.js reads only state.meta and state.routes, so a sibling key
    // here can never ride into the undo stack. A `selected` flag on a route would,
    // and would then have to be stripped in payload() the way endManual is.
    //
    // Points are keyed "routeIndex:kind:i", never held as references — HIST.restore
    // builds fresh objects on undo. Indices are safe because every bulk action,
    // undo and structural render clears the selection.
    select: null,
  };

  const $ = (id) => document.getElementById(id);

  // WHICH ROUTE EDITS LAND ON — the last route the rider touched, and the only
  // thing it decides is where a map click puts a new stop.
  //
  // It was `state.focus`, a 0..N slider where 0 meant "All routes". Two things
  // went with the slider: the null case, which left edits nowhere to land, and the
  // off-by-one that is why this pair of helpers existed.
  //
  // Clamped rather than allowed to go stale: deleting route 3 of 3 must leave the
  // index pointing at a route that exists, which every caller here assumes.
  const activeIndex = () => {
    if (!state.routes.length) return null;
    return Math.max(0, Math.min(state.routes.length - 1, state.active | 0));
  };
  // Kept under their old names because eighteen call sites read them and none of
  // them cared which route it was, only that it was the one being edited.
  const editIndex = activeIndex;
  const focusedIndex = activeIndex;
  const editRoute = () => {
    const r = activeIndex();
    return r == null ? null : state.routes[r];
  };

  // Makes a route the active one. Cheap and idempotent, because every row and
  // section handler calls it before doing anything else — that is what lets the
  // edit handlers go on reading editIndex() without each of them being rewritten
  // to take a route.
  function setActive(r) {
    const next = Math.max(0, Math.min(state.routes.length - 1, r | 0));
    if (state.active === next) return;
    state.active = next;
    // THE MOMENT FOLLOWS THE ROUTE, and in route scope it has to: the slider is
    // about to be re-ranged, and a moment left over from the last route is off the
    // end of its own travel. Snapping to the route's opening is where goToRoute()
    // has always put it. A moment already inside the new route is kept.
    //
    // Ride scope is deliberately NOT clamped — its job is to look across the ride,
    // and yanking the thumb because the rider clicked a name field is the jump the
    // split between this and goToRoute() exists to avoid.
    if (state.timeScope === "route" && state.moment != null) {
      const span = routeSpan(state.routes[next]);
      if (!span) state.moment = null;
      else if (state.moment < span.from || state.moment > span.to) state.moment = span.from;
    }
    markActiveSection();
    renderTimeline();
    applyFocus();
    renderRailRoutes();
    renderTotals();
    // The active route IS what this rider is working on, so it is the claim. Every
    // row and section handler already calls setActive before doing anything
    // else, which is why the claim needs no second set of hooks.
    LIVE.claim(state.routes[next] && state.routes[next].uid);
  }

  // Reads the route off whatever was clicked. Every .route-section and every
  // .point-row carries data-route, so one lookup covers both.
  function setActiveFromEl(el) {
    const host = el && el.closest("[data-route]");
    if (host) setActive(Number(host.dataset.route));
  }

  // --- Toast + status -------------------------------------------------------

  let toastTimer = null;
  function toast(msg, isError) {
    let el = $("tb-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "tb-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = isError ? "error" : "";
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
  }

  // Reached only when something slipped past the disabled controls — a stale
  // Kept as the backstop for "there is no route at all", which is now the only way
  // editIndex() returns null — a ride always has at least one route, so in practice
  // this fires for nothing. It used to cover the slider's "All routes" position,
  // where every route-level control was live but had nowhere to act.
  function noRouteYet() {
    toast("Add a route first", true);
  }

  // Undo/redo and the crash draft. The logic lives in builder-history.js so it
  // can be tested without a DOM; everything here is the wiring.
  const HIST = window.TBHistory;
  const history_ = HIST.createHistory();
  let draftTimer = null;
  let draftFailed = false;

  // Called at the TOP of every content mutation, before the change lands —
  // markDirty() runs after, which is why the two are separate. `coalesce` is a
  // stable key for a run of keystrokes on one field, so typing a name is one
  // undo step rather than one per letter.
  function beginEdit(label, coalesce) {
    history_.push(HIST.snapshot(state), label, coalesce);
    renderHistoryButtons();
  }

  function renderHistoryButtons() {
    const u = $("undo");
    const r = $("redo");
    if (!u || !r) return;
    u.disabled = !history_.canUndo();
    r.disabled = !history_.canRedo();
    u.title = history_.canUndo() ? "Undo " + history_.undoLabel() : "Nothing to undo";
    r.title = history_.canRedo() ? "Redo " + history_.redoLabel() : "Nothing to redo";
  }

  // The ride name is a TEXTAREA, so its height is ours to set — the price of a
  // heading that wraps. Nothing sizes it to its content unless this does.
  //
  // Resetting to "auto" first is load-bearing: scrollHeight reports the larger of
  // the content and the current box, so without it the field grows and never
  // shrinks back.
  //
  // The two-line ceiling is a max-height in _builder.scss, not a number here, so
  // the type size and the clamp cannot drift apart.
  function fitTitle() {
    const el = $("ride-title");
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  // There is no single render() in this file — this is the sequence init() runs,
  // plus the three inputs that no render function touches (they are written
  // only by loadExisting), which would otherwise keep showing pre-undo text.
  function renderEverything() {
    // FIRST, before anything renders a word: it tells TBVocab which vehicle
    // the strings below are for.
    renderVehicle();
    rebuildLayers();
    renderMarkers();
    renderRoutes();
    refreshDerived();
    $("ride-title").value = state.meta.title;
    $("ride-description").value = state.meta.description;
    setFieldValue("ride-visibility", state.meta.visibility);
    renderStopBy();
    // Undo can shorten the name as easily as lengthen it, and the field will not
    // notice either on its own.
    fitTitle();
  }

  function applyUndo(dir) {
    const entry = dir === "redo" ? history_.redo(HIST.snapshot(state)) : history_.undo(HIST.snapshot(state));
    if (!entry) return;
    HIST.restore(state, entry.snap);
    // The selection is keyed by index and the route and point arrays have just
    // been replaced wholesale, so every key in it may now name something else.
    // Dropped rather than remapped: there is no honest remapping of "the third
    // stop of route 2" across an undo that removed route 1.
    state.select = null;
    renderEverything();
    renderSelectBar();
    renderHistoryButtons();
    markDirty();
    toast((dir === "redo" ? "Redid " : "Undid ") + entry.label);
  }

  // Debounced rather than on a timer: a localStorage write of this size is
  // sub-millisecond, so waiting a minute would only buy up to a minute of lost
  // work. Two seconds of idle is close enough to continuous.
  function queueDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      const ok = HIST.Draft.write(state.rideId, state);
      // Silence here would be the worst outcome: a rider who believes a draft
      // exists and finds nothing after a crash. Say it once, not every 2s.
      if (!ok && !draftFailed) {
        draftFailed = true;
        toast("This ride is too big to keep a recovery copy—save often", true);
      }
    }, 2000);
  }

  // Sets a field that MAY NOT EXIST. The visibility select is rendered for the
  // owner only — the PUT ignores it from a non-owner, and a select that silently
  // does nothing is worse than none — so every read and write tolerates absence.
  //
  // Not hypothetical: an unguarded `.addEventListener` threw during init(), which
  // unwound before the ride loaded, and a member opening a shared ride got a
  // blank map called "Untitled".
  function setFieldValue(id, value) {
    const el = $(id);
    if (el) el.value = value;
  }

  // The two vehicle selects follow state, and TBVocab follows them: every
  // string this file builds goes through W()/Ws() below, so a change here is
  // a re-render away from every label agreeing. `"" ` is "my default".
  function renderVehicle() {
    setFieldValue("ride-vehicle", state.meta.vehicle || "");
    setFieldValue("ride-power", state.meta.power || "");
    if (window.TBVocab) window.TBVocab.setRide({ vehicle: state.meta.vehicle, power: state.meta.power });
  }

  // What the app calls things (#321): the singular, the plural, and either
  // capitalized. Falls back to the motorcycle words when vocab.js is absent,
  // which is what every string here read before.
  const W = (id) => (window.TBVocab ? window.TBVocab.w(id) : FALLBACK_WORDS[id][0]);
  const Ws = (id) => (window.TBVocab ? window.TBVocab.many(id) : FALLBACK_WORDS[id][1]);
  const Wc = (id) => cap(W(id));
  const Wsc = (id) => cap(Ws(id));
  const fuelOff = () => !!(window.TBVocab && window.TBVocab.off("fuel"));
  const FALLBACK_WORDS = {
    journey: ["ride", "rides"],
    travel: ["riding", "riding"],
    vehicle: ["bike", "bikes"],
    person: ["rider", "riders"],
    storage: ["paddock", "paddocks"],
    curvy: ["twisty", "twisty"],
    route: ["route", "routes"],
    roadbook: ["roadbook", "roadbooks"],
    fuel: ["gas", "gas"],
    refuel: ["fill up", "fill up"],
    tank: ["tank", "tanks"],
    station: ["gas station", "gas stations"],
    dry: ["runs dry", "runs dry"],
    highway: ["highway", "highways"],
  };
  function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }
  function an(word) {
    return (/^[aeiou]/i.test(word) ? "an " : "a ") + word;
  }

  function markDirty() {
    // THE READ-ONLY BUILDER STOPS HERE, and this is the only place it needs to.
    // Every edit funnels through markDirty, so nothing goes dirty, no recovery draft
    // is filed and no autosave arms — rather than attempting a save and being
    // refused, which shows a rider an error for something they were never allowed
    // to do. Not routed through saveBlockReason(), which reports a condition the
    // rider can CLEAR.
    //
    // A SUGGESTER IS THE EXCEPTION AND STILL GOES NO FURTHER: their edits live in
    // `state` so there is something to propose, but there is nothing to save.
    if (!CAN_EDIT) {
      if (CAN_SUGGEST) renderSuggestBar();
      return;
    }
    state.dirty = true;
    editSeq++;
    setSaveStatus("dirty");
    queueDraft();
    queueAutosave();
  }

  // --- Autosave -------------------------------------------------------------
  //
  // There is no Save button. A flush is a plain PUT of the whole ride, affordable
  // because it makes NO billable Maps call — the money is in the routing request,
  // which keeps its own debounce in computeLeg().
  //
  // Two timers, and the second is the one that matters: an idle debounce alone has
  // no upper bound, so dragging a stop around for four minutes never saves. The
  // ceiling fires regardless of activity, measured from the first edit after a
  // clean state. Both are far under the five-minute acceptance bar, which is what
  // must never be exceeded rather than what to aim for.
  const AUTOSAVE_IDLE_MS = 3000;
  const AUTOSAVE_MAX_MS = 20000;
  // After a failed flush. Long enough not to hammer a server that is down,
  // short enough that a dropped wifi connection recovers on its own.
  const AUTOSAVE_RETRY_MS = 15000;

  let idleTimer = null;
  let ceilingTimer = null;
  let retryTimer = null;

  // WHICH EDITS A COMPLETED SAVE ACTUALLY COVERS, and getting this wrong is
  // silent data loss rather than a visible bug.
  //
  // payload() serializes when the fetch STARTS, so a keystroke during the round
  // trip is not in that request — but the response says "saved", and clearing
  // state.dirty on success marks that keystroke saved. Every later flush then
  // returns early on `!state.dirty` and it is never sent, with the status
  // reading "Saved" throughout.
  //
  // markDirty() bumps editSeq; save() records it before the fetch and compares
  // after. Equal means the response covers everything. (A boolean set by
  // flushNow() was the first version and missed the common case: typing does not
  // call flushNow().)
  let editSeq = 0;

  // Why a flush cannot happen, in the rider's words, or null.
  //
  // save() used to enforce these two with a toast and a focus jump, which is
  // wrong for autosave: a rider who has not typed a title yet is mid-task, not
  // in error. The status line states the condition and waits.
  //
  // A ride that has never been saved and carries no points is NOT STARTED rather
  // than blocked — #290, where a rider who created a ride and typed its name got
  // the save-failure modal three seconds later.
  //
  // GATED ON `rideId` AND NOT ON THE POINTS ALONE, which is the whole care here:
  // a ride that HAS been saved and is then emptied cannot save either, and there
  // the rider has a real deletion that is not persisting, so going quiet would
  // hide it. That case keeps saveBlockReason() and the dialog.
  //
  // Nothing is at risk in the case this covers — the ride does not exist yet, so
  // there is no stored version to fall behind.
  function notStartedYet() {
    return !state.rideId && !state.routes.some((r) => r.points.length > 0);
  }

  function saveBlockReason() {
    // NO TITLE CHECK. An unnamed ride saves as UNTITLED — blocking it was the bug
    // rather than the safeguard. A ride with no points still cannot save, and that
    // one is real: the API requires a stop per route.
    // A NEVER-SAVED RIDE NEVER REACHES THIS — flushNow() returns at notStartedYet()
    // first. What is left is a stored ride emptied of every point, where the
    // deletion is genuine work that is not persisting.
    if (!state.routes.some((r) => r.points.length > 0)) return "Needs a stop";
    // A ROUTE WITH POINTS BUT NO STOP IS THE #233 SHAPE, CAUGHT HERE SO THE MESSAGE
    // CAN NAME THE ROUTE. The server refuses it as `routes.1: a route needs at least
    // one stop` — an index a rider cannot count to, in a box that ellipsizes it.
    //
    // ensureRouteHasStop() means the builder can no longer CREATE this shape, so in
    // practice it fires for a ride that was already broken. Kept for the reason the
    // API's refine is: a check that cannot fire costs nothing, and this one could
    // not fire for two weeks.
    const noStop = state.routes.find((r) => r.points.length > 0 && stopsOf(r).length === 0);
    if (noStop) {
      return routeLabel(state.routes.indexOf(noStop)) + " has no stop—give a point a category, or make one a stop";
    }
    return null;
  }

  function queueAutosave() {
    clearTimeout(retryTimer);
    retryTimer = null;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(flushNow, AUTOSAVE_IDLE_MS);
    // Only armed once per dirty run — re-arming it on every keystroke would make
    // it a second idle timer and give back the unbounded case it exists to close.
    if (!ceilingTimer) ceilingTimer = setTimeout(flushNow, AUTOSAVE_MAX_MS);
  }

  async function flushNow() {
    clearTimeout(idleTimer);
    clearTimeout(ceilingTimer);
    idleTimer = ceilingTimer = null;
    if (!state.dirty) return;
    // Every path back into a save goes through here, so one check covers the
    // idle timer, the ceiling timer, the retry timer and an explicit flush.
    if (state.conflict) return;
    // Coalesce rather than queue: two overlapping PUTs of the same ride would
    // only race to write the same thing. Nothing is recorded here — save()
    // re-queues itself from the editSeq comparison if this flush's request
    // turns out not to have covered everything.
    if (state.saving) return;
    // NOT STARTED IS NOT BLOCKED — see notStartedYet(). Deliberately sets no
    // status: the readout is already on "Unsaved changes" from markDirty(),
    // which is true, and `blocked` reaches the live region and the error dialog,
    // so reporting through it here is the #290 modal by another door.
    if (notStartedYet()) return;
    const blocked = saveBlockReason();
    if (blocked) {
      setSaveStatus("blocked", blocked);
      // No timer. The condition can only clear through an edit, and every edit
      // calls markDirty() — so re-arming here would be a spin loop that changes
      // nothing. This is the one path that deliberately stops trying.
      return;
    }
    await save();
  }

  /**
    * Moves this ride to the recycle bin and leaves.
    *
    * NO CONFIRMATION, deliberately: the bin holds it for thirty days with a button
    * to put it back, so the bin IS the confirmation. Asking twice for something
    * reversible is how a rider learns to click through the dialog that is not.
    *
    * CLEARING dirty AND saving IS THE LOAD-BEARING PART. The beforeunload guard and
    * the visibilitychange flush both key off those two flags, so leaving them set
    * means a "leave site?" prompt and one last PUT at a binned ride. That PUT 404s
    * — nothing is corrupted, but the panel flashes a save error at somebody who has
    * already left.
    */
  async function deleteRide() {
    if (!state.rideId) return;
    const res = await fetch("/api/maps/" + state.rideId, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setSaveStatus("error", (data && data.error) || "Could not delete this " + W("journey") + ".");
      return;
    }
    state.dirty = false;
    state.saving = false;
    // The list, not the dashboard: a rider who just binned a ride wants to see
    // it gone from the rides, and the bin tab that can undo it is on that page.
    window.location.href = "/rides";
  }

  // --- Save status ----------------------------------------------------------

  // One state name in, one fixed-footprint readout out. The width is reserved in
  // CSS for the longest string here, so it cannot reflow what sits beside it.
  // One payload route, in this file's own shape.
  //
  // EXTRACTED SO THE LIVE REFRESH CANNOT DRIFT FROM THE LOAD: two mappings would
  // diverge quietly, and only for routes that came in over the channel — the
  // hardest place to notice a missing field.
  function routeFromPayload(r, i) {
    return {
      // `|| uid()` rather than assuming one is there: a ride saved before this
      // shipped has none in flight, and the server repairs a null anyway — but
      // a route carrying undefined here would send undefined straight back and
      // churn its uid on every save, losing its votes each time.
      uid: r.uid || uid(),
      // `?? null` rather than `|| null` for symmetry with altGroup below —
      // there is no falsy uid, but the two fields are read the same way and one
      // of them written differently is a thing somebody has to check.
      subgroupUid: r.subgroupUid ?? null,
      title: r.title || "",
      color: r.color || ROUTE_COLORS[(i || 0) % ROUTE_COLORS.length],
      startAt: r.startAt || null,
      endAt: r.endAt || null,
      endManual: false,
      // The other half of payload()'s round-trip. Omitting these is how a
      // rider's alternate grouping works perfectly until they reload the page
      // and then is silently gone, with the ride's mileage jumping to match —
      // `?? null` rather than `|| null` because 0 is a real group id.
      altGroup: r.altGroup ?? null,
      altActive: r.altActive ?? true,
      // Omitting this is how a rider's avoid-highways route quietly goes back on
      // the interstate: the next save would post no preference and every leg
      // would re-route to the fast road, on a save made for some other reason.
      routePrefs: r.routePrefs ?? null,
      // One ordered list. A payload from before 2026-08-23 cannot reach this —
      // loadRidePayload is the only source and it was changed with the schema.
      points: r.points || [],
      legs: r.legs || [],
    };
  }

  // --- The live channel -----------------------------------------------------
  //
  // Who else is in this ride, what they are working on, and when a route changes
  // under us. EventSource rather than a socket: everything is one-directional
  // except the claim, an ordinary POST. Server half is src/routes/live.ts.
  //
  // **NOTHING HERE PROTECTS ANY WORK.** A claim is a courtesy that stops two
  // riders picking up the same route by accident; the route hash checked on every
  // save is what prevents loss, and it needs no connection. Every path below
  // degrades to "no presence shown" rather than to "cannot edit".
  const LIVE = (function () {
    let source = null;
    let claimed = null;
    let riders = [];

    // A route another rider is holding, as {routeUid: name}. Read by renderRoutes to
    // mark the section; empty whenever the channel is not connected, which is
    // what makes the whole feature invisible rather than broken when it is off.
    const heldBy = {};

    function rebuildHeld() {
      for (const k in heldBy) delete heldBy[k];
      for (const r of riders) {
        if (r.routeUid && r.riderId !== window.TB.riderId) heldBy[r.routeUid] = r.name;
      }
      renderPresence();
    }

    function renderPresence() {
      const el = $("live-presence");
      if (!el) return;
      const others = riders.filter((r) => r.riderId !== window.TB.riderId);
      if (others.length === 0) {
        el.textContent = "";
        el.hidden = true;
        return;
      }
      el.hidden = false;
      // Names only, and the route they are on if they are on one. The rung is
      // deliberately not shown: canSeePerms is the owner's business, and a
      // presence strip is seen by everybody in the ride.
      el.textContent =
        others.length === 1
          ? others[0].name + (others[0].routeUid ? " is editing a route" : " is here")
          : others.length + " other " + Ws("person") + " here";
      el.title = others.map((r) => r.name).join(", ");
    }

    function connect() {
      if (!state.rideId || source) return;
      try {
        source = new EventSource("/api/rides/" + state.rideId + "/live");
      } catch (e) {
        return;
      }
      source.addEventListener("presence", (e) => {
        try {
          riders = JSON.parse(e.data);
        } catch (_) {
          return;
        }
        rebuildHeld();
        // Re-assert after a reconnect. The server forgets every claim when the
        // stream drops, so without this a rider silently stops holding the route
        // they are visibly working on.
        if (claimed) send(claimed);
      });
      source.addEventListener("routes", (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch (_) {
          return;
        }
        // Our own save, arriving back. The response already rebased us.
        if (msg.by === window.TB.riderId) return;
        onRemoteSave(msg);
      });
      // EventSource reconnects on its own, so an error is not something to
      // handle — closing here would turn a blip into a permanent disconnect.
    }

    function send(routeUid) {
      if (!state.rideId) return;
      fetch("/api/rides/" + state.rideId + "/live/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeUid: routeUid }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) return;
          if (d.presence) {
            riders = d.presence;
            rebuildHeld();
          }
        })
        .catch(() => {});
    }

    return {
      start: connect,
      claim(routeUid) {
        const next = routeUid || null;
        if (next === claimed) return;
        claimed = next;
        send(next);
      },
      heldBy,
      stop() {
        if (source) source.close();
        source = null;
      },
    };
  })();

  // What another rider's save means for this builder.
  //
  // A route is refreshed in place only when it is SAFE to: this rider is not
  // editing it and has nothing unsaved touching it. Anything else is left alone
  // and reported, because patching state under a rider mid-edit is the kind of
  // data loss where nothing is deleted and what they were looking at changes.
  //
  // One route at a time rather than reloading the ride — a big ride's payload is
  // megabytes and the autosave fires every three seconds.
  async function onRemoteSave(msg) {
    const changed = (msg.routes || []).filter((d) => state.routeBase[d.uid] !== d.hash);
    if (changed.length === 0) return;

    const mine = state.routes[state.active] && state.routes[state.active].uid;
    const refreshable = [];
    let blocked = false;

    // A REFRESH RE-RENDERS THE WHOLE DAY LIST, AND THAT EATS A FOCUSED FIELD.
    // Same defect as #188 and the places.js one it was mirrored from: rebuilding
    // the list under a rider destroys the input they are typing in and drops
    // focus to <body>. state.dirty does not cover it — `change` fires on BLUR,
    // so a rider mid-word is still clean. So if the caret is anywhere in the route
    // list, nothing is taken and the panel just says it is behind.
    const focused = document.activeElement;
    const typing = focused && focused.closest && focused.closest("#route-list");
    for (const d of changed) {
      const at = state.routes.findIndex((x) => x.uid === d.uid);
      // A route this builder has never seen. It cannot be spliced meaningfully —
      // there is no position for it — so it is a reload, not a refresh.
      if (at === -1) {
        blocked = true;
        continue;
      }
      // The route under the rider's hands, or unsaved work anywhere. Either way
      // this builder holds something the server has not got.
      if (d.uid === mine || state.dirty || typing) {
        blocked = true;
        continue;
      }
      refreshable.push({ uid: d.uid, at: at, hash: d.hash });
    }

    for (const r of refreshable) {
      try {
        const res = await fetch("/api/rides/" + state.rideId + "/route/" + encodeURIComponent(r.uid));
        if (!res.ok) {
          blocked = true;
          continue;
        }
        const body = await res.json();
        if (!body.route) {
          blocked = true;
          continue;
        }
        // Re-read the index: an await happened, and a render or another refresh
        // may have moved the route. Splicing at a stale index replaces the wrong
        // one, which is exactly the silent corruption this whole sprint is about.
        const at = state.routes.findIndex((x) => x.uid === r.uid);
        if (at === -1) {
          blocked = true;
          continue;
        }
        // Still not mid-edit, and still clean. Both can have changed while the
        // fetch was in flight.
        const nowMine = state.routes[state.active] && state.routes[state.active].uid;
        if (state.dirty || r.uid === nowMine) {
          blocked = true;
          continue;
        }
        state.routes[at] = routeFromPayload(body.route, at);
        state.routes[at].endManual = inferEndManual(state.routes[at]);
        // Rebase, or the next save sends this route with the hash it had BEFORE
        // the refresh and the merge reads it as contested.
        if (r.hash) state.routeBase[r.uid] = r.hash;
      } catch (e) {
        blocked = true;
      }
    }

    if (refreshable.length > 0) {
      // The render half of renderEverything, without the three form inputs it
      // also writes. Those belong to the ride rather than to a route, and nothing
      // here changed them — rewriting a field the rider may be in is the defect
      // above, arriving by another route.
      rebuildLayers();
      renderMarkers();
      renderRoutes();
      refreshDerived();
    }

    // Something changed that could not be taken safely. Say so rather than
    // leaving the panel quietly behind — but do NOT stop the autosave unless
    // this rider has work at stake, because a stale VIEW is not a stale WRITE.
    if (blocked) {
      if (state.dirty) {
        state.conflict = true;
        setSaveStatus("conflict");
      } else {
        setSaveStatus("stale");
      }
    }
  }

  const SAVE_TEXT = {
    new: "Not saved yet",
    dirty: "Unsaved changes",
    saving: "Saving…",
    saved: "Saved",
    error: "Not saved",
    // Nothing of this rider's is at risk — they have no unsaved work — but what
    // is on screen is behind. A softer wording than `conflict` for that reason.
    stale: "Someone else changed this " + W("journey") + "—reload to see it",
    // Deliberately says what to DO, not what went wrong. A rider seeing this has
    // work in front of them that the server has refused, and the only safe move
    // is to reload and redo it — which is worth saying plainly rather than
    // leaving them pressing a save that is never going to be attempted again.
    conflict: "Someone else edited this " + W("journey") + "—reload to see their changes",
  };

  // --- Errors that need saying properly -------------------------------------
  //
  // #233. A save failure went to the status readout and nowhere else: a fixed box
  // that ellipsizes, with the whole message only in a `title`. The server's
  // wording makes it worse — `routes.1: a route needs at least one stop` reached
  // the screen as "routes.1: a route n…".
  //
  // ONCE PER DISTINCT MESSAGE, NOT ONCE PER ATTEMPT: the autosave retries on a
  // timer and a failing save keeps failing, so a dialog per attempt would be far
  // worse than the ellipsized box. The memory resets on the next clean save.
  let lastErrorSeen = null;

  const ERROR_TITLES = {
    error: "This " + W("journey") + " did not save",
    conflict: "Someone else edited this " + W("journey"),
    stale: "Someone else changed this " + W("journey"),
    blocked: "This " + W("journey") + " cannot be saved yet",
  };

  // THE HOUSE MODAL, ON A DIALOG ELEMENT. `.modal` is the box every other modal
  // is drawn in and `.modal--error` adds only what a <dialog> needs — see
  // _modal.scss.
  //
  // BOTH BUTTONS CARRY `.btn`, WHICH THEY DID NOT. `.btn-quiet` alone sets three
  // colors and no padding; the rule that sets those is nested inside
  // `.builder-panel`, which this dialog is not, since showModal() needs it in the
  // top layer. The pair rendered as raw UA buttons on every failure.
  //
  // TWO SIGNS, TWO CLASSES OF SIGN: Dismiss is the green guide sign, Reload the
  // amber WARNING sign, because it is the one action here that can lose work
  // still on screen. Ranked by what each RISKS rather than by which is
  // recommended. Ziad's call, 2026-09-03.
  function errorDialog() {
    let el = $("tb-error");
    if (el) return el;
    el = document.createElement("dialog");
    el.id = "tb-error";
    el.className = "modal modal--error";
    // showModal() gives it role=dialog and aria-modal itself; the heading is the
    // only thing it cannot work out on its own.
    el.setAttribute("aria-labelledby", "tb-error-title");
    el.innerHTML =
      '<h2 id="tb-error-title"></h2>' +
      '<div class="modal-body">' +
      '<p class="modal-error-msg"></p>' +
      '<p class="modal-error-note"></p>' +
      "</div>" +
      '<div class="modal-error-acts">' +
      '<button type="button" class="btn btn-sign btn-warning" data-error-reload>Reload</button>' +
      '<button type="button" class="btn" data-error-close>Dismiss</button>' +
      "</div>";
    document.body.appendChild(el);
    el.querySelector("[data-error-close]").addEventListener("click", () => closeErrorDialog());
    el.querySelector("[data-error-reload]").addEventListener("click", () => location.reload());
    return el;
  }

  function closeErrorDialog() {
    const el = $("tb-error");
    if (!el) return;
    if (typeof el.close === "function" && el.open) el.close();
    else el.removeAttribute("open");
  }

  /**
   * Show a failure in full, at a size that can hold it.
   *
   * `kind` picks the heading; `text` is the message as it will be read. The
   * Reload button is offered only where reloading is the actual remedy — on a
   * plain save error the work is still in the panel and in the recovery draft,
   * and reloading is the one thing that would lose it.
   */
  function showErrorDialog(kind, text) {
    const el = errorDialog();
    el.dataset.kind = kind;
    el.querySelector("#tb-error-title").textContent = ERROR_TITLES[kind] || ERROR_TITLES.error;
    el.querySelector(".modal-error-msg").textContent = text || SAVE_TEXT[kind] || "";
    // WHAT IS AT RISK, WHICH IS THE QUESTION A RIDER ACTUALLY HAS. A save error
    // is alarming and usually harmless — the retry clears most of them — and
    // saying so is the difference between a dialog that helps and one that only
    // interrupts.
    el.querySelector(".modal-error-note").textContent =
      kind === "conflict" || kind === "stale"
        ? "Reload to see their version. Anything you have changed since will need doing again."
        : "Your work is still here and a recovery copy is saved in this browser. Routeloop will keep trying.";
    const reload = el.querySelector("[data-error-reload]");
    reload.hidden = !(kind === "conflict" || kind === "stale");
    if (typeof el.showModal === "function") {
      if (!el.open) el.showModal();
    } else {
      el.setAttribute("open", "");
    }
  }

  function setSaveStatus(name, text) {
    const el = $("save-status");
    if (!el) return;
    const msg = text || SAVE_TEXT[name] || "";
    el.dataset.state = name;
    el.querySelector(".save-text").textContent = msg;
    // A server error message is arbitrary length and the readout is a fixed box,
    // so the visible text ellipsizes and the whole thing lives here.
    el.title = msg;
    // Only the states a rider needs told about reach the live region. The
    // routine dirty/saving/saved cycle runs several times a minute and
    // announcing it would make the panel unusable with a screen reader on.
    if (name === "error" || name === "blocked" || name === "conflict" || name === "stale") {
      $("save-announce").textContent = msg;
      // #233. THE READOUT IS NOT ENOUGH ON ITS OWN — a fixed box that ellipsizes, so
      // a server message longer than a few words reached the rider as its first
      // fragment, the rest in a `title` nobody hovers.
      //
      // ONCE PER DISTINCT MESSAGE, since the autosave retries on a timer and a
      // failing save keeps failing. `lastErrorSeen` clears on the next clean save.
      if (msg !== lastErrorSeen) {
        lastErrorSeen = msg;
        showErrorDialog(name, msg);
      }
      // A way back IN, because a dismissed dialog is otherwise unrecoverable and
      // the box still cannot show the message.
      const d = $("save-detail");
      if (d) d.hidden = false;
    } else {
      const d = $("save-detail");
      if (d) d.hidden = true;
      if (name === "saved") {
        $("save-announce").textContent = "";
        // A clean save is what makes the NEXT failure new again.
        lastErrorSeen = null;
        closeErrorDialog();
      }
    }
  }

  // --- Routing --------------------------------------------------------------

  function straightLeg(a, b, vias) {
    // Placeholder while the real route is in flight (and the NoRoute fallback
    // the server accepts — its distance is the haversine truth). durationS stays
    // 0 because we genuinely do not know it: fabricating a number here would
    // persist as though the router had returned it. legDurationS() estimates it
    // at the point of use instead, which also survives a save/reload.
    const geometry = [a, ...(vias || []), b];
    return { geometry, distanceM: Math.round(haversineTrack(geometry)), durationS: 0, viaPoints: vias || [] };
  }

  // Every route arrives with exactly points−1 legs, whatever it was stored as.
  //
  // A CSV import has NO geometry — csv.ts refuses to join points with straight
  // lines — so it lands with N points and zero legs, which the payload rejects.
  // Once the builder accepted imported rides, a rider could open a CSV import and
  // watch every autosave fail.
  //
  // Filled with straight legs, the placeholder drawn while the router answers.
  // Free and synchronous: NO routing request here, because routing every leg on
  // open is a page load that silently spends money.
  function fillMissingLegs(route) {
    const pts = route.points;
    const want = Math.max(0, pts.length - 1);
    if (route.legs.length === want) return;
    // Trim first: more legs than pairs cannot be saved either, and a leg with
    // no pair of points to connect has nothing to be about.
    route.legs.length = Math.min(route.legs.length, want);
    for (let i = 0; i < want; i++) {
      if (route.legs[i]) continue;
      const a = pts[i];
      const b = pts[i + 1];
      route.legs[i] = straightLeg([a.lng, a.lat], [b.lng, b.lat], []);
    }
  }

  function haversineTrack(coords) {
    let m = 0;
    for (let i = 1; i < coords.length; i++) {
      const [lng1, lat1] = coords[i - 1];
      const [lng2, lat2] = coords[i];
      const rad = Math.PI / 180;
      const dLat = (lat2 - lat1) * rad;
      const dLng = (lng2 - lng1) * rad;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
      m += 2 * 6371008.8 * Math.asin(Math.sqrt(a));
    }
    return m;
  }

  // Routes through our own origin rather than calling Google directly: the
  // Routes key is IP-restricted, so it cannot be used from a browser. The proxy
  // also caches, which matters because dragging a stop re-requests the same pair
  // on every frame and Routes bills per call. See src/routes/routing.ts.
  async function directions(a, b, vias, prefs) {
    // OMITTED WHEN NOTHING IS SET, rather than sent as an object of falses. The
    // proxy keys its cache on the preferences, so a route with none has to send
    // the request it sent before #29 or every already-cached leg misses and
    // re-bills. prefsBody() is what guarantees that.
    const body = { origin: a, destination: b, vias: vias || [] };
    const set = prefsBody(prefs);
    if (set) body.prefs = set;
    const res = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // THE STATUS RIDES ALONG. Every failure used to reach the caller as a bare
      // message and be reported as "no road route for that leg", which blames
      // the road for a 401 — and a session problem looks exactly like a pair of
      // stops with no road between them. That cost a long debugging session on
      // 2026-08-24: an account sitting at `status = 'pending'` 403s every leg,
      // the map drew straight lines, and nothing on screen said why.
      const err = new Error((data && data.error) || "no route found (" + res.status + ")");
      err.status = res.status;
      throw err;
    }
    return {
      geometry: data.geometry,
      distanceM: data.distanceM,
      durationS: data.durationS,
      viaPoints: vias || [],
    };
  }

  // A SHAPING POINT IS PULLED ONTO THE ROAD THE ROUTER ACTUALLY CHOSE, AFTER the
  // response rather than before the request. Ziad's call, 2026-09-06: a via is
  // dropped wherever the pointer landed and Routes snaps it to whatever is
  // nearest, so the road returned is not always the one the rider pointed at and
  // the export is built from the wrong one.
  //
  // The returned geometry IS the road, so projecting onto it costs nothing — no
  // Roads API, no request per drag. The trade-off to state rather than treat as a
  // bug: the HANDLE MOVES once the response lands. Snapping first instead is
  // snapToRoads, billable on every drag; see docs/decisions.md.
  //
  // Vias are walked IN ORDER with each one's segment as the next one's floor, or
  // two snap out of order and the leg doubles back.
  //
  // It reports whether anything MOVED so the caller can mark dirty: a fast
  // response can land after the three-second autosave has gone.
  function snapVias(leg) {
    const vias = leg && leg.viaPoints;
    if (!vias || !vias.length || !leg.geometry || leg.geometry.length < 2) return false;
    let moved = false;
    let floor = 0;
    for (let i = 0; i < vias.length; i++) {
      const hit = snapToTrack(leg.geometry, vias[i], floor);
      if (!hit) break;
      floor = hit.segmentIndex;
      if (hit.lngLat[0] !== vias[i][0] || hit.lngLat[1] !== vias[i][1]) {
        vias[i] = hit.lngLat;
        moved = true;
      }
    }
    return moved;
  }

  // What to tell the rider when a leg does not come back.
  //
  // The leg is drawn straight either way — a placeholder beats no line at all —
  // but WHY it is straight decides whether there is anything they can do about
  // it. "No road route" is the only one of these that is about the route; the
  // rest are about the session or the service, and reporting them as a routing
  // failure sends the rider off to move their stops when they should be
  // reloading the page.
  function legErrorText(e) {
    const s = e && e.status;
    if (s === 401) return "Signed out—reload the page. The leg is drawn straight until then";
    if (s === 403) return "Your account cannot route yet—the leg is drawn straight";
    if (s === 422) return "No road route for that leg—drawn straight, its time is estimated";
    if (s === 503) return "Routing is not configured—legs are drawn straight";
    if (s >= 500) return "Routing is unavailable right now—the leg is drawn straight";
    return "Could not route that leg—drawn straight, its time is estimated";
  }

  // Recomputes leg i of route r, joining points[i] to points[i+1]. `i` indexes
  // route.points directly — both kinds anchor a leg.
  // RETURNS A PROMISE THAT SETTLES WHEN THE ROAD IS REAL, and every early exit
  // returns a settled one. Fire-and-forget is still the normal use, but syncing
  // departures to an arrival needs the ROUTED duration, and the straight
  // placeholder installed first is a number that is about to change.
  function computeLeg(r, i) {
    const route = state.routes[r];
    if (!route) return Promise.resolve();
    const pts = route.points;
    if (!pts[i] || !pts[i + 1]) return Promise.resolve();
    const a = [pts[i].lng, pts[i].lat];
    const b = [pts[i + 1].lng, pts[i + 1].lat];
    const vias = (route.legs[i] && route.legs[i].viaPoints) || [];
    route.legs[i] = straightLeg(a, b, vias);
    renderTrack(r);
    refreshDerived();

    // Two points in the same place have no route between them, and asking is both
    // a billable Routes request and a guaranteed 422 — which surfaces as "no road
    // route for that leg" in a toast, for a leg the rider never asked to route.
    // The straight leg above is already the right answer: zero meters, zero
    // seconds. This became reachable the moment duplicate-a-point shipped, which
    // by design puts the copy exactly on top of its original.
    if (!vias.length && a[0] === b[0] && a[1] === b[1]) return Promise.resolve();

    if (!state.legSeq[r]) state.legSeq[r] = [];
    const seq = (state.legSeq[r][i] = (state.legSeq[r][i] || 0) + 1);
    return directions(a, b, vias, route.routePrefs)
      .then((leg) => {
        // The route may have been deleted or reordered while this was in flight.
        if (state.routes[r] !== route) return;
        if (state.legSeq[r][i] !== seq || !route.legs[i]) return;
        route.legs[i] = leg;
        // Onto the road, now that there is a road to be on. renderMarkers()
        // rather than renderTrack() alone, because the handles are what move.
        if (snapVias(leg)) {
          renderMarkers();
          markDirty();
        }
        renderTrack(r);
        refreshDerived();
      })
      .catch((e) => {
        console.warn("[builder] directions:", e.status || "", e.message);
        toast(legErrorText(e), true);
      });
  }

  // Also returns a promise, for the same reason and with the same caveat: it is
  // normally called for its effect and the result ignored.
  function computeLegsAround(r, indices) {
    const n = state.routes[r].points.length - 1;
    return Promise.all([...new Set(indices)].filter((i) => i >= 0 && i < n).map((i) => computeLeg(r, i)));
  }

  // --- Map rendering --------------------------------------------------------

  // The concatenated track, plus where each leg lands in it. Deliberately the
  // same walk the server does in src/index.ts, down to dropping *any*
  // consecutive duplicate rather than only the joints between legs — otherwise
  // a span computed here and one computed there would disagree on the same
  // ride. spans[i] lines up with legs[i]; a leg with no geometry has no place
  // on the track and gets null rather than shifting everything after it.
  function trackAndSpans(r) {
    const track = [];
    const spans = [];
    for (const leg of state.routes[r].legs) {
      if (!leg.geometry || leg.geometry.length === 0) {
        spans.push(null);
        continue;
      }
      let startIndex = -1;
      for (const pt of leg.geometry) {
        const last = track[track.length - 1];
        if (!last || last[0] !== pt[0] || last[1] !== pt[1]) track.push(pt);
        if (startIndex < 0) startIndex = track.length - 1;
      }
      spans.push({ startIndex, endIndex: track.length - 1 });
    }
    return { track, spans };
  }

  const fullTrack = (r) => trackAndSpans(r).track;

  function renderTrack(r) {
    if (!state.layersReady) return;
    updateRouteTrack(state.map, r, fullTrack(r));
  }

  // Layers are keyed by route index, so a delete or reorder invalidates every
  // key at or after it. Rebuilding all of them is O(routes) on a list capped at
  // 31 and removes a whole class of stale-layer bug.
  function rebuildLayers() {
    if (!state.map) return;
    for (let i = 0; i < state.layerCount; i++) removeRouteLayers(state.map, i);
    state.routes.forEach((route, r) => {
      addRouteLayers(state.map, r, fullTrack(r), route.color, { shapeable: true });
    });
    state.layerCount = state.routes.length;
    state.layersReady = true;
    applyFocus();
  }

  // The only thing the active route does to the map: every route stays drawn and
  // the others are dimmed.
  //
  // There is no "all routes, dim nothing" state — that was the slider's 0
  // position. Something is always active, because a map click has to land
  // somewhere.
  //
  // With a moment chosen the timeline decides instead. A moment in the overnight
  // gap belongs to no route, so everything dims and no leg is drawn — what
  // "nobody is riding right now" honestly looks like.
  function applyFocus() {
    if (!state.map) return;
    const a = activeNow();
    // THE ROUTE BEING EDITED IS THE LIT ONE. ALWAYS. It used to be the route the
    // MOMENT fell in, which is the same answer until a rider scrubs and then clicks
    // into a different route — leaving the one they were editing dimmed behind the
    // slider's. That was #214.
    //
    // In route scope the two cannot disagree; the rule matters in ride scope, where
    // the slider deliberately does not move when a rider clicks a row.
    //
    // The consequence, stated rather than treated as a bug: a moment in the
    // overnight gap no longer dims every route. This is an editor, so the honest
    // picture is the route being worked on.
    const lit = focusedIndex();
    state.routes.forEach((route, r) => {
      const dim = lit !== null && r !== lit;
      const ghost = route.altGroup != null && !route.altActive;
      setRouteDim(state.map, r, dim);
      // Set every pass rather than once when a route is grouped: rebuildLayers()
      // recreates the entry on every add, delete, reorder and recolor, and
      // applyFocus is what runs after all of them.
      setRouteGhost(state.map, r, ghost);
      const m = state.markers[r];
      if (!m) return;
      m.points.forEach(({ el }) => {
        // A ghost stays quiet even while it is the focused route — the rider
        // clicked into it to edit it, which is precisely when they need to see
        // it is the one that does not count.
        el.style.opacity = ghost ? "0.25" : dim ? "0.35" : "";
      });
    });

    // The engine drops the highlight whenever a track is repathed, so this is a
    // re-apply rather than a set — see clearLegHighlight in map-common.js.
    //
    // ONLY ON THE LIT ROUTE. In ride scope the moment can sit on a route the rider
    // is not editing, and a bright leg across a route dimmed to 0.25 reads as
    // neither state. Otherwise there is nothing to point at and it goes.
    const onLitRoute = a && a.routeIndex != null && a.routeIndex === lit;

    // WHERE THE RIDER WOULD BE, drawn on WHATEVER ROUTE THE MOMENT FALLS ON —
    // deliberately not gated on onLitRoute the way the leg highlight is. A
    // highlight is a stretch of the route's own line and reads as neither state when
    // dimmed; a dot is a discrete overlay with no such ambiguity, and suppressing it
    // would make ride scope show nothing for most of its travel.
    paintMoment(a);

    const leg = onLitRoute && a.legIndex != null ? state.routes[a.routeIndex].legs[a.legIndex] : null;
    if (!leg) {
      clearLegHighlight(state.map);
      return;
    }
    const span = trackAndSpans(a.routeIndex).spans[a.legIndex];
    if (span) setLegHighlight(state.map, a.routeIndex, span.startIndex, span.endIndex);
    else clearLegHighlight(state.map);
  }

  /**
   * The moment dot, the fuel ring around it, and where the tank runs dry.
   *
   * THE RING'S RADIUS IS THE FUEL LEFT — the bike's range minus the miles
   * ridden since the last fill — so it shrinks as the rider scrubs, refills at
   * every pump, and is gone at max range. See public/js/range-circle.js.
   */
  function paintMoment(a) {
    // BEFORE THE SLIDER IS TOUCHED, STAND AT THE START OF THE ROUTE.
    //
    // `state.moment` is null until a rider drags, so this used to draw nothing — the
    // ring, the E markers and the closed stretch were invisible on load and appeared
    // only if somebody happened to scrub, which hid the whole feature behind a
    // gesture nobody was told to make. Ziad's call, 2026-08-31.
    //
    // `state.moment` is deliberately NOT seeded instead: the readout's "from – to"
    // line and the absent highlight are the correct rendering of "no moment
    // chosen", and this only decides where to draw the overlay.
    const at = a || { routeIndex: focusedIndex(), pointIndex: 0, legIndex: null, legFraction: null };
    const route = at.routeIndex != null ? state.routes[at.routeIndex] : null;
    if (!route) return setMomentOverlay(state.map, null);
    a = at;
    const track = fullTrack(a.routeIndex);
    if (!track.length) return setMomentOverlay(state.map, null);

    const cum = DIST.cumulativeM(route);
    const distM = RANGE.distanceAtMoment(route, a, cum);
    if (distM == null) return setMomentOverlay(state.map, null);
    const here = pointAtDistance(track, distM);
    if (!here) return setMomentOverlay(state.map, null);

    // Null is the ordinary case, not the edge one: a rider with no bike on file
    // has no range. The dot is still where they would be.
    const role = fuelRole();
    const range = rangeM();
    // ONE SWITCH FOR THE WHOLE FUEL OVERLAY. `state.ringOn` gated only the ring
    // until 2026-08-31, so turning it off left the E markers and the closed
    // stretch on the map — most of the red, and the half a rider is turning off
    // when they want the route back. Everything range-derived is behind it now;
    // the moment dot is not, because where the rider is is not a fuel fact.
    const on = state.ringOn;
    const reach = on ? RANGE.fuelReachM(route, distM, cum, role, range) : null;
    // ONE MARKER PER TANKFUL, not just the next one — see dryDistancesM().
    const walls = on
      ? RANGE.dryDistancesM(route, distM, cum, role, range)
          .map((d) => pointAtDistance(track, d))
          .filter(Boolean)
      : [];
    // The stretch the rider cannot make, from the wall to the next pump — one
    // statement with the wall, so it is drawn on the same condition.
    const gap = on ? RANGE.dryStretch(route, distM, cum, role, range) : null;
    setMomentOverlay(
      state.map,
      here,
      walls,
      ringPath(here, track, distM, reach),
      gap && sliceBetween(track, gap.from, gap.to),
      // GREEN THROUGH THE FIRST HALF OF THE TANK, amber past it, red from three
      // quarters — the ring is the one part of the fuel overlay that is a
      // quantity rather than a verdict. Computed even when the overlay is off,
      // which costs nothing and keeps the tone right the instant it comes back.
      RANGE.ringTone(RANGE.tankUsed(route, distM, cum, role, range)),
    );
  }

  /**
    * The ring itself, as a closed path: a circle around the rider whose radius is
    * the straight line to the furthest point on the route their fuel reaches, so
    * its edge is a PLACE rather than a number and collapses as they arrive.
    *
    * A PATH RATHER THAN A RADIUS because the edge is dotted, and
    * google.maps.Circle has no dash support at all.
    *
    * MEASURED TO THE REACH POINT, NOT TO THE WALL — the same place on a route the
    * rider runs dry on and not on one they do not. Drawing it from the wall is what
    * made the ring disappear for good after a rider's last refuel.
    */
  function ringPath(here, track, distM, reachM) {
    // No `state.ringOn` check here: `reachM` is already null when the overlay is
    // off, and one switch read in two places is one that can be half-flipped.
    if (reachM == null || reachM <= distM) return null;
    const at = pointAtDistance(track, reachM);
    return at ? circlePath(here, haversineM(here, at)) : null;
  }

  function clearMarkers() {
    state.markers.forEach((m) => {
      m.points.forEach(({ marker }) => removeMarker(marker));
      // Vias came later than the other two. A kind that renderMarkers creates
      // and this forgets does not error — it just leaves the old handles on the
      // map, so every redraw stacks another set on top of the last.
      (m.vias || []).forEach(({ marker }) => removeMarker(marker));
    });
    state.markers = [];
  }

  // ONE MAKER FOR BOTH KINDS. `i` indexes route.points; the kind decides only the
  // marker's CSS class — `.tb-marker-poi` is the smaller, solid, route-colored dot
  // — and whether a drag has legs to invalidate.
  function makePointMarker(r, point, i) {
    const el = markerElement(point, state.routes[r].color, point.kind);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      // Clicking a marker on a dimmed route makes that route active, so the map's
      // emphasis follows what was just clicked. Every route's rows are on screen
      // now, so this is no longer what makes the row reachable — focusRow scrolls
      // to it either way.
      if (editIndex() !== r) goToRoute(r);
      focusRow(point.kind, i, r);
    });
    const marker = addMarker(state.map, [point.lng, point.lat], el, { draggable: true });
    onMarkerDragEnd(marker, ([lng, lat]) => {
      const route = state.routes[r];
      beginEdit(point.kind === "stop" ? "move stop" : "move POI");
      point.lng = +lng.toFixed(6);
      point.lat = +lat.toFixed(6);
      // BOTH KINDS BEND THE ROAD. Dragging a POI used to move a dot and cost
      // nothing, because a POI anchored no leg; it anchors the two either side of
      // it now, so the same surgery a stop always got applies to every point.
      // Their shaping points go with them — a via belongs to the pair of points
      // its leg used to join.
      if (route.legs[i - 1]) route.legs[i - 1].viaPoints = [];
      if (route.legs[i]) route.legs[i].viaPoints = [];
      computeLegsAround(r, [i - 1, i]);
      markDirty();
    });
    return { marker, el };
  }

  // --- Drag to shape --------------------------------------------------------

  // A shaping point is a hint about which road to take, not a place anyone is
  // going: smaller handle, no row in the stop list, no place in the numbering.
  // ONE PATH FOR BOTH SURFACES, so the map handle and the pane row cannot come to
  // disagree about what removing one does. The pane needs the row list rebuilt
  // and the map does not, which is the only difference.
  function removeVia(r, legIndex, viaIndex) {
    const leg = state.routes[r] && state.routes[r].legs[legIndex];
    if (!leg || !leg.viaPoints || !leg.viaPoints[viaIndex]) return;
    beginEdit("remove shaping point");
    leg.viaPoints.splice(viaIndex, 1);
    computeLeg(r, legIndex);
    renderMarkers();
    renderRouteList(r);
    markDirty();
  }

  function makeViaMarker(r, legIndex, viaIndex, v) {
    const el = markerElement({ name: "" }, state.routes[r].color, "via");
    el.title = "Shaping point—drag to move, click to remove";
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      removeVia(r, legIndex, viaIndex);
    });
    const marker = addMarker(state.map, [v[0], v[1]], el, { draggable: true });
    onMarkerDragEnd(marker, ([lng, lat]) => {
      beginEdit("move shaping point");
      state.routes[r].legs[legIndex].viaPoints[viaIndex] = [+lng.toFixed(6), +lat.toFixed(6)];
      computeLeg(r, legIndex);
      renderMarkers();
      markDirty();
      // No renderRouteList: the row says nothing about WHERE a shaping point is,
      // so moving one changes no text — and rebuilding the list would cost the
      // rider whatever field they had focused. #188, reached from the map.
    });
    return { marker, el };
  }

  // Called once per drop, with a vertex index into the route's flat track.
  function shapeAt({ id: r, vertexIndex, edgeForward, lngLat }) {
    const route = state.routes[r];
    if (!route) return;
    const { track, spans } = trackAndSpans(r);
    const legIndex = legAtVertex(spans, vertexIndex, edgeForward);
    if (legIndex == null || !route.legs[legIndex]) return;

    const leg = route.legs[legIndex];
    const vias = leg.viaPoints || (leg.viaPoints = []);
    if (vias.length >= MAX_VIAS_PER_LEG) {
      return toast("Up to " + MAX_VIAS_PER_LEG + " shaping points per leg", true);
    }

    beginEdit("shape route");
    // Order is the route: appending one that belongs in the middle makes the
    // leg double back on itself.
    const at = viaInsertIndex(track, spans[legIndex], vias, vertexIndex);
    vias.splice(at, 0, [+lngLat[0].toFixed(6), +lngLat[1].toFixed(6)]);
    computeLeg(r, legIndex);
    renderMarkers();
    // The pane gains a row for it. Without this the drag reshaped the road and
    // the list said nothing, which is exactly the report this row exists for.
    renderRouteList(r);
    markDirty();
  }

  // --- Stopping for the night ------------------------------------------------
  //
  // #220's other half, and the planner's own words: "I like to stop by four, so
  // where should I be looking?" The pieces were already here — activeAt() says
  // where the rider is at a moment, distanceAtMoment() turns that into a
  // distance along the route, sliceBetween() cuts that stretch out of the track,
  // and the corridor search covers a stretch. This is the wiring, not a new
  // mechanism.

  /** A track's own length. corridorRun() needs it to space its samples, and the
   *  bedtime stretch is a slice rather than a whole route, so nothing has already
   *  measured it. */
  function trackLengthM(track) {
    let m = 0;
    for (let i = 1; i < track.length; i++) {
      m += haversineM(track[i - 1][1], track[i - 1][0], track[i][1], track[i][0]);
    }
    return m;
  }

  /** How wide "around four" is, in minutes of riding either side. A constant for
   *  the reason CORRIDOR_MI is one: it is a preference about how much slack a
   *  bedtime has, not a decision to be made afresh on every search. */
  const STOP_BY_WINDOW_MIN = 45;

  /** "16:00" → 960. Empty, half-typed or nonsense → null, which is the same
   *  thing the column means by null: the rider has not said. */
  function minutesFromTimeValue(v) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(v || ""));
    if (!m) return null;
    const min = Number(m[1]) * 60 + Number(m[2]);
    return min >= 0 && min <= 1439 ? min : null;
  }

  /** 960 → "16:00", for the input. */
  function timeValueFromMinutes(min) {
    if (min == null) return "";
    return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
  }

  function renderStopBy() {
    setFieldValue("ride-stop-by", timeValueFromMinutes(state.meta.stopByMin));
    const clear = $("ride-stop-by-clear");
    // Hidden rather than disabled when there is nothing to clear: a control that
    // is always present and never works reads as a bug, the same rule the main
    // group's missing × follows.
    if (clear) clear.hidden = state.meta.stopByMin == null;
  }

  /**
   * Where each route will be when the clock reads the rider's bedtime.
   *
   * One entry per route that HAS an answer, and a route is allowed to have none: an
   * undated route has no clock, and a route that finishes before the hour never
   * reaches it. Both are ordinary and neither is worth reporting — the marker
   * simply is not there.
   */
  // MEMOIZED, BECAUSE THE ROUTE LIST ASKS ONCE PER ROW. Each uncached call walks
  // every route's whole track and rebuilds its cumulative distances — on a
  // hundred-point route, a hundred full passes to place one button.
  //
  // Cleared from refreshDerived(), the pass every schedule change goes through,
  // and from the setting's own handler. A render without either can read a stale
  // answer, which at worst puts the offer one row out.
  let stopByCache = null;

  function stopByPoints() {
    if (stopByCache) return stopByCache;
    const min = state.meta.stopByMin;
    if (min == null) return (stopByCache = []);
    const out = [];
    state.routes.forEach((route, r) => {
      if (ALT.isLosingAlt && ALT.isLosingAlt(route)) return;
      const moment = clockMoment(route, min);
      if (!moment || !moment.at) return;
      // The same two the fuel overlay uses, and deliberately so: a marker
      // placed by different arithmetic from the moment dot would drift from it
      // on the same route.
      const track = fullTrack(r);
      if (!track.length) return;
      const cum = DIST.cumulativeM(route);
      const distM = RANGE.distanceAtMoment(route, moment.at, cum);
      if (distM == null) return;
      const at = pointAtDistance(track, distM);
      if (!at) return;
      // The last point the rider passes BEFORE the moment, which is the row the
      // offer belongs on. `activeAt` reports either a point or a leg; on a leg,
      // the point before it is the leg's own index.
      const atPoint = moment.at.pointIndex != null ? moment.at.pointIndex : moment.at.legIndex;
      out.push({ routeIndex: r, at, distM, offsetS: moment.offsetS, track, cum, atPoint });
    });
    return (stopByCache = out);
  }

  /** The stretch of road the rider could reasonably stop along, as a track. */
  function stopByStretch(entry) {
    const route = state.routes[entry.routeIndex];
    const windowS = STOP_BY_WINDOW_MIN * 60;
    const from = TIMEDIST(route, entry, -windowS);
    const to = TIMEDIST(route, entry, windowS);
    return sliceBetween(entry.track, from, to);
  }

  /** The distance along the route `deltaS` seconds either side of the bedtime,
   *  clamped to the route. Time in, distance out — the two are not proportional on
   *  a route with a two-hour lunch in it, which is why this walks the schedule
   *  rather than scaling miles. */
  function TIMEDIST(route, entry, deltaS) {
    const offset = Math.max(0, Math.min(routeElapsedS(route), entry.offsetS + deltaS));
    const at = activeAt(route, offset);
    const d = RANGE.distanceAtMoment(route, at, entry.cum);
    return d == null ? entry.distM : d;
  }

  /** Draw the bedtime markers, or clear them. Called from the setting's own
   *  handler and from every repaint that could move them. */
  function paintStopBy() {
    if (!state.map) return;
    const spots = stopByPoints().map((e) => ({
      lngLat: e.at,
      label: routeLabel(e.routeIndex) + " · " + fmtClockMin(state.meta.stopByMin) + " · start looking here",
    }));
    setBedtimeMarks(state.map, spots);
  }

  /** 960 → "4:00 PM", in the rider's own date format and clock. The panel says
   *  the time back to them in the form they read everywhere else, not the
   *  24-hour string the input stores.
   *
   *  IT USED TO PASS `undefined` AND SO USED THE BROWSER'S LOCALE (#270), which
   *  made the comment above false: a rider who chose day-first dates or a
   *  24-hour clock got neither here. TBFmt reads both off <html>, where
   *  layout.tsx stamps them. */
  function fmtClockMin(min) {
    if (min == null) return "";
    // An arbitrary UTC date carrying that time of day, formatted in UTC — the
    // same trick every other clock in this app uses, and for the same reason: a
    // wall clock must not be re-read in the browser's zone.
    var pref = (window.TBFmt && window.TBFmt.timePrefs()) || {};
    return new Date(Date.UTC(2000, 0, 1, Math.floor(min / 60), min % 60)).toLocaleTimeString(pref.locale, {
      timeStyle: "short",
      hour12: pref.hour12,
      timeZone: "UTC",
    });
  }

  function renderMarkers() {
    clearMarkers();
    state.markers = state.routes.map((route, r) => ({
      points: route.points.map((pt, i) => makePointMarker(r, pt, i)),
      // One handle per shaping point, so a via can be moved or taken back out.
      vias: route.legs.flatMap((leg, li) => (leg.viaPoints || []).map((v, vi) => makeViaMarker(r, li, vi, v))),
    }));
    applyFocus();
  }

  // --- Mutations ------------------------------------------------------------

  // `routeIndex` defaults to the active route, which is what a map click means;
  // the per-route search rows pass their own. `prebuilt` is how a saved place
  // enters the ride — stopFromPlace() has already made the point.
  // THE ONE CREATION PATH. A map click, either search arm, a saved place, the home
  // seed and a new route's inherited first point all land here, and all produce a
  // POI. Ziad's call, 2026-08-23.
  //
  // EXCEPT THE FIRST POINT OF A ROUTE, promoted on the spot and tagged `start`, so
  // a rider who drops one pin and saves gets a route rather than a validation
  // error. The only implicit promotion in the app.
  //
  // EVERY POINT IS ROUTED TO, whatever its kind, which is what makes a start plus
  // one POI draw a road — and is why adding a POI is a Routes request now.
  // `at` defaults to the end, which makes wedging a stop between two the same code
  // path as appending one.
  function addPoint(lng, lat, name, routeIndex, prebuilt, at) {
    const r = routeIndex == null ? editIndex() : routeIndex;
    if (r == null || !state.routes[r]) return noRouteYet();
    const route = state.routes[r];
    if (route.points.length >= MAX_POINTS) return toast("Point limit reached (" + MAX_POINTS + ")", true);
    const oldLen = route.points.length;
    const where = at == null ? oldLen : Math.max(0, Math.min(at, oldLen));
    beginEdit("add point");
    const pt = prebuilt || newPoint(lng, lat, name);
    const first = oldLen === 0;
    if (first) {
      pt.kind = "stop";
      // Only when the caller has not said otherwise — the home seed brings its
      // own role and a saved place brings the ones the rider filed it under.
      if (!(pt.roles || []).length) pt.roles = ["start"];
    } else {
      // TAGGED MEANS STOPPING, the same rule the category picker follows. A point
      // arriving with roles was found by searching for a kind of place — a Gas
      // chip, a category query, a saved place filed under Lodging — and the rider
      // was looking for somewhere to stop when they did it. Untagged still lands
      // as a POI, which is every map click and every plain name search.
      pt.kind = (pt.roles || []).length ? "stop" : "poi";
    }
    route.points.splice(where, 0, pt);

    // ONE NEW LEG, wherever the point landed. A route with N points has N−1 legs, so
    // splicing a placeholder in at `where` puts the two legs needing recomputation
    // at `where - 1` and `where`.
    //
    // [A,B] with leg [AB], insert X at 1 → [AB, placeholder], recomputing 0 and 1
    // gives [AX, XB]. Insert at 0 → [placeholder, AB], recomputing 0 gives [XA].
    // Appending is the same operation with `where === oldLen`.
    // ROUTED, and the promise is handed back for the one caller that waits: takeMeet
    // syncs departures against an ARRIVAL time, and the straight placeholder is not
    // the number to sync to.
    let routed = Promise.resolve();
    if (!first) {
      route.legs.splice(Math.min(where, route.legs.length), 0, straightLeg([pt.lng, pt.lat], [pt.lng, pt.lat]));
      state.legSeq[r] = [];
      routed = computeLegsAround(r, [where - 1, where]);
    }
    // The slot has been used, so it closes. Left open, the next render would put
    // a second field in the middle of the route the rider just finished with.
    state.insertAt = null;
    renderTrack(r);
    renderMarkers();
    // renderRouteList(r), not renderList(): renderList redraws the ACTIVE route, and
    // a search row can add to a route that is not it.
    renderRouteList(r);
    refreshDerived();
    markDirty();
    return routed;
  }

  /**
     * Swaps the PLACE under an existing point and keeps everything the rider has
     * written on it.
     *
     * EVERY ROW'S NAME FIELD IS A SEARCH BOX, since 2026-09-15 — Ziad's call, after
     * finding the only way to put a different place at stop 3 was to delete it and
     * search again, losing its dwell, its notes and its place in the list.
     *
     * WHAT SURVIVES: the uid (so comments, votes and private details stay
     * attached), the kind, the dwell, both notes boxes and the roles. Roles and
     * details are FILLED FROM the pick only when the point has none — a Gas stop
     * swapped for another station is still Gas. A roleless POI that takes a category
     * IS promoted, per addPoint()'s "a category is a reason to stop".
     *
     * WHAT MOVES: name, address and coordinates — the marker-drag surgery. Both
     * neighboring legs lose their shaping points, because one end of each pair just
     * moved, and both are routed again. The leg count is unchanged.
     *
     * `key` is the typing step's coalesce key, so the typed text and the pick fold
     * into ONE undo step rather than undoing to a stop named "chev".
     */
  function replacePoint(r, i, lng, lat, name, pt, key) {
    const route = state.routes[r];
    const point = route && route.points[i];
    if (!point) return;
    beginEdit("replace point", key);
    point.name = name || "";
    point.lng = +lng.toFixed(6);
    point.lat = +lat.toFixed(6);
    point.address = (pt && pt.address) || "";
    if (!(point.roles || []).length && pt && (pt.roles || []).length) {
      point.roles = pt.roles.slice();
      point.kind = "stop";
    }
    if (!point.details && pt && pt.details) point.details = pt.details;
    if (route.legs[i - 1]) route.legs[i - 1].viaPoints = [];
    if (route.legs[i]) route.legs[i].viaPoints = [];
    computeLegsAround(r, [i - 1, i]);
    renderTrack(r);
    renderMarkers();
    renderRouteList(r);
    refreshDerived();
    markDirty();
  }

  /**
    * Promotes a POI to a stop, or demotes a stop back to a POI.
    *
    * A FLAG FLIP AND NOTHING ELSE, as of 2026-08-24. Every point anchors a leg
    * whatever its kind, so no leg is rebuilt, no shaping point dropped and no
    * Routes request made. What changes is the row's number, the marker's size and
    * whether the ride counts it as a stop.
    *
    * It used to rebuild the legs either side and clear their vias, because the STOP
    * SEQUENCE changed — two Routes calls and the rider's shaping work on both legs,
    * thrown away. Promoting is free and exactly reversible now.
    */
  function setPointKind(i, kind) {
    const r = editIndex();
    if (r == null) return;
    const route = state.routes[r];
    const pt = route.points[i];
    if (!pt || pt.kind === kind) return;
    if (kind === "stop" && stopsOf(route).length >= MAX_STOPS) {
      return toast("Stop limit reached (" + MAX_STOPS + ")", true);
    }
    // The last stop of a route cannot be demoted: the route would have none, the
    // save would 400, and payload() would drop the route whole.
    if (kind === "poi" && stopsOf(route).length <= 1) {
      return toast("A route needs at least one stop", true);
    }
    beginEdit(kind === "stop" ? "make a stop" : "make a POI");
    pt.kind = kind;
    // DEMOTING CLEARS THE CATEGORIES, because a category is what says the rider
    // means to stop. Left in place they would contradict the kind — a POI tagged
    // Gas — and anything that re-derived one from the other would promote the
    // point straight back. Promoting adds none: "make this a stop" is the path
    // for a stop with no reason given, which is the whole point of keeping it.
    if (kind === "poi") pt.roles = [];
    // No leg work and no renderTrack: the road is identical either side of this.
    renderMarkers();
    renderRouteList(r);
    refreshDerived();
    markDirty();
  }

  // --- Arming a map click ---------------------------------------------------
  //
  // "+ Stop" cannot place anything on its own: a button in a list has no
  // coordinates. It arms the NEXT map click for that route instead.
  //
  // The removed panel-wide + Stop / + POI pair had the same mechanism; what was
  // wrong with it was that it read as "add something" while being a mode switch,
  // sat nowhere near the route it affected, and never said it was on.
  // True when THIS row is the armed one. Both halves matter: an insert row and the
  // route's bottom row are different affordances on the same route.
  function isArmed(r, at) {
    const slot = at == null ? null : at;
    return state.arm === r && state.armAt === slot;
  }

  function armPlace(r, at) {
    const slot = at == null ? null : at;
    // A second press on the armed button turns it off. The button is the only
    // affordance that can be armed, so it has to be the one that disarms too —
    // an escape key is not discoverable and a rider who pressed it by mistake
    // should not have to click the map to get out.
    if (isArmed(r, slot)) return disarmPlace();
    if (!state.routes[r]) return;
    if (state.routes[r].points.length >= MAX_POINTS) return toast("Point limit reached (" + MAX_POINTS + ")", true);
    state.arm = r;
    state.armAt = slot;
    // The armed route becomes the working route, so everything else that keys off
    // "where the rider is" agrees with the thing about to happen.
    setActive(r);
    paintArm();
    toast(
      slot == null
        ? "Click the map to add a stop to " + routeLabel(r)
        : "Click the map to insert a point into " + routeLabel(r),
    );
  }

  // Returns whether it did anything, so the Escape chain can tell "I handled it"
  // from "nothing was armed" without reading state a second time.
  function disarmPlace() {
    if (state.arm == null) return false;
    state.arm = null;
    state.armAt = null;
    paintArm();
    return true;
  }

  // Painted rather than re-rendered. renderRouteList() would rebuild the row and
  // take the focus ring with it, and arming is not an edit — it must not touch
  // the undo history or mark the ride dirty. addRowHtml() reads state.arm on its
  // own, so a render that happens for some other reason still comes back armed.
  function paintArm() {
    document.querySelectorAll(".add-place-btn").forEach((b) => {
      const on = Number(b.dataset.route) === state.arm;
      b.classList.toggle("is-armed", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.body.classList.toggle("is-arming", state.arm != null);
  }

  // `i` indexes route.points, and EVERY kind leaves a hole in the route — a POI is
  // ridden through, so removing one joins its neighbors the same way removing a
  // stop does. The surgery used to be a stop-only path expressed in stop
  // ordinals; there is one index space now and one code path.
  function deletePoint(i) {
    const r = editIndex();
    if (r == null) return;
    const route = state.routes[r];
    const pt = route.points[i];
    if (!pt) return;
    beginEdit(pt.kind === "stop" ? "delete stop" : "delete POI");
    route.points.splice(i, 1);
    // A ROUTE MUST KEEP A STOP, AND THIS WAS THE ONE DELETE PATH WITHOUT THE GUARD.
    // The bulk delete, the cross-route move and the drag all had it; this did not,
    // so removing a route's last stop from the row menu left a route of nothing but
    // POIs — refused by the API and unrepairable by further editing, because
    // addPoint only promotes on an EMPTY route. #233 through the last door.
    //
    // A RIDE NEEDS A STARTING POINT AND NOTHING MORE — Ziad's call, 2026-09-03. The
    // rule stays; what changes is that the rider can never be made to satisfy it by
    // hand. The first surviving point becomes the anchor.
    ensureRouteHasStop(route);

    if (route.legs.length) {
      const pts = route.points;
      // Remove the legs that touched point i, then bridge the gap (if any). One
      // leg at either end of the route, two in the middle.
      const from = Math.max(0, i - 1);
      const bridging = i > 0 && i < pts.length;
      // THE SHAPING POINTS SURVIVE THE POINT. A via belongs to the pair of points its
      // leg joins, and deleting one in the MIDDLE merges two pairs into one whose ends
      // both survive — so the vias are carried across in order and the road the rider
      // drew by hand is still the road. The opposite of a MOVE, where one end has
      // physically moved and the hint describes nothing.
      //
      // At either end of the route there is no merge, so those vias go with the point.
      const carried = bridging
        ? [
            ...((route.legs[from] && route.legs[from].viaPoints) || []),
            ...((route.legs[from + 1] && route.legs[from + 1].viaPoints) || []),
          ]
        : [];
      route.legs.splice(from, bridging ? 2 : 1);
      state.legSeq[r] = [];
      if (bridging) {
        // Two full legs can carry more vias than one leg may hold. Truncating is
        // the only option that still deletes the point, and it is said out loud
        // rather than silently reshaping the road.
        if (carried.length > MAX_VIAS_PER_LEG) {
          carried.length = MAX_VIAS_PER_LEG;
          toast("Kept the first " + MAX_VIAS_PER_LEG + " shaping points on the joined leg", true);
        }
        route.legs.splice(from, 0, straightLeg([pts[i - 1].lng, pts[i - 1].lat], [pts[i].lng, pts[i].lat], carried));
        computeLeg(r, from);
      }
    }
    renderTrack(r);
    renderMarkers();
    renderList();
    refreshDerived();
    markDirty();
  }

  // Copy a point, placed straight after the one it came from.
  //
  // The roles array is COPIED, not shared: sharing would make the two points one
  // point wherever roles are concerned, and the aliasing would reach back through
  // the undo stack — see builder-history.js, which records which fields may be
  // shared by reference and warns that the set changes.
  function duplicatePoint(kind, i) {
    const r = editIndex();
    if (r == null) return noRouteYet();
    const route = state.routes[r];
    const list = route.points;
    const src = list[i];
    if (!src) return;
    const cap = MAX_POINTS;
    if (list.length >= cap) return toast((kind === "stop" ? "Stop" : "POI") + " limit reached (" + cap + ")", true);

    beginEdit("duplicate " + kind);
    // A FRESH uid and a deep copy of details. The uid because two points sharing
    // one violates the per-route unique index — the server's ensureUids would break
    // the tie, but then the client and the database would disagree about which
    // copy owns the details until the next reload. The deep copy because a shared
    // details object means typing into one copy edits both.
    const copy = {
      ...src,
      roles: (src.roles || []).slice(),
      uid: uid(),
      details: src.details ? { ...src.details, links: (src.details.links || []).map((l) => ({ ...l })) } : null,
    };
    list.splice(i + 1, 0, copy);

    // A point inserted at i+1 sits on top of its original, so the leg into it is
    // zero length and the one out of it is the original's old leg. Both ends get
    // recomputed rather than guessed.
    //
    // This used to be a stop-only branch, and it indexed the leg array with `i` —
    // a points index — which was already wrong for any route with a POI ahead of the
    // duplicated stop. One index space makes it right rather than papering over it.
    route.legs.splice(i, 0, straightLeg([src.lng, src.lat], [src.lng, src.lat]));
    state.legSeq[r] = [];
    computeLegsAround(r, [i - 1, i, i + 1]);
    renderTrack(r);
    renderMarkers();
    renderList();
    refreshDerived();
    markDirty();
  }

  // MOVE a point to an arbitrary index, which is what a drag produces. movePoint
  // below steps one place at a time — dragging point 2 to position 5 with a swap
  // would put point 5 at 2.
  //
  // A leg joins consecutive POINTS, so ANY move changes the road: every leg from
  // the one before the earlier index through the one after the later is refilled.
  // Recomputing the whole route would fire a routing request per leg.
  //
  // There used to be a short circuit for a move that left the STOP sequence
  // untouched; a POI is on the route now, so dragging one is a real re-route.
  function reorderPoint(from, to) {
    if (from === to) return;
    const r = editIndex();
    if (r == null) return;
    const route = state.routes[r];
    if (from < 0 || from >= route.points.length || to < 0 || to >= route.points.length) return;

    beginEdit("move point");
    const [moved] = route.points.splice(from, 1);
    route.points.splice(to, 0, moved);

    const lo = Math.min(from, to) - 1;
    const hi = Math.max(from, to) + 1;
    const idx = [];
    for (let k = lo; k <= hi; k++) {
      // Shaping points belong to the pair of points the leg used to join, so
      // they are meaningless once either end changes.
      if (route.legs[k]) route.legs[k].viaPoints = [];
      idx.push(k);
    }
    computeLegsAround(r, idx);
    renderTrack(r);
    renderMarkers();
    renderList();
    refreshDerived();
    markDirty();
  }

  // The grip's arrow keys. It was also the row menu's Move up / Move down until
  // those came off — the grip is a real <button> now and carries the keyboard
  // path on its own. `i` indexes route.points and both kinds get it — a POI has
  // an order to change.
  function movePoint(i, dir) {
    const r = editIndex();
    if (r == null) return;
    const route = state.routes[r];
    const j = i + dir;
    if (j < 0 || j >= route.points.length) return;
    reorderPoint(i, j);
  }

  // --- Routes -----------------------------------------------------------------

  // Makes a route active AND puts the timeline on its opening moment. setActive()
  // above is the cheap version that every row handler calls; this is the one for
  // a deliberate "work on this route now" — the rail's dots, a marker click, a
  // freshly added route.
  //
  // The split matters: moving the timeline is a visible jump on the map, and
  // doing it every time a rider clicked into a stop's name field would yank the
  // view out from under them.
  function goToRoute(r) {
    setActive(r);
    const route = state.routes[activeIndex()];
    state.moment = route ? routeStartS(route) : null;
    applyFocus();
    refreshDerived();
  }

  function addRoute() {
    if (state.routes.length >= MAX_ROUTES) return toast("Route limit reached (" + MAX_ROUTES + ")", true);
    beginEdit("add route");
    // THE LAST DAY THAT COUNTS, not the last section on screen. If the ride ends
    // with a pair of alternates, the last row might be the one the rider decided
    // against — seeding from it would start the new route at the wrong place and,
    // via nextMorningAfter below, on the wrong evening.
    const counted = ALT.activeRoutes(state.routes);
    const prev = counted[counted.length - 1];
    const route = newRoute(ROUTE_COLORS[state.routes.length % ROUTE_COLORS.length]);

    // A route begins where the last one ended. Without this every new route starts
    // with a search for a place you already have on the map.
    //
    // The last POINT, not the last stop. Every point is somewhere the rider rides
    // to, so the route physically ends at the last one in the list whatever its
    // kind — a route finishing at a viewpoint ends at the viewpoint.
    const lastPts = prev ? prev.points : [];
    const last = lastPts[lastPts.length - 1];
    if (last) {
      // THROUGH newPoint(), NOT AS A BARE OBJECT LITERAL. This was a hand-built
      // object written on 2026-08-15, before points had a `kind` at all — so it
      // was correct when it landed and became wrong silently on 2026-08-23 when
      // the stop/POI split made `kind` default to `poi`. It also carried no
      // `uid`, which ensureUids() then minted fresh on every save, so nothing
      // could reference this point across one.
      route.points.push(newPoint(last.lng, last.lat, last.name));
      // The route's first point is a stop, exactly as it is when a rider drops one
      // on an empty route. Without this the seeded route has no stop, adding more
      // points never promotes anything, and the ride cannot be saved at all.
      ensureRouteHasStop(route);
    }

    // And it begins the morning after the last one finished. Syncing the
    // previous route first because its end may be derived, and reading a stale
    // cache here would seed off the wrong evening. A previous route with no times
    // seeds nothing — nothing invents a date for a ride the rider never dated.
    if (prev) {
      syncEnd(prev);
      route.startAt = nextMorningAfter(prev.endAt);
    }

    state.routes.push(route);
    renderRoutes();
    goToRoute(state.routes.length - 1); // work on the new route
    rebuildLayers();
    renderMarkers();
    markDirty();
  }

  /**
    * Cut the route in two at point i, dropping the new route in right after it.
    *
    * #49, and #54's mechanic. The arithmetic is route-split.js; here is the part
    * that needs the rest of the ride — a color that is not the one above it, a
    * clock seeded off the route it now follows, and the layer rebuild a changed
    * route count forces.
    *
    * MAX_ROUTES IS CHECKED BEFORE beginEdit, so a refused split pushes no undo
    * step.
    */
  function splitRouteHere(r, i) {
    const route = state.routes[r];
    if (!route) return;
    if (state.routes.length >= MAX_ROUTES) return toast("Route limit reached (" + MAX_ROUTES + ")", true);
    if (!SPLIT.canSplitAt(route, i)) {
      return toast("A route has to keep at least one leg on each side of a split", true);
    }

    beginEdit("split route");
    const cut = SPLIT.splitRouteAt(route, i, uid);

    // A COLOR THAT IS NOT ITS NEIGHBOR'S. Seeding off state.routes.length the way
    // addRoute does would hand the new route the same hue as an existing one once
    // routes have been deleted, and two adjacent routes in one color is the one case
    // the palette exists to prevent.
    const used = new Set(state.routes.map((d) => d.color));
    cut.second.color =
      ROUTE_COLORS.find((c) => !used.has(c)) || ROUTE_COLORS[state.routes.length % ROUTE_COLORS.length];

    // The second route begins the morning after the first one ends, and the first
    // one's end has just changed — it lost every leg past the cut — so it is
    // resynced before being read. A route the rider never dated seeds nothing.
    state.routes.splice(r, 1, cut.first, cut.second);
    syncEnd(cut.first);
    if (cut.first.startAt) cut.second.startAt = nextMorningAfter(cut.first.endAt);

    renderRoutes();
    rebuildLayers();
    renderMarkers();
    refreshDerived();
    markDirty();
    // The rider's attention is on the new route: they asked where one ended, and
    // what they want to see is what now follows it.
    goToRoute(r + 1);
  }

  function deleteRoute() {
    // GUARDS BEFORE beginEdit, not after. All four of these functions had it the
    // other way round, so refusing to delete a ride's last route still pushed an
    // undo step — the rider then pressed undo and nothing visible happened.
    if (state.routes.length <= 1) return toast(cap(an(W("journey"))) + " needs at least one " + W("route"), true);
    const r = editIndex();
    if (r == null) return noRouteYet();
    beginEdit("delete route");
    state.routes.splice(r, 1);
    state.legSeq.splice(r, 1);
    // Deleting one of a pair leaves a group of one, which is not a group. The
    // server would repair it on the next save anyway; doing it here means the
    // panel and the map agree with the totals immediately rather than after a
    // round trip.
    ALT.resolveAltGroups(state.routes);
    // Clamped, not preserved: deleting the last route would leave the active index
    // one past the end, and activeIndex() would quietly clamp it on every read
    // while the highlight sat on nothing.
    state.active = Math.min(r, state.routes.length - 1);
    renderRoutes();
    rebuildLayers();
    renderMarkers();
    refreshDerived();
    markDirty();
  }

  // Ride the route backwards.
  //
  // Every leg has to be re-requested, not reversed in place: a leg's geometry is
  // directional, and the way back is frequently not the way out drawn backwards.
  // One-way streets, divided carriageways and turn restrictions all mean the
  // router has to answer the question again.
  //
  // That costs one Routes call per leg, which is why a long route asks first.
  /**
    * Toggle one routing preference on a route, and re-route it (#29).
    *
    * PATCHED IN PLACE, NEVER RE-RENDERED: renderRouteList() would destroy whatever
    * the rider is typing and drop focus to <body> — #188 from a control with
    * nothing to do with the route's contents.
    *
    * RE-ROUTES EVERY LEG, because that is what the toggle MEANS — the preference
    * with the old roads drawn is a lie on the map and a wrong number in every
    * total. It asks first at the same threshold .route-rev uses: this bills a
    * Routes call per leg.
    */
  function togglePref(r, btn) {
    const route = state.routes[r];
    if (!route) return;
    const key = btn.dataset.pref;
    if (!key) return;

    const legCount = Math.max(0, route.points.length - 1);
    const turningOn = !(route.routePrefs && route.routePrefs[key]);
    if (
      legCount > 12 &&
      !window.confirm("Changing this re-routes all " + legCount + " legs of this route. Continue?")
    ) {
      return;
    }

    beginEdit("routing preference");
    const next = Object.assign({}, route.routePrefs);
    if (turningOn) next[key] = true;
    else delete next[key];
    // Null rather than {} for an empty set, so the route matches what the server
    // will store and the two cannot disagree about whether it changed.
    route.routePrefs = prefsBody(next);

    btn.classList.toggle("is-on", turningOn);
    btn.setAttribute("aria-pressed", turningOn ? "true" : "false");

    if (legCount) {
      state.legSeq[r] = [];
      computeLegsAround(
        r,
        Array.from({ length: legCount }, (_, i) => i),
      );
    }
    markDirty();
    const label = ROUTE_PREFS.find((p) => p.key === key);
    toast(
      (turningOn ? "Avoiding " : "No longer avoiding ") +
        (label ? label.label.toLowerCase() : "that") +
        " on " +
        routeLabel(r) +
        (legCount ? "—re-routing" : ""),
    );
  }

  function reverseRoute() {
    const r = editIndex();
    if (r == null) return noRouteYet();
    const route = state.routes[r];
    // POINTS, not stops. A route of three POIs draws a road and has something to
    // reverse; counting stops would have told the rider there was nothing there.
    if (route.points.length < 2) return toast("Nothing to reverse yet", true);

    const legCount = Math.max(0, route.points.length - 1);
    // "re-routes", not "re-routes" — a find-and-replace during the 2026-08-09
    // routes→routes rename caught this string, which a rider reads in a dialog.
    if (legCount > 12 && !window.confirm("Reversing re-routes all " + legCount + " legs of this route. Continue?"))
      return;

    // Every guard and the confirm are behind us, so this is the first point at
    // which the route is certainly going to change.
    beginEdit("reverse route");
    // REVERSE THE WHOLE LIST, both kinds. A POI has a place in the order now, and
    // a route ridden backwards passes its viewpoints in the opposite order too —
    // leaving them where they were would strand each one beside the wrong leg.
    route.points.reverse();

    // A stop tagged as the start is the finish now. Nothing else about a role
    // has a direction — a gas stop is a gas stop either way round.
    route.points.forEach((s) => {
      s.roles = (s.roles || []).map((role) => (role === "start" ? "finish" : role === "finish" ? "start" : role));
    });

    // Not reversed: legs and their shaping points are both directional and both
    // stale. Dropping them wholesale is cheaper than reasoning about which
    // survive, and computeLeg refills them from the new stop order.
    route.legs = [];
    state.legSeq[r] = [];

    renderTrack(r);
    renderMarkers();
    renderList();
    computeLegsAround(
      r,
      Array.from({ length: legCount }, (_, i) => i),
    );
    refreshDerived();
    markDirty();
    toast(routeLabel(r) + " reversed");
  }

  // --- Select mode ----------------------------------------------------------
  //
  // Checkboxes on every peer and a bar offering what can be done to the set. The
  // alternative to "select four routes and delete them" is doing it four times,
  // and grouping routes as alternates is inherently multi-route.
  //
  // TWO SCOPES, NEVER BOTH: "delete the selected" has to mean routes or points.
  // Opening one closes the other.
  const pointKey = (r, kind, i) => r + ":" + kind + ":" + i;

  function startSelect(scope) {
    closeMenu();
    state.select = { scope, routes: new Set(), points: new Set() };
    renderRoutes();
    renderSelectBar();
  }

  function endSelect() {
    if (!state.select) return;
    state.select = null;
    renderRoutes();
    renderSelectBar();
  }

  const selectedRoutes = () => [...(state.select?.routes ?? [])].sort((a, b) => a - b);

  // Grouped by route and sorted DESCENDING within each, which is the order a
  // caller must splice in — ascending is off by one more with every removal and
  // the bug is silent.
  function selectedPointsByRoute() {
    const byRoute = new Map();
    for (const key of state.select?.points ?? []) {
      const [r, kind, i] = key.split(":");
      const route = Number(r);
      if (!byRoute.has(route)) byRoute.set(route, []);
      byRoute.get(route).push({ kind, i: Number(i) });
    }
    for (const list of byRoute.values()) list.sort((a, b) => b.i - a.i);
    return byRoute;
  }

  const selectedPointCount = () => state.select?.points.size ?? 0;

  function renderSelectBar() {
    const bar = $("select-bar");
    if (!bar) return;
    const sel = state.select;
    if (!sel) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    const isRoute = sel.scope === "route";
    const n = isRoute ? sel.routes.size : sel.points.size;
    const noun = isRoute ? (n === 1 ? "route" : "routes") : n === 1 ? "point" : "points";
    // Buttons are disabled rather than hidden at n === 0, so the bar is the same
    // shape the moment it opens as it is once something is ticked.
    const off = n === 0 ? " disabled" : "";
    const routeBtns =
      '<button type="button" data-sel="group"' +
      (sel.routes.size < 2 ? " disabled" : "") +
      ">Group as alternatives</button>" +
      '<button type="button" data-sel="duplicate"' +
      off +
      ">Duplicate</button>";
    const pointBtns =
      '<label class="sel-move">Move to <select data-sel="move-to">' +
      '<option value="">route…</option>' +
      state.routes.map((_, r) => '<option value="' + r + '">' + esc(routeNumber(r)) + "</option>").join("") +
      "</select></label>";
    bar.hidden = false;
    bar.innerHTML =
      '<span class="sel-count">' +
      n +
      " " +
      noun +
      " selected</span>" +
      '<button type="button" data-sel="all">All</button>' +
      '<button type="button" data-sel="none"' +
      off +
      ">None</button>" +
      (isRoute ? routeBtns : pointBtns) +
      '<button type="button" class="is-danger" data-sel="delete"' +
      off +
      ">Delete</button>" +
      '<button type="button" data-sel="done">Done</button>';
  }

  // Group the selected routes as alternatives of one another. The entry point for
  // the whole alternates feature — everything else about them (ghosting, the
  // totals, the numbering) has been in place since they could only be created by
  // hand-writing a payload.
  function groupSelectedAsAlts() {
    const rows = selectedRoutes();
    if (rows.length < 2) return toast("Pick at least two routes", true);
    if (rows.some((r) => state.routes[r].altGroup != null)) {
      return toast("One of those is already an alternative—ungroup it first", true);
    }
    // A WARNING, NOT A REFUSAL. docs/ROADMAP.md defines an alternate as two paths
    // that share a start and an end, and route-level grouping cannot enforce that:
    // if two alternates finish in different towns, the following route starts with
    // a hole in the ride and nothing else in the app would mention it. The rider
    // may well know what they mean, so this says so and continues.
    const gap = endpointGap(rows);
    beginEdit("group as alternatives");
    const id = Math.max(-1, ...state.routes.map((d) => (d.altGroup == null ? -1 : d.altGroup))) + 1;
    rows.forEach((r, k) => {
      state.routes[r].altGroup = id;
      state.routes[r].altActive = k === 0;
    });
    ALT.resolveAltGroups(state.routes);
    endSelect();
    rebuildLayers();
    renderMarkers();
    refreshDerived();
    markDirty();
    if (gap) toast(gap, true);
    else toast(rows.length + " routes are now alternatives—only the first counts");
  }

  // The message for a group whose members do not start and end together, or null
  // when they do. Compared against the first selected route, which is the one that
  // becomes active.
  function endpointGap(rows) {
    // The first and last POINTS of each candidate. Where a route starts and ends is
    // where its road starts and ends, and both ends anchor a leg whatever kind
    // they are.
    const ends = rows.map((r) => {
      const pts = state.routes[r].points;
      return pts.length ? { first: pts[0], last: pts[pts.length - 1] } : null;
    });
    const base = ends[0];
    if (!base) return null;
    const far = (a, b) => a && b && haversineMi(a, b) > 0.06; // ~100 m, as the importer uses
    for (let k = 1; k < ends.length; k++) {
      const e = ends[k];
      if (!e) continue;
      if (far(base.first, e.first) || far(base.last, e.last)) {
        return "Those alternatives do not start and end in the same place—whichever you ride, the next route may not join up.";
      }
    }
    return null;
  }

  function haversineMi(a, b) {
    const R = 3958.7613;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ONE beginEdit FOR THE WHOLE BATCH, in every one of these. Looping over
  // deleteRoute() would push an undo step per route and leave the rider pressing
  // undo four times to put back one action — which is why the single-item
  // mutators had their guards moved ahead of their beginEdit in step 8 and why
  // these do the splicing themselves rather than calling them.
  function deleteSelectedRoutes() {
    const rows = selectedRoutes();
    if (!rows.length) return;
    if (rows.length >= state.routes.length)
      return toast(cap(an(W("journey"))) + " needs at least one " + W("route"), true);
    beginEdit("delete routes");
    // Descending, so each splice cannot shift the index of one still to come.
    [...rows].reverse().forEach((r) => {
      state.routes.splice(r, 1);
      state.legSeq.splice(r, 1);
    });
    state.active = Math.min(state.active, state.routes.length - 1);
    ALT.resolveAltGroups(state.routes);
    endSelect();
    rebuildLayers();
    renderMarkers();
    refreshDerived();
    markDirty();
    toast(rows.length + " routes deleted");
  }

  function duplicateSelectedRoutes() {
    const rows = selectedRoutes();
    if (!rows.length) return;
    if (state.routes.length + rows.length > MAX_ROUTES) return toast("Route limit reached (" + MAX_ROUTES + ")", true);
    beginEdit("duplicate routes");
    // Descending again: each insertion shifts everything after it, and going
    // backwards means the indices still to come are untouched.
    [...rows].reverse().forEach((r) => {
      const src = state.routes[r];
      state.routes.splice(r + 1, 0, {
        ...src,
        title: src.title ? src.title + " (copy)" : "",
        // A FRESH uid, or the spread above copies the original's and the save
        // fails uq_route_ride_uid — the same reason a duplicated point gets one.
        uid: uid(),
        altGroup: null,
        altActive: true,
        points: src.points.map((pt) => ({ ...pt, roles: (pt.roles || []).slice() })),
        legs: src.legs.map((l) => ({ ...l, viaPoints: (l.viaPoints || []).slice() })),
      });
      state.legSeq.splice(r + 1, 0, []);
    });
    ALT.resolveAltGroups(state.routes);
    endSelect();
    rebuildLayers();
    renderMarkers();
    refreshDerived();
    markDirty();
    toast(rows.length + " routes duplicated");
  }

  // Rebuild a route's legs after some points have gone, keeping every leg the
  // removal did not touch and carrying the shaping points of the ones it did onto
  // the leg that replaces them. Call with the point count and leg array as they
  // were BEFORE the splices; returns the leg indices now holding a placeholder.
  //
  // What this replaced: `route.legs = []` and a re-route of everything — correct,
  // and why a rider who deleted one point out of thirty lost every shaping point
  // they had drawn and paid for twenty-nine routing requests to be told the other
  // roads had not changed.
  function rejoinRouteLegs(route, beforeLegs, beforePoints, removed) {
    const stale = [];
    let trimmed = false;
    route.legs = rejoinSpans(beforePoints, removed).map((span, j) => {
      const whole = span.from === span.to && beforeLegs[span.from];
      if (whole) return whole;
      const vias = [];
      for (let k = span.from; k <= span.to; k++) {
        if (beforeLegs[k]) vias.push(...(beforeLegs[k].viaPoints || []));
      }
      if (vias.length > MAX_VIAS_PER_LEG) {
        vias.length = MAX_VIAS_PER_LEG;
        trimmed = true;
      }
      const a = route.points[j];
      const b = route.points[j + 1];
      stale.push(j);
      return straightLeg([a.lng, a.lat], [b.lng, b.lat], vias);
    });
    return { stale, trimmed };
  }

  function deleteSelectedPoints() {
    const byRoute = selectedPointsByRoute();
    const n = selectedPointCount();
    if (!n) return;
    // Every point removed drops the legs either side and re-requests one, so a
    // big selection is real money and a visibly empty map while it runs. Same
    // threshold and same reasoning as reverseRoute's confirm. Counted over both
    // kinds now — a POI costs exactly what a stop costs.
    if (n > 12 && !window.confirm("Deleting " + n + " points re-routes the legs around each. Continue?")) return;
    beginEdit("delete points");
    const stale = new Map();
    let trimmed = false;
    for (const [r, list] of byRoute) {
      const route = state.routes[r];
      if (!route) continue;
      const beforeLegs = route.legs;
      const beforePoints = route.points.length;
      // Already sorted descending by selectedPointsByRoute().
      list.forEach((p) => route.points.splice(p.i, 1));
      // A DAY MUST KEEP A STOP. A selection can take every stop and leave the
      // POIs, which the API refuses and payload() drops the route for — so the
      // first survivor is promoted, the same rule addPoint applies to a route's
      // first point and the cross-route drag applies to a route that has just lost
      // its only anchor.
      ensureRouteHasStop(route);
      const out = rejoinRouteLegs(
        route,
        beforeLegs,
        beforePoints,
        list.map((p) => p.i),
      );
      stale.set(r, out.stale);
      trimmed = trimmed || out.trimmed;
      state.legSeq[r] = [];
    }
    const touched = [...byRoute.keys()];
    endSelect();
    rebuildLayers();
    renderMarkers();
    touched.forEach((r) => {
      const idx = stale.get(r);
      if (idx && idx.length) computeLegsAround(r, idx);
    });
    if (trimmed) toast("Some legs kept only the first " + MAX_VIAS_PER_LEG + " shaping points", true);
    refreshDerived();
    markDirty();
    toast(n + " points deleted");
  }

  function moveSelectedPoints(toRoute) {
    const byRoute = selectedPointsByRoute();
    const n = selectedPointCount();
    const dst = state.routes[toRoute];
    if (!n || !dst) return;
    beginEdit("move points");
    const moved = [];
    const stale = new Map();
    let trimmed = false;
    for (const [r, list] of byRoute) {
      const route = state.routes[r];
      if (!route || r === toRoute) continue;
      const beforeLegs = route.legs;
      const beforePoints = route.points.length;
      list.forEach((p) => {
        const [pt] = route.points.splice(p.i, 1);
        if (pt) moved.push({ kind: p.kind, pt });
      });
      // Same rule as the bulk delete: moving every stop out of a route leaves one
      // the save refuses, so the first point left behind becomes the anchor.
      ensureRouteHasStop(route);
      // And the same re-join: a leg between two points that both stayed behind
      // is the same road, shaping points and all.
      const out = rejoinRouteLegs(
        route,
        beforeLegs,
        beforePoints,
        list.map((p) => p.i),
      );
      stale.set(r, out.stale);
      trimmed = trimmed || out.trimmed;
      state.legSeq[r] = [];
    }
    // Reversed, because each route's list was spliced descending and the points
    // came off in the opposite order to the one they were in.
    const dstBase = dst.points.length;
    moved.reverse().forEach(({ pt }) => dst.points.push(pt));
    // And the destination, which can be a route whose points all arrived as POIs.
    ensureRouteHasStop(dst);
    // The arrivals land on the END of the destination, so every leg it already
    // had still joins the two points it always joined — only the leg that
    // reaches the first arrival and the legs among the arrivals are new. Keeping
    // the rest keeps the destination's own shaping points, and spends no routing
    // request on a road that has not changed.
    dst.legs.length = Math.min(dst.legs.length, Math.max(0, dstBase - 1));
    fillMissingLegs(dst);
    state.legSeq[toRoute] = [];
    const dstStale = [];
    for (let k = Math.max(0, dstBase - 1); k < dst.points.length - 1; k++) dstStale.push(k);
    stale.set(toRoute, dstStale);
    const touched = new Set([...byRoute.keys(), toRoute]);
    endSelect();
    setActive(toRoute);
    rebuildLayers();
    renderMarkers();
    touched.forEach((r) => {
      const idx = stale.get(r);
      if (idx && idx.length) computeLegsAround(r, idx);
    });
    if (trimmed) toast("Some legs kept only the first " + MAX_VIAS_PER_LEG + " shaping points", true);
    refreshDerived();
    markDirty();
    toast(moved.length + " points moved to " + routeLabel(toRoute));
  }

  // Copy a whole route, inserted straight after the original.
  //
  // The legs come across as they are: the copy has the same stops in the same
  // order, so asking the router again costs one call per leg to be told so. Every
  // array is copied rather than shared — a shared `roles` array would have a role
  // added to the copy appear on the original.
  //
  // This is what "make an alternate" is built on: duplicate, change the copy,
  // group the two.
  function duplicateRoute(r) {
    if (state.routes.length >= MAX_ROUTES) return toast("Route limit reached (" + MAX_ROUTES + ")", true);
    const src = state.routes[r];
    if (!src) return;
    beginEdit("duplicate route");
    const copy = {
      ...src,
      title: src.title ? src.title + " (copy)" : "",
      // A FRESH uid, for the same reason the multi-route duplicate above mints
      // one: the spread would otherwise carry the original's and the save would
      // fail uq_route_ride_uid.
      uid: uid(),
      // The copy is NOT part of its original's group. A duplicate of one
      // alternate would otherwise silently become a third member of a group the
      // rider has not been asked about.
      altGroup: null,
      altActive: true,
      points: src.points.map((pt) => ({ ...pt, roles: (pt.roles || []).slice() })),
      legs: src.legs.map((l) => ({ ...l, viaPoints: (l.viaPoints || []).slice() })),
    };
    state.routes.splice(r + 1, 0, copy);
    state.legSeq.splice(r + 1, 0, []);
    ALT.resolveAltGroups(state.routes);
    setActive(r + 1);
    renderRoutes();
    rebuildLayers();
    renderMarkers();
    refreshDerived();
    markDirty();
    toast("Duplicated to " + routeLabel(r + 1));
  }

  // Choose a different member of a group as the one being ridden. This is the
  // resolution step — the point at which a rider stops weighing two roads and
  // picks one — and it is why altActive exists as a flag rather than the group's
  // first route simply winning: promoting must not reorder the ride and renumber
  // every route after it.
  function promoteAlt(r) {
    const route = state.routes[r];
    if (!route || route.altGroup == null || route.altActive) return;
    beginEdit("choose alternative");
    state.routes.forEach((d) => {
      if (d.altGroup === route.altGroup) d.altActive = false;
    });
    route.altActive = true;
    ALT.resolveAltGroups(state.routes);
    renderRoutes();
    renderMarkers();
    refreshDerived();
    markDirty();
    toast("Now " + W("travel") + " " + routeLabel(r));
  }

  // Break a group apart: every member becomes an ordinary route again and all of
  // them start counting toward the ride. The way out of a grouping, without
  // which the feature is a trap.
  function ungroupAlts(r) {
    const route = state.routes[r];
    if (!route || route.altGroup == null) return;
    beginEdit("ungroup alternatives");
    const group = route.altGroup;
    let n = 0;
    state.routes.forEach((d) => {
      if (d.altGroup !== group) return;
      d.altGroup = null;
      d.altActive = true;
      n++;
    });
    ALT.resolveAltGroups(state.routes);
    renderRoutes();
    renderMarkers();
    refreshDerived();
    markDirty();
    toast(n + " routes are separate routes again");
  }

  function moveRoute(dir) {
    const r = editIndex();
    if (r == null) return noRouteYet();
    const j = r + dir;
    // At either end there is nothing to do, and pushing an undo step for it
    // means the rider's next undo silently spends itself on a no-op.
    if (j < 0 || j >= state.routes.length) return;
    beginEdit("move route");
    const a = state.routes;
    [a[r], a[j]] = [a[j], a[r]];
    const s = state.legSeq;
    [s[r], s[j]] = [s[j] || [], s[r] || []];
    state.active = j;
    renderRoutes();
    rebuildLayers();
    renderMarkers();
    markDirty();
  }

  // THE NUMBER IS THE POSITION AND THE NAME IS THE NAME. They used to be one
  // field, so naming a route REPLACED its number — which reads fine until routes
  // can be reordered, where a route called "Route 2" dragged into third place is
  // wrong and cannot be corrected, because the text is the title.
  // NOT `r + 1`, which it was until alternates: a ride whose routes 3 and 4 are
  // two ways to do one Thursday has four sections and is a three-route ride, so
  // active routes number 1..N and a losing alternate takes its group's number with
  // a letter — 3, 3b, 3c.
  //
  // Recomputed per call rather than cached, because it depends on every other
  // route. TBAlt.routeOrdinals does the whole array in one pass.
  const routeNumber = (r) => ALT.routeOrdinal(state.routes, r);
  const routeName = (r) => (state.routes[r] && state.routes[r].title) || "";

  // For prose — toasts, the timeline readout, the totals line. Both parts when
  // there is a name, the number alone when there is not.
  function routeLabel(r) {
    const name = routeName(r);
    return name ? Wc("route") + " " + routeNumber(r) + SEP + name : Wc("route") + " " + routeNumber(r);
  }

  // EVERY ROUTE, RENDERED AT ONCE. This replaced renderSlider +
  // renderRouteEditing + renderRouteHead, which showed one route and hid the rest
  // behind a slider at the bottom of the drawer.
  //
  // Structure is rebuilt here; VALUES are not written back on every keystroke,
  // which is why typing in a route title does not lose the caret. So this is
  // called only when the SET of routes changes.
  function renderRoutes() {
    const host = $("route-list");
    if (!host) return;
    // AN OPEN SLOT DOES NOT SURVIVE A STRUCTURAL REBUILD. This runs when points
    // are deleted, reordered, moved between routes or a route is added — all of which
    // shift the indices the slot is expressed in, so "before points[3]" stops
    // meaning the gap the rider was looking at. Closing it is honest; silently
    // pointing somewhere else is not.
    //
    // renderRouteList() deliberately does NOT do this, which is what lets opening a
    // slot render itself.
    state.insertAt = null;
    // Same reasoning: {route, i} stops meaning the row the rider was looking at the
    // moment a delete or a reorder shifts the indices.
    state.rolesOpen = null;
    const open = openSections();
    host.innerHTML = state.routes.map((route, r) => routeSectionHtml(route, r, open)).join("");
    state.routes.forEach((_, r) => renderRouteList(r));
    markActiveSection();
    renderRailRoutes();
    $("route-empty-hint").hidden = state.routes.length > 0;
    // One Sortable per route list, all in the same group, so a stop can be dragged
    // from one route into another. See initDragToReorder.
    host.querySelectorAll(".point-list").forEach((el) => initDragToReorder(el));
    initRouteDrag(host);
    // Here rather than on its own, because the two disagree the moment they are
    // separate: a route's picker lists the subgroups and the editor renames them,
    // so a rename that redrew only the editor would leave every picker showing
    // the old name until something else happened to re-render.
    renderSubgroups();
    applyReadOnly();
  }

  /**
    * Turn the panel's controls off for a rider who may look but not write.
    *
    * Runs after every render because the route list is rebuilt wholesale.
    *
    * It disables FIELDS, not buttons wholesale: the tab strip, the route rail and
    * the row menus are how a reader moves around, and a panel whose every button is
    * dead is not read-only, it is broken. `.builder-readonly` on the body hides the
    * controls that only make sense for an editor.
    */
  function applyReadOnly() {
    if (CAN_EDIT) return;
    document.body.classList.add("builder-readonly");
    document.querySelectorAll(".builder-panel input, .builder-panel textarea, .builder-panel select").forEach((el) => {
      el.disabled = true;
    });
  }

  // --- The panel's three tabs -----------------------------------------------
  //
  // Routes, Groups and Riders. Adding the rider and group layers to the densest
  // surface in the app turned it into one long scroll, with the route being edited
  // pushed below the fold by a feature about people.
  //
  // THE BEHAVIOR IS public/js/tabs.js, shared with the ride lists. What is left
  // here is the one thing this strip does that a generic one does not: fetch the
  // roster when the Riders tab opens. init() is called directly rather than
  // through `data-tabs`, which is why this function exists.

  function initTabs() {
    const strip = document.querySelector(".panel-tabs");
    if (!strip || !window.TBTabs) return;
    window.TBTabs.init(strip, (tab) => {
      // The Riders tab is the only one whose contents come from the server, and
      // it is fetched on open rather than on load: most sessions never open it,
      // and the roster can change while the builder is sitting there. loadRiders
      // caches, so flipping between tabs does not re-fetch.
      if (tab.id === "tab-riders") loadRiders();
    });
  }

  // --- The Riders tab --------------------------------------------------------
  //
  // Who is coming, what they are bringing, and which approach they are on. The
  // read is /api/rides/:id/riders — see the foot of src/routes/roster.tsx for why
  // only two verbs are here.
  //
  // NOT A SECOND ROSTER: RSVP, bike, invite and the vote are statements BY a rider
  // and stay on the roster page. What is here is the part about the plan.
  //
  // THE GROUP PICKER IS THE ONE PLACE ids AND uids MEET. Everything else holds a
  // subgroup by uid; `ride_members.subgroup_id` is a numeric id that does not
  // exist until the first save. So the options come from the SERVER's list, and a
  // group just added is missing until the autosave lands — which `unsavedGroups`
  // says out loud rather than leaving it silently unpickable.

  // The last response, so flipping between tabs does not re-fetch.
  //
  // IT EXPIRES RATHER THAN LIVING FOR THE SESSION: the roster is also editable
  // from /m/:slug/riders in another window, and a cache with no clock would show
  // this session's opening snapshot an hour later.
  const RIDERS_TTL_MS = 15000;
  let ridersCache = null;
  let ridersAt = 0;
  let ridersLoading = false;

  const RSVP_LABELS = { going: "coming", maybe: "maybe", declined: "not coming" };

  /** The roster may have changed underneath us—drop the cache so the next open
   *  re-reads, and re-read now if the tab is on screen. */
  function ridersStale() {
    ridersCache = null;
    ridersAt = 0;
    if ($("panel-riders") && !$("panel-riders").hidden) loadRiders();
  }

  async function loadRiders() {
    const host = $("riders-body");
    if (!host) return;
    // NOTHING TO READ UNTIL THE FIRST SAVE. A ride that has never been saved has
    // no row and therefore no roster; seedOwner() puts the owner on it inside the
    // same transaction that inserts the ride, so the moment there is one this is
    // never empty again. The autosave makes that a few seconds, which is why this
    // says "once it saves" rather than asking the rider to do anything.
    if (!state.rideId) {
      host.innerHTML =
        '<p class="riders-empty">' +
        esc(Wsc("person")) +
        " appear here once the " +
        esc(W("journey")) +
        " saves. You are on it already—every " +
        esc(W("journey")) +
        " has its planner on the roster.</p>";
      return;
    }
    if (ridersCache && Date.now() - ridersAt < RIDERS_TTL_MS) return renderRiders(ridersCache);
    if (ridersLoading) return;
    ridersLoading = true;
    if (!host.innerHTML) host.innerHTML = '<p class="riders-empty">Loading…</p>';
    try {
      const res = await fetch("/api/rides/" + state.rideId + "/riders");
      if (!res.ok) throw new Error("could not load the roster");
      ridersCache = await res.json();
      ridersAt = Date.now();
      renderRiders(ridersCache);
    } catch (e) {
      host.innerHTML = '<p class="riders-empty is-error">' + esc(e.message) + "</p>";
    } finally {
      ridersLoading = false;
    }
  }

  // --- Comments -------------------------------------------------------------
  //
  // TWO ANCHORS, ONE LIST. A comment hangs off a POINT by uid, or off the RIDE
  // when it has none — "is this hotel actually walkable" versus "can we leave an
  // hour earlier". Read in one place below the tabs, because a fourth tab would
  // undo the three-tab decision; WRITTEN from two.
  //
  // A COMMENT WHOSE POINT IS DELETED IS NOT DELETED WITH IT — the server clears
  // its anchor and it carries on at ride level, still labeled with the stop it was
  // about (demoteOrphanComments). Nothing here handles that specially.
  let commentsCache = null;
  let commentsLoading = false;
  // What the composer is anchored to: a point uid, or null for the ride.
  let commentAnchor = null;

  async function loadComments(force) {
    const host = $("comments-body");
    if (!host || !state.rideId) return;
    if (commentsCache && !force) return renderComments();
    if (commentsLoading) return;
    commentsLoading = true;
    if (!host.innerHTML) host.innerHTML = '<p class="comments-empty">Loading…</p>';
    try {
      const res = await fetch("/api/rides/" + state.rideId + "/comments");
      if (!res.ok) throw new Error("could not load the comments");
      commentsCache = await res.json();
      renderComments();
    } catch (e) {
      host.innerHTML = '<p class="comments-empty is-error">' + esc(e.message) + "</p>";
    } finally {
      commentsLoading = false;
    }
  }

  /** The name to file a new comment under. Copied from what the commenter is
   *  LOOKING AT rather than resolved later: the point may not be saved yet, and
   *  once it is deleted there is nothing left to read a name off. */
  function labelForUid(uid) {
    for (const route of state.routes) {
      for (const pt of route.points) if (pt.uid === uid) return pt.name || pt.label || "";
    }
    return "";
  }

  function commentRowHtml(c) {
    const mine = commentsCache && c.authorId === commentsCache.viewerId;
    const canManage = mine || window.TB.isOwner === true;
    const when = new Date(c.createdAt);
    return (
      '<li class="comment' +
      (c.resolvedAt ? " is-resolved" : "") +
      '" data-cid="' +
      c.id +
      '">' +
      '<div class="comment-meta">' +
      "<strong>" +
      esc(c.authorName) +
      "</strong>" +
      (c.pointLabel ? '<span class="comment-on">on ' + esc(c.pointLabel) + "</span>" : "") +
      '<time datetime="' +
      esc(c.createdAt) +
      '">' +
      esc(when.toLocaleDateString()) +
      "</time>" +
      "</div>" +
      '<p class="comment-body">' +
      esc(c.body) +
      "</p>" +
      (canManage
        ? '<div class="comment-acts">' +
          '<button type="button" class="linkbtn" data-cact="' +
          (c.resolvedAt ? "reopen" : "resolve") +
          '">' +
          (c.resolvedAt ? "Reopen" : "Mark done") +
          "</button>" +
          '<button type="button" class="linkbtn is-danger" data-cact="delete">Delete</button>' +
          "</div>"
        : "") +
      "</li>"
    );
  }

  function renderComments() {
    const host = $("comments-body");
    const count = $("comments-count");
    if (!host || !commentsCache) return;
    const all = commentsCache.comments;
    const open = all.filter((c) => !c.resolvedAt);
    if (count) {
      count.textContent = String(open.length);
      count.hidden = open.length === 0;
    }
    const list = all.length
      ? '<ul class="comment-list">' + all.map(commentRowHtml).join("") + "</ul>"
      : '<p class="comments-empty">Nothing said yet.</p>';
    // The composer is only drawn for somebody who may actually post. A box that
    // refuses on submit is worse than no box — see canPost, which the server
    // re-checks whatever this page decided.
    const composer = commentsCache.canPost
      ? '<form class="comment-new" id="comment-new">' +
        '<label class="visually-hidden" for="comment-body">Your comment</label>' +
        '<textarea id="comment-body" rows="2" maxlength="4000" placeholder="' +
        (commentAnchor ? "Comment on " + esc(labelForUid(commentAnchor)) : "Comment on this " + esc(W("journey"))) +
        '"></textarea>' +
        '<div class="comment-new-acts">' +
        (commentAnchor
          ? '<button type="button" class="linkbtn" id="comment-unanchor">On the whole ride instead</button>'
          : "") +
        '<button class="btn btn-sm" type="submit">Post</button>' +
        "</div>" +
        "</form>"
      : "";
    host.innerHTML = list + composer;
  }

  async function postComment(body) {
    const res = await fetch("/api/rides/" + state.rideId + "/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body,
        pointUid: commentAnchor,
        pointLabel: commentAnchor ? labelForUid(commentAnchor) : null,
      }),
    });
    if (!res.ok) throw new Error("could not post that comment");
    commentAnchor = null;
    await loadComments(true);
  }

  async function commentVerb(cid, act) {
    const url = "/api/rides/" + state.rideId + "/comments/" + cid + "/" + (act === "delete" ? "delete" : "resolve");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ open: act === "reopen" }),
    });
    if (!res.ok) throw new Error("that did not work");
    await loadComments(true);
  }

  /** Point the composer at one stop and scroll it into view. What the row menu's
   *  "Comment on this stop" does. */
  function commentOnPoint(uid) {
    commentAnchor = uid;
    renderComments();
    const box = $("comment-body");
    if (box) {
      box.scrollIntoView({ block: "center", behavior: "smooth" });
      box.focus();
    }
  }

  // --- Suggestions ----------------------------------------------------------
  //
  // A SUGGESTION IS A WHOLE ROUTE, PROPOSED AGAINST THAT ROUTE AS IT WAS. A rider
  // below `edit` still edits the panel normally — markDirty keeps their work in
  // `state` and files nothing — and Suggest posts what they are looking at.
  //
  // STALENESS IS THE SERVER'S ANSWER AND IS NEVER COMPUTED HERE: it compares the
  // route's fingerprint now against the one taken when the proposal was made, and
  // re-checks on accept. Applying a proposal made against a route that has since
  // moved is the one real hazard the feature has.
  let suggestionsCache = null;
  let suggestionsLoading = false;

  const SUGGESTION_LABELS = {
    pending: "Waiting on the owner",
    stale: "The route changed—needs redoing",
    accepted: "Accepted",
    discarded: "Not taken",
    withdrawn: "Withdrawn",
  };

  async function loadSuggestions(force) {
    const host = $("suggestions-body");
    if (!host || !state.rideId) return;
    if (suggestionsCache && !force) return renderSuggestions();
    if (suggestionsLoading) return;
    suggestionsLoading = true;
    try {
      const res = await fetch("/api/rides/" + state.rideId + "/suggestions");
      if (!res.ok) throw new Error("could not load the suggestions");
      suggestionsCache = await res.json();
      renderSuggestions();
    } catch (e) {
      host.innerHTML = '<p class="comments-empty is-error">' + esc(e.message) + "</p>";
    } finally {
      suggestionsLoading = false;
    }
  }

  function suggestionRowHtml(sg) {
    const mine = suggestionsCache && sg.authorId === suggestionsCache.viewerId;
    const owner = suggestionsCache && suggestionsCache.isOwner;
    const live = sg.state === "pending";
    // ACCEPT IS OWNER-ONLY AND ONLY WHILE PENDING. Discard stays available on a
    // stale one — clearing a proposal that can no longer be applied is exactly
    // what an owner wants to be able to do with it.
    const acts = [];
    if (owner && live) acts.push('<button type="button" class="linkbtn" data-sact="accept">Accept</button>');
    if (owner && !sg.state.match(/^(accepted|discarded|withdrawn)$/)) {
      acts.push('<button type="button" class="linkbtn" data-sact="discard">Discard</button>');
    }
    if (mine && !sg.state.match(/^(accepted|discarded|withdrawn)$/)) {
      acts.push('<button type="button" class="linkbtn" data-sact="withdraw">Withdraw</button>');
    }
    const routeNo = state.routes.findIndex((d) => d.uid === sg.routeUid);
    return (
      '<li class="comment suggestion is-' +
      esc(sg.state) +
      '" data-sid="' +
      sg.id +
      '">' +
      '<div class="comment-meta">' +
      "<strong>" +
      esc(sg.authorName) +
      "</strong>" +
      '<span class="comment-on">on ' +
      (routeNo >= 0 ? "route " + (routeNo + 1) : "a route that is gone") +
      "</span>" +
      '<span class="suggestion-state">' +
      esc(SUGGESTION_LABELS[sg.state] || sg.state) +
      "</span>" +
      "</div>" +
      (sg.note ? '<p class="comment-body">' + esc(sg.note) + "</p>" : "") +
      (acts.length ? '<div class="comment-acts">' + acts.join("") + "</div>" : "") +
      "</li>"
    );
  }

  function renderSuggestions() {
    const host = $("suggestions-body");
    const count = $("suggestions-count");
    if (!host || !suggestionsCache) return;
    const all = suggestionsCache.suggestions;
    const live = all.filter((sg) => sg.state === "pending");
    if (count) {
      count.textContent = String(live.length);
      count.hidden = live.length === 0;
    }
    host.innerHTML = all.length
      ? '<ul class="comment-list">' + all.map(suggestionRowHtml).join("") + "</ul>"
      : '<p class="comments-empty">Nothing proposed yet.</p>';
    renderSuggestBar();
  }

  /** The propose control, for a rider who may suggest but not save. It names the
   *  route being edited, because a suggestion is one route and picking the wrong one
   *  is the easy mistake. */
  function renderSuggestBar() {
    const host = $("suggestions-body");
    if (!host || CAN_EDIT || !CAN_SUGGEST || !state.rideId) return;
    if (host.querySelector("#suggest-bar")) return;
    const bar = document.createElement("form");
    bar.id = "suggest-bar";
    bar.className = "suggest-bar";
    bar.innerHTML =
      '<label class="visually-hidden" for="suggest-note">Why</label>' +
      '<textarea id="suggest-note" rows="2" maxlength="2000" placeholder="What you changed, and why (optional)"></textarea>' +
      '<button class="btn btn-sm" type="submit">Suggest this route</button>';
    host.appendChild(bar);
  }

  async function postSuggestion(note) {
    const route = editRoute();
    if (!route) throw new Error("open a route first");
    const body = payload();
    const proposed = body.routes.find((d) => d.uid === route.uid);
    if (!proposed) throw new Error("that route has nothing in it to suggest");
    const res = await fetch("/api/rides/" + state.rideId + "/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routeUid: route.uid, route: proposed, note }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error === "too-many" ? "you have too many open suggestions" : "could not suggest that");
    }
    await loadSuggestions(true);
    toast("Suggested. The owner decides whether it lands.");
  }

  async function suggestionVerb(sid, act) {
    const res = await fetch("/api/rides/" + state.rideId + "/suggestions/" + sid + "/" + act, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      // 409 is the stale case and is the one worth naming: the route moved under
      // the proposal, so there is nothing safe to apply.
      throw new Error(
        res.status === 409 ? "that route has changed since—the suggestion needs redoing" : "that did not work",
      );
    }
    await loadSuggestions(true);
    if (act === "accept") location.reload();
  }

  function initSuggestions() {
    const host = $("builder-suggestions");
    if (!host) return;
    host.addEventListener("submit", (e) => {
      if (e.target.id !== "suggest-bar") return;
      e.preventDefault();
      const box = $("suggest-note");
      postSuggestion(box ? box.value.trim() : "").catch((err) => toast(err.message, true));
    });
    host.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || !btn.dataset.sact) return;
      const li = btn.closest(".suggestion");
      if (!li) return;
      suggestionVerb(Number(li.dataset.sid), btn.dataset.sact).catch((err) => toast(err.message, true));
    });
    loadSuggestions(false);
  }

  function initComments() {
    const host = $("builder-comments");
    if (!host) return;
    host.addEventListener("submit", (e) => {
      if (e.target.id !== "comment-new") return;
      e.preventDefault();
      const box = $("comment-body");
      const body = box ? box.value.trim() : "";
      if (!body) return;
      postComment(body).catch((err) => toast(err.message, true));
    });
    host.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.id === "comment-unanchor") {
        commentAnchor = null;
        return renderComments();
      }
      const act = btn.dataset.cact;
      if (!act) return;
      const li = btn.closest(".comment");
      if (!li) return;
      commentVerb(Number(li.dataset.cid), act).catch((err) => toast(err.message, true));
    });
    loadComments(false);
  }

  function renderRiders(data) {
    const host = $("riders-body");
    if (!host) return;

    const count = $("riders-count");
    if (count) count.textContent = data.riders.length ? String(data.riders.length) : "";

    // Groups the rider has added since the last save. They have no id yet, so
    // they cannot be assigned to anybody — said out loud, because a picker
    // quietly missing the group you just made reads as a bug.
    const savedUids = new Set(data.groups.map((g) => g.uid));
    const unsaved = state.meta.subgroups.filter((g) => !savedUids.has(g.uid));

    host.innerHTML =
      '<p class="riders-summary">' +
      data.coming +
      " of " +
      data.riders.length +
      (data.riders.length === 1 ? " " + esc(W("person")) + " is" : " " + esc(Ws("person")) + " are") +
      " coming.</p>" +
      fuelHtml(data.range) +
      '<ul class="riders-list">' +
      data.riders.map((r) => riderRowHtml(r, data.groups)).join("") +
      "</ul>" +
      // A BUTTON, NOT JUST A SENTENCE. Ziad's call, 2026-09-06: the line was accurate
      // and left the rider with nothing to do about it, since the ride saves on its
      // own timer. Pressing this saves and re-reads. It is a plain save — the same one
      // the timer runs — because a second write path is a second thing to keep in step
      // with conflicts, merges and the recovery draft.
      (unsaved.length
        ? '<p class="riders-note">' +
          esc(unsaved.map((g) => g.name).join(", ")) +
          (unsaved.length === 1 ? " is" : " are") +
          " not saved yet, so nobody can be put on " +
          (unsaved.length === 1 ? "it" : "them") +
          " yet. " +
          '<button type="button" class="note-action" id="riders-save">Save the ride</button>' +
          "</p>"
        : "") +
      '<div class="tab-actions">' +
      (state.slug
        ? '<a class="btn btn-sm btn-quiet" href="/m/' + encodeURIComponent(state.slug) + '/riders">Roster</a>'
        : "") +
      "</div>";
  }

  // The same claim the roster page makes, in one line. `null` miles means nobody
  // coming has a range on file — a real answer and not a failure, and the reason
  // this never invents a number: a fuel plan built on a guess is worse than none
  // because it looks like one.
  function fuelHtml(range) {
    if (!range || range.riders === 0) return "";
    if (range.miles === null) {
      return (
        '<p class="riders-fuel is-quiet">No ranges on file, so there is nothing to plan ' +
        esc(W("fuel")) +
        " stops around.</p>"
      );
    }
    return (
      '<p class="riders-fuel">Plan ' +
      esc(W("fuel")) +
      " around <strong>" +
      range.miles +
      " miles</strong>—" +
      esc(range.riderName || "") +
      "'s " +
      esc(range.bikeLabel || "") +
      "." +
      (range.unknown > 0
        ? '<span class="riders-fuel-gap"> ' +
          range.unknown +
          (range.unknown === 1 ? " " + esc(W("person")) + " has" : " " + esc(Ws("person")) + " have") +
          " no range on file, so this could still be optimistic.</span>"
        : "") +
      "</p>"
    );
  }

  function riderRowHtml(r, groups) {
    return (
      '<li class="rider-row" data-rider="' +
      r.riderId +
      '">' +
      '<span class="rider-name">' +
      esc(r.displayName) +
      (r.role === "owner" ? '<span class="rider-tag">owner</span>' : "") +
      "</span>" +
      '<span class="rider-rsvp is-' +
      r.rsvp +
      '">' +
      (RSVP_LABELS[r.rsvp] || r.rsvp) +
      "</span>" +
      (r.bike ? '<span class="rider-bike">' + esc(r.bike) + "</span>" : "") +
      // NO PICKER WHEN THE RIDE HAS NO GROUPS. A select whose only option is
      // "Everyone" is a control that cannot do anything, on every row.
      (groups.length
        ? '<select class="rider-group" aria-label="Group for ' +
          esc(r.displayName) +
          '">' +
          '<option value=""' +
          (r.subgroupId === null ? " selected" : "") +
          ">Everyone</option>" +
          groups
            .map(
              (g) =>
                '<option value="' +
                g.id +
                '"' +
                (r.subgroupId === g.id ? " selected" : "") +
                ">" +
                esc(g.name) +
                "</option>",
            )
            .join("") +
          "</select>"
        : "") +
      (r.canRemove
        ? '<button type="button" class="rider-del" data-tip="rider-del" title="Take ' +
          esc(r.displayName) +
          ' off this ride" aria-label="Remove ' +
          esc(r.displayName) +
          '">×</button>'
        : "") +
      "</li>"
    );
  }

  function wireRiders() {
    const host = $("riders-body");
    if (!host) return;

    // Delegated, because renderRiders replaces every row.
    host.addEventListener("change", async (e) => {
      if (!e.target.classList.contains("rider-group")) return;
      const row = e.target.closest(".rider-row");
      if (!row) return;
      const raw = e.target.value;
      const ok = await riderPost("group", {
        rider: Number(row.dataset.rider),
        // JSON null rather than "", so the server does not have to guess whether
        // an empty string meant "no group" or a missing field.
        group: raw === "" ? null : Number(raw),
      });
      // Re-read rather than patching the cache: the answer is the server's, and
      // a row left showing an assignment that was refused is the worst outcome
      // available here.
      ridersStale();
      if (!ok) toast("That group could not be set.", true);
    });

    // SAVE, THEN RE-READ. The group picker is built from the SERVER's list, which
    // carries both the uid the client holds and the numeric id
    // ride_members.subgroup_id needs, so a group made since the last save is not in
    // it. This is the one press that closes that gap.
    //
    // ridersStale() runs from the save's completion rather than beside it: re-reading
    // before the write lands gets the same list back and the button looks broken.
    host.addEventListener("click", async (e) => {
      if (e.target.id !== "riders-save") return;
      e.target.disabled = true;
      e.target.textContent = "Saving…";
      try {
        // saveNow(), not save(): awaiting save() while the autosave is already in
        // flight returns immediately having written nothing, and this button's
        // whole job is that the group exists on the server afterwards.
        await saveNow();
      } finally {
        ridersStale();
      }
    });

    host.addEventListener("click", async (e) => {
      if (!e.target.classList.contains("rider-del")) return;
      const row = e.target.closest(".rider-row");
      if (!row) return;
      const name = row.querySelector(".rider-name").textContent;
      // A confirm rather than an undo, because this one is not in the builder's
      // history at all: it is a write to the roster that lands immediately, and
      // beginEdit() covers the ride payload only.
      if (!window.confirm("Take " + name + " off this " + W("journey") + "?")) return;
      const ok = await riderPost("remove", { rider: Number(row.dataset.rider) });
      ridersStale();
      if (!ok) toast("They could not be removed.", true);
    });
  }

  async function riderPost(verb, body) {
    try {
      const res = await fetch("/api/rides/" + state.rideId + "/riders/" + verb, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // --- Rider subgroups (#67) ------------------------------------------------
  //
  // A named set of riders sharing an approach. A ROUTE belongs to one, or to
  // nobody — which means everyone rides it. See src/subgroups/policy.ts; a
  // subgroup owns a subsequence of one dense sequence, so nothing here reorders
  // or renumbers anything.
  //
  // RENDERS NOTHING UNTIL A RIDER ADDS ONE. A solo ride is the overwhelming
  // majority and should not pay a line of panel for a feature about groups.

  function subgroupByUid(u) {
    return state.meta.subgroups.find((g) => g.uid === u) || null;
  }

  /**
     * A route of its own for a group that has just been added, starting where the
     * rider said that group starts.
     *
     * A GROUP MUST HAVE A STARTING POINT AND CANNOT BE MADE WITHOUT ONE. Ziad's
     * call, 2026-09-04. It seeded at the RIDE'S start before that — so every group
     * arrived with the one fact it owns filled in wrong, and every proposal made
     * from it was about a road nobody rides.
     *
     * THE GROUP'S COLOR, NOT THE NEXT IN THE PALETTE: a group's line has to read as
     * one thing wherever it appears.
     *
     * IT DEPARTS WHEN THE RIDE DOES, as a placeholder — syncDeparturesToMeet
     * rewrites it, and leaving it undated keeps the group off the timeline.
     *
     * Appended rather than inserted ahead of the main group's routes, which would
     * renumber everything already planned.
     */
  function seedGroupRoute(g, start) {
    if (state.routes.length >= MAX_ROUTES) return;
    const route = newRoute(g.color);
    route.subgroupUid = g.uid;
    route.points.push(newPoint(start.lngLat[0], start.lngLat[1], start.name, start.address));
    // The route's first point is a stop, exactly as it is when a rider drops
    // one on an empty route. Without it the seed is a POI, nothing ever
    // promotes it, and the ride cannot be saved at all — #233.
    ensureRouteHasStop(route);
    // Tagged `start` for the same reason the first point of any route is: it is
    // where somebody sets off, and the roadbook and the hand-off both read it.
    if (!route.points[0].roles.length) route.points[0].roles = ["start"];
    const first = ALT.activeRoutes(state.routes)[0];
    route.startAt = (first && first.startAt) || null;
    state.routes.push(route);
  }

  // --- Who is on this stretch of road ------------------------------------
  //
  // #67's last mile, and the thing subgroups could not say: a route carried ONE
  // group and a rider belonged to ONE group for the whole ride, so "three riders
  // join at Portland and one peels off at Eugene" had nowhere to live. Ziad's
  // call, 2026-09-06: the rider is the primitive.
  //
  // HELD SEPARATELY FROM state.routes AND NOT IN THE PAYLOAD — reconciled by uid
  // like votes and point details, and set by its own press rather than riding on
  // the autosave. NULL UNTIL IT LOADS, which the row renderer checks.
  function routeRidersOf(route) {
    const rr = state.routeRiders;
    if (!rr || !route || !route.uid) return null;
    return rr.byUid[route.uid] || null;
  }

  /** Load the resolved sets. Cheap, and re-read after every write because one
   *  route's override changes every route after it that inherits — patching a
   *  local copy from the request just sent is wrong from the next route on. */
  async function loadRouteRiders() {
    if (!state.rideId) return;
    try {
      const res = await fetch("/api/rides/" + state.rideId + "/route-riders");
      if (!res.ok) return;
      applyRouteRiders(await res.json());
    } catch (err) {
      // Not a toast. The line is an annotation on a row; a ride is perfectly
      // editable without it, and a failure here must not read as a save problem.
      console.warn("[builder] route riders:", err);
    }
  }

  function applyRouteRiders(data) {
    if (!data || !Array.isArray(data.routes)) return;
    const byUid = {};
    for (const r of data.routes) byUid[r.uid] = r;
    // BOTH DIRECTIONS OF THE GROUP MAP, because the two identifier spaces meet
    // here exactly as they do on the Riders tab: this file holds a group by UID
    // (the client mints those) while `route_riders.subgroup_id` and the resolved
    // sets are numeric IDS the server owns. Built once per load rather than
    // looked up per row.
    const groups = data.groups || (state.routeRiders && state.routeRiders.groups) || [];
    const idOfGroup = {};
    const uidOfGroup = {};
    for (const g of groups) {
      idOfGroup[g.uid] = g.id;
      uidOfGroup[g.id] = g.uid;
    }
    state.routeRiders = {
      byUid: byUid,
      groups: groups,
      idOfGroup: idOfGroup,
      uidOfGroup: uidOfGroup,
      groupIds: idOfGroup,
      junctions: data.junctions || [],
      // Only present on the GET. A write answers with the resolution and not
      // with the roster, which does not change, so the held one is kept.
      riders: data.riders || (state.routeRiders && state.routeRiders.riders) || [],
    };
    renderRoutes();
    // renderRoutes() draws every Starts and Ends field EMPTY and leaves
    // refreshDerived() to fill them, and this is the one caller that runs
    // after the load's own refresh has already happened — so a stored start
    // time rendered, was replaced by a blank field when this answer landed a
    // moment later, and stayed blank until the next edit. Seen on every
    // dated ride opened in the builder.
    renderTimes();
  }

  const riderNameOf = (id) => {
    const list = (state.routeRiders && state.routeRiders.riders) || [];
    const hit = list.find((r) => r.riderId === id);
    return hit ? hit.displayName : "somebody";
  };

  /**
    * The line under a route head saying who rides it.
    *
    * IT NAMES THE CHANGE, NOT THE WHOLE SET, once a ride has junctions: "Dylan
    * joins here" is what a planner looks for, where four names repeated down every
    * row is noise to diff by eye. The full set is in the `title` and the picker.
    *
    * EMPTY WHEN THE RIDE HAS ONE RIDER, which is nearly every ride.
    */
  function routeRidersHtml(route, r) {
    const rr = routeRidersOf(route);
    if (!rr) return "";
    const roster = (state.routeRiders && state.routeRiders.riders) || [];
    if (roster.length < 2) return "";
    const junction = (state.routeRiders.junctions || []).find((j) => j.position === rr.position);
    const names = rr.riderIds.map(riderNameOf);
    const full = names.length ? names.join(SEP) : "nobody yet";
    let label;
    if (junction && (junction.joined.length || junction.left.length)) {
      const bits = [];
      if (junction.joined.length) bits.push(junction.joined.map(riderNameOf).join(", ") + " joins here");
      if (junction.left.length) bits.push(junction.left.map(riderNameOf).join(", ") + " leaves here");
      label = bits.join(SEP);
    } else {
      label = names.length + " " + (names.length === 1 ? W("person") : Ws("person"));
    }
    return (
      '<button type="button" class="route-riders' +
      (junction ? " is-junction" : "") +
      '" data-route="' +
      r +
      '" title="' +
      esc(full) +
      '" aria-label="Riders on ' +
      esc(routeLabel(r)) +
      ": " +
      esc(full) +
      '">' +
      esc(label) +
      "</button>"
    );
  }

  /**
    * The picker: tick who is on this route.
    *
    * A DIALOG RATHER THAN A ROW CONTROL. The set can be the whole roster and the
    * list has to show who is NOT on the route, which a 380px drawer row cannot. It
    * also keeps a re-rendering control out of the route list — #188.
    *
    * "EVERYONE FROM HERE ON" IS THE CLEAR BUTTON, labeled for what it does rather
    * than what it stores: clearing the override makes the route inherit from the
    * one before it, so the honest label is about the change, not the row.
    */
  function openRouteRiders(r) {
    const route = state.routes[r];
    const rr = routeRidersOf(route);
    if (!route || !rr) return;
    const roster = (state.routeRiders && state.routeRiders.riders) || [];
    const on = new Set(rr.riderIds);
    const el = routeRidersDialog();
    el.dataset.uid = route.uid;
    el.querySelector("#tb-riders-title").textContent = "Who is " + W("travel") + " " + routeLabel(r) + "?";
    el.querySelector(".modal-lede").textContent =
      "Tick everyone " +
      W("travel") +
      " " +
      routeLabel(r) +
      ". They stay on every " +
      W("route") +
      " after this one until you say otherwise.";
    el.querySelector(".rider-picks").innerHTML = roster
      .map(
        (m) =>
          '<li><label><input type="checkbox" value="' +
          m.riderId +
          '"' +
          (on.has(m.riderId) ? " checked" : "") +
          "> " +
          esc(m.displayName) +
          "</label></li>",
      )
      .join("");
    if (typeof el.showModal === "function") {
      if (!el.open) el.showModal();
    } else {
      el.setAttribute("open", "");
    }
  }

  // Built once and reused, the same arrangement as errorDialog() and for the
  // same reasons: appended to <body> because showModal() needs the top layer,
  // and both buttons carry `.btn` because the panel's own button rules are
  // nested inside `.builder-panel`, which a dialog in the top layer is not.
  function routeRidersDialog() {
    let el = $("tb-riders");
    if (el) return el;
    el = document.createElement("dialog");
    el.id = "tb-riders";
    el.className = "modal";
    el.setAttribute("aria-labelledby", "tb-riders-title");
    el.innerHTML =
      '<h2 id="tb-riders-title"></h2>' +
      '<div class="modal-body">' +
      '<p class="modal-lede"></p>' +
      '<ul class="rider-picks"></ul>' +
      "</div>" +
      '<div class="modal-error-acts">' +
      // "Same as before" and NOT "Clear": what it does is make this route follow
      // the one before it, which on route 1 is the whole roster. The label names
      // the change rather than the storage.
      '<button type="button" class="btn btn-quiet" data-riders-inherit>Same as before</button>' +
      '<button type="button" class="btn" data-riders-save>Save</button>' +
      "</div>";
    document.body.appendChild(el);
    const close = () => {
      if (typeof el.close === "function" && el.open) el.close();
      else el.removeAttribute("open");
    };
    el.querySelector("[data-riders-save]").addEventListener("click", () => {
      const ids = [...el.querySelectorAll(".rider-picks input:checked")].map((x) => Number(x.value));
      close();
      putRouteRiders(el.dataset.uid, ids);
    });
    el.querySelector("[data-riders-inherit]").addEventListener("click", () => {
      close();
      putRouteRiders(el.dataset.uid, []);
    });
    return el;
  }

  /**
    * Set who rides one route.
    *
    * `riders` is either bare ids or `{id, group}` objects and the endpoint takes
    * both. The object form says who they are RIDING AS on this stretch, which a
    * feeder tag and a split both need; the picker sends bare ids.
    *
    * Returns whether it landed, because the split writes two routes and has to know
    * whether the first took.
    */
  async function putRouteRiders(uid, riders) {
    if (!state.rideId) return false;
    try {
      const res = await fetch("/api/rides/" + state.rideId + "/route-riders/" + encodeURIComponent(uid), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ riderIds: riders }),
      });
      if (!res.ok) {
        toast("Could not set who rides that route", true);
        return false;
      }
      applyRouteRiders(await res.json());
      return true;
    } catch (err) {
      toast("Could not set who rides that route", true);
      return false;
    }
  }

  // The picker that sits in a route header. Empty string when the ride has no
  // subgroups, so routeSectionHtml concatenates nothing.
  /**
     * Which groups ride this route, as a checkbox list.
     *
     * **A SINGLE SELECT COULD NOT TELL THE TRUTH.** Ziad's call, 2026-09-06, from a
     * staged meet-up: with VMCSF and VMCSC merged but VMCSLO still on approach, the
     * shared route read "Everyone", because one id cannot say "these two of three".
     *
     * **THE TICKS ARE DERIVED FROM WHO IS ON THE ROUTE, BY THEIR HOME GROUP** —
     * once VMCSC joins the main group their stored group is null, so reading stored
     * values would tick nothing. `groupsOnRoute()` derives it server-side.
     *
     * **Everyone is a shortcut, not a value**, and shows ticked exactly when every
     * group is on the route. A `<details>` so it is one line until opened.
     */
  function routeSubgroupHtml(route, r) {
    const groups = state.meta.subgroups;
    if (groups.length === 0) return "";
    const rr = routeRidersOf(route);
    // Until the resolution lands there is nothing honest to tick, and guessing
    // "Everyone" is the exact claim this control exists to stop making.
    if (!rr) return "";
    const on = new Set((rr.groups || []).map((g) => (g == null ? "" : String(g))));
    const mainUid = groups[0] && groups[0].uid;
    const idOf = (g) => (state.routeRiders && state.routeRiders.groupIds && state.routeRiders.groupIds[g.uid]) || null;
    const ticked = (g) => {
      const id = idOf(g);
      if (id != null && on.has(String(id))) return true;
      // AND THE MAIN GROUP ALSO OWNS THE NULL ENTRY, which is not the same as being
      // it: a rider explicitly assigned to it carries its real id, a rider assigned to
      // no group carries null and is riding with everybody. Both tick the first box.
      // Reading only the null left the main group unticked on every route of a ride
      // whose roster was filled in properly.
      return g.uid === mainUid && on.has("");
    };
    const all = groups.every(ticked);
    const label = all
      ? "Everyone"
      : groups
          .filter(ticked)
          .map((g) => g.name)
          .join(", ") || "Nobody yet";
    return (
      '<details class="route-groups" data-route="' +
      r +
      '">' +
      '<summary data-tip="route-groups" title="Which groups ride this route">' +
      esc(label) +
      "</summary>" +
      '<div class="route-groups-list">' +
      '<label class="route-group-all"><input type="checkbox" data-group="*"' +
      (all ? " checked" : "") +
      "> Everyone</label>" +
      groups
        .map(
          (g) =>
            '<label><input type="checkbox" data-group="' +
            esc(g.uid) +
            '"' +
            (ticked(g) ? " checked" : "") +
            "> " +
            esc(g.name) +
            "</label>",
        )
        .join("") +
      "</div></details>"
    );
  }

  /**
    * Apply a tick: put every member of the chosen groups on this route.
    *
    * **MORE THAN ONE GROUP MEANS THEY ARE RIDING TOGETHER, SO THEY RIDE AS THE MAIN
    * GROUP.** Ziad's call, 2026-09-06: when a group joins, their own group stops
    * applying — it does not disappear, it stays on the feeder route they rode as
    * it, which is what a later split reads back. One group ticked is a feeder.
    *
    * Goes through the same PUT the rider picker uses, because it is the same fact.
    */
  function applyRouteGroups(r, uids) {
    const route = state.routes[r];
    if (!route || !route.uid) return;
    const rr = state.routeRiders;
    if (!rr) return;
    const chosen = new Set(uids);
    const mainUid = state.meta.subgroups[0] && state.meta.subgroups[0].uid;
    const feeder = chosen.size === 1 ? [...chosen][0] : null;
    const riders = [];
    for (const m of rr.riders || []) {
      // Same rule in the other direction: no home group means riding with
      // everybody, which is the main group.
      const homeUid = m.group == null ? mainUid : rr.uidOfGroup[m.group] || mainUid;
      if (!chosen.has(homeUid)) continue;
      // Riding as their own group only when theirs is the ONLY group here.
      const asGroup = feeder && feeder === homeUid && homeUid !== mainUid ? rr.idOfGroup[homeUid] : null;
      riders.push({ id: m.riderId, group: asGroup == null ? null : asGroup });
    }
    putRouteRiders(route.uid, riders);
  }

  function renderSubgroups() {
    const host = $("sg-body");
    if (!host) return;
    const groups = state.meta.subgroups;
    const count = $("sg-count");
    if (count) count.textContent = groups.length ? String(groups.length) : "";

    // UNREACHABLE BY DESIGN — a ride always has at least one group, seeded at
    // state init and again on load. Repaired rather than rendered around: an
    // empty panel here would be a dead end the rider cannot get out of, and the
    // seed is one line.
    if (groups.length === 0) {
      state.meta.subgroups.push(seedGroup());
      state.meta.primarySubgroup = state.meta.subgroups[0].uid;
      return renderSubgroups();
    }

    // ORDER IS RANK, AND THE FIRST ROW IS THE MAIN GROUP. Ziad's call, 2026-09-03:
    // promotion is a DRAG rather than a picker, so `subgroups[0]` IS the main group
    // and `primarySubgroup` is kept equal to its uid rather than being a second,
    // independently settable fact. Two ways to say the same thing is what made this
    // panel read as machinery.
    //
    // ONE CONTAINER HOLDING NOTHING BUT `.sg-row`, which is not a style choice:
    // Sortable's raw `oldIndex`/`newIndex` count EVERY child, so a section header
    // between rows would make them read about double — #166. The "Main group" label
    // is INSIDE the first row for that reason.
    host.innerHTML =
      '<div class="sg-list" id="sg-list">' +
      groups
        .map(
          (g, i) =>
            '<div class="sg-row' +
            (i === 0 ? " is-main" : "") +
            '" data-sg="' +
            esc(g.uid) +
            '">' +
            // A real <button>, not a decorative grip: it is the keyboard path
            // and the path that still works when the SortableJS CDN does not.
            // Same arrangement as a route's handle, which replaced two move
            // buttons on 2026-08-16.
            '<button type="button" class="sg-drag" data-tip="sg-drag" title="Drag to reorder, or focus and use the arrow keys"' +
            ' aria-label="Reorder ' +
            esc(g.name) +
            '">⠿</button>' +
            '<input class="sg-color" type="color" value="' +
            esc(g.color) +
            '" aria-label="Color for ' +
            esc(g.name) +
            '">' +
            // autocomplete and data-1p-ignore for the reason spelled out on
            // .route-title in routeSectionHtml: "Name of this group" reads to a
            // password manager as a person's name.
            '<input class="sg-name" type="text" maxlength="80" autocomplete="off" data-1p-ignore value="' +
            esc(g.name) +
            '" aria-label="Name of this group">' +
            (i === 0
              ? '<span class="sg-main-tag">Main</span>'
              : // NO DELETE ON THE MAIN GROUP, which is what guarantees a ride
                // always has one — a simpler invariant than "you cannot delete
                // the last" and the one Ziad asked for. Demote it by dragging
                // another group over it, then it can go like any other.
                '<button type="button" class="sg-del" data-tip="sg-del" title="Remove this group" aria-label="Remove ' +
                esc(g.name) +
                '">×</button>') +
            // WHERE THIS GROUP SETS OFF FROM, under its name. Ziad's call, 2026-09-06: a
            // starting point is the one fact a group owns, and once the form closed it was
            // invisible, so a panel of three groups said nothing about which was which. It
            // is also the fastest way to spot a group seeded at the ride's own start.
            //
            // INSIDE THE ROW, NOT A SIBLING — Sortable's raw indices count every child of
            // the LIST, so a line between two rows is #166 waiting to happen.
            groupStartHtml(g.uid) +
            "</div>",
        )
        .join("") +
      "</div>" +
      // Only what is PINNED now — the group it applies to is the one at the top of the
      // list above, so naming it again in a select was the redundancy.
      // WHAT IS PINNED IS ALWAYS THE MAIN GROUP'S DEPARTURE, so there is no control
      // for it. Ziad's call, 2026-09-03: that is the one time a planner actually
      // knows, and the meet and the arrival are both worked out from it.
      //
      // `rides.time_anchor` keeps its other members and schedule.ts keeps solving for
      // them; nothing sets them. What survives is the fairness note, which is about
      // WHOSE departure and is a live question.
      (groups.length < 2 ? "" : '<div class="sg-anchor"><p class="sg-anchor-note" id="sg-anchor-note"></p></div>');
    initGroupDrag($("sg-list"));
    renderAnchorNote();
    // ONE BUTTON FOR THE RIDE, NOT ONE PER GROUP — #239. The question has one
    // answer for everybody. It appears with the second group and lives in the page's
    // own markup, so this only decides whether it shows. `.sg-meet` sets
    // `display: flex`, which BEATS the `hidden` attribute, so the stylesheet carries
    // an explicit `[hidden]` rule; without it this line does nothing.
    // THE ROW, NOT THE BUTTON: the divert field sits beside it and has to come and go
    // with it, or a solo ride shows a bare "within 25 mi detour".
    const meetRow = $("sg-meet-row");
    if (meetRow) meetRow.hidden = groups.length < 2;
    // A PROPOSAL ABOUT A GROUP THAT IS GONE HAS TO BE TAKEN DOWN HERE. The
    // output used to be rebuilt empty by the innerHTML above; it is static now,
    // so deleting the second group would leave its candidate list on screen and
    // its dots on the map.
    if (groups.length < 2 && state.meet) clearMeet();
    // THE PROPOSAL IS STATE, SO IT SURVIVES A RE-RENDER OF THIS PANEL. Taking a
    // meeting point moves a route's departure, which calls renderRoutes(), which
    // cascades into here and rebuilds #sg-meet-out — so the sections for the groups
    // still undecided were written into an element that had just been replaced, and
    // choosing group 2's point silently wiped group 3's. Rendering from `state.meet`
    // is also what makes the panel and the map agree.
    renderMeetOut();
  }

  /**
     * The line under a group row saying where it sets off from.
     *
     * THE GROUP'S OWN FIRST ROUTE, FALLING BACK TO ITS STRAND — the same rule
     * `startRouteOf()` follows server-side, or the panel names a place the proposer
     * is not using. Active routes only.
     *
     * EMPTY RATHER THAN A PLACEHOLDER: "not set" for a state that lasts a second
     * reads as a warning about nothing.
     *
     * IT REFRESHES WITH renderSubgroups() AND NOT WITH EVERY POINT EDIT — that
     * rebuilds `#sg-body` and its `.sg-name` inputs, costing a rider the group name
     * they were typing (#188). The line can be a beat behind a renamed first point.
     */
  function groupStartHtml(groupUid) {
    const active = ALT.activeRoutes(state.routes);
    // THE MAIN GROUP TAKES THE FIRST ROUTE OF ITS STRAND AND SKIPS THE SEARCH,
    // mirroring `startRouteOf`'s `isMain`. Since splitting tags the main group's
    // continuation, searching for their own tagged route now finds the road AFTER
    // a split and this line would name the split stop as where the ride begins.
    // For the main group a shared route ahead of their own is theirs.
    const isMain = state.meta.subgroups[0] && state.meta.subgroups[0].uid === groupUid;
    const strand = active.filter((d) => !d.subgroupUid || d.subgroupUid === groupUid);
    const route = isMain ? strand[0] : active.find((d) => d.subgroupUid === groupUid) || strand[0];
    const pt = route && route.points && route.points[0];
    if (!pt) return "";
    const name = pt.name || pt.address || "";
    if (!name) return "";
    return '<p class="sg-start" title="' + esc(name) + '">from ' + esc(name) + "</p>";
  }

  /** Redraw the proposal and re-pair its rows with the dots on the map.
   *
   *  #sg-meet-out is no longer rebuilt by renderSubgroups() — the button and the
   *  output are static markup since 2026-09-05 — but this still runs on every
   *  render, because showMeetPreview() binds hover handlers to the ROWS and
   *  those are recreated whenever the proposal is redrawn. Drawing from
   *  `state.meet` is what keeps the panel and the map showing one object. */
  function renderMeetOut() {
    const out = $("sg-meet-out");
    if (!out || !state.meet || !(state.meet.groups || []).length) return;
    out.innerHTML = (state.meetNote || "") + meetAllHtml(state.meet);
    showMeetPreview(out, state.meet);
  }

  /** Take a proposal down: the panel, the state it is drawn from, and the dots
   *  and approach lines it put on the map. */
  function clearMeet() {
    state.meet = null;
    state.meetNote = "";
    const out = $("sg-meet-out");
    if (out) out.innerHTML = "";
    showMeetPreview(document.createElement("div"), null);
  }

  /**
     * The "add a group" form: a name and, required, where that group starts.
     *
     * A GROUP MUST HAVE A STARTING POINT AND CANNOT BE MADE WITHOUT ONE. Ziad's
     * call, 2026-09-04. The button used to seed the group's route at the RIDE'S
     * start — the one place a satellite provably does not set off from — so every
     * group arrived with the one fact it owns filled in wrong.
     *
     * IT LIVES IN `.tab-actions` AND NOT IN `#sg-body`, which renderSubgroups()
     * rebuilds: a form inside would lose the half-typed search it holds. #188 again.
     *
     * NAME SEARCH ONLY: the question is which town a group sets off from, and
     * "coffee" is not an answer to it. That also keeps it to the Autocomplete SKU.
     */
  function openNewGroup() {
    const add = $("sg-add");
    if (!add || document.querySelector(".sg-new")) return;
    add.hidden = true;
    const box = document.createElement("div");
    box.className = "sg-new";
    // THE NAME COMES FIRST NOW, AND IT IS NO LONGER LABELED OPTIONAL. Ziad's call,
    // 2026-09-06: the field sat under a search box whose pick is what CREATES the
    // group, so the rider reached the commit before the name and "(optional)" told
    // them not to go back for it. The order now matches the order the form acts in.
    //
    // THE FALLBACK STAYS, WHICH IS WHY THE LABEL IS NOT A LIE: createGroup() still
    // names a group after the place it starts from, so a nameless group remains
    // impossible to make.
    box.innerHTML =
      '<label class="sg-new-lab" for="sg-new-name">Group name</label>' +
      '<input class="sg-new-name" id="sg-new-name" type="text" maxlength="80" autocomplete="off"' +
      ' data-1p-ignore placeholder="Who is riding together" aria-label="Name for this group">' +
      '<label class="sg-new-lab" for="sg-new-start">Where does this group start?</label>' +
      '<input class="sg-new-start" id="sg-new-start" type="text" autocomplete="off" data-1p-ignore' +
      ' spellcheck="false" placeholder="Town, address or place">' +
      '<ul class="sg-new-hits" hidden></ul>' +
      '<button type="button" class="btn btn-sm btn-quiet sg-new-cancel">Cancel</button>';
    add.parentNode.appendChild(box);

    const startField = box.querySelector(".sg-new-start");
    const nameField = box.querySelector(".sg-new-name");
    const hitList = box.querySelector(".sg-new-hits");
    let hits = [];
    let timer = null;
    let seq = 0;
    // THE FIRST FIELD TAKES FOCUS, which is now the name rather than the search.
    // It used to be the search because that was the only field that mattered;
    // the name is what the rider is asked for first now, and focus landing past
    // it would say the opposite of what the order says.
    nameField.focus();

    box.querySelector(".sg-new-cancel").addEventListener("click", closeNewGroup);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeNewGroup();
      }
    });

    startField.addEventListener("input", () => {
      clearTimeout(timer);
      const q = startField.value.trim();
      if (q.length < 3) {
        hitList.hidden = true;
        hitList.innerHTML = "";
        return;
      }
      timer = setTimeout(async () => {
        // Predictions come back out of order often enough to matter; a slow
        // early keystroke must not overwrite a fast later one. Same guard the
        // route's own search carries, for the same reason.
        const mine = ++seq;
        if (!state.map) return;
        let found = [];
        try {
          found = await searchPlaces(state.map, q);
        } catch (err) {
          console.warn("[builder] group start search:", err.message);
        }
        if (mine !== seq || !box.isConnected) return;
        hits = found;
        if (!hits.length) {
          // NAMES THE VIEWPORT, the same as the route's search does: the search is
          // RESTRICTED to what is on screen, so "no matches" is a fact about the
          // map rather than about the world, and zooming out is the move.
          hitList.innerHTML = '<li class="sg-new-empty">No matches on screen—zoom out to search wider.</li>';
          hitList.hidden = false;
          return;
        }
        hitList.innerHTML = hits
          .map(
            (h, i) =>
              '<li><button type="button" class="sg-new-hit" data-i="' +
              i +
              '"><strong>' +
              esc(h.name) +
              "</strong>" +
              (h.context ? ' <span class="sg-new-ctx">' + esc(h.context) + "</span>" : "") +
              "</button></li>",
          )
          .join("");
        hitList.hidden = false;
      }, 300);
    });

    hitList.addEventListener("click", async (e) => {
      const btn = e.target.closest(".sg-new-hit");
      if (!btn) return;
      const h = hits[Number(btn.dataset.i)];
      if (!h) return;
      // Coordinates are fetched only for the pick — Place Details is billed per
      // call, so resolving every prediction would cost five times as much for a
      // rider who is going to choose one.
      const picked = await h.resolve().catch(() => null);
      if (!picked) return toast("Could not locate that place", true);
      createGroup(picked, nameField.value.trim());
    });
  }

  function closeNewGroup() {
    const box = document.querySelector(".sg-new");
    if (box) box.remove();
    const add = $("sg-add");
    if (add) {
      add.hidden = false;
      add.focus();
    }
  }

  /**
   * Make the group, with the starting point that is now known.
   *
   * NAMED AFTER THE PLACE unless the rider typed something. Ziad's call,
   * 2026-09-04: "Group 2" says nothing about who it is, and "Santa Cruz" is what
   * a planner calls them anyway. A typed name always wins — the same rule the
   * ride title follows, and the reason there is no flag to keep in step here is
   * that the field is read once, at the moment of creation.
   */
  function createGroup(place, typedName) {
    beginEdit("add a group");
    // Walks the route palette so two groups are never the same color. It is the
    // group's own color rather than a route's because a group spans several routes
    // and its line has to read as one thing across all of them.
    const color = ROUTE_COLORS[state.meta.subgroups.length % ROUTE_COLORS.length];
    const g = {
      uid: uid(),
      name: typedName || place.name || "Group " + (state.meta.subgroups.length + 1),
      color: color,
    };
    state.meta.subgroups.push(g);
    // NOT PROMOTED. A ride always has a main group already, so a group added now is
    // a joining one, and taking the main slot from underneath them would silently
    // re-point every meeting-point proposal at a road nobody has planned.
    //
    // The fairness half matters MORE than it did: the seed is the planner's own
    // group, so the default main group IS theirs — exactly the case #67 says the app
    // must not choose silently. renderAnchorNote fires from the second group on.
    //
    // Re-derived rather than conditionally set: the main group IS the first in the
    // list, so reading it back is the one spelling that cannot drift.
    state.meta.primarySubgroup = state.meta.subgroups[0].uid;
    // AND IT COMES WITH A ROUTE OF ITS OWN, starting where the rider just said.
    // Ziad's call, 2026-09-04, reported as "I added a third group, so there
    // should be three distinct routes". A group used to be a TAG and nothing
    // else: adding one changed nothing a rider could see, and giving it a road
    // meant knowing to add a route and then assign it from the route's own picker —
    // two steps, in a different tab, that nothing on screen asked for.
    seedGroupRoute(g, place);
    closeNewGroup();
    // The new group cannot be assigned to anybody until the ride saves, which
    // the Riders tab says itself.
    ridersStale();
    renderRoutes();
    rebuildLayers();
    renderMarkers();
    markDirty();
    panTo(state.map, place.lngLat, 10);
  }

  function wireSubgroups() {
    const add = $("sg-add");
    if (!add) return;

    // A GROUP CANNOT BE MADE WITHOUT A STARTING POINT, so the button opens a form
    // rather than creating anything. Ziad's call, 2026-09-04.
    add.addEventListener("click", openNewGroup);

    // BOUND DIRECTLY, because this button is in the page's own markup now rather
    // than inside #sg-body — it was delegated from that element while
    // renderSubgroups() rebuilt it on every render, and a delegated handler on a
    // static element is a listener that can never fire.
    const meetBtn = $("sg-meet-all");
    if (meetBtn) meetBtn.addEventListener("click", findMeet);

    // SESSION STATE AND NOT A RIDE FIELD, like corridorOn and ringOn: how far a
    // detour is worth is a question about the press being made, and it does not
    // survive a reload on purpose — the rider's own default is what a planner should
    // get on a ride they have just opened.
    //
    // `change` and not `input`: a number box fires on every keystroke, so typing
    // "120" would put state through 1 and then 12.
    const divert = $("sg-divert");
    if (divert) {
      divert.addEventListener("change", () => {
        // AN EMPTY BOX MEANS THE DEFAULT, NOT ZERO. `Number("")` is 0, which the
        // clamp below would lift to the one-mile floor — refusing every
        // candidate on the ride, for a rider whose only act was to clear the
        // field. Same trap as clampDivert() server-side, where a test caught it.
        const raw = divert.value.trim();
        const n = raw === "" ? NaN : Number(raw);
        // OUT OF RANGE IS PUT BACK IN THE BOX, not silently corrected on the way
        // to the server. The server clamps too — it does not trust a form — but
        // a rider who typed 900 and got answers within 200 deserves to see the
        // number that was actually used.
        state.maxDivertMi = Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : window.TB.maxDivertMi || 10;
        divert.value = String(state.maxDivertMi);
      });
    }

    // Delegated on the body, because every row is rebuilt by renderSubgroups
    // and a handler bound to a row would be thrown away with it.
    const body = $("sg-body");
    body.addEventListener("input", (e) => {
      const row = e.target.closest(".sg-row");
      if (!row) return;
      const g = subgroupByUid(row.dataset.sg);
      if (!g) return;
      if (e.target.classList.contains("sg-name")) {
        beginEdit("rename a group");
        g.name = e.target.value;
        // NOT renderRoutes() — that would rebuild the field being typed in and
        // lose the caret on every keystroke. The route pickers go stale for the
        // length of the edit, which nobody can see, and the next render fixes
        // them.
        markDirty();
      } else if (e.target.classList.contains("sg-color")) {
        beginEdit("recolor a group");
        g.color = e.target.value;
        markDirty();
      }
    });

    // The keyboard half of the drag handle, and the path that still works when
    // the SortableJS CDN does not. preventDefault because the drawer scrolls,
    // and an arrow key that both moves the row and scrolls the panel loses the
    // row off the screen — the same reasoning as the route grip.
    body.addEventListener("keydown", (e) => {
      const grip = e.target.closest(".sg-drag");
      if (!grip) return;
      const dir = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      if (!dir) return;
      e.preventDefault();
      const row = grip.closest(".sg-row");
      if (!row) return;
      const uidOfRow = row.dataset.sg;
      const from = state.meta.subgroups.findIndex((g) => g.uid === uidOfRow);
      if (from < 0) return;
      moveGroup(from, from + dir);
      // renderSubgroups() has replaced the button that was focused, so focus
      // goes back to the same GROUP's grip at its new position — by uid, not by
      // index, which is the thing that just changed.
      const moved = body.querySelector('.sg-row[data-sg="' + CSS.escape(uidOfRow) + '"] .sg-drag');
      if (moved) moved.focus();
    });

    // TAKING A CANDIDATE IS DELEGATED ON #sg-meet-out, NOT ON #sg-body. It rode
    // on the body handler while the proposal was rendered inside that element;
    // the output is its own static element since 2026-09-05, so a handler on the
    // body would never see the click — and the failure is a Take button that
    // silently does nothing, with no error anywhere.
    const meetOut = $("sg-meet-out");
    if (meetOut) {
      meetOut.addEventListener("click", (e) => {
        if (e.target.classList.contains("sg-take")) takeMeet(e.target.dataset);
      });
    }

    body.addEventListener("click", (e) => {
      const row = e.target.closest(".sg-row");
      if (!row) return;
      const g = subgroupByUid(row.dataset.sg);
      if (!g) return;
      if (e.target.classList.contains("sg-del")) return removeSubgroup(g);
    });
  }

  // DELETING A GROUP UN-TAGS ITS DAYS RATHER THAN DESTROYING THEM — the same
  // thing `set null` does server-side, done here so undo and the map agree with
  // what the save will do. A rider tidying up a group name must not lose the
  // road they planned.
  function removeSubgroup(g) {
    // THE MAIN GROUP CANNOT BE DELETED, and that one rule is what guarantees a
    // ride always has a group — simpler than "you cannot delete the last one",
    // which is the shape this replaced. Demote it first by dragging another
    // group over it; then it goes like any other.
    //
    // The × is not rendered on it, so this is the backstop for a stale DOM
    // rather than a path a rider takes — but the invariant lives here and the
    // rendering is the courtesy.
    if (state.meta.subgroups[0] && state.meta.subgroups[0].uid === g.uid) return;
    beginEdit("remove a group");
    state.meta.subgroups = state.meta.subgroups.filter((x) => x.uid !== g.uid);
    state.routes.forEach((d) => {
      if (d.subgroupUid === g.uid) d.subgroupUid = null;
    });
    // Re-derived rather than repaired: the main group is whatever is first, and
    // deleting a non-main group cannot change that — but reading it from the
    // list keeps the two from ever disagreeing.
    state.meta.primarySubgroup = state.meta.subgroups[0].uid;
    if (state.meta.trunkSubgroup === g.uid) state.meta.trunkSubgroup = null;
    // renderRoutes() cascades into renderSubgroups() — see moveGroup.
    renderRoutes();
    rebuildLayers();
    markDirty();
  }

  // Asks the server where everybody should meet. The computation is pure geometry
  // and calls no router — src/subgroups/rendezvous.ts — so it is cheap enough to
  // press repeatedly.
  //
  // NO GROUP ARGUMENT, which is #239 in one line: the answer is one meeting point
  // for the ride.
  //
  // IT NEEDS A SAVED RIDE, because the proposal is made against the STORED routes.
  // Proposing against unsaved edits would mean shipping the whole ride up to ask,
  // for an answer about roads that do not exist yet.
  async function findMeet() {
    const out = $("sg-meet-out");
    if (!state.rideId) {
      out.innerHTML =
        '<p class="sg-note">Save the ride first—a meeting point is worked out from the roads you have already planned.</p>';
      return;
    }
    out.innerHTML = '<p class="sg-note">Looking…</p>';
    try {
      const res = await fetch("/api/rides/" + state.rideId + "/rendezvous", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxDivertMi: state.maxDivertMi }),
      });
      const data = await res.json();
      // A REFUSAL IS NOT A FAILURE AND MUST NOT READ AS ONE. The catch below
      // used to swallow this, which cost a browser pass: the server answered
      // 400 "unknown group" — the ride had been saved without it — and the
      // panel said "could not work one out just now", which is what it also
      // says when the network is down.
      if (!res.ok) {
        out.innerHTML = '<p class="sg-note">Could not work one out just now.</p>';
        return;
      }
      // HELD, because taking one group's meeting point re-renders the panel for
      // the groups still undecided — the whole point of answering everybody on
      // one press is that the other answers survive the first decision.
      state.meet = data;
      state.meetNote = "";
      out.innerHTML = meetAllHtml(data);
      showMeetPreview(out, data);
    } catch (err) {
      state.meet = null;
      state.meetNote = "";
      out.innerHTML = '<p class="sg-note">Could not work one out just now.</p>';
      showMeetPreview(out, null);
    }
  }

  /** Every candidate in the press, flattened in the order the sections render
   *  them, each tagged with the group it belongs to. One list is what the map
   *  wants — the dots share a single preview slot — and the running index is
   *  what pairs a dot with its row. */
  function meetFlat(data) {
    const out = [];
    for (const g of (data && data.groups) || []) {
      for (const c of g.candidates || []) out.push({ c, group: g.group, name: g.name });
    }
    return out;
  }

  /**
    * The candidates on the map, one numbered dot each, matching the rows.
    *
    * THE SAME MECHANISM THE PLACE SEARCH USES — `setSearchPreview` — rather than a
    * second kind of temporary marker. A proposal is exactly what that was built
    * for: a short ordered list gone the moment the rider chooses. Reusing it means
    * the dots are already pressable and hover both ways (#232).
    *
    * `label` is passed because the search's default accessible name is "Add …",
    * which is the wrong verb here.
    */
  function showMeetPreview(host, data) {
    if (!state.map) return;
    const flat = meetFlat(data);
    if (!flat.length) {
      if (state.previewOwner === "meet") {
        setSearchPreview(state.map, []);
        state.previewOwner = null;
      }
      return setMeetApproaches(state.map, []);
    }
    state.previewOwner = "meet";
    const rows = Array.from(host.querySelectorAll(".sg-meets li"));
    // EVERY GROUP'S CANDIDATES AT ONCE, EACH IN ITS OWN GROUP'S COLOR. Ziad's call,
    // 2026-09-04. They shipped in $brand — the first entry in ROUTE_COLORS and so
    // the color most main groups are painted in — which made the dots blue on a blue
    // line. The joining group is the right one to borrow from, because the proposal
    // is about them; with three satellites the color is also the only thing saying
    // which decision a dot belongs to.
    setSearchPreview(
      state.map,
      flat.map(({ c, group, name }, i) => ({
        lngLat: [c.lng, c.lat],
        name: "Meeting point " + (i + 1),
        color: (subgroupByUid(group) || {}).color || null,
        num: i + 1,
        // The row's own headline fact, in the row's own words, led by whose
        // decision it is — with several groups on one map the tip is the only
        // place the dot can say that in words. Built here and not in
        // map-common.js so that file stays out of miles-versus-kilometers.
        tip: (name ? name + SEP : "") + meetTip(c),
        label: "Use meeting point " + (i + 1) + " for " + (name || "this group") + ", " + meetTip(c),
      })),
      // HOVERING THE DOT LIFTS ITS ROAD TOO, not just its row. #232's rule is
      // that a dot and its row hover BOTH ways, and the approach line is the
      // third thing that pairing is about — a rider running the pointer over
      // three dots is asking which road each one means.
      (i) => {
        rows.forEach((li, j) => li.classList.toggle("is-lit", j === i));
        highlightMeetApproaches(state.map, i);
      },
      // PRESSING THE DOT PRESSES THE ROW'S BUTTON, rather than repeating what
      // takeMeet does with the row's dataset — a second copy of that call would
      // drift the first time the data attributes changed.
      (i) => {
        const btn = rows[i] && rows[i].querySelector(".sg-take");
        if (btn) btn.click();
      },
    );
    rows.forEach((li, j) => {
      li.addEventListener("pointerenter", () => {
        highlightSearchPreview(state.map, j);
        highlightMeetApproaches(state.map, j);
      });
      li.addEventListener("pointerleave", () => {
        highlightSearchPreview(state.map, null);
        highlightMeetApproaches(state.map, null);
      });
    });
    drawMeetApproaches(flat);
  }

  // THE ROADS THE JOINING GROUPS WOULD ACTUALLY RIDE, drawn from what the proposal
  // already returned.
  //
  // FETCHED BY THE SERVER, NOT HERE, as of 2026-09-03: it routes them anyway to
  // measure each approach against the group's fuel range, so asking again would
  // pay Google twice and let the drawing disagree with the number that filtered.
  //
  // ONE ROAD PER CANDIDATE, in the joining group's color — `group` is the flat
  // index the hover pairs on.
  //
  // THIS IS THE COMPARISON, not decoration: the long way round the lake and the
  // short slog down the interstate are two shapes before they are two numbers.
  function drawMeetApproaches(flat) {
    if (!state.map) return;
    const paths = [];
    flat.forEach(({ c, group }, i) => {
      if (c.approach && c.approach.length > 1) {
        paths.push({ path: c.approach, group: i, color: (subgroupByUid(group) || {}).color || null });
      }
    });
    setMeetApproaches(state.map, paths);
  }

  /** One line of what a candidate costs, shared by the row and its dot so the
   *  two cannot say different things about the same place. */
  function meetTip(c) {
    // `mi` IS THE EXTRA OVER A GROUP'S CHEAPEST WAY OF JOINING (#370), so a
    // zero is a group at its cheapest and not a group sent nowhere.
    const worst = (c.diverts || []).filter((d) => !d.onRoute && d.mi > 0).sort((a, b) => b.mi - a.mi)[0];
    return (
      (c.name ? c.name + SEP : "") +
      (worst ? "+" + worst.mi + " mi at worst" : "nobody goes out of their way") +
      SEP +
      c.sharedPct +
      "% ridden together"
    );
  }

  // EVERY ONE OF THESE NAMES THE THING THE PLANNER SHOULD DO NEXT. The set
  // before #239 named the app's internal state instead — "there are no shared
  // routes yet" is true, unhelpful, and describes the very thing the planner
  // pressed the button to get.
  const MEET_REASONS = {
    "one-group": "Add a second group—a meeting point needs at least two starting places.",
    // ONE ENTRY FOR no-routes. The route rename folded "no-days" into this key and
    // left both lines, and in an object literal the later one wins silently —
    // esbuild's minifier reported it.
    // ITS OWN MESSAGE, because "nowhere works" sent the planner hunting for a
    // geometry problem in a ride whose real state was that nobody had drawn a road.
    // NAMES THE GROUP, because which one has to be planned first is the whole of
    // what the planner needs — the same reason firstIssue() renders `route 2`
    // rather than `routes.1`.
    "no-routes": "Plan the main group’s route to the destination first—that is the road a meeting point sits on.",
    // A REAL ANSWER, not a failure. Groups approaching a destination from
    // opposite sides have nowhere sensible to meet short of it, and offering the
    // least bad option would be worse than saying so.
    "none-viable":
      "No meeting point works without sending somebody a long way round. Check that every group’s route ends at the same place.",
  };

  /**
    * The whole answer: one section per joining group, in the order the server
    * proposed for them.
    *
    * A SECTION EACH RATHER THAN ONE LIST. Ziad's call, 2026-09-04: one press answers
    * the whole question and the decisions are knocked down one at a time. A blended
    * list could not say which group a row was for.
    *
    * A group already carrying a chosen point is still re-proposed for — changing
    * your mind is ordinary, and the row menu removes the point.
    */
  function meetAllHtml(data) {
    const groups = data.groups || [];
    // THE RIDE-WIDE REFUSALS ARE STILL RIDE-WIDE, and they are checked FIRST.
    // Nothing is proposed for anybody when there is one group, no routes or no
    // routes, so those are said once at the top rather than repeated under every
    // group's name — and this branch is the one that names the main group, which
    // a bare "no groups came back" could not.
    if (data.reason) {
      let msg = MEET_REASONS[data.reason] || MEET_REASONS["none-viable"];
      // The server names the main group where it has one, so the line reads
      // "Plan Oakland's route…" rather than making the planner work out which
      // group the app means.
      if (data.reason === "no-routes" && data.group) {
        msg = "Plan " + esc(data.group) + "'s route to the destination first—that is the road a meeting point sits on.";
      }
      return '<p class="sg-note">' + msg + "</p>";
    }
    if (!groups.length) return '<p class="sg-note">' + MEET_REASONS["none-viable"] + "</p>";
    let n = 0;
    return groups
      .map((g) => {
        const color = (subgroupByUid(g.group) || {}).color || "";
        const head =
          '<h4 class="sg-meet-head">' +
          '<span class="sg-meet-swatch" style="background:' +
          esc(color) +
          '"></span>' +
          esc(g.name || "Group") +
          " joins here</h4>";
        const body = meetResultHtml(g, n);
        // The running number is what pairs a row with its dot, and it runs
        // across the WHOLE press rather than per section — the dots share one
        // map and one preview slot, so two groups both numbering from 1 would
        // put two number 1s on the same road. The section's color is what says
        // whose is whose; the number is only ever an identity.
        n += (g.candidates || []).length;
        return '<section class="sg-meet-group" data-sg="' + esc(g.group) + '">' + head + body + "</section>";
      })
      .join("");
  }

  function meetResultHtml(data, base) {
    if (data.candidates.length && data.note === "out-of-range") {
      // NAMES THE COMPROMISE. These stations are real and on the road; what they
      // are not is reachable on the tank somebody arrives with. Saying "here are
      // three meeting points" without that would send a group at a forecourt
      // they run dry twenty miles short of.
      return (
        '<p class="sg-note">No gas station both groups can reach on one tank—these need a fuel stop first:</p>' +
        meetListHtml(data.candidates, data.group, base)
      );
    }
    if (data.candidates.length && data.note === "no-gas") {
      // SAYS WHICH KIND IT GAVE, which is the whole reason the fallback is
      // allowed. A stretch with no station is ordinary on a rural road, and a
      // rider who asked for a forecourt and got a mile marker has to be told
      // that is what happened — otherwise the next question is why the app
      // ignored them.
      return (
        '<p class="sg-note">No gas station on the stretch everyone can reach—these are the best spots on the road:</p>' +
        meetListHtml(data.candidates, data.group, base)
      );
    }
    if (!data.candidates.length) {
      // PER GROUP NOW, so it names the group rather than the ride: with three
      // satellites, two of which have somewhere to meet, "no meeting point
      // works" said once at the top would be false about the ride and useless
      // about the group it is true of.
      return '<p class="sg-note">Nowhere works for this group without a long way round.</p>';
    }
    return meetListHtml(data.candidates, data.group, base);
  }

  function meetListHtml(candidates, groupUid, base) {
    // The badge takes the group's color because the badge IS the pairing: the
    // dot on the map carries the same number, and with three groups proposing at
    // once the number alone is ambiguous the moment two sections are on screen
    // together. Inline, because the color is a rider's choice and there is no
    // class for an arbitrary hex.
    const color = (subgroupByUid(groupUid) || {}).color || "";
    return (
      '<ul class="sg-meets">' +
      candidates
        .map(
          (c, i) =>
            '<li data-n="' +
            (base + i) +
            '">' +
            '<span class="sg-meet-num" style="background:' +
            esc(color) +
            '">' +
            (base + i + 1) +
            "</span>" +
            '<button type="button" class="sg-take" data-lat="' +
            c.lat +
            '" data-lng="' +
            c.lng +
            '" data-along="' +
            c.alongM +
            // WHICH GROUP IS JOINING, carried on the button for the same reason
            // the name is: the row IS the decision, and looking the group up
            // again when the button is pressed is a second chance to disagree
            // about which one the rider meant.
            '" data-group="' +
            esc(groupUid || "") +
            '"' +
            // The name rides along on the button rather than being looked up
            // again when it is pressed: the row is what the rider chose, and a
            // second lookup by coordinate is a second chance to disagree.
            (c.name ? ' data-name="' + esc(c.name) + '"' : "") +
            ">Use this</button>" +
            '<span class="sg-meet-fact">' +
            (c.name
              ? "<strong>" + esc(c.name) + "</strong>" + (c.address ? SEP + esc(shortAddress(c.address)) : "") + SEP
              : "") +
            // WHAT IT COSTS EACH GROUP BY NAME. One number for the worst-hit
            // group would be the honest headline and an unreadable one — the
            // planner cannot tell whose it is, which is the whole thing #67 asks
            // them to be able to see before they choose.
            costPerGroup(c) +
            SEP +
            c.sharedPct +
            "% of the way still to ride together" +
            "</span>" +
            "</li>",
        )
        .join("") +
      "</ul>"
    );
  }

  // Google returns a full postal address and the panel is 380px wide. The street
  // and the town is what tells two forecourts of the same brand apart; the state
  // and the postcode are the parts a rider already knows.
  function shortAddress(a) {
    return String(a).split(",").slice(0, 2).join(",").trim();
  }

  // "on their way" rather than "+0 mi" for a group whose road already passes
  // through the point: zero extra miles is the arithmetic, and what it MEANS is
  // that this is not a detour for them at all. Two routes that converge get a
  // line saying so for every group, which is the answer a planner most wants and
  // the one a column of zeroes would bury.
  function costPerGroup(c) {
    return (c.diverts || [])
      .map((d) => {
        const g = subgroupByUid(d.group);
        const name = g ? g.name : "a group";
        // A zero that is not on-route is this group's cheapest way of joining
        // the ride — still a road to ride, so not "on their way", and not a
        // detour either.
        return esc(name) + (d.onRoute ? " on their way" : d.mi > 0 ? " +" + d.mi + " mi" : " their shortest way in");
      })
      .join(SEP);
  }

  // ACCEPTING A PROPOSAL PUTS THE MEETING POINT ON EVERY GROUP'S ROUTE, THE MAIN
  // GROUP'S INCLUDED — theirs is the road it was found on, so adding it turns a
  // suggested coordinate into a stop with a name, a dwell and a roadbook row.
  //
  // INSERTED BEFORE EACH GROUP'S LAST POINT, not appended: the last point is the
  // destination, so appending would route past the meeting point and back to it.
  //
  // THE MAIN GROUP IS PLACED BY DISTANCE AND EVERY OTHER GROUP BY POSITION.
  // Second-to-last was the rule for all of them until 2026-09-04 — true of a
  // joining group, false of the main one, whose route is the ride and has stops
  // all along it, where the meet landed after every stop the rider had planned.
  // `alongM` is threaded through the response and placeMeetOnMain walks the strand
  // back to a route and a slot. A joining group keeps the position rule because
  // there is nothing to measure, but never before its first point.
  //
  // GOES THROUGH addPoint LIKE EVERY OTHER POINT: a second path would be a second
  // path to keep in step with routing, undo and the map.
  //
  // The prebuilt carries `meet`, which is still only a LABEL — junctions() derives
  // the boundary from the route list and reads no role. Cutting the routes is
  // cutSharedStretch, on accept since 2026-09-06.
  /**
     * Where the meeting point goes on the main group's own road.
     *
     * WHAT THE MAIN GROUP HAS THAT NOBODY ELSE DOES IS A ROUTE THE POINT WAS
     * MEASURED AGAINST, so the response says how far along it the meet is — and a
     * route with stops on it needs that number, because "before the last point" put
     * a meeting point 200 miles up the road after every stop the rider had planned.
     *
     * THE STRAND, NOT THE GROUP'S OWN ROUTES: `alongM` is measured along the same
     * concatenation the server built, so the walk back must use the same definition
     * or it lands on the wrong route.
     *
     * NULL WHEN THERE IS NO DISTANCE TO USE — the caller falls back to the position
     * rule, so a missing number costs the placement and not the feature.
     */
  function placeMeetOnMain(alongM) {
    const uid = state.meta.subgroups[0] && state.meta.subgroups[0].uid;
    if (!uid || !Number.isFinite(alongM)) return null;
    // ACTIVE DAYS ONLY, matching the server — a losing alternate is not a road
    // anybody is riding, so it contributes no distance to walk through.
    const active = ALT.activeRoutes(state.routes);
    const strand = active.filter((d) => !d.subgroupUid || d.subgroupUid === uid);
    const place = DIST.placeAlongStrand(strand, alongM);
    if (!place) return null;
    const route = strand[place.index];
    const routeIndex = state.routes.indexOf(route);
    if (routeIndex < 0 || route.points.length === 0) return null;
    return { uid, routeIndex, at: place.at };
  }

  function takeMeet(d) {
    const lat = Number(d.lat);
    const lng = Number(d.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const alongM = Number(d.along);

    // THE ONE GROUP THIS ROW IS ABOUT, and its LAST route by index — addPoint takes
    // an index and everything downstream is expressed in one.
    //
    // ONE GROUP, NOT ALL OF THEM, since 2026-09-04: taking group 2's meeting point
    // must not drop a point on group 3's road, which is still undecided. A group with
    // no route of its own is skipped rather than refused.
    const lastOf = new Map();
    state.routes.forEach((route, i) => {
      if (route.subgroupUid && route.subgroupUid === d.group) lastOf.set(route.subgroupUid, i);
    });

    // THE MAIN GROUP IS PLACED BY DISTANCE, EVERY OTHER GROUP BY POSITION, and
    // that asymmetry is the shape of what is known rather than an inconsistency.
    // `alongM` is measured along the MAIN group's strand and means nothing on
    // anybody else's road; a joining group contributes a starting point and has
    // no road to measure into until this insert draws one.
    const mainPlace = placeMeetOnMain(alongM);
    if (mainPlace) lastOf.delete(mainPlace.uid);
    if (lastOf.size === 0 && !mainPlace) return;

    const names = [];
    const placed = [];
    // BACK TO FRONT, so an insert never moves an index still to be used. The
    // routes here are distinct so it would survive either order, but doing
    // index-shifting edits in reverse is the habit that keeps the multi-route
    // paths in this file correct.
    const targets = [...lastOf.entries()];
    if (mainPlace) targets.push([mainPlace.uid, mainPlace.routeIndex]);
    targets.sort((a, b) => b[1] - a[1]);
    const routed = [];
    for (const [uidOfGroup, routeIndex] of targets) {
      const route = state.routes[routeIndex];
      if (!route || route.points.length === 0) continue;
      const g = subgroupByUid(uidOfGroup);
      // NAMED AFTER THE STATION where there is one, so the route list reads
      // "Shell" rather than a row every group has three of. The `meet` role is
      // what says what it is FOR; the name says where it is.
      const pt = newPoint(lng, lat, d.name || "Meeting point", d.address);
      // `gas` alongside `meet` when it is a forecourt: the fuel overlay reads
      // that role to decide where a tank refills, and a meeting point everyone
      // fills up at is exactly a refuel the range ring should know about.
      pt.roles = d.name ? ["meet", "gas"] : ["meet"];
      // NEVER BEFORE THE FIRST POINT. A joining group contributes a STARTING POINT and
      // nothing else, so its route is routinely one point long — and `points.length -
      // 1` is 0 there, which put the meeting point ahead of where the group sets off
      // and made elapsedToPointS() return 0, telling them to leave as everyone
      // arrives. The floor of 1 is clamped up by addPoint, so a one-point route
      // appends.
      const at =
        mainPlace && uidOfGroup === mainPlace.uid ? Math.max(1, mainPlace.at) : Math.max(1, route.points.length - 1);
      routed.push(addPoint(lng, lat, pt.name, routeIndex, pt, at));
      // THE POINT'S OWN uid RIDES ALONG, and everything downstream resolves the
      // index from it rather than trusting `at`. addPoint clamps the slot to the
      // route's length, so `at` is where the point was ASKED to go and not
      // necessarily where it went — and the two places that read it back, the
      // departure sync and the route cut, are both off by one the moment they
      // disagree. A uid is the identity that survives every edit in this file.
      placed.push({ uid: uidOfGroup, routeIndex, at, puid: pt.uid });
      if (g) names.push(g.name);
    }

    // THIS GROUP'S CANDIDATES GO AND EVERYBODY ELSE'S STAY. The decision that
    // was just made is done — leaving its other two dots up would read as three
    // meeting points for one group — but the groups still undecided are the
    // whole reason a press answers everybody at once, and clearing the map here
    // is what would send the planner back to the button for each of them.
    const out = $("sg-meet-out");
    if (state.meet) {
      state.meet = { ...state.meet, groups: (state.meet.groups || []).filter((g) => g.group !== d.group) };
    }
    const rest = (state.meet && state.meet.groups) || [];
    // IN STATE, NOT ONLY IN THE DOM, for the same reason the proposal is: this
    // panel is rebuilt out from under us the moment a departure moves.
    state.meetNote =
      '<p class="sg-note">Added to ' +
      esc(names.reverse().join(", ")) +
      "—they now ride through it. Working out departure times…</p>";
    out.innerHTML = state.meetNote + (rest.length ? meetAllHtml(state.meet) : "");
    showMeetPreview(out, state.meet);

    // WAITS FOR THE REAL ROADS. Every leg here is a straight placeholder until
    // the Routes responses land, and syncing departures to a straight-line
    // duration would set every time to a number that is about to change — with
    // nothing to say it had. This is the one caller that awaits addPoint.
    Promise.all(routed).then(() => {
      // The remaining groups' sections are re-rendered with the result rather than
      // replaced by it: the departure line is about the decision just made, and the
      // sections under it are the ones still to make.
      //
      // `$("sg-meet-out")` IS RE-READ rather than closed over — it was replaced on
      // every render until 2026-09-05, and re-reading is the form that survives that
      // being true again.
      const sync = syncDeparturesToMeet(placed);
      // THE SHARED STRETCH BECOMES ITS OWN DAY, and it happens after the sync
      // rather than before it because the sync addresses routes by index and this
      // changes them. It also needs the arrival the sync worked out: the shared
      // route starts at the meeting point, which is the moment everybody is there.
      state.meetNote = '<p class="sg-note">' + sync.note + cutSharedStretch(placed, sync.arrival) + "</p>";
      const host = $("sg-meet-out");
      if (!host) return;
      host.innerHTML = state.meetNote + (rest.length ? meetAllHtml(state.meet) : "");
      showMeetPreview(host, state.meet);
    });
  }

  /**
    * Set every sub-group's departure so they reach the meeting point when the main
    * group does.
    *
    * THE MAIN GROUP'S CLOCK IS THE ONE THAT HOLDS, which is the same rule the
    * fairness note is about and the reason `time_anchor` needs no control. So this
    * never moves the main group's route — a planner who set a 7am start keeps it.
    *
    * ARITHMETIC ON THE STORED VALUE, WITH NO ZONE ANYWHERE. `startAt` is a wall
    * clock carried as UTC, so adding seconds stays in the same representation — see
    * route-clock.js, the only place that value is converted. Do not reach for a
    * local Date here.
    */
  function syncDeparturesToMeet(placed) {
    const mainUid = state.meta.subgroups[0] && state.meta.subgroups[0].uid;
    const main = placed.find((p) => p.uid === mainUid);
    if (!main) return { note: "They now ride through it.", arrival: null };

    const mainRoute = state.routes[main.routeIndex];
    const mainAt = meetIndex(mainRoute, main);
    const mainStart = mainRoute && routeStartS(mainRoute);
    // NOTHING TO SYNC TO, said rather than silently skipped. An undated main route
    // is the ordinary state of a ride nobody has put a date on yet, and a rider
    // who watched three departure times not change deserves to know it was this
    // and not a failure.
    if (mainStart == null) {
      return {
        note:
          "They now ride through it. Give " +
          esc(subgroupName(mainUid)) +
          "’s route a date and time to line the other groups up with it.",
        arrival: null,
      };
    }
    const mainToMeet = mainAt == null ? null : elapsedToPointS(mainRoute, mainAt);
    if (mainToMeet == null) return { note: "They now ride through it.", arrival: null };
    const arrival = mainStart + mainToMeet;

    // ITS OWN UNDO STEP. The point inserts pushed theirs while the rider was
    // watching; this lands a second or two later when the Routes responses do,
    // and folding it into the last insert would make one undo take back a
    // departure time the rider had already read on screen.
    beginEdit("sync departures");
    const moved = [];
    for (const p of placed) {
      if (p.uid === mainUid) continue;
      const route = state.routes[p.routeIndex];
      const at = meetIndex(route, p);
      const toMeet = at == null ? null : elapsedToPointS(route, at);
      if (toMeet == null) continue;
      // The seconds are dropped so a rider is given a departure on the minute —
      // a route's duration is seconds-precise and "leave at 07:43:19" is a
      // false precision nobody can act on. Rounding DOWN, because the alternative
      // is telling somebody to leave after the moment they had to.
      const departS = Math.floor((arrival - toMeet) / 60) * 60;
      const wasS = routeStartS(route);
      route.startAt = new Date(departS * 1000).toISOString();
      // THE GROUP'S EARLIER ROUTES COME WITH IT. Only the route HOLDING the meet was
      // moved until 2026-09-06, so moving a departure two hours earlier left the group
      // arriving at the meet the route before they set off from the previous night's
      // hotel. Ziad's call: the whole approach shifts.
      //
      // BY THE SAME DELTA, WHICH PRESERVES THE GAPS — solving each earlier route
      // backwards would mean deciding how long a night is, which is already in the
      // rider's dates. An undated route is skipped rather than given one.
      if (wasS != null) shiftEarlierRoutes(p.uid, p.routeIndex, departS - wasS);
      moved.push(subgroupName(p.uid) + " " + fmtMoment(departS));
    }
    // refreshDerived() syncs every route's end from its new start, so the ends
    // follow the departures without this touching endAt itself.
    renderRoutes();
    refreshDerived();
    markDirty();
    if (!moved.length) return { note: "They now ride through it.", arrival: arrival };
    return {
      note: "Everyone arrives at " + fmtMoment(arrival) + ". Leaving: " + esc(moved.join(SEP)) + ".",
      arrival: arrival,
    };
  }

  /**
   * Where the meeting point actually landed in a route.
   *
   * BY uid, NEVER BY THE SLOT IT WAS ASKED FOR. `addPoint` clamps its `at` to
   * the route's length, so a request to insert at 3 into a two-point route lands at
   * 2 — and both readers of this number, the departure sync and the route cut, are
   * silently off by one when that happens. `points.uid` is the identity that
   * survives every edit in this file, which is exactly what it is for.
   */
  function meetIndex(route, p) {
    if (!route) return null;
    const i = route.points.findIndex((pt) => pt.uid === p.puid);
    return i < 0 ? null : i;
  }

  /**
    * Move a group's routes BEFORE `routeIndex` by `deltaS` seconds.
    *
    * Its own routes only — a shared route belongs to the main group's clock, which
    * this must never touch. Wall clock carried as UTC, so this is arithmetic on the
    * stored value with no zone anywhere.
    *
    * `endAt` is left alone: refreshDerived() re-derives every route's end from its
    * start, so a value set here would be overwritten a moment later.
    */
  function shiftEarlierRoutes(groupUid, routeIndex, deltaS) {
    if (!deltaS) return;
    for (let i = 0; i < routeIndex && i < state.routes.length; i++) {
      const d = state.routes[i];
      if (d.subgroupUid !== groupUid) continue;
      const s = routeStartS(d);
      if (s == null) continue;
      d.startAt = new Date((s + deltaS) * 1000).toISOString();
    }
  }

  /**
    * Cut the shared stretch out of the main group's route and make it a route of
    * its own, ridden by everybody.
    *
    * WHAT ACCEPTING A MEETING POINT USED TO LEAVE BEHIND: the main group's route
    * ran straight through the meet to the destination, so the road after it was
    * tagged to the main group while every other group was expected to ride it, and
    * the rider was told to split it themselves. Ziad's call, 2026-09-06.
    *
    * THE TAIL IS UNTAGGED, WHICH IS THE WHOLE POINT — an untagged route is ridden
    * by everyone, so this turns "the main group's road, which the others somehow
    * join" into #67's structure: one approach per group, then a shared route.
    * `junctions()` derives a MEET at that boundary with no column and no flag.
    *
    * IT GOES AFTER THE LAST APPROACH, NOT AFTER THE ROUTE IT WAS CUT FROM.
    * `strandOf` builds a strand in position order, so a shared route ahead of a
    * joining group's approach puts the ride home before the ride out — and the main
    * group's route is routinely first, so the naive splice is wrong in the ordinary
    * case rather than the exotic one.
    *
    * IT STARTS AT THE ARRIVAL, NOT THE NEXT MORNING, which is the opposite of
    * `splitRouteHere`: everybody meets and rides on. An undated ride stays undated.
    *
    * ITS OWN UNDO STEP, like the departure sync's — one press should give back the
    * ride the rider was looking at rather than three edits.
    *
    * Returns the sentence for the note, or "" when there was nothing to cut, which
    * is the ordinary outcome rather than a failure.
    */
  function cutSharedStretch(placed, arrival) {
    const mainUid = state.meta.subgroups[0] && state.meta.subgroups[0].uid;
    const main = placed.find((p) => p.uid === mainUid);
    if (!main) return "";
    // OBJECTS, RESOLVED ONCE, BEFORE ANY SPLICE. Everything below inserts routes,
    // which moves every index after the insert — and `placed` holds the indices
    // as they were when the points went in. Holding the route OBJECT and asking
    // for its index at the moment it is needed is the only form that survives
    // two cuts in one press. Same reason meetIndex() resolves a point by uid.
    const held = placed.map((p) => ({ p: p, route: state.routes[p.routeIndex] || null })).filter((h) => h.route);

    const mainRoute = state.routes[main.routeIndex];
    const i = mainRoute ? meetIndex(mainRoute, main) : null;
    // NOTHING AFTER THE MEET IS NOT AN ERROR: canSplitAt refuses the last point, and
    // a main group whose route ends at the meeting point has no shared stretch.
    //
    // THE JOINING TAILS ARE STILL CUT IN THAT CASE, which is why this is a branch
    // rather than an early return — it used to be one, so the ordinary shape meant
    // no joining group's road past the meet was ever trimmed.
    if (i == null || !SPLIT.canSplitAt(mainRoute, i)) {
      // GUARD BEFORE beginEdit, like every other refusal in this file. With no
      // main cut to make and no joining tail to trim — which is the ordinary
      // shape — an unconditional beginEdit here pushes an undo step for nothing,
      // and the rider presses undo and watches nothing happen.
      if (!held.some((h) => h.p.uid !== mainUid && splittableAtMeet(h))) return "";
      beginEdit("split at the meeting point");
      return cutJoiningTails(held, mainUid);
    }
    if (state.routes.length >= MAX_ROUTES) {
      return (
        " The shared stretch is still part of " +
        esc(routeLabel(state.routes.indexOf(mainRoute))) +
        "—the ride is at its route limit."
      );
    }

    const r = state.routes.indexOf(mainRoute);
    const route = mainRoute;
    beginEdit("split at the meeting point");
    const cut = SPLIT.splitRouteAt(route, i, uid);

    // Everybody rides it. This is the one line that makes the cut worth making.
    cut.second.subgroupUid = null;
    cut.second.title = "Together from " + (route.points[i].name || "the meeting point");

    // A COLOR THAT IS NOT ITS NEIGHBOR'S, the same rule splitRouteHere follows.
    const used = new Set(state.routes.map((d) => d.color));
    cut.second.color =
      ROUTE_COLORS.find((c) => !used.has(c)) || ROUTE_COLORS[state.routes.length % ROUTE_COLORS.length];

    state.routes.splice(r, 1, cut.first);
    syncEnd(cut.first);
    if (arrival != null) cut.second.startAt = new Date(arrival * 1000).toISOString();

    // AFTER THE LAST APPROACH. Every placed route is an approach to this meeting
    // point, so the shared stretch belongs after all of them — and the indices
    // are re-read from the array rather than taken from `placed`, because the
    // splice above has already moved everything past `r`.
    let after = r;
    for (const h of held) {
      const at = state.routes.indexOf(h.route);
      if (at > after) after = at;
    }
    state.routes.splice(after + 1, 0, cut.second);
    // THE ACTIVE DAY IS AN INDEX, so inserting ahead of it moves what it points
    // at. `splitRouteHere` gets away with not doing this because it finishes with
    // goToRoute(); this deliberately does not move the rider's attention — they
    // are reading the panel, not the route list — so the index has to be carried
    // across by hand or the next map click lands on the wrong route.
    if (state.active > after) state.active += 1;

    // AND EVERY JOINING GROUP THAT DREW PAST THE MEETING POINT. Their approach
    // has to END there — that is what an approach is — so a route running
    // through it to somewhere else is a group riding past the place they were
    // told to stop and wait.
    const tails = cutJoiningTails(held, mainUid);

    renderRoutes();
    rebuildLayers();
    renderMarkers();
    refreshDerived();
    markDirty();
    return " The road after it is now a shared route everybody rides." + tails;
  }

  /**
    * End every joining group's approach AT the meeting point, keeping whatever they
    * had drawn past it.
    *
    * A joining group contributes a starting point and nothing else, so normally
    * there is nothing to do. This exists for a planner who drew their own
    * destination: the approach ran THROUGH the meeting point to somewhere else.
    *
    * **NOTHING IS DELETED, AND THAT IS DELIBERATE.** The road past the meet is
    * usually redundant, but "usually" is a judgment about somebody else's plan, and
    * a silent delete cannot be undone by looking at the screen. It becomes a route
    * of that group's own and the note names them, so one press removes it.
    *
    * **BACK TO FRONT**, so an insert never moves an index still to be used.
    */
  /** Whether this group drew road PAST the meeting point. The ordinary answer is
   *  no: a joining group contributes a starting point, so by the time the meet
   *  is added its route is two points and the meet is the last of them. */
  function splittableAtMeet(h) {
    const i = meetIndex(h.route, h.p);
    return i != null && SPLIT.canSplitAt(h.route, i);
  }

  function cutJoiningTails(held, mainUid) {
    const names = [];
    const targets = held
      .filter((h) => h.p.uid !== mainUid)
      .map((h) => ({ h: h, at: state.routes.indexOf(h.route) }))
      .filter((t) => t.at >= 0)
      .sort((a, b) => b.at - a.at);

    for (const t of targets) {
      if (state.routes.length >= MAX_ROUTES) break;
      const route = t.h.route;
      const i = meetIndex(route, t.h.p);
      // The ordinary outcome: the meeting point is the last thing on their
      // route, so their approach already ends there.
      if (i == null || !SPLIT.canSplitAt(route, i)) continue;
      const cut = SPLIT.splitRouteAt(route, i, uid);
      // THEIR OWN, not shared: this is a road one group drew and nobody else
      // agreed to ride. Inheriting the approach's group is what keeps it out of
      // everybody else's strand.
      cut.second.subgroupUid = route.subgroupUid;
      cut.second.color = route.color;
      cut.second.title = "";
      state.routes.splice(t.at, 1, cut.first, cut.second);
      syncEnd(cut.first);
      if (state.active > t.at) state.active += 1;
      const g = subgroupByUid(route.subgroupUid);
      if (g) names.push(g.name);
    }
    if (!names.length) return "";
    return (
      " " +
      esc(names.reverse().join(SEP)) +
      (names.length === 1 ? " had road" : " had roads") +
      " drawn past the meeting point, kept as a separate route—delete it if they are riding the shared one."
    );
  }

  const subgroupName = (uid) => {
    const g = subgroupByUid(uid);
    return g ? g.name : "that group";
  };

  /**
   * The dialog's own events. Bound once, when it is built.
   *
   * The destination search is `openNewGroup()`'s, verbatim in shape: a 300ms
   * debounce, a three-character floor, and a `seq` counter so a slow response for
   * an old query cannot overwrite a fast one for the current query. Coordinates
   * are fetched only for the PICK, because Place Details bills per call and a
   * rider typing a town name would otherwise spend one per keystroke.
   */
  function wireSplitDialog(el) {
    const close = () => {
      if (typeof el.close === "function" && el.open) el.close();
      else el.removeAttribute("open");
    };
    const destField = el.querySelector(".split-dest");
    const hitList = el.querySelector(".split-hits");
    let hits = [];
    let seq = 0;
    let timer = null;

    el.querySelector(".split-group").addEventListener("change", () => renderSplitPicks(el));
    el.querySelector(".split-name").addEventListener("input", () => refreshSplitGo(el));
    el.querySelector(".rider-picks").addEventListener("change", () => refreshSplitGo(el));
    el.querySelector("[data-split-cancel]").addEventListener("click", close);

    destField.addEventListener("input", () => {
      // Typing invalidates a pick: the field no longer names the place whose
      // coordinates are held, and committing those would send them somewhere the
      // rider is no longer looking at.
      el.dataset.dest = "";
      refreshSplitGo(el);
      clearTimeout(timer);
      const q = destField.value.trim();
      if (q.length < 3) {
        hitList.hidden = true;
        return;
      }
      timer = setTimeout(async () => {
        const mine = ++seq;
        const found = await searchPlaces(state.map, q).catch(() => []);
        if (mine !== seq) return;
        hits = found || [];
        hitList.innerHTML = hits.length
          ? hits
              .map(
                (h, n) =>
                  '<li><button type="button" class="split-hit" data-i="' +
                  n +
                  '">' +
                  esc(h.name) +
                  (h.context ? ' <span class="split-ctx">' + esc(h.context) + "</span>" : "") +
                  "</button></li>",
              )
              .join("")
          : '<li class="split-empty">No matches on screen—zoom out to search wider.</li>';
        hitList.hidden = false;
      }, 300);
    });

    hitList.addEventListener("click", async (e) => {
      const btn = e.target.closest(".split-hit");
      if (!btn) return;
      const h = hits[Number(btn.dataset.i)];
      if (!h) return;
      const picked = await h.resolve().catch(() => null);
      if (!picked) return toast("Could not locate that place", true);
      destField.value = picked.name;
      el.dataset.dest = JSON.stringify(picked);
      hitList.hidden = true;
      refreshSplitGo(el);
    });

    el.querySelector("[data-split-go]").addEventListener("click", async (e) => {
      const r = Number(el.dataset.route);
      const i = Number(el.dataset.i);
      const route = state.routes[r];
      const rr = routeRidersOf(route);
      if (!route || !rr) return close();
      const riderIds = [...el.querySelectorAll(".rider-picks input:checked")].map((x) => Number(x.value));
      let groupUid = el.querySelector(".split-group").value;
      // A NEW GROUP IS MINTED BEFORE THE SAVE, because the save is what creates
      // it: reconcileSubgroups matches on the uid this file holds. Never promoted
      // — subgroups[0] is the main group and taking that slot from underneath the
      // ride would re-point every meeting-point proposal at a road nobody planned.
      if (!groupUid) {
        const name = el.querySelector(".split-name").value.trim();
        const g = {
          uid: uid(),
          name: name || "Group " + (state.meta.subgroups.length + 1),
          color: ROUTE_COLORS[state.meta.subgroups.length % ROUTE_COLORS.length],
        };
        state.meta.subgroups.push(g);
        state.meta.primarySubgroup = state.meta.subgroups[0].uid;
        groupUid = g.uid;
        ridersStale();
      }
      const choice = {
        groupUid: groupUid,
        riderIds: riderIds,
        onRoute: rr.riderIds || [],
        destination: JSON.parse(el.dataset.dest),
      };
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = "Splitting…";
      const result = splitGroupOffAt(r, i, choice);
      if (!result) {
        btn.textContent = "Split";
        refreshSplitGo(el);
        return;
      }
      close();
      btn.textContent = "Split";
      // The road is drawn and undoable either way; only the rider record can fail
      // on its own, and a rider who is told nothing would read the split as done.
      const ok = await writeSplitRiders(result, choice);
      if (!ok)
        toast("The split is drawn, but who rides it could not be saved—try the riders pill on those routes", true);
    });
  }

  /**
    * The split dialog, built once and appended to `<body>`.
    *
    * A DIALOG FOR THE SAME REASON THE RIDER PICKER IS ONE: three questions — who
    * leaves, which of them, where they are going — and a 380px drawer row has
    * nowhere to put that. `showModal()` needs the top layer, which is why both
    * buttons carry `.btn`: the panel's own rules are nested inside
    * `.builder-panel`.
    *
    * THE GROUP LIST COMES FROM THE SERVER, NOT `state.meta.subgroups` — only the
    * server's carries the numeric id `route_riders.subgroup_id` needs.
    */
  function splitGroupDialog() {
    let el = $("tb-split");
    if (el) return el;
    el = document.createElement("dialog");
    el.id = "tb-split";
    el.className = "modal";
    el.setAttribute("aria-labelledby", "tb-split-title");
    el.innerHTML =
      '<h2 id="tb-split-title"></h2>' +
      '<div class="modal-body">' +
      '<p class="modal-lede"></p>' +
      '<label class="split-lab" for="tb-split-group">Who is leaving?</label>' +
      '<select id="tb-split-group" class="split-group"></select>' +
      '<input class="split-name" id="tb-split-name" type="text" maxlength="80" autocomplete="off"' +
      ' data-1p-ignore placeholder="Name for the new group" aria-label="Name for the new group" hidden>' +
      '<ul class="rider-picks"></ul>' +
      '<p class="split-warn" hidden></p>' +
      '<label class="split-lab" for="tb-split-dest">Where are they headed?</label>' +
      '<input class="split-dest" id="tb-split-dest" type="text" autocomplete="off" data-1p-ignore' +
      ' spellcheck="false" placeholder="Town, address or place">' +
      '<ul class="split-hits" hidden></ul>' +
      "</div>" +
      '<div class="modal-error-acts">' +
      '<button type="button" class="btn btn-quiet" data-split-cancel>Cancel</button>' +
      '<button type="button" class="btn" data-split-go disabled>Split</button>' +
      "</div>";
    document.body.appendChild(el);
    wireSplitDialog(el);
    return el;
  }

  /**
   * Open the split dialog on a stop.
   *
   * Only riders who are ON this stretch are offered — splitting off somebody who
   * is not there is not a thing anyone means — and the group picker prefills from
   * `lastRiders`, which is `ridersWhoRodeAs()` server-side: the people who last
   * rode as that group. Editable afterwards, which is what covers the one or two
   * who carry on rather than going home with their own lot.
   */
  function openSplitGroup(r, i) {
    const route = state.routes[r];
    const rr = routeRidersOf(route);
    const roster = (state.routeRiders && state.routeRiders.riders) || [];
    if (!route || !rr || roster.length < 2) return;
    const el = splitGroupDialog();
    el.dataset.route = r;
    el.dataset.i = i;
    const stop = route.points[i];
    el.querySelector("#tb-split-title").textContent = "Split a group off at " + (stop.name || "this stop");
    el.querySelector(".modal-lede").textContent =
      "They ride on from here to somewhere of their own. Everyone else carries on as planned.";
    const mainUid = state.meta.subgroups[0] && state.meta.subgroups[0].uid;
    el.querySelector(".split-group").innerHTML =
      state.meta.subgroups
        .filter((g) => g.uid !== mainUid)
        .map((g) => '<option value="' + esc(g.uid) + '">' + esc(g.name) + "</option>")
        .join("") + '<option value="">A new group…</option>';
    el.querySelector(".split-name").value = "";
    el.querySelector(".split-dest").value = "";
    el.querySelector(".split-hits").hidden = true;
    el.dataset.dest = "";
    renderSplitPicks(el);
    if (typeof el.showModal === "function") {
      if (!el.open) el.showModal();
    } else {
      el.setAttribute("open", "");
    }
    el.querySelector(".split-group").focus();
  }

  /** The rider list, re-drawn whenever the chosen group changes so the prefill
   *  follows it. Ticks come from `lastRiders`; the list is who is on the route. */
  function renderSplitPicks(el) {
    const route = state.routes[Number(el.dataset.route)];
    const rr = routeRidersOf(route);
    const roster = (state.routeRiders && state.routeRiders.riders) || [];
    const onRoute = new Set((rr && rr.riderIds) || []);
    const uid = el.querySelector(".split-group").value;
    const g = (state.routeRiders.groups || []).find((x) => x.uid === uid);
    const pre = new Set((g && g.lastRiders) || []);
    el.querySelector(".rider-picks").innerHTML = roster
      .filter((m) => onRoute.has(m.riderId))
      .map(
        (m) =>
          '<li><label><input type="checkbox" value="' +
          m.riderId +
          '"' +
          (pre.has(m.riderId) ? " checked" : "") +
          "> " +
          esc(m.displayName) +
          "</label></li>",
      )
      .join("");
    el.querySelector(".split-name").hidden = uid !== "";
    refreshSplitGo(el);
  }

  /** Everything the Split button waits for, in one place so the reason a rider
   *  cannot press it is always the one shown beside the list. */
  function refreshSplitGo(el) {
    const route = state.routes[Number(el.dataset.route)];
    const rr = routeRidersOf(route);
    const onRoute = (rr && rr.riderIds) || [];
    const picked = [...el.querySelectorAll(".rider-picks input:checked")].map((x) => Number(x.value));
    const uid = el.querySelector(".split-group").value;
    const named = uid !== "" || el.querySelector(".split-name").value.trim() !== "";
    const dest = el.dataset.dest !== "";
    const okRiders = SPLIT.canSplitRiders(onRoute, picked);
    const warn = el.querySelector(".split-warn");
    // EVERY GROUP KEEPS A RIDER, THE ONE CARRYING ON INCLUDED, and the reason is
    // stated in place rather than as a toast after a press that does nothing.
    if (picked.length && !okRiders) {
      warn.textContent =
        picked.length >= onRoute.length
          ? "Somebody has to carry on—leave at least one " + W("person") + " on the road ahead."
          : "Nobody would be " + W("travel") + " this.";
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
    el.querySelector("[data-split-go]").disabled = !(okRiders && named && dest);
  }

  /**
    * Peel a group off the ride at a stop: the structural half.
    *
    * THE MIRROR OF `cutSharedStretch`. Accepting a meeting point leaves the tail
    * UNTAGGED because everybody rides together from there; a split is the same cut
    * read the other way, so the tail is tagged with whoever carries on.
    *
    * **THE CONTINUATION IS TAGGED WITH WHOEVER KEEPS RIDING IT, WHICH TAGS THE MAIN
    * GROUP FOR THE FIRST TIME.** Ziad's call, 2026-09-07. `null` means EVERYONE
    * rides a route, so leaving the continuation shared is a false and expensive
    * statement: `strandOf` would hand the leavers the main group's entire onward
    * road — the ride-34 origin bug in a third costume. It costs `startRouteOf` a
    * parameter, and `groupStartHtml` and `longestApproach` the same correction.
    *
    * **THE PEEL-OFF ROUTE GOES TO THE END OF THE LIST, NOT BESIDE THE CUT.**
    * `resolveRouteRiders` is a linear walk carrying a set forward, so a route
    * spliced in mid-list makes every route AFTER it inherit the leavers, silently.
    * `test/route-riders.test.ts` pins both readings against each other.
    *
    * **NOTHING IS RE-ROUTED EXCEPT THE ONE NEW LEG** — the leavers' road from the
    * stop to where they are going.
    *
    * `choice` is `{ groupUid, riderIds, destination }`. Returns both route uids.
    */
  function splitGroupOffAt(r, i, choice) {
    const route = state.routes[r];
    const g = subgroupByUid(choice.groupUid);
    if (!route || !g) return null;
    const cutting = SPLIT.canSplitAt(route, i);
    // GUARDS BEFORE beginEdit, like every other refusal in this file — a refused
    // split must push no undo step. Two routes are added when the stop is interior
    // and one when the route already begins there.
    if (!SPLIT.canPeelOffAt(route, i)) return null;
    if (state.routes.length + (cutting ? 2 : 1) > MAX_ROUTES) {
      toast("Route limit reached (" + MAX_ROUTES + ")", true);
      return null;
    }

    const mainUid = state.meta.subgroups[0] && state.meta.subgroups[0].uid;
    const stop = route.points[i];
    // THE ARRIVAL, NOT THE NEXT MORNING, which is where this diverges from
    // splitRouteHere for the same reason cutSharedStretch does: a rider splitting
    // a route by hand is usually marking where they slept, and here everybody
    // arrives and one lot turns off. Null on an undated ride, which is ordinary.
    const startS = routeStartS(route);
    const toStop = startS == null ? null : elapsedToPointS(route, i);
    const arrival = startS == null || toStop == null ? null : startS + toStop;
    const arriveIso = arrival == null ? null : new Date(Math.floor(arrival / 60) * 60 * 1000).toISOString();

    beginEdit("split a group off");

    let continuation = route;
    if (cutting) {
      const cut = SPLIT.splitRouteAt(route, i, uid);
      continuation = cut.second;
      continuation.subgroupUid = route.subgroupUid || mainUid;
      continuation.title = "";
      // A COLOR THAT IS NOT ITS NEIGHBOR'S, the same rule splitRouteHere follows.
      const used = new Set(state.routes.map((d) => d.color));
      continuation.color =
        ROUTE_COLORS.find((c) => !used.has(c)) || ROUTE_COLORS[state.routes.length % ROUTE_COLORS.length];
      state.routes.splice(r, 1, cut.first, continuation);
      // splitRouteHere omits this and gets away with it because the identity check
      // in computeLeg discards a stale response; the sequence array still ends up
      // one short of the route array, so every index past `r` is reading the wrong
      // entry. Splice it here rather than inherit the bug.
      state.legSeq.splice(r + 1, 0, []);
      syncEnd(cut.first);
      if (arriveIso) continuation.startAt = arriveIso;
      if (state.active > r) state.active += 1;
    } else if (route.subgroupUid == null && mainUid) {
      // No cut to make: the route already begins at this stop. It still has to
      // stop claiming everybody, for the same reason the cut half does.
      continuation.subgroupUid = mainUid;
    }

    // The leavers' road. seedGroupRoute()'s recipe, plus a destination — and it
    // builds its own first point rather than reusing splitRouteAt's carried copy,
    // which drops `address`.
    const peel = newRoute(g.color);
    peel.subgroupUid = g.uid;
    peel.title = "";
    peel.points.push(newPoint(stop.lng, stop.lat, stop.name, stop.address));
    ensureRouteHasStop(peel);
    if (!peel.points[0].roles.length) peel.points[0].roles = ["start"];
    const dest = choice.destination;
    peel.points.push(newPoint(dest.lngLat[0], dest.lngLat[1], dest.name, dest.address));
    peel.legs.push(straightLeg([stop.lng, stop.lat], dest.lngLat));
    peel.startAt = arriveIso || continuation.startAt || null;
    state.routes.push(peel);
    state.legSeq.push([]);

    // ONE ROUTES REQUEST AND ONE UNDO STEP. addPoint() would push a second,
    // uncoalesced `beginEdit("add point")`, and a single undo has to give back the
    // ride the planner was looking at rather than half of this.
    computeLeg(state.routes.length - 1, 0);

    renderRoutes();
    rebuildLayers();
    renderMarkers();
    refreshDerived();
    markDirty();
    // The continuation, not the new route: a second group peels off from the same
    // stop, which is now its first row.
    goToRoute(state.routes.indexOf(continuation));
    return { peelUid: peel.uid, continueUid: continuation.uid, arrival: arrival, cut: cutting };
  }

  /**
    * Peel a group off: the rider half, which is what makes the split a fact.
    *
    * **A BRAND-NEW GROUP HAS NO SERVER ID UNTIL A SAVE, AND WRITING WITHOUT ONE
    * FAILS SILENTLY.** `reconcileSubgroups` inside the ordinary save is the only
    * thing that creates a subgroup, and `setRouteRiders` coerces an unrecognized
    * group id to null rather than refusing — so an early write says the leavers ride
    * as the main group and looks like it worked. Mutate, save, re-read, then write.
    *
    * **AN ENDPOINT THAT CREATES ONE GROUP WAS REJECTED**: `reconcileSubgroups`
    * deletes stored subgroups whose uid is absent from the payload, so an autosave
    * serialized before the group existed would delete the row it had just inserted.
    *
    * **THE PEEL-OFF ROUTE IS WRITTEN FIRST.** If the second write fails the leavers
    * are named on both roads, which one press fixes; the other order makes them
    * vanish from everything after the boundary.
    */
  async function writeSplitRiders(result, choice) {
    // SAVE FIRST, ALWAYS, AND NOT ONLY FOR A NEW GROUP. The split MINTS TWO ROUTE
    // UIDS and `payloadFor` answers from the routes the DATABASE holds, so a PUT sent
    // first is answered with a list that does not contain them and `applyRouteRiders`
    // replaces the client's map with it. The rows land, and the panel draws no group
    // and no riders on either new route until something re-reads. Seen live on ride
    // 34.
    //
    // Gating this on a new group was the first version and made the failure depend on
    // which group was chosen.
    const saved = await saveNow();
    if (!saved) return false;
    await loadRouteRiders();
    const groupId = state.routeRiders && state.routeRiders.idOfGroup[choice.groupUid];
    if (groupId == null) return false;
    const staying = SPLIT.remainingRiders(choice.onRoute, choice.riderIds);
    const leaving = choice.riderIds.map((id) => ({ id: id, group: groupId }));
    // Riding as the MAIN group is null, not the main group's own id — see the
    // route_riders column comment. Everybody carrying on together is the main
    // group whatever they set off as.
    const carrying = staying.map((id) => ({ id: id, group: null }));
    const ok = await putRouteRiders(result.peelUid, leaving);
    if (!ok) return false;
    return await putRouteRiders(result.continueUid, carrying);
  }

  // MOVING A GROUP IS THE ONLY WAY TO CHANGE WHICH IS MAIN. `subgroups[0]` is
  // the main group by definition, so promotion and reordering are one operation
  // rather than two that could disagree — and `primarySubgroup` is re-derived
  // here rather than set anywhere else, which is what stops the column drifting
  // away from the list a rider is looking at.
  function moveGroup(from, to) {
    const a = state.meta.subgroups;
    if (from === to || from < 0 || to < 0 || from >= a.length || to >= a.length) return;
    beginEdit(to === 0 || from === 0 ? "change the main group" : "reorder groups");
    a.splice(to, 0, a.splice(from, 1)[0]);
    state.meta.primarySubgroup = a[0].uid;
    // renderRoutes() only — it cascades into renderSubgroups(), and calling both
    // would build the row list twice and re-init Sortable on a node it had just
    // bound. The route pickers name groups in this order and the fairness note is
    // about which group is main, so both are stale the moment the order changes.
    renderRoutes();
    markDirty();
  }

  // Rebound on every renderSubgroups() because that replaces the rows; the
  // instance is stashed on the element and destroyed first, the same as the route
  // list and the point lists.
  function initGroupDrag(host) {
    if (!host) return;
    if (!window.Sortable) {
      // Not a failure worth a toast: the grip is a real button with arrow keys,
      // so reordering still works and the only thing lost is the gesture.
      console.warn("[builder] Sortable did not load—reorder groups with the grip and arrow keys");
      return;
    }
    if (host._sortable) host._sortable.destroy();
    host._sortable = window.Sortable.create(host, {
      draggable: ".sg-row",
      handle: ".sg-drag",
      animation: 150,
      ghostClass: "is-dragging",
      // Same reasoning as the route list: one code path on desktop and touch, a
      // drag mirror that can be styled, and the only path a synthetic event can
      // drive.
      forceFallback: true,
      fallbackClass: "route-drag-ghost",
      fallbackOnBody: true,
      onEnd: (evt) => {
        // THE DRAGGABLE PAIR, NOT THE RAW ONE. #sg-list holds nothing but
        // .sg-row today, so the two agree — and that is exactly the property
        // #166 quietly lost when insert slots landed in the point list nine routes
        // after the arithmetic. Reading the pair that stays correct costs
        // nothing and does not depend on nobody ever adding a separator here.
        const from = evt.oldDraggableIndex;
        const to = evt.newDraggableIndex;
        if (from == null || to == null || from === to) return;
        moveGroup(from, to);
      },
    });
  }

  // #67 IS EXPLICIT THAT THE DEFAULT PRIMARY MUST NOT BE THE PLANNER'S OWN
  // GROUP: it is the one most likely to be nearest the meet, so that default
  // reproduces the unfair-6am case every time and the planner does not notice,
  // being the one who rode three miles. The suggestion here is the group with
  // the most riding to do, and the note says what choosing wrong costs.
  function renderAnchorNote() {
    const el = $("sg-anchor-note");
    if (!el) return;
    const longest = longestApproach();
    if (!longest || state.meta.primarySubgroup === longest.uid) {
      el.textContent = longest ? "" : "Give each group at least one route to see the effect.";
      return;
    }
    // NAMES THE GESTURE, because there is no longer a picker to point at: the
    // main group is whichever is at the top of the list, so the fix for this
    // warning is to drag one there.
    el.textContent =
      esc(longest.name) +
      " has the farthest to ride. Pinning a closer group’s clock asks them to leave earlier—drag " +
      esc(longest.name) +
      " to the top to make it the main group.";
  }

  /**
    * Longest by planned riding time across the routes that group rides ALONE BEFORE
    * THE FIRST SHARED ONE — the shared routes cancel out.
    *
    * **AN APPROACH IS WHAT YOU RIDE TO GET THERE, AND THE RIDE HOME IS NOT ONE.** It
    * counted every route a group rode alone, which was the same thing until
    * splitting tagged the main group's continuation — Main would then own the rest
    * of the ride, win every time, and silence `renderAnchorNote()` on exactly the
    * rides with the most groups on them.
    */
  function longestApproach() {
    const active = ALT.activeRoutes(state.routes);
    const met = active.findIndex((d) => !d.subgroupUid);
    const approach = met < 0 ? active : active.slice(0, met);
    let best = null;
    let bestS = -1;
    for (const g of state.meta.subgroups) {
      const s = approach
        .filter((d) => d.subgroupUid === g.uid)
        .reduce((n, d) => n + d.legs.reduce((m, l) => m + (l.durationS || 0), 0), 0);
      if (s > bestS) {
        bestS = s;
        best = g;
      }
    }
    return best;
  }

  // Which sections are currently open, so a rebuild does not spring every twirl
  // back to its default. Keyed by route index, which is the best available: a route
  // has no id until it is saved, and a reorder is meant to carry the open state
  // with the position rather than with the route.
  function openSections() {
    const open = new Set();
    document.querySelectorAll(".route-section").forEach((el) => {
      if (!el.classList.contains("is-shut")) open.add(Number(el.dataset.route));
    });
    // First render: nothing is on the page yet and every route starts open.
    if (!document.querySelector(".route-section")) return null;
    return open;
  }

  function routeSectionHtml(route, r, open) {
    const shut = open && !open.has(r);
    const single = state.routes.length < 2;
    // ALTERNATES. `is-alt` is a losing one and `is-alt-active` the member that
    // counts; both carry `in-alt-group` so the stylesheet can bracket the pair
    // without caring which is which. A route with no group gets none of them, so
    // a ride without alternates renders exactly as it did before.
    const grouped = route.altGroup != null;
    const ghost = grouped && !route.altActive;
    const altClass = !grouped ? "" : ghost ? " in-alt-group is-alt" : " in-alt-group is-alt-active";
    // The badge says which of the two a section is, in the same words the
    // viewer's legend uses. Same reasoning as there: badging only the loser
    // leaves "an alternative to what?" unanswered.
    const altBadge = !grouped
      ? ""
      : '<span class="route-alt' +
        (ghost ? "" : " is-on") +
        '" data-tip="route-alt" title="' +
        (ghost
          ? "Not counted in the ride total. Use the route menu to ride this one instead."
          : "This is the route counted in the ride total.") +
        '">' +
        (ghost ? "alternative" : "riding this") +
        "</span>";
    return (
      '<section class="route-section' +
      (shut ? " is-shut" : "") +
      altClass +
      // Somebody else is working on this route. A class rather than a disabled
      // control: the route stays fully editable, because a claim is advisory and
      // the save path is what actually decides. This says "expect a clash", not
      // "you may not".
      (LIVE.heldBy[route.uid] ? " is-held" : "") +
      '" data-route="' +
      r +
      '"' +
      (LIVE.heldBy[route.uid] ? ' title="' + esc(LIVE.heldBy[route.uid]) + ' is working on this route"' : "") +
      ' style="--route-color:' +
      esc(route.color) +
      '">' +
      '<div class="route-head">' +
      // AFTER the grip, never before it: .route-drag's negative margins depend on
      // being the first thing in the header, and anything ahead of it breaks the
      // tab that reaches the section's padding edge.
      (state.select?.scope === "route"
        ? '<input type="checkbox" class="route-pick" data-route="' +
          r +
          '"' +
          (state.select.routes.has(r) ? " checked" : "") +
          ' aria-label="Select ' +
          esc(routeLabel(r)) +
          '">'
        : "") +
      // The route's own drag handle rather than dragging by the header: the header
      // holds a color input, a text field and buttons, and every attempt to type in
      // the name would start a drag.
      //
      // A BUTTON, not a span, which replaced the ↑ ↓ pair in .route-actions. A drag
      // handle cannot be operated from a keyboard and does not exist at all if the
      // SortableJS CDN fails; arrow keys on a focusable grip cover both without
      // spending two more buttons of a 380px header.
      '<button type="button" class="route-drag" data-tip="route-drag" title="Drag to reorder, or focus and use the arrow keys"' +
      ' aria-label="Reorder route ' +
      routeNumber(r) +
      ', use the up and down arrow keys"></button>' +
      '<button type="button" class="route-twirl" aria-expanded="' +
      (shut ? "false" : "true") +
      '" data-tip="route-twirl" title="Show or hide this route\'s stops"><span class="route-twirl-mark" aria-hidden="true"></span></button>' +
      // The ordinal, rendered rather than stored. Reordering re-renders, so it is
      // always the route's real position and there is nothing to keep in sync.
      '<span class="route-num" aria-hidden="true">' +
      routeNumber(r) +
      "</span>" +
      '<input class="route-color" type="color" value="' +
      esc(route.color) +
      '" data-tip="route-color" title="Route color" aria-label="Color for ' +
      esc(routeLabel(r)) +
      '">' +
      // The placeholder no longer says "Route N", which made an empty field look like
      // it already held the name.
      //
      // `data-1p-ignore` IS NOT A DUPLICATE OF `autocomplete="off"`. 1Password
      // deliberately ignores autocomplete and classifies a field by the words around
      // it, so "Name…" reads as a person's name and it offered a rider their own
      // contact card on the route title. `autocomplete="off"` still earns its place:
      // it stops the BROWSER offering the last ride's route names.
      //
      // Three fields carry it — this, .row-name and .sg-name — and any new free-text
      // field wants it. It is 1Password's own attribute and does nothing in any other
      // extension.
      '<input class="route-title" type="text" maxlength="150" placeholder="Name this route (optional)"' +
      ' autocomplete="off" data-1p-ignore aria-label="Name for route ' +
      routeNumber(r) +
      '" value="' +
      esc(route.title) +
      '">' +
      altBadge +
      routeSubgroupHtml(route, r) +
      routeRidersHtml(route, r) +
      '<span class="route-actions">' +
      // Empty for the same reason .route-del is: icon-reverse.svg comes in through
      // a CSS mask on ::before, so it takes the button's color and its disabled
      // opacity. It was a bare ⇄ (U+21C4), which a screen reader announces as
      // "rightwards arrow over leftwards arrow" — hence the aria-label.
      '<button type="button" class="route-rev" data-tip="route-rev" title="Reverse this route—re-routes every leg" aria-label="Reverse ' +
      esc(routeLabel(r)) +
      '"></button>' +
      // DELETE MOVED INTO THE MENU, and ⇄ did not. One re-routes every leg and the
      // other throws a route away, both one mis-click from the title field. Reverse is
      // the one a rider reaches for mid-edit, so it stays a button.
      //
      // U+22EE, the same glyph the row menu uses, so the two read as the same control
      // at two levels.
      '<button type="button" class="route-menu-btn" data-tip="route-menu" title="More" aria-label="More actions for ' +
      esc(routeLabel(r)) +
      '" aria-haspopup="menu" aria-expanded="false">⋮</button>' +
      "</span>" +
      "</div>" +
      '<div class="route-body">' +
      '<div class="route-times">' +
      '<label class="route-time"><span>Starts</span>' +
      '<input class="route-start" type="datetime-local"></label>' +
      '<label class="route-time"><span>Ends</span>' +
      '<input class="route-end" type="datetime-local"' +
      ' data-tip="route-end" title="Worked out from the start time and the route\'s riding and stops. Type your own to override, or clear it to go back to automatic."></label>' +
      '<span class="route-times-note"></span>' +
      "</div>" +
      prefsHtml(r, route) +
      // data-duration-format rides on each list, not only on #route-list: the rule
      // in _builder.scss that widens .row-dur for the "1h 30m" format keys off
      // the list itself, so putting it only on the ancestor silently stopped it
      // matching and clipped the field.
      '<ol class="point-list" data-route="' +
      r +
      '" data-duration-format="' +
      esc(durFormat) +
      '"></ol>' +
      "</div>" +
      "</section>"
    );
  }

  // WHAT A DAY ASKS OF THE ROUTER (#29) — the three things Routes API v2 can
  // actually be told. There is no "prefer scenic" here because the router has no
  // such notion: that is #28, and it works by scoring the alternates Routes
  // returns rather than by asking for anything.
  const AVOID_PREFS = [
    {
      key: "avoidHighways",
      label: Wsc("highway"),
      hint: "Route this one off the interstate where there is another way",
    },
    { key: "avoidTolls", label: "Tolls", hint: "Avoid toll roads and bridges on this route" },
    {
      key: "avoidFerries",
      label: "Ferries",
      hint: "Keep this " + W("route") + " on roads the " + W("vehicle") + " can go onto",
    },
  ];

  // #28. A SEPARATE GROUP BECAUSE IT IS A DIFFERENT VERB. Four toggles under one
  // "Avoid" label would have read as "avoid twisty roads", which is the opposite
  // of what it does — and the two are answered by different mechanisms anyway:
  // the avoids are Google's routeModifiers, this is us scoring the alternates it
  // returns and keeping the twistiest.
  const PREFER_PREFS = [
    {
      key: "preferTwisty",
      label: Wc("curvy") + " roads",
      hint: "Compare the roads Google offers for this route and take the twistiest",
    },
  ];

  const ROUTE_PREFS = AVOID_PREFS.concat(PREFER_PREFS);

  /**
    * The set flags, or null when none are — the client half of normalizePrefs() in
    * src/maps/route-prefs.ts.
    *
    * MIRRORED RATHER THAN SHARED, and deliberately not pinned by a test the way
    * filename.js is: the server re-normalizes on every save and is the authority, so
    * this only has to keep `{}` out of a request body and out of the dirty check.
    */
  function prefsBody(prefs) {
    if (!prefs) return null;
    const out = {};
    ROUTE_PREFS.forEach((p) => {
      if (prefs[p.key] === true) out[p.key] = true;
    });
    return Object.keys(out).length ? out : null;
  }

  function prefsGroup(r, on, lede, list, label) {
    return (
      '<div class="route-prefs" role="group" aria-label="' +
      esc(label) +
      '">' +
      '<span class="route-prefs-lede">' +
      esc(lede) +
      "</span>" +
      list
        .map(
          (p) =>
            '<button type="button" class="pref-btn' +
            (on[p.key] ? " is-on" : "") +
            '"' +
            ' data-route="' +
            r +
            '" data-pref="' +
            p.key +
            '"' +
            ' aria-pressed="' +
            (on[p.key] ? "true" : "false") +
            '"' +
            ' title="' +
            esc(p.hint) +
            '">' +
            esc(p.label) +
            "</button>",
        )
        .join("") +
      "</div>"
    );
  }

  function prefsHtml(r, route) {
    const on = route.routePrefs || {};
    return (
      prefsGroup(r, on, "Avoid", AVOID_PREFS, "What to avoid on " + routeLabel(r)) +
      prefsGroup(r, on, "Prefer", PREFER_PREFS, "What to prefer on " + routeLabel(r))
    );
  }

  /**
   * What to say when a category search found nothing, naming the stretch that
   * was actually searched.
   *
   * THREE CASES BECAUSE THERE ARE THREE SEARCHES, and telling a rider the wrong
   * one sends them looking in the wrong place — which is the complaint #232 was
   * filed about. Each line also names the way out, and the way out is always a
   * control already on screen.
   */
  function emptyText(spec, isSlot) {
    const what = spec.label.toLowerCase();
    const width = Math.round(window.TBUnits.distanceFromMiles(CORRIDOR_MI, UNITS)) + " " + distUnit;
    if (isSlot)
      return "No " + what + " within " + width + " of this leg. Add it from the bottom of the route to search wider.";
    if (state.corridorOn) return "No " + what + " within " + width + " of this route.";
    return "No " + what + " on screen. Pan or zoom out to look wider.";
  }

  const routeSection = (r) => document.querySelector('.route-section[data-route="' + r + '"]');

  // The active route's own section carries the class; nothing else does. Separate
  // from renderRoutes() because it runs on every click into a row and must not
  // rebuild anything.
  function markActiveSection() {
    const a = activeIndex();
    document.querySelectorAll(".route-section").forEach((el) => {
      el.classList.toggle("is-active", Number(el.dataset.route) === a);
    });
  }

  // The rail's jump list: one dot per route, no "All" — there is no all-routes
  // view to return to now that every route is on screen.
  //
  // Buttons rather than a slider: a 44px-wide slider is not a usable slider, and
  // these are what a screen reader gets once the rail is the only thing on screen.
  function renderRailRoutes() {
    const wrap = $("rail-routes");
    if (!wrap) return;
    const a = activeIndex();
    wrap.innerHTML = state.routes
      .map(
        (route, r) =>
          '<button type="button" class="rail-route" data-route="' +
          r +
          '"' +
          (r === a ? ' aria-current="true"' : "") +
          ' style="--rail-color:' +
          esc(route.color) +
          '"' +
          ' title="' +
          esc(routeLabel(r)) +
          '">' +
          String(r + 1) +
          "</button>",
      )
      .join("");
  }

  // --- Times ----------------------------------------------------------------

  // A DAY'S CLOCK IS A WALL CLOCK AT THE DEPARTURE POINT and nothing converts
  // it into the browser's zone — see the header of public/js/route-clock.js for
  // the rule and for how the value is carried. These three are that file, kept
  // here as thin names because the call sites read better for it.
  const isoToLocalInput = (iso) => window.TBRouteClock.isoToInput(iso);
  const localInputToIso = (value) => window.TBRouteClock.inputToIso(value);

  // The hour a fresh route is assumed to start. Only ever a seed — the rider
  // edits it, and nothing derives from it beyond the first suggestion.
  const ROUTE_START_HOUR = 8;

  // Where a new route's start comes from: the first ROUTE_START_HOUR o'clock
  // strictly after the previous route ends. For a route finishing in the evening
  // that is simply the next morning.
  const nextMorningAfter = (iso) => window.TBRouteClock.nextMorningAfter(iso, ROUTE_START_HOUR);

  const derivedEndIso = (route) =>
    route.startAt ? new Date(new Date(route.startAt).getTime() + routeElapsedS(route) * 1000).toISOString() : null;

  // Whether the rider typed this end themselves, held as session state (not part
  // of the save payload). Inferred once at load, then tracked directly — it has to
  // be a flag rather than the same comparison re-run, because the moment a leg or
  // stop changes an end that WAS automatic no longer matches the new derivation,
  // and comparing would freeze it as though the rider had typed it.
  function inferEndManual(route) {
    if (!route.startAt || !route.endAt) return false;
    const derived = derivedEndIso(route);
    if (!derived) return false;
    return Math.abs(new Date(route.endAt).getTime() - new Date(derived).getTime()) > 60000;
  }

  // Called wherever a route's shape changes. An end the rider typed is left
  // alone; anything else is kept in step with the legs and stops.
  function syncEnd(route) {
    // With no start there is nothing to derive from. An end already on the
    // route is left as it is rather than discarded — the columns are
    // independently nullable, and silently dropping a stored time on load
    // would lose it on the next save.
    if (!route.startAt || route.endManual) return;
    route.endAt = derivedEndIso(route);
  }

  // Every figure the panel shows is derived from the legs and stops, so one
  // call keeps them all honest. Ends sync across every route, not just the edited
  // one — a marker on a dimmed route is still draggable, so any route's shape can
  // change while another is in focus.
  function refreshDerived() {
    state.routes.forEach(syncEnd);
    renderTotals();
    renderTimes();
    renderTimeline();
    // Where the rider will be at bedtime moves with every schedule change — a
    // dragged stop, a new dwell, a changed departure — so it is recomputed and
    // repainted from the one pass every such change already goes through.
    stopByCache = null;
    paintStopBy();
    // Last, and not optional: the leg highlight is derived from the moment and
    // the legs, and the engine drops it on every track repath. Anything that
    // changes a route has to put it back, which is exactly this pass.
    applyFocus();
  }

  // --- Timeline -------------------------------------------------------------

  // The live POI distances this used to compute are gone: a POI carried no stored
  // distFromStartMi, so the time model projected each onto the track and the
  // builder had to pass those distances in. Points sit on leg boundaries now.
  // What the timeline currently spans. Every caller goes through this rather than
  // choosing between routeSpan and rideSpan, so a third scope is one edit here.
  function timelineSpan() {
    if (state.timeScope === "ride") return rideSpan(state.routes);
    const route = state.routes[activeIndex()];
    return route ? routeSpan(route) : null;
  }

  /**
    * THE RIDE-SCOPE SLIDER TRAVELS RIDING HOURS, NOT WALL CLOCK, so the overnights
    * between routes consume none of it.
    *
    * rideSpan() is first-departure to last-arrival, so on a nine-route ride the
    * rider spent more of the drag in "between routes", with nothing on the map, than
    * on the road. In ride scope the value is an OFFSET into the concatenated spans;
    * in route scope there are no gaps and it stays the epoch second it always was.
    *
    * `state.moment` is an epoch second in BOTH scopes, so nothing downstream
    * changes — the compression lives between the slider and that field.
    */
  const rideSegs = () => rideSegments(state.routes);

  function momentFromSlider(v) {
    if (state.timeScope !== "ride") return v;
    return momentAtOffset(rideSegs(), v);
  }

  // Where the moment falls: which route, and which leg or point within it.
  //
  // IN ROUTE SCOPE THE ROUTE IS ALREADY KNOWN, so the moment resolves against it
  // directly. That is not just cheaper — activeAtMoment SKIPS LOSING ALTERNATES,
  // correctly, so a rider who clicked into an alternate to work on it would get
  // back null (or the winning route's index) and watch the route they are editing
  // dim itself.
  //
  // The clamp matters on one frame only: renderTimeline re-ranges the slider when
  // the active route changes, and this can be read in between.
  const activeNow = () => {
    if (state.moment == null) return null;
    if (state.timeScope === "ride") return activeAtMoment(state.routes, state.moment);
    const r = activeIndex();
    const route = r == null ? null : state.routes[r];
    const span = route && routeSpan(route);
    if (!span) return null;
    const at = activeAt(route, Math.min(Math.max(state.moment, span.from), span.to) - span.from);
    return { routeIndex: r, legIndex: at.legIndex, pointIndex: at.pointIndex, legFraction: at.legFraction };
  };

  function renderTimeline() {
    const wrap = $("ride-timeline");
    const slider = $("time-slider");
    const readout = $("time-readout");
    const span = timelineSpan();
    renderTimeScope();
    renderRingToggle();

    // The slider's value is epoch seconds, which is what a screen reader would
    // otherwise read out. aria-valuetext replaces that with the same sentence
    // sighted users get.
    const say = (text) => {
      readout.textContent = text;
      slider.setAttribute("aria-valuetext", text);
    };

    // IT HIDES NOW RATHER THAN GOING INERT, the opposite of what it did in the panel
    // and right for the same reason it was wrong there: inside the panel, vanishing
    // reflowed every control under it the moment a date was typed. On the map's
    // bottom edge there is nothing to reflow, and a dead slider lying across
    // somebody's route is worse than no slider.
    //
    // The hint the disabled state carried moved to #route-times-note, beneath the
    // Starts field that fixes it. This is the only branch that can leave the bar
    // hidden, so the two have to stay in step.
    //
    // IN ROUTE SCOPE THAT MEANS THE ACTIVE ROUTE'S DATES, NOT THE RIDE'S, so the bar
    // comes and goes as a rider clicks between a dated route and an undated one —
    // the honest reading, since there is nothing to scrub on a route with no clock.
    // The cost to state rather than treat as a bug: the scope button goes with the
    // bar, so reaching ride scope from an undated route means clicking into a dated
    // one first.
    wrap.hidden = !span;
    slider.disabled = !span;
    if (!span) {
      slider.min = "0";
      slider.max = "0";
      slider.value = "0";
      say("");
      return;
    }

    if (state.timeScope === "ride") {
      // Zero to total riding seconds. The overnights are not on the track at
      // all, so there is no position on it that means "between routes".
      const segs = rideSegs();
      slider.min = "0";
      slider.max = String(segmentsTotalS(segs));
      slider.value = String(state.moment == null ? 0 : offsetAtMoment(segs, state.moment));
    } else {
      slider.min = String(span.from);
      slider.max = String(span.to);
      slider.value = String(state.moment == null ? span.from : Math.min(Math.max(state.moment, span.from), span.to));
    }

    if (state.moment == null) {
      say(fmtMoment(span.from) + " – " + fmtMoment(span.to));
      return;
    }
    // activeNow(), not activeAtMoment(), because in route scope the moment resolves
    // against the active route rather than being searched for — see the
    // losing-alternate hole in that header.
    //
    // THIS CAPTIONS THE SLIDER, NOT THE MAP, and in ride scope those are two
    // questions with two right answers: the thumb is where the rider left it, the lit
    // route is the one they are editing. Scrub to Route 1, click into Route 3, and
    // the line still says Route 1 — correctly.
    const a = activeNow();
    if (!a) {
      say(fmtMoment(state.moment));
      return;
    }
    let what;
    if (a.routeIndex == null) {
      what = "between routes";
    } else if (a.legIndex != null) {
      what =
        routeLabel(a.routeIndex) + SEP + "leg " + (a.legIndex + 1) + " of " + state.routes[a.routeIndex].legs.length;
    } else {
      // ONE INDEX, into the route's own points array — no filtering, so no chance
      // of reading the wrong element. A point with no name falls back to its
      // position in the route rather than a stop number, because the number a row
      // shows counts stops only and a POI has none.
      const pt = a.pointIndex == null ? null : state.routes[a.routeIndex].points[a.pointIndex];
      const fallback = pt && pt.kind === "poi" ? "a point of interest" : "point " + ((a.pointIndex || 0) + 1);
      what = routeLabel(a.routeIndex) + SEP + "at " + ((pt && pt.name) || fallback);
    }
    say(fmtMoment(state.moment) + SEP + what);
  }

  // Moving the timeline is the primary gesture; the route slider follows it so
  // the two controls can never show different routes.
  function setMoment(momentS) {
    state.moment = momentS;
    // Only in ride scope. In route scope the slider cannot leave the active route —
    // that IS its range — so there is never another route to move to, and asking
    // activeAtMoment would reintroduce the losing-alternate hole activeNow()
    // exists to close.
    if (state.timeScope === "ride") {
      const a = activeAtMoment(state.routes, momentS);
      // A moment between routes leaves the active route where it was — there is no
      // route to move it to, and snapping it somewhere arbitrary would be a lie.
      if (a.routeIndex != null) setActive(a.routeIndex);
    }
    applyFocus();
    refreshDerived();
  }

  // Flips between scrubbing the active route and scrubbing the whole ride.
  //
  // The moment is carried across rather than reset. Going route → ride it is
  // already a real instant inside the ride, so it simply stops being clamped;
  // going ride → route it may be in an overnight gap or on another route, and
  // setActive's clamp cannot help because the active route is not changing — so
  // this does the clamping itself, to the same rule.
  function setTimeScope(scope) {
    if (state.timeScope === scope) return;
    state.timeScope = scope;
    if (scope === "route" && state.moment != null) {
      const span = timelineSpan();
      if (!span) state.moment = null;
      else state.moment = Math.min(Math.max(state.moment, span.from), span.to);
    }
    renderTimeline();
    applyFocus();
    refreshDerived();
  }

  // The bar's own scope control: two segments of one pill, Route and Ride.
  //
  // BOTH LABELS ARE ON SCREEN, WHICH IS THE THIRD SHAPE THIS HAS TAKEN. It was
  // one button reading "Whole ride" — the ACTION — and a rider glancing at it
  // saw the word "ride" and believed that was their scope. It became one button
  // reading its own STATE, which fixed that and left the other half of the
  // choice invisible. A pill says both and fills the one you are on. Ziad's
  // call, 2026-09-07.
  function renderTimeScope() {
    const set = $("time-scope");
    if (!set) return;
    const onRoute = state.timeScope === "route";
    set.querySelectorAll(".time-seg").forEach((seg) => {
      const on = (seg.dataset.scope === "route") === onRoute;
      // aria-pressed on each segment rather than aria-checked on a radiogroup:
      // these are two toggles, and a radiogroup promises arrow-key roving this
      // bar does not implement.
      seg.setAttribute("aria-pressed", String(on));
      seg.classList.toggle("is-on", on);
      seg.title =
        seg.dataset.scope === "route"
          ? "The slider covers the " + W("route") + " you are editing"
          : "The slider covers the whole " + W("journey");
    });
    // Nothing to widen to on a single-route ride, and a control that returns the
    // same slider does nothing. Hidden rather than disabled: it is in a one-line
    // bar where a dead control is pure noise.
    set.hidden = state.routes.length < 2;
  }

  // #229's fuel ring toggle. Mirrored by the same function in viewer.js; the two
  // surfaces hold the flag in their own state and there is nothing to share but
  // four lines of labeling.
  //
  // HIDDEN WHEN THERE IS NO RING TO TALK ABOUT: a rider with no bike on file has
  // no range, and a control that does nothing is worse than no control.
  function renderRingToggle() {
    const btn = $("range-ring");
    if (!btn) return;
    btn.hidden = rangeM() == null;
    if (btn.hidden) return;
    btn.textContent = "Range";
    btn.title = state.ringOn ? "Hide the " + W("fuel") + " range" : "Show the " + W("fuel") + " range";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-pressed", String(state.ringOn));
  }

  // Every route's times, because every route's fields are on screen. It was one set
  // of ids reading whichever route the slider had selected.
  function renderTimes() {
    state.routes.forEach((_, r) => renderRouteTimes(r));
  }

  function renderRouteTimes(r) {
    const route = state.routes[r];
    const sec = routeSection(r);
    if (!route || !sec) return;
    const start = sec.querySelector(".route-start");
    const end = sec.querySelector(".route-end");
    const note = sec.querySelector(".route-times-note");
    if (!start || !end || !note) return;
    // Never fight the rider for a field they are in. refreshDerived() runs on
    // every keystroke elsewhere in the panel, and rewriting a datetime input
    // mid-edit resets the caret to the month segment.
    if (document.activeElement === start || document.activeElement === end) return;

    start.value = isoToLocalInput(route.startAt);
    end.value = isoToLocalInput(route.endAt);
    // Without a start there is nothing to derive an end from, and a lone end
    // would be a time the timeline cannot place.
    end.disabled = !route.startAt;

    if (!route.startAt) {
      // The second half of this used to live in the timeline's readout, back when
      // the timeline sat in the panel and stayed visible-but-disabled without
      // dates. The bar hides itself now, so the hint has to be somewhere a rider
      // will see it — and beside the field that fixes it is a better place than
      // under a slider that has gone gray.
      note.textContent = route.endAt ? "add a start time to work the end out" : "add a start time to scrub the ride";
      return;
    }
    if (route.endManual) {
      note.textContent = "end set by hand";
    } else {
      note.textContent = routeTotals(route).estimated
        ? "end estimated from the " + W("route")
        : "end from the " + W("route");
    }
  }

  // --- Panel: list + totals -------------------------------------------------

  // ONE ICON'S FOOTPRINT, WHATEVER THE ROLE COUNT. It used to join one 16px chip
  // per role, so the control was roughly 18n + 10 wide — about 316px of a 320px row
  // at all seventeen, with the name field paying for it.
  //
  // The shape is the first role's icon at full size plus a count; roles are capped
  // at 4, so the badge never exceeds "+3". Stacking and a quarter-scale 2x2 grid
  // both lose legibility at 16px, which is the size that matters.
  //
  // Every role's name still reaches the rider through the button's title.
  function roleIconsHtml(point) {
    const roles = (point.roles || []).filter((r) => window.TB.roles[r]);
    if (!roles.length) return "";
    const meta = window.TB.roles[roles[0]];
    const extra = roles.length - 1;
    return (
      '<span class="role-chip tb-inline-icon" data-icon="' +
      esc(meta.icon) +
      '"></span>' +
      (extra > 0 ? '<span class="role-more">+' + extra + "</span>" : "")
    );
  }

  // Every role a point carries, in words, for the icon button's tooltip. The
  // button shows one icon and a count; this is where the rest of the answer
  // lives without costing any width.
  function roleTitle(point) {
    const names = (point.roles || []).map((r) => window.TB.roles[r] && window.TB.roles[r].title).filter(Boolean);
    return names.length ? names.join(", ") : "Categories";
  }

  // Mirrors faqLink() in src/views/layout.ts, for the panel markup this file builds
  // itself.
  //
  // Used once, on the twistiness label. It was briefly on the role picker and came
  // straight back out: .row-roles renders for every point row, so one link there is
  // two hundred identical links on a long ride, explaining a picker that already
  // labels all seventeen options in words.
  const faqLink = (anchor, what) =>
    '<a class="faq-link" href="/faq#' +
    anchor +
    '" target="_blank" rel="noopener"' +
    ' title="What is ' +
    esc(what) +
    '?" aria-label="What is ' +
    esc(what) +
    '? Opens the questions page in a new tab">?</a>';

  const rolesAreOpen = (r, i) => !!state.rolesOpen && state.rolesOpen.route === r && state.rolesOpen.i === i;

  function rolePickerHtml(point) {
    return Object.keys(window.TB.roles)
      .map((r) => {
        const meta = window.TB.roles[r];
        const on = (point.roles || []).includes(r);
        return (
          '<button type="button" class="role-opt' +
          (on ? " on" : "") +
          '" data-role="' +
          r +
          '" aria-pressed="' +
          on +
          '">' +
          '<span class="tb-inline-icon" data-icon="' +
          esc(meta.icon) +
          '"></span><span>' +
          esc(meta.title) +
          "</span></button>"
        );
      })
      .join("");
  }

  function hydrateIcons(scope) {
    scope.querySelectorAll(".tb-inline-icon[data-icon]").forEach((span) => {
      window.TBMap.iconSvg(span.getAttribute("data-icon")).then((svg) => {
        if (svg) span.innerHTML = svg;
      });
    });
  }

  // SIX BUTTONS BECAME TWO: the row carried up, down, notes and delete beside the
  // role button and now carries a grip and one menu. `.row-actions` was 80px of a
  // 320px row, and most of it goes back to the name field.
  //
  // BOTH KINDS DRAG, and they mean different things by it — a stop reorders the
  // route, a POI moves its pin onto the road between the rows it was dropped
  // between. Same affordance, because from the rider's side it is the same intent.
  // data-route is what makes every handler below route-agnostic.
  /**
    * "End the route here?" on a mid-route point tagged as somewhere you sleep.
    *
    * #54 asks for the route to end there outright. It OFFERS instead, Ziad's call
    * 2026-08-31, because the tag cannot tell the two cases apart: a hotel you sleep
    * at and one you ride past are the same `hotel` role. The cost of offering is one
    * dismissed prompt; the cost of not offering is a ride reorganized behind
    * somebody's back.
    *
    * NOT SHOWN ON THE LAST POINT OF A ROUTE, where lodging normally goes — which is
    * also what stops this appearing on every route of a well-planned ride.
    *
    * A button rather than a toast: a toast disappears, and this should wait until
    * the rider has decided.
    */
  /**
    * The band that says the riding route should end about here.
    *
    * A BANNER ACROSS THE LIST, NOT A BUTTON ON A ROW. Ziad's call, 2026-09-03: a
    * small control tucked under one row is a decoration, and this has to be an
    * interruption — the point where the route stops being a good idea. It carries
    * the hour, how far in that is, and what to do about it.
    *
    * INSIDE THE ROW ELEMENT rather than as a sibling `<li>`: the point list is a
    * Sortable container and every non-draggable child has to be accounted for
    * (#166). The handler reads the DRAGGABLE pair so it would survive, but a band
    * that cannot be a sibling cannot be miscounted at all.
    *
    * ON THE ROW BEFORE THE MOMENT: the useful place to be told is the last point
    * you pass BEFORE the hour comes up. ONE PER ROUTE, because the moment is one
    * moment.
    */
  function bedtimeOfferHtml(i, routeIndex) {
    const entry = stopByPoints().find((e) => e.routeIndex === routeIndex);
    if (!entry || entry.atPoint !== i) return "";
    const route = state.routes[routeIndex];
    const over = routeElapsedS(route) - entry.offsetS;
    return (
      '<div class="bedtime-band">' +
      '<span class="bedtime-band-fact">' +
      esc(fmtClockMin(state.meta.stopByMin)) +
      SEP +
      esc(fmtDist(entry.distM)) +
      " in" +
      // WHAT IS LEFT AFTER IT, which is the number that says whether this is a
      // gentle nudge or a route that badly overruns. Omitted when the route ends
      // within the hour anyway, where "0h 12m still to ride" is noise.
      (over > 3600 ? SEP + esc(hm(over)) + " still to go" : "") +
      "</span>" +
      '<button type="button" class="row-bedtime-btn" data-route="' +
      routeIndex +
      '">Find somewhere to stay</button>' +
      "</div>"
    );
  }

  function lodgingOfferHtml(point, i, routeIndex) {
    const route = state.routes[routeIndex];
    if (!route || !SPLIT.canSplitAt(route, i)) return "";
    const roles = point.roles || [];
    if (!LODGING_ROLES.some((r) => roles.indexOf(r) >= 0)) return "";
    return (
      '<div class="row-lodging-offer">' +
      '<button type="button" class="row-split-offer" data-route="' +
      routeIndex +
      '" data-i="' +
      i +
      '">' +
      "Sleeping here? End the route" +
      "</button></div>"
    );
  }

  /**
    * How far into the route this point is, and how far it is on the current tank.
    *
    * #220, in the planner's words: "to know when to add fuel stops I need to know
    * how many miles since the start, and how many since the last fuel stop."
    *
    * NOTHING ON THE FIRST POINT — zero miles into a route it has not started is a
    * row of noise on every route in the ride.
    *
    * THE SINCE-FUEL FIGURE IS SHOWN ONLY WHEN IT DIFFERS from the distance into the
    * route: before the first fuel stop the two are the same number and printing it
    * twice reads as a rendering fault.
    *
    * The dry marker is absent entirely when no range is on file — never a zero,
    * never a guess.
    */
  function distReadoutHtml(point, i, dist) {
    if (!dist || i <= 0) return "";
    const into = dist.cum[i];
    if (!(into > 0)) return "";
    const since = dist.since[i];
    const dry = dist.dryAt === i;
    const range = window.TB.range || {};
    const parts = ['<span class="row-dist-into">' + esc(fmtDist(into)) + " in</span>"];
    // Rounded before comparing, or two figures a mile apart print identically
    // and the row looks like it is repeating itself.
    //
    // AND NEVER ZERO. At a fuel stop `since` resets to 0 by design — the tank is
    // full and the row is answering how far the NEXT one is — so the pair here
    // differs and would print "0 mi on this tank" under every fuel stop in the
    // ride. True, and noise.
    if (Math.round(since) > 0 && Math.round(since) !== Math.round(into)) {
      parts.push('<span class="row-dist-fuel">' + esc(fmtDist(since)) + " on this " + esc(W("tank")) + "</span>");
    }
    if (dry) {
      // Names WHOSE tank, because on a group ride the binding range belongs to
      // somebody in particular and "you will run out" is the wrong sentence to
      // show the rider with the big tank. See groupRange().
      const whose = range.riderName
        ? esc(range.riderName) + "\u2019s " + esc(range.bikeLabel || W("vehicle"))
        : "the smallest " + esc(W("tank"));
      parts.push(
        '<span class="row-dist-dry" data-tip="row-dist-dry" title="Past ' +
          whose +
          " (" +
          esc(String(range.miles)) +
          " mi). Add a " +
          esc(W("fuel")) +
          ' stop before here.">out of range</span>',
      );
    }
    return '<div class="row-dist"' + (dry ? ' data-dry="1"' : "") + ">" + parts.join("") + "</div>";
  }

  /**
    * "VMCSC split off here → Santa Cruz", on the row of the stop they left at.
    *
    * THE PEEL-OFF ROUTE IS AT THE BOTTOM OF THE LIST AND THIS IS WHAT MAKES THAT
    * READABLE. Its position is a correctness constraint rather than a choice —
    * `resolveRouteRiders` is a linear walk, so a route spliced in beside the cut
    * poisons everything after it — which leaves the group's road a long way from
    * the stop they left at.
    *
    * **A SPLIT IS RIDERS LEAVING, AND GEOMETRY CANNOT TELL IT FROM A MEET.** This
    * gated on shape alone — a tagged non-main route whose first point is this one —
    * which is ALSO what `cutJoiningTails()` leaves at a MEETING point. A ride where
    * three groups converged and nobody split read "VMCSC splits off here" at its
    * two JOIN points. Reported on stage 2026-09-07.
    *
    * The gate is `riderJunctions()` instead: who is on this road and not on the one
    * that follows it. Geometry still NAMES the group, matched on coordinates —
    * `splitRouteAt` mints a fresh uid and records no link back, so this can name the
    * wrong group at a duplicated stop, which is the cheap end of getting it wrong.
    *
    * **ON THE LAST POINT OF A ROUTE AND NOWHERE ELSE**, which keeps it to one line
    * per split: the stop exists on three routes afterwards, and rendering wherever
    * the coordinates matched turned three splits into eight lines on ride 34.
    *
    * The consequence to state rather than treat as a bug: a split at the ride's very
    * first point has no route ending there, so it gets no line.
    */
  function splitOffHtml(point, i, routeIndex) {
    const route = state.routes[routeIndex];
    if (!route || i !== route.points.length - 1) return "";
    const rr = state.routeRiders;
    const mine = rr && route.uid && rr.byUid[route.uid];
    // Null until the resolution loads, and null for a route the server has not
    // seen yet — a split's own two routes, until its save lands. Drawing nothing
    // is the honest state: whether anybody left is exactly what is not known.
    if (!mine) return "";
    // WHO IS ON THIS ROAD AND NOT ON THE ONE THAT FOLLOWS IT. The junction is
    // reported AT the following route, so it is read at this route's position
    // plus one — server positions, not indexes into state.routes, because an
    // inactive alternate sits in the array and not in the numbering.
    const junction = (rr.junctions || []).find((j) => j.position === mine.position + 1);
    const leavers = new Set((junction && junction.left) || []);
    if (!leavers.size) return "";
    const mainUid = state.meta.subgroups[0] && state.meta.subgroups[0].uid;
    const here = (d) => {
      const first = d.points[0];
      return first && first.lat === point.lat && first.lng === point.lng;
    };
    const left = ALT.activeRoutes(state.routes).filter((d) => {
      if (!d.subgroupUid || d.subgroupUid === mainUid || d === route || !here(d)) return false;
      // And it has to be a road one of the LEAVERS actually took. Without this a
      // meet's leftover tail — tagged, starting here, riders unchanged — is named
      // as the group that left, which is the bug this whole gate exists for.
      const on = rr.byUid[d.uid];
      return !!on && on.riderIds.some((id) => leavers.has(id));
    });
    if (!left.length) return "";
    // A REAL BUTTON THAT GOES THERE, not a colored sentence. The peel-off route
    // is at the bottom of the list by construction, which is the whole reason
    // this line exists — so the line has to be the way to it, and $signal text
    // that cannot be pressed is the exact thing #232 established a map dot must
    // not be. Keyed by uid because the index changes on every later split.
    return left
      .map((d) => {
        const g = subgroupByUid(d.subgroupUid);
        const dest = d.points[d.points.length - 1];
        const to = d.points.length > 1 && dest.name ? " → " + esc(dest.name) : "";
        const name = esc((g && g.name) || "A group");
        return (
          '<button type="button" class="row-splitoff" data-splitoff="' +
          esc(d.uid) +
          '" data-tip="row-splitoff" title="Go to their route">' +
          name +
          " splits off here" +
          to +
          "</button>"
        );
      })
      .join("");
  }

  // `n` is the row's stop number, or null for a POI — worked out by orderedRows()
  // because it counts stops only and `i` indexes the whole list.
  function pointRowHtml(kind, point, i, routeIndex, n, dist) {
    const isStop = kind === "stop";
    return (
      '<li class="point-row" data-kind="' +
      kind +
      '" data-i="' +
      i +
      '" data-route="' +
      routeIndex +
      '" data-uid="' +
      esc(point.uid || "") +
      '">' +
      '<div class="row-main">' +
      // Both kinds reorder now — a POI has a place in the list of its own, so there is
      // one gesture with one meaning.
      //
      // A REAL <button> WITH ARROW KEYS, which carries the two properties Move up /
      // Move down used to: a keyboard path, and reordering that still works when the
      // SortableJS CDN does not. `.route-drag` and `.sg-drag` are already this, which
      // is why neither of their menus carries move items either.
      '<button type="button" class="row-drag" data-tip="row-drag" title="Drag to reorder, or focus and use the arrow keys"' +
      ' aria-label="Reorder ' +
      esc(point.name || "this point") +
      '"></button>' +
      // THE CHECKBOX REPLACES THE NUMBER rather than joining it. A 380px row has
      // no spare width and .row-name is already the thing that shrinks; the stop
      // number is the one element that is redundant while you are ticking boxes,
      // because ticking is what you are doing rather than reading an order. It
      // comes straight back when select mode ends.
      (state.select?.scope === "point"
        ? '<input type="checkbox" class="row-pick" data-route="' +
          routeIndex +
          '" data-kind="' +
          kind +
          '" data-i="' +
          i +
          '"' +
          (state.select.points.has(pointKey(routeIndex, kind, i)) ? " checked" : "") +
          ' aria-label="Select ' +
          (isStop ? "stop " + n : "POI") +
          '">'
        : isStop
          ? '<span class="row-num">' + n + "</span>"
          : '<span class="row-num poi-dot"></span>') +
      '<input class="row-name" data-tip="row-name" title="Type to rename, or search for a different place" name="' +
      kind +
      "-name-" +
      i +
      // data-1p-ignore for the reason spelled out on .route-title in
      // routeSectionHtml, and this is the strongest case of the three: the field
      // is called `stop-name-0`, so a password manager has both a label and a
      // name attribute telling it this is somebody's name.
      '" type="text" maxlength="255" autocomplete="off" data-1p-ignore placeholder="' +
      (isStop ? "Stop name" : "POI name") +
      '" value="' +
      esc(point.name) +
      '">' +
      // POIs get the same dwell field. Blank means "rode past without stopping", which
      // is why it stays a placeholder rather than a zero.
      //
      // TYPE="TEXT", not "number", which is the price of the format being a
      // preference: "1h 30m" is not a number, and switching the input's type per format
      // would be three code paths through every read and write. `inputmode` gets the
      // phone keyboard right instead. The stored value is still an integer of minutes.
      '<input class="row-dur" name="' +
      kind +
      "-duration-" +
      i +
      '" type="text" autocomplete="off" inputmode="' +
      DUR.inputMode(durFormat) +
      '" placeholder="' +
      esc(DUR.placeholder(durFormat)) +
      '" data-tip="row-dur" title="' +
      (isStop ? "Stop duration" : "How long you stop here, if you stop") +
      " (" +
      esc(DUR.unitName(durFormat)) +
      ')" value="' +
      esc(DUR.format(point.durationMin, durFormat)) +
      '">' +
      '<button type="button" class="row-roles-btn" data-tip="row-roles" title="' +
      esc(roleTitle(point)) +
      '" aria-label="Categories">' +
      // Empty rather than a "+" glyph: the dot IS the affordance and it is drawn
      // in CSS, so there is nothing to read here. aria-hidden because the button
      // already carries its own label.
      (roleIconsHtml(point) || '<span class="role-add" aria-hidden="true"></span>') +
      "</button>" +
      '<span class="row-actions">' +
      // U+22EE, the VERTICAL ellipsis, not U+22EF. It is the same control and
      // roughly a third of the width, which on a 320px row is width the name
      // field gets instead.
      // Shown only when something is filled in, so a rider can see at a glance
      // which stops carry a reservation without opening every row. Not a button:
      // the row menu is how the panel opens, and a second affordance for the same
      // thing on a 320px row costs width the name field needs.
      (hasDetails(point.details)
        ? '<span class="row-detail-flag" data-tip="row-detail-flag" title="Has reservation details" aria-label="Has reservation details">\u2731</span>'
        : "") +
      '<button type="button" class="row-menu-btn" data-tip="row-menu" title="More" aria-label="More actions for this ' +
      (isStop ? "stop" : "POI") +
      '" aria-haspopup="menu" aria-expanded="false">⋮</button>' +
      "</span></div>" +
      distReadoutHtml(point, i, dist) +
      bedtimeOfferHtml(i, routeIndex) +
      lodgingOfferHtml(point, i, routeIndex) +
      '<div class="row-roles"' +
      (rolesAreOpen(routeIndex, i) ? "" : " hidden") +
      ">" +
      rolePickerHtml(point) +
      "</div>" +
      splitOffHtml(point, i, routeIndex) +
      // A note that has been written stays visible on the row. The textarea moved
      // into the details panel, so without this a rider's own note would be
      // behind a menu item and two clicks away — and a note is the kind of thing
      // you write in order to see it while planning. Read-only, one line,
      // ellipsised: pressing it is what the panel is for.
      (point.description
        ? '<p class="row-note" title="' + esc(point.description) + '">' + esc(point.description) + "</p>"
        : "") +
      // TWO NOTES BOXES, ONE PANEL, AND THE SPLIT INSIDE IT IS LOAD-BEARING.
      // `.row-desc` writes `point.description`, which is PUBLIC — payload, ride.json,
      // every export. `.detail-body` holds the owner-only box writing
      // `point_details.notes`.
      //
      // The public one is OUTSIDE `.detail-body` because that body is re-rendered on
      // its own whenever a link is added or removed, and it used to be the WHOLE panel
      // — so a rider typing a note who pressed Add link lost it. #188 from inside the
      // details panel.
      //
      // A role change goes through renderRouteList(), which rebuilds the row and closes
      // the panel; nothing is lost there because `input` has already written the note.
      '<div class="row-details" hidden>' +
      '<label class="detail-field detail-desc"><span>Notes everyone on the ride can see</span>' +
      '<textarea class="row-desc" name="' +
      kind +
      "-notes-" +
      i +
      '" maxlength="2000" placeholder="Where to park, what the turn looks like, why we are stopping">' +
      esc(point.description) +
      "</textarea></label>" +
      '<div class="detail-body">' +
      detailsHtml(point, kind, i) +
      "</div>" +
      "</div>" +
      "</li>"
    );
  }

  // The private half of a stop: reservations, codes, check-in, links, notes.
  //
  // Fields are chosen by role, so a gas stop does not present a check-out time. The
  // block is `hidden` until opened from the row menu — a panel of empty inputs
  // under every row would bury the ride.
  //
  // Every input carries `data-field` and one delegated handler writes whichever
  // changed, rather than a handler per field.
  const DETAIL_LABELS = {
    confirmation: "Confirmation number",
    checkInAt: "Check in",
    checkOutAt: "Check out",
    phone: "Phone",
    address: "Address",
  };

  // datetime-local wants "YYYY-MM-DDTHH:MM" and the value is stored as an ISO
  // string with an offset. Sliced rather than round-tripped through a Date, which
  // would re-interpret it in the browser's zone and shift it.
  // A check-in is a wall clock in a place, exactly like a route's start — see
  // route-clock.js. This used to slice while the WRITE path attached the browser's
  // offset, so a 3pm check-in typed in California was stored as 22:00 and read back
  // as 10pm. Both ends go through the same module now.
  const toLocalInput = (iso) => window.TBRouteClock.isoToInput(iso);

  function detailsHtml(point, kind, i) {
    const d = point.details || blankDetails();
    const fields = detailFieldsFor(point.roles);
    let out = '<div class="detail-grid">';
    for (const f of fields) {
      if (f === "notes" || f === "links") continue;
      const isTime = f === "checkInAt" || f === "checkOutAt";
      out +=
        '<label class="detail-field"><span>' +
        esc(DETAIL_LABELS[f]) +
        "</span>" +
        '<input type="' +
        (isTime ? "datetime-local" : f === "phone" ? "tel" : "text") +
        '"' +
        ' data-field="' +
        f +
        '"' +
        ' name="' +
        kind +
        "-" +
        f +
        "-" +
        i +
        '"' +
        (isTime ? "" : ' maxlength="' + (f === "confirmation" ? 120 : f === "phone" ? 40 : 300) + '"') +
        ' autocomplete="off" value="' +
        esc(isTime ? toLocalInput(d[f]) : d[f] || "") +
        '"></label>';
    }
    out += "</div>";

    out += '<div class="detail-links">';
    (d.links || []).forEach((l, n) => {
      out +=
        '<div class="detail-link" data-link="' +
        n +
        '">' +
        '<input type="text" data-field="linkLabel" maxlength="60" placeholder="Label" value="' +
        esc(l.label || "") +
        '">' +
        '<input type="url" data-field="linkUrl" maxlength="500" placeholder="https://" value="' +
        esc(l.url || "") +
        '">' +
        '<button type="button" class="detail-link-del" aria-label="Remove link">\u00d7</button>' +
        "</div>";
    });
    out +=
      '<button type="button" class="detail-link-add"' +
      ((d.links || []).length >= MAX_LINKS ? " disabled" : "") +
      ">Add link</button></div>";

    out +=
      // "Only you" rather than "Private", because the box above it in this same
      // panel is also a notes box and the whole difference between them is who
      // reads it. A label that names the audience answers that where one naming
      // the sensitivity leaves the rider to infer it.
      '<label class="detail-field detail-notes"><span>Notes only you can see</span>' +
      '<textarea data-field="notes" maxlength="2000" placeholder="Gate code, confirmation number, who to ask for">' +
      esc(d.notes || "") +
      "</textarea></label>";

    // Stated on the surface rather than only in the code, because a rider
    // deciding whether to type a door code into a web app is entitled to know
    // where it goes. It is also true — see canSeeDetails in
    // src/maps/point-details.ts.
    out +=
      '<p class="detail-privacy">Only you can see this. It stays out of shared links and every export except your own backup.</p>';
    return out;
  }

  // Reads the row's OWN route, not the active one. Those are the same thing by the
  // time a handler runs — every listener calls setActiveFromEl first — but
  // relying on that ordering would make this quietly wrong the first time
  // something read a row without having clicked it.
  function pointOf(row) {
    const i = Number(row.dataset.i);
    const route = state.routes[Number(row.dataset.route)];
    if (!route) return null;
    return route.points[i];
  }

  // Stops and POIs in the order you would meet them.
  //
  // ONE INDEX SPACE: a row's `data-i` indexes route.points whatever its kind, so
  // pointOf(), movePoint() and deletePoint() all take the same number.
  // THE ARRAY IS THE ORDER. This used to interleave two arrays by projecting the
  // POIs onto the track and sorting — which had no answer at all before a route
  // existed, so every POI on a fresh route reported distance 0.
  //
  // `n` is the stop number a row displays, or null for a POI. It counts stops only,
  // so promoting renumbers everything after it with no logic of its own.
  function orderedRows(route) {
    let stopN = 0;
    return route.points.map((point, i) => ({
      kind: point.kind,
      point,
      i,
      n: point.kind === "stop" ? ++stopN : null,
    }));
  }

  // WHICH CATEGORY PUTS FUEL BACK IN, from the bike the plan is built around.
  // `gas` when nothing is known, because it is what all but a handful of bikes
  // take and the alternative is showing no fuel figures at all to every rider
  // who has not filled in a paddock.
  const fuelRole = () => (window.TB.range && window.TB.range.fuelType === "electric" ? "charge" : "gas");

  // The group's binding range in meters, or null when nobody on the ride has one
  // on file. NULL MUST STAY NULL all the way to the renderer — a fuel warning
  // built on an invented number is worse than none because it looks like one.
  function rangeM() {
    const mi = window.TB.range && window.TB.range.miles;
    // window.TB.range.miles is always MILES, whatever the rider's preference —
    // it comes off usable_range_m through metersToMiles server-side. Converting
    // it with the display unit here would read a metric rider's 300 km tank as
    // 300 miles.
    return typeof mi === "number" && mi > 0 ? mi * window.TBUnits.METERS_PER_MILE : null;
  }

  // Everything the rows of one route need to say how far in they are. Computed
  // once per render rather than per row: each of these walks the whole route, so
  // doing it inside pointRowHtml would make a 400-point route quadratic.
  function routeDistances(route) {
    const role = fuelRole();
    return {
      cum: DIST.cumulativeM(route),
      since: DIST.sinceRefuelM(route, role),
      dryAt: DIST.firstDryPoint(route, role, rangeM()),
    };
  }

  // One route's rows. Takes the route index rather than reading the active one,
  // because every route's list is on screen and any of them can need redrawing.
  function renderRouteList(r) {
    const list = document.querySelector('.point-list[data-route="' + r + '"]');
    if (!list) return;
    const route = state.routes[r];
    if (!route) return;
    const dist = routeDistances(route);
    list.innerHTML =
      orderedRows(route)
        .map(
          (row) =>
            // The gap ABOVE each row, so slot `i` means "before points[i]" and
            // the indices read the same way addPoint's `at` does. The gap below
            // the last row is the bottom add-row, which is always present, so no
            // slot is rendered for it.
            slotHtml(r, route, row.i, null) +
            pointRowHtml(row.kind, row.point, row.i, r, row.n, dist) +
            viaRowsHtml(r, route, row.i),
        )
        .join("") + addRowHtml(r, route);
    hydrateIcons(list);
  }

  // THE LAST ROW OF EVERY ROUTE IS A SEARCH FIELD, replacing a single box above
  // the whole list that had to guess which route you meant — and guessed the last
  // one you touched. Invisible until it is wrong: type an address on route 4 and it
  // lands on route 2. The row knows its own `data-route`.
  //
  // Rendered on every route whether or not it has points, so it is also the empty
  // state.
  //
  // NOT a .point-row: it has no point behind it, and wireList()'s handlers all
  // resolve a row to `state.routes[route].points[i]`. SortableJS is told to leave
  // it alone.
  // A hairline with a + in it, between two rows — Excel's "insert row here".
  // Rendered for every gap rather than on hover, because a control that only exists
  // under the pointer does not exist on a touch screen. Quiet enough at rest that
  // 30 of them read as row separators.
  // `via` names WHICH slot this is when several share an `at`: every slot in a
  // leg's stack inserts at the same index, so without a second key `state.insertAt`
  // could not tell them apart and one + opened a field in every gap on the leg.
  function insertSlotHtml(r, at, via) {
    const viaAttr = via == null ? "" : '" data-via="' + via;
    return (
      '<li class="insert-slot" data-route="' +
      r +
      '" data-at="' +
      at +
      viaAttr +
      '">' +
      '<button type="button" class="insert-btn" data-route="' +
      r +
      '" data-at="' +
      at +
      viaAttr +
      '"' +
      ' data-tip="insert-slot" title="Add a point here" aria-label="Add a point above point ' +
      (at + 1) +
      '">+</button>' +
      "</li>"
    );
  }

  // One gap: the hairline, or the search field when this is the gap the rider
  // opened. Every gap in a route goes through it so the two states cannot be
  // rendered by two different pieces of arithmetic.
  function slotHtml(r, route, at, via) {
    const open = state.insertAt;
    const isOpen = open && open.route === r && open.at === at && (open.via == null ? via == null : open.via === via);
    return isOpen ? addRowHtml(r, route, at) : insertSlotHtml(r, at, via);
  }

  /**
    * The shaping points on one leg, as their own rows under the point they follow.
    *
    * A SHAPING POINT IS NOT A POINT, and these rows exist because it is also not
    * invisible. A via stays out of `route.points`, out of the numbering and out of
    * every arithmetic that walks the route. What it gained on 2026-09-04 is a row,
    * because "I dragged the route onto 25 and nothing appeared in the pane" is what
    * a feature whose only surface is a map dot costs.
    *
    * NOT A `.point-row`, AND THAT IS LOAD-BEARING IN THREE PLACES: wireList()'s
    * handlers resolve a row to `state.routes[route].points[i]`; SortableJS is told
    * to leave it alone; and #166 — the list's raw child indices already run at 2n+1,
    * so these add children the drag arithmetic cannot see.
    *
    * `legs[i]` joins `points[i]` to `points[i+1]`, so a leg's vias render below the
    * point they leave.
    */
  function viaRowsHtml(r, route, i) {
    const vias = (route.legs[i] && route.legs[i].viaPoints) || [];
    if (!vias.length) return "";
    return vias
      .map(
        (v, vi) =>
          // THE SAME GAP THE POINT ROWS GET, above each one. Ziad's call,
          // 2026-09-04: the stack reads as one list or it reads as two, and a
          // shaping point is a place on the road like any other row here. Every
          // one of these inserts at `i + 1` — the point after the leg — because
          // a stop dropped anywhere along that leg goes in at the same index;
          // `vi` is what tells the slots apart in state.insertAt.
          slotHtml(r, route, i + 1, vi) +
          '<li class="via-row" data-route="' +
          r +
          '" data-leg="' +
          i +
          '" data-via="' +
          vi +
          '">' +
          '<span class="via-mark" aria-hidden="true"></span>' +
          // NO NAME AND NO NUMBER, because it has neither. What it can honestly
          // say is which of a leg's shaping points it is, and only when there is
          // more than one to tell apart.
          '<span class="via-name">Shaping point' +
          (vias.length > 1 ? " " + (vi + 1) : "") +
          "</span>" +
          '<button type="button" class="via-del" data-route="' +
          r +
          '" data-leg="' +
          i +
          '" data-via="' +
          vi +
          '" data-tip="via-del" title="Remove this shaping point"' +
          ' aria-label="Remove shaping point' +
          (vias.length > 1 ? " " + (vi + 1) : "") +
          " after point " +
          (i + 1) +
          '">&times;</button>' +
          "</li>",
      )
      .join("");
  }

  // `at` is the slot this row inserts into, or undefined for the route's own
  // bottom row, which appends. It rides on the element as data-at so every
  // handler below — search, chips, arm-a-map-click — reads it from one place
  // rather than each keeping its own copy of where the rider was.
  function addRowHtml(r, route, at) {
    const full = route.points.length >= MAX_POINTS;
    const slot = at == null ? "" : ' data-at="' + at + '"';
    return (
      '<li class="add-row' +
      (at == null ? "" : " is-insert") +
      '" data-route="' +
      r +
      '"' +
      slot +
      ">" +
      '<span class="add-row-mark" aria-hidden="true">+</span>' +
      '<input class="add-search" type="text" autocomplete="off" spellcheck="false"' +
      ' placeholder="' +
      (full ? "Point limit reached" : "Search, or click the map") +
      '"' +
      (full ? " disabled" : "") +
      ' aria-label="Add a place to ' +
      esc(routeLabel(r)) +
      '">' +
      // Arms the next map click for THIS route — see armPlace(). The armed state
      // is derived from state.arm rather than left on the element, because this
      // row is rebuilt on every structural change and a class living only in the
      // DOM would be lost by the next render.
      '<button type="button" class="add-place-btn' +
      (isArmed(r, at) ? " is-armed" : "") +
      '"' +
      ' data-route="' +
      r +
      '"' +
      slot +
      (full ? " disabled" : "") +
      ' aria-pressed="' +
      (isArmed(r, at) ? "true" : "false") +
      '"' +
      ' data-tip="map-add" title="' +
      (full ? "Point limit reached" : "Add a point to " + esc(routeLabel(r)) + " by clicking the map") +
      '">' +
      "+ Point</button>" +
      chipsHtml(r, full, at) +
      "</li>"
    );
  }

  // The categories worth one tap, and nothing more.
  //
  // Four, not seventeen: fuel, a meal, a bed, coffee. A row of seventeen chips
  // would be a worse version of typing the word, and everything else reaches the
  // same search through the box.
  //
  // Each chip carries the ROLE, so a picked result arrives already tagged — the
  // alternative is finding the station and then opening the row menu to say it is
  // a gas station.
  const CHIPS = [
    { role: "gas", label: Wc("fuel"), query: "gas station" },
    { role: "food", label: "Food", query: "restaurant" },
    { role: "coffee", label: "Coffee", query: "coffee shop" },
    { role: "hotel", label: "Lodging", query: "hotel" },
  ];

  // HOW FAR OFF THE ROUTE IS WORTH IT, in MILES — always miles, whatever unit the
  // rider reads, because the value is compared against meters through one
  // conversion.
  //
  // A CONSTANT AND NOT A CONTROL, as of 2026-08-31. It shipped as a slider beside
  // the toggle and was rejected on sight: the corridor width is a preference, not a
  // per-search decision, and asking every time put two controls in front of a
  // question the rider had answered by tapping a chip. Fifteen miles is about
  // twenty minutes there and back. If it ever moves it belongs in ride preferences.
  const CORRIDOR_MI = 15;

  // Whether the last corridor search covered the whole route or left gaps between
  // its circles. Read by nearbyResultsHtml() — see MAX_CORRIDOR_SAMPLES for why
  // a long enough route still cannot be covered in one press.
  let corridorPartial = false;

  // The ceiling on how many Places calls one chip tap may spend. Text Search is
  // billed per request, so this is a money number.
  //
  // TWELVE, NOT SIX, since 2026-09-03, and the count is DERIVED from it rather than
  // always spent — so short routes got CHEAPER: a 40-mile route spends two searches
  // where it used to spend six.
  //
  // Six was chosen when the radius was believed to grow with the route. It does not
  // — the proxy caps it at 50 km — so six left 37-mile holes in a 593-mile route and
  // answered "no gas between Burbank and Anaheim". Twelve covers about 745 miles;
  // past that samplesCoverAll() reports false and the panel says so.
  const MAX_CORRIDOR_SAMPLES = 12;

  /** What a chip promises. A slot chip searches its own leg whichever scope is
   *  selected, so it names that rather than the scope — see the chip handler. */
  function chipTitle(c, isSlot) {
    const what = c.label.toLowerCase();
    if (isSlot) return "Find " + what + " along this leg";
    return "Find " + what + (state.corridorOn ? " anywhere along this route" : " on the part of the map you can see");
  }

  function chipsHtml(r, full, at) {
    if (full) return "";
    const slot = at == null ? "" : ' data-at="' + at + '"';
    return (
      '<div class="add-chips" role="group" aria-label="Find nearby">' +
      CHIPS.map(
        (c) =>
          '<button type="button" class="chip" data-route="' +
          r +
          '" data-chip="' +
          c.role +
          '"' +
          slot +
          ' title="' +
          esc(chipTitle(c, at != null)) +
          '">' +
          esc(c.label) +
          "</button>",
      ).join("") +
      "</div>" +
      // ONCE PER DAY, ON THE DAY'S OWN BOTTOM ROW — never on an insert slot.
      // The scope is one session-wide flag, so a copy in every add-row meant a
      // six-point route drawing seven of them and a handler hand-syncing the lot
      // on every change. One control cannot disagree with itself.
      (at == null ? corridorHtml(r) : "")
    );
  }

  /**
    * #50's search scope: near the last point, or along the whole route.
    *
    * TWO NAMED STATES, NOT A CHECKBOX AND A SLIDER. Both are always on screen, so
    * the control says what it does rather than what it is not doing — a checkbox
    * labeled "Along the route" never says what unchecking it means.
    *
    * NEAR HERE IS THE DEFAULT, so the chips keep answering what is near where I have
    * got to. The other scope is a different question rather than a wider version of
    * the same one.
    *
    * The width it searches is CORRIDOR_MI and there is no control for it.
    */
  function corridorHtml(r) {
    const on = state.corridorOn;
    const opt = (along, label, title) =>
      '<button type="button" class="scope-btn' +
      (on === along ? " is-on" : "") +
      '"' +
      ' data-route="' +
      r +
      '" data-along="' +
      (along ? "1" : "0") +
      '"' +
      ' aria-pressed="' +
      (on === along ? "true" : "false") +
      '" data-tip="scope-btn" title="' +
      esc(title) +
      '">' +
      esc(label) +
      "</button>";
    const width = Math.round(window.TBUnits.distanceFromMiles(CORRIDOR_MI, UNITS)) + " " + distUnit;
    return (
      '<div class="add-corridor" role="group" aria-label="Where to search">' +
      opt(false, "On screen", "Search the part of the map you can see") +
      opt(true, "Along the route", "Search the whole route, within " + width + " of the route") +
      "</div>"
    );
  }

  // Kept under its old name for the ~15 callers that mean "redraw what I just
  // changed". They all edit the active route, which is the route they are called
  // from — a row handler sets it before doing anything else.
  function renderList() {
    const r = activeIndex();
    if (r != null) renderRouteList(r);
  }

  // The route index is required now: every route's rows are on the page, so
  // [data-kind][data-i] alone matches one row per route and would scroll to
  // whichever came first.
  function focusRow(kind, i, routeIndex) {
    const r = routeIndex == null ? activeIndex() : routeIndex;
    const row = document.querySelector(
      '.point-row[data-route="' + r + '"][data-kind="' + kind + '"][data-i="' + i + '"]',
    );
    if (!row) return;
    // A row inside a shut route cannot be scrolled to, so open it first.
    const sec = row.closest(".route-section");
    if (sec && sec.classList.contains("is-shut")) {
      sec.classList.remove("is-shut");
      const twirl = sec.querySelector(".route-twirl");
      if (twirl) twirl.setAttribute("aria-expanded", "true");
    }
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    row.classList.add("flash");
    setTimeout(() => row.classList.remove("flash"), 900);
  }

  const hm = (secs) => {
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    return (h ? h + "h " : "") + m + "m";
  };

  function routeTotals(route) {
    return {
      meters: route.legs.reduce((n, l) => n + l.distanceM, 0),
      riding: route.legs.reduce((n, l) => n + legDurationS(l), 0),
      // Still computed although it is no longer displayed: routeElapsedS is
      // riding plus stopped, and every derived end time and the whole timeline
      // slider are built on it.
      stopped: routeStoppedS(route),
      estimated: routeIsEstimated(route),
      // Live rather than the value stored at last save, which would be stale the
      // moment a stop moves. window.TBTwist caches on the legs array, so this is
      // free until the router answers again.
      twist: routeTwistiness(route),
    };
  }

  function renderTotals() {
    const totalsEl = $("totals");
    // ANY POINT, not any stop. A route of POIs draws a road and has a mileage now,
    // so a ride made of them has totals worth printing.
    const anyPoints = state.routes.some((r) => r.points.length > 0);
    if (!anyPoints) {
      totalsEl.textContent = "";
      return;
    }
    // "~" marks a riding figure that includes an estimated leg, so a number the
    // router never produced is never shown as though it had.
    //
    // Time stopped used to sit at the end of this line and no longer does: it is
    // a number nobody plans around, where what the road is actually like is. The
    // dwell figures still drive the end times and the timeline, they are just not
    // worth a slot in a 380px panel.
    const line = (t, withLink) =>
      window.TBUnits.distanceFrom(t.meters, UNITS).toFixed(1) +
      " " +
      distUnit +
      SEP +
      (t.estimated ? "~" : "") +
      hm(t.riding) +
      " " +
      W("travel") +
      (t.twist
        ? SEP +
          twistScale(twistRank(t.twist.dpm), twistLabel(t.twist.dpm), twistTitle(t)) +
          (withLink ? faqLink("twistiness", "twistiness") : "")
        : "");

    // The band's line and word on the readout; the numbers behind them on
    // hover. "252°/mi" means nothing to a rider, but it is the thing to check
    // when the rating looks wrong, so it should be reachable without being in
    // the way. Hoisted: `line` above reads it.
    function twistTitle(t) {
      if (!t.twist) return "";
      // CONVERTED FOR DISPLAY, LABELED FROM THE MILE FIGURE. The band the label
      // comes from is a threshold in degrees per MILE, so only the number moves —
      // see rollUpTwist() in src/stats/shape.ts.
      let s =
        Math.round(window.TBUnits.twistFrom(t.twist.dpm, UNITS)) +
        window.TBUnits.twistUnit(UNITS) +
        " of heading change";
      // Only worth saying when the best stretch is meaningfully better than the
      // route as a whole. On a uniformly twisty route it is the same number twice.
      if (t.twist.bestDpm && t.twist.bestDpm > t.twist.dpm * 1.25) {
        s +=
          ", best " +
          window.TBUnits.distanceFromMiles(t.twist.bestMiles, UNITS).toFixed(1) +
          " " +
          distUnit +
          " at " +
          Math.round(window.TBUnits.twistFrom(t.twist.bestDpm, UNITS));
      }
      return s;
    }

    // The routes that COUNT, everywhere below. A ride carrying two ways to do
    // Thursday is not twice as long, and this readout is the number a rider
    // watches change while they edit — it has to agree with what the server
    // stores on the next save, which is rideTotals() over the same filter.
    const counted = ALT.activeRoutes(state.routes);

    if (counted.length === 1) {
      const t = routeTotals(counted[0]);
      // innerHTML, not textContent: line() now carries the twistiness "?" link.
      // Nothing user-supplied reaches it — the mileage and the label are both
      // computed here — so there is no injection surface.
      totalsEl.innerHTML = line(t, true);
      totalsEl.title = twistTitle(t);
      // The tip key rides on the element that carries the title, which is the
      // readout itself here and the `.totals-ride` span below. The tour's
      // "that is a route" step anchors on this key, so it has to exist on a
      // one-route ride — which is every ride the tour is taken on.
      totalsEl.setAttribute("data-tip", "totals-ride");
      return;
    }
    totalsEl.removeAttribute("data-tip");

    // With several routes the ride total is the number that matters; the focused
    // route's own figures sit under it.
    //
    // The fold moved to TBAlt.rideRollup, which is the same file the server's
    // rule lives beside and, unlike an inline reduce, has tests — including the
    // one that pins the distance-weighted twistiness mean. Read it there for
    // why twistiness is weighted and why the best stretch is a max rather than
    // a sum.
    const ride = ALT.rideRollup(counted.map(routeTotals));
    // The per-route figures only exist when a route is selected. On "All" the ride
    // figures stand alone, which is exactly what "All" means — but the line that
    // would hold them is still emitted, empty. See below.
    const r = editIndex();
    const routeT = r == null ? null : routeTotals(state.routes[r]);
    totalsEl.title = "";
    totalsEl.innerHTML =
      '<span class="totals-ride" data-tip="totals-ride" title="' +
      esc(twistTitle(ride)) +
      '">' +
      // The count of routes that COUNT, not of sections on screen. A ride with
      // three routes and two alternates is a three-route ride, and saying "5 routes"
      // beside a mileage that only covers three would make both look wrong.
      counted.length +
      " " +
      (counted.length === 1 ? W("route") : Ws("route")) +
      SEP +
      line(ride, true) +
      "</span>" +
      // THE ROUTE LINE IS EMITTED EITHER WAY, empty on "All": it reserves its own line,
      // so the block is the same height whichever way the scrubber is set. Dropping the
      // span used to shift the panel on every scrub.
      //
      // Two spans rather than one string, so the stylesheet can shrink the name and
      // never the figures — a route title runs to 150 characters.
      '<span class="totals-route"' +
      (routeT ? ' title="' + esc(twistTitle(routeT)) + '"' : "") +
      ">" +
      (routeT
        ? '<span class="totals-route-name">' +
          esc(routeLabel(r)) +
          ":</span>" +
          '<span class="totals-route-figs">' +
          line(routeT, false) +
          "</span>"
        : "") +
      "</span>";
  }

  /**
    * Keep the row's read-only note line in step with the box being typed into.
    *
    * Both render from `point.description` but at different times, and a re-render
    * would reconcile them — which is exactly what must not happen here, because the
    * caret is in the textarea.
    *
    * Creates and removes the element rather than hiding it: an empty `<p>` would
    * take its own margin and put a gap under every row nobody has written on.
    */
  function syncRowNote(row, point) {
    const text = point.description || "";
    let el = row.querySelector(".row-note");
    if (!text) return el && el.remove();
    if (!el) {
      el = document.createElement("p");
      el.className = "row-note";
      row.insertBefore(el, row.querySelector(".row-details"));
    }
    el.textContent = text;
    el.title = text;
  }

  // The undo-coalesce key for one field on one row. Shared with replacePoint(),
  // which folds a pick into the typing that found it. It read `row.dataset.index`
  // until 2026-09-15 — an attribute no row carries — so every row's name field
  // coalesced into one step and renaming two stops was one undo.
  const rowEditKey = (kind, i, field) => "row:" + (kind || "") + ":" + i + ":" + field;

  // Delegated events for both lists.
  function wireList(listEl) {
    listEl.addEventListener("input", (e) => {
      const row = e.target.closest(".point-row");
      if (!row) return;
      const point = pointOf(row);
      if (!point) return;
      // Keyed by the row and the field, so a run of keystrokes folds into one
      // step and moving to another field starts a new one.
      beginEdit("edit stop", rowEditKey(row.dataset.kind, row.dataset.i, e.target.className));
      if (e.target.classList.contains("row-name")) point.name = e.target.value;
      if (e.target.classList.contains("row-desc")) {
        point.description = e.target.value;
        // PATCHED IN PLACE, NEVER RE-RENDERED. The preview line on the row is
        // built from the same value, so without this it holds whatever the note
        // said when the row was last drawn — and this handler cannot call
        // renderRouteList(), which would destroy the textarea being typed in and
        // drop focus to <body>. #188, and the same treatment togglePref uses.
        syncRowNote(row, point);
      }
      // The detail fields, all of them, through one branch. `data-field` is what
      // makes that possible — adding a field to detailsHtml needs nothing here.
      //
      // `details` is created lazily on the first keystroke rather than at row
      // build time: a stop nobody has typed into keeps `details: null`, which is
      // what the server reconciles as "no row", and what stops every stop in the
      // ride growing a detail row it does not need.
      const field = e.target.dataset && e.target.dataset.field;
      if (field) {
        if (!point.details) point.details = blankDetails();
        if (field === "linkLabel" || field === "linkUrl") {
          const n = Number(e.target.closest(".detail-link").dataset.link);
          const link = point.details.links[n];
          if (link) link[field === "linkLabel" ? "label" : "url"] = e.target.value;
        } else if (field === "checkInAt" || field === "checkOutAt") {
          // The digits the rider typed, carried as UTC. Attaching the BROWSER's
          // offset here is what the old version did, and it is the thing that
          // moved a 3pm check-in by seven hours.
          point.details[field] = window.TBRouteClock.inputToIso(e.target.value);
        } else {
          point.details[field] = e.target.value;
        }
        markDirty();
        return;
      }
      if (e.target.classList.contains("row-dur")) {
        // Parsed on every keystroke, reformatted on none of them. Rewriting the field as
        // it is typed is hostile in every format and breaks two: "1." becomes "1.0" with
        // the caret stranded, "1h " becomes "1h 0m" before the minutes are typed.
        // Tidying is the blur handler's job.
        //
        // An unparseable value stores null rather than the last good number, so "abc" and
        // an empty field mean the same thing.
        point.durationMin = DUR.parse(e.target.value, durFormat);
        refreshDerived();
      }
      markDirty();
    });

    // Tidy the duration on the way out: whatever was typed is rewritten in the
    // rider's format, so "90m" in hours mode settles to "1.5" and a typo settles
    // to blank rather than sitting there looking stored.
    //
    // focusout, not blur, because blur does not bubble and this listener is
    // delegated on the list. It writes the field only — the value was already
    // parsed into state on input, so there is nothing to mark dirty here and
    // nothing to save.
    listEl.addEventListener("focusout", (e) => {
      if (!e.target.classList || !e.target.classList.contains("row-dur")) return;
      const row = e.target.closest(".point-row");
      const point = row && pointOf(row);
      if (!point) return;
      e.target.value = DUR.format(point.durationMin, durFormat);
    });

    // THE KEYBOARD HALF OF THE DRAG HANDLE, and the reason Move up / Move down could
    // come off the row menu at all: those two were the point list's only keyboard
    // reorder and its only path when the SortableJS CDN fails.
    //
    // preventDefault because the drawer scrolls, and an arrow key that both moves the
    // point and scrolls the panel loses the row off the screen.
    listEl.addEventListener("keydown", (e) => {
      const grip = e.target.closest(".row-drag");
      if (!grip) return;
      const dir = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      if (!dir) return;
      e.preventDefault();
      const row = grip.closest(".point-row");
      if (!row) return;
      // movePoint() works on the ACTIVE route and a row can belong to one that is
      // not it, the same reason every other handler here calls setActive first.
      setActive(Number(row.dataset.route));
      const uid = row.dataset.uid;
      movePoint(Number(row.dataset.i), dir);
      // renderList() has replaced the button that was focused, so focus goes back
      // on the same POINT's grip at its new index — BY UID, because the index is
      // precisely the thing that just changed. Same rule as the route grip and
      // `.sg-drag`.
      const moved = uid && listEl.querySelector('.point-row[data-uid="' + CSS.escape(uid) + '"] .row-drag');
      if (moved) moved.focus();
    });

    listEl.addEventListener("click", (e) => {
      // BEFORE THE .point-row LOOKUP, because a via row is not one — every
      // handler below resolves a row to state.routes[route].points[i], and there is
      // no point behind this one.
      const viaDel = e.target.closest(".via-del");
      if (viaDel) {
        return removeVia(Number(viaDel.dataset.route), Number(viaDel.dataset.leg), Number(viaDel.dataset.via));
      }
      const row = e.target.closest(".point-row");
      if (!row) return;
      const i = Number(row.dataset.i);
      const isStop = row.dataset.kind === "stop";
      const point = pointOf(row);
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.classList.contains("row-menu-btn")) return toggleRowMenu(row, btn);
      if (btn.classList.contains("row-menu-item")) {
        const act = btn.dataset.act;
        closeRowMenu();
        if (act === "details") {
          const box = row.querySelector(".row-details");
          // Re-rendered on open rather than only at row build time, because the
          // rider may have changed the stop's roles since — and roles are what
          // decide which fields show. ONLY `.detail-body` is rewritten: the
          // rider-visible note sits outside it precisely so a role change cannot
          // destroy what is being typed into it.
          box.querySelector(".detail-body").innerHTML = detailsHtml(point, row.dataset.kind, i);
          box.hidden = false;
          const first = box.querySelector("textarea, input");
          if (first) first.focus();
          return;
        }
        if (act === "comment") return commentOnPoint(point.uid);
        if (act === "save-place") return savePointAsPlace(point);
        if (act === "duplicate") return duplicatePoint(row.dataset.kind, i);
        if (act === "delete") return deletePoint(i);
        if (act === "kind") return setPointKind(i, point.kind === "stop" ? "poi" : "stop");
        if (act === "select") return startSelect("point");
        if (act === "split") return splitRouteHere(Number(row.dataset.route), i);
        if (act === "split-group") return openSplitGroup(Number(row.dataset.route), i);
        return;
      }
      if (btn.classList.contains("detail-link-add")) {
        beginEdit("add link");
        if (!point.details) point.details = blankDetails();
        if (point.details.links.length >= MAX_LINKS) return toast("Up to " + MAX_LINKS + " links per stop", true);
        point.details.links.push({ label: "", url: "" });
        const box = row.querySelector(".detail-body");
        box.innerHTML = detailsHtml(point, row.dataset.kind, i);
        const inputs = box.querySelectorAll(".detail-link input");
        if (inputs.length) inputs[inputs.length - 2].focus();
        markDirty();
        return;
      }
      if (btn.classList.contains("detail-link-del")) {
        beginEdit("remove link");
        const n = Number(btn.closest(".detail-link").dataset.link);
        if (point.details) point.details.links.splice(n, 1);
        row.querySelector(".detail-body").innerHTML = detailsHtml(point, row.dataset.kind, i);
        markDirty();
        return;
      }
      if (btn.classList.contains("row-splitoff")) {
        // BY uid, never by the index this row was rendered with: a later split
        // pushes routes onto the end and every index after it moves.
        const to = state.routes.findIndex((d) => d.uid === btn.dataset.splitoff);
        if (to >= 0) goToRoute(to);
        return;
      }
      if (btn.classList.contains("row-split-offer")) {
        return splitRouteHere(Number(btn.dataset.route), Number(btn.dataset.i));
      }
      if (btn.classList.contains("row-roles-btn")) {
        closeRowMenu();
        const r = Number(row.dataset.route);
        const i = Number(row.dataset.i);
        // Toggled in state, not on the element — see state.rolesOpen. Only one
        // picker is open at a time, which is what the old DOM toggle gave by
        // accident (each row had its own) and is now deliberate: two open grids
        // in a 380px drawer is most of the panel.
        state.rolesOpen = rolesAreOpen(r, i) ? null : { route: r, i: i };
        renderRouteList(r);
        return;
      }
      // A CATEGORY IS A REASON TO STOP, so choosing one promotes the point and clearing
      // the last one demotes it. Ziad's call, 2026-08-24. The old flow was two actions
      // for one intention: pick "Gas", then open the menu and say "make this a stop".
      //
      // "Make this a stop" survives for the case categories cannot express — a stop
      // with no reason given, which imports and the first-point rule both produce.
      if (btn.classList.contains("role-opt")) {
        const role = btn.dataset.role;
        const r = Number(row.dataset.route);
        const route = state.routes[r];
        const i = Number(row.dataset.i);
        const had = point.roles.indexOf(role);
        const removing = had >= 0;
        const last = removing && point.roles.length === 1;

        // REFUSED BEFORE beginEdit, so a rejected untag pushes no undo step. The
        // route would otherwise be left with no stop at all, which the API refuses
        // and payload() drops the whole route for. Same guard setPointKind applies
        // to an explicit demote, reached from a different direction.
        if (last && point.kind === "stop" && stopsOf(route).length <= 1) {
          return toast("A route needs at least one stop—give this one a category or make another a stop", true);
        }
        if (!removing && point.roles.length >= 4) return toast("Up to 4 categories per point", true);

        beginEdit("change category");
        if (removing) point.roles.splice(had, 1);
        else point.roles.push(role);

        // The kind follows the categories. Note this is an INTERACTION rule, not a
        // schema one: points.kind stays its own column, because an untagged stop
        // is a real shape the importer and the first-point rule both create.
        point.kind = point.roles.length ? "stop" : "poi";

        // ONE PICK CLOSES IT. It used to stay open, on the reasoning that a point may
        // carry four categories — reported as #213: every rider read the grid staying put
        // as the click not registering. A second category is one more click on an icon
        // still right there; a control that will not close is a fault.
        //
        // Cleared BEFORE the render, so the row is built once in its final state.
        state.rolesOpen = null;
        renderRouteList(r);
        renderMarkers();
        refreshDerived();
        markDirty();
      }
    });
  }

  // --- Overflow menus -------------------------------------------------------
  //
  // ONE MENU, TWO OWNERS. Point rows and route headers share this; the differences
  // are entirely in the item list and the dispatch.
  //
  // BUILT ON OPEN, NEVER PER HOST, and that is a constraint rather than a
  // preference: the role picker already renders 17 buttons per point — 340 nodes at
  // twenty stops — and an eager menu per row would repeat that mistake.
  //
  // Absolutely positioned inside its host, so opening it moves nothing; both hosts
  // therefore need `position: relative`.
  //
  // NEITHER MENU CARRIES MOVE UP / MOVE DOWN ANY MORE. They existed because
  // `.row-drag` was a `<span aria-hidden>`, so they were its only keyboard reorder
  // and its only path with no CDN. The grip is a real <button> with arrow keys now.
  // Do not re-add the items without first making the grip a span again.
  const MENU_ITEMS = [
    // ONE DOOR TO BOTH NOTES. "Edit notes" opened `.row-desc` and this opened a
    // panel with a "Private notes" box in it, so a rider had two items leading to
    // two boxes with nothing saying which was which — and the difference is the
    // one thing about them worth knowing. Both live in the panel now, labeled.
    { act: "details", label: "Notes, reservations & details" },
    { act: "save-place", label: "Save to my places" },
    { act: "duplicate", label: "Duplicate" },
    { act: "select", label: "Select points…" },
    // ONE ITEM, NOT TWO, AND IT IS ABSENT ON A TAGGED STOP. Picking a category
    // promotes a point on its own and clearing the last one demotes it, so on a point
    // carrying categories this would be a second way to say what the chips say.
    //
    // What a category cannot say is a stop with no reason given, which imports and
    // the first-point rule both produce — so the item survives for exactly that.
    //
    // Kept reversible, because a mis-promotion would otherwise cost a delete and a
    // re-add and take the point's notes and details with it.
    {
      act: "kind",
      label: (pt) => (pt.kind === "stop" ? "Make this a POI" : "Make this a stop"),
      when: (pt) => pt.kind !== "stop" || !(pt.roles || []).length,
    },
    // No longer stopOnly: a POI has a place in the list of its own now.
    // ANCHORED BY UID, which is the point's identity across a save — its id
    // churns on every PUT and cannot be referenced. The comment survives the
    // point being deleted, demoting to ride level rather than going with it.
    { act: "comment", label: "Comment on this stop" },
    // #49. Shown on every interior point and DISABLED on the two ends rather
    // than hidden, because "why can I not split here" is worth answering in
    // place — splitting at the first or last point would leave a route with one
    // point and no legs, which the API refuses and payload() drops whole.
    { act: "split", label: "End the route here" },
    // #67's diverge half. Shown and DISABLED rather than hidden, the same as the
    // cut above and for the same reason: "why can I not split a group off here"
    // is worth answering in place. It has three refusals — a ride of one rider,
    // a route that already ends at this stop, and a ride with no groups to peel
    // off — and toggleRowMenu picks the one that applies.
    { act: "split-group", label: "Split a group off here" },
    { act: "delete", label: "Delete", danger: true },
  ];

  // The route menu. `when` decides whether an item appears at all — the two
  // alternate actions are meaningless on a route that is not in a group, and a
  // menu full of disabled items nobody can explain is worse than a short one.
  //
  // "Make this the active alternate" and "Ungroup alternates" are not optional
  // extras: without them a rider can put routes into a group and has no way back
  // out, and no way to change their mind about which one they are riding.
  const ROUTE_MENU_ITEMS = [
    { act: "route-duplicate", label: "Duplicate route" },
    { act: "route-select", label: "Select routes…" },
    { act: "route-promote", label: "Ride this one instead", when: (d) => d.altGroup != null && !d.altActive },
    { act: "route-ungroup", label: "Ungroup alternatives", when: (d) => d.altGroup != null },
    { act: "route-delete", label: "Delete route", danger: true },
  ];

  // Which button opened the menu that is currently up, so Escape can put focus
  // back on it. It used to be found with `.closest('.point-row')`, which does
  // not generalize to a second host.
  let menuOpener = null;

  function closeMenu() {
    const open = document.querySelector(".row-menu");
    if (!open) return;
    if (menuOpener) menuOpener.setAttribute("aria-expanded", "false");
    menuOpener = null;
    open.remove();
  }

  // Kept under the old name for the handful of callers that mean "the row menu";
  // there is only one menu and closing it is closing it.
  const closeRowMenu = closeMenu;

  function openMenu(host, btn, items) {
    const wasOpen = host.contains(document.querySelector(".row-menu"));
    closeMenu();
    if (wasOpen) return;

    const menu = document.createElement("div");
    menu.className = "row-menu";
    menu.setAttribute("role", "menu");
    menu.innerHTML = items
      .map(
        (m) =>
          '<button type="button" role="menuitem" class="row-menu-item' +
          (m.danger ? " is-danger" : "") +
          '"' +
          ' data-act="' +
          m.act +
          '"' +
          // WHY it is disabled, on the item itself. A disabled control with no
          // reason is what the split item was written not to be, and a `title` is
          // the only place a reason fits inside a 380px menu.
          (m.title ? ' title="' + esc(m.title) + '"' : "") +
          (m.off ? " disabled" : "") +
          ">" +
          esc(m.label) +
          "</button>",
      )
      .join("");
    host.appendChild(menu);
    btn.setAttribute("aria-expanded", "true");
    menuOpener = btn;
    const first = menu.querySelector(".row-menu-item:not([disabled])");
    if (first) first.focus();
  }

  /**
   * Why a group cannot be peeled off here, or null when it can be.
   *
   * A SENTENCE RATHER THAN A BOOLEAN, because the item is shown disabled and a
   * greyed control with no reason is the thing #49's split item exists not to be.
   * The order is the order a planner meets them: no groups to peel off at all,
   * then nobody to peel off, then this particular stop.
   */
  function splitGroupRefusal(route, i) {
    const roster = (state.routeRiders && state.routeRiders.riders) || [];
    if (!state.rideId) return "Save the " + W("journey") + " first—a split is a change to who is on which road.";
    if (state.meta.subgroups.length < 2 && roster.length < 2) {
      return "There is nobody to split off—you are the only " + W("person") + " on this " + W("journey") + ".";
    }
    if (roster.length < 2)
      return "There is nobody to split off—add " + Ws("person") + " to the " + W("journey") + " first.";
    const rr = routeRidersOf(route);
    if (rr && (rr.riderIds || []).length < 2)
      return "Only one " + W("person") + " is on this stretch, so nobody can leave it.";
    if (!SPLIT.canPeelOffAt(route, i)) return "This route ends here—split from the route that carries on.";
    return null;
  }

  function toggleRowMenu(row, btn) {
    const i = Number(row.dataset.i);
    const route = editRoute();
    const point = route && route.points[i];
    if (!point) return;
    // The kind item is ABSENT rather than disabled on a tagged stop — unlike the
    // split below — because the categories are the control there and a greyed
    // duplicate says nothing a rider can act on.
    //
    // Demoting the route's last stop IS shown and disabled: a real action unavailable
    // for a reason worth stating, and setPointKind says which.
    //
    // `label` may be a function of the point, because the kind item is one item
    // saying two things.
    const items = MENU_ITEMS.filter((m) => !m.when || m.when(point)).map((m) => ({
      ...m,
      label: typeof m.label === "function" ? m.label(point) : m.label,
      off:
        (m.act === "kind" && point.kind === "stop" && stopsOf(route).length <= 1) ||
        (m.act === "split" && !SPLIT.canSplitAt(route, i)) ||
        (m.act === "split-group" && splitGroupRefusal(route, i) !== null),
      title: m.act === "split-group" ? splitGroupRefusal(route, i) : null,
    }));
    openMenu(row, btn, items);
  }

  function toggleRouteMenu(head, btn, r) {
    const route = state.routes[r];
    if (!route) return;
    const items = ROUTE_MENU_ITEMS.filter((m) => !m.when || m.when(route)).map((m) => ({
      ...m,
      // A ride needs at least one route, and the reason has to be visible before
      // the click rather than as a toast after it.
      off: m.act === "route-delete" && state.routes.length <= 1,
    }));
    openMenu(head, btn, items);
  }

  // Anywhere else, or Escape. Registered once rather than per menu, so an open
  // menu never outlives the render that replaced its host.
  function wireMenuDismiss() {
    document.addEventListener("pointerdown", (e) => {
      // A press on a tour card is not "anywhere else": the tour opens a menu
      // to show it, and closing it under the card's own Next moved the card
      // out from under the pointer before the click could land.
      if (
        !e.target.closest(".row-menu") &&
        !e.target.closest(".row-menu-btn") &&
        !e.target.closest(".route-menu-btn") &&
        !e.target.closest(".shepherd-element")
      ) {
        closeMenu();
      }
    });
    // Escape is CHAINED: a menu first, then select mode. Two things can be open
    // at once and the rider means the innermost one — closing select mode while
    // a menu is up would throw away a selection they had not finished with.
    //
    // Select mode is deliberately NOT dismissed by an outside click. A selection
    // takes work to build and a stray click on the map must not discard it.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".row-menu")) {
        const btn = menuOpener;
        closeMenu();
        if (btn) btn.focus();
        return;
      }
      // Before select mode and after a menu: arming is the shallower of the two
      // and costs nothing to redo, where a selection took work to build.
      if (disarmPlace()) return;
      if (state.select) endSelect();
    });
  }

  // --- Drag to reorder ------------------------------------------------------
  //
  // THE INDEX MAPPING IS THE WHOLE JOB, and it is not what it looks like.
  // orderedRows() interleaves stops and POIs sorted by distance, while each row's
  // data-i indexes its OWN array — so Sortable's oldIndex/newIndex, which count
  // all children, mean nothing here.
  //
  // Reading the resulting DOM order of the stop rows sidesteps the interleaving:
  // their data-i values in document order ARE the new ordering, however many POIs
  // sat between them.
  //
  // Degrades to nothing if the CDN did not deliver; the grips carry arrow keys.
  function initDragToReorder(listEl) {
    if (!window.Sortable) {
      console.warn("[builder] Sortable did not load—reorder by the row menu");
      return;
    }
    // Guard against double-binding: renderRoutes() rebuilds every list and calls
    // this for each, and Sortable leaves its own instance on the element.
    if (listEl._sortable) listEl._sortable.destroy();
    listEl._sortable = window.Sortable.create(listEl, {
      // `draggable` already excludes the trailing .add-row, but `filter` is what stops
      // a drag STARTING on it — without it a drop can be placed after it, putting a
      // real row below the search field.
      //
      // .insert-slot is filtered for that and one more reason: there is one between
      // every pair of rows, so an unfiltered drag on a hairline would be the easiest
      // drag in the list to begin by accident.
      draggable: ".point-row",
      filter: ".add-row, .insert-slot, .via-row",
      // WITHOUT THIS THE SEARCH FIELD CANNOT BE CLICKED INTO. `preventOnFilter`
      // defaults to TRUE, so Sortable calls preventDefault() on any pointerdown inside
      // a filtered element — and the default action being prevented is the one that
      // moves focus. Every route's add row was inert to the mouse: tabbable and
      // typable, but a click left focus on <body>. Observed on /builder/9.
      //
      // `filter` still does its real job either way: it stops a DRAG starting on the
      // add row, which is a Sortable-internal check that does not need the event
      // canceled.
      preventOnFilter: false,
      handle: ".row-drag",
      animation: 150,
      ghostClass: "is-dragging",
      // ONE GROUP ACROSS EVERY DAY, so a stop can be dragged out of one route and
      // into another. That is a new capability, not a side effect: before every
      // route was on screen at once there was only ever one list, and moving a stop
      // between routes was impossible by any route.
      group: "ride-points",
      // Sortable defaults to native HTML5 drag-and-drop on a desktop pointer and
      // to its own implementation on touch, which means two code paths, two sets
      // of quirks and a drag image the browser draws and we cannot style. The
      // fallback path is used for both here so a drag behaves and looks the same
      // on a phone and a laptop. It is also the only path a synthetic event can
      // drive, which is what makes this testable at all.
      forceFallback: true,
      fallbackClass: "row-drag-ghost",
      fallbackOnBody: true,
      // Touch needs a moment of hold to tell a drag from a scroll; a mouse does
      // not and 0 keeps it feeling immediate.
      delay: 200,
      delayOnTouchOnly: true,
      // DRAGGING IS OFF WHILE SELECTING. A drag started with four rows ticked
      // reads as "move all four" and does not do that, and there is no reading
      // of it that is obviously right — so the gesture is taken away rather than
      // given an ambiguous meaning.
      disabled: !!state.select,
      onEnd: (evt) => {
        // CROSS-DAY FIRST, and it is a different operation rather than a special
        // case of reordering: the point leaves one route's array and joins
        // another's, and BOTH routes' legs are wrong afterwards. A same-route drop
        // falls through to the index arithmetic below.
        if (evt.from !== evt.to) return movePointAcrossRoutes(evt);

        const route = state.routes[Number(evt.from.dataset.route)];
        if (!route) return;

        // ONE OPERATION FOR BOTH KINDS, and Sortable's own indices finally mean
        // something: every row is a point in route.points and the list on screen is that
        // array in order.
        //
        // **`newDraggableIndex`, NEVER `newIndex`, AND THE DIFFERENCE IS NOT COSMETIC.**
        // `oldIndex`/`newIndex` count EVERY child; the draggable pair counts only
        // `.point-row`s. This list renders an `.insert-slot` ABOVE every row plus a
        // trailing `.add-row`, so it holds 2n+1 children and the raw index runs at
        // roughly double.
        //
        // Live from 2026-08-24 to 2026-08-27, failing two ways at once — measured on
        // /builder/8. Dragging point 7 of 8 up one reported `newIndex: 13`, which clamped
        // to 7 and equalled `from`, so nothing moved and nothing was marked dirty;
        // dragging point 0 down one reported 3 and moved it three places, which DID save.
        // Reported as #166.
        //
        // The clamping and the did-it-move question are TBDragIndex.dropTarget, so
        // test/drag-index.test.ts can hold the arithmetic: nothing in this closure is
        // reachable from a test. A null answer means the drop was not an edit.
        const i = Number(evt.item.dataset.i);
        const to = DRAG.dropTarget(i, evt.newDraggableIndex, route.points.length);
        if (to == null) return;
        return reorderPoint(i, to);
      },
    });
  }

  // DRAG TO REORDER ROUTES. The use case is a base camp: rent a house, ride a loop
  // each day, and the routes are interchangeable in a way a linear tour's are not.
  //
  // Cheaper than reordering stops, because a route owns its own legs: moving route
  // 3 above route 1 changes no leg's endpoints and needs no routing call. Only the
  // position changes, plus the parallel legSeq array — leaving that behind would
  // let a stale response land on whichever route took the old index.
  //
  // Rebound on every renderRoutes(), which replaces the sections.
  function initRouteDrag(host) {
    if (!window.Sortable) return;
    if (host._sortable) host._sortable.destroy();
    host._sortable = window.Sortable.create(host, {
      draggable: ".route-section",
      handle: ".route-drag",
      animation: 150,
      ghostClass: "is-dragging",
      // Same reasoning as the stop list: one code path on desktop and touch, a
      // drag mirror we can style, and the only path a synthetic event can drive.
      forceFallback: true,
      fallbackClass: "route-drag-ghost",
      fallbackOnBody: true,
      delay: 200,
      delayOnTouchOnly: true,
      // DRAGGING IS OFF WHILE SELECTING. A drag started with four rows ticked
      // reads as "move all four" and does not do that, and there is no reading
      // of it that is obviously right — so the gesture is taken away rather than
      // given an ambiguous meaning.
      disabled: !!state.select,
      onEnd: (evt) => {
        // The RAW indices are safe here and only because #route-list holds nothing
        // but .route-section children, so they agree with the draggable ones. The
        // point list does not have that property and #166 is what it cost: adding
        // any sibling between the sections — a separator, a drop hint — silently
        // makes these read about double. Use the draggable pair if that ever
        // changes.
        const from = evt.oldIndex;
        const to = evt.newIndex;
        if (from === to || from == null || to == null) return;
        beginEdit("reorder routes");
        const [route] = state.routes.splice(from, 1);
        state.routes.splice(to, 0, route);
        const [seq] = state.legSeq.splice(from, 1);
        state.legSeq.splice(to, 0, seq || []);
        // The route that moved is the one the rider is thinking about.
        state.active = to;
        renderRoutes();
        // Layers are keyed by route index, so every one from the lower of the two
        // positions onward is now drawing the wrong route. Rebuilding is the whole
        // fix and costs no routing.
        rebuildLayers();
        renderMarkers();
        refreshDerived();
        markDirty();
      },
    });
  }

  // A POINT DRAGGED OUT OF ONE ROUTE AND INTO ANOTHER.
  //
  // New with the all-routes panel. It is a move between two arrays rather than a
  // reorder within one, and the consequence that matters is that BOTH routes' legs
  // are wrong afterwards — the N points, N−1 legs invariant breaks at both ends.
  //
  // Legs are PATCHED on both sides rather than dropped wholesale. Dropping them
  // cost the rider every hand-drawn shaping point on both routes plus a routing
  // request for each road that had not changed. The source is a removal
  // (rejoinRouteLegs); the destination is an insertion, which is what addPoint
  // does.
  function movePointAcrossRoutes(evt) {
    const fromRoute = Number(evt.from.dataset.route);
    const toRoute = Number(evt.to.dataset.route);
    const src = state.routes[fromRoute];
    const dst = state.routes[toRoute];
    if (!src || !dst || fromRoute === toRoute) return;

    const i = Number(evt.item.dataset.i);
    const moving = src.points[i];
    if (!moving) return;
    const kind = moving.kind;

    beginEdit("move " + (kind === "stop" ? "stop" : "POI") + " between routes");

    const srcLegs = src.legs;
    const srcPoints = src.points.length;
    const [pt] = src.points.splice(i, 1);
    // Where it landed in the DESTINATION's list, clamped because .add-row is a child
    // too and always last.
    //
    // `newDraggableIndex`, never `newIndex`: the destination list interleaves an
    // .insert-slot above every row, so the raw child index runs at about double. Same
    // bug as the same-route path, and it landed here as an append to the bottom of
    // the target route rather than a drop where the rider aimed. See #166.
    //
    // insertTarget rather than dropTarget: the point is not in this array yet, so one
    // past the last element is an append and a legitimate answer.
    const at = DRAG.insertTarget(evt.newDraggableIndex, dst.points.length);
    // A POI's distance along the track belongs to the route it was measured on and
    // means nothing on another one. Null is honest — "near this route's route,
    // position not measured" — and is exactly what an import with no track
    // stores. See the null-is-not-zero note in AGENTS.md.
    pt.distFromStartMi = null;
    dst.points.splice(at, 0, pt);

    // A DAY MUST KEEP A STOP — see ensureRouteHasStop(). Dragging the last one out
    // would leave a route the save refuses and payload() drops whole.
    ensureRouteHasStop(src);

    const srcOut = rejoinRouteLegs(src, srcLegs, srcPoints, [i]);
    state.legSeq[fromRoute] = [];

    // The destination gains a point at `at`: splicing a placeholder in at `at`
    // leaves the two legs needing the router at `at - 1` and `at`, and every
    // other leg still joins the pair of points it always joined.
    if (dst.points.length > 1) {
      dst.legs.splice(Math.min(at, dst.legs.length), 0, straightLeg([pt.lng, pt.lat], [pt.lng, pt.lat]));
    }
    fillMissingLegs(dst);
    state.legSeq[toRoute] = [];

    // The two route LISTS are rebuilt rather than patched: both have shifted
    // indices, and every row's data-i has to agree with the arrays again before
    // any later handler reads one.
    renderRoutes();
    rebuildLayers();
    renderMarkers();
    // Only the legs that actually changed go to the router.
    if (srcOut.stale.length) computeLegsAround(fromRoute, srcOut.stale);
    computeLegsAround(toRoute, [at - 1, at]);
    if (srcOut.trimmed) toast("The joined leg kept only the first " + MAX_VIAS_PER_LEG + " shaping points", true);
    setActive(toRoute);
    refreshDerived();
    markDirty();
    toast("Moved to " + routeLabel(toRoute));
  }

  // --- Search (Google Places autocomplete) ----------------------------------

  // The whole reason the map moved to Google: place-search quality was the one
  // thing Mapbox Geocoding was measurably worse at, and Google's terms forbid
  // showing Places results on anyone else's basemap.

  let searchTimer = null;
  let searchSeq = 0;

  // #search-results is `position: fixed` so it can escape the panel's scroll
  // box, which means its coordinates are this function's job rather than the
  // stylesheet's. Sized to the field, opening downward unless the bottom of the
  // viewport is closer than the list is tall, in which case it flips above.
  function placeResults(input, results) {
    const f = input.getBoundingClientRect();
    const GAP = 2;
    results.style.left = f.left + "px";
    results.style.width = f.width + "px";

    // Measure the list where it will actually sit, so a flip decision is made
    // against its real height rather than its max-height.
    results.style.top = f.bottom + GAP + "px";
    results.style.bottom = "auto";
    const h = results.getBoundingClientRect().height;

    if (f.bottom + GAP + h > window.innerHeight && f.top - GAP - h > 0) {
      results.style.top = "auto";
      results.style.bottom = window.innerHeight - f.top + GAP + "px";
    }
  }

  // ONE DROPDOWN FOR EVERY ROW. There can be 31 search fields on screen and only
  // one open list, so the results element is owned by the document and moved to
  // whichever field is asking. A <ul> per row would put 31 empty dropdowns in
  // the DOM for nothing — the same argument the row ⋮ menu makes for building
  // on open. `results.dataset.route` remembers which route the open list is for, so
  // a pick lands correctly even if the rows have been re-rendered since.
  let resultsEl = null;
  function searchResultsEl() {
    if (resultsEl) return resultsEl;
    resultsEl = document.createElement("ul");
    resultsEl.id = "search-results";
    resultsEl.hidden = true;
    document.body.appendChild(resultsEl);
    return resultsEl;
  }

  function hideSearchResults() {
    if (resultsEl && !resultsEl.hidden) resultsEl.hidden = true;
    // THE DOTS LIVE EXACTLY AS LONG AS THE DROPDOWN. Every path that closes it comes
    // through here, so there is no way to leave a dozen candidates painted over a
    // route the rider has moved on from.
    //
    // ONLY WHEN THE SEARCH IS WHAT PUT THEM THERE. `setSearchPreview` is one slot
    // with two consumers — a place search and a meeting-point proposal — and without
    // this, opening and closing a search would wipe the candidates the rider is
    // choosing between.
    if (state.map && state.previewOwner === "search") {
      setSearchPreview(state.map, []);
      state.previewOwner = null;
    }
  }

  function wireSearch() {
    const host = $("route-list");
    const results = searchResultsEl();

    // A fixed dropdown does not travel with the field, so anything that moves
    // the field dismisses it rather than leaving it stranded. That matters more
    // now than it did: the field is inside the panel's scroller rather than
    // pinned above it.
    const wrapper = document.querySelector(".panel-contents-wrapper");
    if (wrapper) wrapper.addEventListener("scroll", hideSearchResults, { passive: true });
    window.addEventListener("resize", hideSearchResults);

    // A saved place looks different from a Google prediction on purpose: it is
    // the rider's own, it costs nothing to pick, and it arrives with roles and
    // contact details attached. The badge is what says so.
    // The slot a row inserts into, or null for the route's bottom row. One reader,
    // so the search, the chips and the arm button cannot disagree about where the
    // point is going.
    const slotOf = (el) => {
      const row = el && el.closest ? el.closest(".add-row") : null;
      const raw = row && row.dataset.at;
      return raw == null || raw === "" ? null : Number(raw);
    };

    // --- Category search ----------------------------------------------------

    // Where a category search with no place in its text should look.
    //
    // The route's LAST point, because that is where the rider has got to. Falls back
    // to the map viewport on a route with no points, and to nothing at all before the
    // map has settled, where Text Search answers unbiased rather than not at all.
    //
    // A typed query naming a place ("gas station in oakdale ca") does not come
    // through here: Text Search reads the place out of the text, so an anchor would
    // fight it.
    /**
      * Where a "near" search looks: WHAT IS ON SCREEN.
      *
      * It anchored on the route's LAST POINT until 2026-08-31, so panning changed
      * nothing and a rider looking at Redding who tapped Coffee got results around a
      * hotel three hundred miles down the route. The last point is a place they can
      * neither see nor move; the viewport is the one anchor they control.
      *
      * Null before the map has settled, and the proxy is happy with no anchor — Text
      * Search falls back to its own global ranking.
      */
    function viewportAnchor() {
      return viewportCircle(state.map);
    }

    /**
      * The track of the leg an insert slot sits in, and where to anchor a search on
      * it. Null when there is no leg to speak of.
      *
      * `at` is an INSERTION INDEX, so the new point lands between points[at-1] and
      * points[at] and the leg being split is legs[at-1]. Inserting at 0 anchors on the
      * first point itself.
      *
      * PREFERS THE ROUTED GEOMETRY AND FALLS BACK TO THE STRAIGHT PAIR: a leg that has
      * not come back from the router is still a stretch of map the rider is pointing
      * at, and the straight line between its ends beats searching the whole ride.
      */
    function legAnchor(route, at) {
      const pts = route.points;
      if (!pts.length) return null;
      const j = Math.max(0, Math.min(at, pts.length - 1));
      const b = pts[j];
      if (j === 0) {
        const near = [b.lng, b.lat];
        return { track: [near], near: near, totalM: 0 };
      }
      const a = pts[j - 1];
      const leg = route.legs[j - 1];
      const track =
        leg && leg.geometry && leg.geometry.length >= 2
          ? leg.geometry
          : [
              [a.lng, a.lat],
              [b.lng, b.lat],
            ];
      const totalM = haversineTrack(track);
      const near = pointAtDistance(track, totalM / 2) || [b.lng, b.lat];
      return { track: track, near: near, totalM: totalM };
    }

    /**
      * The anchor for a search from the route's own bottom add-row.
      *
      * ON SCREEN FALLS BACK TO THE ROUTE WHEN THE SCREEN IS TOO BIG TO SEARCH.
      * viewportCircle() clamps its radius to the 50km the proxy accepts, so on a ride
      * fitted from Oakland to Vancouver the anchor was a 50km bubble near Roseburg
      * holding none of the road, and every suggestion came back from central Oregon.
      * Reported on ride 32, 2026-09-02.
      */
    function screenAnchor(r) {
      const view = viewportAnchor();
      if (view && view.spanM <= view.radiusM) return view;
      const route = state.routes[r];
      const track = route ? fullTrack(r) : [];
      const totalM = route ? DIST.totalM(route) : 0;
      if (!track.length || !totalM) return view;
      const near = pointAtDistance(track, totalM / 2);
      if (!near) return view;
      return {
        near: near,
        radiusM: Math.max(500, Math.min(50000, Math.round(totalM / 2))),
        spanM: Math.round(totalM / 2),
        widened: true,
      };
    }

    /**
      * ONE TEXT SEARCH FOR THE WHOLE ROUTE, biased at its midpoint, then filtered to
      * the corridor here in the browser. Ziad's call, 2026-08-31, and a cost decision
      * rather than a technical one: searching every ten miles is the accurate version
      * and costs about thirty billed calls per slider move on a 300-mile route.
      *
      * WHAT THAT BUYS AND COSTS: one cached call for any route of any length, against
      * a result set Google biases toward one point, so a long route gets a set thinned
      * toward its middle. `wide` asks for the API's twenty rather than the dropdown's
      * eight — same call, same money, and most of what makes this usable.
      *
      * The bias radius covers half the route, clamped to 50 km. A bias is not a filter,
      * so the corridor test below is what actually decides.
      */
    function corridorSearchArgs(r) {
      const route = state.routes[r];
      // BOTH HALVES OF ONE WALK. fullTrack() is trackAndSpans().track, and #266
      // needs the spans as well to put a hit back on a row, so taking them
      // together is one pass rather than two that could disagree.
      const built = route ? trackAndSpans(r) : { track: [], spans: [] };
      const track = built.track;
      const spans = built.spans;
      const totalM = route ? DIST.totalM(route) : 0;
      // The viewport only when the route has no line yet — this is the ALONG THE ROUTE
      // scope, so the route is the subject and the screen is the fallback.
      // A route with no line has no corridor, and withinCorridor() lets everything
      // through on an empty track by design: a rider who just dropped their first point
      // should get Google's answer rather than an empty list reading as "there is none
      // here".
      const view = viewportAnchor();
      if (!track.length || !totalM) {
        return { track: track, spans: spans, totalM: 0, near: view && view.near };
      }

      // The sampling itself is corridorRun(), which the insert-slot path shares
      // — the route and one leg are the same question at two scales.
      return { track: track, spans: spans, totalM: totalM, near: pointAtDistance(track, totalM / 2) };
    }

    /**
      * Put each hit back on the row it belongs between. #266.
      *
      * A CORRIDOR HIT IS A DISTANCE ALONG A ROAD THAT ALREADY EXISTS — the same shape
      * of fact the meeting point turned out to be, and its fix is the precedent. Here
      * the projection was already being run and its answer thrown away, so every Along
      * the route hit fell through to addPoint()'s append and a coffee stop found at
      * mile 40 landed after the hotel at mile 300.
      *
      * `legs[i]` JOINS `points[i]` TO `points[i + 1]`, so a place projecting onto leg i
      * belongs at row i + 1. No distance is compared against anything.
      *
      * `edgeForward` IS TRUE BECAUSE A BOUNDARY VERTEX IS THE START OF THE SEGMENT
      * THAT WON: taking the arriving leg would put the hit one row early at every
      * joint.
      *
      * A hit that cannot be placed is left alone rather than given a guess.
      */
    function placeAlongRoute(hits, spans) {
      if (!spans || !spans.length) return;
      hits.forEach((h) => {
        if (typeof h.atIndex !== "number") return;
        const leg = legAtVertex(spans, h.atIndex, true);
        if (leg != null) h.insertAt = leg + 1;
      });
    }

    /**
      * Every place any sample returned, each one once.
      *
      * PARTIAL RESULTS BEAT NO RESULTS: one sample failing must not throw away the
      * five that answered, so failures are counted and only a total wipeout is an
      * error.
      *
      * DEDUPED ON POSITION AND NAME, because the samples overlap by design. There is
      * no place id in the proxy's shape to key on, and the coordinates are rounded to
      * six places server-side, so the pair compares exactly.
      */
    /**
     * A corridor search over one track: sample it, union the answers, keep what
     * is within CORRIDOR_MI of it.
     *
     * TAKES A TRACK RATHER THAN A DAY, which is what lets an insert slot reuse
     * every rule here for the single leg it sits in. The route and the leg are the
     * same question asked at two scales.
     */
    async function corridorRun(query, track, totalM, fallbackNear) {
      const corridorM = CORRIDOR_MI * window.TBUnits.METERS_PER_MILE;
      const samples = [];
      const spans = CORRIDOR.corridorSamples(totalM, corridorM, MAX_CORRIDOR_SAMPLES);
      // WHETHER THE DAY WAS FULLY SEARCHED, carried out with the results. A
      // partly searched route that finds nothing is indistinguishable from a road
      // with no fuel on it, and the rider is entitled to know which they have.
      corridorPartial = !CORRIDOR.samplesCoverAll(spans, totalM);
      spans.forEach((sp) => {
        const at = pointAtDistance(track, sp.atM);
        if (at) samples.push({ near: at, radiusM: sp.radiusM });
      });
      // A ZERO-LENGTH STRETCH IS STILL A PLACE. Inserting above the first point
      // of a route, or between two points sitting on top of each other, gives a
      // track with no length for corridorSamples() to divide — and answering
      // nothing there would be worse than answering about the one point we have.
      if (!samples.length && fallbackNear) {
        samples.push({ near: fallbackNear, radiusM: Math.max(500, Math.min(50000, Math.round(corridorM))) });
      }
      const raw = await corridorPlaces(query, samples);
      // `atIndex` IS A VERTEX OF THE TRACK THAT WAS PASSED IN, so it is carried
      // rather than resolved here: this function takes a track and does not know
      // whether it is a whole route, one leg, or an explicit stretch. Only the
      // route case can turn it into a row, and placeAlongRoute() is where that
      // happens because that is where the spans are.
      return CORRIDOR.withinCorridor(raw, track, corridorM).map((hit) =>
        Object.assign({}, hit.place, { offRouteM: hit.offRouteM, atIndex: hit.atIndex }),
      );
    }

    async function corridorPlaces(query, samples) {
      const settled = await Promise.allSettled(
        samples.map((s) => nearbySearch(query, s.near, { wide: true, radiusM: s.radiusM })),
      );
      const failed = settled.filter((r) => r.status === "rejected");
      if (samples.length && failed.length === settled.length) throw failed[0].reason;
      if (failed.length)
        console.warn("[builder] corridor search:", failed.length, "of", settled.length, "samples failed");
      const seen = Object.create(null);
      const out = [];
      settled.forEach((r) => {
        if (r.status !== "fulfilled") return;
        r.value.forEach((p) => {
          const ll = CORRIDOR.placeLngLat(p);
          const key = (ll ? ll[0] + "," + ll[1] : "?") + "|" + (p.name || "");
          if (seen[key]) return;
          seen[key] = true;
          out.push(p);
        });
      });
      return out;
    }

    /**
     * The anchor arguments for a typed category query, spread into
     * nearbySearch.
     *
     * NO ANCHOR WHEN THE TEXT NAMES A PLACE. Text Search reads "gas station in
     * oakdale ca" itself, and biasing to the viewport as well would pull the
     * answer back to wherever the rider happens to be looking — which is the
     * one case where the screen is NOT what they meant.
     */
    // "gas station in bakersfield" carries its own where. Text Search reads the
    // place out of the query, so ANY anchor we add — the viewport, or the route's
    // own corridor — drags the answer back to wherever the rider happens to be.
    // Factored out because the corridor path has to make the same exception.
    const namesAPlace = (q) => /\b(in|near|around|close to|by)\b/.test(q);

    function namedOrViewport(q) {
      if (namesAPlace(q)) return [null];
      const view = viewportAnchor();
      return view ? [view.near, { radiusM: view.radiusM }] : [null];
    }

    /**
      * The category half of a TYPED query, searched over the same stretch a chip would
      * search.
      *
      * #266's other half. The scope control governed the chips and nothing else, so
      * with Along the route selected, tapping Gas searched the route and typing "gas"
      * searched the screen — two answers to one question, from one control.
      *
      * ONLY THE CATEGORY HALF. The name half is Autocomplete and stays restricted to
      * the visible map: a prediction carries no coordinates to filter on until it is
      * resolved, and Place Details bills per call.
      *
      * The precedence is `categorySearch()`'s — a slot is the rider pointing at a
      * stretch of road, and it outranks the scope.
      */
    async function typedCategoryHits(cat, q, r, at, rep) {
      if (namesAPlace(q)) return nearbySearch(cat.text, null);
      // A REPLACE SEARCHES AROUND THE POINT BEING REPLACED. It is the one
      // anchor the rider has unambiguously pointed at — the row they are typing
      // in — and it outranks the scope for the reason a slot does.
      const old = rep == null ? null : state.routes[r] && state.routes[r].points[rep];
      if (old) return nearbySearch(cat.text, [old.lng, old.lat]);
      const leg = at == null ? null : legAnchor(state.routes[r], at);
      if (leg) return corridorRun(cat.text, leg.track, leg.totalM, leg.near);
      if (state.corridorOn) {
        const args = corridorSearchArgs(r);
        const hits = await corridorRun(cat.text, args.track, args.totalM, args.near);
        placeAlongRoute(hits, args.spans);
        return hits;
      }
      return nearbySearch(cat.text, ...namedOrViewport(q));
    }

    /**
      * What to say when a typed query found nothing, naming what was actually covered.
      *
      * TWO HALVES SEARCHING TWO AREAS is what makes this its own function: the
      * category half follows the scope and the name half is always the viewport, so
      * "on screen" describes only half of what was asked. Telling a rider the wrong
      * area is the complaint #232 was filed about.
      */
    function typedEmptyText(q, cat, at, rep) {
      const named = "“" + q + "”";
      if (cat && rep != null)
        return "No matches for " + named + " near this point or on screen. Zoom out to search wider.";
      if (cat && at != null)
        return "No matches for " + named + " along this leg or on screen. Zoom out to search wider.";
      if (cat && state.corridorOn)
        return "No matches for " + named + " along this route or on screen. Zoom out to search wider.";
      return "No matches for " + named + " on screen. Zoom out to search wider.";
    }

    async function nearbySearch(query, near, opts) {
      const body = near ? { query: query, near: near } : { query: query };
      // A corridor search asks for the wider result set and a bias radius that
      // covers the route rather than the default town-sized one. Both are the same
      // single billed call — see MAX_CORRIDOR_RESULTS in src/routes/routing.ts.
      if (opts && opts.wide) body.wide = true;
      if (opts && opts.radiusM) body.radiusM = opts.radiusM;
      const res = await fetch("/api/places/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error((data && data.error) || "search failed (" + res.status + ")");
        err.status = res.status;
        throw err;
      }
      return (data && data.places) || [];
    }

    // A heading above the nearby block, because two kinds of answer in one list
    // with nothing between them reads as one ranked list where the good matches
    // happen to be at the top. They are not the same question: above are places
    // matching what you typed, below are places OF the kind you asked for.
    function nearbyResultsHtml(hits) {
      if (!hits.length && !corridorPartial) return "";
      return (
        '<li class="hit-head" aria-hidden="true">Nearby' +
        // SAYS THE DAY WAS ONLY PARTLY SEARCHED, because the alternative is a
        // short list — or none — that reads as a road with no fuel on it. Past
        // about 745 miles the samples stop touching even at the raised cap, and
        // the honest thing is to name the gap rather than let the rider draw the
        // wrong conclusion from it. See MAX_CORRIDOR_SAMPLES.
        (corridorPartial ? ' <span class="hit-partial">part of this route only—zoom in and use On screen</span>' : "") +
        "</li>" +
        hits
          .map(
            (h, i) =>
              '<li class="hit-nearby" data-nearby="' +
              i +
              '"><strong>' +
              esc(h.name) +
              "</strong> " +
              // THE NUMBER THE RIDER IS DECIDING ON, when there is one. A
              // corridor search annotates each hit with its detour; a plain
              // near-a-point search has nothing to say here and renders none.
              (typeof h.offRouteM === "number"
                ? '<span class="hit-off">' + esc(fmtDist(h.offRouteM)) + " off</span> "
                : "") +
              '<span class="hit-ctx">' +
              esc(h.address) +
              "</span></li>",
          )
          .join("")
      );
    }

    // `role` is the chip's role, or the one parse() read out of the query. It
    // wins over the place's own type — the rider said "gas", so a convenience
    // store that came back among the stations is still the answer to a question
    // about fuel. roleForType() fills in only when nothing was asked for.
    /**
      * Paint one numbered dot per result and couple it to its row, both ways.
      *
      * A NUMBER RATHER THAN A NAME ON THE MAP, with the name on hover: twelve labels
      * overlapping each other is what would be unreadable.
      *
      * The row highlight is a class rather than a scroll — a list that jumps under the
      * pointer while the pointer is driving it fights the rider.
      */
    function showPreview(host, hits) {
      if (!state.map) return;
      // The search takes the slot, which also clears any meeting-point dots —
      // correct, because the rider has moved on to adding a place, and two sets
      // of numbered dots on one map would be unreadable.
      state.previewOwner = "search";
      setMeetApproaches(state.map, []);
      const rows = Array.from(host.querySelectorAll("li.hit-nearby"));
      setSearchPreview(
        state.map,
        // THE SAME TWO FACTS THE ROW SHOWS, in the same words: the name, and the
        // detour when the search was a corridor one. Built here rather than in
        // map-common.js so that file stays out of miles-versus-kilometers —
        // fmtDist() is already the one place that decision is made.
        hits.map((h) => ({
          lngLat: h.lngLat,
          name: h.name,
          tip: typeof h.offRouteM === "number" ? h.name + " · " + fmtDist(h.offRouteM) + " off" : h.name,
        })),
        (i) => rows.forEach((li, j) => li.classList.toggle("is-lit", j === i)),
        // PRESSING THE DOT PRESSES THE ROW, rather than repeating what the row's
        // handler does. That handler mints the point with its category role,
        // reads the open insert slot, pans and moves focus — four things a
        // second copy would drift from the first time any of them changed.
        (i) => rows[i] && rows[i].click(),
      );
      rows.forEach((li, j) => {
        li.addEventListener("pointerenter", () => highlightSearchPreview(state.map, j));
        li.addEventListener("pointerleave", () => highlightSearchPreview(state.map, null));
      });
    }

    function wireNearbyResults(host, hits, role) {
      host.querySelectorAll("li.hit-nearby").forEach((li) => {
        li.addEventListener("click", () => {
          const h = hits[Number(li.dataset.nearby)];
          if (!h) return;
          const r = Number(host.dataset.route);
          hideSearchResults();
          setActive(r);
          // Built here rather than letting addPoint mint a bare one, for the same
          // reason a saved place is: the role is the point of having searched by
          // category, and addPoint's auto-promotion leaves a supplied role alone.
          const pt = newPoint(h.lngLat[0], h.lngLat[1], h.name, h.address);
          const tag = role || QUERY.roleForType(h.type);
          if (tag) pt.roles = [tag];
          // AN OPEN `+` SLOT STILL WINS, which is #232's call intact: the
          // rider pressed the hairline between two points and said which
          // stretch they meant. Projection is the answer only when nothing was
          // pointed at — and when neither has one, addPoint() appends exactly as
          // it always did, which is right for On screen.
          const slot = openSlot(host);
          const at = slot != null ? slot : typeof h.insertAt === "number" ? h.insertAt : null;
          landPick(host, h.lngLat[0], h.lngLat[1], h.name, pt, at);
          panTo(state.map, h.lngLat, 13);
        });
      });
    }

    // One line, shown IN the dropdown rather than as a toast.
    //
    // Both of the states this covers used to be invisible. A search that threw
    // was a console.warn and nothing else; a search that matched nothing set
    // `hidden = true`, so "no results" and "the search is broken" were the same
    // empty box. That is how a server key missing the Places API would present:
    // type a query, get nothing, learn nothing.
    function noticeHtml(text) {
      return '<li class="hit-note">' + esc(text) + "</li>";
    }

    function searchErrorText(e) {
      const st = e && e.status;
      if (st === 401) return "Signed out—reload the page to search";
      if (st === 403) return "Your account cannot search yet";
      if (st === 503) return (e && e.message) || "Search is not configured";
      return "Search is unavailable right now";
    }

    function savedResultsHtml(list) {
      return list
        .map(
          (pl, i) =>
            '<li class="hit-saved" data-saved="' +
            i +
            '">' +
            '<span class="hit-badge">Saved</span> <strong>' +
            esc(pl.name) +
            "</strong> " +
            '<span class="hit-ctx">' +
            esc(pl.groupName || pl.address || "") +
            "</span></li>",
        )
        .join("");
    }

    // Rewired on every render because the list is rebuilt wholesale — the same
    // reason the search field itself is delegated rather than bound per input.
    const openSlot = (host) => (host.dataset.at === "" || host.dataset.at == null ? null : Number(host.dataset.at));

    // Which field the open list is answering: a route's add-row (`at` is the
    // insert slot, or null for the bottom row) or an existing row's name field
    // (`rep` is that point's index). One writer, so the stamps cannot disagree.
    function aimResults(results, route, at, rep) {
      results.dataset.route = String(route);
      results.dataset.at = at == null ? "" : String(at);
      results.dataset.replace = rep == null ? "" : String(rep);
    }
    const replacing = (results) =>
      results.dataset.replace === "" || results.dataset.replace == null ? null : Number(results.dataset.replace);

    // Where a pick lands: a NEW point, or the place under an existing one. The
    // dropdown is one element serving every add-row and every row's name field,
    // so it carries which it was opened for, and the three pick handlers ask
    // here rather than each deciding. `at` overrides the open slot for the one
    // caller that projects a corridor hit onto the route.
    function landPick(results, lng, lat, name, pt, at) {
      const r = Number(results.dataset.route);
      const rep = replacing(results);
      if (rep != null) {
        const point = state.routes[r] && state.routes[r].points[rep];
        if (!point) return;
        replacePoint(r, rep, lng, lat, name, pt, rowEditKey(point.kind, rep, "row-name"));
        // The kind is read AFTER the replace: a POI that took a category is a stop now.
        focusRow(point.kind, rep, r);
        return;
      }
      addPoint(lng, lat, name, r, pt, at === undefined ? openSlot(results) : at);
      // The add above re-rendered the list, so the row is a new element. Put the
      // cursor in its replacement: adding several stops in a row is the common
      // case and should not need a click between each one.
      const next = document.querySelector('.add-row[data-route="' + r + '"] .add-search');
      if (next) next.focus();
    }

    function wireSavedResults(host, list) {
      host.querySelectorAll("li.hit-saved").forEach((li) => {
        li.addEventListener("click", () => {
          const pl = list[Number(li.dataset.saved)];
          if (!pl) return;
          const r = Number(host.dataset.route);
          hideSearchResults();
          setActive(r);
          // Built here and handed in, rather than letting addPoint mint a bare
          // point: the roles and the durable details are the reason a saved
          // place is worth having.
          const pt = stopFromPlace(pl);
          landPick(host, pl.lng, pl.lat, pl.name, pt);
          panTo(state.map, [pl.lng, pl.lat], 11);
        });
      });
    }

    // Delegated on #route-list, because renderRoutes() replaces every one of these
    // fields on any structural change. Binding per input would either be lost
    // on the next render or leak a listener per render.
    host.addEventListener("input", (e) => {
      // A ROW'S NAME FIELD IS THE SAME SEARCH. Typing renames — wireList()'s
      // handler already wrote the keystroke into point.name — and a pick from
      // the list that opens under it REPLACES the place through replacePoint().
      // The row knows its point, so `rep` is its index and there is no slot.
      const input = e.target.closest(".add-search, .row-name");
      if (!input) return;
      const isRow = input.classList.contains("row-name");
      const route = Number(input.closest(isRow ? ".point-row" : ".add-row").dataset.route);
      const rep = isRow ? Number(input.closest(".point-row").dataset.i) : null;
      const at = isRow ? null : slotOf(input);
      clearTimeout(searchTimer);
      const q = input.value.trim();

      // Saved places first, and they are drawn IMMEDIATELY — no debounce, no
      // network, no minimum length beyond one character. Typing "bob" surfaces
      // your own "Bob's Gas" before Google has been asked anything, which is the
      // whole reason to have a library. The predictions land underneath 300ms
      // later and are appended rather than replacing these.
      const saved = matchSavedPlaces(q);
      if (saved.length) {
        aimResults(results, route, at, rep);
        results.innerHTML = savedResultsHtml(saved);
        results.hidden = false;
        placeResults(input, results);
        wireSavedResults(results, saved);
      } else if (q.length < 3) {
        hideSearchResults();
      }

      if (q.length < 3) return;
      searchTimer = setTimeout(async () => {
        // Predictions come back out of order often enough to matter; a slow
        // early keystroke must not overwrite a fast later one.
        const mine = ++searchSeq;
        // A CATEGORY QUERY RUNS BOTH SEARCHES. Autocomplete still answers, because
        // "coffee" might be the name of the place the rider means; the category
        // results are appended under a heading. parse() returns null for anything
        // that reads as a name, and that is the common case — a Text Search call
        // is the expensive one and it only fires when the query genuinely asks
        // for a kind of place.
        const cat = QUERY.parse(q);
        // CLEARED BEFORE EVERY SEARCH, the same reason categorySearch() clears
        // it: a typed query can now run the corridor, so it can also raise the
        // partial-coverage note — and leaving one standing would hang it above
        // an answer that searched exactly what it said it did.
        corridorPartial = false;
        try {
          // allSettled, NOT all. These are two independent services and either
          // can fail on its own — the category search in particular fails
          // wholesale when the server key has no Places API on it. With
          // Promise.all one rejection took the other answer down with it, so a
          // misconfigured category search would have broken name search too,
          // which is a strictly worse bug than the one being fixed.
          const [nameRes, nearRes] = await Promise.allSettled([
            searchPlaces(state.map, q),
            // No anchor when the text names a place: Text Search reads it out of
            // the query, and biasing to the rider's current position as well
            // would pull the answer back home.
            cat ? typedCategoryHits(cat, q, route, at, rep) : [],
          ]);
          if (mine !== searchSeq) return;
          const hits = nameRes.status === "fulfilled" ? nameRes.value : [];
          const nearby = nearRes.status === "fulfilled" ? nearRes.value : [];
          // Whichever half failed, named. Both failing is the interesting case
          // and it falls through to the catch below via this throw.
          const failed = [nameRes, nearRes].filter((x) => x.status === "rejected");
          if (failed.length === 2) throw failed[0].reason;
          if (nearRes.status === "rejected") console.warn("[builder] category search:", nearRes.reason.message);
          if (nameRes.status === "rejected") console.warn("[builder] name search:", nameRes.reason.message);
          // The rows may have been rebuilt out from under this response, in
          // which case the field it was for no longer exists.
          if (!input.isConnected) return;
          aimResults(results, route, at, rep);
          // Saved matches keep their place at the top; the predictions are
          // appended under them. Re-derived rather than read off the DOM so a
          // response that arrives after the query changed cannot pair the new
          // predictions with the old library rows.
          const savedNow = matchSavedPlaces(input.value.trim());
          const nothing = hits.length === 0 && savedNow.length === 0 && nearby.length === 0;
          results.innerHTML =
            savedResultsHtml(savedNow) +
            hits
              .map(
                (h, i) =>
                  '<li class="hit-google" data-i="' +
                  i +
                  '"><strong>' +
                  esc(h.name) +
                  "</strong> " +
                  '<span class="hit-ctx">' +
                  esc(h.context) +
                  "</span></li>",
              )
              .join("") +
            nearbyResultsHtml(nearby) +
            // SAID OUT LOUD, not left as an empty box. "Nothing matched" and
            // "the search broke" were pixel-identical before this.
            // NAMES THE VIEWPORT, because the search is restricted to it and a
            // rider who is told only "no matches" has no reason to think
            // zooming out would help. See searchPlaces() in map-common.js for
            // why there is no automatic fallback to widen it for them.
            (nothing ? noticeHtml(typedEmptyText(q, cat, at, rep)) : "") +
            // One half down while the other answered: the results still show,
            // with a line saying what is missing. Silently returning half an
            // answer is how a broken category search would go unnoticed for a
            // week.
            (nearRes.status === "rejected" ? noticeHtml(searchErrorText(nearRes.reason)) : "") +
            (nameRes.status === "rejected" && nearby.length ? noticeHtml("Name search is unavailable") : "");
          results.hidden = false;
          placeResults(input, results);
          wireSavedResults(results, savedNow);
          wireNearbyResults(results, nearby, cat && cat.role);
          // ONLY THE CATEGORY BLOCK GETS DOTS HERE, and that is a limit rather
          // than an oversight: a `hit-google` name match carries no coordinates
          // until it is picked, because Place Details bills per call and
          // resolving five to draw five dots would cost five times as much for a
          // rider who is going to choose one. The numbering follows the nearby
          // rows, which sit under their own heading.
          showPreview(results, nearby);
          results.querySelectorAll("li.hit-google").forEach((li) => {
            li.addEventListener("click", async () => {
              // Coordinates are fetched only for the pick — Place Details bills
              // per call, so resolving all five would cost five times as much.
              const picked = await hits[Number(li.dataset.i)].resolve().catch(() => null);
              if (!picked) return toast("Could not locate that place", true);
              const [lng, lat] = picked.lngLat;
              // Read the route off the open list rather than the closure: it is
              // the same value, and taking it from one place means a stale
              // closure can never put a stop on the wrong route.
              const r = Number(results.dataset.route);
              hideSearchResults();
              // The route whose row was used becomes the active one, so a map
              // click afterwards continues where the rider is working rather
              // than wherever they last clicked.
              setActive(r);
              // A point rather than a bare add, only so the address travels: it
              // is the one thing addPoint() cannot re-derive from coordinates.
              landPick(results, lng, lat, picked.name, newPoint(lng, lat, picked.name, picked.address));
              panTo(state.map, picked.lngLat, 11);
            });
          });
        } catch (e) {
          console.warn("[builder] search:", e.status || "", e.message);
          if (mine !== searchSeq || !input.isConnected) return;
          // The failure REACHES THE RIDER. This was a bare console.warn, so a
          // referrer-restricted key, a pending account or a Places API that was
          // never enabled all presented as an empty dropdown and no explanation.
          aimResults(results, route, at, rep);
          results.innerHTML = noticeHtml(searchErrorText(e));
          results.hidden = false;
          placeResults(input, results);
        }
      }, 300);
    });

    host.addEventListener("click", (e) => {
      const btn = e.target.closest(".add-place-btn");
      if (!btn || btn.disabled) return;
      armPlace(Number(btn.dataset.route), slotOf(btn));
    });

    // Opening a gap. Re-rendered rather than patched in place: the row that replaces
    // the hairline is a real .add-row whose handlers are all delegated on #route-list
    // and resolve from data attributes, so building it through the normal render is
    // what makes an inserted point behave identically to an appended one.
    //
    // NOT an edit. No beginEdit, no markDirty — opening a field changes nothing about
    // the ride, and putting it on the undo stack would make Ctrl-Z close a text box.
    host.addEventListener("click", (e) => {
      // The whole strip, not only the glyph — an 18px full-width row is something
      // a thumb can hit, an 18px square is not. .insert-btn is still inside it and
      // carries the accessible label, so the keyboard path is unchanged.
      const btn = e.target.closest(".insert-slot");
      if (!btn) return;
      const r = Number(btn.dataset.route);
      const at = Number(btn.dataset.at);
      // undefined rather than null when the attribute is absent, so a point
      // slot and a shaping point's slot at the same index stay distinguishable.
      const via = btn.dataset.via == null ? null : Number(btn.dataset.via);
      // A second press on the same gap closes it, matching how the arm button
      // toggles rather than needing a separate dismiss.
      const open = state.insertAt;
      const same = open && open.route === r && open.at === at && open.via === via;
      state.insertAt = same ? null : { route: r, at: at, via: via };
      // Arming belongs to the row that armed it, and that row may have just
      // stopped existing.
      disarmPlace();
      hideSearchResults();
      setActive(r);
      renderRouteList(r);
      const field = document.querySelector('.add-row.is-insert[data-route="' + r + '"] .add-search');
      if (field) field.focus();
    });

    // A CHIP IS A SEARCH, not a mode: one tap runs the category search and opens the
    // same dropdown a typed query would, so a chip cannot behave differently from
    // typing the same words. The field is left empty on purpose — filling it would
    // look typed and be re-searched on the next keystroke.
    // The search scope. PATCHED IN PLACE, NEVER RE-RENDERED: rebuilding the route
    // list would destroy whatever is in the add-row's field and drop focus to <body>
    // (#188). It also does not mark the ride dirty — how a rider is searching is not
    // a change to the ride.
    //
    // The flag is session-wide, so every route's control is repainted: a rider who
    // switched at route 3 must not find Near here lit at route 1.
    host.addEventListener("click", (e) => {
      const btn = e.target.closest(".scope-btn");
      if (!btn) return;
      state.corridorOn = btn.dataset.along === "1";
      document.querySelectorAll(".scope-btn").forEach((el) => {
        const on = (el.dataset.along === "1") === state.corridorOn;
        el.classList.toggle("is-on", on);
        el.setAttribute("aria-pressed", on ? "true" : "false");
      });
      // The chips' tooltips name the scope, so they go stale otherwise — but a
      // SLOT chip's does not, because a slot searches its own leg whichever
      // scope is selected. Retitling those would have the tooltip promise
      // something the search does not do.
      document.querySelectorAll(".add-chips .chip").forEach((el) => {
        const spec = CHIPS.find((c) => c.role === el.dataset.chip);
        if (!spec || el.dataset.at != null) return;
        el.title = chipTitle(spec, false);
      });
    });

    host.addEventListener("click", async (e) => {
      // "Find somewhere to stay" runs the SAME search a Lodging chip does, over
      // the stretch of road around the rider's bedtime instead of the whole route.
      // It is routed through categorySearch() rather than repeating the render,
      // the preview, the error text and the sequence guard — five things a
      // second copy would drift from the first time any of them changed.
      const bed = e.target.closest(".row-bedtime-btn");
      if (bed) {
        const r = Number(bed.dataset.route);
        const entry = stopByPoints().find((x) => x.routeIndex === r);
        if (!entry) return;
        const stretch = stopByStretch(entry);
        if (!stretch || stretch.length < 2) return;
        return categorySearch({
          r,
          at: null,
          spec: CHIPS.find((c) => c.role === "hotel"),
          input: null,
          track: stretch,
          near: entry.at,
        });
      }
      const chip = e.target.closest(".chip");
      if (!chip || chip.disabled) return;
      const r = Number(chip.dataset.route);
      const spec = CHIPS.find((c) => c.role === chip.dataset.chip);
      if (!spec || !state.routes[r]) return;
      const at = slotOf(chip);
      const row = chip.closest(".add-row");
      const input = row ? row.querySelector(".add-search") : null;
      return categorySearch({ r, at, spec, input });
    });

    /**
     * One category search, however it was asked for.
     *
     * `track` and `near` are the bedtime button's: an explicit stretch of road to
     * search instead of the route or the screen. Without them this behaves exactly
     * as the chips always did.
     */
    async function categorySearch({ r, at, spec, input, track, near }) {
      if (!spec || !state.routes[r]) return;
      const results = searchResultsEl();
      aimResults(results, r, at, null);
      const mine = ++searchSeq;
      // Something in the box immediately: a billed round trip with no feedback
      // reads as a dead button, and this one is a button.
      results.innerHTML = noticeHtml("Finding " + spec.label.toLowerCase() + "…");
      results.hidden = false;
      if (input) placeResults(input, results);
      try {
        let nearby;
        // CLEARED BEFORE EVERY SEARCH, so the partial-coverage note belongs to
        // THIS answer. Left standing, a corridor search on a very long route would
        // put its warning above the next On screen search, which searched
        // exactly what it said it did.
        corridorPartial = false;
        // A SLOT OUTRANKS THE SCOPE, AND THAT IS THE WHOLE OF #232's SECOND HALF.
        // Pressing the + between Oakland and Benbow is the rider pointing at that stretch
        // of road, so a slot search is always the leg's corridor and the Route / On
        // screen control governs only the bottom add-row. Ziad's call, 2026-09-02.
        // AN EXPLICIT STRETCH OUTRANKS EVERYTHING, for the same reason.
        if (track) {
          nearby = await corridorRun(spec.query, track, trackLengthM(track), near);
        } else {
          const leg = at == null ? null : legAnchor(state.routes[r], at);
          if (leg) {
            nearby = await corridorRun(spec.query, leg.track, leg.totalM, leg.near);
          } else if (state.corridorOn) {
            const args = corridorSearchArgs(r);
            nearby = await corridorRun(spec.query, args.track, args.totalM, args.near);
            // ONLY THIS BRANCH. The two above searched a stretch the rider
            // pointed at — a slot's own leg, or the band's explicit track — and
            // their hits are placed by that, so their atIndex indexes a track
            // that is not the route and must not be read as one.
            placeAlongRoute(nearby, args.spans);
          } else {
            const view = screenAnchor(r);
            nearby = await nearbySearch(spec.query, view && view.near, view && { radiusM: view.radiusM });
          }
        }
        if (mine !== searchSeq) return;
        results.innerHTML =
          nearbyResultsHtml(nearby) ||
          noticeHtml(
            // "within 15 mi of this route" named a distance from a DAY, which is
            // not a thing a rider can picture — reported as unreadable in #232.
            // It is a stretch of ROUTE the corridor is measured from, and each
            // line names the stretch it actually searched, because the three
            // cases are three different questions and a rider who is told the
            // wrong one goes looking in the wrong place.
            emptyText(spec, at != null),
          );
        results.hidden = false;
        if (input) placeResults(input, results);
        wireNearbyResults(results, nearby, spec.role);
        showPreview(results, nearby);
      } catch (err) {
        console.warn("[builder] chip search:", err.status || "", err.message);
        if (mine !== searchSeq) return;
        results.innerHTML = noticeHtml(searchErrorText(err));
        results.hidden = false;
        if (input) placeResults(input, results);
      }
    }

    // Escape dismisses the suggestions without clearing the query — the rider
    // may have meant to close the list, not to start over.
    host.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !e.target.closest(".add-search, .row-name")) return;
      // The dropdown first, then the row. Two presses to back all the way out of
      // an insert, which is the same shape as closing a menu inside a dialog —
      // one Escape should not dismiss two things.
      if (resultsEl && !resultsEl.hidden) {
        e.stopPropagation();
        hideSearchResults();
        return;
      }
      if (state.insertAt && e.target.closest(".add-row.is-insert")) {
        e.stopPropagation();
        const r = state.insertAt.route;
        state.insertAt = null;
        renderRouteList(r);
      }
    });

    document.addEventListener("click", (e) => {
      if (e.target.closest(".add-row") || e.target.closest(".row-name") || e.target.closest("#search-results")) return;
      hideSearchResults();

      // THE + THAT OPENS A SLOT IS AN OUTSIDE CLICK BY THIS TEST. Both handlers
      // see the same event — the delegated one on #route-list opens the row, then
      // this one bubbles and would close it again, so clicking + did nothing at
      // all. Observed, not theorized.
      if (e.target.closest(".insert-slot")) return;

      // AN UNUSED INSERT ROW CLOSES ITSELF. It is an affordance, not a form: leaving it
      // open puts a stray search box in the middle of a route that nothing will clear.
      // The bottom add-row is untouched — that one belongs to the route.
      //
      // NOT WHEN SOMETHING IS ARMED, and this is the case that makes the guard
      // necessary: arming "+ Point" and clicking the map is the whole point of the
      // button, and that map click is an outside click. The insert clears
      // state.insertAt when it completes, so the row still goes away — after doing its
      // job rather than instead of it.
      if (state.insertAt && state.arm == null) {
        const r = state.insertAt.route;
        state.insertAt = null;
        renderRouteList(r);
      }
    });
  }

  // Ticking boxes and the bar's buttons. Delegated on the panel because
  // renderRoutes() replaces every checkbox on every structural change.
  function wireSelect() {
    const panel = document.querySelector(".builder-panel");
    if (!panel) return;

    panel.addEventListener("change", (e) => {
      const sel = state.select;
      if (!sel) return;
      const el = e.target;
      if (el.classList.contains("route-pick")) {
        const r = Number(el.dataset.route);
        if (el.checked) sel.routes.add(r);
        else sel.routes.delete(r);
        return renderSelectBar();
      }
      if (el.classList.contains("row-pick")) {
        const key = pointKey(Number(el.dataset.route), el.dataset.kind, Number(el.dataset.i));
        if (el.checked) sel.points.add(key);
        else sel.points.delete(key);
        return renderSelectBar();
      }
      // The move-to picker fires `change` rather than `click`, so it is handled
      // here rather than below with the buttons.
      if (el.dataset.sel === "move-to" && el.value !== "") {
        const to = Number(el.value);
        el.value = "";
        moveSelectedPoints(to);
      }
    });

    panel.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-sel]");
      if (!btn || btn.tagName === "SELECT") return;
      const sel = state.select;
      if (!sel) return;
      const act = btn.dataset.sel;
      if (act === "done") return endSelect();
      if (act === "none") {
        sel.routes.clear();
        sel.points.clear();
        renderRoutes();
        return renderSelectBar();
      }
      if (act === "all") {
        if (sel.scope === "route") state.routes.forEach((_, r) => sel.routes.add(r));
        else {
          state.routes.forEach((route, r) => {
            route.points.forEach((pt, i) => sel.points.add(pointKey(r, pt.kind, i)));
          });
        }
        renderRoutes();
        return renderSelectBar();
      }
      if (act === "delete") return sel.scope === "route" ? deleteSelectedRoutes() : deleteSelectedPoints();
      if (act === "duplicate") return duplicateSelectedRoutes();
      if (act === "group") return groupSelectedAsAlts();
    });
  }

  // --- Save / load ----------------------------------------------------------

  function payload() {
    return {
      // The revision this edit is based on. Read at serialize time, like every
      // other field here — see the editSeq comment for why that instant matters.
      rev: state.rev,
      routeBase: state.routeBase,
      // FALLS BACK HERE TOO, not only in the field's blur handler. A draft
      // restored from before the default existed carries an empty title, and
      // fields.title is min(1) server-side — so an empty string 400s the whole
      // save and the rider is told nothing useful about why.
      title: state.meta.title.trim() || UNTITLED,
      description: state.meta.description,
      visibility: state.meta.visibility,
      external_url: state.meta.external_url,
      subgroups: state.meta.subgroups,
      primarySubgroup: state.meta.primarySubgroup,
      trunkSubgroup: state.meta.trunkSubgroup,
      timeAnchor: state.meta.timeAnchor,
      stopByMin: state.meta.stopByMin,
      vehicle: state.meta.vehicle,
      power: state.meta.power,
      // The API requires at least one stop per route, so a route you added but
      // never filled in would fail validation for the whole ride. Dropping it
      // is what the rider means; save() warns when it happens.
      routes: state.routes
        .filter((r) => r.points.length > 0)
        .map((r) => ({
          uid: r.uid,
          subgroupUid: r.subgroupUid,
          title: r.title,
          color: r.color,
          startAt: r.startAt,
          endAt: r.endAt,
          // The server re-resolves these on every save — dissolving a group of
          // one, electing an active member, renumbering densely — so what comes
          // back may not be what went out. That is the contract, not a bug: see
          // resolveAltGroups. Note a route dropped by the filter above can leave a
          // group with one member, which is exactly the case that dissolves.
          altGroup: r.altGroup,
          altActive: r.altActive,
          routePrefs: r.routePrefs ?? null,
          points: r.points,
          legs: r.legs,
        })),
    };
  }

  // Warned once per episode rather than on every flush. Autosave calls save()
  // several times a minute, and a rider who has added a route and not yet given it
  // a stop would otherwise be told about it continuously for as long as it takes
  // them to add one. Reset when nothing is being dropped, so the next episode
  // warns again.
  let warnedDropped = false;

  /**
    * Save and actually wait for it to have landed.
    *
    * **`save()` CANNOT BE AWAITED, AND THAT IS A LATENT BUG EVERYWHERE IT IS.** It
    * opens with `if (state.saving) return`, so awaiting it mid-flight returns having
    * written nothing. `#riders-save` mostly gets away with it; the split flow cannot,
    * because it reads a brand-new group's server id back out of the write and
    * `setRouteRiders` SILENTLY coerces an unknown group to null — a peel-off route
    * claiming everybody rides as the main group.
    *
    * Polls rather than hooking the request, because what is being waited for is "the
    * tree is clean", which a re-queued save satisfies only on its second pass.
    * Bounded, so a ride that will not save reports false instead of hanging the
    * dialog.
    */
  async function saveNow(tries) {
    const limit = tries || 12;
    for (let n = 0; n < limit; n++) {
      if (!state.saving) save();
      await new Promise((done) => setTimeout(done, 250));
      if (!state.dirty && !state.saving) return true;
    }
    return false;
  }

  async function save() {
    if (state.saving) return;
    // Unreachable while markDirty holds the line, and here because a save is the
    // one thing in this file that cannot be allowed to happen by a route nobody
    // thought of.
    if (!CAN_EDIT) return;
    const body = payload();
    const dropped = state.routes.length - body.routes.length;
    if (dropped > 0 && !warnedDropped) {
      warnedDropped = true;
      toast(dropped + " empty route" + (dropped > 1 ? "s" : "") + " not saved—add a stop to it");
    } else if (dropped === 0) {
      warnedDropped = false;
    }

    // Captured BEFORE the fetch, beside the payload it belongs to. See the
    // editSeq comment above for why the two have to be read at the same instant.
    const sentSeq = editSeq;

    state.saving = true;
    setSaveStatus("saving");
    try {
      const res = await fetch(state.rideId ? "/api/rides/" + state.rideId : "/api/rides", {
        method: state.rideId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      // A STALE SAVE IS NOT AN ERROR TO RETRY, WHICH IS WHY IT IS HANDLED SEPARATELY.
      // The catch below re-arms a timer, right for any other failure — but here the
      // request was REFUSED because somebody else wrote to this ride, so trying again
      // is a second attempt to overwrite them, every fifteen seconds.
      //
      // Nothing local is thrown away: state.routes still holds this rider's work and
      // the draft still holds the crash copy. The ride is left dirty on purpose.
      if (res.status === 409) {
        state.conflict = true;
        clearTimeout(retryTimer);
        retryTimer = null;
        setSaveStatus("conflict");
        return;
      }
      if (!res.ok) throw new Error(data.error || "save failed (" + res.status + ")");
      // Straight back out on the next save. Dropping this is how the SECOND
      // save of a session 409s against a ride nobody else has touched.
      if (typeof data.rev === "number") state.rev = data.rev;
      // REBASE ON WHAT WAS ACTUALLY STORED, BUT ONLY FOR ROUTES THIS BUILDER HOLDS.
      // Without the rebase, the second save of a session is based on hashes the first
      // invalidated and every route reads as contested. Without the FILTER it is
      // worse: the server's map includes routes another rider has just added, and a uid
      // in routeBase missing from the payload is exactly how the merge is told "the
      // rider deleted this" — so the next autosave would erase their new routes.
      if (data.routeBase) {
        const held = new Set(state.routes.map((d) => d.uid));
        const next = {};
        for (const uid in data.routeBase) if (held.has(uid)) next[uid] = data.routeBase[uid];
        state.routeBase = next;
      }

      // THIS BUILDER IS NOW STALE, AND SAVING AGAIN WOULD UNDO SOMEBODY.
      //
      // `superseded` means a route this rider edited was kept from the database
      // instead, so state.routes still holds their rejected version and the rebase has
      // just made its base match — the very next autosave would win, delaying the
      // clobber by three seconds rather than preventing it.
      //
      // `adopted` means another rider added routes this builder has never seen: nothing
      // is lost by saving, but the panel is showing a ride that is missing routes.
      //
      // Both stop the loop and ask for a reload. Two riders on DIFFERENT routes reach
      // neither, which is the whole point of merging per route.
      const clashed = (data.superseded || []).length + (data.adopted || []).length;
      if (clashed > 0) {
        state.conflict = true;
        clearTimeout(retryTimer);
        retryTimer = null;
        setSaveStatus("conflict");
        return;
      }
      if (!state.rideId) {
        state.rideId = data.id;
        history.replaceState(null, "", "/builder/" + data.id);
        // The draft was filed under "new"; move it before it becomes an orphan
        // that offers itself to the next new ride.
        HIST.Draft.adopt(state.rideId);
        // THE FIRST SAVE IS WHEN A NEW RIDE GETS A ROSTER, and the prefetch in
        // init() ran before there was one to read — it returns immediately on a
        // ride with no id. Without this the Riders tab's count stays blank on
        // every newly planned ride until the rider happens to open it, which is
        // exactly the ride where they are least likely to think to look.
        loadRiders();
        // AND WHO IS ON WHICH ROUTE, for the same reason: it returns immediately
        // on a ride with no id, so a newly planned ride would show no rider line
        // on any route until something else happened to reload it.
        loadRouteRiders();
        // NOT initComments() here. Its host element is server-rendered only for
        // a ride that already has an id, so on a brand-new ride there is nothing
        // in the DOM to bind to and it would return without doing anything.
        // Comments appear on the next load of the builder, which is the same
        // moment the Delete control does, and for the same reason.
      }
      if (data.slug) showViewLink(data.slug);

      // Did this response cover everything, or did the rider keep working
      // through it? Both branches are load-bearing.
      if (editSeq !== sentSeq) {
        // It did not. Stay dirty, keep the draft, and go round again — this is
        // the re-queue that makes the mid-flight keystroke survive.
        setSaveStatus("dirty");
        queueAutosave();
        return;
      }
      state.dirty = false;
      // Clean, and the one moment the draft is provably redundant. Note this
      // sits AFTER the check above on purpose: clearing it on a partial save
      // would throw away the crash copy of the very edits still outstanding.
      clearTimeout(draftTimer);
      HIST.Draft.clear(state.rideId);
      draftFailed = false;
      setSaveStatus("saved");
      // A SAVE IS WHAT GIVES A NEW SUBGROUP AN id, and an id is what the Riders
      // tab's picker assigns by — so the tab is stale the moment the set of uids
      // changes. Compared against the cache rather than invalidated on every
      // save: autosave fires on idle throughout a session and re-reading the
      // roster after each one would be a request per edit burst for an answer
      // that did not change.
      if (ridersCache && !sameGroupUids(ridersCache.groups, state.meta.subgroups)) ridersStale();
    } catch (e) {
      // The message goes to the status line, not to a toast: an autosave that
      // fails once tends to fail again, and one toast per attempt would bury the
      // panel. The failure is also not fatal — the localStorage draft still has
      // the work, and the retry below usually clears it without the rider ever
      // needing to act.
      setSaveStatus("error", e.message);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(flushNow, AUTOSAVE_RETRY_MS);
    } finally {
      state.saving = false;
    }
  }

  function sameGroupUids(a, b) {
    if (a.length !== b.length) return false;
    const seen = new Set(a.map((g) => g.uid));
    return b.every((g) => seen.has(g.uid));
  }

  // The link to the public page, revealed once and never hidden again. It is
  // rendered from the start and only made visible here — see the markup comment
  // in src/routes/builder.ts for why it is `visibility` and not `hidden`.
  function showViewLink(slug) {
    state.slug = slug;
    showExport(slug);
    const a = $("view-link");
    if (!a) return;
    a.href = "/m/" + encodeURIComponent(slug);
    a.classList.remove("is-empty");
  }

  // The export block's hrefs, filled in the same moment the View link is.
  //
  // A NEW RIDE HAS NO SLUG, so the server renders this hidden with every href a
  // "#" — a live-looking link to a ride that does not exist is worse than no link.
  // The first successful save mints the slug and this reveals the block.
  //
  // Rebuilt from `data-export`, which carries the path segment, rather than by
  // index: a positional loop would silently point the zips at the wrong format the
  // first time the order changed.
  function showExport(slug) {
    const box = $("builder-export");
    if (!box || !slug) return;
    box.hidden = false;
    box.querySelectorAll("[data-export]").forEach((a) => {
      const what = a.getAttribute("data-export");
      // Only the whole-ride formats take ?dl. A zip is already an attachment by
      // virtue of being a zip, and the flag would be noise on the URL.
      const dl = what.indexOf("zip/") === 0 ? "" : "?dl";
      a.href = "/api/public/maps/" + encodeURIComponent(slug) + "/" + what + dl;
    });
  }

  async function loadExisting() {
    const res = await fetch("/api/rides/" + state.rideId);
    if (!res.ok) throw new Error("could not load ride");
    const ride = await res.json();
    state.meta = {
      title: ride.title,
      description: ride.description,
      visibility: ride.visibility,
      external_url: ride.external_url,
      // The other half of payload()'s round-trip. Omitting any of these is how a
      // rider's whole subgroup setup works perfectly until they reload — worse here
      // than the altGroup case, because the routes keep their tags while the subgroups
      // they name stop existing.
      // SEEDED ON LOAD WHEN A STORED RIDE HAS NONE, which every ride planned before
      // 2026-09-03 does. The alternative was a backfill against live rider data. A ride
      // created outside the builder and never opened in it still has none, which is the
      // known limit of doing it here.
      subgroups: (ride.subgroups || []).length ? ride.subgroups : [seedGroup()],
      primarySubgroup: ride.primarySubgroup ?? null,
      trunkSubgroup: ride.trunkSubgroup ?? null,
      timeAnchor: ride.timeAnchor || "departure",
      // `?? null` rather than `||`: midnight is 0 and a real answer, and `||`
      // would turn "start looking at 00:00" into "never said".
      stopByMin: ride.stopByMin ?? null,
      vehicle: ride.vehicle ?? null,
      power: ride.power ?? null,
    };
    // ORDER IS RANK, SO THE STORED MAIN GROUP IS MOVED TO THE FRONT rather than the
    // column being trusted where it sits. A ride saved before 2026-09-03 could name
    // any group as primary while `position` put it third, and the panel now says the
    // top row is the main group — so one has to give, and it is the order, because
    // that is the thing the rider was never asked about.
    //
    // THE MAIN GROUP MAY NEVER BE NULL: a null column or one naming a deleted group
    // both fall through to the first group.
    const wasPrimary = state.meta.subgroups.findIndex((g) => g.uid === state.meta.primarySubgroup);
    if (wasPrimary > 0) {
      state.meta.subgroups.splice(0, 0, state.meta.subgroups.splice(wasPrimary, 1)[0]);
    }
    state.meta.primarySubgroup = state.meta.subgroups[0].uid;
    // `?? null` because rev 0 is a real, current revision — a ride nobody has
    // saved since the column landed — and `||` would send it as null and turn
    // the check off for exactly the rides that have never been contested.
    state.rev = ride.rev ?? null;
    state.conflict = false;
    // Built from what the SERVER sent, never computed here. The hash is the
    // server's own record of what it stored; a second implementation in this
    // file would drift and every route would read as contested.
    state.routeBase = {};
    for (const r of ride.routes || []) {
      if (r.uid && r.contentHash) state.routeBase[r.uid] = r.contentHash;
    }
    // Every route loads. This used to take routes[0] and warn that saving would
    // drop the rest, which made multi-route rides effectively read-only.
    state.routes = (ride.routes || []).map(routeFromPayload);
    state.routes.forEach(fillMissingLegs);
    // Nothing has changed the route yet, so a stored end that matches what the
    // route derives is one we wrote — anything else the rider chose themselves.
    state.routes.forEach((r) => {
      r.endManual = inferEndManual(r);
    });
    if (state.routes.length === 0) state.routes = [newRoute()];
    $("ride-title").value = state.meta.title;
    $("ride-description").value = state.meta.description;
    setFieldValue("ride-visibility", state.meta.visibility);
    renderVehicle();
    // MISSED ON THE LOAD PATH FIRST TIME ROUND. The snapshot render calls this
    // and this one did not, so a stop-by time set, saved and reloaded came back
    // to an empty field — the value was in state and on the server, and the one
    // control that shows it never heard. Every ride-level field has to be listed
    // in BOTH places, which is the shape of this bug and the reason they sit
    // together here.
    renderStopBy();
    fitTitle();
    // What was just loaded IS what the server holds, so the panel opens on
    // "Saved" rather than on the "Not saved yet" a new ride starts at.
    setSaveStatus("saved");
    if (ride.slug) showViewLink(ride.slug);
  }

  // --- Init -----------------------------------------------------------------

  // ALL DELEGATED ON #route-list, because there are N of every one of these now and
  // renderRoutes() replaces the lot on any change to the set of routes. A bound
  // listener would go with the element it was bound to.
  //
  // Every handler starts by making the touched route active. That single line is
  // what let the ~15 shared edit functions below keep reading editIndex() when
  // the panel went from one visible route to all of them.
  function wireRoutes() {
    $("time-slider").addEventListener("input", (e) => setMoment(momentFromSlider(Number(e.target.value))));
    // Delegated on the pill, so the two segments need no handler each and
    // renderTimeScope can rewrite them freely.
    $("time-scope")?.addEventListener("click", (e) => {
      const seg = e.target.closest(".time-seg");
      if (seg) setTimeScope(seg.dataset.scope === "ride" ? "ride" : "route");
    });
    // Repaints rather than re-rendering: the ring is a map overlay, so nothing
    // in the panel changes and rebuilding the route list would cost a rider the
    // field they are typing in — the #188 shape, reached from a map control.
    $("range-ring")?.addEventListener("click", () => {
      state.ringOn = !state.ringOn;
      renderRingToggle();
      applyFocus();
    });
    $("rail-routes").addEventListener("click", (e) => {
      const btn = e.target.closest(".rail-route");
      if (!btn) return;
      const r = Number(btn.dataset.route);
      goToRoute(r);
      // The rail is a jump list, so it scrolls as well as selects. Harmless while
      // the drawer is collapsed and the sections are not on screen — it is the
      // reopened drawer that lands in the right place.
      const sec = routeSection(r);
      if (sec) sec.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    $("route-add").addEventListener("click", addRoute);
    wireSubgroups();

    // Only present on a saved ride — see the markup in src/routes/builder.ts.
    const del = $("ride-delete");
    if (del) del.addEventListener("click", deleteRide);

    const host = $("route-list");

    // Pointerdown rather than click: it fires before focus moves, so tabbing or
    // clicking into a field has already set the right active route by the time any
    // other handler runs.
    host.addEventListener("pointerdown", (e) => setActiveFromEl(e.target));
    host.addEventListener("focusin", (e) => setActiveFromEl(e.target));

    host.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const sec = btn.closest(".route-section");
      if (!sec) return;
      const r = Number(sec.dataset.route);
      setActive(r);
      if (btn.classList.contains("route-twirl")) {
        const shut = sec.classList.toggle("is-shut");
        btn.setAttribute("aria-expanded", String(!shut));
        return;
      }
      if (btn.classList.contains("pref-btn")) return togglePref(r, btn);
      if (btn.classList.contains("route-riders")) return openRouteRiders(Number(btn.dataset.route));
      // The group checkboxes are inside a <details> in the route head. Delegated
      // like everything else here, because renderRoutes() replaces the lot.
      if (btn.dataset && btn.dataset.group) return;
      if (btn.classList.contains("route-rev")) return reverseRoute();
      if (btn.classList.contains("route-menu-btn")) {
        return toggleRouteMenu(sec.querySelector(".route-head"), btn, r);
      }
      if (btn.classList.contains("row-menu-item") && btn.closest(".route-head")) {
        // Close first: every one of these re-renders, and a menu still attached
        // to a section that is about to be replaced would be orphaned mid-click.
        const act = btn.dataset.act;
        closeMenu();
        if (act === "route-delete") return deleteRoute();
        if (act === "route-duplicate") return duplicateRoute(r);
        if (act === "route-promote") return promoteAlt(r);
        if (act === "route-ungroup") return ungroupAlts(r);
        if (act === "route-select") return startSelect("route");
        return;
      }
      // Ticking a route. Not delegated through setActive above — a checkbox is
      // about the set, not about where the next map click lands.
      if (btn.classList.contains("route-pick")) return;
    });

    // The keyboard half of the drag handle. Reordering was two buttons until
    // 2026-08-16; the grip carries it now so the header keeps its width.
    // preventDefault because the drawer scrolls, and an arrow key that both moves
    // the route and scrolls the panel loses the route off the screen.
    host.addEventListener("keydown", (e) => {
      const grip = e.target.closest(".route-drag");
      if (!grip) return;
      const dir = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      if (!dir) return;
      e.preventDefault();
      const sec = grip.closest(".route-section");
      if (!sec) return;
      setActive(Number(sec.dataset.route));
      moveRoute(dir);
      // renderRoutes() has replaced the button that was focused, so focus has to be
      // put back on the same route's grip at its NEW position or the next arrow key
      // goes nowhere.
      const moved = routeSection(activeIndex());
      const next = moved && moved.querySelector(".route-drag");
      if (next) next.focus();
    });

    host.addEventListener("input", (e) => {
      const sec = e.target.closest(".route-section");
      if (!sec) return;
      const r = Number(sec.dataset.route);
      setActive(r);
      const route = state.routes[r];
      if (!route) return;
      // WHICH GROUPS RIDE THIS ROUTE. Delegated here rather than bound per box,
      // because renderRoutes() replaces every head. Ticking Everyone ticks the
      // lot — it is a shortcut over the boxes below it, not a value of its own,
      // so it is read back out of them rather than stored.
      if (e.target.dataset && e.target.dataset.group) {
        const box = e.target.closest(".route-groups");
        const all = e.target.dataset.group === "*";
        if (all) {
          box.querySelectorAll('input[data-group]:not([data-group="*"])').forEach((i) => {
            i.checked = e.target.checked;
          });
        }
        const uids = [...box.querySelectorAll('input[data-group]:not([data-group="*"]):checked')].map(
          (i) => i.dataset.group,
        );
        // NOBODY IS NOT A STATE THIS CONTROL CAN SET. A route ridden by no group
        // is a route nobody rides, which payload() drops whole — so unticking
        // the last box is read as "go back to inheriting", the same answer the
        // rider picker's "Same as before" gives.
        applyRouteGroups(r, uids);
        return;
      }
      if (e.target.classList.contains("route-color")) {
        beginEdit("recolor route", "route-color:" + r);
        route.color = e.target.value;
        sec.style.setProperty("--route-color", route.color);
        renderRailRoutes();
        rebuildLayers();
        renderMarkers();
        markDirty();
        return;
      }
      if (e.target.classList.contains("route-title")) {
        beginEdit("rename route", "route-title:" + r);
        route.title = e.target.value;
        // Deliberately NOT renderRoutes(): rebuilding the section would take the
        // caret out of the field being typed in.
        renderRailRoutes();
        refreshDerived();
        markDirty();
      }
    });

    host.addEventListener("change", (e) => {
      const sec = e.target.closest(".route-section");
      if (!sec) return;
      const r = Number(sec.dataset.route);
      setActive(r);
      const route = state.routes[r];
      if (!route) return;
      if (e.target.classList.contains("route-subgroup")) {
        beginEdit("change which group rides a route");
        // "" is the Everyone option, and null is what the payload carries — an
        // empty string would reach the server as a uid that matches nothing and
        // be resolved to null anyway, but silently and one layer too late.
        route.subgroupUid = e.target.value || null;
        // A full render: the map has to redraw the strand and the anchor note
        // depends on which routes each group owns.
        renderRoutes();
        rebuildLayers();
        markDirty();
        return;
      }
      if (e.target.classList.contains("route-start")) {
        beginEdit("change start time");
        route.startAt = localInputToIso(e.target.value);
        refreshDerived();
        markDirty();
        return;
      }
      // Typing an end overrides the derivation; clearing it hands control back,
      // and refreshDerived() refills the field from the route on the way out.
      if (e.target.classList.contains("route-end")) {
        beginEdit("change end time");
        route.endAt = localInputToIso(e.target.value);
        route.endManual = route.endAt !== null;
        refreshDerived();
        markDirty();
      }
    });
  }

  // Sharing a ride that begins at the rider's front door puts a pin on their
  // house — and moving the pin would not be enough, because the first leg is
  // *drawn* from there. The line points at the building whatever the marker
  // says. So the swap happens here, while planning, and re-routes leg 0.
  //
  // Offered rather than applied: the rider may well have meant to share it, and
  // silently redrawing a route they already planned is worse than asking.
  function offerPublicStart() {
    // ANY LEVEL BUT PRIVATE, stated as the exclusion rather than as a list of
    // the open ones — `friends` joined the enum on 2026-08-26 and a list would
    // have silently kept the prompt from firing for it, which is a pin on
    // somebody's house shown to everyone they ride with. The one level that
    // shows a ride to nobody is the only one that is safe here.
    const shared = state.meta.visibility !== "private";
    const start = window.TB.publicStart;
    // points[0], not the first STOP. The first point of every route is promoted on
    // the spot, so they are the same element — reading the ordered list directly
    // keeps it true if that ever stops being the case, and leg 0 below runs out
    // of points[0] either way.
    const route = state.routes[0];
    const first = route && route.points[0];
    if (!shared || !start || !first || !(first.roles || []).includes("home")) return;
    if (state.startSwapDeclined) return;

    const ok = window.confirm(
      "This " +
        W("journey") +
        " starts at your home address, and a shared map would show a pin on it.\n\n" +
        "Replace the start with your public starting point (" +
        start.label +
        ")?",
    );
    if (!ok) {
      // Asked once per session. Nagging on every visibility change would train
      // the rider to dismiss it without reading.
      state.startSwapDeclined = true;
      return;
    }

    first.lat = +start.lat.toFixed(6);
    first.lng = +start.lng.toFixed(6);
    first.name = start.label;
    first.roles = (first.roles || []).filter((r) => r !== "home");
    // The leg out of the old start is meaningless now, shaping points included.
    if (route.legs[0]) route.legs[0].viaPoints = [];
    computeLegsAround(0, [0]);
    renderMarkers();
    renderList();
    refreshDerived();
    markDirty();
    toast("Start swapped to " + start.label);
  }

  function wireMeta() {
    // A new ride opens already named, so it can save from the first pin. An
    // EXISTING ride is left exactly as stored — including a rider who genuinely
    // named their ride "Untitled ride", which is theirs to keep.
    if (!state.rideId && !state.meta.title) {
      state.meta.title = UNTITLED;
      $("ride-title").value = UNTITLED;
      fitTitle();
    }

    // Select the default so the first keystroke replaces it. Only the default:
    // selecting a name the rider chose would make an accidental keypress destroy
    // it, which is the failure mode this pattern is usually blamed for.
    $("ride-title").addEventListener("focus", (e) => {
      if (e.target.value === UNTITLED) e.target.select();
    });

    // Cleared back to empty falls back to the default rather than to "", because
    // fields.title is min(1) server-side and an empty title 400s the whole save.
    // Done on blur, not on input, so the field can be emptied and retyped.
    $("ride-title").addEventListener("blur", (e) => {
      if (e.target.value.trim()) return;
      e.target.value = UNTITLED;
      state.meta.title = UNTITLED;
      fitTitle();
      markDirty();
    });

    $("ride-title").addEventListener("input", (e) => {
      // A ride name is one line of text even though the control holding it is a
      // textarea, so newlines are flattened rather than stored. They arrive by
      // paste — a name copied out of a document brings its line break with it —
      // and the Enter key is headed off separately below.
      const flat = e.target.value.replace(/\s*[\r\n]+\s*/g, " ");
      if (flat !== e.target.value) e.target.value = flat;
      beginEdit("rename ride", "ride-title");
      state.meta.title = e.target.value;
      fitTitle();
      markDirty();
    });
    $("ride-title").addEventListener("keydown", (e) => {
      // Enter in a heading means "done", not "new line".
      if (e.key === "Enter") {
        e.preventDefault();
        e.target.blur();
      }
    });
    $("ride-description").addEventListener("input", (e) => {
      beginEdit("edit description", "ride-description");
      state.meta.description = e.target.value;
      markDirty();
    });
    // Owner-only, and absent for everybody else — see setFieldValue. Optional
    // chaining rather than a hoisted guard so the shape matches the other
    // wirings around it.
    $("ride-visibility")?.addEventListener("change", (e) => {
      beginEdit("change visibility");
      state.meta.visibility = e.target.value;
      markDirty();
      offerPublicStart();
    });
    // The ride's own vehicle (#321). Picking Bicycle coerces the power to
    // Pedal the way the server will, so the select does not claim a pair the
    // save will not keep; the whole panel re-renders because the words in it
    // just changed.
    const vehicleChanged = (label) => (e) => {
      beginEdit(label);
      state.meta.vehicle = $("ride-vehicle")?.value || null;
      state.meta.power = $("ride-power")?.value || null;
      if (state.meta.vehicle && window.TBVocab) {
        const p = window.TBVocab.toPower(state.meta.power || window.TBVocabData?.profile?.power, state.meta.vehicle);
        if (state.meta.power && p !== state.meta.power) state.meta.power = p;
      }
      renderVehicle();
      renderEverything();
      markDirty();
    };
    $("ride-vehicle")?.addEventListener("change", vehicleChanged("change what the ride is for"));
    $("ride-power")?.addEventListener("change", vehicleChanged("change what it runs on"));
    // A <input type="time"> reports "" when it is cleared or half-typed, which
    // is the same thing as "they have not said" — so it lands as null rather
    // than being refused or defaulted.
    $("ride-stop-by")?.addEventListener("change", (e) => {
      beginEdit("change when to look for a bed");
      state.meta.stopByMin = minutesFromTimeValue(e.target.value);
      stopByCache = null;
      renderStopBy();
      // THE MAP AND THE LIST BOTH MOVE. The marker is a repaint, but the row
      // offer is part of the route list, so the list has to be rebuilt for it to
      // appear at all — and this control is a ride-level field the rider has
      // just committed to with a `change` event, so nothing in the list is
      // mid-edit. That is the same test #188's rule turns on: only a render
      // under a rider who is typing is the harmful one.
      paintStopBy();
      renderRoutes();
      markDirty();
    });
    $("ride-stop-by-clear")?.addEventListener("click", () => {
      beginEdit("clear when to look for a bed");
      state.meta.stopByMin = null;
      stopByCache = null;
      renderStopBy();
      paintStopBy();
      renderRoutes();
      markDirty();
    });
    // Narrowed from "dirty" to "dirty and not yet flushed". With autosave most
    // of a session is clean within three seconds of the last keystroke, so the
    // old guard would have fired on almost every exit for work that was already
    // on the server. What is left is the genuine window: an edit inside the
    // debounce, a flush in flight, or a ride that cannot be saved at all.
    window.addEventListener("beforeunload", (e) => {
      if (state.dirty || state.saving) e.preventDefault();
    });

    // The reliable half of the pair. beforeunload is increasingly restricted and
    // never fires at all when a phone backgrounds the tab and later kills it;
    // visibilitychange does, and it is the documented place to persist. Flushing
    // early here is free — a clean state returns immediately.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushNow();
    });
  }

  function allTrackPoints() {
    const pts = [];
    state.routes.forEach((route, r) => {
      // NOT a spread — see the same note in viewer.js. Spread passes every
      // element as its own ARGUMENT, so a long track exceeds the engine's
      // argument limit (~65k Safari, ~125k V8) and throws
      // `RangeError: Maximum call stack size exceeded`. Measured on a
      // 211,939-vertex import, where one leg alone held 161,831.
      for (const p of fullTrack(r)) pts.push(p);
      route.points.forEach((p) => pts.push([p.lng, p.lat]));
    });
    return pts;
  }

  // Undo/redo controls and the recovery prompt.
  /** Is the pointer of a keystroke inside something a rider is typing in?
   *  Shared by the shortcuts below, which each want a different answer about
   *  what to do next but the same answer about this. */
  function isTypingTarget(t) {
    if (!t || !t.tagName) return false;
    if (t.isContentEditable) return true;
    if (t.tagName === "TEXTAREA") return true;
    return t.tagName === "INPUT" && t.type !== "range" && t.type !== "color" && t.type !== "checkbox";
  }

  function wireHistory() {
    $("undo").addEventListener("click", () => applyUndo("undo"));
    $("redo").addEventListener("click", () => applyUndo("redo"));

    document.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      // Text fields keep their own undo — except the row inputs, whose native
      // stack renderList() destroys on every redraw anyway, so those are ours.
      const t = e.target;
      const native =
        t &&
        (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && t.type !== "range" && t.type !== "color")) &&
        !t.classList.contains("row-name") &&
        !t.classList.contains("row-desc") &&
        !t.classList.contains("row-dur");
      if (native) return;
      e.preventDefault();
      applyUndo(e.shiftKey ? "redo" : "undo");
    });

    // CTRL+Y IS REDO TOO, and only on the ctrl side. It is the Windows and Linux
    // convention where shift+cmd+Z is the Mac one, and a rider who learned one
    // does not discover the other by guessing. Not bound to the meta key: cmd+Y
    // is taken on macOS and stealing it would be worse than not offering it.
    document.addEventListener("keydown", (e) => {
      if (!e.ctrlKey || e.metaKey || e.key.toLowerCase() !== "y") return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      applyUndo("redo");
    });

    // CMD/CTRL+S SAVES NOW instead of waiting for the autosave. #40.
    //
    // IT MUST preventDefault UNCONDITIONALLY, including when there is nothing to
    // save: otherwise a rider who pressed it out of habit gets the browser's Save
    // Page dialog over their ride. That is the whole reason to bind it.
    //
    // Bound wherever focus is, text fields included, because it is not an edit: a
    // rider reaching for cmd+S means the ride.
    document.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      if (e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (!CAN_EDIT) return;
      // Ends the run of keystrokes first, or the field being typed in is not yet
      // part of what gets written — `change` fires on blur and cmd+S does not
      // blur anything.
      const el = document.activeElement;
      if (el && typeof el.blur === "function" && isTypingTarget(el)) el.blur();
      if (!state.dirty) return toast("Already saved");
      flushNow();
    });

    // Leaving a field ends the run of keystrokes, so the next edit is its own
    // undo step rather than folding into the last word typed.
    document.addEventListener("focusout", () => history_.breakCoalesce());

    // THE WAY BACK INTO A DISMISSED ERROR. The readout can only ever show the
    // first few words of one, so without this a rider who dismissed the dialog
    // has no way to read the rest of the message their ride failed on.
    const detail = $("save-detail");
    if (detail) {
      detail.addEventListener("click", () => {
        const st = $("save-status");
        showErrorDialog(st.dataset.state || "error", st.querySelector(".save-text").textContent);
      });
    }

    renderHistoryButtons();
  }

  // A draft only means something if it is newer than what was just loaded, and
  // nothing is applied until the rider says so.
  // Tell the layout how tall the page-top banner is, so the map and the drawer move
  // down instead of being painted over.
  //
  // THE HELPER MOVED TO site.js, because the VIEWER is a map page that loads no
  // copy of this file and had nothing to push its map down. The measuring, the
  // resize dispatch and the do-nothing-on-no-change guard went with it — see
  // TBBanner.refresh() for why each is load-bearing. This shim is a courtesy for a
  // load order that has never failed.
  function setBannerOffset() {
    if (window.TBBanner) window.TBBanner.refresh();
  }

  function offerRecovery() {
    const d = HIST.Draft.read(state.rideId);
    if (!d) return;
    const bar = $("recover-bar");
    const mins = Math.max(1, Math.round((Date.now() - (d.savedAt || 0)) / 60000));
    $("recover-text").textContent =
      "Unsaved changes from " + (mins < 60 ? mins + " minute" + (mins === 1 ? "" : "s") : "over an hour") + " ago. ";
    bar.hidden = false;
    setBannerOffset();
    $("recover-yes").addEventListener("click", () => {
      beginEdit("restore draft");
      state.meta = { ...d.meta };
      state.routes = d.routes.map((r) => ({ ...r, legs: (r.legs || []).map((l) => ({ ...l, geometry: [] })) }));
      state.legSeq = [];
      renderEverything();
      bar.hidden = true;
      setBannerOffset();
      // Geometry is not in the draft — the router rebuilds it. Stops are what
      // could not have been recovered from anywhere else.
      state.routes.forEach((_, r) =>
        computeLegsAround(
          r,
          Array.from({ length: Math.max(0, state.routes[r].points.length - 1) }, (_, i) => i),
        ),
      );
      markDirty();
      toast("Unsaved changes restored");
    });
    $("recover-no").addEventListener("click", () => {
      HIST.Draft.clear(state.rideId);
      bar.hidden = true;
      // Put the map and the drawer back, or they stay pushed down by a banner
      // that is no longer there.
      setBannerOffset();
    });
  }

  async function init() {
    if (!window.TB.gmapsKey || !window.TB.mapId) {
      document.body.insertAdjacentHTML(
        "afterbegin",
        '<div class="tb-banner">Maps are not configured—set GMAPS_KEY and GMAPS_MAP_ID and restart.</div>',
      );
      setBannerOffset();
      return;
    }
    wireMeta();
    initTabs();
    wireRiders();
    wireRoutes();
    // Delegated on the container rather than on each list, so the handlers
    // survive renderRoutes() replacing every list. Sortable cannot work that way —
    // it binds to the list element — so initDragToReorder is called per list from
    // renderRoutes instead.
    wireList($("route-list"));
    wireMenuDismiss();
    wireSearch();
    wireSelect();
    wireHistory();
    // Undo and redo are the only icons in static markup — every other one is in
    // a row this file renders, and renderList() hydrates those as it goes. These
    // two are in the shell, so nothing would ever come along and fill them.
    hydrateIcons($("undo").parentElement);

    if (state.rideId) {
      try {
        await loadExisting();
      } catch (e) {
        return toast(e.message, true);
      }
    }

    // AFTER loadExisting, so the first presence event lands on a state that
    // already knows its routes — heldBy is keyed by uid and would otherwise mark
    // nothing on the first render. Nothing below depends on it connecting.
    LIVE.start();

    // Unlike Mapbox, the map is usable as soon as the constructor resolves —
    // there is no style to wait on, so the `load` handler this replaces is gone.
    state.map = await initMap("map");

    // The server only sends TB.home on the new-ride route, so this cannot fire
    // while editing. Guarding on stops.length as well means a reload of a
    // half-built ride does not stack a second home stop on the first.
    if (window.TB.home && !state.rideId && state.routes[0].points.length === 0) {
      // Seeded with its roles already set, so addPoint's auto-promotion leaves
      // them alone — it only supplies `start` when the caller named nothing. Both
      // are true of this point: it is where the ride begins and it is home.
      // The rider's own name for the place, with "Home" as the server's
      // fallback — see homeSeed() in routes/builder.ts. Hardcoded here until
      // 2026-09-07, which named the shop and the storage unit wrong.
      const seed = newPoint(window.TB.home.lng, window.TB.home.lat, window.TB.home.label || "Home");
      seed.roles = ["start", "home"];
      addPoint(window.TB.home.lng, window.TB.home.lat, "Home", 0, seed);
    }

    rebuildLayers();
    renderMarkers();
    renderRoutes();
    refreshDerived();
    const all = allTrackPoints();
    if (all.length) fitTo(state.map, all);
    // Deliberately NOT awaited. The library is an accelerant on the search box,
    // not something the map or the panel needs in order to render — blocking
    // init on it would put a network round trip in front of a builder that works
    // perfectly without one.
    loadSavedPlaces();
    // Also not awaited, and for the same reason. It fills the count in the
    // Riders tab's label, which is the whole affordance for opening a tab whose
    // contents nothing else hints at — a strip that says "Riders 5" is a reason
    // to look and one that says "Riders" is not. It also warms the cache, so the
    // first open paints with no round trip. On a ride with no id yet it returns
    // immediately without asking the server anything.
    loadRiders();
    // Not awaited either. Every route row asks who is on it, so this is what
    // turns those lines on — and until it lands they render nothing rather than
    // guessing, which is why a slow answer costs no correctness. It returns
    // immediately on a ride with no id.
    loadRouteRiders();
    // Same reasoning as loadRiders above: the count beside the heading is the
    // only hint that anybody has said anything, and warming it costs one request
    // on a ride that has an id. It returns immediately on one that does not.
    initComments();
    initSuggestions();
    offerRecovery();
    onRouteShapeDrag(state.map, shapeAt);
    onMapClick(state.map, ([lng, lat]) => {
      // A drop at the end of a shape drag also produces a click. Without this
      // the rider bends the line and gets a stop they never asked for.
      if (consumeShapeClick(state.map)) return;
      // ADDING IS SUPPRESSED WHILE POINTS ARE SELECTED, and this is a
      // correctness guard rather than a nicety: the selection keys points by
      // index, and splicing a new stop into a route renumbers every point after
      // it. The rider would then delete a different set from the one they
      // ticked, silently. Saying so beats acting on the stale keys.
      if (state.select?.scope === "point") return toast("Finish selecting first", true);
      // NEVER A CHOICE HERE. addPoint() decides the kind and is the only place that
      // does: a POI, unless this is the route's first point. The panel-wide + Stop /
      // + POI pair read as buttons that add something and was really a mode switch that
      // added nothing; the per-row radios that briefly replaced it went with the
      // POI-first model. Promotion is a row-menu item now, and free.
      //
      // Read and cleared BEFORE the add, so a failed add cannot leave the builder armed
      // with the button still lit.
      const armed = state.arm;
      const armedAt = state.armAt;
      disarmPlace();
      addPoint(lng, lat, "", armed, null, armedAt);
    });
  }

  // ——— The tour's one door ———
  //
  // tour.js DEMONSTRATES the builder rather than asking a rider to drive it (Ziad's
  // call, 2026-09-11): it types into the real fields and picks from the real search
  // list, all DOM it can reach on its own. The one thing it cannot reach is the
  // map, so the two places it types have to be on screen before it starts. One
  // function and not `state`: the tour reads what is on screen, never builder
  // state, which is what keeps it unable to disagree with what the rider sees.
  //
  // `apply(frame)` is the load-bearing one — the tour is a canned planning session,
  // so each beat REPLACES the ride with a pre-routed keyframe through the LOAD path
  // (routeFromPayload, fillMissingLegs, inferEndManual) rather than the edit path,
  // because five things fight a naive state swap: an in-flight save rebasing
  // routeBase, the recovery draft offering the previous frame back, endManual read
  // off a stored end, a stale legSeq dropping a response that is not coming, and a
  // meet proposal drawn against a road that just changed.
  async function tourApply(frame) {
    if (!CAN_EDIT || !frame || !frame.ride) return false;
    const ride = frame.ride;
    // Let whatever is in flight land first, so the rebase below is against
    // the ride the server actually holds.
    await saveNow();
    beginEdit("tour step");
    state.meta = {
      title: ride.title || "",
      description: ride.description || "",
      visibility: ride.visibility || "private",
      external_url: ride.external_url || "",
      subgroups: (ride.subgroups || []).length ? ride.subgroups.map((g) => ({ ...g })) : [seedGroup()],
      primarySubgroup: ride.primarySubgroup ?? null,
      trunkSubgroup: null,
      timeAnchor: ride.timeAnchor || "departure",
      stopByMin: ride.stopByMin ?? null,
    };
    const wasPrimary = state.meta.subgroups.findIndex((g) => g.uid === state.meta.primarySubgroup);
    if (wasPrimary > 0) state.meta.subgroups.splice(0, 0, state.meta.subgroups.splice(wasPrimary, 1)[0]);
    state.meta.primarySubgroup = state.meta.subgroups[0].uid;
    state.routes = (ride.routes || []).map(routeFromPayload);
    state.routes.forEach(fillMissingLegs);
    state.routes.forEach((r) => {
      r.endManual = inferEndManual(r);
    });
    if (state.routes.length === 0) state.routes = [newRoute()];
    state.legSeq = [];
    state.active = 0;
    state.select = null;
    state.rolesOpen = null;
    state.insertAt = null;
    state.moment = null;
    clearMeet();
    // The draft is the previous frame now, and offering it back would undo
    // the demonstration.
    clearTimeout(draftTimer);
    HIST.Draft.clear(state.rideId);
    const bar = $("recover-bar");
    if (bar) bar.hidden = true;
    renderEverything();
    renderSelectBar();
    // The tour owns the camera when it says so: a demonstration that has
    // already framed the story's box passes `fit: false`, or the map zooms
    // to the ride after every frame and back out before the next one.
    const all = allTrackPoints();
    if (all.length && frame.fit !== false) fitTo(state.map, all);
    markDirty();
    const ok = await saveNow();
    // A save is what gives a new route its stored uid and a new group its id,
    // and both readers below answer from what the server holds.
    loadRouteRiders();
    ridersStale();
    return ok;
  }

  // Resolved once init() has loaded the ride and made the map. THE TOUR AWAITS IT
  // BEFORE ITS FIRST FRAME: this object exists from the moment the file runs while
  // the ride arrives by fetch inside init(), so a tour resuming on a page whose
  // Shepherd was cached applied a frame — and saveNow() PUT the seed's empty route
  // — before loadExisting() had answered. The PUT was refused ("routes: Too small")
  // and the dialog stayed up for the rest of the tour. Found by
  // utils/record-tour-replay.ts, 2026-09-20.
  let markReady;
  const READY = new Promise((r) => {
    markReady = r;
  });

  window.TBBuilder = {
    ready: READY,
    // `padding` is optional; the tour passes one to keep a card off the road.
    fitTo: (lngLats, padding) => fitTo(state.map, lngLats, padding),
    apply: tourApply,
    // Awaited before the tour leaves the page, so the beforeunload guard has
    // nothing to hold the rider for.
    settled: () => saveNow(),
    // The opposite, for a tour STARTING from a blank builder: the seeded home
    // base has made the ride dirty and armed the autosave, and saving it
    // would create a ride nobody planned on the way to the tour's own. Drop
    // the work instead — there is none the rider typed — so the navigation
    // is not stopped by the guard above.
    discard: () => {
      if (state.rideId) return;
      clearTimeout(idleTimer);
      clearTimeout(ceilingTimer);
      clearTimeout(retryTimer);
      clearTimeout(draftTimer);
      idleTimer = ceilingTimer = retryTimer = draftTimer = null;
      state.dirty = false;
      HIST.Draft.clear(state.rideId);
    },
    // The recorded proposal, drawn exactly as a live one is. The tour never
    // presses a candidate's own button: that calls takeMeet, which routes.
    showMeet: (data) => {
      const out = $("sg-meet-out");
      if (!out) return;
      state.meet = data;
      state.meetNote = "";
      out.innerHTML = meetAllHtml(data);
      showMeetPreview(out, data);
    },
    clearMeet: clearMeet,
    // The split dialog, opened for show and closed without submitting.
    openSplit: (r, i) => openSplitGroup(r, i),
    closeSplit: () => {
      const el = $("tb-split");
      if (el && el.open) el.close();
    },
    setMoment: (s) => setMoment(s),
    reloadRiders: () => {
      ridersStale();
      return loadRouteRiders();
    },
    routeIndexOf: (uid) => state.routes.findIndex((d) => d.uid === uid),
    // A coordinate as a pixel on the map element, for the cursor that slides
    // a shaping point onto another road.
    project: (lngLat) => (state.map ? containerPixel(state.map, lngLat) : null),
  };

  init().finally(markReady);
})();
