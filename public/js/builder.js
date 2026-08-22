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
  const { dayTwistiness, twistLabel, dayPoiDistances } = window.TBTwist;

  // Pure drag-to-shape arithmetic — see route-shape.js.
  const { legAtVertex, nearestVertexIndex, viaInsertIndex } = window.TBShape;

  const MILE = 1609.344;
  const MAX_DAYS = 31; // matches MAX_DAYS in src/routes/rides.ts
  const MAX_STOPS = 200;
  const MAX_POIS = 200;
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
    // Alternates. A new day is always a plain one — grouping is something a
    // rider does to days that already exist. Both fields DO go in payload() and
    // both come back in loadExisting(); see src/maps/alts.ts for what they mean
    // and why the group id is not stable across a save.
    altGroup: null,
    altActive: true,
    stops: [],
    pois: [],
    legs: [],
  });

  const state = {
    map: null,
    rideId: window.TB.rideId || null,
    meta: { title: "", description: "", visibility: "private", external_url: "" },
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
    addMode: "stop",
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
    if (!state.meta.title.trim()) return "Needs a title";
    if (!state.days.some((r) => r.stops.length > 0)) return "Needs a stop";
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

  // Every day arrives with exactly stops−1 legs, whatever it was stored as.
  //
  // A CSV import is a list of stops with NO geometry at all — csv.ts refuses to
  // join them with straight lines, because a distance no motorcycle can ride is
  // worse than no distance. So it lands with N stops and zero legs, which the
  // ride payload rejects on the way back out: `legs must connect consecutive
  // stops`. That never mattered while imported rides could not be opened; the
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
    const want = Math.max(0, day.stops.length - 1);
    if (day.legs.length === want) return;
    // Trim first: more legs than pairs cannot be saved either, and a leg with
    // no pair of stops to connect has nothing to be about.
    day.legs.length = Math.min(day.legs.length, want);
    for (let i = 0; i < want; i++) {
      if (day.legs[i]) continue;
      const a = day.stops[i];
      const b = day.stops[i + 1];
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
      throw new Error((data && data.error) || "no route found (" + res.status + ")");
    }
    return {
      geometry: data.geometry,
      distanceM: data.distanceM,
      durationS: data.durationS,
      viaPoints: vias || [],
    };
  }

  // Recomputes leg i of day r (stops[i] → stops[i+1]).
  function computeLeg(r, i) {
    const day = state.days[r];
    if (!day || !day.stops[i] || !day.stops[i + 1]) return;
    const a = [day.stops[i].lng, day.stops[i].lat];
    const b = [day.stops[i + 1].lng, day.stops[i + 1].lat];
    const vias = (day.legs[i] && day.legs[i].viaPoints) || [];
    day.legs[i] = straightLeg(a, b, vias);
    renderTrack(r);
    refreshDerived();

    // Two stops in the same place have no route between them, and asking is both
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
        console.warn("[builder] directions:", e.message);
        toast("No road route for that leg—drawn straight, its time is estimated", true);
      });
  }

  function computeLegsAround(r, indices) {
    const n = state.days[r].stops.length - 1;
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
      [...m.stops, ...m.pois].forEach(({ el }) => {
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
      m.stops.forEach(({ marker }) => removeMarker(marker));
      m.pois.forEach(({ marker }) => removeMarker(marker));
      // Vias came later than the other two. A kind that renderMarkers creates
      // and this forgets does not error — it just leaves the old handles on the
      // map, so every redraw stacks another set on top of the last.
      (m.vias || []).forEach(({ marker }) => removeMarker(marker));
    });
    state.markers = [];
  }

  function makeStopMarker(r, stop, i) {
    const el = markerElement(stop, state.days[r].color, "stop");
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      // Clicking a marker on a dimmed day makes that day active, so the map's
      // emphasis follows what was just clicked. Every day's rows are on screen
      // now, so this is no longer what makes the row reachable — focusRow scrolls
      // to it either way.
      if (editIndex() !== r) goToDay(r);
      focusRow("stop", i, r);
    });
    const marker = addMarker(state.map, [stop.lng, stop.lat], el, { draggable: true });
    onMarkerDragEnd(marker, ([lng, lat]) => {
      beginEdit("move stop");
      stop.lng = +lng.toFixed(6);
      stop.lat = +lat.toFixed(6);
      // A moved anchor invalidates its shaping points.
      if (state.days[r].legs[i - 1]) state.days[r].legs[i - 1].viaPoints = [];
      if (state.days[r].legs[i]) state.days[r].legs[i].viaPoints = [];
      computeLegsAround(r, [i - 1, i]);
      markDirty();
    });
    return { marker, el };
  }

  function makePoiMarker(r, poi, i) {
    const el = markerElement(poi, state.days[r].color, "poi");
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (editIndex() !== r) goToDay(r);
      focusRow("poi", i, r);
    });
    const marker = addMarker(state.map, [poi.lng, poi.lat], el, { draggable: true });
    onMarkerDragEnd(marker, ([lng, lat]) => {
      beginEdit("move POI");
      poi.lng = +lng.toFixed(6);
      poi.lat = +lat.toFixed(6);
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
      stops: day.stops.map((s, i) => makeStopMarker(r, s, i)),
      pois: day.pois.map((p, i) => makePoiMarker(r, p, i)),
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
  function addStop(lng, lat, name, dayIndex) {
    const r = dayIndex == null ? editIndex() : dayIndex;
    if (r == null || !state.days[r]) return noDayYet();
    const day = state.days[r];
    if (day.stops.length >= MAX_STOPS) return toast("Stop limit reached (" + MAX_STOPS + ")", true);
    beginEdit("add stop");
    day.stops.push({
      lat: +lat.toFixed(6),
      lng: +lng.toFixed(6),
      name: name || "",
      description: "",
      roles: [],
      durationMin: null,
    });
    const n = day.stops.length;
    if (n >= 2) computeLeg(r, n - 2);
    renderMarkers();
    // renderDayList(r), not renderList(): renderList redraws the ACTIVE day, and
    // a search row can add to a day that is not it.
    renderDayList(r);
    refreshDerived();
    markDirty();
  }

  function addPoi(lng, lat, name, dayIndex) {
    const r = dayIndex == null ? editIndex() : dayIndex;
    if (r == null || !state.days[r]) return noDayYet();
    const day = state.days[r];
    if (day.pois.length >= MAX_POIS) return toast("POI limit reached (" + MAX_POIS + ")", true);
    beginEdit("add POI");
    // durationMin present from the start, matching a stop: blank means "rode
    // past", which is the common case, and the field has to exist for the row to
    // round-trip through save and reload.
    day.pois.push({
      lat: +lat.toFixed(6),
      lng: +lng.toFixed(6),
      name: name || "",
      description: "",
      roles: [],
      durationMin: null,
    });
    renderMarkers();
    renderDayList(r);
    markDirty();
  }

  function deleteStop(i) {
    beginEdit("delete stop");
    const r = editIndex();
    if (r == null) return;
    const day = state.days[r];
    day.stops.splice(i, 1);
    // Remove the legs that touched stop i, then bridge the gap (if any).
    if (day.legs.length) {
      const from = Math.max(0, i - 1);
      day.legs.splice(from, i === 0 || i === day.stops.length ? 1 : 2);
      state.legSeq[r] = [];
      if (i > 0 && i < day.stops.length) {
        day.legs.splice(
          from,
          0,
          straightLeg([day.stops[i - 1].lng, day.stops[i - 1].lat], [day.stops[i].lng, day.stops[i].lat]),
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

  function deletePoi(i) {
    beginEdit("delete POI");
    const r = editIndex();
    if (r == null) return;
    state.days[r].pois.splice(i, 1);
    renderMarkers();
    renderList();
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
    const list = kind === "stop" ? day.stops : day.pois;
    const src = list[i];
    if (!src) return;
    const cap = kind === "stop" ? MAX_STOPS : MAX_POIS;
    if (list.length >= cap) return toast((kind === "stop" ? "Stop" : "POI") + " limit reached (" + cap + ")", true);

    beginEdit("duplicate " + kind);
    const copy = { ...src, roles: (src.roles || []).slice() };
    list.splice(i + 1, 0, copy);

    if (kind === "stop") {
      // A stop inserted at i+1 sits on top of its original, so the leg into it
      // is zero length and the one out of it is the original's old leg. Both
      // ends get recomputed rather than guessed.
      day.legs.splice(i, 0, straightLeg([src.lng, src.lat], [src.lng, src.lat]));
      state.legSeq[r] = [];
      computeLegsAround(r, [i - 1, i, i + 1]);
      renderTrack(r);
    }
    renderMarkers();
    renderList();
    refreshDerived();
    markDirty();
  }

  // MOVE a stop to an arbitrary index, which is what a drag produces. moveStop
  // below SWAPS with a neighbor, which is the same thing only for a one-step
  // move — dragging stop 2 to position 5 with a swap would put stop 5 at 2, and
  // that is not what anybody dragging means.
  //
  // Which legs are wrong afterwards: a leg joins consecutive stops, so moving
  // between `from` and `to` invalidates every leg from the one BEFORE the earlier
  // position through the one AT the later position. Worked through on an 8-stop
  // day, 2 -> 5 leaves L0 and L6 untouched and breaks L1..L5, which is exactly
  // [min-1, max]. Recomputing the whole day instead would be correct and would
  // also fire a routing request per leg, which is the half that costs money.
  // Dragging a POI MOVES ITS PIN, and that is the whole difference between the
  // two kinds. A stop carries `position` and its order is stored, so dragging it
  // rewrites that order. A POI does not — ride-graph.ts writes `position: null`
  // for every one and its place in the list is its projected distance along the
  // day's track — so there is nothing for a drag to reorder. Dropping it between
  // two rows therefore relocates it to the road between them, and the projection
  // then puts it exactly where it was dropped.
  //
  // This MOVES A PLACE THE RIDER CHOSE, which is the thing to be careful about:
  // a POI is usually a specific spot, and its coordinates feed the roadbook and
  // every export. It is one undo step, deliberately, so taking it back is one
  // action rather than a hunt for the original position.
  function movePoiToDistance(i, targetM) {
    const r = editIndex();
    if (r == null) return;
    const day = state.days[r];
    if (!day.pois[i]) return;
    const { track } = trackAndSpans(r);
    // No routed geometry means no road to move onto — a day with a single stop,
    // or one whose legs have not come back from the router yet.
    if (track.length < 2) return toast("No route to place it along yet", true);
    const p = window.TBShape.pointAtDistance(track, targetM);
    if (!p) return;

    beginEdit("move POI");
    day.pois[i].lng = +p[0].toFixed(6);
    day.pois[i].lat = +p[1].toFixed(6);
    renderMarkers();
    renderList();
    refreshDerived();
    markDirty();
  }

  function reorderStop(from, to) {
    if (from === to) return;
    const r = editIndex();
    if (r == null) return;
    const day = state.days[r];
    if (from < 0 || from >= day.stops.length || to < 0 || to >= day.stops.length) return;

    beginEdit("move stop");
    const [moved] = day.stops.splice(from, 1);
    day.stops.splice(to, 0, moved);

    const lo = Math.min(from, to) - 1;
    const hi = Math.max(from, to);
    const idx = [];
    for (let k = lo; k <= hi; k++) {
      // Shaping points belong to the pair of stops the leg used to join, so they
      // are meaningless once either end changes. Same reasoning as moveStop.
      if (day.legs[k]) day.legs[k].viaPoints = [];
      idx.push(k);
    }
    computeLegsAround(r, idx);
    renderMarkers();
    renderList();
    refreshDerived();
    markDirty();
  }

  function moveStop(i, dir) {
    beginEdit("move stop");
    const r = editIndex();
    if (r == null) return;
    const day = state.days[r];
    const j = i + dir;
    if (j < 0 || j >= day.stops.length) return;
    const s = day.stops;
    [s[i], s[j]] = [s[j], s[i]];
    // Reordered anchors: recompute every leg touching either position, and drop
    // their shaping points.
    [i - 1, i, j - 1, j].forEach((k) => {
      if (day.legs[k]) day.legs[k].viaPoints = [];
    });
    computeLegsAround(r, [i - 1, i, j - 1, j]);
    renderMarkers();
    renderList();
    markDirty();
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
    const last = prev && prev.stops[prev.stops.length - 1];
    if (last) {
      day.stops.push({
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
    if (day.stops.length < 2) return toast("Nothing to reverse yet", true);

    const legCount = Math.max(0, day.stops.length - 1);
    // "re-routes", not "re-days" — a find-and-replace during the 2026-08-09
    // routes→days rename caught this string, which a rider reads in a dialog.
    if (legCount > 12 && !window.confirm("Reversing re-routes all " + legCount + " legs of this day. Continue?")) return;

    // Every guard and the confirm are behind us, so this is the first point at
    // which the day is certainly going to change.
    beginEdit("reverse day");
    day.stops.reverse();

    // A stop tagged as the start is the finish now. Nothing else about a role
    // has a direction — a gas stop is a gas stop either way round.
    day.stops.forEach((s) => {
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
    const ends = rows.map((r) => {
      const s = state.days[r].stops;
      return s.length ? { first: s[0], last: s[s.length - 1] } : null;
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
        altGroup: null,
        altActive: true,
        stops: src.stops.map((s) => ({ ...s, roles: (s.roles || []).slice() })),
        pois: src.pois.map((p) => ({ ...p, roles: (p.roles || []).slice() })),
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
    // Every stop removed drops the legs either side and re-requests one, so a
    // big selection is real money and a visibly empty map while it runs. Same
    // threshold and same reasoning as reverseDay's confirm.
    const stops = [...byDay.values()].reduce((m, list) => m + list.filter((p) => p.kind === "stop").length, 0);
    if (stops > 12 && !window.confirm("Deleting " + stops + " stops re-routes the legs around each. Continue?")) return;
    beginEdit("delete points");
    for (const [r, list] of byDay) {
      const day = state.days[r];
      if (!day) continue;
      // Already sorted descending by selectedPointsByDay().
      list.forEach((p) => {
        if (p.kind === "stop") day.stops.splice(p.i, 1);
        else day.pois.splice(p.i, 1);
      });
      // Legs are rebuilt wholesale for any day that lost a stop rather than
      // repaired around each removal — with several gone at once there is no
      // "the leg either side" to bridge.
      if (list.some((p) => p.kind === "stop")) {
        day.legs = [];
        state.legSeq[r] = [];
      }
    }
    const touched = [...byDay.keys()];
    endSelect();
    rebuildLayers();
    renderMarkers();
    touched.forEach((r) => {
      const day = state.days[r];
      if (day && day.stops.length >= 2 && day.legs.length === 0) {
        computeLegsAround(r, Array.from({ length: day.stops.length - 1 }, (_, k) => k));
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
        const arr = p.kind === "stop" ? day.stops : day.pois;
        const [pt] = arr.splice(p.i, 1);
        if (pt) moved.push({ kind: p.kind, pt });
      });
      day.legs = [];
      state.legSeq[r] = [];
    }
    // Reversed, because each day's list was spliced descending and the points
    // came off in the opposite order to the one they were in.
    moved.reverse().forEach(({ kind, pt }) => {
      if (kind === "stop") dst.stops.push(pt);
      else dst.pois.push(pt);
    });
    dst.legs = [];
    state.legSeq[toDay] = [];
    const touched = new Set([...byDay.keys(), toDay]);
    endSelect();
    setActive(toDay);
    rebuildLayers();
    renderMarkers();
    touched.forEach((r) => {
      const day = state.days[r];
      if (day && day.stops.length >= 2) {
        computeLegsAround(r, Array.from({ length: day.stops.length - 1 }, (_, k) => k));
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
      // The copy is NOT part of its original's group. A duplicate of one
      // alternate would otherwise silently become a third member of a group the
      // rider has not been asked about.
      altGroup: null,
      altActive: true,
      stops: src.stops.map((s) => ({ ...s, roles: (s.roles || []).slice() })),
      pois: src.pois.map((p) => ({ ...p, roles: (p.roles || []).slice() })),
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

  // <input type="datetime-local"> has no timezone: it reads and writes wall
  // clock, which the platform parses as the builder's own zone. That is the
  // zone we store from, so a ride planned in California reads back in
  // California time even for its Nevada legs. A per-ride timezone is the real
  // fix and is deliberately out of scope here.
  const pad = (n) => String(n).padStart(2, "0");

  function isoToLocalInput(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return (
      d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes())
    );
  }

  function localInputToIso(value) {
    if (!value) return null;
    const d = new Date(value); // no offset in the string—parsed as local time
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // The hour a fresh day is assumed to start. Only ever a seed — the rider
  // edits it, and nothing derives from it beyond the first suggestion.
  const DAY_START_HOUR = 8;

  // Where a new day's start comes from: the first DAY_START_HOUR o'clock
  // strictly after the previous day ends. For a day finishing in the evening
  // that is simply the next morning. Anchoring on the end *instant* rather than
  // on its calendar date also keeps a day that runs past midnight sane — "the
  // morning after the end date" would skip a day for a ride that finishes at
  // 2am, this does not.
  function nextMorningAfter(iso) {
    if (!iso) return null;
    const end = new Date(iso);
    if (Number.isNaN(end.getTime())) return null;
    const start = new Date(end);
    start.setHours(DAY_START_HOUR, 0, 0, 0);
    if (start <= end) start.setDate(start.getDate() + 1);
    return start.toISOString();
  }

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

  // Live POI distances, one array per day, for the time model. The builder's
  // POIs carry no stored distFromStartMi — it does not exist until save — so the
  // timeline would otherwise place every POI at the start of its day.
  const allPoiDists = () => state.days.map((r) => dayPoiDistances(r));

  const activeNow = () =>
    state.moment == null ? null : activeAtMoment(state.days, state.moment, allPoiDists());

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
    const a = activeAtMoment(state.days, state.moment, allPoiDists());
    let what;
    if (a.dayIndex == null) {
      what = "between days";
    } else if (a.legIndex != null) {
      what = dayLabel(a.dayIndex) + " · leg " + (a.legIndex + 1) + " of " + state.days[a.dayIndex].legs.length;
    } else if (a.poiIndex != null) {
      const poi = state.days[a.dayIndex].pois[a.poiIndex];
      what = dayLabel(a.dayIndex) + " · at " + ((poi && poi.name) || "a point of interest");
    } else {
      const stop = a.stopIndex == null ? null : state.days[a.dayIndex].stops[a.stopIndex];
      what = dayLabel(a.dayIndex) + " · at " + ((stop && stop.name) || "stop " + ((a.stopIndex || 0) + 1));
    }
    say(fmtMoment(state.moment) + " · " + what);
  }

  // Moving the timeline is the primary gesture; the day slider follows it so
  // the two controls can never show different days.
  function setMoment(momentS) {
    state.moment = momentS;
    const a = activeAtMoment(state.days, momentS, allPoiDists());
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
  function pointRowHtml(kind, point, i, dayIndex) {
    const isStop = kind === "stop";
    return (
      '<li class="point-row" data-kind="' + kind + '" data-i="' + i + '" data-day="' + dayIndex + '">' +
      '<div class="row-main">' +
      '<span class="row-drag" title="' +
      (isStop ? "Drag to reorder" : "Drag to move it along the route") +
      '" aria-hidden="true"></span>' +
      // THE CHECKBOX REPLACES THE NUMBER rather than joining it. A 380px row has
      // no spare width and .row-name is already the thing that shrinks; the stop
      // number is the one element that is redundant while you are ticking boxes,
      // because ticking is what you are doing rather than reading an order. It
      // comes straight back when select mode ends.
      (state.select?.scope === "point"
        ? '<input type="checkbox" class="row-pick" data-day="' + dayIndex + '" data-kind="' + kind + '" data-i="' + i + '"' +
          (state.select.points.has(pointKey(dayIndex, kind, i)) ? " checked" : "") +
          ' aria-label="Select ' + (isStop ? "stop " + (i + 1) : "POI") + '">'
        : isStop
          ? '<span class="row-num">' + (i + 1) + "</span>"
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
      (roleIconsHtml(point) || '<span class="role-add">+</span>') + "</button>" +
      '<span class="row-actions">' +
      // U+22EE, the VERTICAL ellipsis, not U+22EF. It is the same control and
      // roughly a third of the width, which on a 320px row is width the name
      // field gets instead.
      '<button type="button" class="row-menu-btn" title="More" aria-label="More actions for this ' +
      (isStop ? "stop" : "POI") + '" aria-haspopup="menu" aria-expanded="false">⋮</button>' +
      "</span></div>" +
      '<div class="row-roles" hidden>' + rolePickerHtml(point) + "</div>" +
      '<textarea class="row-desc" name="' + kind + '-notes-' + i + '" maxlength="2000" placeholder="Notes (optional)"' +
      (point.description ? "" : " hidden") + ">" + esc(point.description) + "</textarea>" +
      "</li>"
    );
  }

  // Reads the row's OWN day, not the active one. Those are the same thing by the
  // time a handler runs — every listener calls setActiveFromEl first — but
  // relying on that ordering would make this quietly wrong the first time
  // something read a row without having clicked it.
  function pointOf(row) {
    const i = Number(row.dataset.i);
    const day = state.days[Number(row.dataset.day)];
    if (!day) return null;
    return row.dataset.kind === "stop" ? day.stops[i] : day.pois[i];
  }

  // Stops and POIs in the order you would meet them, which is the order the day
  // actually happens in.
  //
  // They were two lists before, POIs below the stops, which said a POI came
  // after every stop — it does not, it sits between two of them. Stops carry
  // their position; POIs are placed by projecting them onto the day's track (see
  // dayPoiDistances), so a POI 40 miles in lands between the stops at 30 and
  // 60.
  //
  // The two index spaces stay separate: a row keeps `data-kind` and its index
  // within its own array, so pointOf(), moveStop() and deleteStop() are
  // unchanged by the merge. Stops keep their numbers and POIs keep the dot, so
  // the distinction survives being interleaved.
  function orderedRows(day) {
    const prefix = [0];
    for (const l of day.legs) prefix.push(prefix[prefix.length - 1] + (l.distanceM || 0));
    const rows = day.stops.map((s, i) => ({
      kind: "stop",
      point: s,
      i,
      // A stop with no leg after it (the last one) reuses the final prefix.
      dist: prefix[Math.min(i, prefix.length - 1)],
    }));
    const poiDists = dayPoiDistances(day);
    day.pois.forEach((p, i) => {
      rows.push({ kind: "poi", point: p, i, dist: poiDists[i] ?? 0 });
    });
    // Stable ties broken toward the stop: arriving somewhere is the anchor, and
    // a POI at the same spot reads as being *at* that stop rather than before it.
    rows.sort((a, b) => a.dist - b.dist || (a.kind === b.kind ? a.i - b.i : a.kind === "stop" ? -1 : 1));
    return rows;
  }

  // One day's rows. Takes the day index rather than reading the active one,
  // because every day's list is on screen and any of them can need redrawing.
  function renderDayList(r) {
    const list = document.querySelector('.point-list[data-day="' + r + '"]');
    if (!list) return;
    const day = state.days[r];
    if (!day) return;
    list.innerHTML =
      orderedRows(day)
        .map((row) => pointRowHtml(row.kind, row.point, row.i, r))
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
  // its own `data-day` and passes it to addStop/addPoi.
  //
  // Rendered on every day whether or not it has points, so it is also the empty
  // state; the `.empty-hint` li it replaced said "click the map or search to
  // add your first stop" while pointing at neither.
  //
  // NOT a .point-row: it has no point behind it, and wireList()'s handlers all
  // resolve a row to `state.days[day].stops[i]`. SortableJS is also told to
  // leave it alone — see the filter option in initDragToReorder.
  function addRowHtml(r, day) {
    const full = day.stops.length >= MAX_STOPS;
    return (
      '<li class="add-row" data-day="' + r + '">' +
      '<span class="add-row-mark" aria-hidden="true">+</span>' +
      '<input class="add-search" type="text" autocomplete="off" spellcheck="false"' +
      ' placeholder="' + (full ? "Stop limit reached" : "Search, or click the map") + '"' +
      (full ? " disabled" : "") +
      ' aria-label="Add a place to ' + esc(dayLabel(r)) + '">' +
      // The kind is chosen HERE rather than by the panel-wide + Stop / + POI
      // pair, because that pair belongs to the map click and a searched address
      // is a different gesture. Two radios rather than a select: there are two
      // options and they are both one word.
      '<span class="add-kind" role="group" aria-label="What to add">' +
      '<label><input type="radio" name="add-kind-' + r + '" value="stop" checked><span>Stop</span></label>' +
      '<label><input type="radio" name="add-kind-' + r + '" value="poi"><span>POI</span></label>' +
      "</span>" +
      "</li>"
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
    const anyStops = state.days.some((r) => r.stops.length > 0);
    if (!anyStops) {
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
      (t.meters / MILE).toFixed(1) + " mi · " + (t.estimated ? "~" : "") + hm(t.riding) + " riding" +
      (t.twist ? " · " + twistLabel(t.twist.dpm) + (withLink ? faqLink("twistiness", "twistiness") : "") : "");

    // The label alone on the line; the numbers behind it on hover. "252°/mi"
    // means nothing to a rider, but it is the thing to check when the label
    // looks wrong, so it should be reachable without being in the way.
    const twistTitle = (t) => {
      if (!t.twist) return "";
      let s = t.twist.dpm + "°/mi of heading change";
      // Only worth saying when the best stretch is meaningfully better than the
      // day as a whole. On a uniformly twisty day it is the same number twice.
      if (t.twist.bestDpm && t.twist.bestDpm > t.twist.dpm * 1.25) {
        s += ", best " + t.twist.bestMiles + " mi at " + t.twist.bestDpm;
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
        if (act === "duplicate") return duplicatePoint(row.dataset.kind, i);
        if (act === "delete") return isStop ? deleteStop(i) : deletePoi(i);
        if (act === "up") return moveStop(i, -1);
        if (act === "down") return moveStop(i, 1);
        if (act === "select") return startSelect("point");
        return;
      }
      if (btn.classList.contains("row-roles-btn")) {
        closeRowMenu();
        row.querySelector(".row-roles").hidden = !row.querySelector(".row-roles").hidden;
        return;
      }
      if (btn.classList.contains("role-opt")) {
        const role = btn.dataset.role;
        beginEdit("change category");
        const idx = point.roles.indexOf(role);
        if (idx >= 0) point.roles.splice(idx, 1);
        else if (point.roles.length < 4) point.roles.push(role);
        else return toast("Up to 4 categories per point", true);
        btn.classList.toggle("on");
        btn.setAttribute("aria-pressed", String(point.roles.includes(role)));
        const rolesBtn = row.querySelector(".row-roles-btn");
        rolesBtn.innerHTML = roleIconsHtml(point) || '<span class="role-add">+</span>';
        rolesBtn.title = roleTitle(point);
        hydrateIcons(rolesBtn);
        renderMarkers();
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
    { act: "duplicate", label: "Duplicate" },
    { act: "select", label: "Select points…" },
    { act: "up", label: "Move up", stopOnly: true },
    { act: "down", label: "Move down", stopOnly: true },
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
    const isStop = row.dataset.kind === "stop";
    const i = Number(row.dataset.i);
    const day = editRoute();
    const last = isStop && day ? day.stops.length - 1 : 0;
    // Disabled rather than absent at the ends, so the first stop's menu is the
    // same shape as every other one.
    const items = MENU_ITEMS.filter((m) => !m.stopOnly || isStop).map((m) => ({
      ...m,
      off: (m.act === "up" && i === 0) || (m.act === "down" && i === last),
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
      draggable: ".point-row",
      filter: ".add-row",
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
        // A DRAG THAT ENDED WHERE IT STARTED IS NOT AN EDIT. Sortable fires
        // onEnd for every drop, including one that changed nothing — picking a
        // row up and putting it back. For a stop that was harmless, since
        // reorderStop no-ops on from === to. For a POI it was not: the handler
        // below reads the rows it landed BETWEEN and moves the pin to the middle
        // of them, so lifting a POI and dropping it in place relocated it to the
        // midpoint of its neighbors. Observed, not theorized.
        if (evt.oldIndex === evt.newIndex) return;

        const i = Number(evt.item.dataset.i);

        if (evt.item.dataset.kind === "stop") {
          // Stops carry a stored order, so the drop is a reorder. Reading the
          // DOM order of the stop rows and taking their data-i sidesteps the
          // interleaving with POIs entirely — Sortable's own indices count all
          // children and mean nothing here.
          const order = [...evt.to.querySelectorAll('.point-row[data-kind="stop"]')].map((el) => Number(el.dataset.i));
          const to = order.indexOf(i);
          if (to < 0 || to === i) return;
          return reorderStop(i, to);
        }

        // A POI has no order to change, so the drop is a position. Its target
        // distance is read from the rows it landed BETWEEN, using the distances
        // orderedRows() already computed for this render.
        const dists = new Map();
        for (const row of orderedRows(day)) dists.set(row.kind + ":" + row.i, row.dist);
        const at = (el) => (el ? dists.get(el.dataset.kind + ":" + el.dataset.i) : undefined);

        const rows = [...evt.to.querySelectorAll(".point-row")];
        const pos = rows.indexOf(evt.item);
        const before = at(rows[pos - 1]);
        const after = at(rows[pos + 1]);

        let target;
        if (before == null && after == null) return; // dropped alone; nothing to sit between
        else if (before == null) target = after / 2; // above every other row
        else if (after == null) target = Infinity; // below every other row—clamped to the end
        else target = (before + after) / 2;
        movePoiToDistance(i, target);
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

    const kind = evt.item.dataset.kind;
    const i = Number(evt.item.dataset.i);

    beginEdit("move " + (kind === "stop" ? "stop" : "POI") + " between days");

    if (kind === "poi") {
      const [poi] = src.pois.splice(i, 1);
      if (!poi) return;
      // A POI's distance along the track belongs to the day it was measured on
      // and means nothing on another one. Null is honest — "near this day's
      // route, position not measured" — and is exactly what an import with no
      // track stores. See the null-is-not-zero note in AGENTS.md.
      poi.distFromStartMi = null;
      dst.pois.push(poi);
    } else {
      const [stop] = src.stops.splice(i, 1);
      if (!stop) return;
      // Where it landed among the DESTINATION's stops, read from the DOM the
      // same way the same-day branch does — the rows it sits between are the
      // answer, whatever POIs are interleaved with them.
      const order = [...evt.to.querySelectorAll('.point-row[data-kind="stop"]')];
      const at = Math.max(0, Math.min(dst.stops.length, order.indexOf(evt.item)));
      dst.stops.splice(at, 0, stop);
      src.legs = [];
      dst.legs = [];
      state.legSeq[fromDay] = [];
      state.legSeq[toDay] = [];
    }

    // Rebuilt rather than patched: both lists have shifted indices, and every
    // row's data-i has to agree with the arrays again before any later handler
    // reads one.
    renderDays();
    rebuildLayers();
    renderMarkers();
    if (kind === "stop") {
      computeLegsAround(fromDay, Array.from({ length: Math.max(0, src.stops.length - 1) }, (_, k) => k));
      computeLegsAround(toDay, Array.from({ length: Math.max(0, dst.stops.length - 1) }, (_, k) => k));
    }
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

    // Delegated on #day-list, because renderDays() replaces every one of these
    // fields on any structural change. Binding per input would either be lost
    // on the next render or leak a listener per render.
    host.addEventListener("input", (e) => {
      const input = e.target.closest(".add-search");
      if (!input) return;
      const day = Number(input.closest(".add-row").dataset.day);
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (q.length < 3) {
        hideSearchResults();
        return;
      }
      searchTimer = setTimeout(async () => {
        // Predictions come back out of order often enough to matter; a slow
        // early keystroke must not overwrite a fast later one.
        const mine = ++searchSeq;
        try {
          const hits = await searchPlaces(state.map, q);
          if (mine !== searchSeq) return;
          // The rows may have been rebuilt out from under this response, in
          // which case the field it was for no longer exists.
          if (!input.isConnected) return;
          results.dataset.day = String(day);
          results.innerHTML = hits
            .map(
              (h, i) =>
                '<li data-i="' + i + '"><strong>' + esc(h.name) + "</strong> " +
                '<span class="hit-ctx">' + esc(h.context) + "</span></li>",
            )
            .join("");
          results.hidden = hits.length === 0;
          if (!results.hidden) placeResults(input, results);
          results.querySelectorAll("li").forEach((li) => {
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
              const kindEl = document.querySelector('.add-row[data-day="' + r + '"] .add-kind input:checked');
              const asPoi = kindEl && kindEl.value === "poi";
              hideSearchResults();
              // The day whose row was used becomes the active one, so a map
              // click afterwards continues where the rider is working rather
              // than wherever they last clicked.
              setActive(r);
              if (asPoi) addPoi(lng, lat, picked.name, r);
              else addStop(lng, lat, picked.name, r);
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
          console.warn("[builder] search:", e);
        }
      }, 300);
    });

    // Escape dismisses the suggestions without clearing the query — the rider
    // may have meant to close the list, not to start over.
    host.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && resultsEl && !resultsEl.hidden && e.target.closest(".add-search")) {
        e.stopPropagation();
        hideSearchResults();
      }
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".add-row") && !e.target.closest("#search-results")) hideSearchResults();
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
            day.stops.forEach((_, i) => sel.points.add(pointKey(r, "stop", i)));
            day.pois.forEach((_, i) => sel.points.add(pointKey(r, "poi", i)));
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
      title: state.meta.title,
      description: state.meta.description,
      visibility: state.meta.visibility,
      external_url: state.meta.external_url,
      // The API requires at least one stop per day, so a day you added but
      // never filled in would fail validation for the whole ride. Dropping it
      // is what the rider means; save() warns when it happens.
      days: state.days
        .filter((r) => r.stops.length > 0)
        .map((r) => ({
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
          stops: r.stops,
          pois: r.pois,
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

  // The link to the public page, revealed once and never hidden again. It is
  // rendered from the start and only made visible here — see the markup comment
  // in src/routes/builder.ts for why it is `visibility` and not `hidden`.
  function showViewLink(slug) {
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
    };
    // Every day loads. This used to take days[0] and warn that saving would
    // drop the rest, which made multi-day rides effectively read-only.
    state.days = (ride.days || []).map((r, i) => ({
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
      stops: r.stops || [],
      pois: r.pois || [],
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
    const shared = state.meta.visibility === "public" || state.meta.visibility === "unlisted";
    const start = window.TB.publicStart;
    const day = state.days[0];
    const first = day && day.stops[0];
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
    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.addMode = btn.dataset.mode;
      });
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
      pts.push(...fullTrack(r));
      [...day.stops, ...day.pois].forEach((p) => pts.push([p.lng, p.lat]));
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
  function offerRecovery() {
    const d = HIST.Draft.read(state.rideId);
    if (!d) return;
    const bar = $("recover-bar");
    const mins = Math.max(1, Math.round((Date.now() - (d.savedAt || 0)) / 60000));
    $("recover-text").textContent =
      "Unsaved changes from " + (mins < 60 ? mins + " minute" + (mins === 1 ? "" : "s") : "over an hour") + " ago. ";
    bar.hidden = false;
    $("recover-yes").addEventListener("click", () => {
      beginEdit("restore draft");
      state.meta = { ...d.meta };
      state.days = d.days.map((r) => ({ ...r, legs: (r.legs || []).map((l) => ({ ...l, geometry: [] })) }));
      state.legSeq = [];
      renderEverything();
      bar.hidden = true;
      // Geometry is not in the draft — the router rebuilds it. Stops are what
      // could not have been recovered from anywhere else.
      state.days.forEach((_, r) =>
        computeLegsAround(
          r,
          Array.from({ length: Math.max(0, state.days[r].stops.length - 1) }, (_, i) => i),
        ),
      );
      markDirty();
      toast("Unsaved changes restored");
    });
    $("recover-no").addEventListener("click", () => {
      HIST.Draft.clear(state.rideId);
      bar.hidden = true;
    });
  }

  async function init() {
    if (!window.TB.gmapsKey || !window.TB.mapId) {
      document.body.insertAdjacentHTML(
        "afterbegin",
        '<div class="tb-banner">Maps are not configured—set GMAPS_KEY and GMAPS_MAP_ID and restart.</div>',
      );
      return;
    }
    wireMeta();
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
    if (window.TB.home && !state.rideId && state.days[0].stops.length === 0) {
      addStop(window.TB.home.lng, window.TB.home.lat, "Home");
      state.days[0].stops[0].roles = ["home"];
    }

    rebuildLayers();
    renderMarkers();
    renderDays();
    refreshDerived();
    const all = allTrackPoints();
    if (all.length) fitTo(state.map, all);
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
      if (state.addMode === "poi") addPoi(lng, lat, "");
      else addStop(lng, lat, "");
    });
  }

  init();
})();
