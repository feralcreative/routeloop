// The unified ride viewer: renders ride.json (window.TB.rideUrl) on Google Maps.
// Ports the legacy legend/day-table behavior: per-day visibility
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
    setRouteGhost,
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
  const { rideSpan, activeAtMoment, fmtMoment } = window.TBTime;

  // Only the label lookup — the viewer reads stored figures rather than
  // computing them, so it never touches window.TBTwist.twistiness itself.
  const { twistLabel } = window.TBTwist;

  // Numbering and the active-day filter. The server has already resolved the
  // grouping before ride.json is written, so the viewer only ever reads — it
  // never calls resolveAltGroups. See public/js/alts.js.
  const ALT = window.TBAlt;

  initPanelToggle(() => state.map);

  const state = {
    map: null,
    ride: null,
    arrowsOn: true,
    // per day: { visible, markers: [{ marker, el }] } — the element is kept
    // alongside the marker because dimming and hiding are CSS on our own DOM,
    // not map state.
    days: [],
    // The timeline's position in epoch seconds, or null for "no moment chosen".
    moment: null,
    // The day the pointer is over, if any. Hovering is a momentary question —
    // "which one is this?" — so while it lasts it outranks the timeline, and
    // releasing it puts the timeline's emphasis straight back.
    hover: null,
  };

  function allTrackPoints() {
    const pts = [];
    for (const r of state.ride.days) {
      pts.push(...r.track);
      for (const s of [...r.stops, ...r.pois]) pts.push([s.lng, s.lat]);
    }
    return pts;
  }

  function place(day, point, kind, mileage) {
    const el = markerElement(point, day.color, kind);
    const marker = addMarker(state.map, [point.lng, point.lat], el, { title: point.name || "" });
    attachPopup(state.map, marker, popupHtml(point, day.color, mileage));
    return { marker, el };
  }

  function renderDay(i, day) {
    const rs = { visible: true, markers: [] };
    state.days[i] = rs;
    if (day.track.length >= 2) addRouteLayers(state.map, i, day.track, day.color);

    const mileages = stopMileages(day.stops);
    day.stops.forEach((stop, si) => {
      rs.markers.push(place(day, stop, "stop", mileages[si]));
    });
    day.pois.forEach((poi) => {
      rs.markers.push(place(day, poi, "poi", { fromStartMi: poi.distFromStartMi, showCharge: false }));
    });
  }

  function setVisible(i, visible) {
    state.days[i].visible = visible;
    setRouteVisible(state.map, i, visible, state.arrowsOn);
    state.days[i].markers.forEach(({ el }) => {
      el.style.display = visible ? "" : "none";
    });
    // Hiding a day drops any leg highlight in the engine, so repaint rather
    // than assume the timeline's emphasis survived.
    paintFocus();
  }

  // The one place emphasis is decided. Hovering a legend row and scrubbing the
  // timeline both want to single a day out, so they resolve here instead of
  // fighting over setRouteDim — before this, leaving a hovered row undimmed
  // everything and silently threw the timeline's state away.
  function paintFocus() {
    const active = state.moment == null ? null : activeAtMoment(state.ride.days, state.moment);
    const hovering = state.hover != null;
    const lit = hovering ? state.hover : active && active.dayIndex;
    const dimming = hovering || active != null;

    state.ride.days.forEach((r, j) => {
      const dim = dimming && j !== lit;
      const ghost = r.altGroup != null && !r.altActive;
      setRouteDim(state.map, j, dim);
      // Ghosting is a fact about the day, not about what is focused, so it is
      // set here alongside dim rather than once at load: rebuildLayers-style
      // churn aside, this is the one function that owns how a day looks.
      setRouteGhost(state.map, j, ghost);
      state.days[j].markers.forEach(({ el }) => {
        // A ghost's pins go quieter than a dimmed day's and stay that way when
        // it is the focused one — the line is dashed underneath them, and full
        // -strength markers on a dashed line read as the route you are riding.
        el.style.opacity = ghost ? "0.25" : dim ? "0.3" : "";
      });
    });

    // The leg highlight answers "where is the rider at this moment", which a
    // hover is not asking — so a hover suppresses it rather than leaving a
    // bright leg stranded on a day the pointer is not on.
    const day = !hovering && active && active.dayIndex != null ? state.ride.days[active.dayIndex] : null;
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
    const wrap = document.getElementById("ride-timeline");
    if (!wrap) return; // legacy shell renders no timeline
    const span = rideSpan(state.ride.days);
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
    const a = activeAtMoment(state.ride.days, state.moment);
    const multi = state.ride.days.length > 1;
    const dayName = (i) => state.ride.days[i].title || (multi ? "Day " + (i + 1) : state.ride.title);
    let what;
    if (a.dayIndex == null) {
      what = "between days";
    } else if (a.legIndex != null) {
      what = dayName(a.dayIndex) + " · leg " + (a.legIndex + 1) + " of " + state.ride.days[a.dayIndex].legs.length;
    } else if (a.poiIndex != null) {
      // The viewer passes no distances: a published ride carries distFromStartMi
      // for every POI already, and ride-time.js falls back to it.
      const poi = state.ride.days[a.dayIndex].pois[a.poiIndex];
      what = dayName(a.dayIndex) + " · at " + ((poi && poi.name) || "a point of interest");
    } else {
      const stop = a.stopIndex == null ? null : state.ride.days[a.dayIndex].stops[a.stopIndex];
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

  function dlButton(href, label, download, title) {
    return (
      '<a class="day-dl-btn" href="' +
      esc(href) +
      '"' +
      (title ? ' title="' + esc(title) + '"' : "") +
      (download ? " download" : ' target="_blank" rel="noopener"') +
      ">" +
      label +
      "</a>"
    );
  }

  // The numbers behind the label, on hover. The best stretch is only mentioned
  // when it is meaningfully better than the day as a whole — on a uniformly
  // twisty road it is the same figure twice.
  function twistDetail(r) {
    let s = r.twistinessDpm + "°/mi of heading change";
    if (r.twistinessBestDpm && r.twistinessBestDpm > r.twistinessDpm * 1.25) {
      s += ", best 20 mi at " + r.twistinessBestDpm;
    }
    return s;
  }

  function buildLegend() {
    const table = document.querySelector(".day-table");
    if (!table) return;
    const days = state.ride.days;
    const multi = days.length > 1;
    // "Day 3" / "Day 3b" rather than the row index — a ride with two alternates
    // for Thursday has more rows than it has days, and numbering by row would
    // say it is longer than it is. See public/js/alts.js.
    const ordinals = ALT.dayOrdinals(days);
    const anyAlt = days.some((r) => r.altGroup != null);
    table.innerHTML = days
      .map((r, i) => {
        const name = r.title || (multi ? "Day " + ordinals[i] : state.ride.title);
        const ghost = r.altGroup != null && !r.altActive;
        // BOTH MEMBERS ARE BADGED, not only the loser. A single "alternate" tag
        // on one row leaves the reader wondering what it is an alternate TO;
        // marking the pair is what makes them read as a pair.
        const badge =
          r.altGroup == null
            ? ""
            : '<span class="day-alt' +
              (ghost ? "" : " is-on") +
              '" title="' +
              (ghost
                ? "An alternative to day " + esc(ordinals[i].replace(/[a-z]+$/, "")) + ". Not counted in the ride total."
                : "The route counted in the ride total. This day has alternatives.") +
              '">' +
              (ghost ? "alternative" : "riding this") +
              "</span>";
        // Read from the ride rather than recomputed: a published ride is not
        // being edited, so the stored figure is current by definition. The
        // builder does the opposite, and twist.js says why.
        //
        // Null means nothing has measured this day — a row stored before the
        // column existed, or one with no geometry. Rendering null as "Straight"
        // would be a claim the data does not support, so it says nothing.
        const twist = twistLabel(r.twistinessDpm)
          ? '<span class="day-twist" title="' +
            esc(twistDetail(r)) +
            '">' +
            esc(twistLabel(r.twistinessDpm)) +
            "</span>"
          : "";
        return (
          '<tr class="day-row' +
          (ghost ? " is-alt" : "") +
          '" data-i="' +
          i +
          '">' +
          '<td><label class="day-toggle" style="--day-color:' +
          esc(r.color) +
          '">' +
          '<input type="checkbox" checked data-i="' +
          i +
          '">' +
          '<span class="day-name">' +
          esc(name) +
          "</span></label>" +
          badge +
          twist +
          "</td>" +
          // The day's own mileage either way. A losing alternate really is that
          // long — it is just not part of the ride, which is what the badge and
          // the total below say.
          '<td class="day-miles">' +
          Number(r.distanceMi).toFixed(1) +
          " mi</td></tr>"
        );
      })
      .join("");

    // A TOTAL ROW, but only once a ride has alternates in it. With ghosts in the
    // table the mileage column no longer adds up to anything a reader can get
    // to, and they will try — so the sum of the days that count is stated
    // rather than left to be inferred from a column that does not agree with
    // it. On a ride with no alternates the column does add up and the row would
    // be noise, so it is not rendered.
    if (anyAlt) {
      const counted = ALT.activeDays(days).reduce((n, r) => n + Number(r.distanceMi), 0);
      const n = ALT.activeDayCount(days);
      table.insertAdjacentHTML(
        "beforeend",
        '<tr class="day-total"><td>' +
          n +
          (n === 1 ? " day" : " days") +
          ", not counting alternatives</td>" +
          '<td class="day-miles">' +
          counted.toFixed(1) +
          " mi</td></tr>",
      );
    }

    // Ride-level downloads. Every ride offers every format now: an imported
    // ride streams its stored original for the format it arrived in and the
    // rest are generated from the rows, so which formats are on offer no longer
    // depends on which one the ride came from. See the DOWNLOADS table in
    // src/index.tsx.
    const dls = [];
    if (state.ride.gpxUrl) dls.push(dlButton(state.ride.gpxUrl + "?dl", "GPX", true));
    if (state.ride.kmlUrl) dls.push(dlButton(state.ride.kmlUrl + "?dl", "KML", true));
    if (state.ride.geojsonUrl) dls.push(dlButton(state.ride.geojsonUrl + "?dl", "GeoJSON", true));
    // The stop list on its own, for a spreadsheet. Last because it is the one
    // that is not a route.
    if (state.ride.csvUrl) dls.push(dlButton(state.ride.csvUrl + "?dl", "CSV", true));
    // Last and titled, because it is the one to pick for a backup: every other
    // format on this row loses something on the way back in.
    // Not a download — a page you print. Separate from the file formats above
    // because it answers a different question: not "give me this ride in
    // another app" but "give me this ride on paper".
    if (state.ride.roadbookUrl) dls.push(dlButton(state.ride.roadbookUrl, "Roadbook", false));
    if (state.ride.nativeUrl) {
      dls.push(
        dlButton(state.ride.nativeUrl + "?dl", "Routeloop", true, "Lossless \u2014 re-imports as the same ride"),
      );
    }
    if (state.ride.externalUrl && /^https?:/i.test(state.ride.externalUrl)) {
      dls.push(dlButton(state.ride.externalUrl, "URL", false));
    }
    if (dls.length) {
      table.innerHTML += '<tr class="day-downloads-row"><td colspan="2">' + dls.join(" ") + "</td></tr>";
    }

    // The per-day archives, on their own row and only for a multi-day ride.
    // Its own row rather than four more buttons on the one above: these answer
    // a different question — not "this ride as a file" but "this ride as one
    // file per day" — and they are the only download that gets a date onto
    // every day, since a GPX or KML cannot carry one internally.
    if (state.ride.dayZipBase) {
      const zips = ["gpx", "kml", "geojson", "csv"]
        .map(
          (f) =>
            '<a class="day-zip" download href="' +
            esc(state.ride.dayZipBase) +
            "/" +
            f +
            '">' +
            f.toUpperCase() +
            "</a>",
        )
        .join(" ");
      // The label links to the FAQ rather than explaining itself here. The
      // panel is 380px wide and the answer to "why are the names like that"
      // is three paragraphs — see /faq#one-file-per-day.
      table.innerHTML +=
        '<tr class="day-downloads-row day-zip-row"><td colspan="2">' +
        '<a class="day-zip-label" href="/faq#one-file-per-day" target="_blank" rel="noopener" ' +
        'title="One file per day, named so they re-import in order and dated">' +
        "One file per day (zip)</a>: " +
        zips +
        "</td></tr>";
    }

    table.querySelectorAll('input[type="checkbox"][data-i]').forEach((cb) => {
      cb.addEventListener("change", () => setVisible(Number(cb.dataset.i), cb.checked));
    });
    table.querySelectorAll(".day-row").forEach((row) => {
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

      ride.days.forEach((day, i) => renderDay(i, day));
      // Paint once the layers exist. paintFocus() is "the one place emphasis is
      // decided" and that has to include the state a ride LOADS in, not only
      // what a hover or a scrub changes it to — a losing alternate is ghosted
      // because of what it is, and nothing has to happen for that to be true.
      // Without this the alternates drew solid until the first pointer move.
      paintFocus();
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
          ride.days.forEach((_, i) => setRouteVisible(state.map, i, state.days[i].visible, state.arrowsOn));
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
