// The unified ride viewer: renders ride.json (window.TB.rideUrl) on Google Maps.
// Ports the legacy legend/route-table behavior: per-route visibility
// checkboxes, mileage, hover highlight/dim, download buttons, arrow toggle.
(function () {
  "use strict";
  const {
    esc,
    initMap,
    fitTo,
    addRouteLayers,
    setRouteVisible,
    setRouteDim,
    setLegHighlight,
    clearLegHighlight,
    addMarker,
    markerElement,
    popupHtml,
    attachPopup,
    stopMileages,
    initPanelToggle,
  } = window.TBMap;

  // Shared with the builder so a ride resolves to the same leg at the same
  // moment in both. See ride-time.js.
  const { tripSpan, activeAtMoment, fmtMoment } = window.TBTime;

  initPanelToggle();

  const state = {
    map: null,
    ride: null,
    arrowsOn: true,
    // per route: { visible, markers: [{ marker, el }] } — the element is kept
    // alongside the marker because dimming and hiding are CSS on our own DOM,
    // not map state.
    routes: [],
    // The timeline's position in epoch seconds, or null for "no moment chosen".
    moment: null,
    // The route the pointer is over, if any. Hovering is a momentary question —
    // "which one is this?" — so while it lasts it outranks the timeline, and
    // releasing it puts the timeline's emphasis straight back.
    hover: null,
  };

  function allTrackPoints() {
    const pts = [];
    for (const r of state.ride.routes) {
      pts.push(...r.track);
      for (const s of [...r.stops, ...r.pois]) pts.push([s.lng, s.lat]);
    }
    return pts;
  }

  function place(route, point, kind, mileage) {
    const el = markerElement(point, route.color, kind);
    const marker = addMarker(state.map, [point.lng, point.lat], el, { title: point.name || "" });
    attachPopup(state.map, marker, popupHtml(point, route.color, mileage));
    return { marker, el };
  }

  function renderRoute(i, route) {
    const rs = { visible: true, markers: [] };
    state.routes[i] = rs;
    if (route.track.length >= 2) addRouteLayers(state.map, i, route.track, route.color);

    const mileages = stopMileages(route.stops);
    route.stops.forEach((stop, si) => {
      rs.markers.push(place(route, stop, "stop", mileages[si]));
    });
    route.pois.forEach((poi) => {
      rs.markers.push(place(route, poi, "poi", { fromStartMi: poi.distFromStartMi, showCharge: false }));
    });
  }

  function setVisible(i, visible) {
    state.routes[i].visible = visible;
    setRouteVisible(state.map, i, visible, state.arrowsOn);
    state.routes[i].markers.forEach(({ el }) => {
      el.style.display = visible ? "" : "none";
    });
    // Hiding a route drops any leg highlight in the engine, so repaint rather
    // than assume the timeline's emphasis survived.
    paintFocus();
  }

  // The one place emphasis is decided. Hovering a legend row and scrubbing the
  // timeline both want to single a route out, so they resolve here instead of
  // fighting over setRouteDim — before this, leaving a hovered row undimmed
  // everything and silently threw the timeline's state away.
  function paintFocus() {
    const active = state.moment == null ? null : activeAtMoment(state.ride.routes, state.moment);
    const hovering = state.hover != null;
    const lit = hovering ? state.hover : active && active.dayIndex;
    const dimming = hovering || active != null;

    state.ride.routes.forEach((_, j) => {
      const dim = dimming && j !== lit;
      setRouteDim(state.map, j, dim);
      state.routes[j].markers.forEach(({ el }) => {
        el.style.opacity = dim ? "0.3" : "";
      });
    });

    // The leg highlight answers "where is the rider at this moment", which a
    // hover is not asking — so a hover suppresses it rather than leaving a
    // bright leg stranded on a route the pointer is not on.
    const day = !hovering && active && active.dayIndex != null ? state.ride.routes[active.dayIndex] : null;
    const leg = day && active.legIndex != null ? day.legs[active.legIndex] : null;
    if (leg) setLegHighlight(state.map, active.dayIndex, leg.startIndex, leg.endIndex);
    else clearLegHighlight(state.map);
  }

  function highlight(i) {
    state.hover = i;
    paintFocus();
  }

  // --- Timeline -------------------------------------------------------------

  function renderTimeline() {
    const wrap = document.getElementById("trip-timeline");
    if (!wrap) return; // legacy shell renders no timeline
    const span = tripSpan(state.ride.routes);
    // A ride nobody has dated has no timeline to offer, and an empty slider
    // would be a control that does nothing. Hidden outright rather than
    // disabled — unlike the builder, a viewer cannot fix it by typing a date.
    wrap.hidden = !span;
    if (!span) return;

    const slider = document.getElementById("time-slider");
    const readout = document.getElementById("time-readout");
    slider.min = String(span.from);
    slider.max = String(span.to);
    slider.value = String(state.moment == null ? span.from : state.moment);

    // The slider's value is epoch seconds, which is what a screen reader would
    // otherwise read out. aria-valuetext replaces that with the same sentence
    // sighted users get.
    const say = (text) => {
      readout.textContent = text;
      slider.setAttribute("aria-valuetext", text);
    };

    if (state.moment == null) {
      say(fmtMoment(span.from) + " – " + fmtMoment(span.to));
      return;
    }
    const a = activeAtMoment(state.ride.routes, state.moment);
    const multi = state.ride.routes.length > 1;
    const dayName = (i) => state.ride.routes[i].title || (multi ? "Day " + (i + 1) : state.ride.title);
    let what;
    if (a.dayIndex == null) {
      what = "between days";
    } else if (a.legIndex != null) {
      what = dayName(a.dayIndex) + " · leg " + (a.legIndex + 1) + " of " + state.ride.routes[a.dayIndex].legs.length;
    } else {
      const stop = a.stopIndex == null ? null : state.ride.routes[a.dayIndex].stops[a.stopIndex];
      what = dayName(a.dayIndex) + " · at " + ((stop && stop.name) || "stop " + ((a.stopIndex || 0) + 1));
    }
    say(fmtMoment(state.moment) + " · " + what);
  }

  function wireTimeline() {
    const slider = document.getElementById("time-slider");
    if (!slider) return;
    slider.addEventListener("input", () => {
      state.moment = Number(slider.value);
      paintFocus();
      renderTimeline();
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

  async function init() {
    try {
      const res = await fetch(window.TB.rideUrl);
      if (!res.ok) throw new Error("ride fetch failed: " + res.status);
      const ride = await res.json();

      state.ride = ride;
      state.map = await initMap("map");

      ride.routes.forEach((route, i) => renderRoute(i, route));
      fitTo(state.map, allTrackPoints());
      buildLegend();
      renderTimeline();
      wireTimeline();

      const cloneBtn = document.querySelector("[data-clone]");
      if (cloneBtn) {
        cloneBtn.addEventListener("click", async () => {
          cloneBtn.disabled = true;
          cloneBtn.textContent = "Cloning…";
          try {
            const res = await fetch("/api/rides/" + cloneBtn.dataset.clone + "/clone", { method: "POST" });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "clone failed");
            // Straight into the builder on the copy: the point of cloning is to
            // change something, so landing on a read-only view would be a step
            // short of what was asked for.
            window.location.href = "/builder/" + data.id;
          } catch (e) {
            cloneBtn.disabled = false;
            cloneBtn.textContent = "Clone this ride";
            console.warn("[viewer] clone:", e);
          }
        });
      }

      const arrowToggle = document.getElementById("toggle-arrows");
      if (arrowToggle) {
        arrowToggle.addEventListener("change", () => {
          state.arrowsOn = arrowToggle.checked;
          ride.routes.forEach((_, i) => setRouteVisible(state.map, i, state.routes[i].visible, state.arrowsOn));
          paintFocus(); // setRouteVisible repaints, which drops the leg highlight
        });
      }
    } catch (e) {
      console.error("[viewer]", e);
      const panel = document.querySelector(".panel-content");
      if (panel) panel.innerHTML = '<p class="empty">Could not load this ride.</p>';
    }
  }

  init();
})();
