// The ride builder. State mirrors the /api/rides payload: ride meta + one
// route of ordered stops, unordered POIs, and Directions-routed legs
// (legs[i] connects stops[i] → stops[i+1]). Multi-route editing arrives with
// the trip phase; the API already accepts it.
(function () {
  "use strict";
  const { esc, initMap, fitTo, addRouteLayers, updateRouteTrack, markerElement, initPanelToggle } = window.TBMap;

  initPanelToggle();

  const MILE = 1609.344;

  const state = {
    map: null,
    rideId: window.TB.rideId || null,
    meta: { title: "", description: "", visibility: "private", external_url: "" },
    route: { title: "", color: "#0066cc", startAt: null, endAt: null, stops: [], pois: [], legs: [] },
    stopMarkers: [],
    poiMarkers: [],
    addMode: "stop",
    dirty: false,
    layersReady: false,
    legSeq: [], // per-leg request sequence, stale Directions responses dropped
  };

  const $ = (id) => document.getElementById(id);

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

  // --- Directions -----------------------------------------------------------

  function straightLeg(a, b, vias) {
    // Placeholder while Directions is in flight (or as NoRoute fallback the
    // server will accept — its distance is the haversine truth).
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

  async function directions(a, b, vias) {
    const pts = [a, ...(vias || []), b];
    const coords = pts.map((p) => p[0].toFixed(6) + "," + p[1].toFixed(6)).join(";");
    const url =
      "https://api.mapbox.com/directions/v5/mapbox/driving/" +
      coords +
      "?geometries=geojson&overview=full&steps=false&continue_straight=true&alternatives=false&access_token=" +
      window.TB.token;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || !data.routes || !data.routes.length) {
      throw new Error(data.message || data.code || "no route found");
    }
    const r = data.routes[0];
    return {
      geometry: r.geometry.coordinates,
      distanceM: Math.round(r.distance),
      durationS: Math.round(r.duration),
      viaPoints: vias || [],
    };
  }

  // Recomputes leg i (stops[i] → stops[i+1]); stale responses are dropped.
  function computeLeg(i) {
    const a = [state.route.stops[i].lng, state.route.stops[i].lat];
    const b = [state.route.stops[i + 1].lng, state.route.stops[i + 1].lat];
    const vias = (state.route.legs[i] && state.route.legs[i].viaPoints) || [];
    state.route.legs[i] = straightLeg(a, b, vias);
    renderTrack();
    renderTotals();
    const seq = (state.legSeq[i] = (state.legSeq[i] || 0) + 1);
    directions(a, b, vias)
      .then((leg) => {
        if (state.legSeq[i] !== seq || !state.route.legs[i]) return;
        state.route.legs[i] = leg;
        renderTrack();
        renderTotals();
      })
      .catch((e) => {
        console.warn("[builder] directions:", e.message);
        toast("No road route for that leg — drawn straight for now", true);
      });
  }

  function computeLegsAround(indices) {
    const n = state.route.stops.length - 1;
    [...new Set(indices)].filter((i) => i >= 0 && i < n).forEach(computeLeg);
  }

  // --- Map rendering --------------------------------------------------------

  function fullTrack() {
    const track = [];
    for (const leg of state.route.legs) {
      for (const pt of leg.geometry) {
        const last = track[track.length - 1];
        if (!last || last[0] !== pt[0] || last[1] !== pt[1]) track.push(pt);
      }
    }
    return track;
  }

  function renderTrack() {
    if (!state.layersReady) return;
    updateRouteTrack(state.map, 0, fullTrack());
  }

  function rebuildLayers() {
    if (!state.map || !state.map.isStyleLoaded()) return;
    addRouteLayers(state.map, 0, fullTrack(), state.route.color);
    state.layersReady = true;
  }

  function makeStopMarker(stop, i) {
    const el = markerElement(stop, state.route.color, "stop");
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      focusRow("stop", i);
    });
    const marker = new mapboxgl.Marker({ element: el, anchor: "center", draggable: true })
      .setLngLat([stop.lng, stop.lat])
      .addTo(state.map);
    marker.on("dragend", () => {
      const p = marker.getLngLat();
      stop.lng = +p.lng.toFixed(6);
      stop.lat = +p.lat.toFixed(6);
      // A moved anchor invalidates its shaping points.
      if (state.route.legs[i - 1]) state.route.legs[i - 1].viaPoints = [];
      if (state.route.legs[i]) state.route.legs[i].viaPoints = [];
      computeLegsAround([i - 1, i]);
      markDirty();
    });
    return marker;
  }

  function makePoiMarker(poi, i) {
    const el = markerElement(poi, state.route.color, "poi");
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      focusRow("poi", i);
    });
    const marker = new mapboxgl.Marker({ element: el, anchor: "center", draggable: true })
      .setLngLat([poi.lng, poi.lat])
      .addTo(state.map);
    marker.on("dragend", () => {
      const p = marker.getLngLat();
      poi.lng = +p.lng.toFixed(6);
      poi.lat = +p.lat.toFixed(6);
      markDirty();
    });
    return marker;
  }

  function renderMarkers() {
    state.stopMarkers.forEach((m) => m.remove());
    state.poiMarkers.forEach((m) => m.remove());
    state.stopMarkers = state.route.stops.map((s, i) => makeStopMarker(s, i));
    state.poiMarkers = state.route.pois.map((p, i) => makePoiMarker(p, i));
  }

  // --- Mutations ------------------------------------------------------------

  function addStop(lng, lat, name) {
    if (state.route.stops.length >= 200) return toast("Stop limit reached (200)", true);
    state.route.stops.push({ lat: +lat.toFixed(6), lng: +lng.toFixed(6), name: name || "", description: "", roles: [], durationMin: null });
    const n = state.route.stops.length;
    if (n >= 2) computeLeg(n - 2);
    renderMarkers();
    renderList();
    renderTotals();
    markDirty();
  }

  function addPoi(lng, lat, name) {
    if (state.route.pois.length >= 200) return toast("POI limit reached (200)", true);
    state.route.pois.push({ lat: +lat.toFixed(6), lng: +lng.toFixed(6), name: name || "", description: "", roles: [] });
    renderMarkers();
    renderList();
    markDirty();
  }

  function deleteStop(i) {
    state.route.stops.splice(i, 1);
    // Remove the legs that touched stop i, then bridge the gap (if any).
    if (state.route.legs.length) {
      const from = Math.max(0, i - 1);
      state.route.legs.splice(from, i === 0 || i === state.route.stops.length ? 1 : 2);
      state.legSeq = [];
      if (i > 0 && i < state.route.stops.length) {
        state.route.legs.splice(from, 0, straightLeg(
          [state.route.stops[i - 1].lng, state.route.stops[i - 1].lat],
          [state.route.stops[i].lng, state.route.stops[i].lat],
        ));
        computeLeg(from);
      }
    }
    renderTrack();
    renderMarkers();
    renderList();
    renderTotals();
    markDirty();
  }

  function deletePoi(i) {
    state.route.pois.splice(i, 1);
    renderMarkers();
    renderList();
    markDirty();
  }

  function moveStop(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= state.route.stops.length) return;
    const s = state.route.stops;
    [s[i], s[j]] = [s[j], s[i]];
    // Reordered anchors: recompute every leg touching either position, and
    // drop their shaping points.
    [i - 1, i, j - 1, j].forEach((k) => {
      if (state.route.legs[k]) state.route.legs[k].viaPoints = [];
    });
    computeLegsAround([i - 1, i, j - 1, j]);
    renderMarkers();
    renderList();
    markDirty();
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
    return row.dataset.kind === "stop" ? state.route.stops[i] : state.route.pois[i];
  }

  function renderList() {
    const stopList = $("stop-list");
    const poiList = $("poi-list");
    stopList.innerHTML = state.route.stops.map((s, i) => pointRowHtml("stop", s, i)).join("");
    poiList.innerHTML = state.route.pois.map((p, i) => pointRowHtml("poi", p, i)).join("");
    $("poi-head").hidden = state.route.pois.length === 0;
    hydrateIcons(stopList);
    hydrateIcons(poiList);
    if (state.route.stops.length === 0 && state.route.pois.length === 0) {
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

  function renderTotals() {
    const meters = state.route.legs.reduce((n, l) => n + l.distanceM, 0);
    const riding = state.route.legs.reduce((n, l) => n + l.durationS, 0);
    const stopped = state.route.stops.reduce((n, s) => n + (s.durationMin || 0) * 60, 0);
    const hm = (secs) => {
      const h = Math.floor(secs / 3600);
      const m = Math.round((secs % 3600) / 60);
      return (h ? h + "h " : "") + m + "m";
    };
    $("totals").textContent =
      state.route.stops.length === 0
        ? ""
        : (meters / MILE).toFixed(1) + " mi · " + hm(riding) + " riding" + (stopped ? " · " + hm(stopped) + " stopped" : "");
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

  // --- Search (Mapbox Geocoding v6 forward) ---------------------------------

  let searchTimer = null;
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
        try {
          const center = state.map.getCenter();
          const url =
            "https://api.mapbox.com/search/geocode/v6/forward?q=" +
            encodeURIComponent(q) +
            "&autocomplete=true&limit=5&proximity=" +
            center.lng.toFixed(4) + "," + center.lat.toFixed(4) +
            "&access_token=" + window.TB.token;
          const res = await fetch(url);
          const data = await res.json();
          const feats = (data && data.features) || [];
          results.innerHTML = feats
            .map(
              (f, i) =>
                '<li data-i="' + i + '"><strong>' + esc(f.properties.name || "") + "</strong> " +
                '<span class="hit-ctx">' + esc(f.properties.place_formatted || "") + "</span></li>",
            )
            .join("");
          results.hidden = feats.length === 0;
          results.querySelectorAll("li").forEach((li) => {
            li.addEventListener("click", () => {
              const f = feats[Number(li.dataset.i)];
              const [lng, lat] = f.geometry.coordinates;
              if (state.addMode === "poi") addPoi(lng, lat, f.properties.name || "");
              else addStop(lng, lat, f.properties.name || "");
              state.map.flyTo({ center: [lng, lat], zoom: Math.max(state.map.getZoom(), 11) });
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
      routes: [
        {
          title: state.route.title,
          color: state.route.color,
          startAt: state.route.startAt,
          endAt: state.route.endAt,
          stops: state.route.stops,
          pois: state.route.pois,
          legs: state.route.legs,
        },
      ],
    };
  }

  async function save() {
    if (state.saving) return;
    state.meta.title = $("ride-title").value.trim();
    if (!state.meta.title) {
      $("ride-title").focus();
      return toast("Give the ride a title first", true);
    }
    if (state.route.stops.length < 1) return toast("Add at least one stop", true);
    state.saving = true;
    $("save").disabled = true;
    $("save-status").textContent = "saving…";
    try {
      const res = await fetch(state.rideId ? "/api/rides/" + state.rideId : "/api/rides", {
        method: state.rideId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
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
    const r0 = ride.routes[0] || state.route;
    state.route = {
      title: r0.title || "",
      color: r0.color || "#0066cc",
      startAt: r0.startAt || null,
      endAt: r0.endAt || null,
      stops: r0.stops || [],
      pois: r0.pois || [],
      legs: r0.legs || [],
    };
    if (ride.routes.length > 1) toast("Multi-day editing is coming — showing day 1 only; saving would drop other days", true);
    $("ride-title").value = state.meta.title;
    $("ride-description").value = state.meta.description;
    $("ride-visibility").value = state.meta.visibility;
    $("route-color").value = state.route.color;
  }

  // --- Init -----------------------------------------------------------------

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
    $("route-color").addEventListener("change", (e) => {
      state.route.color = e.target.value;
      rebuildLayers();
      renderMarkers();
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

  async function init() {
    if (!window.TB.token) {
      document.body.insertAdjacentHTML(
        "afterbegin",
        '<div class="tb-banner">Mapbox token not configured — set MAPBOX_TOKEN and restart.</div>',
      );
      return;
    }
    wireMeta();
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

    state.map = initMap("map");
    state.map.on("load", () => {
      // The server only sends TB.home on the new-ride route, so this cannot fire
      // while editing. Guarding on stops.length as well means a reload of a
      // half-built ride does not stack a second home stop on the first. It runs
      // here rather than earlier in init() because addStop() renders markers,
      // which needs the map to exist; the renders below then pick up the role.
      if (window.TB.home && !state.rideId && state.route.stops.length === 0) {
        addStop(window.TB.home.lng, window.TB.home.lat, "Home");
        state.route.stops[0].roles = ["home"];
      }

      rebuildLayers();
      renderMarkers();
      renderList();
      renderTotals();
      const all = fullTrack();
      if (all.length) fitTo(state.map, all);
      state.map.on("click", (e) => {
        if (state.addMode === "poi") addPoi(e.lngLat.lng, e.lngLat.lat, "");
        else addStop(e.lngLat.lng, e.lngLat.lat, "");
      });
    });
  }

  init();
})();
