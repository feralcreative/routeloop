// The ride builder. State mirrors the /api/rides payload: ride meta plus an
// ordered array of days, each a day/session of ordered stops, unordered POIs,
// and road-routed legs (legs[i] connects stops[i] → stops[i+1]).
//
// Every day is drawn on the map at once, always. The day slider changes which
// one is emphasized and never hides anything — seeing the whole ride on a single
// map is the point of the app, so dimming is the only thing focus does.
(function () {
  "use strict";
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
    clearLegHighlight,
    onRouteShapeDrag,
    consumeShapeClick,
    addMarker,
    removeMarker,
    onMarkerDragEnd,
    searchPlaces,
    mapCenter,
    markerElement,
    initPanelToggle,
  } = window.TBMap;

  initPanelToggle(() => state.map);

  // The ride's time model is shared with the viewer so the two can never
  // disagree about what is happening at a given moment. See ride-time.js.
  const {
    legIsEstimated,
    legDurationS,
    dayIsEstimated,
    dayStoppedS,
    dayElapsedS,
    dayStartS,
    rideSpan,
    activeAtMoment,
    fmtMoment,
  } = window.TBTime;

  // Twistiness, computed here rather than read from the ride: the stored figure
  // is whatever the geometry looked like at the last save, and this panel has to
  // be right while the rider is still moving stops around. See twist.js for why
  // there are two implementations and what keeps them honest.
  const { dayTwistiness, twistLabel } = window.TBTwist;

  // Category-vs-name detection and the place-type to role map. See
  // public/js/place-query.js — pure, and pinned by test/place-query.test.ts.
  const QUERY = window.TBQuery;

  // Pure drag-to-shape arithmetic — see route-shape.js.
  const { legAtVertex, nearestVertexIndex, viaInsertIndex } = window.TBShape;

  // Turning a SortableJS drop into a position in day.points — see drag-index.js.
  const DRAG = window.TBDragIndex;

  const MILE = 1609.344;

  // Miles or kilometers — see public/js/units.js, which mirrors
  // src/views/units.ts and is pinned to it by test/units-client.test.ts.
  const UNITS = window.TBUnits ? window.TBUnits.toUnits(window.TB.units) : "imperial";
  const distUnit = window.TBUnits ? window.TBUnits.distanceUnit(UNITS) : "mi";
  const MAX_DAYS = 31; // matches MAX_DAYS in src/routes/rides.ts
  // Mirrors MAX_POINTS / MAX_STOPS in src/maps/ride-graph.ts. One cap over the
  // whole list, plus a separate ceiling on how many of them may be routing
  // anchors — promoting 400 POIs would be 399 Directions calls.
  const MAX_POINTS = 400;
  const MAX_STOPS = 200;
  const MAX_LINKS = 5;

  // A point's durable identity. Mirrors newUid() in src/maps/uid.ts and is pinned
  // to it by test/point-details.test.ts — same alphabet, same length, or a uid
  // minted here fails server validation and the save 400s.
  //
  // Minted on the CLIENT rather than assigned by the server because a rider can
  // open a stop and type a confirmation number into it before any save has
  // happened; without an identity at creation time there would be nothing to
  // attach those details to.
  //
  // crypto.getRandomValues over Math.random for the same reason the server uses
  // randomBytes: a repeat inside one save violates the per-day unique index and
  // fails the whole request. Rejection sampling — bytes at or above 252 are
  // discarded, because 256 % 36 would otherwise bias the first four symbols.
  const UID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
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
  function newPoint(lng, lat, name) {
    return {
      // THE BASELINE TYPE. Ziad's call, 2026-08-23: a point is a POI until it is
      // promoted, so nothing has to be decided at the moment of creation — which
      // is the moment a rider knows least about the place they just dropped.
      kind: "poi",
      lat: +lat.toFixed(6),
      lng: +lng.toFixed(6),
      name: name || "",
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
  // A day holds ONE array, `points`, in the rider's order, and `kind` says only
  // whether the rider means to STOP there. It replaced `day.stops` and
  // `day.pois`, where "stopness" was expressed by which array an object sat in
  // and a POI had no stored order at all — its place in the list was derived by
  // projecting it onto the day's track, which has no answer before a route
  // exists.
  //
  // ONE INDEX SPACE, as of 2026-08-24. `legs[i]` joins `points[i]` to
  // `points[i+1]`, whatever kind either end is, so a point's position in the day
  // IS its leg index and there is nothing to convert.
  //
  // What used to be here: stopIdx() and stopOrdinalAt(), the bridge between
  // "position in the day" and "ordinal among the stops", because a leg connected
  // stop i to stop i+1 and a POI bent no road. A POI is part of the route now — it
  // is something the rider will at least ride BY — so the second index space is
  // gone and every leg call site indexes points directly.
  //
  // stopsOf() survives for the things that genuinely count stops rather than
  // points: the row numbering, the at-least-one-stop guard, and the endpoints of
  // an alternate group.
  const stopsOf = (day) => day.points.filter((pt) => pt.kind === "stop");

  // The rider's saved-place library, loaded once when the builder opens.
  //
  // Held in memory rather than re-fetched per keystroke: it is one rider's own
  // list, bounded at 500 by MAX_PLACES server-side, and matching it locally is
  // what lets a saved place appear in the search list INSTANTLY and for free.
  // The Google predictions that arrive 300ms later are appended below them.
  //
  // A failure here is silent and non-fatal. Saved places are an accelerant, not
  // a dependency — a builder that cannot reach /api/places must still let a
  // rider plan a ride.
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
      .filter((pl) =>
        (pl.name + " " + (pl.groupName || "") + " " + (pl.address || "")).toLowerCase().includes(needle),
      )
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
    const pt = newPoint(pl.lng, pl.lat, pl.name);
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

  // Saves a stop into the rider's library, so the good fuel stop found once is
  // droppable into every ride after it.
  //
  // Sends only the DURABLE half of the stop's details — a phone number belongs
  // to the place, a confirmation number to one trip. Sending the confirmation
  // would put last September's booking reference on every future ride that used
  // the place, which is worse than having none.
  //
  // The saved copy is independent from this moment on: editing the stop
  // afterwards does not change the place, and editing the place does not change
  // the stop. That is the copy-not-reference decision, and it runs in both
  // directions.
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

  // Which detail fields a stop actually shows, keyed off its roles.
  //
  // By role rather than one giant form: a HOTEL wants check-in/out and a
  // confirmation number, a FOOD stop wants a reservation time and a menu link,
  // and showing a rider fourteen inputs for a gas stop is how a feature like
  // this stops being used. Notes and links are on everything — "gate code 4417,
  // park behind the barn" fits nowhere else and belongs everywhere.
  //
  // A stop with no roles gets the full set rather than the minimum: an unlabelled
  // stop is one the rider has not categorized yet, and hiding fields from it
  // would make the editor look broken.
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
  // window.TB.roles carries the role table. The importer colors the days of a
  // folder import server-side, so the palette cannot live only in here.
  const DAY_COLORS = window.TB.dayColors;

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
  // page that does not offer an edit it cannot keep and does not autosave into a
  // 404 every twenty seconds.
  //
  // Defaults to TRUE on a missing value, deliberately: the new-ride page has no
  // ride and therefore no roster, and an older cached page that predates the key
  // must keep working for the rider who owns what it is showing.
  const CAN_EDIT = window.TB.canEdit !== false;

  // WHETHER THIS RIDER MAY PROPOSE A CHANGE. `suggest` is the DEFAULT an
  // invitation grants, so this is the common case for anybody who is not the
  // owner — and it is what makes the read-only builder useful rather than a
  // museum: a rider edits a day locally, presses Suggest, and the owner takes it
  // or leaves it. Nothing they do is saved to the ride.
  const CAN_SUGGEST = window.TB.perm === "suggest" || CAN_EDIT;

  // Alternates: the numbering, the active-day filter and the ride rollup. The
  // builder is the only client that calls resolveAltGroups — it is the one
  // editing days, and repairing locally is what keeps the panel, the map and
  // the totals agreeing before the next save round trip. The server resolves
  // again on save regardless, and its answer wins.
  const ALT = window.TBAlt;

  const newDay = (color) => ({
    title: "",
    color: color || DAY_COLORS[0],
    startAt: null,
    endAt: null,
    // Session-only: see inferEndManual(). Never part of payload().
    endManual: false,
    // The day's durable identity, minted here the way a point's is. It DOES go
    // in payload() and it DOES come back in loadExisting(); mirror of
    // `days.uid` in src/db/schema.ts. Votes on an alternate are keyed by it, so
    // a day that loses its uid loses its votes silently.
    uid: uid(),
    // WHOSE DAY THIS IS, by subgroup uid. Null means everyone rides it, which
    // is what a new day always is: tagging one is something a rider does to a
    // day that already exists, the same as grouping it as an alternate.
    subgroupUid: null,
    // Alternates. A new day is always a plain one — grouping is something a
    // rider does to days that already exist. Both fields DO go in payload() and
    // both come back in loadExisting(); see src/maps/alts.ts for what they mean
    // and why the group id is not stable across a save.
    altGroup: null,
    altActive: true,
    // One ordered list of both kinds, and legs[i] joins points[i] to points[i+1]
    // whatever kind either end is — see the One ordered list block above.
    points: [],
    legs: [],
  });

  // THE NAME A RIDE HAS BEFORE ANYBODY NAMES IT. Ziad's call, 2026-08-24.
  //
  // A ride used to be unsaveable without a title: saveBlockReason() refused, so
  // autosave never fired, and a rider who dropped three pins and closed the tab
  // lost all three to a naming rule. That is the defect — not the missing name.
  //
  // Visible rather than hidden, and pre-filled rather than a placeholder, which
  // is what Docs, Figma and Notion all do. A placeholder would leave `title`
  // genuinely empty and fields.title would still refuse it server-side; a real
  // value saves, and the field selects itself on focus so the first keystroke
  // replaces it.
  const UNTITLED = "Untitled ride";

  const state = {
    map: null,
    // Which row has its category picker open, as {day, i}, or null.
    //
    // In state rather than in the DOM because picking a category now changes the
    // point's KIND, which renumbers every stop after it — so the row has to be
    // re-rendered, and a picker whose openness lived only in a `hidden` attribute
    // would slam shut after every icon tap.
    rolesOpen: null,
    // Which gap between two points has its add-row open, as {day, at}, or null.
    // `at` is an index into day.points: 0 is before the first point, and
    // day.points.length would be the bottom row, which is always there anyway.
    insertAt: null,
    rideId: window.TB.rideId || null,
    // The public slug, for the Riders tab's link out to the roster page. Null
    // until the first save mints one — showViewLink() is where it lands, because
    // that is already the one place a slug reaches this file.
    slug: window.TB.slug || null,
    meta: {
      title: "",
      description: "",
      visibility: "private",
      external_url: "",
      // SUBGROUPS ARE RIDE-LEVEL — several days reference one and a rider is
      // assigned to one across the whole ride. Each is {uid, name, color}; the
      // uid is minted here and is what days reference, because the server's ids
      // do not exist until the first save. Mirror of ride_subgroups.
      subgroups: [],
      // Whose clock is pinned, and whose route is the spine — two keys although
      // the panel asks once. See rides.primary_subgroup_id for why they come
      // apart. Both are subgroup uids or null.
      primarySubgroup: null,
      trunkSubgroup: null,
      // Which event is pinned: "departure", "meet" or "arrival".
      timeAnchor: "departure",
    },
    days: [newDay()],
    // The active day, as a plain index into state.days. It is where a map click
    // puts a stop and which day the map emphasizes; it is NOT a filter, because
    // every day is on screen at once.
    //
    // It was `focus`, a 0..N slider value with 0 meaning "all days". Both the
    // off-by-one and the null-means-all case went with the slider.
    active: 0,
    // The timeline's position, in epoch seconds, or null for "no moment
    // chosen". When it is set it is the single source of what is emphasized:
    // the day containing it, and the leg being ridden at it. The day slider
    // does not compete with this — moving it just picks a new moment (that
    // day's start), so there is one model and two ways to drive it. Null falls
    // back to plain day focus, which is what an undated ride always uses.
    moment: null,
    // markers[r] = { stops: [{marker, el}], pois: [{marker, el}] }
    markers: [],
    // WHICH DAY IS WAITING FOR A MAP CLICK, or null. Set by a day's "+ Stop"
    // button and cleared by the click that satisfies it.
    //
    // One value rather than a boolean plus a day index: two fields can disagree
    // with each other, and the disagreement here would put a stop on the wrong
    // day silently. Every armed button re-derives its own state from this, so
    // there is no class anybody has to remember to move.
    arm: null,
    dirty: false,
    // A flush is in flight. Declared rather than sprung into existence by the
    // first assignment, because autosave now READS it before any save has run.
    saving: false,
    layersReady: false,
    layerCount: 0, // how many day layers are currently on the map
    legSeq: [], // legSeq[r][i]—stale routing responses are dropped
    // SELECT MODE, or null when off:
    //   { scope: "day" | "point", days: Set<int>, points: Set<"day:kind:i"> }
    //
    // ON state, DELIBERATELY NOT ON A DAY OR A POINT. snapshot() in
    // builder-history.js reads only state.meta and state.days, so a sibling key
    // here needs no entry in its copy list and can never ride into the undo
    // stack. A `selected` flag on a day object would need one — and would then
    // have to be stripped in payload() the way endManual is.
    //
    // Points are keyed "dayIndex:kind:i", never held as object references:
    // HIST.restore builds fresh objects on undo, so a reference-based selection
    // would go stale silently. Indices are safe because every bulk action, every
    // undo and every structural render clears the selection — there is never a
    // live selection across a mutation to reindex.
    select: null,
  };

  const $ = (id) => document.getElementById(id);

  // WHICH DAY EDITS LAND ON. Every day is on screen at once now, so this is no
  // longer "the one day being shown" — it is the last day the rider touched, and
  // the only thing it decides is where a map click puts a new stop.
  //
  // It was `state.focus`, a 0..N slider value where 0 meant "All days" and every
  // day but one was hidden. Two things went with the slider: the null case, which
  // meant edits had nowhere to land and half the panel had to hide itself, and
  // the off-by-one, which is why this pair of helpers existed at all.
  //
  // It is clamped rather than allowed to go stale: deleting day 3 of 3 has to
  // leave the active index pointing at a day that still exists, and every caller
  // here assumes state.days[activeIndex()] is real whenever there is a day.
  const activeIndex = () => {
    if (!state.days.length) return null;
    return Math.max(0, Math.min(state.days.length - 1, state.active | 0));
  };
  // Kept under their old names because eighteen call sites read them and none of
  // them cared which day it was, only that it was the one being edited.
  const editIndex = activeIndex;
  const focusedIndex = activeIndex;
  const editRoute = () => {
    const r = activeIndex();
    return r == null ? null : state.days[r];
  };

  // Makes a day the active one. Cheap and idempotent, because every row and
  // section handler calls it before doing anything else — that is what lets the
  // edit handlers go on reading editIndex() without each of them being rewritten
  // to take a day.
  function setActive(r) {
    const next = Math.max(0, Math.min(state.days.length - 1, r | 0));
    if (state.active === next) return;
    state.active = next;
    markActiveSection();
    applyFocus();
    renderRailDays();
    renderTotals();
  }

  // Reads the day off whatever was clicked. Every .day-section and every
  // .point-row carries data-day, so one lookup covers both.
  function setActiveFromEl(el) {
    const host = el && el.closest("[data-day]");
    if (host) setActive(Number(host.dataset.day));
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
  // Kept as the backstop for "there is no day at all", which is now the only way
  // editIndex() returns null — a ride always has at least one day, so in practice
  // this fires for nothing. It used to cover the slider's "All days" position,
  // where every day-level control was live but had nowhere to act.
  function noDayYet() {
    toast("Add a day first", true);
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

  // The ride name is a TEXTAREA, so its height is ours to set — that is the price
  // of a heading that wraps. An <input> is single-line by definition and would
  // only ever ellipsize; a textarea holds whatever `rows` says and scrolls the
  // rest, so nothing sizes it to its content unless this does.
  //
  // Resetting to "auto" first is load-bearing rather than tidy: scrollHeight
  // reports the larger of the content and the current box, so measuring without
  // the reset lets the field grow and never shrink back. A name trimmed from two
  // lines to one would keep the second line's worth of white space forever.
  //
  // The two-line ceiling is a max-height in _builder.scss, not a number here, so
  // the type size and the clamp cannot drift apart. Anything taller than that is
  // clamped by CSS and clipped, which is the truncation the heading promises.
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
    rebuildLayers();
    renderMarkers();
    renderDays();
    refreshDerived();
    $("ride-title").value = state.meta.title;
    $("ride-description").value = state.meta.description;
    $("ride-visibility").value = state.meta.visibility;
    // Undo can shorten the name as easily as lengthen it, and the field will not
    // notice either on its own.
    fitTitle();
  }

  function applyUndo(dir) {
    const entry = dir === "redo" ? history_.redo(HIST.snapshot(state)) : history_.undo(HIST.snapshot(state));
    if (!entry) return;
    HIST.restore(state, entry.snap);
    // The selection is keyed by index and the day and point arrays have just
    // been replaced wholesale, so every key in it may now name something else.
    // Dropped rather than remapped: there is no honest remapping of "the third
    // stop of day 2" across an undo that removed day 1.
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

  function markDirty() {
    // THE READ-ONLY BUILDER STOPS HERE, and this is the only place it needs to.
    // Every edit in the panel funnels through markDirty, so nothing goes dirty,
    // no recovery draft is filed, and no autosave arms — rather than letting a
    // save be attempted and refused, which would show a rider an error for
    // something they were never allowed to do.
    //
    // Not routed through saveBlockReason(): that reports a condition the rider
    // can CLEAR by editing, and this one they cannot.
    //
    // A SUGGESTER IS THE EXCEPTION AND STILL GOES NO FURTHER THAN THIS LINE.
    // Their edits live in `state` so there is something to propose, and the
    // suggest bar below reads it — but no draft is filed and no autosave arms,
    // because there is nothing they are allowed to save.
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
  // There is no Save button. A flush is a plain PUT of the whole ride, and the
  // reason that is affordable is that it makes NO billable Maps call — the money
  // is in the routing request, which keeps its own debounce in computeLeg() and
  // is deliberately not coupled to this.
  //
  // Two timers, not one, and the second is the one that matters. An idle
  // debounce alone has no upper bound: dragging a stop around for four minutes
  // never goes idle and never saves. The ceiling fires regardless of activity,
  // measured from the first edit after a clean state, so the worst case is
  // bounded by AUTOSAVE_MAX_MS rather than by how long someone can keep typing.
  //
  // Both are far under the five-minute acceptance bar on purpose: the bar is what
  // must never be exceeded, not what to aim for.
  const AUTOSAVE_IDLE_MS = 3000;
  const AUTOSAVE_MAX_MS = 20000;
  // After a failed flush. Long enough not to hammer a server that is down,
  // short enough that a dropped wifi connection recovers on its own.
  const AUTOSAVE_RETRY_MS = 15000;

  let idleTimer = null;
  let ceilingTimer = null;
  let retryTimer = null;

  // WHICH EDITS A COMPLETED SAVE ACTUALLY COVERS, and getting this wrong is
  // silent data loss rather than a visible bug, so it is worth the counter.
  //
  // payload() serializes when the fetch STARTS. A keystroke during the round trip
  // is therefore not in that request — but the response says "saved", and the
  // obvious thing to do on success is clear state.dirty. That marks the keystroke
  // as saved, and every later flush then returns early on `!state.dirty`, so it
  // is never sent at all. The status reads "Saved" the whole time.
  //
  // The first version of this tracked a boolean set by flushNow() when it was
  // called mid-flight, which is a different event: a flush attempt during the
  // request, not an edit during it. Typing does not call flushNow(), so the
  // common case sailed straight past it.
  //
  // markDirty() bumps editSeq. save() records it before the fetch and compares
  // after: equal means the response covers everything, different means more
  // arrived and the ride is still dirty.
  let editSeq = 0;

  // Why a flush cannot happen, in the rider's words, or null.
  //
  // These are the same two conditions save() used to enforce with a toast and a
  // focus jump. Neither is right for autosave: a rider who has not typed a title
  // yet is mid-task, not in error, and a toast every three seconds saying so
  // would be the worst thing in the app. The status line states the condition
  // and waits.
  function saveBlockReason() {
    // NO TITLE CHECK. An unnamed ride saves as UNTITLED — see the constant above
    // for why blocking it was the bug rather than the safeguard. A ride with no
    // points still cannot save, and that one is real: the API requires at least
    // one stop per day and there would be nothing to store.
    if (!state.days.some((r) => r.points.length > 0)) return "Needs a stop";
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
    // Coalesce rather than queue: two overlapping PUTs of the same ride would
    // only race to write the same thing. Nothing is recorded here — save()
    // re-queues itself from the editSeq comparison if this flush's request
    // turns out not to have covered everything.
    if (state.saving) return;
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
   * NO CONFIRMATION, deliberately, and the same argument as the dashboard's
   * Delete: the bin holds it for thirty days with a button to put it back, so
   * the bin IS the confirmation. Asking twice for something reversible is how a
   * rider learns to click through the dialog that is not.
   *
   * CLEARING dirty AND saving IS THE LOAD-BEARING PART. Both the beforeunload
   * guard and the visibilitychange flush key off exactly those two flags, so
   * leaving them set means the rider gets a browser "leave site?" prompt on the
   * way out and the tab fires one last PUT at a ride that is now in the bin.
   * That PUT 404s — ownRide() excludes trashed rides — so nothing is corrupted,
   * but the panel would flash a save error at someone who has already left.
   */
  async function deleteRide() {
    if (!state.rideId) return;
    const res = await fetch("/api/maps/" + state.rideId, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setSaveStatus("error", (data && data.error) || "Could not delete this ride.");
      return;
    }
    state.dirty = false;
    state.saving = false;
    window.location.href = "/";
  }

  // --- Save status ----------------------------------------------------------

  // One state name in, one fixed-footprint readout out. The width is reserved in
  // CSS for the longest string here, because #save-status was on the epic's list
  // of variable-length readouts that reflow whatever sits beside them.
  const SAVE_TEXT = {
    new: "Not saved yet",
    dirty: "Unsaved changes",
    saving: "Saving…",
    saved: "Saved",
    error: "Not saved",
  };

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
    if (name === "error" || name === "blocked") {
      $("save-announce").textContent = text || SAVE_TEXT[name] || "";
    } else if (name === "saved") {
      $("save-announce").textContent = "";
    }
  }

  // --- Routing --------------------------------------------------------------

  function straightLeg(a, b, vias) {
    // Placeholder while the real day is in flight (and the NoRoute fallback
    // the server accepts — its distance is the haversine truth). durationS stays
    // 0 because we genuinely do not know it: fabricating a number here would
    // persist as though the router had returned it. legDurationS() estimates it
    // at the point of use instead, which also survives a save/reload.
    const geometry = [a, ...(vias || []), b];
    return { geometry, distanceM: Math.round(haversineTrack(geometry)), durationS: 0, viaPoints: vias || [] };
  }

  // Every day arrives with exactly points−1 legs, whatever it was stored as.
  //
  // A CSV import is a list of points with NO geometry at all — csv.ts refuses to
  // join them with straight lines, because a distance no motorcycle can ride is
  // worse than no distance. So it lands with N points and zero legs, which the
  // ride payload rejects on the way back out: `legs must connect consecutive
  // points`. That never mattered while imported rides could not be opened; the
  // moment the builder started accepting them, a rider could open a CSV import
  // and watch every autosave fail.
  //
  // The gap is filled with straight legs — the same placeholder the builder
  // already draws between two stops while the router is still answering, and
  // the same one it keeps when the router refuses. Free and synchronous: NO
  // routing request is made here. Routing every leg of an imported ride the
  // instant it was opened would be a page load that silently spends money.
  // Touching a stop routes its legs, which is the rider asking.
  function fillMissingLegs(day) {
    const pts = day.points;
    const want = Math.max(0, pts.length - 1);
    if (day.legs.length === want) return;
    // Trim first: more legs than pairs cannot be saved either, and a leg with
    // no pair of points to connect has nothing to be about.
    day.legs.length = Math.min(day.legs.length, want);
    for (let i = 0; i < want; i++) {
      if (day.legs[i]) continue;
      const a = pts[i];
      const b = pts[i + 1];
      day.legs[i] = straightLeg([a.lng, a.lat], [b.lng, b.lat], []);
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
  async function directions(a, b, vias) {
    const res = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin: a, destination: b, vias: vias || [] }),
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

  // Recomputes leg i of day r, joining points[i] to points[i+1]. `i` indexes
  // day.points directly — both kinds anchor a leg, so there is no ordinal to
  // convert from.
  function computeLeg(r, i) {
    const day = state.days[r];
    if (!day) return;
    const pts = day.points;
    if (!pts[i] || !pts[i + 1]) return;
    const a = [pts[i].lng, pts[i].lat];
    const b = [pts[i + 1].lng, pts[i + 1].lat];
    const vias = (day.legs[i] && day.legs[i].viaPoints) || [];
    day.legs[i] = straightLeg(a, b, vias);
    renderTrack(r);
    refreshDerived();

    // Two points in the same place have no route between them, and asking is both
    // a billable Routes request and a guaranteed 422 — which surfaces as "no road
    // route for that leg" in a toast, for a leg the rider never asked to route.
    // The straight leg above is already the right answer: zero meters, zero
    // seconds. This became reachable the moment duplicate-a-point shipped, which
    // by design puts the copy exactly on top of its original.
    if (!vias.length && a[0] === b[0] && a[1] === b[1]) return;

    if (!state.legSeq[r]) state.legSeq[r] = [];
    const seq = (state.legSeq[r][i] = (state.legSeq[r][i] || 0) + 1);
    directions(a, b, vias)
      .then((leg) => {
        // The day may have been deleted or reordered while this was in flight.
        if (state.days[r] !== day) return;
        if (state.legSeq[r][i] !== seq || !day.legs[i]) return;
        day.legs[i] = leg;
        renderTrack(r);
        refreshDerived();
      })
      .catch((e) => {
        console.warn("[builder] directions:", e.status || "", e.message);
        toast(legErrorText(e), true);
      });
  }

  function computeLegsAround(r, indices) {
    const n = state.days[r].points.length - 1;
    [...new Set(indices)].filter((i) => i >= 0 && i < n).forEach((i) => computeLeg(r, i));
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
    for (const leg of state.days[r].legs) {
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

  // Layers are keyed by day index, so a delete or reorder invalidates every
  // key at or after it. Rebuilding all of them is O(days) on a list capped at
  // 31 and removes a whole class of stale-layer bug.
  function rebuildLayers() {
    if (!state.map) return;
    for (let i = 0; i < state.layerCount; i++) removeRouteLayers(state.map, i);
    state.days.forEach((day, r) => {
      addRouteLayers(state.map, r, fullTrack(r), day.color, { shapeable: true });
    });
    state.layerCount = state.days.length;
    state.layersReady = true;
    applyFocus();
  }

  // The only thing the active day does to the map. Every day stays drawn; the
  // others are dimmed so the one being edited reads clearly against them.
  //
  // There is no longer an "all days, dim nothing" state — that was the slider's
  // 0 position, and the slider is gone. Something is always active, because a map
  // click always has to land somewhere.
  //
  // With a moment chosen the timeline decides instead: the day containing it
  // stays lit and the leg being ridden at it is drawn over the top. A moment in
  // the overnight gap belongs to no day, so everything dims and no leg is drawn —
  // which is what "nobody is riding right now" honestly looks like.
  function applyFocus() {
    if (!state.map) return;
    const a = activeNow();
    const lit = a ? a.dayIndex : focusedIndex();
    state.days.forEach((day, r) => {
      const dim = a ? r !== lit : lit !== null && r !== lit;
      const ghost = day.altGroup != null && !day.altActive;
      setRouteDim(state.map, r, dim);
      // Set every pass rather than once when a day is grouped: rebuildLayers()
      // recreates the entry on every add, delete, reorder and recolor, and
      // applyFocus is what runs after all of them.
      setRouteGhost(state.map, r, ghost);
      const m = state.markers[r];
      if (!m) return;
      m.points.forEach(({ el }) => {
        // A ghost stays quiet even while it is the focused day — the rider
        // clicked into it to edit it, which is precisely when they need to see
        // it is the one that does not count.
        el.style.opacity = ghost ? "0.25" : dim ? "0.35" : "";
      });
    });

    // The engine drops the highlight whenever a track is repathed, so this is a
    // re-apply rather than a set — see clearLegHighlight in map-common.js.
    const leg = a && a.dayIndex != null && a.legIndex != null ? state.days[a.dayIndex].legs[a.legIndex] : null;
    if (!leg) {
      clearLegHighlight(state.map);
      return;
    }
    const span = trackAndSpans(a.dayIndex).spans[a.legIndex];
    if (span) setLegHighlight(state.map, a.dayIndex, span.startIndex, span.endIndex);
    else clearLegHighlight(state.map);
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

  // ONE MAKER FOR BOTH KINDS. `i` indexes day.points; the kind decides only the
  // marker's CSS class — `.tb-marker-poi` is the smaller, solid, day-colored dot
  // — and whether a drag has legs to invalidate.
  function makePointMarker(r, point, i) {
    const el = markerElement(point, state.days[r].color, point.kind);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      // Clicking a marker on a dimmed day makes that day active, so the map's
      // emphasis follows what was just clicked. Every day's rows are on screen
      // now, so this is no longer what makes the row reachable — focusRow scrolls
      // to it either way.
      if (editIndex() !== r) goToDay(r);
      focusRow(point.kind, i, r);
    });
    const marker = addMarker(state.map, [point.lng, point.lat], el, { draggable: true });
    onMarkerDragEnd(marker, ([lng, lat]) => {
      const day = state.days[r];
      beginEdit(point.kind === "stop" ? "move stop" : "move POI");
      point.lng = +lng.toFixed(6);
      point.lat = +lat.toFixed(6);
      // BOTH KINDS BEND THE ROAD. Dragging a POI used to move a dot and cost
      // nothing, because a POI anchored no leg; it anchors the two either side of
      // it now, so the same surgery a stop always got applies to every point.
      // Their shaping points go with them — a via belongs to the pair of points
      // its leg used to join.
      if (day.legs[i - 1]) day.legs[i - 1].viaPoints = [];
      if (day.legs[i]) day.legs[i].viaPoints = [];
      computeLegsAround(r, [i - 1, i]);
      markDirty();
    });
    return { marker, el };
  }

  // --- Drag to shape --------------------------------------------------------

  // A shaping point is not a place anyone is going — it is a hint about which
  // road to take. It gets its own smaller handle, no row in the stop list, and
  // no place in the stop numbering.
  function makeViaMarker(r, legIndex, viaIndex, v) {
    const el = markerElement({ name: "" }, state.days[r].color, "via");
    el.title = "Shaping point—drag to move, click to remove";
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      beginEdit("remove shaping point");
      state.days[r].legs[legIndex].viaPoints.splice(viaIndex, 1);
      computeLeg(r, legIndex);
      renderMarkers();
      markDirty();
    });
    const marker = addMarker(state.map, [v[0], v[1]], el, { draggable: true });
    onMarkerDragEnd(marker, ([lng, lat]) => {
      beginEdit("move shaping point");
      state.days[r].legs[legIndex].viaPoints[viaIndex] = [+lng.toFixed(6), +lat.toFixed(6)];
      computeLeg(r, legIndex);
      renderMarkers();
      markDirty();
    });
    return { marker, el };
  }

  // Called once per drop, with a vertex index into the day's flat track.
  function shapeAt({ id: r, vertexIndex, edgeForward, lngLat }) {
    const day = state.days[r];
    if (!day) return;
    const { track, spans } = trackAndSpans(r);
    const legIndex = legAtVertex(spans, vertexIndex, edgeForward);
    if (legIndex == null || !day.legs[legIndex]) return;

    const leg = day.legs[legIndex];
    const vias = leg.viaPoints || (leg.viaPoints = []);
    if (vias.length >= MAX_VIAS_PER_LEG) {
      return toast("Up to " + MAX_VIAS_PER_LEG + " shaping points per leg", true);
    }

    beginEdit("shape route");
    // Order is the day: appending one that belongs in the middle makes the
    // leg double back on itself.
    const at = viaInsertIndex(track, spans[legIndex], vias, vertexIndex);
    vias.splice(at, 0, [+lngLat[0].toFixed(6), +lngLat[1].toFixed(6)]);
    computeLeg(r, legIndex);
    renderMarkers();
    markDirty();
  }

  function renderMarkers() {
    clearMarkers();
    state.markers = state.days.map((day, r) => ({
      points: day.points.map((pt, i) => makePointMarker(r, pt, i)),
      // One handle per shaping point, so a via can be moved or taken back out.
      vias: day.legs.flatMap((leg, li) => (leg.viaPoints || []).map((v, vi) => makeViaMarker(r, li, vi, v))),
    }));
    applyFocus();
  }

  // --- Mutations ------------------------------------------------------------

  // `dayIndex` is optional and defaults to the active day, which is what a map
  // click means — you clicked the map, not a day. The per-day search rows pass
  // their own index explicitly: a row is unambiguous about which day it belongs
  // to in a way the global search box never was, and that ambiguity is the
  // reason the box is gone.
  // `prebuilt` is how a saved place enters the ride: stopFromPlace() has already
  // made the point, roles and durable details included, and this must not
  // discard it by minting a bare one. Every other caller passes nothing.
  // THE ONE CREATION PATH. A map click, either search arm, a saved place, the
  // home seed and a new day's inherited first point all land here, and they all
  // produce a POI — the kind is not a choice anybody makes at creation time any
  // more. Ziad's call, 2026-08-23.
  //
  // EXCEPT THE FIRST POINT OF A DAY, which is promoted on the spot and tagged
  // `start`. A day has to begin somewhere, the server still requires at least
  // one stop per day, and a rider who drops one pin and saves should get a day
  // that means something rather than a validation error. It is the only implicit
  // promotion in the app.
  //
  // EVERY POINT IS ROUTED TO, whatever its kind. A point appended to a day gets a
  // leg from the one before it, which is what makes a start plus one POI draw a
  // road — the report that changed this on 2026-08-24. Note the cost that comes
  // with it: adding a POI is a Routes request now, where it used to be free.
  // `at` is where in the day's list the point goes, and it defaults to the end —
  // which is every caller except the insert-between rows. It is what makes
  // "wedge a stop between these two" the same code path as appending one, so a
  // point inserted mid-day gets the same kinds, the same roles and the same legs.
  function addPoint(lng, lat, name, dayIndex, prebuilt, at) {
    const r = dayIndex == null ? editIndex() : dayIndex;
    if (r == null || !state.days[r]) return noDayYet();
    const day = state.days[r];
    if (day.points.length >= MAX_POINTS) return toast("Point limit reached (" + MAX_POINTS + ")", true);
    const oldLen = day.points.length;
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
    day.points.splice(where, 0, pt);

    // ONE NEW LEG, wherever the point landed. A day with N points has N−1 legs,
    // so inserting one point adds exactly one leg — and splicing a placeholder in
    // at `where` puts the two legs that need recomputing at `where - 1` and
    // `where`, which is what computeLegsAround is given below.
    //
    // Worked through: [A,B] with leg [AB], insert X at 1 → legs become
    // [AB, placeholder], recomputing 0 and 1 gives [AX, XB]. Insert at 0 →
    // [placeholder, AB], recomputing 0 gives [XA] and leg 1 stays AB. Appending
    // is the same operation with `where === oldLen`, which is why there is no
    // separate branch for it.
    if (!first) {
      day.legs.splice(Math.min(where, day.legs.length), 0, straightLeg([pt.lng, pt.lat], [pt.lng, pt.lat]));
      state.legSeq[r] = [];
      computeLegsAround(r, [where - 1, where]);
    }
    // The slot has been used, so it closes. Left open, the next render would put
    // a second field in the middle of the day the rider just finished with.
    state.insertAt = null;
    renderTrack(r);
    renderMarkers();
    // renderDayList(r), not renderList(): renderList redraws the ACTIVE day, and
    // a search row can add to a day that is not it.
    renderDayList(r);
    refreshDerived();
    markDirty();
  }

  /**
   * Promotes a POI to a stop, or demotes a stop back to a POI.
   *
   * A FLAG FLIP AND NOTHING ELSE, as of 2026-08-24. Every point anchors a leg
   * whatever its kind, so the road does not change, no leg is rebuilt, no shaping
   * point is dropped and no Routes request is made. What changes is the row's
   * number, the marker's size, and whether the ride counts it as a stop.
   *
   * It used to rebuild the legs either side and clear their vias, because the
   * STOP SEQUENCE changed and a via belonged to the pair of stops its leg joined.
   * That is the cost this model removes: promoting a point is now free and exactly
   * reversible, where before it spent two Routes calls and silently threw away the
   * rider's shaping work on both legs.
   */
  function setPointKind(i, kind) {
    const r = editIndex();
    if (r == null) return;
    const day = state.days[r];
    const pt = day.points[i];
    if (!pt || pt.kind === kind) return;
    if (kind === "stop" && stopsOf(day).length >= MAX_STOPS) {
      return toast("Stop limit reached (" + MAX_STOPS + ")", true);
    }
    // The last stop of a day cannot be demoted: the day would have none, the
    // save would 400, and payload() would drop the day whole.
    if (kind === "poi" && stopsOf(day).length <= 1) {
      return toast("A day needs at least one stop", true);
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
    renderDayList(r);
    refreshDerived();
    markDirty();
  }

  // --- Arming a map click ---------------------------------------------------
  //
  // "+ Stop" at the end of a day cannot place anything on its own: a button in a
  // list has no coordinates. It arms the NEXT map click for that day instead —
  // press it, click the road you meant, and the stop lands there.
  //
  // This is the behavior the removed panel-wide + Stop / + POI pair actually
  // had. What was wrong with that pair was not the mechanism but that it read as
  // "add something" while being a mode switch, sat nowhere near the day it would
  // affect, and never said it was on. This one lives on the day it acts on and
  // shows its own state.
  // True when THIS row is the armed one. Both halves matter: an insert row and
  // the day's bottom row are different affordances on the same day, so arming one
  // must not light the other.
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
    if (!state.days[r]) return;
    if (state.days[r].points.length >= MAX_POINTS) return toast("Point limit reached (" + MAX_POINTS + ")", true);
    state.arm = r;
    state.armAt = slot;
    // The armed day becomes the working day, so everything else that keys off
    // "where the rider is" agrees with the thing about to happen.
    setActive(r);
    paintArm();
    toast(
      slot == null
        ? "Click the map to add a stop to " + dayLabel(r)
        : "Click the map to insert a point into " + dayLabel(r),
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

  // Painted rather than re-rendered. renderDayList() would rebuild the row and
  // take the focus ring with it, and arming is not an edit — it must not touch
  // the undo history or mark the ride dirty. addRowHtml() reads state.arm on its
  // own, so a render that happens for some other reason still comes back armed.
  function paintArm() {
    document.querySelectorAll(".add-place-btn").forEach((b) => {
      const on = Number(b.dataset.day) === state.arm;
      b.classList.toggle("is-armed", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.body.classList.toggle("is-arming", state.arm != null);
  }

  // `i` indexes day.points, and EVERY kind leaves a hole in the route — a POI is
  // ridden through, so removing one joins its neighbors the same way removing a
  // stop does. The surgery used to be a stop-only path expressed in stop
  // ordinals; there is one index space now and one code path.
  function deletePoint(i) {
    const r = editIndex();
    if (r == null) return;
    const day = state.days[r];
    const pt = day.points[i];
    if (!pt) return;
    beginEdit(pt.kind === "stop" ? "delete stop" : "delete POI");
    day.points.splice(i, 1);

    if (day.legs.length) {
      const pts = day.points;
      // Remove the legs that touched point i, then bridge the gap (if any). One
      // leg at either end of the day, two in the middle.
      const from = Math.max(0, i - 1);
      day.legs.splice(from, i === 0 || i === pts.length ? 1 : 2);
      state.legSeq[r] = [];
      if (i > 0 && i < pts.length) {
        day.legs.splice(
          from,
          0,
          straightLeg([pts[i - 1].lng, pts[i - 1].lat], [pts[i].lng, pts[i].lat]),
        );
        computeLeg(r, from);
      }
    }
    renderTrack(r);
    renderMarkers();
    renderList();
    refreshDerived();
    markDirty();
  }

  // Copy a point, placed straight after the one it came from. New in the row
  // menu — this capability did not exist before, so the menu adds something
  // rather than only rearranging what was there.
  //
  // The roles array is COPIED, not shared. Sharing it would make the two points
  // one point wherever roles are concerned, and the same aliasing would reach
  // back through the undo stack — see the header of builder-history.js, which
  // records exactly which fields may be shared by reference and warns that the
  // set changes whenever a feature like this one lands.
  function duplicatePoint(kind, i) {
    const r = editIndex();
    if (r == null) return noDayYet();
    const day = state.days[r];
    const list = day.points;
    const src = list[i];
    if (!src) return;
    const cap = MAX_POINTS;
    if (list.length >= cap) return toast((kind === "stop" ? "Stop" : "POI") + " limit reached (" + cap + ")", true);

    beginEdit("duplicate " + kind);
    // A FRESH uid and a deep copy of details. The uid because two points sharing
    // one violates the per-day unique index — the server's ensureUids would break
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
    // a points index — which was already wrong for any day with a POI ahead of the
    // duplicated stop. One index space makes it right rather than papering over it.
    day.legs.splice(i, 0, straightLeg([src.lng, src.lat], [src.lng, src.lat]));
    state.legSeq[r] = [];
    computeLegsAround(r, [i - 1, i, i + 1]);
    renderTrack(r);
    renderMarkers();
    renderList();
    refreshDerived();
    markDirty();
  }

  // MOVE a point to an arbitrary index, which is what a drag produces. movePoint
  // below steps one place at a time, which is the same thing only for a one-step
  // move — dragging point 2 to position 5 with a swap would put point 5 at 2, and
  // that is not what anybody dragging means.
  //
  // Which legs are wrong afterwards: a leg joins consecutive POINTS, so ANY move
  // changes the road. Every leg from the one before the earlier index through the
  // one after the later index is refilled — recomputing the whole day instead
  // would be correct and would also fire a routing request per leg, which is the
  // half that costs money.
  //
  // There used to be a short circuit here: a move that left the STOP sequence
  // untouched — any POI drag, or a stop dropped among POIs without passing
  // another stop — changed no leg and cost nothing. A POI is on the route now, so
  // there is no such move and the short circuit is gone with it. Dragging a POI is
  // a real re-route.
  //
  // What used to be here: a POI drag was a REPOSITION, not a reorder — the pin
  // was relocated to the road midway between the rows it was dropped between,
  // because a POI had no stored order for a drag to change. It moved a place the
  // rider had chosen, and dropping one back where it started relocated it to the
  // midpoint of its neighbors. Both are gone: a POI has a position now.
  function reorderPoint(from, to) {
    if (from === to) return;
    const r = editIndex();
    if (r == null) return;
    const day = state.days[r];
    if (from < 0 || from >= day.points.length || to < 0 || to >= day.points.length) return;

    beginEdit("move point");
    const [moved] = day.points.splice(from, 1);
    day.points.splice(to, 0, moved);

    const lo = Math.min(from, to) - 1;
    const hi = Math.max(from, to) + 1;
    const idx = [];
    for (let k = lo; k <= hi; k++) {
      // Shaping points belong to the pair of points the leg used to join, so
      // they are meaningless once either end changes.
      if (day.legs[k]) day.legs[k].viaPoints = [];
      idx.push(k);
    }
    computeLegsAround(r, idx);
    renderTrack(r);
    renderMarkers();
    renderList();
    refreshDerived();
    markDirty();
  }

  // The row menu's Move up / Move down, and the keyboard path. `i` indexes
  // day.points and both kinds get it now — a POI has an order to change.
  function movePoint(i, dir) {
    const r = editIndex();
    if (r == null) return;
    const day = state.days[r];
    const j = i + dir;
    if (j < 0 || j >= day.points.length) return;
    reorderPoint(i, j);
  }

  // --- Days -----------------------------------------------------------------

  // Makes a day active AND puts the timeline on its opening moment. setActive()
  // above is the cheap version that every row handler calls; this is the one for
  // a deliberate "work on this day now" — the rail's dots, a marker click, a
  // freshly added day.
  //
  // The split matters: moving the timeline is a visible jump on the map, and
  // doing it every time a rider clicked into a stop's name field would yank the
  // view out from under them.
  function goToDay(r) {
    setActive(r);
    const day = state.days[activeIndex()];
    state.moment = day ? dayStartS(day) : null;
    applyFocus();
    refreshDerived();
  }

  function addDay() {
    if (state.days.length >= MAX_DAYS) return toast("Day limit reached (" + MAX_DAYS + ")", true);
    beginEdit("add day");
    // THE LAST DAY THAT COUNTS, not the last section on screen. If the ride ends
    // with a pair of alternates, the last row might be the one the rider decided
    // against — seeding from it would start the new day at the wrong place and,
    // via nextMorningAfter below, on the wrong evening.
    const counted = ALT.activeDays(state.days);
    const prev = counted[counted.length - 1];
    const day = newDay(DAY_COLORS[state.days.length % DAY_COLORS.length]);

    // A day begins where the last one ended. Without this every new day starts
    // with a search for a place you already have on the map.
    //
    // The last POINT, not the last stop. Every point is somewhere the rider rides
    // to, so the day physically ends at the last one in the list whatever its
    // kind — a day finishing at a viewpoint ends at the viewpoint.
    const lastPts = prev ? prev.points : [];
    const last = lastPts[lastPts.length - 1];
    if (last) {
      day.points.push({
        lat: last.lat,
        lng: last.lng,
        name: last.name,
        description: "",
        roles: [],
        durationMin: null,
      });
    }

    // And it begins the morning after the last one finished. Syncing the
    // previous day first because its end may be derived, and reading a stale
    // cache here would seed off the wrong evening. A previous day with no times
    // seeds nothing — nothing invents a date for a ride the rider never dated.
    if (prev) {
      syncEnd(prev);
      day.startAt = nextMorningAfter(prev.endAt);
    }

    state.days.push(day);
    renderDays();
    goToDay(state.days.length - 1); // work on the new day
    rebuildLayers();
    renderMarkers();
    markDirty();
  }

  function deleteDay() {
    // GUARDS BEFORE beginEdit, not after. All four of these functions had it the
    // other way round, so refusing to delete a ride's last day still pushed an
    // undo step — the rider then pressed undo and nothing visible happened.
    if (state.days.length <= 1) return toast("A ride needs at least one day", true);
    const r = editIndex();
    if (r == null) return noDayYet();
    beginEdit("delete day");
    state.days.splice(r, 1);
    state.legSeq.splice(r, 1);
    // Deleting one of a pair leaves a group of one, which is not a group. The
    // server would repair it on the next save anyway; doing it here means the
    // panel and the map agree with the totals immediately rather than after a
    // round trip.
    ALT.resolveAltGroups(state.days);
    // Clamped, not preserved: deleting the last day would leave the active index
    // one past the end, and activeIndex() would quietly clamp it on every read
    // while the highlight sat on nothing.
    state.active = Math.min(r, state.days.length - 1);
    renderDays();
    rebuildLayers();
    renderMarkers();
    refreshDerived();
    markDirty();
  }

  // Ride the day backwards.
  //
  // Every leg has to be re-requested, not reversed in place: a leg's geometry is
  // directional, and the way back is frequently not the way out drawn backwards.
  // One-way streets, divided carriageways and turn restrictions all mean the
  // router has to answer the question again.
  //
  // That costs one Routes call per leg, which is why a long day asks first.
  function reverseDay() {
    const r = editIndex();
    if (r == null) return noDayYet();
    const day = state.days[r];
    // POINTS, not stops. A day of three POIs draws a road and has something to
    // reverse; counting stops would have told the rider there was nothing there.
    if (day.points.length < 2) return toast("Nothing to reverse yet", true);

    const legCount = Math.max(0, day.points.length - 1);
    // "re-routes", not "re-days" — a find-and-replace during the 2026-08-09
    // routes→days rename caught this string, which a rider reads in a dialog.
    if (legCount > 12 && !window.confirm("Reversing re-routes all " + legCount + " legs of this day. Continue?")) return;

    // Every guard and the confirm are behind us, so this is the first point at
    // which the day is certainly going to change.
    beginEdit("reverse day");
    // REVERSE THE WHOLE LIST, both kinds. A POI has a place in the order now, and
    // a day ridden backwards passes its viewpoints in the opposite order too —
    // leaving them where they were would strand each one beside the wrong leg.
    day.points.reverse();

    // A stop tagged as the start is the finish now. Nothing else about a role
    // has a direction — a gas stop is a gas stop either way round.
    day.points.forEach((s) => {
      s.roles = (s.roles || []).map((role) => (role === "start" ? "finish" : role === "finish" ? "start" : role));
    });

    // Not reversed: legs and their shaping points are both directional and both
    // stale. Dropping them wholesale is cheaper than reasoning about which
    // survive, and computeLeg refills them from the new stop order.
    day.legs = [];
    state.legSeq[r] = [];

    renderTrack(r);
    renderMarkers();
    renderList();
    computeLegsAround(r, Array.from({ length: legCount }, (_, i) => i));
    refreshDerived();
    markDirty();
    toast(dayLabel(r) + " reversed");
  }

  // --- Select mode ----------------------------------------------------------
  //
  // Turn on from either ⋮ menu; checkboxes appear on every peer and a bar at the
  // top of the list offers what can be done to the set. It exists because the
  // alternative to "select four days and delete them" is doing it four times,
  // and because grouping days as alternates is inherently a multi-day action
  // with nowhere else to live.
  //
  // TWO SCOPES, NEVER BOTH. Days and points are different kinds of thing and
  // "delete the selected" has to mean one of them. Opening one closes the other.
  const pointKey = (r, kind, i) => r + ":" + kind + ":" + i;

  function startSelect(scope) {
    closeMenu();
    state.select = { scope, days: new Set(), points: new Set() };
    renderDays();
    renderSelectBar();
  }

  function endSelect() {
    if (!state.select) return;
    state.select = null;
    renderDays();
    renderSelectBar();
  }

  const selectedDays = () => [...(state.select?.days ?? [])].sort((a, b) => a - b);

  // Grouped by day and sorted DESCENDING within each, which is the order a
  // caller must splice in — ascending is off by one more with every removal and
  // the bug is silent.
  function selectedPointsByDay() {
    const byDay = new Map();
    for (const key of state.select?.points ?? []) {
      const [r, kind, i] = key.split(":");
      const day = Number(r);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({ kind, i: Number(i) });
    }
    for (const list of byDay.values()) list.sort((a, b) => b.i - a.i);
    return byDay;
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
    const isDay = sel.scope === "day";
    const n = isDay ? sel.days.size : sel.points.size;
    const noun = isDay ? (n === 1 ? "day" : "days") : n === 1 ? "point" : "points";
    // Buttons are disabled rather than hidden at n === 0, so the bar is the same
    // shape the moment it opens as it is once something is ticked.
    const off = n === 0 ? " disabled" : "";
    const dayBtns =
      '<button type="button" data-sel="group"' + (sel.days.size < 2 ? " disabled" : "") + ">Group as alternatives</button>" +
      '<button type="button" data-sel="duplicate"' + off + ">Duplicate</button>";
    const pointBtns =
      '<label class="sel-move">Move to <select data-sel="move-to">' +
      '<option value="">day…</option>' +
      state.days.map((_, r) => '<option value="' + r + '">' + esc(dayNumber(r)) + "</option>").join("") +
      "</select></label>";
    bar.hidden = false;
    bar.innerHTML =
      '<span class="sel-count">' + n + " " + noun + " selected</span>" +
      '<button type="button" data-sel="all">All</button>' +
      '<button type="button" data-sel="none"' + off + ">None</button>" +
      (isDay ? dayBtns : pointBtns) +
      '<button type="button" class="is-danger" data-sel="delete"' + off + ">Delete</button>" +
      '<button type="button" data-sel="done">Done</button>';
  }

  // Group the selected days as alternatives of one another. The entry point for
  // the whole alternates feature — everything else about them (ghosting, the
  // totals, the numbering) has been in place since they could only be created by
  // hand-writing a payload.
  function groupSelectedAsAlts() {
    const rows = selectedDays();
    if (rows.length < 2) return toast("Pick at least two days", true);
    if (rows.some((r) => state.days[r].altGroup != null)) {
      return toast("One of those is already an alternative—ungroup it first", true);
    }
    // A WARNING, NOT A REFUSAL. docs/ROADMAP.md defines an alternate as two paths
    // that share a start and an end, and day-level grouping cannot enforce that:
    // if two alternates finish in different towns, the following day starts with
    // a hole in the ride and nothing else in the app would mention it. The rider
    // may well know what they mean, so this says so and continues.
    const gap = endpointGap(rows);
    beginEdit("group as alternatives");
    const id = Math.max(-1, ...state.days.map((d) => (d.altGroup == null ? -1 : d.altGroup))) + 1;
    rows.forEach((r, k) => {
      state.days[r].altGroup = id;
      state.days[r].altActive = k === 0;
    });
    ALT.resolveAltGroups(state.days);
    endSelect();
    rebuildLayers();
    renderMarkers();
    refreshDerived();
    markDirty();
    if (gap) toast(gap, true);
    else toast(rows.length + " days are now alternatives—only the first counts");
  }

  // The message for a group whose members do not start and end together, or null
  // when they do. Compared against the first selected day, which is the one that
  // becomes active.
  function endpointGap(rows) {
    // The first and last POINTS of each candidate. Where a day starts and ends is
    // where its road starts and ends, and both ends anchor a leg whatever kind
    // they are.
    const ends = rows.map((r) => {
      const pts = state.days[r].points;
      return pts.length ? { first: pts[0], last: pts[pts.length - 1] } : null;
    });
    const base = ends[0];
    if (!base) return null;
    const far = (a, b) => a && b && haversineMi(a, b) > 0.06; // ~100 m, as the importer uses
    for (let k = 1; k < ends.length; k++) {
      const e = ends[k];
      if (!e) continue;
      if (far(base.first, e.first) || far(base.last, e.last)) {
        return "Those alternatives do not start and end in the same place—whichever you ride, the next day may not join up.";
      }
    }
    return null;
  }

  function haversineMi(a, b) {
    const R = 3958.7613;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const h =
      Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ONE beginEdit FOR THE WHOLE BATCH, in every one of these. Looping over
  // deleteDay() would push an undo step per day and leave the rider pressing
  // undo four times to put back one action — which is why the single-item
  // mutators had their guards moved ahead of their beginEdit in step 8 and why
  // these do the splicing themselves rather than calling them.
  function deleteSelectedDays() {
    const rows = selectedDays();
    if (!rows.length) return;
    if (rows.length >= state.days.length) return toast("A ride needs at least one day", true);
    beginEdit("delete days");
    // Descending, so each splice cannot shift the index of one still to come.
    [...rows].reverse().forEach((r) => {
      state.days.splice(r, 1);
      state.legSeq.splice(r, 1);
    });
    state.active = Math.min(state.active, state.days.length - 1);
    ALT.resolveAltGroups(state.days);
    endSelect();
    rebuildLayers();
    renderMarkers();
    refreshDerived();
    markDirty();
    toast(rows.length + " days deleted");
  }

  function duplicateSelectedDays() {
    const rows = selectedDays();
    if (!rows.length) return;
    if (state.days.length + rows.length > MAX_DAYS) return toast("Day limit reached (" + MAX_DAYS + ")", true);
    beginEdit("duplicate days");
    // Descending again: each insertion shifts everything after it, and going
    // backwards means the indices still to come are untouched.
    [...rows].reverse().forEach((r) => {
      const src = state.days[r];
      state.days.splice(r + 1, 0, {
        ...src,
        title: src.title ? src.title + " (copy)" : "",
        // A FRESH uid, or the spread above copies the original's and the save
        // fails uq_day_ride_uid — the same reason a duplicated point gets one.
        uid: uid(),
        altGroup: null,
        altActive: true,
        points: src.points.map((pt) => ({ ...pt, roles: (pt.roles || []).slice() })),
        legs: src.legs.map((l) => ({ ...l, viaPoints: (l.viaPoints || []).slice() })),
      });
      state.legSeq.splice(r + 1, 0, []);
    });
    ALT.resolveAltGroups(state.days);
    endSelect();
    rebuildLayers();
    renderMarkers();
    refreshDerived();
    markDirty();
    toast(rows.length + " days duplicated");
  }

  function deleteSelectedPoints() {
    const byDay = selectedPointsByDay();
    const n = selectedPointCount();
    if (!n) return;
    // Every point removed drops the legs either side and re-requests one, so a
    // big selection is real money and a visibly empty map while it runs. Same
    // threshold and same reasoning as reverseDay's confirm. Counted over both
    // kinds now — a POI costs exactly what a stop costs.
    if (n > 12 && !window.confirm("Deleting " + n + " points re-routes the legs around each. Continue?")) return;
    beginEdit("delete points");
    for (const [r, list] of byDay) {
      const day = state.days[r];
      if (!day) continue;
      // Already sorted descending by selectedPointsByDay().
      list.forEach((p) => day.points.splice(p.i, 1));
      // A DAY MUST KEEP A STOP. A selection can take every stop and leave the
      // POIs, which the API refuses and payload() drops the day for — so the
      // first survivor is promoted, the same rule addPoint applies to a day's
      // first point and the cross-day drag applies to a day that has just lost
      // its only anchor.
      if (day.points.length > 0 && stopsOf(day).length === 0) day.points[0].kind = "stop";
      // Legs are rebuilt wholesale rather than repaired around each removal —
      // with several gone at once there is no "the leg either side" to bridge.
      // Unconditional now: losing any point of either kind changes the road.
      day.legs = [];
      state.legSeq[r] = [];
    }
    const touched = [...byDay.keys()];
    endSelect();
    rebuildLayers();
    renderMarkers();
    touched.forEach((r) => {
      const day = state.days[r];
      const nPts = day ? day.points.length : 0;
      if (day && nPts >= 2 && day.legs.length === 0) {
        fillMissingLegs(day);
        computeLegsAround(r, Array.from({ length: nPts - 1 }, (_, k) => k));
      }
    });
    refreshDerived();
    markDirty();
    toast(n + " points deleted");
  }

  function moveSelectedPoints(toDay) {
    const byDay = selectedPointsByDay();
    const n = selectedPointCount();
    const dst = state.days[toDay];
    if (!n || !dst) return;
    beginEdit("move points");
    const moved = [];
    for (const [r, list] of byDay) {
      const day = state.days[r];
      if (!day || r === toDay) continue;
      list.forEach((p) => {
        const [pt] = day.points.splice(p.i, 1);
        if (pt) moved.push({ kind: p.kind, pt });
      });
      // Same rule as the bulk delete: moving every stop out of a day leaves one
      // the save refuses, so the first point left behind becomes the anchor.
      if (day.points.length > 0 && stopsOf(day).length === 0) day.points[0].kind = "stop";
      day.legs = [];
      state.legSeq[r] = [];
    }
    // Reversed, because each day's list was spliced descending and the points
    // came off in the opposite order to the one they were in.
    moved.reverse().forEach(({ pt }) => dst.points.push(pt));
    // And the destination, which can be a day whose points all arrived as POIs.
    if (dst.points.length > 0 && stopsOf(dst).length === 0) dst.points[0].kind = "stop";
    dst.legs = [];
    state.legSeq[toDay] = [];
    const touched = new Set([...byDay.keys(), toDay]);
    endSelect();
    setActive(toDay);
    rebuildLayers();
    renderMarkers();
    touched.forEach((r) => {
      const day = state.days[r];
      const nPts = day ? day.points.length : 0;
      if (day && nPts >= 2) {
        fillMissingLegs(day);
        computeLegsAround(r, Array.from({ length: nPts - 1 }, (_, k) => k));
      }
    });
    refreshDerived();
    markDirty();
    toast(moved.length + " points moved to " + dayLabel(toDay));
  }

  // Copy a whole day, inserted straight after the original.
  //
  // The legs come across as they are rather than being re-requested: the copy
  // has the same stops in the same order, so its geometry is the same road and
  // asking the router again would cost one call per leg to be told so. Every
  // array is copied rather than shared — the snapshot rule in builder-history.js
  // applies to live state too, and a shared `roles` array would have a role
  // added to the copy appearing on the original.
  //
  // This is what "make an alternate" is built on: duplicate the day, change the
  // copy, then group the two. Grouping itself is a bulk action on a selection.
  function duplicateDay(r) {
    if (state.days.length >= MAX_DAYS) return toast("Day limit reached (" + MAX_DAYS + ")", true);
    const src = state.days[r];
    if (!src) return;
    beginEdit("duplicate day");
    const copy = {
      ...src,
      title: src.title ? src.title + " (copy)" : "",
      // A FRESH uid, for the same reason the multi-day duplicate above mints
      // one: the spread would otherwise carry the original's and the save would
      // fail uq_day_ride_uid.
      uid: uid(),
      // The copy is NOT part of its original's group. A duplicate of one
      // alternate would otherwise silently become a third member of a group the
      // rider has not been asked about.
      altGroup: null,
      altActive: true,
      points: src.points.map((pt) => ({ ...pt, roles: (pt.roles || []).slice() })),
      legs: src.legs.map((l) => ({ ...l, viaPoints: (l.viaPoints || []).slice() })),
    };
    state.days.splice(r + 1, 0, copy);
    state.legSeq.splice(r + 1, 0, []);
    ALT.resolveAltGroups(state.days);
    setActive(r + 1);
    renderDays();
    rebuildLayers();
    renderMarkers();
    refreshDerived();
    markDirty();
    toast("Duplicated to " + dayLabel(r + 1));
  }

  // Choose a different member of a group as the one being ridden. This is the
  // resolution step — the point at which a rider stops weighing two roads and
  // picks one — and it is why altActive exists as a flag rather than the group's
  // first day simply winning: promoting must not reorder the ride and renumber
  // every day after it.
  function promoteAlt(r) {
    const day = state.days[r];
    if (!day || day.altGroup == null || day.altActive) return;
    beginEdit("choose alternative");
    state.days.forEach((d) => {
      if (d.altGroup === day.altGroup) d.altActive = false;
    });
    day.altActive = true;
    ALT.resolveAltGroups(state.days);
    renderDays();
    renderMarkers();
    refreshDerived();
    markDirty();
    toast("Now riding " + dayLabel(r));
  }

  // Break a group apart: every member becomes an ordinary day again and all of
  // them start counting toward the ride. The way out of a grouping, without
  // which the feature is a trap.
  function ungroupAlts(r) {
    const day = state.days[r];
    if (!day || day.altGroup == null) return;
    beginEdit("ungroup alternatives");
    const group = day.altGroup;
    let n = 0;
    state.days.forEach((d) => {
      if (d.altGroup !== group) return;
      d.altGroup = null;
      d.altActive = true;
      n++;
    });
    ALT.resolveAltGroups(state.days);
    renderDays();
    renderMarkers();
    refreshDerived();
    markDirty();
    toast(n + " days are separate days again");
  }

  function moveDay(dir) {
    const r = editIndex();
    if (r == null) return noDayYet();
    const j = r + dir;
    // At either end there is nothing to do, and pushing an undo step for it
    // means the rider's next undo silently spends itself on a no-op.
    if (j < 0 || j >= state.days.length) return;
    beginEdit("move day");
    const a = state.days;
    [a[r], a[j]] = [a[j], a[r]];
    const s = state.legSeq;
    [s[r], s[j]] = [s[j] || [], s[r] || []];
    state.active = j;
    renderDays();
    rebuildLayers();
    renderMarkers();
    markDirty();
  }

  // THE NUMBER IS THE POSITION AND THE NAME IS THE NAME. They used to be one
  // field: dayLabel returned `title || "Day N"`, so naming a day REPLACED its
  // number and an unnamed day borrowed the ordinal as a name. That reads fine
  // until days can be reordered — "Big Sur run" tells you nothing about where it
  // sits, and a day called "Day 2" that has been dragged into third place is
  // actively wrong and cannot be corrected, because the text is the title.
  //
  // Now the ordinal is derived from the index on every render and is not
  // editable, and the title is free text that may be empty.
  // NOT `r + 1`, which it was until alternates. A ride whose days 3 and 4 are
  // two ways to do the same Thursday has four sections and is a three-day ride,
  // so the index is no longer the ordinal: the active days number 1..N and a
  // losing alternate takes its group's number with a letter — 3, 3b, 3c.
  //
  // Recomputed per call rather than cached on the day, because it depends on
  // every other day: adding, deleting, reordering or promoting one renumbers
  // its neighbors. TBAlt.dayOrdinals does the whole array in one pass and is
  // what a render loop should use; this is the single lookup.
  const dayNumber = (r) => ALT.dayOrdinal(state.days, r);
  const dayName = (r) => (state.days[r] && state.days[r].title) || "";

  // For prose — toasts, the timeline readout, the totals line. Both parts when
  // there is a name, the number alone when there is not.
  function dayLabel(r) {
    const name = dayName(r);
    return name ? "Day " + dayNumber(r) + " · " + name : "Day " + dayNumber(r);
  }

  // EVERY DAY, RENDERED AT ONCE. This replaces renderSlider + renderDayEditing +
  // renderDayHead, which between them showed exactly one day and hid the rest
  // behind a slider at the bottom of the drawer.
  //
  // Structure is rebuilt here; VALUES are not written back on every keystroke.
  // That split is why typing in a day title does not lose the caret: the input
  // handler updates state and the derived figures, and never calls this.
  //
  // Which means this is called only when the SET of days changes — add, delete,
  // reorder, or first load.
  function renderDays() {
    const host = $("day-list");
    if (!host) return;
    // AN OPEN SLOT DOES NOT SURVIVE A STRUCTURAL REBUILD. This runs when points
    // are deleted, reordered, moved between days or a day is added — all of which
    // shift the indices the slot is expressed in, so "before points[3]" stops
    // meaning the gap the rider was looking at. Closing it is honest; silently
    // pointing somewhere else is not.
    //
    // renderDayList() deliberately does NOT do this, which is what lets opening a
    // slot render itself.
    state.insertAt = null;
    // Same reasoning: {day, i} stops meaning the row the rider was looking at the
    // moment a delete or a reorder shifts the indices.
    state.rolesOpen = null;
    const open = openSections();
    host.innerHTML = state.days.map((day, r) => daySectionHtml(day, r, open)).join("");
    state.days.forEach((_, r) => renderDayList(r));
    markActiveSection();
    renderRailDays();
    $("day-empty-hint").hidden = state.days.length > 0;
    // One Sortable per day list, all in the same group, so a stop can be dragged
    // from one day into another. See initDragToReorder.
    host.querySelectorAll(".point-list").forEach((el) => initDragToReorder(el));
    initDayDrag(host);
    // Here rather than on its own, because the two disagree the moment they are
    // separate: a day's picker lists the subgroups and the editor renames them,
    // so a rename that redrew only the editor would leave every picker showing
    // the old name until something else happened to re-render.
    renderSubgroups();
    applyReadOnly();
  }

  /**
   * Turn the panel's controls off for a rider who may look but not write.
   *
   * Runs after every render because the day list is rebuilt wholesale — a row
   * disabled once comes back enabled the next time anything re-renders.
   *
   * It disables FIELDS, not buttons wholesale: the tab strip, the day rail and
   * the row menus are how a reader moves around, and a panel whose every button
   * is dead is not read-only, it is broken. `.builder-readonly` on the body is
   * what hides the controls that only make sense for an editor — the add rows,
   * the drag handles — and lives in style/_builder.scss.
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
  // Routes, Groups and Riders. Adding the rider and group layers to a panel that
  // was already the densest surface in the app turned it into one long scroll,
  // with the day being edited pushed below the fold by a feature about people.
  //
  // THE BEHAVIOR IS public/js/tabs.js, shared with the dashboard's ride lists.
  // The roving tabindex, the arrow keys and the `hidden` switching all live
  // there; what is left here is the one thing this strip does that a generic one
  // does not, which is fetch the roster when the Riders tab opens.
  //
  // init() is called directly rather than through the `data-tabs` auto-wiring,
  // because that hook is the whole reason this file still has a function here.

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
  // read is /api/rides/:id/riders and the two writes are its siblings — see the
  // block at the foot of src/routes/roster.tsx for why only two verbs are here.
  //
  // NOT A SECOND ROSTER. RSVP, bike, invite and the vote are statements BY a
  // rider rather than decisions by the planner, and they stay on the roster
  // page, which is also the only rider surface a non-owner can reach. What is in
  // this tab is the part that is about the plan: assigning somebody to a group,
  // and taking somebody off the ride.
  //
  // THE GROUP PICKER IS THE ONE PLACE ids AND uids MEET. Everything else in this
  // file holds a subgroup by uid, because the client mints those and the server
  // reconciles on them; `ride_members.subgroup_id` is a numeric id, which does
  // not exist until the ride has been saved. So the picker's options come from
  // the SERVER's list, not from state.meta.subgroups, and a group the rider just
  // added is missing from it until the autosave lands — which is what
  // `unsavedGroups` says out loud rather than leaving as a group that silently
  // cannot be picked.

  // The last response, so flipping between tabs does not re-fetch on every press.
  //
  // IT EXPIRES RATHER THAN LIVING FOR THE SESSION. Everything this tab can change
  // it invalidates itself, but the roster is also editable from /m/:slug/riders
  // in another window — a rider RSVPs, the owner invites somebody — and a cache
  // with no clock would show that session's opening snapshot an hour later. A few
  // seconds is long enough for the tab-flipping it exists for and short enough
  // that nothing sits visibly wrong.
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
        '<p class="riders-empty">Riders appear here once the ride saves. You are on it already—' +
        "every ride has its planner on the roster.</p>";
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
  // when it has no uid — "is this hotel actually walkable" versus "can we leave
  // an hour earlier". They are read in one place, below the tabs, because a
  // fourth tab would undo the three-tab decision; they are WRITTEN from two, the
  // composer here and the row menu's "Comment on this stop".
  //
  // A COMMENT WHOSE POINT IS DELETED IS NOT DELETED WITH IT. The server clears
  // its anchor and the comment carries on at ride level, still labeled with the
  // stop it was about — see demoteOrphanComments in src/comments/service.ts.
  // Nothing here has to handle that case specially: an unanchored comment with a
  // pointLabel renders exactly like one that always was.
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
    for (const day of state.days) {
      for (const pt of day.points) if (pt.uid === uid) return pt.name || pt.label || "";
    }
    return "";
  }

  function commentRowHtml(c) {
    const mine = commentsCache && c.authorId === commentsCache.viewerId;
    const canManage = mine || window.TB.isOwner === true;
    const when = new Date(c.createdAt);
    return (
      '<li class="comment' + (c.resolvedAt ? " is-resolved" : "") + '" data-cid="' + c.id + '">' +
      '<div class="comment-meta">' +
      '<strong>' + esc(c.authorName) + "</strong>" +
      (c.pointLabel ? '<span class="comment-on">on ' + esc(c.pointLabel) + "</span>" : "") +
      '<time datetime="' + esc(c.createdAt) + '">' + esc(when.toLocaleDateString()) + "</time>" +
      "</div>" +
      '<p class="comment-body">' + esc(c.body) + "</p>" +
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
        (commentAnchor ? "Comment on " + esc(labelForUid(commentAnchor)) : "Comment on this ride") +
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
  // A SUGGESTION IS A WHOLE DAY, PROPOSED AGAINST THAT DAY AS IT WAS. A rider
  // below `edit` still edits the panel normally — markDirty keeps their work in
  // `state` and files nothing — and Suggest posts the day they are looking at.
  // The owner accepts it, which is an ordinary ride save with one day swapped, or
  // discards it.
  //
  // STALENESS IS THE SERVER'S ANSWER AND IS NEVER COMPUTED HERE. It compares the
  // day's fingerprint now against the one taken when the proposal was made, and
  // it re-checks on accept — the list this page drew may be minutes old, and
  // applying a proposal made against a day that has since moved is the one real
  // hazard the feature has.
  let suggestionsCache = null;
  let suggestionsLoading = false;

  const SUGGESTION_LABELS = {
    pending: "Waiting on the owner",
    stale: "The day changed—needs redoing",
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
    const dayNo = state.days.findIndex((d) => d.uid === sg.dayUid);
    return (
      '<li class="comment suggestion is-' + esc(sg.state) + '" data-sid="' + sg.id + '">' +
      '<div class="comment-meta">' +
      "<strong>" + esc(sg.authorName) + "</strong>" +
      '<span class="comment-on">on ' + (dayNo >= 0 ? "day " + (dayNo + 1) : "a day that is gone") + "</span>" +
      '<span class="suggestion-state">' + esc(SUGGESTION_LABELS[sg.state] || sg.state) + "</span>" +
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
   *  day being edited, because a suggestion is one day and picking the wrong one
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
      '<button class="btn btn-sm" type="submit">Suggest this day</button>';
    host.appendChild(bar);
  }

  async function postSuggestion(note) {
    const day = editRoute();
    if (!day) throw new Error("open a day first");
    const body = payload();
    const proposed = body.days.find((d) => d.uid === day.uid);
    if (!proposed) throw new Error("that day has nothing in it to suggest");
    const res = await fetch("/api/rides/" + state.rideId + "/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dayUid: day.uid, day: proposed, note }),
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
      // 409 is the stale case and is the one worth naming: the day moved under
      // the proposal, so there is nothing safe to apply.
      throw new Error(res.status === 409 ? "that day has changed since—the suggestion needs redoing" : "that did not work");
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
      (data.riders.length === 1 ? " rider is" : " riders are") +
      " coming.</p>" +
      fuelHtml(data.range) +
      '<ul class="riders-list">' +
      data.riders.map((r) => riderRowHtml(r, data.groups)).join("") +
      "</ul>" +
      (unsaved.length
        ? '<p class="riders-note">' +
          esc(unsaved.map((g) => g.name).join(", ")) +
          (unsaved.length === 1 ? " is" : " are") +
          " not saved yet, so nobody can be put on " +
          (unsaved.length === 1 ? "it" : "them") +
          " until the ride saves.</p>"
        : "") +
      '<div class="tab-actions">' +
      (state.slug
        ? '<a class="btn btn-sm btn-quiet" href="/m/' +
          encodeURIComponent(state.slug) +
          '/riders">Invite, RSVP and the vote</a>'
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
      return '<p class="riders-fuel is-quiet">No ranges on file, so there is nothing to plan fuel stops around.</p>';
    }
    return (
      '<p class="riders-fuel">Plan fuel around <strong>' +
      range.miles +
      " miles</strong>—" +
      esc(range.riderName || "") +
      "'s " +
      esc(range.bikeLabel || "") +
      "." +
      (range.unknown > 0
        ? '<span class="riders-fuel-gap"> ' +
          range.unknown +
          (range.unknown === 1 ? " rider has" : " riders have") +
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
        ? '<button type="button" class="rider-del" title="Take ' +
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

    host.addEventListener("click", async (e) => {
      if (!e.target.classList.contains("rider-del")) return;
      const row = e.target.closest(".rider-row");
      if (!row) return;
      const name = row.querySelector(".rider-name").textContent;
      // A confirm rather than an undo, because this one is not in the builder's
      // history at all: it is a write to the roster that lands immediately, and
      // beginEdit() covers the ride payload only.
      if (!window.confirm("Take " + name + " off this ride?")) return;
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
  // A named set of riders sharing an approach. A DAY belongs to one, or to
  // nobody — which means everyone rides it, the trunk. See src/subgroups/
  // policy.ts; the model is one dense sequence of days where a subgroup owns a
  // subsequence, so nothing here reorders or renumbers anything.
  //
  // RENDERS NOTHING UNTIL A RIDER ADDS ONE. A solo ride is the overwhelming
  // majority and should not pay a line of panel for a feature about groups —
  // which is also why every subgroup control below is built from
  // state.meta.subgroups.length rather than being hidden with CSS.

  function subgroupByUid(u) {
    return state.meta.subgroups.find((g) => g.uid === u) || null;
  }

  // The picker that sits in a day header. Empty string when the ride has no
  // subgroups, so daySectionHtml concatenates nothing.
  function daySubgroupHtml(day, r) {
    if (state.meta.subgroups.length === 0) return "";
    return (
      '<select class="day-subgroup" data-day="' + r + '" title="Which group rides this day"' +
      ' aria-label="Group for day ' + dayNumber(r) + '">' +
      // "Everyone" is the null option and it is FIRST, because it is what every
      // day is until somebody says otherwise and what most days stay.
      '<option value=""' + (day.subgroupUid ? "" : " selected") + ">Everyone</option>" +
      state.meta.subgroups
        .map(
          (g) =>
            '<option value="' + esc(g.uid) + '"' + (day.subgroupUid === g.uid ? " selected" : "") + ">" +
            esc(g.name) + "</option>",
        )
        .join("") +
      "</select>"
    );
  }

  function renderSubgroups() {
    const host = $("sg-body");
    if (!host) return;
    const groups = state.meta.subgroups;
    const count = $("sg-count");
    if (count) count.textContent = groups.length ? String(groups.length) : "";

    if (groups.length === 0) {
      host.innerHTML =
        '<p class="sg-empty">Riders leaving from different places. Add a group for each starting point, then say ' +
        "which days that group rides—the days you leave on Everyone are the ones you all ride together.</p>";
      return;
    }

    host.innerHTML =
      groups
        .map(
          (g) =>
            '<div class="sg-row" data-sg="' + esc(g.uid) + '">' +
            '<input class="sg-color" type="color" value="' + esc(g.color) + '" aria-label="Color for ' + esc(g.name) + '">' +
            '<input class="sg-name" type="text" maxlength="80" value="' + esc(g.name) + '" aria-label="Name of this group">' +
            '<button type="button" class="sg-meet" title="Suggest where this group could join the others">Find a meet</button>' +
            '<button type="button" class="sg-del" title="Remove this group" aria-label="Remove ' + esc(g.name) + '">×</button>' +
            '</div>',
        )
        .join("") +
      // The two axes, and they only appear once there are two groups to solve
      // against each other. Whose clock and which event — see rides.time_anchor
      // for why one control cannot carry both.
      (groups.length < 2
        ? ""
        : '<div class="sg-anchor">' +
          '<label for="sg-primary">Solve everyone around</label>' +
          '<select id="sg-primary">' +
          state.meta.subgroups
            .map(
              (g) =>
                '<option value="' + esc(g.uid) + '"' +
                (state.meta.primarySubgroup === g.uid ? " selected" : "") + ">" + esc(g.name) + "</option>",
            )
            .join("") +
          "</select>" +
          '<label for="sg-when">and pin their</label>' +
          '<select id="sg-when">' +
          ANCHORS.map(
            (a) =>
              '<option value="' + a.key + '"' + (state.meta.timeAnchor === a.key ? " selected" : "") + ">" +
              a.label + "</option>",
          ).join("") +
          "</select>" +
          '<p class="sg-anchor-note" id="sg-anchor-note"></p>' +
          "</div>") +
      '<div class="sg-meet-out" id="sg-meet-out"></div>';
    renderAnchorNote();
  }

  function wireSubgroups() {
    const add = $("sg-add");
    if (!add) return;

    add.addEventListener("click", () => {
      beginEdit("add a group");
      // Walks the day palette so two groups are never the same color. It is the
      // group's own color rather than a day's because a group spans several
      // days and its line has to read as one thing across all of them.
      const color = DAY_COLORS[state.meta.subgroups.length % DAY_COLORS.length];
      const g = { uid: uid(), name: "Group " + (state.meta.subgroups.length + 1), color: color };
      state.meta.subgroups.push(g);
      // The first group is the default primary only because there is nothing
      // else to be. The moment there are two, renderAnchorNote says whether
      // that is the fair answer — see #67 on why the app must not pick.
      if (!state.meta.primarySubgroup) state.meta.primarySubgroup = g.uid;
      // The panel used to be one column with a collapsed <details> for groups,
      // and this opened it. The Groups tab is already open — pressing Add a
      // group is only reachable from inside it — so there is nothing to reveal;
      // what does need saying is that the new group cannot be assigned to
      // anybody until the ride saves, which the Riders tab says itself.
      ridersStale();
      renderDays();
      markDirty();
    });

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
        // NOT renderDays() — that would rebuild the field being typed in and
        // lose the caret on every keystroke. The day pickers go stale for the
        // length of the edit, which nobody can see, and the next render fixes
        // them.
        markDirty();
      } else if (e.target.classList.contains("sg-color")) {
        beginEdit("recolor a group");
        g.color = e.target.value;
        markDirty();
      }
    });

    body.addEventListener("change", (e) => {
      if (e.target.id === "sg-primary") {
        beginEdit("change the primary group");
        state.meta.primarySubgroup = e.target.value;
        renderAnchorNote();
        markDirty();
      } else if (e.target.id === "sg-when") {
        beginEdit("change what is pinned");
        state.meta.timeAnchor = e.target.value;
        markDirty();
      }
    });

    body.addEventListener("click", (e) => {
      if (e.target.classList.contains("sg-take")) return takeMeet(e.target.dataset);
      const row = e.target.closest(".sg-row");
      if (!row) return;
      const g = subgroupByUid(row.dataset.sg);
      if (!g) return;
      if (e.target.classList.contains("sg-del")) return removeSubgroup(g);
      if (e.target.classList.contains("sg-meet")) return findMeet(g);
    });
  }

  // DELETING A GROUP UN-TAGS ITS DAYS RATHER THAN DESTROYING THEM — the same
  // thing `set null` does server-side, done here so undo and the map agree with
  // what the save will do. A rider tidying up a group name must not lose the
  // road they planned.
  function removeSubgroup(g) {
    beginEdit("remove a group");
    state.meta.subgroups = state.meta.subgroups.filter((x) => x.uid !== g.uid);
    state.days.forEach((d) => {
      if (d.subgroupUid === g.uid) d.subgroupUid = null;
    });
    if (state.meta.primarySubgroup === g.uid) state.meta.primarySubgroup = state.meta.subgroups[0]?.uid || null;
    if (state.meta.trunkSubgroup === g.uid) state.meta.trunkSubgroup = null;
    renderDays();
    rebuildLayers();
    markDirty();
  }

  // Asks the server for somewhere this group could join the others. The whole
  // computation is pure geometry and calls no router — see
  // src/subgroups/rendezvous.ts — so this is cheap enough to press repeatedly.
  //
  // IT NEEDS A SAVED RIDE, because the proposal is made against the STORED
  // trunk. Proposing against unsaved edits would mean shipping the whole ride
  // up to ask, and the answer would be about a route that does not exist yet.
  async function findMeet(g) {
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
        body: JSON.stringify({ group: g.uid }),
      });
      const data = await res.json();
      // A REFUSAL IS NOT A FAILURE AND MUST NOT READ AS ONE. The catch below
      // used to swallow this, which cost a browser pass: the server answered
      // 400 "unknown group" — the ride had been saved without it — and the
      // panel said "could not work one out just now", which is what it also
      // says when the network is down.
      if (!res.ok) {
        out.innerHTML =
          '<p class="sg-note">' +
          (data && data.error === "unknown group"
            ? "This group is not saved yet. Give it a moment and try again."
            : "Could not work one out just now.") +
          "</p>";
        return;
      }
      out.innerHTML = meetResultHtml(g, data);
    } catch (err) {
      out.innerHTML = '<p class="sg-note">Could not work one out just now.</p>';
    }
  }

  const MEET_REASONS = {
    "no-trunk": "There are no shared days yet. Leave at least one day on Everyone and try again.",
    "no-days": "Give this group a day of its own first, starting where they start.",
    // A REAL ANSWER, not a failure. Two groups on opposite sides of a route
    // running away from both of them have nowhere sensible to meet, and
    // offering the least bad option would be worse than saying so.
    "none-viable": "Nowhere on the shared route works without sending them a long way round or backwards.",
  };

  function meetResultHtml(g, data) {
    if (!data.candidates.length) {
      return '<p class="sg-note">' + (MEET_REASONS[data.reason] || MEET_REASONS["none-viable"]) + "</p>";
    }
    return (
      '<p class="sg-note">Where ' + esc(g.name) + " could join:</p>" +
      '<ul class="sg-meets">' +
      data.candidates
        .map(
          (c) =>
            "<li>" +
            '<button type="button" class="sg-take" data-lat="' + c.lat + '" data-lng="' + c.lng + '"' +
            ' data-sg="' + esc(g.uid) + '">Use this</button>' +
            '<span class="sg-meet-fact">' +
            (c.isFuel ? "a fuel stop · " : "") +
            "+" + c.divertMi + " mi out of their way · " +
            c.sharedPct + "% of the shared route still ahead" +
            "</span>" +
            "</li>",
        )
        .join("") +
      "</ul>"
    );
  }

  // ACCEPTING A PROPOSAL IS TWO EDITS, NOT ONE, and that is the whole structure
  // of a meet: the joining group's last day ENDS there and the first shared day
  // BEGINS there. One place, two points, which is what gives each group a route
  // that actually reaches it and what makes junctions() see a boundary.
  //
  // GOES THROUGH addPoint LIKE EVERY OTHER POINT. It appends, splices the leg,
  // asks the router for it, re-renders and marks dirty — a meeting point is not
  // special once it exists, and a second path that placed one would be a second
  // path to keep in step with routing, undo and the map.
  //
  // The prebuilt carries `meet`, which is an existing waypoint role and is where
  // #67's "meet/split become structural" lands. It is still only a LABEL:
  // junctions() derives the boundary from the day list and reads no role. A
  // point arriving with roles becomes a stop, which is right — a meeting point
  // is somewhere you unambiguously stop, and it wants a dwell.
  function takeMeet(d) {
    const g = subgroupByUid(d.sg);
    if (!g) return;
    const lat = Number(d.lat);
    const lng = Number(d.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    // Indices, not the day objects: addPoint takes an index and everything
    // downstream of it is expressed in one.
    let lastOwn = -1;
    let firstShared = -1;
    state.days.forEach((day, i) => {
      if (day.subgroupUid === g.uid) lastOwn = i;
      if (firstShared < 0 && day.subgroupUid == null) firstShared = i;
    });
    if (lastOwn < 0 || firstShared < 0) return;

    const name = g.name + " meets here";
    const mk = () => {
      const pt = newPoint(lng, lat, name);
      pt.roles = ["meet"];
      return pt;
    };
    // The shared day FIRST, because adding to it does not move any index, and
    // then the group's own — the reverse order would still work here since the
    // two days are distinct, but doing index-shifting edits back to front is
    // the habit that keeps the multi-day paths in this file correct.
    addPoint(lng, lat, name, firstShared, mk(), 0);
    addPoint(lng, lat, name, lastOwn, mk());
    $("sg-meet-out").innerHTML = '<p class="sg-note">Added to ' + esc(g.name) + "'s last day and to the first shared day.</p>";
  }

  const ANCHORS = [
    { key: "departure", label: "departure" },
    { key: "meet", label: "arrival at the meet" },
    { key: "arrival", label: "arrival at the end" },
  ];

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
      el.textContent = longest ? "" : "Give each group at least one day to see the effect.";
      return;
    }
    el.textContent =
      esc(longest.name) + " has the farthest to ride. Solving around a group that is closer asks them to leave earlier.";
  }

  // Longest by planned riding time across the days that group rides on its own
  // — the shared days are the same for everybody and cancel out.
  function longestApproach() {
    let best = null;
    let bestS = -1;
    for (const g of state.meta.subgroups) {
      const s = state.days
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
  // back to its default. Keyed by day index, which is the best available: a day
  // has no id until it is saved, and a reorder is meant to carry the open state
  // with the position rather than with the day.
  function openSections() {
    const open = new Set();
    document.querySelectorAll(".day-section").forEach((el) => {
      if (!el.classList.contains("is-shut")) open.add(Number(el.dataset.day));
    });
    // First render: nothing is on the page yet and every day starts open.
    if (!document.querySelector(".day-section")) return null;
    return open;
  }

  function daySectionHtml(day, r, open) {
    const shut = open && !open.has(r);
    const single = state.days.length < 2;
    // ALTERNATES. `is-alt` is a losing one and `is-alt-active` the member that
    // counts; both carry `in-alt-group` so the stylesheet can bracket the pair
    // without caring which is which. A day with no group gets none of them, so
    // a ride without alternates renders exactly as it did before.
    const grouped = day.altGroup != null;
    const ghost = grouped && !day.altActive;
    const altClass = !grouped ? "" : ghost ? " in-alt-group is-alt" : " in-alt-group is-alt-active";
    // The badge says which of the two a section is, in the same words the
    // viewer's legend uses. Same reasoning as there: badging only the loser
    // leaves "an alternative to what?" unanswered.
    const altBadge = !grouped
      ? ""
      : '<span class="day-alt' + (ghost ? "" : " is-on") + '" title="' +
        (ghost
          ? "Not counted in the ride total. Use the day menu to ride this one instead."
          : "This is the route counted in the ride total.") +
        '">' + (ghost ? "alternative" : "riding this") + "</span>";
    return (
      '<section class="day-section' + (shut ? " is-shut" : "") + altClass + '" data-day="' + r + '"' +
      ' style="--day-color:' + esc(day.color) + '">' +
      '<div class="day-head">' +
      // AFTER the grip, never before it: .day-drag's negative margins depend on
      // being the first thing in the header, and anything ahead of it breaks the
      // tab that reaches the section's padding edge.
      (state.select?.scope === "day"
        ? '<input type="checkbox" class="day-pick" data-day="' + r + '"' +
          (state.select.days.has(r) ? " checked" : "") +
          ' aria-label="Select ' + esc(dayLabel(r)) + '">'
        : "") +
      // The day's own drag handle. A separate grip rather than dragging by the
      // header itself: the header holds a color input, a text field and buttons,
      // and making all of that a drag surface would mean every attempt to type in
      // the name started a drag.
      //
      // A BUTTON, not a span, and that is what replaced the ↑ ↓ pair that used to
      // sit in .day-actions. A drag handle cannot be operated from a keyboard and
      // does not exist at all if the SortableJS CDN fails — the same two reasons
      // AGENTS.md gives for keeping Move up / Move down on the stop rows. Making
      // the grip focusable and giving it arrow keys covers both without spending
      // two more buttons of a 380px header.
      '<button type="button" class="day-drag" title="Drag to reorder, or focus and use the arrow keys"' +
      ' aria-label="Reorder day ' + dayNumber(r) + ', use the up and down arrow keys"></button>' +
      '<button type="button" class="day-twirl" aria-expanded="' + (shut ? "false" : "true") +
      '" title="Show or hide this day\'s stops"><span class="day-twirl-mark" aria-hidden="true"></span></button>' +
      // The ordinal, rendered rather than stored. Reordering re-renders, so it is
      // always the day's real position and there is nothing to keep in sync.
      '<span class="day-num" aria-hidden="true">' + dayNumber(r) + "</span>" +
      '<input class="day-color" type="color" value="' + esc(day.color) + '" title="Day color" aria-label="Color for ' + esc(dayLabel(r)) + '">' +
      // The placeholder no longer says "Day N". It used to, which made an empty
      // field look like it already held the name — so the number and the name
      // were indistinguishable until you clicked in.
      '<input class="day-title" type="text" maxlength="150" placeholder="Name this day (optional)"' +
      ' autocomplete="off" aria-label="Name for day ' + dayNumber(r) + '" value="' + esc(day.title) + '">' +
      altBadge +
      daySubgroupHtml(day, r) +
      '<span class="day-actions">' +
      // Empty for the same reason .day-del is: icon-reverse.svg comes in through
      // a CSS mask on ::before, so it takes the button's color and its disabled
      // opacity. It was a bare ⇄ (U+21C4), which a screen reader announces as
      // "rightwards arrow over leftwards arrow" — hence the aria-label.
      '<button type="button" class="day-rev" title="Reverse this day—re-routes every leg" aria-label="Reverse ' +
      esc(dayLabel(r)) + '"></button>' +
      // DELETE MOVED INTO THE MENU, and ⇄ did not. The two were side by side and
      // one of them re-routes every leg while the other throws a day away — both
      // one mis-click from the title field. Reverse is the one a rider reaches
      // for mid-edit, so it stays a button; delete is not, so it went behind the
      // ⋮ with the rest. Same move the point rows made when four buttons became
      // one, and it gives the width back to .day-title.
      //
      // U+22EE, the same glyph the row menu uses, so the two read as the same
      // control at two levels.
      '<button type="button" class="day-menu-btn" title="More" aria-label="More actions for ' +
      esc(dayLabel(r)) + '" aria-haspopup="menu" aria-expanded="false">⋮</button>' +
      "</span>" +
      "</div>" +
      '<div class="day-body">' +
      '<div class="day-times">' +
      '<label class="day-time"><span>Starts</span>' +
      '<input class="day-start" type="datetime-local"></label>' +
      '<label class="day-time"><span>Ends</span>' +
      '<input class="day-end" type="datetime-local"' +
      ' title="Worked out from the start time and the day\'s riding and stops. Type your own to override, or clear it to go back to automatic."></label>' +
      '<span class="day-times-note"></span>' +
      "</div>" +
      // data-duration-format rides on each list, not only on #day-list: the rule
      // in _builder.scss that widens .row-dur for the "1h 30m" format keys off
      // the list itself, so putting it only on the ancestor silently stopped it
      // matching and clipped the field.
      '<ol class="point-list" data-day="' + r + '" data-duration-format="' + esc(durFormat) + '"></ol>' +
      "</div>" +
      "</section>"
    );
  }

  const daySection = (r) => document.querySelector('.day-section[data-day="' + r + '"]');

  // The active day's own section carries the class; nothing else does. Separate
  // from renderDays() because it runs on every click into a row and must not
  // rebuild anything.
  function markActiveSection() {
    const a = activeIndex();
    document.querySelectorAll(".day-section").forEach((el) => {
      el.classList.toggle("is-active", Number(el.dataset.day) === a);
    });
  }

  // The rail's jump list: one dot per day, no "All" — there is no all-days view
  // to return to now that every day is on screen. Clicking one scrolls that
  // day's section into view and makes it active.
  //
  // Buttons rather than a slider. A 44px-wide slider is not a usable slider, and
  // these are also what a screen reader gets once the rail is the only thing on
  // screen — initPanelToggle flips the container's aria-hidden so the rail and
  // the sections are never both announced.
  function renderRailDays() {
    const wrap = $("rail-days");
    if (!wrap) return;
    const a = activeIndex();
    wrap.innerHTML = state.days
      .map(
        (day, r) =>
          '<button type="button" class="rail-day" data-day="' + r + '"' +
          (r === a ? ' aria-current="true"' : "") +
          ' style="--rail-color:' + esc(day.color) + '"' +
          ' title="' + esc(dayLabel(r)) + '">' + String(r + 1) + "</button>",
      )
      .join("");
  }

  // --- Times ----------------------------------------------------------------

  // A DAY'S CLOCK IS A WALL CLOCK AT THE DEPARTURE POINT and nothing converts
  // it into the browser's zone — see the header of public/js/day-clock.js for
  // the rule and for how the value is carried. These three are that file, kept
  // here as thin names because the call sites read better for it.
  const isoToLocalInput = (iso) => window.TBDayClock.isoToInput(iso);
  const localInputToIso = (value) => window.TBDayClock.inputToIso(value);

  // The hour a fresh day is assumed to start. Only ever a seed — the rider
  // edits it, and nothing derives from it beyond the first suggestion.
  const DAY_START_HOUR = 8;

  // Where a new day's start comes from: the first DAY_START_HOUR o'clock
  // strictly after the previous day ends. For a day finishing in the evening
  // that is simply the next morning.
  const nextMorningAfter = (iso) => window.TBDayClock.nextMorningAfter(iso, DAY_START_HOUR);

  const derivedEndIso = (day) =>
    day.startAt ? new Date(new Date(day.startAt).getTime() + dayElapsedS(day) * 1000).toISOString() : null;

  // Whether the rider typed this end themselves, held on the day as session
  // state (it is not part of the save payload). Inferred once at load by
  // comparing the stored end against what the day derives, then tracked
  // directly. It has to be a flag rather than that same comparison run on every
  // refresh: the moment a leg or stop changes, an end that *was* automatic no
  // longer matches the new derivation, and comparing would freeze it as though
  // the rider had typed it. Minute tolerance because the input's own resolution
  // is a minute.
  function inferEndManual(day) {
    if (!day.startAt || !day.endAt) return false;
    const derived = derivedEndIso(day);
    if (!derived) return false;
    return Math.abs(new Date(day.endAt).getTime() - new Date(derived).getTime()) > 60000;
  }

  // Called wherever a day's shape changes. An end the rider typed is left
  // alone; anything else is kept in step with the legs and stops.
  function syncEnd(day) {
    // With no start there is nothing to derive from. An end already on the
    // day is left as it is rather than discarded — the columns are
    // independently nullable, and silently dropping a stored time on load
    // would lose it on the next save.
    if (!day.startAt || day.endManual) return;
    day.endAt = derivedEndIso(day);
  }

  // Every figure the panel shows is derived from the legs and stops, so one
  // call keeps them all honest. Ends sync across every day, not just the edited
  // one — a marker on a dimmed day is still draggable, so any day's shape can
  // change while another is in focus.
  function refreshDerived() {
    state.days.forEach(syncEnd);
    renderTotals();
    renderTimes();
    renderTimeline();
    // Last, and not optional: the leg highlight is derived from the moment and
    // the legs, and the engine drops it on every track repath. Anything that
    // changes a day has to put it back, which is exactly this pass.
    applyFocus();
  }

  // --- Timeline -------------------------------------------------------------

  // The live POI distances this used to compute are gone. A POI carried no stored
  // distFromStartMi — it does not exist until save — so the time model projected
  // each one onto the day's track to place it, and the builder had to pass those
  // distances in or the timeline put every POI at the start of its day. Points sit
  // on leg boundaries now, so the schedule reads the order straight off the array
  // and needs nothing passed to it.
  const activeNow = () => (state.moment == null ? null : activeAtMoment(state.days, state.moment));

  function renderTimeline() {
    const wrap = $("ride-timeline");
    const slider = $("time-slider");
    const readout = $("time-readout");
    const span = rideSpan(state.days);

    // The slider's value is epoch seconds, which is what a screen reader would
    // otherwise read out. aria-valuetext replaces that with the same sentence
    // sighted users get.
    const say = (text) => {
      readout.textContent = text;
      slider.setAttribute("aria-valuetext", text);
    };

    // IT HIDES NOW RATHER THAN GOING INERT, which is the opposite of what it did
    // in the panel and is right for the same reason it was wrong there. Inside the
    // panel, vanishing would have reflowed every control under it the moment a
    // date was typed — the jump this whole redesign exists to remove. Out on the
    // map's bottom edge there is nothing under it to reflow, and a dead slider
    // lying across someone's route is worse than no slider.
    //
    // What is lost is the hint the disabled state carried. It is not gone, it
    // moved: renderTimes() puts it on #day-times-note, directly beneath the Starts
    // field that fixes it, which is where it should have been all along. This is
    // the only branch that can leave the bar hidden, so the two have to stay in
    // step.
    wrap.hidden = !span;
    slider.disabled = !span;
    if (!span) {
      slider.min = "0";
      slider.max = "0";
      slider.value = "0";
      say("");
      return;
    }

    slider.min = String(span.from);
    slider.max = String(span.to);
    slider.value = String(state.moment == null ? span.from : Math.min(Math.max(state.moment, span.from), span.to));

    if (state.moment == null) {
      say(fmtMoment(span.from) + " – " + fmtMoment(span.to));
      return;
    }
    const a = activeAtMoment(state.days, state.moment);
    let what;
    if (a.dayIndex == null) {
      what = "between days";
    } else if (a.legIndex != null) {
      what = dayLabel(a.dayIndex) + " · leg " + (a.legIndex + 1) + " of " + state.days[a.dayIndex].legs.length;
    } else {
      // ONE INDEX, into the day's own points array — no filtering, so no chance
      // of reading the wrong element. A point with no name falls back to its
      // position in the day rather than a stop number, because the number a row
      // shows counts stops only and a POI has none.
      const pt = a.pointIndex == null ? null : state.days[a.dayIndex].points[a.pointIndex];
      const fallback = pt && pt.kind === "poi" ? "a point of interest" : "point " + ((a.pointIndex || 0) + 1);
      what = dayLabel(a.dayIndex) + " · at " + ((pt && pt.name) || fallback);
    }
    say(fmtMoment(state.moment) + " · " + what);
  }

  // Moving the timeline is the primary gesture; the day slider follows it so
  // the two controls can never show different days.
  function setMoment(momentS) {
    state.moment = momentS;
    const a = activeAtMoment(state.days, momentS);
    // A moment between days leaves the active day where it was — there is no day
    // to move it to, and snapping it somewhere arbitrary would be a lie.
    if (a.dayIndex != null) setActive(a.dayIndex);
    applyFocus();
    refreshDerived();
  }

  // Every day's times, because every day's fields are on screen. It was one set
  // of ids reading whichever day the slider had selected.
  function renderTimes() {
    state.days.forEach((_, r) => renderDayTimes(r));
  }

  function renderDayTimes(r) {
    const day = state.days[r];
    const sec = daySection(r);
    if (!day || !sec) return;
    const start = sec.querySelector(".day-start");
    const end = sec.querySelector(".day-end");
    const note = sec.querySelector(".day-times-note");
    if (!start || !end || !note) return;
    // Never fight the rider for a field they are in. refreshDerived() runs on
    // every keystroke elsewhere in the panel, and rewriting a datetime input
    // mid-edit resets the caret to the month segment.
    if (document.activeElement === start || document.activeElement === end) return;

    start.value = isoToLocalInput(day.startAt);
    end.value = isoToLocalInput(day.endAt);
    // Without a start there is nothing to derive an end from, and a lone end
    // would be a time the timeline cannot place.
    end.disabled = !day.startAt;

    if (!day.startAt) {
      // The second half of this used to live in the timeline's readout, back when
      // the timeline sat in the panel and stayed visible-but-disabled without
      // dates. The bar hides itself now, so the hint has to be somewhere a rider
      // will see it — and beside the field that fixes it is a better place than
      // under a slider that has gone grey.
      note.textContent = day.endAt ? "add a start time to work the end out" : "add a start time to scrub the ride";
      return;
    }
    if (day.endManual) {
      note.textContent = "end set by hand";
    } else {
      note.textContent = routeTotals(day).estimated ? "end estimated from the day" : "end from the day";
    }
  }

  // --- Panel: list + totals -------------------------------------------------

  // ONE ICON'S FOOTPRINT, WHATEVER THE ROLE COUNT. This used to join one 16px
  // chip per role, so the control was roughly 18n + 10 wide — 28px at one role
  // and about 316px of a 320px row at all seventeen, with the name field paying
  // for it. It is the sharpest case of the panel rule that nothing changes size
  // as its value changes.
  //
  // The shape chosen (2026-08-15) is the first role's icon at full size plus a
  // count. Roles are capped at 4 by wireList, so the badge never exceeds "+3",
  // and the full set is one click away in the picker below — this control is an
  // indicator, not the list. Stacking and a quarter-scale 2x2 grid were the other
  // two candidates; both lose legibility at 16px, which is the size that matters.
  //
  // Every role's name still reaches the rider: they are joined into the button's
  // title attribute by pointRowHtml, so nothing is hidden, only summarized.
  function roleIconsHtml(point) {
    const roles = (point.roles || []).filter((r) => window.TB.roles[r]);
    if (!roles.length) return "";
    const meta = window.TB.roles[roles[0]];
    const extra = roles.length - 1;
    return (
      '<span class="role-chip tb-inline-icon" data-icon="' + esc(meta.icon) + '"></span>' +
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

  // Mirrors faqLink() in src/views/layout.ts, for the panel markup this file
  // builds itself rather than receiving from the server.
  //
  // Used once, on the twistiness label. It was briefly on the role picker too
  // and came straight back out: .row-roles is rendered for every point row, so
  // one link there is one link per stop — seven on a short ride, two hundred on
  // a long one, all identical, to explain a picker that already labels all
  // seventeen options in words. The dot-kinds link at the top of the panel
  // covers the question that actually needs answering.
  const faqLink = (anchor, what) =>
    '<a class="faq-link" href="/faq#' + anchor + '" target="_blank" rel="noopener"' +
    ' title="What is ' + esc(what) + '?" aria-label="What is ' + esc(what) + '? Opens the questions page in a new tab">?</a>';

  const rolesAreOpen = (r, i) => !!state.rolesOpen && state.rolesOpen.day === r && state.rolesOpen.i === i;

  function rolePickerHtml(point) {
    return Object.keys(window.TB.roles)
      .map((r) => {
        const meta = window.TB.roles[r];
        const on = (point.roles || []).includes(r);
        return (
          '<button type="button" class="role-opt' + (on ? " on" : "") + '" data-role="' + r + '" aria-pressed="' + on + '">' +
          '<span class="tb-inline-icon" data-icon="' + esc(meta.icon) + '"></span><span>' + esc(meta.title) + '</span></button>'
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

  // SIX BUTTONS BECAME TWO. The row carried up, down, notes and delete beside the
  // role button; it now carries a drag handle and one menu. `.row-actions` was
  // 80px of a 320px row and most of that goes back to the name field, which was
  // 113px on a stop against a POI's 152px — that 39px difference WAS the arrow
  // pair, and it is gone.
  //
  // BOTH KINDS DRAG, and they mean different things by it. A stop carries a
  // stored order, so dragging it reorders the day. A POI does not — its place in
  // this list is its projected distance along the track — so dragging it moves
  // its pin onto the road between the rows it was dropped between. Same
  // affordance, because from the rider's side it is the same intent: put this
  // one there. See the onEnd handler in initDragToReorder for the split.
  // data-day is what makes every handler below day-agnostic: pointOf() reads the
  // point out of that day, and any interaction with the row makes that day active
  // so the shared edit functions land in the right place.
  // `n` is the row's stop number, or null for a POI — worked out by orderedRows()
  // because it counts stops only and `i` indexes the whole list.
  function pointRowHtml(kind, point, i, dayIndex, n) {
    const isStop = kind === "stop";
    return (
      '<li class="point-row" data-kind="' + kind + '" data-i="' + i + '" data-day="' + dayIndex + '">' +
      '<div class="row-main">' +
      // Both kinds reorder now — a POI has a place in the list of its own, so
      // there is one gesture with one meaning rather than a drag that reordered
      // a stop and repositioned a POI's pin.
      '<span class="row-drag" title="Drag to reorder" aria-hidden="true"></span>' +
      // THE CHECKBOX REPLACES THE NUMBER rather than joining it. A 380px row has
      // no spare width and .row-name is already the thing that shrinks; the stop
      // number is the one element that is redundant while you are ticking boxes,
      // because ticking is what you are doing rather than reading an order. It
      // comes straight back when select mode ends.
      (state.select?.scope === "point"
        ? '<input type="checkbox" class="row-pick" data-day="' + dayIndex + '" data-kind="' + kind + '" data-i="' + i + '"' +
          (state.select.points.has(pointKey(dayIndex, kind, i)) ? " checked" : "") +
          ' aria-label="Select ' + (isStop ? "stop " + n : "POI") + '">'
        : isStop
          ? '<span class="row-num">' + n + "</span>"
          : '<span class="row-num poi-dot"></span>') +
      '<input class="row-name" name="' + kind + '-name-' + i + '" type="text" maxlength="255" autocomplete="off" placeholder="' + (isStop ? "Stop name" : "POI name") + '" value="' + esc(point.name) + '">' +
      // POIs get the same dwell field. Blank means "rode past without stopping",
      // which is the common case and why it stays a placeholder rather than a
      // zero.
      //
      // TYPE="TEXT", not "number", and that is the price of the format being a
      // preference. "1h 30m" is not a number, and switching the input's type per
      // format would be three code paths through every read and write of this
      // field. One text input with `inputmode` set from the format gets the
      // phone keyboard right without any of that. The stored value is still an
      // integer count of minutes — TBDuration is only how it is written down.
      '<input class="row-dur" name="' + kind + '-duration-' + i + '" type="text" autocomplete="off" inputmode="' +
      DUR.inputMode(durFormat) + '" placeholder="' + esc(DUR.placeholder(durFormat)) + '" title="' +
      (isStop ? "Stop duration" : "How long you stop here, if you stop") + " (" + esc(DUR.unitName(durFormat)) +
      ')" value="' + esc(DUR.format(point.durationMin, durFormat)) + '">' +
      '<button type="button" class="row-roles-btn" title="' + esc(roleTitle(point)) + '" aria-label="Categories">' +
      // Empty rather than a "+" glyph: the dot IS the affordance and it is drawn
      // in CSS, so there is nothing to read here. aria-hidden because the button
      // already carries its own label.
      (roleIconsHtml(point) || '<span class="role-add" aria-hidden="true"></span>') + "</button>" +
      '<span class="row-actions">' +
      // U+22EE, the VERTICAL ellipsis, not U+22EF. It is the same control and
      // roughly a third of the width, which on a 320px row is width the name
      // field gets instead.
      // Shown only when something is filled in, so a rider can see at a glance
      // which stops carry a reservation without opening every row. Not a button:
      // the row menu is how the panel opens, and a second affordance for the same
      // thing on a 320px row costs width the name field needs.
      (hasDetails(point.details)
        ? '<span class="row-detail-flag" title="Has reservation details" aria-label="Has reservation details">\u2731</span>'
        : "") +
      '<button type="button" class="row-menu-btn" title="More" aria-label="More actions for this ' +
      (isStop ? "stop" : "POI") + '" aria-haspopup="menu" aria-expanded="false">⋮</button>' +
      "</span></div>" +
      '<div class="row-roles"' + (rolesAreOpen(dayIndex, i) ? "" : " hidden") + ">" + rolePickerHtml(point) + "</div>" +
      '<textarea class="row-desc" name="' + kind + '-notes-' + i + '" maxlength="2000" placeholder="Notes (optional)"' +
      (point.description ? "" : " hidden") + ">" + esc(point.description) + "</textarea>" +
      '<div class="row-details" hidden>' + detailsHtml(point, kind, i) + "</div>" +
      "</li>"
    );
  }

  // The private half of a stop: reservations, codes, check-in, links, notes.
  //
  // Fields are chosen by role — see detailFieldsFor — so a gas stop does not
  // present a check-out time. The whole block is `hidden` until the rider opens
  // it from the row menu, because a stop's details are the exception rather than
  // the rule and a panel of empty inputs under every row would bury the ride.
  //
  // Every input carries `data-field`, and one delegated handler writes whichever
  // one changed. Naming them individually would mean a handler per field and a
  // new one every time the set grows.
  const DETAIL_LABELS = {
    confirmation: "Confirmation number",
    checkInAt: "Check in",
    checkOutAt: "Check out",
    phone: "Phone",
    address: "Address",
  };

  // datetime-local wants "YYYY-MM-DDTHH:MM" and the value is stored as an ISO
  // string with an offset. Slicing rather than constructing a Date and
  // reformatting: the stored value already IS local wall-clock for the place the
  // stop is in, and round-tripping it through a Date would re-interpret it in
  // the browser's zone and shift it.
  // A check-in is a wall clock in a place, exactly like a day's start — see the
  // header of public/js/day-clock.js. This used to slice the first 16 characters
  // off the ISO string while the WRITE path below attached the browser's offset,
  // so a 3pm check-in typed in California was stored as 22:00 and read back into
  // the field as 10pm. Both ends go through the same module now.
  const toLocalInput = (iso) => window.TBDayClock.isoToInput(iso);

  function detailsHtml(point, kind, i) {
    const d = point.details || blankDetails();
    const fields = detailFieldsFor(point.roles);
    let out = '<div class="detail-grid">';
    for (const f of fields) {
      if (f === "notes" || f === "links") continue;
      const isTime = f === "checkInAt" || f === "checkOutAt";
      out +=
        '<label class="detail-field"><span>' + esc(DETAIL_LABELS[f]) + "</span>" +
        '<input type="' + (isTime ? "datetime-local" : f === "phone" ? "tel" : "text") + '"' +
        ' data-field="' + f + '"' +
        ' name="' + kind + "-" + f + "-" + i + '"' +
        (isTime ? "" : ' maxlength="' + (f === "confirmation" ? 120 : f === "phone" ? 40 : 300) + '"') +
        ' autocomplete="off" value="' + esc(isTime ? toLocalInput(d[f]) : d[f] || "") + '"></label>';
    }
    out += "</div>";

    out += '<div class="detail-links">';
    (d.links || []).forEach((l, n) => {
      out +=
        '<div class="detail-link" data-link="' + n + '">' +
        '<input type="text" data-field="linkLabel" maxlength="60" placeholder="Label" value="' + esc(l.label || "") + '">' +
        '<input type="url" data-field="linkUrl" maxlength="500" placeholder="https://" value="' + esc(l.url || "") + '">' +
        '<button type="button" class="detail-link-del" aria-label="Remove link">\u00d7</button>' +
        "</div>";
    });
    out +=
      '<button type="button" class="detail-link-add"' +
      ((d.links || []).length >= MAX_LINKS ? " disabled" : "") +
      ">Add link</button></div>";

    out +=
      '<label class="detail-field detail-notes"><span>Private notes</span>' +
      '<textarea data-field="notes" maxlength="2000" placeholder="Gate code, where to park, who to ask for">' +
      esc(d.notes || "") + "</textarea></label>";

    // Stated on the surface rather than only in the code, because a rider
    // deciding whether to type a door code into a web app is entitled to know
    // where it goes. It is also true — see canSeeDetails in
    // src/maps/point-details.ts.
    out += '<p class="detail-privacy">Only you can see this. It stays out of shared links and every export except your own backup.</p>';
    return out;
  }

  // Reads the row's OWN day, not the active one. Those are the same thing by the
  // time a handler runs — every listener calls setActiveFromEl first — but
  // relying on that ordering would make this quietly wrong the first time
  // something read a row without having clicked it.
  function pointOf(row) {
    const i = Number(row.dataset.i);
    const day = state.days[Number(row.dataset.day)];
    if (!day) return null;
    return day.points[i];
  }

  // Stops and POIs in the order you would meet them, which is the order the day
  // actually happens in.
  //
  // ONE INDEX SPACE: a row's `data-i` indexes day.points, whatever its kind, so
  // pointOf(), movePoint() and deletePoint() all take the same number. Stops keep
  // their numbers and POIs keep the dot, so the distinction is still visible.
  // THE ARRAY IS THE ORDER. This used to interleave two arrays by projecting the
  // POIs onto the day's track and sorting, which was the only thing that could
  // place a point with no stored position — and it had no answer at all before a
  // route existed, so every POI on a fresh day reported distance 0 and they came
  // out in whatever order the array happened to hold.
  //
  // `n` is the stop number a row displays, or null for a POI. It counts stops
  // only, so promoting a point renumbers everything after it and demoting one
  // closes the gap, with no renumbering logic of its own.
  function orderedRows(day) {
    let stopN = 0;
    return day.points.map((point, i) => ({
      kind: point.kind,
      point,
      i,
      n: point.kind === "stop" ? ++stopN : null,
    }));
  }

  // One day's rows. Takes the day index rather than reading the active one,
  // because every day's list is on screen and any of them can need redrawing.
  function renderDayList(r) {
    const list = document.querySelector('.point-list[data-day="' + r + '"]');
    if (!list) return;
    const day = state.days[r];
    if (!day) return;
    const open = state.insertAt && state.insertAt.day === r ? state.insertAt.at : null;
    list.innerHTML =
      orderedRows(day)
        .map(
          (row) =>
            // The gap ABOVE each row, so slot `i` means "before points[i]" and
            // the indices read the same way addPoint's `at` does. The gap below
            // the last row is the bottom add-row, which is always present, so no
            // slot is rendered for it.
            (open === row.i ? addRowHtml(r, day, row.i) : insertSlotHtml(r, row.i)) +
            pointRowHtml(row.kind, row.point, row.i, r, row.n),
        )
        .join("") + addRowHtml(r, day);
    hydrateIcons(list);
  }

  // THE LAST ROW OF EVERY DAY IS A SEARCH FIELD, and it replaced a single
  // "Search for a place…" box that sat above the whole day list.
  //
  // The box had to guess which day you meant, and it guessed the last one you
  // touched. That is invisible until it is wrong: you scroll to day 4, type an
  // address, and it lands on day 2 because day 2 held the last field you
  // clicked in. Putting the field IN the day removes the guess — the row knows
  // its own `data-day` and passes it to addPoint().
  //
  // Rendered on every day whether or not it has points, so it is also the empty
  // state; the `.empty-hint` li it replaced said "click the map or search to
  // add your first stop" while pointing at neither.
  //
  // NOT a .point-row: it has no point behind it, and wireList()'s handlers all
  // resolve a row to `state.days[day].points[i]`. SortableJS is also told to
  // leave it alone — see the filter option in initDragToReorder.
  // A hairline with a + in it, between two rows. Excel's "insert row here",
  // which is what it was asked for by.
  //
  // Rendered for every gap rather than on hover, because a control that only
  // exists while the pointer is over it does not exist on a touch screen at all
  // — and the drawer is a phone sheet on a narrow viewport. It is quiet enough
  // at rest (a 1px rule and a small glyph) that 30 of them read as row
  // separators rather than as 30 buttons.
  function insertSlotHtml(r, at) {
    return (
      '<li class="insert-slot" data-day="' + r + '" data-at="' + at + '">' +
      '<button type="button" class="insert-btn" data-day="' + r + '" data-at="' + at + '"' +
      ' title="Add a point here" aria-label="Add a point above point ' + (at + 1) + '">+</button>' +
      "</li>"
    );
  }

  // `at` is the slot this row inserts into, or undefined for the day's own
  // bottom row, which appends. It rides on the element as data-at so every
  // handler below — search, chips, arm-a-map-click — reads it from one place
  // rather than each keeping its own copy of where the rider was.
  function addRowHtml(r, day, at) {
    const full = day.points.length >= MAX_POINTS;
    const slot = at == null ? "" : ' data-at="' + at + '"';
    return (
      '<li class="add-row' + (at == null ? "" : " is-insert") + '" data-day="' + r + '"' + slot + '>' +
      '<span class="add-row-mark" aria-hidden="true">+</span>' +
      '<input class="add-search" type="text" autocomplete="off" spellcheck="false"' +
      ' placeholder="' + (full ? "Point limit reached" : "Search, or click the map") + '"' +
      (full ? " disabled" : "") +
      ' aria-label="Add a place to ' + esc(dayLabel(r)) + '">' +
      // Arms the next map click for THIS day — see armPlace(). The armed state
      // is derived from state.arm rather than left on the element, because this
      // row is rebuilt on every structural change and a class living only in the
      // DOM would be lost by the next render.
      '<button type="button" class="add-place-btn' + (isArmed(r, at) ? " is-armed" : "") + '"' +
      ' data-day="' + r + '"' + slot + (full ? " disabled" : "") +
      ' aria-pressed="' + (isArmed(r, at) ? "true" : "false") + '"' +
      ' title="' + (full ? "Point limit reached" : "Add a point to " + esc(dayLabel(r)) + " by clicking the map") + '">' +
      "+ Point</button>" +
      chipsHtml(r, full, at) +
      "</li>"
    );
  }

  // The categories worth one tap, and nothing more.
  //
  // Four, not seventeen. These are what a rider is actually hunting for mid-plan
  // — fuel, a meal, a bed, coffee — and a row of seventeen chips would be a
  // worse version of typing the word. Everything else reaches the same search
  // through the box: "campground near lake tahoe" is one query away and costs no
  // screen.
  //
  // Each chip carries the ROLE, so a picked result arrives already tagged. The
  // alternative is finding the station and then opening the row menu to say it
  // is a gas station, which is the sort of thing that makes a tool feel stupid.
  const CHIPS = [
    { role: "gas", label: "Gas", query: "gas station" },
    { role: "food", label: "Food", query: "restaurant" },
    { role: "coffee", label: "Coffee", query: "coffee shop" },
    { role: "hotel", label: "Lodging", query: "hotel" },
  ];

  function chipsHtml(r, full, at) {
    if (full) return "";
    const slot = at == null ? "" : ' data-at="' + at + '"';
    return (
      '<div class="add-chips" role="group" aria-label="Find nearby">' +
      CHIPS.map(
        (c) =>
          '<button type="button" class="chip" data-day="' + r + '" data-chip="' + c.role + '"' + slot +
          ' title="Find ' + esc(c.label.toLowerCase()) + ' near this day\'s last point">' +
          esc(c.label) + "</button>",
      ).join("") +
      "</div>"
    );
  }

  // Kept under its old name for the ~15 callers that mean "redraw what I just
  // changed". They all edit the active day, which is the day they are called
  // from — a row handler sets it before doing anything else.
  function renderList() {
    const r = activeIndex();
    if (r != null) renderDayList(r);
  }

  // The day index is required now: every day's rows are on the page, so
  // [data-kind][data-i] alone matches one row per day and would scroll to
  // whichever came first.
  function focusRow(kind, i, dayIndex) {
    const r = dayIndex == null ? activeIndex() : dayIndex;
    const row = document.querySelector(
      '.point-row[data-day="' + r + '"][data-kind="' + kind + '"][data-i="' + i + '"]',
    );
    if (!row) return;
    // A row inside a shut day cannot be scrolled to, so open it first.
    const sec = row.closest(".day-section");
    if (sec && sec.classList.contains("is-shut")) {
      sec.classList.remove("is-shut");
      const twirl = sec.querySelector(".day-twirl");
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

  function routeTotals(day) {
    return {
      meters: day.legs.reduce((n, l) => n + l.distanceM, 0),
      riding: day.legs.reduce((n, l) => n + legDurationS(l), 0),
      // Still computed although it is no longer displayed: dayElapsedS is
      // riding plus stopped, and every derived end time and the whole timeline
      // slider are built on it.
      stopped: dayStoppedS(day),
      estimated: dayIsEstimated(day),
      // Live rather than the value stored at last save, which would be stale the
      // moment a stop moves. window.TBTwist caches on the legs array, so this is
      // free until the router answers again.
      twist: dayTwistiness(day),
    };
  }

  function renderTotals() {
    const totalsEl = $("totals");
    // ANY POINT, not any stop. A day of POIs draws a road and has a mileage now,
    // so a ride made of them has totals worth printing.
    const anyPoints = state.days.some((r) => r.points.length > 0);
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
      " · " +
      (t.estimated ? "~" : "") +
      hm(t.riding) +
      " riding" +
      (t.twist ? " · " + twistLabel(t.twist.dpm) + (withLink ? faqLink("twistiness", "twistiness") : "") : "");

    // The label alone on the line; the numbers behind it on hover. "252°/mi"
    // means nothing to a rider, but it is the thing to check when the label
    // looks wrong, so it should be reachable without being in the way.
    const twistTitle = (t) => {
      if (!t.twist) return "";
      // CONVERTED FOR DISPLAY, LABELED FROM THE MILE FIGURE. The band the label
      // comes from is a threshold in degrees per MILE, so only the number moves —
      // see rollUpTwist() in src/stats/shape.ts.
      let s = Math.round(window.TBUnits.twistFrom(t.twist.dpm, UNITS)) + window.TBUnits.twistUnit(UNITS) + " of heading change";
      // Only worth saying when the best stretch is meaningfully better than the
      // day as a whole. On a uniformly twisty day it is the same number twice.
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
    };

    // The days that COUNT, everywhere below. A ride carrying two ways to do
    // Thursday is not twice as long, and this readout is the number a rider
    // watches change while they edit — it has to agree with what the server
    // stores on the next save, which is rideTotals() over the same filter.
    const counted = ALT.activeDays(state.days);

    if (counted.length === 1) {
      const t = routeTotals(counted[0]);
      // innerHTML, not textContent: line() now carries the twistiness "?" link.
      // Nothing user-supplied reaches it — the mileage and the label are both
      // computed here — so there is no injection surface.
      totalsEl.innerHTML = line(t, true);
      totalsEl.title = twistTitle(t);
      return;
    }

    // With several days the ride total is the number that matters; the focused
    // day's own figures sit under it.
    //
    // The fold moved to TBAlt.rideRollup, which is the same file the server's
    // rule lives beside and, unlike an inline reduce, has tests — including the
    // one that pins the distance-weighted twistiness mean. Read it there for
    // why twistiness is weighted and why the best stretch is a max rather than
    // a sum.
    const ride = ALT.rideRollup(counted.map(routeTotals));
    // The per-day figures only exist when a day is selected. On "All" the ride
    // figures stand alone, which is exactly what "All" means — but the line that
    // would hold them is still emitted, empty. See below.
    const r = editIndex();
    const dayT = r == null ? null : routeTotals(state.days[r]);
    totalsEl.title = "";
    totalsEl.innerHTML =
      '<span class="totals-ride" title="' + esc(twistTitle(ride)) + '">' +
      // The count of days that COUNT, not of sections on screen. A ride with
      // three days and two alternates is a three-day ride, and saying "5 days"
      // beside a mileage that only covers three would make both look wrong.
      counted.length + " days · " + line(ride, true) + "</span>" +
      // THE DAY LINE IS EMITTED EITHER WAY, empty on "All". It is what reserves
      // its own line, so the block is the same height whichever way the scrubber
      // is set and the controls below it never move. Dropping the span when
      // there is no day is what used to shift the panel on every scrub.
      //
      // Inside it, two spans rather than one string so the stylesheet can shrink
      // the name and never the figures — see .totals-day in _builder.scss. A day
      // title runs to 150 characters and an import hands over 31 by default,
      // which would otherwise push the mileage off the line.
      '<span class="totals-day"' + (dayT ? ' title="' + esc(twistTitle(dayT)) + '"' : "") + ">" +
      (dayT
        ? '<span class="totals-day-name">' + esc(dayLabel(r)) + ":</span>" +
          '<span class="totals-day-figs">' + line(dayT, false) + "</span>"
        : "") +
      "</span>";
  }

  // Delegated events for both lists.
  function wireList(listEl) {
    listEl.addEventListener("input", (e) => {
      const row = e.target.closest(".point-row");
      if (!row) return;
      const point = pointOf(row);
      if (!point) return;
      // Keyed by the row and the field, so a run of keystrokes folds into one
      // step and moving to another field starts a new one.
      beginEdit("edit stop", "row:" + (row.dataset.kind || "") + ":" + (row.dataset.index || "") + ":" + e.target.className);
      if (e.target.classList.contains("row-name")) point.name = e.target.value;
      if (e.target.classList.contains("row-desc")) point.description = e.target.value;
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
          point.details[field] = window.TBDayClock.inputToIso(e.target.value);
        } else {
          point.details[field] = e.target.value;
        }
        markDirty();
        return;
      }
      if (e.target.classList.contains("row-dur")) {
        // Parsed on every keystroke, reformatted on none of them. Rewriting the
        // field as it is typed is hostile in every format and actively breaks
        // two: "1." becomes "1.0" with the caret stranded, and "1h " becomes
        // "1h 0m" before the rider has typed the minutes. Tidying is the blur
        // handler's job — see wireList's focusout below.
        //
        // An unparseable value stores null rather than holding the last good
        // number, so "abc" and an empty field mean the same thing, which is what
        // they look like they mean.
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
    listEl.addEventListener("click", (e) => {
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
        if (act === "notes") {
          const ta = row.querySelector(".row-desc");
          ta.hidden = false;
          ta.focus();
          return;
        }
        if (act === "details") {
          const box = row.querySelector(".row-details");
          // Re-rendered on open rather than only at row build time, because the
          // rider may have changed the stop's roles since — and roles are what
          // decide which fields show.
          box.innerHTML = detailsHtml(point, row.dataset.kind, i);
          box.hidden = false;
          const first = box.querySelector("input, textarea");
          if (first) first.focus();
          return;
        }
        if (act === "comment") return commentOnPoint(point.uid);
        if (act === "save-place") return savePointAsPlace(point);
        if (act === "duplicate") return duplicatePoint(row.dataset.kind, i);
        if (act === "delete") return deletePoint(i);
        if (act === "up") return movePoint(i, -1);
        if (act === "down") return movePoint(i, 1);
        if (act === "promote") return setPointKind(i, "stop");
        if (act === "demote") return setPointKind(i, "poi");
        if (act === "select") return startSelect("point");
        return;
      }
      if (btn.classList.contains("detail-link-add")) {
        beginEdit("add link");
        if (!point.details) point.details = blankDetails();
        if (point.details.links.length >= MAX_LINKS) return toast("Up to " + MAX_LINKS + " links per stop", true);
        point.details.links.push({ label: "", url: "" });
        const box = row.querySelector(".row-details");
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
        row.querySelector(".row-details").innerHTML = detailsHtml(point, row.dataset.kind, i);
        markDirty();
        return;
      }
      if (btn.classList.contains("row-roles-btn")) {
        closeRowMenu();
        const r = Number(row.dataset.day);
        const i = Number(row.dataset.i);
        // Toggled in state, not on the element — see state.rolesOpen. Only one
        // picker is open at a time, which is what the old DOM toggle gave by
        // accident (each row had its own) and is now deliberate: two open grids
        // in a 380px drawer is most of the panel.
        state.rolesOpen = rolesAreOpen(r, i) ? null : { day: r, i: i };
        renderDayList(r);
        return;
      }
      // A CATEGORY IS A REASON TO STOP, so choosing one promotes the point and
      // clearing the last one demotes it. Ziad's call, 2026-08-24.
      //
      // The old flow was two actions for one intention: pick "Gas", then open the
      // menu again and say "make this a stop". Tagging a point already says you
      // mean to be there — including the `poi` role itself, which is now labeled
      // Sight and means a place you stop to look at rather than one you ride past.
      //
      // "Make this a stop" survives in the menu for the case categories cannot
      // express: a stop with no reason given. Imports and the day's first point
      // both produce those, so the row has to render them either way.
      if (btn.classList.contains("role-opt")) {
        const role = btn.dataset.role;
        const r = Number(row.dataset.day);
        const day = state.days[r];
        const i = Number(row.dataset.i);
        const had = point.roles.indexOf(role);
        const removing = had >= 0;
        const last = removing && point.roles.length === 1;

        // REFUSED BEFORE beginEdit, so a rejected untag pushes no undo step. The
        // day would otherwise be left with no stop at all, which the API refuses
        // and payload() drops the whole day for. Same guard setPointKind applies
        // to an explicit demote, reached from a different direction.
        if (last && point.kind === "stop" && stopsOf(day).length <= 1) {
          return toast("A day needs at least one stop—give this one a category or make another a stop", true);
        }
        if (!removing && point.roles.length >= 4) return toast("Up to 4 categories per point", true);

        beginEdit("change category");
        if (removing) point.roles.splice(had, 1);
        else point.roles.push(role);

        // The kind follows the categories. Note this is an INTERACTION rule, not a
        // schema one: points.kind stays its own column, because an untagged stop
        // is a real shape the importer and the first-point rule both create.
        point.kind = point.roles.length ? "stop" : "poi";

        // Re-rendered rather than patched. The kind decides the row's number and
        // stops are numbered in sequence, so promoting one renumbers every row
        // below it — an in-place patch would leave the rest of the day wrong.
        // state.rolesOpen is what keeps the grid open across it.
        renderDayList(r);
        renderMarkers();
        refreshDerived();
        markDirty();
      }
    });
  }

  // --- Overflow menus -------------------------------------------------------
  //
  // ONE MENU, TWO OWNERS. Point rows have had a ⋮ since the day four buttons
  // became one; day headers now have one too, and rather than a second
  // implementation they share this. The differences between them are entirely
  // in the item list and the dispatch, which is what the `items` argument and
  // the per-host click handlers are for.
  //
  // BUILT ON OPEN, NEVER PER HOST, and that is a constraint rather than a
  // preference. The role picker already renders 17 buttons for every point —
  // 119 nodes at seven stops and 340 at twenty — and an eager menu per row would
  // repeat that mistake. One menu element exists at a time, for whichever host
  // asked.
  //
  // It is absolutely positioned inside its host, so opening it moves nothing: an
  // inline menu would push everything below it down, which is the jump the whole
  // panel redesign exists to remove. Both hosts therefore need
  // `position: relative` — .point-row and .day-head both have it.
  //
  // Move up / Move down are on the POINT menu only. They are not redundant with
  // the drag handle there, because .row-drag is aria-hidden and a drag handle
  // cannot be operated from a keyboard — they are also what still works if the
  // SortableJS CDN fails. A DAY's grip is a real <button> with arrow keys wired
  // on #day-list, so the day menu needs no equivalent.
  const MENU_ITEMS = [
    { act: "notes", label: "Edit notes" },
    { act: "details", label: "Reservation & details" },
    { act: "save-place", label: "Save to my places" },
    { act: "duplicate", label: "Duplicate" },
    { act: "select", label: "Select points…" },
    // PROMOTION ALSO LIVES HERE, and no longer only here. Picking a category
    // promotes a point on its own as of 2026-08-24 — tagging it Gas already says
    // you mean to stop — so these two items are the path for what a category
    // cannot say: a stop with no reason given, and taking one back without having
    // to find which tag to remove.
    //
    // Kept keyboard-reachable and reversible, which matters because a
    // mis-promotion would otherwise cost a delete and a re-add and take the
    // point's notes and details with it.
    { act: "promote", label: "Make this a stop", when: (pt) => pt.kind !== "stop" },
    // Clears the categories with it, or the point would come straight back as a
    // stop the next time anything re-derived the kind from its roles — and it
    // would read as a POI that is somehow tagged Gas.
    { act: "demote", label: "Make this a POI", when: (pt) => pt.kind === "stop" },
    // No longer stopOnly: a POI has a place in the list of its own now.
    // ANCHORED BY UID, which is the point's identity across a save — its id
    // churns on every PUT and cannot be referenced. The comment survives the
    // point being deleted, demoting to ride level rather than going with it.
    { act: "comment", label: "Comment on this stop" },
    { act: "up", label: "Move up" },
    { act: "down", label: "Move down" },
    { act: "delete", label: "Delete", danger: true },
  ];

  // The day menu. `when` decides whether an item appears at all — the two
  // alternate actions are meaningless on a day that is not in a group, and a
  // menu full of disabled items nobody can explain is worse than a short one.
  //
  // "Make this the active alternate" and "Ungroup alternates" are not optional
  // extras: without them a rider can put days into a group and has no way back
  // out, and no way to change their mind about which one they are riding.
  const DAY_MENU_ITEMS = [
    { act: "day-duplicate", label: "Duplicate day" },
    { act: "day-select", label: "Select days…" },
    { act: "day-promote", label: "Ride this one instead", when: (d) => d.altGroup != null && !d.altActive },
    { act: "day-ungroup", label: "Ungroup alternatives", when: (d) => d.altGroup != null },
    { act: "day-delete", label: "Delete day", danger: true },
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
          '<button type="button" role="menuitem" class="row-menu-item' + (m.danger ? " is-danger" : "") + '"' +
          ' data-act="' + m.act + '"' + (m.off ? " disabled" : "") + ">" + esc(m.label) + "</button>",
      )
      .join("");
    host.appendChild(menu);
    btn.setAttribute("aria-expanded", "true");
    menuOpener = btn;
    const first = menu.querySelector(".row-menu-item:not([disabled])");
    if (first) first.focus();
  }

  function toggleRowMenu(row, btn) {
    const i = Number(row.dataset.i);
    const day = editRoute();
    const last = day ? day.points.length - 1 : 0;
    const point = day && day.points[i];
    if (!point) return;
    // Promote and demote are ABSENT rather than disabled — unlike the ends below
    // — because exactly one of the pair applies to any row and showing the other
    // greyed out would say a point can be made into what it already is.
    //
    // Demoting the day's last stop IS shown and disabled: it is a real action
    // that is unavailable right now for a reason worth stating, and setPointKind
    // says which.
    const items = MENU_ITEMS.filter((m) => !m.when || m.when(point)).map((m) => ({
      ...m,
      off:
        (m.act === "up" && i === 0) ||
        (m.act === "down" && i === last) ||
        (m.act === "demote" && stopsOf(day).length <= 1),
    }));
    openMenu(row, btn, items);
  }

  function toggleDayMenu(head, btn, r) {
    const day = state.days[r];
    if (!day) return;
    const items = DAY_MENU_ITEMS.filter((m) => !m.when || m.when(day)).map((m) => ({
      ...m,
      // A ride needs at least one day, and the reason has to be visible before
      // the click rather than as a toast after it.
      off: m.act === "day-delete" && state.days.length <= 1,
    }));
    openMenu(head, btn, items);
  }

  // Anywhere else, or Escape. Registered once rather than per menu, so an open
  // menu never outlives the render that replaced its host.
  function wireMenuDismiss() {
    document.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".row-menu") && !e.target.closest(".row-menu-btn") && !e.target.closest(".day-menu-btn")) {
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
  // orderedRows() interleaves stops and POIs sorted by distance along the track,
  // while each row's data-i is its index within its OWN array — so Sortable's
  // oldIndex/newIndex, which count all children, mean nothing here.
  //
  // Reading the resulting DOM order of the stop rows sidesteps the interleaving
  // entirely: their data-i values in document order ARE the new ordering, however
  // many POIs were sitting between them. Dropping a stop between two POIs lands
  // it after however many stop rows precede it, which is the right answer without
  // a special case.
  //
  // Degrades to nothing if the CDN did not deliver. Every row menu carries Move
  // up and Move down, which is also the keyboard path.
  function initDragToReorder(listEl) {
    if (!window.Sortable) {
      console.warn("[builder] Sortable did not load—reorder by the row menu");
      return;
    }
    // Guard against double-binding: renderDays() rebuilds every list and calls
    // this for each, and Sortable leaves its own instance on the element.
    if (listEl._sortable) listEl._sortable.destroy();
    listEl._sortable = window.Sortable.create(listEl, {
      // `draggable` already excludes the trailing .add-row — it is not a
      // .point-row — but `filter` is what stops a drag STARTING on it, and
      // without it a drop can be placed after it, putting a real row below the
      // search field. The add row is always last.
      //
      // .insert-slot is filtered for the same reason and one more: there is one
      // between every pair of rows, so an unfiltered drag starting on a hairline
      // would be the easiest drag in the list to begin by accident.
      draggable: ".point-row",
      filter: ".add-row, .insert-slot",
      // WITHOUT THIS THE SEARCH FIELD CANNOT BE CLICKED INTO. `preventOnFilter`
      // defaults to TRUE, which makes Sortable call preventDefault() on the
      // pointerdown whenever it lands inside a filtered element — and the
      // default action being prevented is the one that moves focus. So every
      // day's add row was inert to the mouse: the input could be tabbed to and
      // typed in, but a click on it left focus on <body>. Observed on
      // /builder/9, not theorized — `e.defaultPrevented` reads true on the
      // pointerdown, and the whole .add-row is filtered, search field included.
      //
      // `filter` is still doing its real job either way: it stops a DRAG
      // starting on the add row. That is a Sortable-internal check and does not
      // need the event canceled to work.
      preventOnFilter: false,
      handle: ".row-drag",
      animation: 150,
      ghostClass: "is-dragging",
      // ONE GROUP ACROSS EVERY DAY, so a stop can be dragged out of one day and
      // into another. That is a new capability, not a side effect: before every
      // day was on screen at once there was only ever one list, and moving a stop
      // between days was impossible by any route.
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
        // case of reordering: the point leaves one day's array and joins
        // another's, and BOTH days' legs are wrong afterwards. A same-day drop
        // falls through to the index arithmetic below.
        if (evt.from !== evt.to) return movePointAcrossDays(evt);

        const day = state.days[Number(evt.from.dataset.day)];
        if (!day) return;

        // ONE OPERATION FOR BOTH KINDS, and Sortable's own indices finally mean
        // something: every row is a point in day.points and the list on screen is
        // that array in order. The whole index-mapping problem this handler used
        // to solve — two arrays, a derived interleave, a POI drag that was a
        // reposition rather than a reorder — went away with the merge.
        //
        // **`newDraggableIndex`, NEVER `newIndex`, AND THE DIFFERENCE IS NOT
        // COSMETIC.** Sortable reports two pairs of indices: `oldIndex`/`newIndex`
        // count EVERY child of the list, and `oldDraggableIndex`/`newDraggableIndex`
        // count only children matching `draggable` — the `.point-row`s. This list
        // renders an `.insert-slot` hairline ABOVE every row plus one trailing
        // `.add-row`, so it holds 2n+1 children for n points and the raw index runs
        // at roughly double the one `day.points` is addressed by.
        //
        // That was live from 2026-08-24, when the insert slots landed nine days
        // after this arithmetic, to 2026-08-27, and it failed in two ways at once
        // — measured on /builder/8, not theorized. Dragging point 7 of 8 up one
        // slot reported `newIndex: 13`, which clamped to 7 and equalled `from`, so
        // nothing moved, the ride was never marked dirty, and the next render put
        // the row back. Dragging point 0 down one slot reported `newIndex: 3` and
        // moved it three places instead of one — that half DID save, wrongly.
        // Reported as #166.
        //
        // The clamping and the did-it-move question are TBDragIndex.dropTarget,
        // in public/js/drag-index.js, so that test/drag-index.test.ts can hold the
        // arithmetic: nothing in this closure is reachable from a test, and there
        // is no browser suite. A null answer means the drop was not an edit —
        // Sortable fires onEnd for every drop, including one that changed nothing.
        const i = Number(evt.item.dataset.i);
        const to = DRAG.dropTarget(i, evt.newDraggableIndex, day.points.length);
        if (to == null) return;
        return reorderPoint(i, to);
      },
    });
  }

  // DRAG TO REORDER DAYS. The use case is a base camp: rent a house, ride a loop
  // from it each day, and the days are interchangeable in a way a linear tour's
  // are not — so the order is something a rider genuinely revises, not just an
  // artefact of what they entered first.
  //
  // Cheaper than reordering stops, because a day owns its own legs: moving day 3
  // above day 1 changes no leg's endpoints and needs no routing call. Only the
  // position changes, plus the parallel legSeq array that tracks in-flight
  // routing responses — leaving that behind would let a stale response land on
  // whichever day took the old index.
  //
  // Rebound on every renderDays() because that replaces the sections; the
  // instance is stashed on the element and destroyed first, same as the lists.
  function initDayDrag(host) {
    if (!window.Sortable) return;
    if (host._sortable) host._sortable.destroy();
    host._sortable = window.Sortable.create(host, {
      draggable: ".day-section",
      handle: ".day-drag",
      animation: 150,
      ghostClass: "is-dragging",
      // Same reasoning as the stop list: one code path on desktop and touch, a
      // drag mirror we can style, and the only path a synthetic event can drive.
      forceFallback: true,
      fallbackClass: "day-drag-ghost",
      fallbackOnBody: true,
      delay: 200,
      delayOnTouchOnly: true,
      // DRAGGING IS OFF WHILE SELECTING. A drag started with four rows ticked
      // reads as "move all four" and does not do that, and there is no reading
      // of it that is obviously right — so the gesture is taken away rather than
      // given an ambiguous meaning.
      disabled: !!state.select,
      onEnd: (evt) => {
        // The RAW indices are safe here and only because #day-list holds nothing
        // but .day-section children, so they agree with the draggable ones. The
        // point list does not have that property and #166 is what it cost: adding
        // any sibling between the sections — a separator, a drop hint — silently
        // makes these read about double. Use the draggable pair if that ever
        // changes.
        const from = evt.oldIndex;
        const to = evt.newIndex;
        if (from === to || from == null || to == null) return;
        beginEdit("reorder days");
        const [day] = state.days.splice(from, 1);
        state.days.splice(to, 0, day);
        const [seq] = state.legSeq.splice(from, 1);
        state.legSeq.splice(to, 0, seq || []);
        // The day that moved is the one the rider is thinking about.
        state.active = to;
        renderDays();
        // Layers are keyed by day index, so every one from the lower of the two
        // positions onward is now drawing the wrong day. Rebuilding is the whole
        // fix and costs no routing.
        rebuildLayers();
        renderMarkers();
        refreshDerived();
        markDirty();
      },
    });
  }

  // A POINT DRAGGED OUT OF ONE DAY AND INTO ANOTHER.
  //
  // New with the all-days panel: while only one day was ever on screen there was
  // only one list, and this could not be expressed at all. It is a move between
  // two arrays, not a reorder within one, and the consequence that matters is
  // that BOTH days' legs are wrong afterwards — the source loses a stop and the
  // destination gains one, so the invariant every day carries (N stops means
  // exactly N-1 legs, enforced server-side in ride-graph.ts) breaks at both ends
  // until they are rebuilt.
  //
  // Legs are dropped wholesale on both sides rather than patched. Patching means
  // reasoning about which of the surviving legs still joins the same pair of
  // stops, and the shaping points on any leg that touched the moved stop are
  // meaningless regardless. computeLegsAround refills them from the router.
  function movePointAcrossDays(evt) {
    const fromDay = Number(evt.from.dataset.day);
    const toDay = Number(evt.to.dataset.day);
    const src = state.days[fromDay];
    const dst = state.days[toDay];
    if (!src || !dst || fromDay === toDay) return;

    const i = Number(evt.item.dataset.i);
    const moving = src.points[i];
    if (!moving) return;
    const kind = moving.kind;

    beginEdit("move " + (kind === "stop" ? "stop" : "POI") + " between days");

    const [pt] = src.points.splice(i, 1);
    // Where it landed in the DESTINATION's list — Sortable's index into the
    // ROWS, clamped because .add-row is a child too and always last.
    //
    // `newDraggableIndex`, never `newIndex`: the destination list interleaves an
    // .insert-slot above every row, so the raw child index runs at about double
    // the one dst.points is addressed by. Same bug as the same-day path in
    // initDragToReorder's onEnd, and it landed here as an append to the bottom of
    // the target day rather than a drop where the rider aimed. See #166.
    //
    // insertTarget rather than dropTarget: the point is not in this array yet, so
    // one past the last element is an append and a legitimate answer.
    const at = DRAG.insertTarget(evt.newDraggableIndex, dst.points.length);
    // A POI's distance along the track belongs to the day it was measured on and
    // means nothing on another one. Null is honest — "near this day's route,
    // position not measured" — and is exactly what an import with no track
    // stores. See the null-is-not-zero note in AGENTS.md.
    pt.distFromStartMi = null;
    dst.points.splice(at, 0, pt);

    // A DAY MUST KEEP A STOP. Dragging the last one out would leave a day the
    // save refuses and payload() drops whole, so the first survivor is promoted
    // in its place — the same rule addPoint applies to a day's first point,
    // applied to a day that has just lost its only anchor.
    if (kind === "stop" && stopsOf(src).length === 0 && src.points.length > 0) {
      src.points[0].kind = "stop";
    }

    src.legs = [];
    dst.legs = [];
    state.legSeq[fromDay] = [];
    state.legSeq[toDay] = [];

    // Rebuilt rather than patched: both lists have shifted indices, and every
    // row's data-i has to agree with the arrays again before any later handler
    // reads one.
    renderDays();
    rebuildLayers();
    renderMarkers();
    // Both days are refilled regardless of kind: the legs were cleared above and
    // a day whose points merely shifted still needs its placeholders back.
    [fromDay, toDay].forEach((r) => {
      const day = state.days[r];
      if (!day) return;
      fillMissingLegs(day);
      computeLegsAround(r, Array.from({ length: Math.max(0, day.points.length - 1) }, (_, k) => k));
    });
    setActive(toDay);
    refreshDerived();
    markDirty();
    toast("Moved to " + dayLabel(toDay));
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
  // on open. `results.dataset.day` remembers which day the open list is for, so
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
  }

  function wireSearch() {
    const host = $("day-list");
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
    // The slot a row inserts into, or null for the day's bottom row. One reader,
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
    // The day's LAST point, because that is where the rider has got to — asking
    // for gas while planning day 3 means gas near the end of day 3, not near the
    // start of day 1. Falls back to the map viewport on a day with no points
    // yet, and to nothing at all before the map has settled, in which case Text
    // Search answers unbiased rather than not at all.
    //
    // A typed query that names a place ("gas station in oakdale ca") does not
    // come through here: Text Search reads the place out of the text itself, so
    // sending an anchor as well would fight it.
    function anchorFor(r) {
      const day = state.days[r];
      const last = day && day.points.length ? day.points[day.points.length - 1] : null;
      if (last) return [last.lng, last.lat];
      return mapCenter(state.map);
    }

    async function nearbySearch(query, near) {
      const res = await fetch("/api/places/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(near ? { query: query, near: near } : { query: query }),
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
      if (!hits.length) return "";
      return (
        '<li class="hit-head" aria-hidden="true">Nearby</li>' +
        hits
          .map(
            (h, i) =>
              '<li class="hit-nearby" data-nearby="' + i + '"><strong>' + esc(h.name) + "</strong> " +
              '<span class="hit-ctx">' + esc(h.address) + "</span></li>",
          )
          .join("")
      );
    }

    // `role` is the chip's role, or the one parse() read out of the query. It
    // wins over the place's own type — the rider said "gas", so a convenience
    // store that came back among the stations is still the answer to a question
    // about fuel. roleForType() fills in only when nothing was asked for.
    function wireNearbyResults(host, hits, role) {
      host.querySelectorAll("li.hit-nearby").forEach((li) => {
        li.addEventListener("click", () => {
          const h = hits[Number(li.dataset.nearby)];
          if (!h) return;
          const r = Number(host.dataset.day);
          hideSearchResults();
          setActive(r);
          // Built here rather than letting addPoint mint a bare one, for the same
          // reason a saved place is: the role is the point of having searched by
          // category, and addPoint's auto-promotion leaves a supplied role alone.
          const pt = newPoint(h.lngLat[0], h.lngLat[1], h.name);
          const tag = role || QUERY.roleForType(h.type);
          if (tag) pt.roles = [tag];
          addPoint(h.lngLat[0], h.lngLat[1], h.name, r, pt, openSlot(host));
          panTo(state.map, h.lngLat, 13);
          const next = document.querySelector('.add-row[data-day="' + r + '"] .add-search');
          if (next) next.focus();
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
            '<li class="hit-saved" data-saved="' + i + '">' +
            '<span class="hit-badge">Saved</span> <strong>' + esc(pl.name) + "</strong> " +
            '<span class="hit-ctx">' + esc(pl.groupName || pl.address || "") + "</span></li>",
        )
        .join("");
    }

    // Rewired on every render because the list is rebuilt wholesale — the same
    // reason the search field itself is delegated rather than bound per input.
    const openSlot = (host) => (host.dataset.at === "" || host.dataset.at == null ? null : Number(host.dataset.at));

    function wireSavedResults(host, list) {
      host.querySelectorAll("li.hit-saved").forEach((li) => {
        li.addEventListener("click", () => {
          const pl = list[Number(li.dataset.saved)];
          if (!pl) return;
          const r = Number(host.dataset.day);
          hideSearchResults();
          setActive(r);
          // Built here and handed in, rather than letting addPoint mint a bare
          // point: the roles and the durable details are the reason a saved
          // place is worth having.
          const pt = stopFromPlace(pl);
          addPoint(pl.lng, pl.lat, pl.name, r, pt, openSlot(host));
          panTo(state.map, [pl.lng, pl.lat], 11);
          const next = document.querySelector('.add-row[data-day="' + r + '"] .add-search');
          if (next) next.focus();
        });
      });
    }

    // Delegated on #day-list, because renderDays() replaces every one of these
    // fields on any structural change. Binding per input would either be lost
    // on the next render or leak a listener per render.
    host.addEventListener("input", (e) => {
      const input = e.target.closest(".add-search");
      if (!input) return;
      const day = Number(input.closest(".add-row").dataset.day);
      const at = slotOf(input);
      clearTimeout(searchTimer);
      const q = input.value.trim();

      // Saved places first, and they are drawn IMMEDIATELY — no debounce, no
      // network, no minimum length beyond one character. Typing "bob" surfaces
      // your own "Bob's Gas" before Google has been asked anything, which is the
      // whole reason to have a library. The predictions land underneath 300ms
      // later and are appended rather than replacing these.
      const saved = matchSavedPlaces(q);
      if (saved.length) {
        results.dataset.day = String(day);
        results.dataset.at = at == null ? "" : String(at);
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
            cat ? nearbySearch(cat.text, /\b(in|near|around|close to|by)\b/.test(q) ? null : anchorFor(day)) : [],
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
          results.dataset.day = String(day);
        results.dataset.at = at == null ? "" : String(at);
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
                  '<li class="hit-google" data-i="' + i + '"><strong>' + esc(h.name) + "</strong> " +
                  '<span class="hit-ctx">' + esc(h.context) + "</span></li>",
              )
              .join("") +
            nearbyResultsHtml(nearby) +
            // SAID OUT LOUD, not left as an empty box. "Nothing matched" and
            // "the search broke" were pixel-identical before this.
            (nothing ? noticeHtml("No matches for “" + q + "”") : "") +
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
          results.querySelectorAll("li.hit-google").forEach((li) => {
            li.addEventListener("click", async () => {
              // Coordinates are fetched only for the pick — Place Details bills
              // per call, so resolving all five would cost five times as much.
              const picked = await hits[Number(li.dataset.i)].resolve().catch(() => null);
              if (!picked) return toast("Could not locate that place", true);
              const [lng, lat] = picked.lngLat;
              // Read the day off the open list rather than the closure: it is
              // the same value, and taking it from one place means a stale
              // closure can never put a stop on the wrong day.
              const r = Number(results.dataset.day);
              // The row's own radio, not the panel's + Stop / + POI pair. That
              // pair belongs to the map click; a searched address is a separate
              // gesture and deserves its own answer.
              hideSearchResults();
              // The day whose row was used becomes the active one, so a map
              // click afterwards continues where the rider is working rather
              // than wherever they last clicked.
              setActive(r);
              addPoint(lng, lat, picked.name, r, null, openSlot(results));
              panTo(state.map, picked.lngLat, 11);
              // The add above re-rendered the list, so this row is a new
              // element. Put the cursor in its replacement: adding several
              // stops in a row is the common case and should not need a click
              // between each one.
              const next = document.querySelector('.add-row[data-day="' + r + '"] .add-search');
              if (next) next.focus();
            });
          });
        } catch (e) {
          console.warn("[builder] search:", e.status || "", e.message);
          if (mine !== searchSeq || !input.isConnected) return;
          // The failure REACHES THE RIDER. This was a bare console.warn, so a
          // referrer-restricted key, a pending account or a Places API that was
          // never enabled all presented as an empty dropdown and no explanation.
          results.dataset.day = String(day);
        results.dataset.at = at == null ? "" : String(at);
          results.innerHTML = noticeHtml(searchErrorText(e));
          results.hidden = false;
          placeResults(input, results);
        }
      }, 300);
    });

    host.addEventListener("click", (e) => {
      const btn = e.target.closest(".add-place-btn");
      if (!btn || btn.disabled) return;
      armPlace(Number(btn.dataset.day), slotOf(btn));
    });

    // Opening a gap. Re-rendered rather than patched in place: the row that
    // replaces the hairline is a real .add-row with a search field, chips and an
    // arm button, and every handler for those is delegated on #day-list and
    // resolves the row from its own data attributes. Building it through the
    // normal render is what makes an inserted point behave identically to an
    // appended one.
    //
    // NOT an edit. No beginEdit, no markDirty — opening a field changes nothing
    // about the ride, and putting it on the undo stack would make Ctrl-Z close a
    // text box instead of undoing the last real change.
    host.addEventListener("click", (e) => {
      // The whole strip, not only the glyph — an 18px full-width row is something
      // a thumb can hit, an 18px square is not. .insert-btn is still inside it and
      // carries the accessible label, so the keyboard path is unchanged.
      const btn = e.target.closest(".insert-slot");
      if (!btn) return;
      const r = Number(btn.dataset.day);
      const at = Number(btn.dataset.at);
      // A second press on the same gap closes it, matching how the arm button
      // toggles rather than needing a separate dismiss.
      const open = state.insertAt;
      state.insertAt = open && open.day === r && open.at === at ? null : { day: r, at: at };
      // Arming belongs to the row that armed it, and that row may have just
      // stopped existing.
      disarmPlace();
      hideSearchResults();
      setActive(r);
      renderDayList(r);
      const field = document.querySelector('.add-row.is-insert[data-day="' + r + '"] .add-search');
      if (field) field.focus();
    });

    // A CHIP IS A SEARCH, not a mode. One tap runs the category search for that
    // day and opens the same dropdown a typed query would — the pick path, the
    // role tagging and the error line are all shared, so a chip cannot behave
    // differently from typing the same words.
    //
    // The field is left empty on purpose. Filling it with "gas station" would
    // look like the rider typed it and would then be re-searched on the next
    // keystroke, spending a second call to get the same answer.
    host.addEventListener("click", async (e) => {
      const chip = e.target.closest(".chip");
      if (!chip || chip.disabled) return;
      const r = Number(chip.dataset.day);
      const spec = CHIPS.find((c) => c.role === chip.dataset.chip);
      if (!spec || !state.days[r]) return;
      const at = slotOf(chip);
      const row = chip.closest(".add-row");
      const input = row ? row.querySelector(".add-search") : null;
      const results = searchResultsEl();
      results.dataset.day = String(r);
      results.dataset.at = at == null ? "" : String(at);
      const mine = ++searchSeq;
      // Something in the box immediately: a billed round trip with no feedback
      // reads as a dead button, and this one is a button.
      results.innerHTML = noticeHtml("Finding " + spec.label.toLowerCase() + "…");
      results.hidden = false;
      if (input) placeResults(input, results);
      try {
        const nearby = await nearbySearch(spec.query, anchorFor(r));
        if (mine !== searchSeq) return;
        results.innerHTML =
          nearbyResultsHtml(nearby) ||
          noticeHtml("No " + spec.label.toLowerCase() + " found near this day");
        results.hidden = false;
        if (input) placeResults(input, results);
        wireNearbyResults(results, nearby, spec.role);
      } catch (err) {
        console.warn("[builder] chip search:", err.status || "", err.message);
        if (mine !== searchSeq) return;
        results.innerHTML = noticeHtml(searchErrorText(err));
        results.hidden = false;
        if (input) placeResults(input, results);
      }
    });

    // Escape dismisses the suggestions without clearing the query — the rider
    // may have meant to close the list, not to start over.
    host.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !e.target.closest(".add-search")) return;
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
        const r = state.insertAt.day;
        state.insertAt = null;
        renderDayList(r);
      }
    });

    document.addEventListener("click", (e) => {
      if (e.target.closest(".add-row") || e.target.closest("#search-results")) return;
      hideSearchResults();

      // THE + THAT OPENS A SLOT IS AN OUTSIDE CLICK BY THIS TEST. Both handlers
      // see the same event — the delegated one on #day-list opens the row, then
      // this one bubbles and would close it again, so clicking + did nothing at
      // all. Observed, not theorized.
      if (e.target.closest(".insert-slot")) return;

      // AN UNUSED INSERT ROW CLOSES ITSELF. It is an affordance, not a form: the
      // rider asked for a field between two points, did not use it, and looked
      // somewhere else. Leaving it open puts a stray search box in the middle of a
      // day that nothing will ever clear, and the rider has to find the Escape key
      // or the same + again to be rid of it.
      //
      // The bottom add-row is untouched — that one is permanent and belongs to the
      // day.
      //
      // NOT WHEN SOMETHING IS ARMED, and this is the case that makes the guard
      // necessary rather than defensive: arming "+ Point" and then clicking the
      // map is the whole point of the button, and that map click is an outside
      // click. Closing on it would take the row and the armed slot away a
      // moment before the point landed in it. The insert itself clears
      // state.insertAt when it completes, so the row still goes away — just
      // after doing its job rather than instead of it.
      if (state.insertAt && state.arm == null) {
        const r = state.insertAt.day;
        state.insertAt = null;
        renderDayList(r);
      }
    });
  }

  // Ticking boxes and the bar's buttons. Delegated on the panel because
  // renderDays() replaces every checkbox on every structural change.
  function wireSelect() {
    const panel = document.querySelector(".builder-panel");
    if (!panel) return;

    panel.addEventListener("change", (e) => {
      const sel = state.select;
      if (!sel) return;
      const el = e.target;
      if (el.classList.contains("day-pick")) {
        const r = Number(el.dataset.day);
        if (el.checked) sel.days.add(r);
        else sel.days.delete(r);
        return renderSelectBar();
      }
      if (el.classList.contains("row-pick")) {
        const key = pointKey(Number(el.dataset.day), el.dataset.kind, Number(el.dataset.i));
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
        sel.days.clear();
        sel.points.clear();
        renderDays();
        return renderSelectBar();
      }
      if (act === "all") {
        if (sel.scope === "day") state.days.forEach((_, r) => sel.days.add(r));
        else {
          state.days.forEach((day, r) => {
            day.points.forEach((pt, i) => sel.points.add(pointKey(r, pt.kind, i)));
          });
        }
        renderDays();
        return renderSelectBar();
      }
      if (act === "delete") return sel.scope === "day" ? deleteSelectedDays() : deleteSelectedPoints();
      if (act === "duplicate") return duplicateSelectedDays();
      if (act === "group") return groupSelectedAsAlts();
    });
  }

  // --- Save / load ----------------------------------------------------------

  function payload() {
    return {
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
      // The API requires at least one stop per day, so a day you added but
      // never filled in would fail validation for the whole ride. Dropping it
      // is what the rider means; save() warns when it happens.
      days: state.days
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
          // resolveAltGroups. Note a day dropped by the filter above can leave a
          // group with one member, which is exactly the case that dissolves.
          altGroup: r.altGroup,
          altActive: r.altActive,
          points: r.points,
          legs: r.legs,
        })),
    };
  }

  // Warned once per episode rather than on every flush. Autosave calls save()
  // several times a minute, and a rider who has added a day and not yet given it
  // a stop would otherwise be told about it continuously for as long as it takes
  // them to add one. Reset when nothing is being dropped, so the next episode
  // warns again.
  let warnedDropped = false;

  async function save() {
    if (state.saving) return;
    // Unreachable while markDirty holds the line, and here because a save is the
    // one thing in this file that cannot be allowed to happen by a route nobody
    // thought of.
    if (!CAN_EDIT) return;
    const body = payload();
    const dropped = state.days.length - body.days.length;
    if (dropped > 0 && !warnedDropped) {
      warnedDropped = true;
      toast(dropped + " empty day" + (dropped > 1 ? "s" : "") + " not saved—add a stop to it");
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
      if (!res.ok) throw new Error(data.error || "save failed (" + res.status + ")");
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
    const a = $("view-link");
    if (!a) return;
    a.href = "/m/" + encodeURIComponent(slug);
    a.classList.remove("is-empty");
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
      // The other half of payload()'s round-trip. Omitting any of these is how
      // a rider's whole subgroup setup works perfectly until they reload and is
      // then silently gone — the same trap the altGroup comment below names,
      // and worse here because the days keep their tags while the subgroups
      // they name stop existing.
      subgroups: ride.subgroups || [],
      primarySubgroup: ride.primarySubgroup ?? null,
      trunkSubgroup: ride.trunkSubgroup ?? null,
      timeAnchor: ride.timeAnchor || "departure",
    };
    // Every day loads. This used to take days[0] and warn that saving would
    // drop the rest, which made multi-day rides effectively read-only.
    state.days = (ride.days || []).map((r, i) => ({
      // `|| uid()` rather than assuming one is there: a ride saved before this
      // shipped has none in flight, and the server repairs a null anyway — but
      // a day carrying undefined here would send undefined straight back and
      // churn its uid on every save, losing its votes each time.
      uid: r.uid || uid(),
      // `?? null` rather than `|| null` for symmetry with altGroup below —
      // there is no falsy uid, but the two fields are read the same way and one
      // of them written differently is a thing somebody has to check.
      subgroupUid: r.subgroupUid ?? null,
      title: r.title || "",
      color: r.color || DAY_COLORS[i % DAY_COLORS.length],
      startAt: r.startAt || null,
      endAt: r.endAt || null,
      endManual: false,
      // The other half of payload()'s round-trip. Omitting these is how a
      // rider's alternate grouping works perfectly until they reload the page
      // and then is silently gone, with the ride's mileage jumping to match —
      // `?? null` rather than `|| null` because 0 is a real group id.
      altGroup: r.altGroup ?? null,
      altActive: r.altActive ?? true,
      // One ordered list. A payload from before 2026-08-23 cannot reach this —
      // loadRidePayload is the only source and it was changed with the schema.
      points: r.points || [],
      legs: r.legs || [],
    }));
    state.days.forEach(fillMissingLegs);
    // Nothing has changed the day yet, so a stored end that matches what the
    // day derives is one we wrote — anything else the rider chose themselves.
    state.days.forEach((r) => {
      r.endManual = inferEndManual(r);
    });
    if (state.days.length === 0) state.days = [newDay()];
    $("ride-title").value = state.meta.title;
    $("ride-description").value = state.meta.description;
    $("ride-visibility").value = state.meta.visibility;
    fitTitle();
    // What was just loaded IS what the server holds, so the panel opens on
    // "Saved" rather than on the "Not saved yet" a new ride starts at.
    setSaveStatus("saved");
    if (ride.slug) showViewLink(ride.slug);
  }

  // --- Init -----------------------------------------------------------------

  // ALL DELEGATED ON #day-list, because there are N of every one of these now and
  // renderDays() replaces the lot on any change to the set of days. A bound
  // listener would go with the element it was bound to.
  //
  // Every handler starts by making the touched day active. That single line is
  // what let the ~15 shared edit functions below keep reading editIndex() when
  // the panel went from one visible day to all of them.
  function wireDays() {
    $("time-slider").addEventListener("input", (e) => setMoment(Number(e.target.value)));
    $("rail-days").addEventListener("click", (e) => {
      const btn = e.target.closest(".rail-day");
      if (!btn) return;
      const r = Number(btn.dataset.day);
      goToDay(r);
      // The rail is a jump list, so it scrolls as well as selects. Harmless while
      // the drawer is collapsed and the sections are not on screen — it is the
      // reopened drawer that lands in the right place.
      const sec = daySection(r);
      if (sec) sec.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    $("day-add").addEventListener("click", addDay);
    wireSubgroups();

    // Only present on a saved ride — see the markup in src/routes/builder.ts.
    const del = $("ride-delete");
    if (del) del.addEventListener("click", deleteRide);

    const host = $("day-list");

    // Pointerdown rather than click: it fires before focus moves, so tabbing or
    // clicking into a field has already set the right active day by the time any
    // other handler runs.
    host.addEventListener("pointerdown", (e) => setActiveFromEl(e.target));
    host.addEventListener("focusin", (e) => setActiveFromEl(e.target));

    host.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const sec = btn.closest(".day-section");
      if (!sec) return;
      const r = Number(sec.dataset.day);
      setActive(r);
      if (btn.classList.contains("day-twirl")) {
        const shut = sec.classList.toggle("is-shut");
        btn.setAttribute("aria-expanded", String(!shut));
        return;
      }
      if (btn.classList.contains("day-rev")) return reverseDay();
      if (btn.classList.contains("day-menu-btn")) {
        return toggleDayMenu(sec.querySelector(".day-head"), btn, r);
      }
      if (btn.classList.contains("row-menu-item") && btn.closest(".day-head")) {
        // Close first: every one of these re-renders, and a menu still attached
        // to a section that is about to be replaced would be orphaned mid-click.
        const act = btn.dataset.act;
        closeMenu();
        if (act === "day-delete") return deleteDay();
        if (act === "day-duplicate") return duplicateDay(r);
        if (act === "day-promote") return promoteAlt(r);
        if (act === "day-ungroup") return ungroupAlts(r);
        if (act === "day-select") return startSelect("day");
        return;
      }
      // Ticking a day. Not delegated through setActive above — a checkbox is
      // about the set, not about where the next map click lands.
      if (btn.classList.contains("day-pick")) return;
    });

    // The keyboard half of the drag handle. Reordering was two buttons until
    // 2026-08-16; the grip carries it now so the header keeps its width.
    // preventDefault because the drawer scrolls, and an arrow key that both moves
    // the day and scrolls the panel loses the day off the screen.
    host.addEventListener("keydown", (e) => {
      const grip = e.target.closest(".day-drag");
      if (!grip) return;
      const dir = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      if (!dir) return;
      e.preventDefault();
      const sec = grip.closest(".day-section");
      if (!sec) return;
      setActive(Number(sec.dataset.day));
      moveDay(dir);
      // renderDays() has replaced the button that was focused, so focus has to be
      // put back on the same day's grip at its NEW position or the next arrow key
      // goes nowhere.
      const moved = daySection(activeIndex());
      const next = moved && moved.querySelector(".day-drag");
      if (next) next.focus();
    });

    host.addEventListener("input", (e) => {
      const sec = e.target.closest(".day-section");
      if (!sec) return;
      const r = Number(sec.dataset.day);
      setActive(r);
      const day = state.days[r];
      if (!day) return;
      if (e.target.classList.contains("day-color")) {
        beginEdit("recolor day", "day-color:" + r);
        day.color = e.target.value;
        sec.style.setProperty("--day-color", day.color);
        renderRailDays();
        rebuildLayers();
        renderMarkers();
        markDirty();
        return;
      }
      if (e.target.classList.contains("day-title")) {
        beginEdit("rename day", "day-title:" + r);
        day.title = e.target.value;
        // Deliberately NOT renderDays(): rebuilding the section would take the
        // caret out of the field being typed in.
        renderRailDays();
        refreshDerived();
        markDirty();
      }
    });

    host.addEventListener("change", (e) => {
      const sec = e.target.closest(".day-section");
      if (!sec) return;
      const r = Number(sec.dataset.day);
      setActive(r);
      const day = state.days[r];
      if (!day) return;
      if (e.target.classList.contains("day-subgroup")) {
        beginEdit("change which group rides a day");
        // "" is the Everyone option, and null is what the payload carries — an
        // empty string would reach the server as a uid that matches nothing and
        // be resolved to null anyway, but silently and one layer too late.
        day.subgroupUid = e.target.value || null;
        // A full render: the map has to redraw the strand and the anchor note
        // depends on which days each group owns.
        renderDays();
        rebuildLayers();
        markDirty();
        return;
      }
      if (e.target.classList.contains("day-start")) {
        beginEdit("change start time");
        day.startAt = localInputToIso(e.target.value);
        refreshDerived();
        markDirty();
        return;
      }
      // Typing an end overrides the derivation; clearing it hands control back,
      // and refreshDerived() refills the field from the day on the way out.
      if (e.target.classList.contains("day-end")) {
        beginEdit("change end time");
        day.endAt = localInputToIso(e.target.value);
        day.endManual = day.endAt !== null;
        refreshDerived();
        markDirty();
      }
    });
  }

  // Sharing a ride that begins at the rider's front door puts a pin on their
  // house — and moving the pin would not be enough, because the first leg is
  // *drawn* from there. The line points at the building whatever the marker
  // says. So the swap happens here, while planning, and re-days leg 0.
  //
  // Offered rather than applied: the rider may well have meant to share it, and
  // silently redrawing a day they already planned is worse than asking.
  function offerPublicStart() {
    // ANY LEVEL BUT PRIVATE, stated as the exclusion rather than as a list of
    // the open ones — `friends` joined the enum on 2026-08-26 and a list would
    // have silently kept the prompt from firing for it, which is a pin on
    // somebody's house shown to everyone they ride with. The one level that
    // shows a ride to nobody is the only one that is safe here.
    const shared = state.meta.visibility !== "private";
    const start = window.TB.publicStart;
    // points[0], not the first STOP. The first point of every day is promoted on
    // the spot, so they are the same element — reading the ordered list directly
    // keeps it true if that ever stops being the case, and leg 0 below runs out
    // of points[0] either way.
    const day = state.days[0];
    const first = day && day.points[0];
    if (!shared || !start || !first || !(first.roles || []).includes("home")) return;
    if (state.startSwapDeclined) return;

    const ok = window.confirm(
      "This ride starts at your home address, and a shared map would show a pin on it.\n\n" +
        "Replace the start with your public starting point (" + start.label + ")?",
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
    if (day.legs[0]) day.legs[0].viaPoints = [];
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
    $("ride-visibility").addEventListener("change", (e) => {
      beginEdit("change visibility");
      state.meta.visibility = e.target.value;
      markDirty();
      offerPublicStart();
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
    state.days.forEach((day, r) => {
      // NOT a spread — see the same note in viewer.js. Spread passes every
      // element as its own ARGUMENT, so a long track exceeds the engine's
      // argument limit (~65k Safari, ~125k V8) and throws
      // `RangeError: Maximum call stack size exceeded`. Measured on a
      // 211,939-vertex import, where one leg alone held 161,831.
      for (const p of fullTrack(r)) pts.push(p);
      day.points.forEach((p) => pts.push([p.lng, p.lat]));
    });
    return pts;
  }

  // Undo/redo controls and the recovery prompt.
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

    // Leaving a field ends the run of keystrokes, so the next edit is its own
    // undo step rather than folding into the last word typed.
    document.addEventListener("focusout", () => history_.breakCoalesce());
    renderHistoryButtons();
  }

  // A draft only means something if it is newer than what was just loaded, and
  // nothing is applied until the rider says so — restoring over a saved ride
  // without asking is its own kind of data loss.
  // Tell the layout how tall the page-top banner is, so the map and the drawer
  // move down instead of being painted over.
  //
  // MEASURED, not declared. The recovery text wraps to two lines in a narrow
  // drawer and the maps-misconfigured banner is longer again, so no constant is
  // right — and a constant that is wrong either leaves a gap or puts the banner
  // back over the logo. Re-measured on resize for the same reason.
  //
  // Reads 0 when the banner is hidden or absent, which is what every other page
  // gets and what makes the calc()s in _map.scss a no-op by default.
  //
  // IT ONLY ACTS ON A CHANGE, AND THAT IS WHAT STOPS IT RECURSING FOREVER.
  // This function dispatches a resize, and it is itself a resize listener, so
  // dispatching unconditionally called it again from inside itself: a
  // RangeError every time a banner appeared, thrown out of offerRecovery() and
  // straight through init(). Everything after that line was then never wired —
  // clicking the map added nothing and the route could not be dragged into
  // shape — so a rider with an unsaved draft got a builder that looked normal
  // and did not work, with one console error nobody was looking at.
  //
  // Comparing against the last value fixes it at the source rather than with a
  // re-entry flag: the nested call measures the same height, changes nothing
  // and returns, and a resize that did not move the banner no longer costs a
  // pointless map redraw either.
  let bannerH = null;
  function setBannerOffset() {
    const bar = document.querySelector(".tb-banner:not([hidden])");
    const h = bar ? Math.ceil(bar.getBoundingClientRect().height) : 0;
    if (h === bannerH) return;
    bannerH = h;
    document.documentElement.style.setProperty("--banner-h", h + "px");
    // The map's own viewport changed size, and Google only notices on a resize
    // event. Without this the tiles keep the old height and the controls sit
    // off the bottom edge until something else nudges it.
    if (state.map && h) window.dispatchEvent(new Event("resize"));
  }

  window.addEventListener("resize", setBannerOffset);

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
      state.days = d.days.map((r) => ({ ...r, legs: (r.legs || []).map((l) => ({ ...l, geometry: [] })) }));
      state.legSeq = [];
      renderEverything();
      bar.hidden = true;
      setBannerOffset();
      // Geometry is not in the draft — the router rebuilds it. Stops are what
      // could not have been recovered from anywhere else.
      state.days.forEach((_, r) =>
        computeLegsAround(
          r,
          Array.from({ length: Math.max(0, state.days[r].points.length - 1) }, (_, i) => i),
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
    wireDays();
    // Delegated on the container rather than on each list, so the handlers
    // survive renderDays() replacing every list. Sortable cannot work that way —
    // it binds to the list element — so initDragToReorder is called per list from
    // renderDays instead.
    wireList($("day-list"));
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

    // Unlike Mapbox, the map is usable as soon as the constructor resolves —
    // there is no style to wait on, so the `load` handler this replaces is gone.
    state.map = await initMap("map");

    // The server only sends TB.home on the new-ride day, so this cannot fire
    // while editing. Guarding on stops.length as well means a reload of a
    // half-built ride does not stack a second home stop on the first.
    if (window.TB.home && !state.rideId && state.days[0].points.length === 0) {
      // Seeded with its roles already set, so addPoint's auto-promotion leaves
      // them alone — it only supplies `start` when the caller named nothing. Both
      // are true of this point: it is where the ride begins and it is home.
      const seed = newPoint(window.TB.home.lng, window.TB.home.lat, "Home");
      seed.roles = ["start", "home"];
      addPoint(window.TB.home.lng, window.TB.home.lat, "Home", 0, seed);
    }

    rebuildLayers();
    renderMarkers();
    renderDays();
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
      // index, and splicing a new stop into a day renumbers every point after
      // it. The rider would then delete a different set from the one they
      // ticked, silently. Saying so beats acting on the stale keys.
      if (state.select?.scope === "point") return toast("Finish selecting first", true);
      // NEVER A CHOICE HERE. addPoint() decides the kind and it is the only place
      // that does: a POI, unless this is the day's first point. The panel-wide
      // + Stop / + POI pair that used to decide it was removed on 2026-08-22 —
      // it read as a pair of buttons that add something and was really a mode
      // switch that added nothing, which is exactly how it was reported — and the
      // per-row radios that briefly replaced it went on 2026-08-23 with the
      // POI-first model. Promotion is a row-menu item now, and free.
      //
      // An armed "+ Stop" names the day explicitly; an unarmed click falls back
      // to whichever day the rider last touched, which is what it always did.
      // Read and cleared BEFORE the add, so a failed add cannot leave the
      // builder armed with the button still lit.
      const armed = state.arm;
      const armedAt = state.armAt;
      disarmPlace();
      addPoint(lng, lat, "", armed, null, armedAt);
    });
  }

  init();
})();
