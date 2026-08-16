// Shared Google Maps helpers for the routeloop viewer and builder.
// Ports the hard-won behavior of the legacy Google Maps viewer (main.js):
// per-route colored tracks with direction arrows, role-icon markers tinted via
// currentColor, and the waypoint tooltip with its mileage columns.
//
// Expects window.TB = { gmapsKey, mapId, roles, ... } injected by the page shell
// and the Maps bootstrap loader (which defines google.maps.importLibrary) to
// have run. Exposes window.TBMap.
//
// This file is the ONLY one that touches google.maps. The viewer and the builder
// go through the handles returned here — that boundary is what made replacing
// Mapbox a rewrite of one file instead of three.
(function () {
  "use strict";

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // --- Coordinate order -----------------------------------------------------

  // Every TBMap entry point speaks [lng, lat] — GeoJSON order, which is what
  // route_legs.geometry stores and what /api/route returns. google.maps speaks
  // {lat, lng}. These two functions are the ONLY place that conversion happens.
  // Reversed pairs still render, just in the wrong hemisphere, so confining the
  // swap to one place is the whole defense. Same reasoning as toGoogleWaypoint
  // in src/routes/routing.ts — keep it that way.
  const toLatLng = (lngLat) => ({ lat: lngLat[1], lng: lngLat[0] });

  function fromLatLng(p) {
    if (!p) return null;
    // A marker's position comes back as LatLng (accessors) or LatLngLiteral
    // (plain numbers) depending on how it was set.
    const lat = typeof p.lat === "function" ? p.lat() : p.lat;
    const lng = typeof p.lng === "function" ? p.lng() : p.lng;
    return [lng, lat];
  }

  // --- Library handles ------------------------------------------------------

  // Populated by initMap. Held here so the rest of the file reads like the
  // Mapbox original instead of awaiting an import in every function.
  let Maps = null; // google.maps.importLibrary("maps")
  let Core = null; // ... ("core")
  let Marker = null; // ... ("marker")

  function requireInit(what) {
    if (!Maps) throw new Error("TBMap: " + what + " called before initMap()");
  }

  // --- Map init -------------------------------------------------------------

  const DEFAULT_CENTER = { lat: 37.3, lng: -119.5 };
  const DEFAULT_ZOOM = 6;

  // fitBounds has no maxZoom, unlike the Mapbox call this replaces. A ride with
  // one stop would otherwise land at building zoom.
  const MAX_FIT_ZOOM = 14;

  // --- Basemap --------------------------------------------------------------

  // The four Google basemaps, as an allow-list. Written as strings rather than
  // MapTypeId.* on purpose: the enum lives in the "maps" library and would have
  // to be read off the handle after the await, while the literals are what the
  // API documents and accepts either way.
  //
  // Order is the order they appear in the control, and it is deliberate: the two
  // drawn maps first, then the two photographic ones.
  const MAP_TYPES = ["terrain", "roadmap", "satellite", "hybrid"];

  // Terrain, not roadmap, and this is the point of the whole block. A rider is
  // choosing roads to ride, and relief is the single most useful thing a basemap
  // can say about a road that a line on white cannot — a pass, a canyon, the
  // reason a road bends. Roadmap is still one click away for anyone navigating
  // by town rather than by terrain.
  //
  // Worth knowing before styling: terrain is raster imagery with vector data on
  // top, so the cloud styling attached to GMAPS_MAP_ID applies only to the
  // labels and roads drawn over it, not to the ground. Whatever is styled in the
  // Map ID will look like it partly stopped working here. It did not.
  const DEFAULT_MAP_TYPE = "terrain";

  // Per rider, per browser. Not on the ride: the basemap is how one person likes
  // to read a map, not a property of the route, and putting it on the record
  // would mean a shared link overrides the reader's own preference.
  const MAP_TYPE_KEY = "routeloop.mapType";

  // Private-mode Safari throws on localStorage access. Same guard as site.js and
  // builder-history.js — a failure has to degrade to "no preference" rather than
  // taking the map down, which on these two pages is the whole page.
  function storedMapType() {
    let v = null;
    try {
      v = window.localStorage.getItem(MAP_TYPE_KEY);
    } catch (e) {
      return DEFAULT_MAP_TYPE;
    }
    // Validated against the allow-list rather than trusted. The value survives
    // deploys, so a type we stop offering — or anything else that ends up under
    // this key — has to fall back rather than reach Maps.Map as a bad option.
    return MAP_TYPES.indexOf(v) === -1 ? DEFAULT_MAP_TYPE : v;
  }

  function rememberMapType(map) {
    map.addListener("maptypeid_changed", () => {
      const v = map.getMapTypeId();
      if (MAP_TYPES.indexOf(v) === -1) return;
      try {
        window.localStorage.setItem(MAP_TYPE_KEY, v);
      } catch (e) {
        /* nothing to do — the choice simply lasts as long as the page does */
      }
    });
  }

  async function initMap(container, opts) {
    const el = typeof container === "string" ? document.getElementById(container) : container;
    if (!el) throw new Error("TBMap: no map container");

    [Core, Maps, Marker] = await Promise.all([
      google.maps.importLibrary("core"),
      google.maps.importLibrary("maps"),
      google.maps.importLibrary("marker"),
    ]);

    const map = new Maps.Map(
      el,
      Object.assign(
        {
          center: DEFAULT_CENTER,
          zoom: DEFAULT_ZOOM,
          // Advanced Markers render nothing at all without a Map ID — no error,
          // no marker, which reads as a data bug rather than a config one.
          mapId: window.TB.mapId,
          // Google's own POI pins open their own info windows and would fight
          // the builder's click-to-add-a-stop.
          clickableIcons: false,
          mapTypeId: storedMapType(),
          mapTypeControl: true,
          mapTypeControlOptions: {
            mapTypeIds: MAP_TYPES,
            // TOP_CENTER, and every other edge is taken. The site header floats
            // over the map rather than sitting above it, so TOP_LEFT is under
            // the wordmark and TOP_RIGHT is under the nav hamburger — that
            // second collision was real and visible, not theorised. The left
            // edge below that is the builder's panel (fitTo pads 380px for it),
            // RIGHT_BOTTOM is the zoom control, and the bottom edge carries
            // Google's own logo and attribution, which may not be covered.
            position: Core.ControlPosition.TOP_CENTER,
          },
          // mapTypeControlStyle is deliberately unset. The default adapts to the
          // available width, collapsing to a dropdown on a narrow viewport,
          // which is the behavior wanted on a phone and is not worth
          // reimplementing by pinning a style and adding a breakpoint.
          streetViewControl: false,
          fullscreenControl: false,
          // The map is the page; scroll should zoom it without a modifier, which
          // is how the Mapbox engine behaved.
          gestureHandling: "greedy",
          zoomControl: true,
          zoomControlOptions: { position: Core.ControlPosition.RIGHT_BOTTOM },
        },
        opts || {},
      ),
    );
    rememberMapType(map);
    return map;
  }

  function fitTo(map, lngLats, padding) {
    requireInit("fitTo");
    if (!lngLats.length) return;
    const bounds = new Core.LatLngBounds();
    lngLats.forEach((p) => bounds.extend(toLatLng(p)));
    // Even padding. It was `left: 380` while #map spanned the whole viewport and
    // the panel floated over its left 380px — the fit had to push the route clear
    // of a panel drawn on top of it. The drawer takes its own column now and the
    // map is sized to what is left, so every edge of the map is visible and an
    // asymmetric pad would just shove the route to the right.
    map.fitBounds(bounds, padding ?? { top: 60, bottom: 60, left: 60, right: 60 });
    Core.event.addListenerOnce(map, "idle", () => {
      if (map.getZoom() > MAX_FIT_ZOOM) map.setZoom(MAX_FIT_ZOOM);
    });
  }

  function onMapClick(map, fn) {
    requireInit("onMapClick");
    return map.addListener("click", (e) => {
      if (e.latLng) fn(fromLatLng(e.latLng));
    });
  }

  function panTo(map, lngLat, minZoom) {
    map.panTo(toLatLng(lngLat));
    if (minZoom != null && map.getZoom() < minZoom) map.setZoom(minZoom);
  }

  function mapBounds(map) {
    const b = map.getBounds();
    if (!b) return null;
    const ne = b.getNorthEast();
    const sw = b.getSouthWest();
    return { north: ne.lat(), east: ne.lng(), south: sw.lat(), west: sw.lng() };
  }

  // --- Track + arrow layers -------------------------------------------------

  const TRACK_OPACITY = 0.8;
  const DIM_OPACITY = 0.25;

  // Mapbox has no line symbol, so the engine this replaces drew a triangle to a
  // canvas and registered it as an image (ensureArrowImage). Polyline.icons does
  // it natively, so that whole function is gone.
  function arrowIcons(color, dim) {
    return [
      {
        icon: {
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: 2.4,
          strokeColor: color,
          strokeOpacity: dim ? DIM_OPACITY : 1,
          strokeWeight: 1.5,
          fillColor: color,
          fillOpacity: dim ? DIM_OPACITY : 1,
        },
        offset: "0%",
        repeat: "120px",
      },
    ];
  }

  // Mapbox addressed layers by string id against the style; a Polyline is a
  // plain object we have to hold onto ourselves. Keyed off the map so two maps
  // on one page could never collide.
  const routeLayers = new WeakMap(); // map -> Map<id, entry>

  function layersOf(map) {
    let m = routeLayers.get(map);
    if (!m) routeLayers.set(map, (m = new Map()));
    return m;
  }

  function paint(entry) {
    entry.line.setOptions({
      strokeColor: entry.color,
      strokeOpacity: entry.dim ? DIM_OPACITY : TRACK_OPACITY,
      zIndex: entry.dim ? 1 : 2,
      icons: entry.visible && entry.arrowsOn ? arrowIcons(entry.color, entry.dim) : [],
    });
    entry.line.setVisible(entry.visible);
  }

  // Adds (or replaces) the line + arrows for one route's track.
  //
  // `opts.shapeable` makes the line grabbable for drag-to-shape. It is opt-in
  // per call, and only the builder passes it: the viewer draws through this
  // same function, and a route line that swallows clicks there would break
  // click-through to the map and offer an edit affordance on a page with
  // nothing to edit.
  //
  // It lives on the entry rather than only on the Polyline because
  // addRouteLayers destroys and rebuilds the line — rebuildLayers() runs on
  // every day add, delete, reorder and recolour — so a flag set once at
  // construction would quietly vanish. paint() never touches clickable, so
  // once it is on the entry it survives every repaint.
  function addRouteLayers(map, id, track, color, opts) {
    requireInit("addRouteLayers");
    removeRouteLayers(map, id);
    const shapeable = Boolean(opts && opts.shapeable);
    const entry = {
      line: new Maps.Polyline({
        map,
        path: track.map(toLatLng),
        strokeWeight: 4,
        clickable: shapeable,
      }),
      color,
      visible: true,
      arrowsOn: true,
      dim: false,
      shapeable,
      id,
    };
    paint(entry);
    layersOf(map).set(id, entry);
    // Re-arm: this line is brand new, and rebuildLayers() runs often enough
    // that a gesture wired only at onRouteShapeDrag() time would stop working
    // the first time a day was added.
    const drag = shapeDrags.get(map);
    if (shapeable && drag && drag.arm) drag.arm(entry);
  }

  // The leg highlight is a slice of a route's path, so anything that removes a
  // route, repaths one, or hides one leaves it pointing at something that is no
  // longer there. Dropping it here and letting the caller re-apply is the safe
  // direction: a highlight that briefly disappears is a far smaller lie than
  // one drawn over the wrong stretch of road. Both consumers re-apply on the
  // same pass that triggers these.
  function removeRouteLayers(map, id) {
    const layers = layersOf(map);
    const entry = layers.get(id);
    if (!entry) return;
    entry.line.setMap(null);
    layers.delete(id);
    clearLegHighlight(map);
  }

  function updateRouteTrack(map, id, track) {
    const entry = layersOf(map).get(id);
    if (entry) entry.line.setPath(track.map(toLatLng));
    clearLegHighlight(map);
  }

  function setRouteVisible(map, id, visible, arrowsOn) {
    const entry = layersOf(map).get(id);
    if (!entry) return;
    entry.visible = visible;
    entry.arrowsOn = arrowsOn;
    paint(entry);
    if (!visible) clearLegHighlight(map);
  }

  function setRouteDim(map, id, dim) {
    const entry = layersOf(map).get(id);
    if (!entry) return;
    entry.dim = dim;
    paint(entry);
  }

  // --- Leg highlight --------------------------------------------------------

  // One spare Polyline per map, moved onto whichever leg is active and hidden
  // when none is. Deliberately an overlay rather than a Polyline per leg: the
  // layer ids here are route indices, and both consumers plus the export and
  // navigation work depend on that shape. Splitting a route into per-leg lines
  // to draw a highlight would change the contract for every caller of
  // addRouteLayers / updateRouteTrack / setRouteVisible / setRouteDim.
  //
  // Its path is sliced from the route's own Polyline, so there is no second
  // copy of the track to keep in step with updateRouteTrack.
  const legHighlights = new WeakMap(); // map -> Polyline

  function highlightOf(map) {
    let line = legHighlights.get(map);
    if (!line) {
      line = new Maps.Polyline({
        map,
        strokeWeight: 7,
        strokeOpacity: 1,
        zIndex: 3, // above both painted states in paint()
        clickable: false,
        visible: false,
      });
      legHighlights.set(map, line);
    }
    return line;
  }

  // Draws the span [startIndex, endIndex] of route `id`'s track at full
  // strength. Indices come from ride.json's per-leg spans and are clamped
  // rather than trusted: an imported ride's leg count and its track can drift
  // apart, and a bad slice would otherwise throw inside the renderer.
  function setLegHighlight(map, id, startIndex, endIndex) {
    const line = highlightOf(map);
    const entry = layersOf(map).get(id);
    if (!entry || !entry.visible || startIndex == null || endIndex == null) {
      line.setVisible(false);
      return;
    }
    const path = entry.line.getPath().getArray();
    const from = Math.max(0, Math.min(startIndex, path.length - 1));
    const to = Math.max(from, Math.min(endIndex, path.length - 1));
    const slice = path.slice(from, to + 1);
    // A single point is not a line — a degenerate leg highlights nothing rather
    // than drawing a dot the rider cannot interpret.
    if (slice.length < 2) {
      line.setVisible(false);
      return;
    }
    line.setOptions({ strokeColor: entry.color, icons: entry.arrowsOn ? arrowIcons(entry.color, false) : [] });
    line.setPath(slice);
    line.setVisible(true);
  }

  // --- Drag to shape --------------------------------------------------------

  // Pulling the route line onto the road the rider actually meant.
  //
  // Google's own `editable: true` is the obvious answer and the wrong one: a
  // routed leg is thousands of shape points, so it would hand back thousands of
  // drag handles, and dragging one edits geometry that the next re-route throws
  // away. What a rider wants is to grab the line anywhere and leave ONE shaping
  // point behind. So the gesture is built by hand.
  //
  // The drag is tracked on the map rather than the polyline because the pointer
  // leaves the line the instant it moves — that is the whole point of the
  // gesture.
  const shapeDrags = new WeakMap(); // map -> { preview, handler, active }

  function previewOf(map, state) {
    if (!state.preview) {
      state.preview = new Maps.Polyline({
        map,
        strokeWeight: 4,
        strokeOpacity: 0.9,
        zIndex: 4, // above the leg highlight, which may be showing at the time
        clickable: false,
        visible: false,
        // Deliberately not the route colour: this is a proposal, not the route.
        strokeColor: "#222222",
      });
    }
    return state.preview;
  }

  // handler({ id, vertexIndex, edgeForward, lngLat }) fires once, on drop.
  //
  // `edgeForward` says the rider grabbed the segment leaving the nearest vertex
  // rather than the one arriving at it. Consecutive legs share their joint
  // vertex, so on a joint that flag is the only thing that says which leg was
  // meant.
  function onRouteShapeDrag(map, handler) {
    requireInit("onRouteShapeDrag");
    const state = shapeDrags.get(map) || {};
    state.handler = handler;
    shapeDrags.set(map, state);
    if (state.wired) return;
    state.wired = true;

    const finish = (commit, lngLat) => {
      const a = state.active;
      state.active = null;
      if (!a) return;
      if (state.preview) state.preview.setVisible(false);
      map.setOptions({ draggable: true });
      if (moveL) Core.event.removeListener(moveL);
      if (upL) Core.event.removeListener(upL);
      moveL = upL = null;
      if (commit && state.handler) {
        state.handler({ id: a.id, vertexIndex: a.vertexIndex, edgeForward: a.edgeForward, lngLat });
      }
      // The click that follows a mouseup would otherwise reach onMapClick and
      // drop a stop where the rider was only bending the line.
      if (commit) state.swallowClick = true;
    };

    let moveL = null;
    let upL = null;

    // Polylines are destroyed and rebuilt on every rebuildLayers(), so arming
    // is a function the creation path calls rather than a one-time pass.
    state.arm = (entry) => {
      entry.line.addListener("mousedown", (e) => {
        if (!entry.shapeable || !entry.visible) return;
        const path = entry.line.getPath().getArray();
        if (path.length < 2) return;
        const here = fromLatLng(e.latLng);
        let best = 0;
        let bestD = Infinity;
        const k = Math.cos((here[1] * Math.PI) / 180);
        for (let i = 0; i < path.length; i++) {
          const p = fromLatLng(path[i]);
          const dx = (p[0] - here[0]) * k;
          const dy = p[1] - here[1];
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        // Which side of the nearest vertex did the grab land on? Compare
        // against the neighbours: closer to the next vertex means the rider
        // took the segment leaving `best`.
        let edgeForward = true;
        if (best > 0 && best < path.length - 1) {
          const prev = fromLatLng(path[best - 1]);
          const next = fromLatLng(path[best + 1]);
          const dp = Math.hypot((prev[0] - here[0]) * k, prev[1] - here[1]);
          const dn = Math.hypot((next[0] - here[0]) * k, next[1] - here[1]);
          edgeForward = dn <= dp;
        } else if (best === path.length - 1) {
          edgeForward = false;
        }

        state.active = { id: entry.id, vertexIndex: best, edgeForward, from: path[best] };
        // Or the map pans out from under the gesture.
        map.setOptions({ draggable: false });

        const preview = previewOf(map, state);
        preview.setPath([path[best], e.latLng]);
        preview.setVisible(true);

        moveL = map.addListener("mousemove", (ev) => {
          if (!state.active) return;
          preview.setPath([state.active.from, ev.latLng]);
        });
        upL = map.addListener("mouseup", (ev) => finish(true, fromLatLng(ev.latLng)));
      });
    };

    // Arm what is already drawn; addRouteLayers arms everything drawn later.
    for (const entry of layersOf(map).values()) if (entry.shapeable) state.arm(entry);
  }

  // True once per drop, so the caller can ignore the click that follows.
  function consumeShapeClick(map) {
    const state = shapeDrags.get(map);
    if (!state || !state.swallowClick) return false;
    state.swallowClick = false;
    return true;
  }

  function clearLegHighlight(map) {
    const line = legHighlights.get(map);
    if (line) line.setVisible(false);
  }

  // --- Markers --------------------------------------------------------------

  // The Mapbox engine left marker construction to the callers, so viewer.js and
  // builder.js both reached for `new mapboxgl.Marker` directly and both had to
  // change when the engine did. They go through these four functions now.

  function addMarker(map, lngLat, element, opts) {
    requireInit("addMarker");
    const o = opts || {};
    return new Marker.AdvancedMarkerElement({
      map,
      position: toLatLng(lngLat),
      content: element,
      gmpDraggable: !!o.draggable,
      title: o.title || "",
    });
  }

  function removeMarker(marker) {
    marker.map = null;
  }

  function onMarkerDragEnd(marker, fn) {
    marker.addListener("dragend", () => fn(fromLatLng(marker.position)));
  }

  // --- Place search ---------------------------------------------------------

  // Replaces Mapbox Geocoding v6 forward search. The move was not optional once
  // the map became Google: each provider's terms tie their search results to
  // their own basemap, so a Mapbox geocode rendered on a Google map breaks the
  // one and Google Places on a Mapbox map breaks the other.
  let Places = null;

  // Autocomplete keystrokes and the details lookup that resolves the pick are
  // billed as one session when they share a token. The token is retired after
  // each resolved pick — reusing it would merge unrelated searches.
  let sessionToken = null;

  async function placesLib() {
    if (!Places) Places = await google.maps.importLibrary("places");
    return Places;
  }

  async function searchPlaces(map, input) {
    const { AutocompleteSuggestion, AutocompleteSessionToken } = await placesLib();
    if (!sessionToken) sessionToken = new AutocompleteSessionToken();

    const request = { input, sessionToken };
    // Bias, not restrict: a rider planning from home still wants to find the
    // far end of the ride.
    const bounds = mapBounds(map);
    if (bounds) request.locationBias = bounds;

    const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
    return suggestions
      .map((s) => s.placePrediction)
      .filter(Boolean)
      .map((prediction) => ({
        name: prediction.mainText ? prediction.mainText.toString() : prediction.text.toString(),
        context: prediction.secondaryText ? prediction.secondaryText.toString() : "",
        // Deferred so coordinates are only fetched for the one result actually
        // chosen — Place Details is billed per call, autocomplete is not.
        resolve: async () => {
          const place = prediction.toPlace();
          await place.fetchFields({ fields: ["displayName", "location"] });
          sessionToken = null;
          if (!place.location) return null;
          return { lngLat: fromLatLng(place.location), name: place.displayName || "" };
        },
      }));
  }

  // --- Role icons + marker DOM ----------------------------------------------

  const svgCache = {}; // icon file -> Promise<svg text>
  function iconSvg(iconFile) {
    if (!svgCache[iconFile]) {
      svgCache[iconFile] = fetch("/img/icons/" + iconFile)
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => "");
    }
    return svgCache[iconFile];
  }

  // Legacy grid offsets (px) for 1–4 stacked role icons.
  const GRID_OFFSETS = [
    [[0, 0]],
    [
      [-13, 0],
      [13, 0],
    ],
    [
      [-13, 13],
      [13, 13],
      [0, -13],
    ],
    [
      [-13, -13],
      [13, -13],
      [-13, 13],
      [13, 13],
    ],
  ];

  // Builds the marker DOM element for a point. Role icons are inlined SVGs
  // tinted through CSS currentColor — no data-URI recoloring, which is what the
  // legacy viewer did and why it needed a two-entry cache per color. Role-less
  // points render as the legacy white circle with a colored stroke.
  //
  // .tb-marker is a zero-size positioning context (see _map.scss), so an
  // AdvancedMarkerElement's bottom-center anchor lands exactly on the point and
  // the offsets below stay measured from the center.
  function markerElement(point, color, kind) {
    const el = document.createElement("div");
    el.className = "tb-marker tb-marker-" + (kind || "stop");
    el.style.color = color;
    const roles = point.roles || [];
    if (roles.length === 0) {
      const dot = document.createElement("div");
      dot.className = "tb-marker-dot";
      const label = (point.name || "").trim();
      if (/^\d{1,3}$/.test(label)) {
        dot.textContent = label;
        dot.classList.add("tb-marker-dot-num");
      }
      el.appendChild(dot);
      return el;
    }
    const offsets = GRID_OFFSETS[Math.min(roles.length, 4) - 1];
    roles.slice(0, 4).forEach((role, idx) => {
      const meta = window.TB.roles[role];
      if (!meta) return;
      const wrap = document.createElement("div");
      wrap.className = "tb-marker-icon";
      wrap.style.transform = "translate(" + offsets[idx][0] + "px," + offsets[idx][1] + "px)";
      iconSvg(meta.icon).then((svg) => {
        if (svg) wrap.innerHTML = svg;
      });
      el.appendChild(wrap);
    });
    return el;
  }

  // --- Waypoint tooltip (ported markup — same classes as main.scss) ---------

  function roleTitle(roles) {
    if (!roles || roles.length === 0) return "Waypoint";
    return roles
      .map((r) => (window.TB.roles[r] ? window.TB.roles[r].title : r))
      .join(" / ");
  }

  function iconImgHtml(roles, color) {
    const first = roles && roles[0] && window.TB.roles[roles[0]];
    if (!first) return "";
    return (
      '<span class="waypoint-tooltip-icon tb-inline-icon" style="color:' +
      esc(color) +
      '" data-icon="' +
      esc(first.icon) +
      '"></span>'
    );
  }

  function numRow(label, value) {
    return (
      "<div class='waypoint-tooltip-num'><span class='waypoint-tooltip-label'>" +
      label +
      ":</span> <span class='waypoint-tooltip-value'>" +
      value +
      "</span></div>"
    );
  }

  // mileage: { fromStartMi, fromGasMi, fromChargeMi (null to hide), durationMin }
  function popupHtml(point, color, mileage) {
    const m = mileage || {};
    const fmt = (v) => (v == null ? "-" : v.toFixed(1) + " mi");
    let rows = "";
    if (m.fromStartMi !== undefined) rows += numRow("From Start", fmt(m.fromStartMi));
    if (m.fromGasMi !== undefined) rows += numRow("From Gas", fmt(m.fromGasMi));
    if (m.fromChargeMi !== undefined && m.showCharge) rows += numRow("From Charge", fmt(m.fromChargeMi));
    if (point.durationMin != null) rows += numRow("Stop", point.durationMin + " min");
    return (
      "<div class='waypoint-tooltip-toprow'>" +
      "<div class='waypoint-tooltip-title' style='color:" +
      esc(color) +
      ";display:flex;align-items:center;gap:6px'>" +
      iconImgHtml(point.roles, color) +
      "<span>" +
      esc(roleTitle(point.roles)) +
      "</span></div>" +
      rows +
      "</div>" +
      "<div class='waypoint-tooltip-name'>" +
      esc(point.name || "") +
      "</div>" +
      (point.description ? "<div class='waypoint-tooltip-desc'>" + esc(point.description) + "</div>" : "")
    );
  }

  // Inline the tooltip's icon (same currentColor trick as the markers).
  function hydratePopupIcons(popupEl) {
    popupEl.querySelectorAll(".tb-inline-icon[data-icon]").forEach((span) => {
      iconSvg(span.getAttribute("data-icon")).then((svg) => {
        if (svg) span.innerHTML = svg;
      });
    });
  }

  // Attaches hover-open / click-pin popup behavior (legacy wasClicked port).
  //
  // The listeners go on the marker's own DOM content rather than through
  // gmp-click, because the content is a real element in the overlay and the
  // hover half of this behavior has no marker-level equivalent.
  function attachPopup(map, marker, html) {
    requireInit("attachPopup");

    // A DOM element rather than an HTML string: the icons can then be inlined
    // before the window ever opens, instead of racing the domready event.
    const content = document.createElement("div");
    content.className = "waypoint-tooltip";
    content.innerHTML = html;
    hydratePopupIcons(content);

    const popup = new Maps.InfoWindow({
      content,
      disableAutoPan: true,
      // Suppresses the close button and header. _map.scss also hides
      // .gm-ui-hover-effect, which is what covered this before the option
      // existed; between them the tooltip stays chrome-free either way.
      headerDisabled: true,
    });

    let open = false;
    let pinned = false;
    const el = marker.content;

    function show() {
      if (open) return;
      popup.open({ map, anchor: marker });
      open = true;
    }
    function hide() {
      if (!open) return;
      popup.close();
      open = false;
    }

    el.addEventListener("mouseenter", show);
    el.addEventListener("mouseleave", () => {
      if (!pinned) hide();
    });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      pinned = !pinned;
      if (pinned) show();
      else hide();
    });
    Core.event.addListener(popup, "closeclick", () => {
      pinned = false;
      open = false;
    });
    return popup;
  }

  // --- Mileage columns (ported gas/charge semantics) ------------------------

  // First stop counts as gas but never charge; the charge column shows only
  // when a later stop actually has the charge role.
  function stopMileages(stops) {
    const hasCharge = stops.some((s, i) => i > 0 && (s.roles || []).includes("charge"));
    let lastGas = 0;
    let lastCharge = null;
    return stops.map((s, i) => {
      const d = s.distFromStartMi;
      const out = {
        fromStartMi: d,
        fromGasMi: d == null || lastGas == null ? null : d - lastGas,
        fromChargeMi: d == null || lastCharge == null ? null : d - lastCharge,
        showCharge: hasCharge,
      };
      if (d != null) {
        if (i === 0 || (s.roles || []).includes("gas")) lastGas = d;
        if (i > 0 && (s.roles || []).includes("charge")) lastCharge = d;
      }
      return out;
    });
  }

  // --- Panel collapse (ported from the legacy DOMContentLoaded block) -------

  // `getMap` is an optional accessor, not a map, and it is a function on
  // purpose: both pages bind this toggle at load and create their map inside an
  // await several hundred milliseconds later. Taking the map itself here would
  // capture null forever. A caller that passes nothing still gets a working
  // toggle, just without the re-centre.
  function initPanelToggle(getMap) {
    const panel = document.getElementById("info-panel");
    const toggle = panel && panel.querySelector(".collapse-toggle");
    if (!panel || !toggle) return;
    const rail = panel.querySelector(".drawer-rail");
    toggle.addEventListener("click", () => {
      const map = typeof getMap === "function" ? getMap() : null;
      // THE CENTRE IS CAPTURED BEFORE THE WIDTH CHANGES. #map is sized to the
      // space beside the drawer now rather than to the whole viewport, so
      // collapsing hands it 324 more pixels — and Google keeps the map's
      // top-left fixed through a resize, which slides the route sideways by
      // half that. Reinstating the centre afterwards keeps whatever the rider
      // was looking at in the middle of what they can see.
      const center = map && map.getCenter && map.getCenter();

      panel.classList.toggle("collapsed");
      const collapsed = panel.classList.contains("collapsed");
      // The button carries aria-expanded, so it has to be kept true. The markup
      // ships it as "true" and this is the only thing that flips it — a stale
      // attribute is worse than none, because it states the opposite of what a
      // screen reader user is looking at.
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute("aria-label", collapsed ? "Expand panel" : "Collapse panel");
      // The rail's controls duplicate the day scrubber, so they are hidden from
      // assistive tech while the scrubber itself is on screen and exposed only
      // once it is not. The markup ships aria-hidden="true" to match the
      // expanded state it also ships in.
      if (rail) rail.setAttribute("aria-hidden", String(!collapsed));
      // No src to swap any more: .collapse-icon is a masked span and the mask
      // is selected by the aria-expanded set two lines up. That attribute was
      // always the real state — driving the artwork from it as well removes the
      // second thing to keep in step, and there is nothing to do here.

      if (!center) return;
      // Re-centred on transitionend rather than immediately: the width animates
      // over 0.28s and a setCenter against the old width is undone by the very
      // next frame. The timeout is the fallback for a browser that never fires
      // the event — prefers-reduced-motion kills the transition entirely, and
      // transitionend does not fire for a transition that did not run.
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        map.setCenter(center);
      };
      panel.addEventListener("transitionend", settle, { once: true });
      setTimeout(settle, 350);
    });
  }

  window.TBMap = {
    esc,
    initMap,
    fitTo,
    onMapClick,
    panTo,
    addRouteLayers,
    removeRouteLayers,
    updateRouteTrack,
    setRouteVisible,
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
    popupHtml,
    attachPopup,
    stopMileages,
    iconSvg,
    initPanelToggle,
  };
})();
