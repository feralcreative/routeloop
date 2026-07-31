// Shared Google Maps helpers for the tankbag viewer and builder.
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

  async function initMap(container, opts) {
    const el = typeof container === "string" ? document.getElementById(container) : container;
    if (!el) throw new Error("TBMap: no map container");

    [Core, Maps, Marker] = await Promise.all([
      google.maps.importLibrary("core"),
      google.maps.importLibrary("maps"),
      google.maps.importLibrary("marker"),
    ]);

    return new Maps.Map(
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
          mapTypeControl: false,
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
  }

  function fitTo(map, lngLats, padding) {
    requireInit("fitTo");
    if (!lngLats.length) return;
    const bounds = new Core.LatLngBounds();
    lngLats.forEach((p) => bounds.extend(toLatLng(p)));
    map.fitBounds(bounds, padding ?? { top: 60, bottom: 60, left: 380, right: 60 });
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
  function addRouteLayers(map, id, track, color) {
    requireInit("addRouteLayers");
    removeRouteLayers(map, id);
    const entry = {
      line: new Maps.Polyline({
        map,
        path: track.map(toLatLng),
        strokeWeight: 4,
        clickable: false,
      }),
      color,
      visible: true,
      arrowsOn: true,
      dim: false,
    };
    paint(entry);
    layersOf(map).set(id, entry);
  }

  function removeRouteLayers(map, id) {
    const layers = layersOf(map);
    const entry = layers.get(id);
    if (!entry) return;
    entry.line.setMap(null);
    layers.delete(id);
  }

  function updateRouteTrack(map, id, track) {
    const entry = layersOf(map).get(id);
    if (entry) entry.line.setPath(track.map(toLatLng));
  }

  function setRouteVisible(map, id, visible, arrowsOn) {
    const entry = layersOf(map).get(id);
    if (!entry) return;
    entry.visible = visible;
    entry.arrowsOn = arrowsOn;
    paint(entry);
  }

  function setRouteDim(map, id, dim) {
    const entry = layersOf(map).get(id);
    if (!entry) return;
    entry.dim = dim;
    paint(entry);
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
    // far end of the trip.
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

  function initPanelToggle() {
    const panel = document.getElementById("info-panel");
    const toggle = panel && panel.querySelector(".collapse-toggle");
    if (!panel || !toggle) return;
    toggle.addEventListener("click", () => {
      panel.classList.toggle("collapsed");
      const img = toggle.querySelector("img");
      const collapsed = panel.classList.contains("collapsed");
      if (img) {
        img.src = collapsed ? "/img/icons/icon-expand.svg" : "/img/icons/icon-collapse.svg";
        img.alt = collapsed ? "Expand" : "Collapse";
      }
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
