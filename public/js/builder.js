// The ride builder. State mirrors the /api/rides payload: ride meta plus an
// ordered array of routes, each a day/session of ordered stops, unordered POIs,
// and road-routed legs (legs[i] connects stops[i] → stops[i+1]).
//
// Every route is drawn on the map at once, always. The day slider changes which
// one is emphasised and never hides anything — seeing the whole trip on a single
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
    addMarker,
    removeMarker,
    onMarkerDragEnd,
    searchPlaces,
    markerElement,
    initPanelToggle,
  } = window.TBMap;

  initPanelToggle();

  const MILE = 1609.344;
  const MAX_ROUTES = 31; // matches MAX_ROUTES in src/routes/rides.ts
  const MAX_STOPS = 200;
  const MAX_POIS = 200;

  // Fallback riding speed for a leg the router never answered for, matching the
  // 20 m/s (~45 mph) the demo seeder uses. Rough twice over — it is applied to a
  // haversine distance, which is shorter than the road — so anything derived
  // from it is labelled an estimate rather than presented as a duration.
  const NOMINAL_SPEED_MS = 20;

  // Same palette the legacy viewer used, so a multi-day trip gets visually
  // distinct days without the rider picking each one.
  const DAY_COLORS = [
    "#0066cc", "#cc0000", "#8800dd", "#ff6f00", "#dd00dd", "#006064",
    "#4a148c", "#4e342e", "#00aaaa", "#a0740b", "#003300", "#550000",
  ];

  const newRoute = (color) => ({
    title: "",
    color: color || DAY_COLORS[0],
    startAt: null,
    endAt: null,
    stops: [],
    pois: [],
    legs: [],
  });

  const state = {
    map: null,
    rideId: window.TB.rideId || null,
    meta: { title: "", description: "", visibility: "private", external_url: "" },
    routes: [newRoute()],
    // Slider position: 0 means "all days", 1..N focuses that day. It is the
    // slider's value directly, so the two can never disagree.
    focus: 0,
    // markers[r] = { stops: [{marker, el}], pois: [{marker, el}] }
    markers: [],
    addMode: "stop",
    dirty: false,
    layersReady: false,
    layerCount: 0, // how many route layers are currently on the map
    legSeq: [], // legSeq[r][i] — stale routing responses are dropped
  };

  const $ = (id) => document.getElementById(id);

  // With the slider on "all days" there is still exactly one route that edits
  // land on, and the last day is the one you are almost certainly extending.
  const editIndex = () => (state.focus === 0 ? state.routes.length - 1 : state.focus - 1);
  const focusedIndex = () => (state.focus === 0 ? null : state.focus - 1);
  const editRoute = () => state.routes[editIndex()];

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

  function markDirty() {
    state.dirty = true;
    $("save-status").textContent = "unsaved changes";
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

  // A leg with distance but no duration never came back from the router, so its
  // time is estimated from distance. Deriving this rather than storing a flag
  // means a reloaded ride reports the same figures as the session that built it.
  const legIsEstimated = (leg) => leg.durationS <= 0 && leg.distanceM > 0;
  const legDurationS = (leg) =>
    legIsEstimated(leg) ? Math.round(leg.distanceM / NOMINAL_SPEED_MS) : leg.durationS;

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

  // Recomputes leg i of route r (stops[i] → stops[i+1]).
  function computeLeg(r, i) {
    const route = state.routes[r];
    if (!route || !route.stops[i] || !route.stops[i + 1]) return;
    const a = [route.stops[i].lng, route.stops[i].lat];
    const b = [route.stops[i + 1].lng, route.stops[i + 1].lat];
    const vias = (route.legs[i] && route.legs[i].viaPoints) || [];
    route.legs[i] = straightLeg(a, b, vias);
    renderTrack(r);
    renderTotals();

    if (!state.legSeq[r]) state.legSeq[r] = [];
    const seq = (state.legSeq[r][i] = (state.legSeq[r][i] || 0) + 1);
    directions(a, b, vias)
      .then((leg) => {
        // The route may have been deleted or reordered while this was in flight.
        if (state.routes[r] !== route) return;
        if (state.legSeq[r][i] !== seq || !route.legs[i]) return;
        route.legs[i] = leg;
        renderTrack(r);
        renderTotals();
      })
      .catch((e) => {
        console.warn("[builder] directions:", e.message);
        toast("No road route for that leg — drawn straight, its time is estimated", true);
      });
  }

  function computeLegsAround(r, indices) {
    const n = state.routes[r].stops.length - 1;
    [...new Set(indices)].filter((i) => i >= 0 && i < n).forEach((i) => computeLeg(r, i));
  }

  // --- Map rendering --------------------------------------------------------

  function fullTrack(r) {
    const track = [];
    for (const leg of state.routes[r].legs) {
      for (const pt of leg.geometry) {
        const last = track[track.length - 1];
        if (!last || last[0] !== pt[0] || last[1] !== pt[1]) track.push(pt);
      }
    }
    return track;
  }

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
      addRouteLayers(state.map, r, fullTrack(r), route.color);
    });
    state.layerCount = state.routes.length;
    state.layersReady = true;
    applyFocus();
  }

  // The only thing focus does. Every route stays on the map; the unfocused ones
  // are dimmed, and "all days" (focus 0) dims nothing.
  function applyFocus() {
    const f = focusedIndex();
    state.routes.forEach((_, r) => {
      const dim = f !== null && r !== f;
      setRouteDim(state.map, r, dim);
      const m = state.markers[r];
      if (!m) return;
      [...m.stops, ...m.pois].forEach(({ el }) => {
        el.style.opacity = dim ? "0.35" : "";
      });
    });
  }

  function clearMarkers() {
    state.markers.forEach((m) => {
      m.stops.forEach(({ marker }) => removeMarker(marker));
      m.pois.forEach(({ marker }) => removeMarker(marker));
    });
    state.markers = [];
  }

  function makeStopMarker(r, stop, i) {
    const el = markerElement(stop, state.routes[r].color, "stop");
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      // Clicking a marker on a dimmed day focuses that day — otherwise the row
      // it scrolls to would not be in the visible list.
      if (editIndex() !== r) setFocus(r + 1);
      focusRow("stop", i);
    });
    const marker = addMarker(state.map, [stop.lng, stop.lat], el, { draggable: true });
    onMarkerDragEnd(marker, ([lng, lat]) => {
      stop.lng = +lng.toFixed(6);
      stop.lat = +lat.toFixed(6);
      // A moved anchor invalidates its shaping points.
      if (state.routes[r].legs[i - 1]) state.routes[r].legs[i - 1].viaPoints = [];
      if (state.routes[r].legs[i]) state.routes[r].legs[i].viaPoints = [];
      computeLegsAround(r, [i - 1, i]);
      markDirty();
    });
    return { marker, el };
  }

  function makePoiMarker(r, poi, i) {
    const el = markerElement(poi, state.routes[r].color, "poi");
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (editIndex() !== r) setFocus(r + 1);
      focusRow("poi", i);
    });
    const marker = addMarker(state.map, [poi.lng, poi.lat], el, { draggable: true });
    onMarkerDragEnd(marker, ([lng, lat]) => {
      poi.lng = +lng.toFixed(6);
      poi.lat = +lat.toFixed(6);
      markDirty();
    });
    return { marker, el };
  }

  function renderMarkers() {
    clearMarkers();
    state.markers = state.routes.map((route, r) => ({
      stops: route.stops.map((s, i) => makeStopMarker(r, s, i)),
      pois: route.pois.map((p, i) => makePoiMarker(r, p, i)),
    }));
    applyFocus();
  }

  // --- Mutations ------------------------------------------------------------

  function addStop(lng, lat, name) {
    const r = editIndex();
    const route = state.routes[r];
    if (route.stops.length >= MAX_STOPS) return toast("Stop limit reached (" + MAX_STOPS + ")", true);
    route.stops.push({
      lat: +lat.toFixed(6),
      lng: +lng.toFixed(6),
      name: name || "",
      description: "",
      roles: [],
      durationMin: null,
    });
    const n = route.stops.length;
    if (n >= 2) computeLeg(r, n - 2);
    renderMarkers();
    renderList();
    renderTotals();
    markDirty();
  }

  function addPoi(lng, lat, name) {
    const r = editIndex();
    const route = state.routes[r];
    if (route.pois.length >= MAX_POIS) return toast("POI limit reached (" + MAX_POIS + ")", true);
    route.pois.push({ lat: +lat.toFixed(6), lng: +lng.toFixed(6), name: name || "", description: "", roles: [] });
    renderMarkers();
    renderList();
    markDirty();
  }

  function deleteStop(i) {
    const r = editIndex();
    const route = state.routes[r];
    route.stops.splice(i, 1);
    // Remove the legs that touched stop i, then bridge the gap (if any).
    if (route.legs.length) {
      const from = Math.max(0, i - 1);
      route.legs.splice(from, i === 0 || i === route.stops.length ? 1 : 2);
      state.legSeq[r] = [];
      if (i > 0 && i < route.stops.length) {
        route.legs.splice(
          from,
          0,
          straightLeg([route.stops[i - 1].lng, route.stops[i - 1].lat], [route.stops[i].lng, route.stops[i].lat]),
        );
        computeLeg(r, from);
      }
    }
    renderTrack(r);
    renderMarkers();
    renderList();
    renderTotals();
    markDirty();
  }

  function deletePoi(i) {
    state.routes[editIndex()].pois.splice(i, 1);
    renderMarkers();
    renderList();
    markDirty();
  }

  function moveStop(i, dir) {
    const r = editIndex();
    const route = state.routes[r];
    const j = i + dir;
    if (j < 0 || j >= route.stops.length) return;
    const s = route.stops;
    [s[i], s[j]] = [s[j], s[i]];
    // Reordered anchors: recompute every leg touching either position, and drop
    // their shaping points.
    [i - 1, i, j - 1, j].forEach((k) => {
      if (route.legs[k]) route.legs[k].viaPoints = [];
    });
    computeLegsAround(r, [i - 1, i, j - 1, j]);
    renderMarkers();
    renderList();
    markDirty();
  }

  // --- Days -----------------------------------------------------------------

  function setFocus(v) {
    state.focus = Math.max(0, Math.min(state.routes.length, v));
    $("day-slider").value = String(state.focus);
    applyFocus();
    renderDayHead();
    renderList();
    renderTotals();
  }

  function addDay() {
    if (state.routes.length >= MAX_ROUTES) return toast("Day limit reached (" + MAX_ROUTES + ")", true);
    const prev = state.routes[state.routes.length - 1];
    const route = newRoute(DAY_COLORS[state.routes.length % DAY_COLORS.length]);

    // A day begins where the last one ended. Without this every new day starts
    // with a search for a place you already have on the map.
    const last = prev && prev.stops[prev.stops.length - 1];
    if (last) {
      route.stops.push({
        lat: last.lat,
        lng: last.lng,
        name: last.name,
        description: "",
        roles: [],
        durationMin: null,
      });
    }

    state.routes.push(route);
    renderSlider();
    setFocus(state.routes.length); // focus the new day
    rebuildLayers();
    renderMarkers();
    markDirty();
  }

  function deleteDay() {
    if (state.routes.length <= 1) return toast("A ride needs at least one day", true);
    const r = editIndex();
    state.routes.splice(r, 1);
    state.legSeq.splice(r, 1);
    renderSlider();
    setFocus(Math.min(state.focus, state.routes.length));
    rebuildLayers();
    renderMarkers();
    renderList();
    renderTotals();
    markDirty();
  }

  function moveDay(dir) {
    const r = editIndex();
    const j = r + dir;
    if (j < 0 || j >= state.routes.length) return;
    const a = state.routes;
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
    const route = state.routes[r];
    return route.title || "Day " + (r + 1);
  }

  function renderSlider() {
    const slider = $("day-slider");
    slider.max = String(state.routes.length);
    if (Number(slider.value) > state.routes.length) slider.value = String(state.routes.length);
    // A single day has nothing to scrub between; the slider stays but goes
    // inert rather than disappearing and reflowing the panel on the second day.
    slider.disabled = state.routes.length < 2;
    $("day-ticks").innerHTML =
      '<span class="day-tick">All</span>' +
      state.routes
        .map((_, r) => '<span class="day-tick" style="--tick-color:' + esc(state.routes[r].color) + '">' + (r + 1) + "</span>")
        .join("");
  }

  function renderDayHead() {
    const head = $("day-head");
    const r = editIndex();
    const route = state.routes[r];
    // The header edits one specific day, so it names that day even while the
    // slider sits on "all" — otherwise the color swatch would be ambiguous.
    $("day-label").textContent =
      state.focus === 0
        ? state.routes.length > 1
          ? "All days · editing " + dayLabel(r)
          : "All days"
        : dayLabel(r);
    head.hidden = state.routes.length < 2 && !route.title;
    $("route-color").value = route.color;
    $("route-title").value = route.title;
    $("day-up").disabled = r === 0;
    $("day-down").disabled = r === state.routes.length - 1;
    $("day-del").disabled = state.routes.length <= 1;
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
      (isStop
        ? '<input class="row-dur" name="stop-duration-' + i + '" type="number" min="0" max="43200" placeholder="min" title="Stop duration (minutes)" value="' +
          (point.durationMin ?? "") + '">'
        : "") +
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
    const route = editRoute();
    return row.dataset.kind === "stop" ? route.stops[i] : route.pois[i];
  }

  function renderList() {
    const stopList = $("stop-list");
    const poiList = $("poi-list");
    const route = editRoute();
    stopList.innerHTML = route.stops.map((s, i) => pointRowHtml("stop", s, i)).join("");
    poiList.innerHTML = route.pois.map((p, i) => pointRowHtml("poi", p, i)).join("");
    $("poi-head").hidden = route.pois.length === 0;
    hydrateIcons(stopList);
    hydrateIcons(poiList);
    if (route.stops.length === 0 && route.pois.length === 0) {
      stopList.innerHTML = '<li class="empty-hint">Click the map or search to add your first stop.</li>';
    }
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

  function routeTotals(route) {
    return {
      meters: route.legs.reduce((n, l) => n + l.distanceM, 0),
      riding: route.legs.reduce((n, l) => n + legDurationS(l), 0),
      stopped: route.stops.reduce((n, s) => n + (s.durationMin || 0) * 60, 0),
      estimated: route.legs.some(legIsEstimated),
    };
  }

  function renderTotals() {
    const totalsEl = $("totals");
    const anyStops = state.routes.some((r) => r.stops.length > 0);
    if (!anyStops) {
      totalsEl.textContent = "";
      return;
    }
    // "~" marks a riding figure that includes an estimated leg, so a number the
    // router never produced is never shown as though it had.
    const line = (t) =>
      (t.meters / MILE).toFixed(1) + " mi · " + (t.estimated ? "~" : "") + hm(t.riding) + " riding" +
      (t.stopped ? " · " + hm(t.stopped) + " stopped" : "");

    if (state.routes.length === 1) {
      totalsEl.textContent = line(routeTotals(state.routes[0]));
      return;
    }

    // With several days the trip total is the number that matters; the focused
    // day's own figures sit under it.
    const trip = state.routes.reduce(
      (acc, r) => {
        const t = routeTotals(r);
        return {
          meters: acc.meters + t.meters,
          riding: acc.riding + t.riding,
          stopped: acc.stopped + t.stopped,
          estimated: acc.estimated || t.estimated,
        };
      },
      { meters: 0, riding: 0, stopped: 0, estimated: false },
    );
    totalsEl.innerHTML =
      '<span class="totals-trip">' + state.routes.length + " days · " + line(trip) + "</span>" +
      '<span class="totals-day">' + esc(dayLabel(editIndex())) + ": " + line(routeTotals(editRoute())) + "</span>";
  }

  // Delegated events for both lists.
  function wireList(listEl) {
    listEl.addEventListener("input", (e) => {
      const row = e.target.closest(".point-row");
      if (!row) return;
      const point = pointOf(row);
      if (!point) return;
      if (e.target.classList.contains("row-name")) point.name = e.target.value;
      if (e.target.classList.contains("row-desc")) point.description = e.target.value;
      if (e.target.classList.contains("row-dur")) {
        point.durationMin = e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value)));
        renderTotals();
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
  function wireSearch() {
    const input = $("search");
    const results = $("search-results");
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
      // The API requires at least one stop per route, so a day you added but
      // never filled in would fail validation for the whole ride. Dropping it
      // is what the rider means; save() warns when it happens.
      routes: state.routes
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
    if (body.routes.length === 0) return toast("Add at least one stop", true);
    const dropped = state.routes.length - body.routes.length;
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
      }
      state.dirty = false;
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
    // Every day loads. This used to take routes[0] and warn that saving would
    // drop the rest, which made multi-day rides effectively read-only.
    state.routes = (ride.routes || []).map((r, i) => ({
      title: r.title || "",
      color: r.color || DAY_COLORS[i % DAY_COLORS.length],
      startAt: r.startAt || null,
      endAt: r.endAt || null,
      stops: r.stops || [],
      pois: r.pois || [],
      legs: r.legs || [],
    }));
    if (state.routes.length === 0) state.routes = [newRoute()];
    $("ride-title").value = state.meta.title;
    $("ride-description").value = state.meta.description;
    $("ride-visibility").value = state.meta.visibility;
  }

  // --- Init -----------------------------------------------------------------

  function wireDays() {
    $("day-slider").addEventListener("input", (e) => setFocus(Number(e.target.value)));
    $("day-add").addEventListener("click", addDay);
    $("day-del").addEventListener("click", deleteDay);
    $("day-up").addEventListener("click", () => moveDay(-1));
    $("day-down").addEventListener("click", () => moveDay(1));
    $("route-color").addEventListener("input", (e) => {
      editRoute().color = e.target.value;
      renderSlider();
      rebuildLayers();
      renderMarkers();
      markDirty();
    });
    $("route-title").addEventListener("input", (e) => {
      editRoute().title = e.target.value;
      $("day-label").textContent = state.focus === 0 ? "All days · editing " + dayLabel(editIndex()) : dayLabel(editIndex());
      renderTotals();
      markDirty();
    });
  }

  function wireMeta() {
    $("ride-title").addEventListener("input", (e) => {
      state.meta.title = e.target.value;
      markDirty();
    });
    $("ride-description").addEventListener("input", (e) => {
      state.meta.description = e.target.value;
      markDirty();
    });
    $("ride-visibility").addEventListener("change", (e) => {
      state.meta.visibility = e.target.value;
      markDirty();
    });
    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.addMode = btn.dataset.mode;
      });
    });
    $("save").addEventListener("click", save);
    window.addEventListener("beforeunload", (e) => {
      if (state.dirty) e.preventDefault();
    });
  }

  function allTrackPoints() {
    const pts = [];
    state.routes.forEach((route, r) => {
      pts.push(...fullTrack(r));
      [...route.stops, ...route.pois].forEach((p) => pts.push([p.lng, p.lat]));
    });
    return pts;
  }

  async function init() {
    if (!window.TB.gmapsKey || !window.TB.mapId) {
      document.body.insertAdjacentHTML(
        "afterbegin",
        '<div class="tb-banner">Maps are not configured — set GMAPS_KEY and GMAPS_MAP_ID and restart.</div>',
      );
      return;
    }
    wireMeta();
    wireDays();
    wireList($("stop-list"));
    wireList($("poi-list"));
    wireSearch();

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

    // The server only sends TB.home on the new-ride route, so this cannot fire
    // while editing. Guarding on stops.length as well means a reload of a
    // half-built ride does not stack a second home stop on the first.
    if (window.TB.home && !state.rideId && state.routes[0].stops.length === 0) {
      addStop(window.TB.home.lng, window.TB.home.lat, "Home");
      state.routes[0].stops[0].roles = ["home"];
    }

    rebuildLayers();
    renderMarkers();
    renderSlider();
    renderDayHead();
    renderList();
    renderTotals();
    const all = allTrackPoints();
    if (all.length) fitTo(state.map, all);
    onMapClick(state.map, ([lng, lat]) => {
      if (state.addMode === "poi") addPoi(lng, lat, "");
      else addStop(lng, lat, "");
    });
  }

  init();
})();
