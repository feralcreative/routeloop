// Shared Mapbox GL helpers for the tankbag viewer and builder.
// Ports the hard-won behavior of the legacy Google Maps viewer (main.js):
// per-route colored tracks with direction arrows, role-icon markers tinted via
// currentColor, and the waypoint tooltip with its mileage columns.
//
// Expects window.TB = { token, roles, ... } injected by the page shell, and
// mapbox-gl.js loaded before this file. Exposes window.TBMap.
(function () {
  "use strict";

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // --- Map init -------------------------------------------------------------

  function initMap(container, opts) {
    mapboxgl.accessToken = window.TB.token;
    const map = new mapboxgl.Map(
      Object.assign(
        {
          container,
          style: "mapbox://styles/mapbox/outdoors-v12",
          center: [-119.5, 37.3],
          zoom: 5.5,
          attributionControl: true,
        },
        opts || {},
      ),
    );
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: false }), "bottom-right");
    return map;
  }

  function fitTo(map, lngLats, padding) {
    if (!lngLats.length) return;
    const bounds = new mapboxgl.LngLatBounds();
    lngLats.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, { padding: padding ?? { top: 60, bottom: 60, left: 380, right: 60 }, maxZoom: 14 });
  }

  // --- Track + arrow layers -------------------------------------------------

  // One arrow image per color, drawn on canvas (reliable across fontstacks).
  function ensureArrowImage(map, color) {
    const id = "tb-arrow-" + color;
    if (map.hasImage(id)) return id;
    const size = 22;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    // Triangle pointing right (+x), the direction of travel along the line.
    ctx.beginPath();
    ctx.moveTo(size * 0.15, size * 0.2);
    ctx.lineTo(size * 0.85, size * 0.5);
    ctx.lineTo(size * 0.15, size * 0.8);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    map.addImage(id, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
    return id;
  }

  const srcId = (id) => "tb-route-" + id;

  // Adds (or replaces) the line + arrow layers for one route's track.
  function addRouteLayers(map, id, track, color) {
    removeRouteLayers(map, id);
    const arrowImage = ensureArrowImage(map, color);
    map.addSource(srcId(id), {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: track }, properties: {} },
    });
    map.addLayer({
      id: srcId(id) + "-line",
      type: "line",
      source: srcId(id),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": color, "line-width": 4, "line-opacity": 0.8 },
    });
    map.addLayer({
      id: srcId(id) + "-arrows",
      type: "symbol",
      source: srcId(id),
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 120,
        "icon-image": arrowImage,
        "icon-size": 0.55,
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
  }

  function removeRouteLayers(map, id) {
    for (const layer of [srcId(id) + "-line", srcId(id) + "-arrows"]) {
      if (map.getLayer(layer)) map.removeLayer(layer);
    }
    if (map.getSource(srcId(id))) map.removeSource(srcId(id));
  }

  function updateRouteTrack(map, id, track) {
    const src = map.getSource(srcId(id));
    if (src) src.setData({ type: "Feature", geometry: { type: "LineString", coordinates: track }, properties: {} });
  }

  function setRouteVisible(map, id, visible, arrowsOn) {
    const v = visible ? "visible" : "none";
    if (map.getLayer(srcId(id) + "-line")) map.setLayoutProperty(srcId(id) + "-line", "visibility", v);
    if (map.getLayer(srcId(id) + "-arrows")) {
      map.setLayoutProperty(srcId(id) + "-arrows", "visibility", visible && arrowsOn ? "visible" : "none");
    }
  }

  function setRouteDim(map, id, dim) {
    if (map.getLayer(srcId(id) + "-line")) {
      map.setPaintProperty(srcId(id) + "-line", "line-opacity", dim ? 0.25 : 0.8);
    }
    if (map.getLayer(srcId(id) + "-arrows")) {
      map.setPaintProperty(srcId(id) + "-arrows", "icon-opacity", dim ? 0.25 : 1);
    }
  }

  // --- Role icons + markers -------------------------------------------------

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
  // tinted through CSS currentColor — no data-URI recoloring. Role-less points
  // render as the legacy white circle with a colored stroke.
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

  // Inline the tooltip's icon after the popup opens (same currentColor trick).
  function hydratePopupIcons(popupEl) {
    popupEl.querySelectorAll(".tb-inline-icon[data-icon]").forEach((span) => {
      iconSvg(span.getAttribute("data-icon")).then((svg) => {
        if (svg) span.innerHTML = svg;
      });
    });
  }

  // Attaches hover-open / click-pin popup behavior (legacy wasClicked port).
  function attachPopup(map, marker, html) {
    const popup = new mapboxgl.Popup({ offset: 18, closeButton: false, maxWidth: "280px" });
    popup.setHTML(html);
    let pinned = false;
    const el = marker.getElement();
    el.addEventListener("mouseenter", () => {
      if (!popup.isOpen()) {
        popup.setLngLat(marker.getLngLat()).addTo(map);
        hydratePopupIcons(popup.getElement());
      }
    });
    el.addEventListener("mouseleave", () => {
      if (!pinned) popup.remove();
    });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      pinned = !pinned;
      if (pinned && !popup.isOpen()) {
        popup.setLngLat(marker.getLngLat()).addTo(map);
        hydratePopupIcons(popup.getElement());
      }
    });
    popup.on("close", () => {
      pinned = false;
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
    addRouteLayers,
    removeRouteLayers,
    updateRouteTrack,
    setRouteVisible,
    setRouteDim,
    markerElement,
    popupHtml,
    attachPopup,
    stopMileages,
    iconSvg,
    initPanelToggle,
  };
})();
