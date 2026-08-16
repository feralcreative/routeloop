// The ride builder. State mirrors the /api/rides payload: ride meta plus an
// ordered array of days, each a day/session of ordered stops, unordered POIs,
// and road-routed legs (legs[i] connects stops[i] → stops[i+1]).
//
// Every day is drawn on the map at once, always. The day slider changes which
// one is emphasised and never hides anything — seeing the whole ride on a single
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

  initPanelToggle();

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
  // window.TB.roles carries the role table. The importer colours the days of a
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

  const newDay = (color) => ({
    title: "",
    color: color || DAY_COLORS[0],
    startAt: null,
    endAt: null,
    // Session-only: see inferEndManual(). Never part of payload().
    endManual: false,
    stops: [],
    pois: [],
    legs: [],
  });

  const state = {
    map: null,
    rideId: window.TB.rideId || null,
    meta: { title: "", description: "", visibility: "private", external_url: "" },
    days: [newDay()],
    // Slider position: 0 means "all days", 1..N focuses that day. It is the
    // slider's value directly, so the two can never disagree.
    focus: 0,
    // The timeline's position, in epoch seconds, or null for "no moment
    // chosen". When it is set it is the single source of what is emphasised:
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
  };

  const $ = (id) => document.getElementById(id);

  // Which day edits land on, or null for "none — the rider is looking at the
  // whole ride".
  //
  // This used to return `state.days.length - 1` on "All", so edits silently
  // landed on the LAST day for no stated reason and with no control that
  // changed it. The panel announced "All days · editing Day 4" as though that
  // had been asked for. The slider is the only control here, so it decides one
  // thing: which day you are working on. "All" is a view.
  //
  // The single-day case is the exception and not a special case: with one day,
  // "All" and "Day 1" are the same view of the same thing, and renderSlider
  // already disables the slider below two days.
  const editIndex = () => (state.focus === 0 ? (state.days.length > 1 ? null : 0) : state.focus - 1);
  const focusedIndex = () => (state.focus === 0 ? null : state.focus - 1);
  const editRoute = () => {
    const r = editIndex();
    return r == null ? null : state.days[r];
  };

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
  // keyboard shortcut, a double-click landing after the slider moved. The real
  // defence is that these controls are inert on "All"; this is the backstop that
  // says why rather than doing nothing.
  function pickADayFirst() {
    toast("Pick a day on the slider first", true);
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
    renderSlider();
    renderDayHead();
    renderList();
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
    renderEverything();
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
    // The straight leg above is already the right answer: zero metres, zero
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

  // The only thing focus does. Every day stays on the map; the unfocused ones
  // are dimmed, and "all days" (focus 0) dims nothing.
  //
  // With a moment chosen the timeline decides instead of the day slider: the
  // day containing it stays lit and the leg being ridden at it is drawn over
  // the top. A moment in the overnight gap belongs to no day, so everything
  // dims and no leg is drawn — which is what "nobody is riding right now"
  // honestly looks like.
  function applyFocus() {
    if (!state.map) return;
    const a = activeNow();
    const lit = a ? a.dayIndex : focusedIndex();
    state.days.forEach((_, r) => {
      const dim = a ? r !== lit : lit !== null && r !== lit;
      setRouteDim(state.map, r, dim);
      const m = state.markers[r];
      if (!m) return;
      [...m.stops, ...m.pois].forEach(({ el }) => {
        el.style.opacity = dim ? "0.35" : "";
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
      // Clicking a marker on a dimmed day focuses that day — otherwise the row
      // it scrolls to would not be in the visible list.
      if (editIndex() !== r) setFocus(r + 1);
      focusRow("stop", i);
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
      if (editIndex() !== r) setFocus(r + 1);
      focusRow("poi", i);
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

  function addStop(lng, lat, name) {
    beginEdit("add stop");
    const r = editIndex();
    if (r == null) return pickADayFirst();
    const day = state.days[r];
    if (day.stops.length >= MAX_STOPS) return toast("Stop limit reached (" + MAX_STOPS + ")", true);
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
    renderList();
    refreshDerived();
    markDirty();
  }

  function addPoi(lng, lat, name) {
    beginEdit("add POI");
    const r = editIndex();
    if (r == null) return pickADayFirst();
    const day = state.days[r];
    if (day.pois.length >= MAX_POIS) return toast("POI limit reached (" + MAX_POIS + ")", true);
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
    renderList();
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
    if (r == null) return pickADayFirst();
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
  // below SWAPS with a neighbour, which is the same thing only for a one-step
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

  function setFocus(v) {
    state.focus = Math.max(0, Math.min(state.days.length, v));
    $("day-slider").value = String(state.focus);
    // Picking a day picks that day's opening moment, so the timeline follows
    // rather than competing. "All days" and any undated day mean no moment at
    // all, which is what an undated ride uses throughout.
    const day = state.focus === 0 ? null : state.days[state.focus - 1];
    state.moment = day ? dayStartS(day) : null;
    applyFocus();
    renderDayHead();
    renderList();
    refreshDerived();
  }

  function addDay() {
    beginEdit("add day");
    if (state.days.length >= MAX_DAYS) return toast("Day limit reached (" + MAX_DAYS + ")", true);
    const prev = state.days[state.days.length - 1];
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
    renderSlider();
    setFocus(state.days.length); // focus the new day
    rebuildLayers();
    renderMarkers();
    markDirty();
  }

  function deleteDay() {
    beginEdit("delete day");
    if (state.days.length <= 1) return toast("A ride needs at least one day", true);
    const r = editIndex();
    if (r == null) return pickADayFirst();
    state.days.splice(r, 1);
    state.legSeq.splice(r, 1);
    renderSlider();
    setFocus(Math.min(state.focus, state.days.length));
    rebuildLayers();
    renderMarkers();
    renderList();
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
    beginEdit("reverse day");
    const r = editIndex();
    if (r == null) return pickADayFirst();
    const day = state.days[r];
    if (day.stops.length < 2) return toast("Nothing to reverse yet", true);

    const legCount = Math.max(0, day.stops.length - 1);
    if (legCount > 12 && !window.confirm("Reversing re-days all " + legCount + " legs of this day. Continue?")) return;

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

  function moveDay(dir) {
    beginEdit("move day");
    const r = editIndex();
    if (r == null) return pickADayFirst();
    const j = r + dir;
    if (j < 0 || j >= state.days.length) return;
    const a = state.days;
    [a[r], a[j]] = [a[j], a[r]];
    const s = state.legSeq;
    [s[r], s[j]] = [s[j] || [], s[r] || []];
    setFocus(j + 1);
    rebuildLayers();
    renderMarkers();
    renderList();
    markDirty();
  }

  function dayLabel(r) {
    const day = state.days[r];
    return day.title || "Day " + (r + 1);
  }

  function renderSlider() {
    const slider = $("day-slider");
    slider.max = String(state.days.length);
    if (Number(slider.value) > state.days.length) slider.value = String(state.days.length);
    // A single day has nothing to scrub between; the slider stays but goes
    // inert rather than disappearing and reflowing the panel on the second day.
    slider.disabled = state.days.length < 2;
    // --pos is the tick's fraction of the slider's range, which the stylesheet
    // turns into the point the thumb reaches at that value. Sent from here
    // because only this side knows the day count.
    const span = state.days.length; // slider runs 0..span
    const tick = (label, pos, color) =>
      '<span class="day-tick" style="--pos:' + pos + (color ? ";--tick-color:" + esc(color) : "") + '">' + label + "</span>";
    $("day-ticks").innerHTML =
      tick("All", 0) + state.days.map((day, r) => tick(String(r + 1), (r + 1) / span, day.color)).join("");
  }

  // Shows or hides everything that belongs to one day, in one place, so the
  // panel cannot end up half in each state.
  //
  // On "All" with several days there is no day to edit, so the day controls, the
  // times, the search box and the point list all go and a single line takes
  // their place. Nothing is disabled-but-visible here: unlike the sliders, these
  // are not controls whose absence would reflow anything the rider is aiming at.
  function renderDayEditing() {
    const editing = editIndex() != null;
    $("day-band").hidden = !editing;
    $("day-pick-hint").hidden = editing;
    // Adding by map click needs a day to add to, so the mode buttons say so
    // rather than accepting a click that would have to be refused.
    document.querySelectorAll(".mode-btn").forEach((b) => {
      b.disabled = !editing;
    });
  }

  function renderDayHead() {
    const r = editIndex();
    $("day-label").textContent = r == null ? "All days" : dayLabel(r);
    renderDayEditing();
    if (r == null) return;

    const day = state.days[r];
    // The band's accent and every role icon inside it read this. The icons are
    // SVGs whose disc is fill="currentColor", so tinting them is a matter of
    // setting `color` on an ancestor — no per-icon work, and it follows the
    // colour picker live because this runs on its input event.
    $("day-band").style.setProperty("--day-color", day.color);
    const head = $("day-head");
    // Still hidden for a lone untitled day: there is nothing to reorder, delete
    // or distinguish, so the controls would be four disabled buttons.
    head.hidden = state.days.length < 2 && !day.title;
    $("day-color").value = day.color;
    $("day-title").value = day.title;
    $("day-up").disabled = r === 0;
    $("day-down").disabled = r === state.days.length - 1;
    $("day-del").disabled = state.days.length <= 1;
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
    // A moment between days leaves the day slider where it was — there is no
    // day to move it to, and snapping it somewhere arbitrary would be a lie.
    if (a.dayIndex != null) {
      state.focus = a.dayIndex + 1;
      $("day-slider").value = String(state.focus);
    }
    applyFocus();
    renderDayHead();
    renderList();
    refreshDerived();
  }

  function renderTimes() {
    const day = editRoute();
    if (!day) return; // the times block is hidden on "All"
    const start = $("day-start");
    const end = $("day-end");
    const note = $("day-times-note");

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
  function pointRowHtml(kind, point, i) {
    const isStop = kind === "stop";
    return (
      '<li class="point-row" data-kind="' + kind + '" data-i="' + i + '">' +
      '<div class="row-main">' +
      '<span class="row-drag" title="' +
      (isStop ? "Drag to reorder" : "Drag to move it along the route") +
      '" aria-hidden="true"></span>' +
      (isStop ? '<span class="row-num">' + (i + 1) + "</span>" : '<span class="row-num poi-dot"></span>') +
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

  function pointOf(row) {
    const i = Number(row.dataset.i);
    const day = editRoute();
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

  function renderList() {
    const list = $("stop-list");
    const day = editRoute();
    // Nothing to list on "All". renderDayEditing() has already hidden this, but
    // leaving the last day's stops in the DOM behind it would make the next
    // render flash the wrong day's rows.
    if (!day) {
      list.innerHTML = "";
      return;
    }
    if (day.stops.length === 0 && day.pois.length === 0) {
      list.innerHTML = '<li class="empty-hint">Click the map or search to add your first stop.</li>';
      return;
    }
    list.innerHTML = orderedRows(day)
      .map((r) => pointRowHtml(r.kind, r.point, r.i))
      .join("");
    hydrateIcons(list);
  }

  function focusRow(kind, i) {
    const row = document.querySelector('.point-row[data-kind="' + kind + '"][data-i="' + i + '"]');
    if (!row) return;
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

    if (state.days.length === 1) {
      const t = routeTotals(state.days[0]);
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
    // Twistiness across days is a distance-weighted mean, not an average of the
    // days' figures: it is degrees over miles, so the ride's value is the sum of
    // the degrees over the sum of the miles. Averaging the per-day numbers would
    // let a 30-mile breakfast ride count as much as a 300-mile transit day.
    const ride = state.days.reduce(
      (acc, r) => {
        const t = routeTotals(r);
        return {
          meters: acc.meters + t.meters,
          riding: acc.riding + t.riding,
          stopped: acc.stopped + t.stopped,
          estimated: acc.estimated || t.estimated,
          twistDeg: acc.twistDeg + (t.twist ? (t.twist.dpm * t.meters) / MILE : 0),
          twistMeters: acc.twistMeters + (t.twist ? t.meters : 0),
          // The ride's best stretch is the best any single day has, not a sum:
          // "somewhere in this ride there are twenty miles like that".
          twistBest: Math.max(acc.twistBest, (t.twist && t.twist.bestDpm) || 0),
          twistBestMiles: t.twist && t.twist.bestDpm > acc.twistBest ? t.twist.bestMiles : acc.twistBestMiles,
        };
      },
      { meters: 0, riding: 0, stopped: 0, estimated: false, twistDeg: 0, twistMeters: 0, twistBest: 0, twistBestMiles: 0 },
    );
    ride.twist =
      ride.twistMeters > 0
        ? {
            dpm: Math.round(ride.twistDeg / (ride.twistMeters / MILE)),
            bestDpm: ride.twistBest,
            bestMiles: ride.twistBestMiles,
          }
        : null;
    // The per-day line only exists when a day is selected. On "All" the ride
    // figures stand alone, which is exactly what "All" means.
    const r = editIndex();
    const dayT = r == null ? null : routeTotals(state.days[r]);
    totalsEl.title = "";
    totalsEl.innerHTML =
      '<span class="totals-ride" title="' + esc(twistTitle(ride)) + '">' +
      state.days.length + " days · " + line(ride, true) + "</span>" +
      (dayT
        ? '<span class="totals-day" title="' + esc(twistTitle(dayT)) + '">' +
          esc(dayLabel(r)) + ": " + line(dayT, false) + "</span>"
        : "");
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

  // --- The row menu ---------------------------------------------------------
  //
  // BUILT ON OPEN, NEVER PER ROW, and that is the constraint rather than a
  // preference. The role picker already renders 17 buttons for every point —
  // 119 nodes in the DOM at seven stops and 340 at twenty — and a second eager
  // per-row menu would repeat that mistake exactly. One menu element exists at a
  // time, for the row that asked for it.
  //
  // It is absolutely positioned inside the row, so opening it moves nothing: an
  // inline menu would push every row below it, which is the jump this whole epic
  // is about.
  //
  // Move up / Move down live here as well as on the drag handle. They are not
  // redundant — a drag handle cannot be operated from a keyboard, and they are
  // also what still works if the SortableJS CDN fails.
  const MENU_ITEMS = [
    { act: "notes", label: "Edit notes" },
    { act: "duplicate", label: "Duplicate" },
    { act: "up", label: "Move up", stopOnly: true },
    { act: "down", label: "Move down", stopOnly: true },
    { act: "delete", label: "Delete", danger: true },
  ];

  function closeRowMenu() {
    const open = document.querySelector(".row-menu");
    if (open) {
      const btn = open.closest(".point-row")?.querySelector(".row-menu-btn");
      if (btn) btn.setAttribute("aria-expanded", "false");
      open.remove();
    }
  }

  function toggleRowMenu(row, btn) {
    const wasOpen = !!row.querySelector(".row-menu");
    closeRowMenu();
    if (wasOpen) return;

    const isStop = row.dataset.kind === "stop";
    const i = Number(row.dataset.i);
    const day = editRoute();
    const last = isStop && day ? day.stops.length - 1 : 0;

    const menu = document.createElement("div");
    menu.className = "row-menu";
    menu.setAttribute("role", "menu");
    menu.innerHTML = MENU_ITEMS.filter((m) => !m.stopOnly || isStop)
      .map((m) => {
        // Disabled rather than absent, so the menu is the same shape every time
        // and the first stop's menu does not read as a different menu.
        const off = (m.act === "up" && i === 0) || (m.act === "down" && i === last);
        return (
          '<button type="button" role="menuitem" class="row-menu-item' + (m.danger ? " is-danger" : "") + '"' +
          ' data-act="' + m.act + '"' + (off ? " disabled" : "") + ">" + esc(m.label) + "</button>"
        );
      })
      .join("");
    row.appendChild(menu);
    btn.setAttribute("aria-expanded", "true");
    const first = menu.querySelector(".row-menu-item:not([disabled])");
    if (first) first.focus();
  }

  // Anywhere else, or Escape. Registered once rather than per menu, so an open
  // menu never outlives the render that replaced its row.
  function wireRowMenuDismiss() {
    document.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".row-menu") && !e.target.closest(".row-menu-btn")) closeRowMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const open = document.querySelector(".row-menu");
      if (!open) return;
      const btn = open.closest(".point-row")?.querySelector(".row-menu-btn");
      closeRowMenu();
      if (btn) btn.focus();
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
    window.Sortable.create(listEl, {
      draggable: ".point-row",
      handle: ".row-drag",
      animation: 150,
      ghostClass: "is-dragging",
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
      onEnd: (evt) => {
        const day = editRoute();
        if (!day) return;
        // A DRAG THAT ENDED WHERE IT STARTED IS NOT AN EDIT. Sortable fires
        // onEnd for every drop, including one that changed nothing — picking a
        // row up and putting it back. For a stop that was harmless, since
        // reorderStop no-ops on from === to. For a POI it was not: the handler
        // below reads the rows it landed BETWEEN and moves the pin to the middle
        // of them, so lifting a POI and dropping it in place relocated it to the
        // midpoint of its neighbours. Observed, not theorised.
        if (evt.oldIndex === evt.newIndex) return;

        const i = Number(evt.item.dataset.i);

        if (evt.item.dataset.kind === "stop") {
          // Stops carry a stored order, so the drop is a reorder. Reading the
          // DOM order of the stop rows and taking their data-i sidesteps the
          // interleaving with POIs entirely — Sortable's own indices count all
          // children and mean nothing here.
          const order = [...listEl.querySelectorAll('.point-row[data-kind="stop"]')].map((el) => Number(el.dataset.i));
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

        const rows = [...listEl.querySelectorAll(".point-row")];
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

  function wireSearch() {
    const input = $("search");
    const results = $("search-results");

    // A fixed dropdown does not travel with the field, so anything that moves
    // the field dismisses it rather than leaving it stranded. Scrolling the
    // panel is the case that actually happens; the map page itself never
    // scrolls, so a resize is the only other way the field moves.
    const wrapper = document.querySelector(".panel-contents-wrapper");
    const dismiss = () => {
      if (!results.hidden) results.hidden = true;
    };
    if (wrapper) wrapper.addEventListener("scroll", dismiss, { passive: true });
    window.addEventListener("resize", dismiss);

    input.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (q.length < 3) {
        results.hidden = true;
        return;
      }
      searchTimer = setTimeout(async () => {
        // Predictions come back out of order often enough to matter; a slow
        // early keystroke must not overwrite a fast later one.
        const mine = ++searchSeq;
        try {
          const hits = await searchPlaces(state.map, q);
          if (mine !== searchSeq) return;
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
              if (state.addMode === "poi") addPoi(lng, lat, picked.name);
              else addStop(lng, lat, picked.name);
              panTo(state.map, picked.lngLat, 11);
              input.value = "";
              results.hidden = true;
            });
          });
        } catch (e) {
          console.warn("[builder] search:", e);
        }
      }, 300);
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-wrap")) results.hidden = true;
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
      stops: r.stops || [],
      pois: r.pois || [],
      legs: r.legs || [],
    }));
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

  function wireDays() {
    $("day-slider").addEventListener("input", (e) => setFocus(Number(e.target.value)));
    $("time-slider").addEventListener("input", (e) => setMoment(Number(e.target.value)));
    $("day-add").addEventListener("click", addDay);
    $("day-del").addEventListener("click", deleteDay);
    $("day-rev").addEventListener("click", reverseDay);
    $("day-up").addEventListener("click", () => moveDay(-1));
    $("day-down").addEventListener("click", () => moveDay(1));
    $("day-color").addEventListener("input", (e) => {
      const day = editRoute();
      if (!day) return;
      beginEdit("recolor day", "day-color");
      day.color = e.target.value;
      renderDayHead();
      renderSlider();
      rebuildLayers();
      renderMarkers();
      markDirty();
    });
    $("day-title").addEventListener("input", (e) => {
      const day = editRoute();
      if (!day) return;
      beginEdit("rename day", "day-title");
      day.title = e.target.value;
      $("day-label").textContent = dayLabel(editIndex());
      refreshDerived();
      markDirty();
    });
    $("day-start").addEventListener("change", (e) => {
      const day = editRoute();
      if (!day) return;
      beginEdit("change start time");
      day.startAt = localInputToIso(e.target.value);
      refreshDerived();
      markDirty();
    });
    // Typing an end overrides the derivation; clearing it hands control back,
    // and refreshDerived() refills the field from the day on the way out.
    $("day-end").addEventListener("change", (e) => {
      const day = editRoute();
      if (!day) return;
      beginEdit("change end time");
      day.endAt = localInputToIso(e.target.value);
      day.endManual = day.endAt !== null;
      refreshDerived();
      markDirty();
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
    wireList($("stop-list"));
    wireRowMenuDismiss();
    initDragToReorder($("stop-list"));
    wireSearch();
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
    renderSlider();
    renderDayHead();
    renderList();
    refreshDerived();
    const all = allTrackPoints();
    if (all.length) fitTo(state.map, all);
    offerRecovery();
    onRouteShapeDrag(state.map, shapeAt);
    onMapClick(state.map, ([lng, lat]) => {
      // A drop at the end of a shape drag also produces a click. Without this
      // the rider bends the line and gets a stop they never asked for.
      if (consumeShapeClick(state.map)) return;
      if (state.addMode === "poi") addPoi(lng, lat, "");
      else addStop(lng, lat, "");
    });
  }

  init();
})();
