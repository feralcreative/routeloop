// The unified ride viewer: renders ride.json (window.TB.rideUrl) on Mapbox GL.
// Ports the legacy legend/route-table behavior: per-route visibility
// checkboxes, mileage, hover highlight/dim, download buttons, arrow toggle.
(function () {
  "use strict";
  const { esc, initMap, fitTo, addRouteLayers, setRouteVisible, setRouteDim, markerElement, popupHtml, attachPopup, stopMileages, initPanelToggle } =
    window.TBMap;

  initPanelToggle();

  const state = {
    map: null,
    ride: null,
    arrowsOn: true,
    routes: [], // per route: { visible, markers: mapboxgl.Marker[] }
  };

  function allTrackPoints() {
    const pts = [];
    for (const r of state.ride.routes) {
      pts.push(...r.track);
      for (const s of [...r.stops, ...r.pois]) pts.push([s.lng, s.lat]);
    }
    return pts;
  }

  function renderRoute(i, route) {
    const rs = { visible: true, markers: [] };
    state.routes[i] = rs;
    if (route.track.length >= 2) addRouteLayers(state.map, i, route.track, route.color);

    const mileages = stopMileages(route.stops);
    route.stops.forEach((stop, si) => {
      const marker = new mapboxgl.Marker({ element: markerElement(stop, route.color, "stop"), anchor: "center" })
        .setLngLat([stop.lng, stop.lat])
        .addTo(state.map);
      attachPopup(state.map, marker, popupHtml(stop, route.color, mileages[si]));
      rs.markers.push(marker);
    });
    route.pois.forEach((poi) => {
      const marker = new mapboxgl.Marker({ element: markerElement(poi, route.color, "poi"), anchor: "center" })
        .setLngLat([poi.lng, poi.lat])
        .addTo(state.map);
      attachPopup(
        state.map,
        marker,
        popupHtml(poi, route.color, { fromStartMi: poi.distFromStartMi, showCharge: false }),
      );
      rs.markers.push(marker);
    });
  }

  function setVisible(i, visible) {
    state.routes[i].visible = visible;
    setRouteVisible(state.map, i, visible, state.arrowsOn);
    state.routes[i].markers.forEach((m) => {
      m.getElement().style.display = visible ? "" : "none";
    });
  }

  function highlight(i) {
    state.ride.routes.forEach((_, j) => {
      const dim = i !== null && j !== i;
      setRouteDim(state.map, j, dim);
      state.routes[j].markers.forEach((m) => {
        m.getElement().style.opacity = dim ? "0.3" : "";
      });
    });
  }

  function dlButton(href, label, download) {
    return (
      '<a class="route-dl-btn" href="' + esc(href) + '"' + (download ? ' download' : ' target="_blank" rel="noopener"') + ">" + label + "</a>"
    );
  }

  function buildLegend() {
    const table = document.querySelector(".route-table");
    if (!table) return;
    const multi = state.ride.routes.length > 1;
    table.innerHTML = state.ride.routes
      .map((r, i) => {
        const name = r.title || (multi ? "Day " + (i + 1) : state.ride.title);
        return (
          '<tr class="route-row" data-i="' + i + '">' +
          '<td><label class="route-toggle" style="--route-color:' + esc(r.color) + '">' +
          '<input type="checkbox" checked data-i="' + i + '">' +
          '<span class="route-name">' + esc(name) + "</span></label></td>" +
          '<td class="route-miles">' + Number(r.distanceMi).toFixed(1) + " mi</td></tr>"
        );
      })
      .join("");

    // Ride-level downloads (imported originals now; native exports in Phase 3).
    const dls = [];
    if (state.ride.gpxUrl) dls.push(dlButton(state.ride.gpxUrl + "?dl", "GPX", true));
    if (state.ride.kmlUrl) dls.push(dlButton(state.ride.kmlUrl + "?dl", "KML", true));
    if (state.ride.externalUrl && /^https?:/i.test(state.ride.externalUrl)) {
      dls.push(dlButton(state.ride.externalUrl, "URL", false));
    }
    if (dls.length) {
      table.innerHTML += '<tr class="route-downloads-row"><td colspan="2">' + dls.join(" ") + "</td></tr>";
    }

    table.querySelectorAll('input[type="checkbox"][data-i]').forEach((cb) => {
      cb.addEventListener("change", () => setVisible(Number(cb.dataset.i), cb.checked));
    });
    table.querySelectorAll(".route-row").forEach((row) => {
      row.addEventListener("mouseenter", () => highlight(Number(row.dataset.i)));
      row.addEventListener("mouseleave", () => highlight(null));
    });
  }

  function init() {
    fetch(window.TB.rideUrl)
      .then((r) => {
        if (!r.ok) throw new Error("ride fetch failed: " + r.status);
        return r.json();
      })
      .then((ride) => {
        state.ride = ride;
        state.map = initMap("map");
        state.map.on("load", () => {
          ride.routes.forEach((route, i) => renderRoute(i, route));
          fitTo(state.map, allTrackPoints());
          buildLegend();
          const arrowToggle = document.getElementById("toggle-arrows");
          if (arrowToggle) {
            arrowToggle.addEventListener("change", () => {
              state.arrowsOn = arrowToggle.checked;
              ride.routes.forEach((_, i) => setRouteVisible(state.map, i, state.routes[i].visible, state.arrowsOn));
            });
          }
        });
      })
      .catch((e) => {
        console.error("[viewer]", e);
        const panel = document.querySelector(".panel-content");
        if (panel) panel.innerHTML = '<p class="empty">Could not load this ride.</p>';
      });
  }

  init();
})();
