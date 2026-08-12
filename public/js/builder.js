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
    $("save-status").textContent = "unsaved changes";
    $("discard").disabled = false;
    queueDraft();
  }

  // Throws the working copy away and reloads the saved one. A reload rather than
  // an in-place rebuild because that is the only version guaranteed to match
  // what the server holds — reconstructing state by hand is how a "discard"
  // quietly keeps something. For a ride that was never saved there is nothing to
  // fetch, so the reload lands on an empty builder, which is the same answer.
  //
  // state.dirty is cleared first or beforeunload asks a second time, one line
  // after the rider already confirmed.
  function discardChanges() {
    if (!state.dirty) return;
    const saved = state.rideId ? "the last saved version" : "an empty ride";
    if (!window.confirm("Discard every unsaved change and go back to " + saved + "?\n\nThis cannot be undone.")) return;
    state.dirty = false;
    // Drop the draft too, or the reload lands on a recovery prompt offering
    // back the exact thing that was just discarded.
    clearTimeout(draftTimer);
    HIST.Draft.clear(state.rideId);
    window.location.reload();
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

    // Same treatment the day slider gets below two days: it stays put and goes
    // inert rather than vanishing and reflowing the panel the moment a date is
    // typed.
    slider.disabled = !span;
    if (!span) {
      slider.min = "0";
      slider.max = "0";
      slider.value = "0";
      say(state.days.some((r) => r.startAt) ? "" : "Give a day a start time to scrub the ride");
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
      note.textContent = day.endAt ? "add a start time to work the end out" : "";
      return;
    }
    if (day.endManual) {
      note.textContent = "end set by hand";
    } else {
      note.textContent = routeTotals(day).estimated ? "end estimated from the day" : "end from the day";
    }
  }

  // --- Panel: list + totals -------------------------------------------------

  function roleIconsHtml(point) {
    return (point.roles || [])
      .map((r) => {
        const meta = window.TB.roles[r];
        return meta ? '<span class="role-chip tb-inline-icon" data-icon="' + esc(meta.icon) + '" title="' + esc(meta.title) + '"></span>' : "";
      })
      .join("");
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

  function pointRowHtml(kind, point, i) {
    const isStop = kind === "stop";
    return (
      '<li class="point-row" data-kind="' + kind + '" data-i="' + i + '">' +
      '<div class="row-main">' +
      (isStop ? '<span class="row-num">' + (i + 1) + "</span>" : '<span class="row-num poi-dot"></span>') +
      '<input class="row-name" name="' + kind + '-name-' + i + '" type="text" maxlength="255" autocomplete="off" placeholder="' + (isStop ? "Stop name" : "POI name") + '" value="' + esc(point.name) + '">' +
      // POIs get the same minutes field now. Blank means "rode past without
      // stopping", which is the common case and why it stays a placeholder
      // rather than a zero.
      '<input class="row-dur" name="' + kind + '-duration-' + i + '" type="number" min="0" max="43200" placeholder="min" title="' +
      (isStop ? "Stop duration (minutes)" : "How long you stop here, if you stop (minutes)") + '" value="' +
      (point.durationMin ?? "") + '">' +
      '<button type="button" class="row-roles-btn" title="Categories">' + (roleIconsHtml(point) || "+") + "</button>" +
      '<span class="row-actions">' +
      (isStop
        ? '<button type="button" class="row-up" title="Move up">↑</button><button type="button" class="row-down" title="Move down">↓</button>'
        : "") +
      '<button type="button" class="row-notes" title="Notes">✎</button>' +
      '<button type="button" class="row-del" title="Delete">✕</button>' +
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
        point.durationMin = e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value)));
        refreshDerived();
      }
      markDirty();
    });
    listEl.addEventListener("click", (e) => {
      const row = e.target.closest(".point-row");
      if (!row) return;
      const i = Number(row.dataset.i);
      const isStop = row.dataset.kind === "stop";
      const point = pointOf(row);
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.classList.contains("row-del")) return isStop ? deleteStop(i) : deletePoi(i);
      if (btn.classList.contains("row-up")) return moveStop(i, -1);
      if (btn.classList.contains("row-down")) return moveStop(i, 1);
      if (btn.classList.contains("row-notes")) {
        const ta = row.querySelector(".row-desc");
        ta.hidden = !ta.hidden;
        if (!ta.hidden) ta.focus();
        return;
      }
      if (btn.classList.contains("row-roles-btn")) {
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
        rolesBtn.innerHTML = roleIconsHtml(point) || "+";
        hydrateIcons(rolesBtn);
        renderMarkers();
        markDirty();
      }
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

  async function save() {
    if (state.saving) return;
    state.meta.title = $("ride-title").value.trim();
    if (!state.meta.title) {
      $("ride-title").focus();
      return toast("Give the ride a title first", true);
    }
    const body = payload();
    if (body.days.length === 0) return toast("Add at least one stop", true);
    const dropped = state.days.length - body.days.length;
    if (dropped > 0) toast(dropped + " empty day" + (dropped > 1 ? "s" : "") + " skipped", true);

    state.saving = true;
    $("save").disabled = true;
    $("save-status").textContent = "saving…";
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
      state.dirty = false;
      // Saved is the one moment the draft is provably redundant.
      clearTimeout(draftTimer);
      HIST.Draft.clear(state.rideId);
      draftFailed = false;
      $("discard").disabled = true;
      $("save-status").innerHTML = 'saved ✓ · <a href="/m/' + esc(data.slug || "") + '">view</a>';
    } catch (e) {
      toast(e.message, true);
      $("save-status").textContent = "not saved";
    } finally {
      state.saving = false;
      $("save").disabled = false;
    }
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
      beginEdit("rename ride", "ride-title");
      state.meta.title = e.target.value;
      markDirty();
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
    $("save").addEventListener("click", save);
    $("discard").addEventListener("click", discardChanges);
    window.addEventListener("beforeunload", (e) => {
      if (state.dirty) e.preventDefault();
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
    wireSearch();
    wireHistory();

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
