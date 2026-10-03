// Rider-reported road conditions (#48) and seasonal closures (#53) on a map page,
// shared by the builder and the viewer. The rules are src/road-reports/policy.ts;
// the season arithmetic is road-season.js. map-common.js stays the only file that
// speaks google.maps: this draws through TBMap and nothing else.
//
// The host page hands over what it owns as functions, the conditions-strip
// arrangement: `routes()` is [{uid, title, startAt, endAt}], read fresh each render
// so a changed date re-judges a seasonal closure with no refetch.
(function (window) {
  "use strict";
  const KINDS = [
    { id: "surface", label: "Rough or unpaved", glyph: "!" },
    { id: "hazard", label: "Hazard", glyph: "!" },
    { id: "closure", label: "Closed", glyph: "×" },
  ];
  const LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label]));
  const GLYPH = Object.fromEntries(KINDS.map((k) => [k.id, k.glyph]));
  const DAY_MS = 86400000;

  // The builder's #tb-toast, made here for a page that has no toast of its own.
  let toastTimer = null;
  function ownToast(msg, isError) {
    let el = document.getElementById("tb-toast");
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

  function create(opts) {
    const M = window.TBMap;
    const S = window.TBRoadSeason;
    const esc = M.esc;
    const host = opts.host || null;
    const toast = opts.toast || ownToast;
    let reports = [];
    let markers = [];
    let armed = false;
    let tookAt = 0;
    let button = null;

    function ago(iso) {
      const days = Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
      return days <= 0 ? "today" : days === 1 ? "yesterday" : days + " days ago";
    }

    function routeOf(uid) {
      return opts.routes().find((r) => r.uid === uid) || null;
    }

    // What one report says about the routes it sits on. A seasonal closure is judged
    // against each route's own date; anything else simply applies.
    function verdict(r) {
      if (!r.season) return { tone: r.kind === "closure" ? "closed" : "warn", text: "" };
      const hits = r.routes
        .map(routeOf)
        .filter(Boolean)
        .map((rt) => S.seasonVerdict(r.season, rt.startAt ? new Date(rt.startAt) : null, rt.endAt ? new Date(rt.endAt) : null));
      const span = S.fmtMmdd(r.season.start) + " – " + S.fmtMmdd(r.season.end);
      if (hits.includes("closed")) return { tone: "closed", text: "Closed " + span + ", which includes your date" };
      if (hits.includes("seasonal")) return { tone: "warn", text: "Closed every year " + span };
      return { tone: "quiet", text: "Closed " + span + ", not on your dates" };
    }

    function titles(r) {
      return r.routes
        .map(routeOf)
        .filter(Boolean)
        .map((rt) => rt.title || "Untitled")
        .join(", ");
    }

    function popup(r) {
      const v = verdict(r);
      return (
        '<div class="rr-pop"><strong>' +
        esc(LABEL[r.kind] || r.kind) +
        "</strong>" +
        (v.text ? '<span class="rr-season rr-' + v.tone + '">' + esc(v.text) + "</span>" : "") +
        (r.note ? "<p>" + esc(r.note) + "</p>" : "") +
        '<span class="rr-meta">Reported ' +
        esc(ago(r.createdAt)) +
        (r.expiresAt ? ", counts until " + esc(new Date(r.expiresAt).toLocaleDateString()) : "") +
        "</span>" +
        (r.mine ? '<button type="button" class="rr-withdraw" data-rr-withdraw="' + r.id + '">Withdraw</button>' : "") +
        "</div>"
      );
    }

    function pin(r) {
      const el = document.createElement("div");
      el.className = "tb-marker rr-pin rr-" + r.kind + (verdict(r).tone === "quiet" ? " is-quiet" : "");
      el.innerHTML = '<span class="rr-diamond" aria-hidden="true"><b>' + GLYPH[r.kind] + "</b></span>";
      el.setAttribute("aria-label", (LABEL[r.kind] || "Road report") + (r.note ? ": " + r.note : ""));
      return el;
    }

    function render() {
      markers.forEach((m) => M.removeMarker(m));
      markers = reports.map((r) => {
        const m = M.addMarker(opts.map, r.at, pin(r), { title: LABEL[r.kind], zIndex: 5 });
        M.attachPopup(opts.map, m, popup(r));
        return m;
      });
      if (!host) return;
      if (!reports.length) {
        host.hidden = true;
        host.innerHTML = "";
        return;
      }
      host.hidden = false;
      host.innerHTML =
        '<h3 class="rr-head">Road reports</h3><ul class="rr-list">' +
        reports
          .map((r) => {
            const v = verdict(r);
            return (
              '<li class="rr-item rr-' +
              v.tone +
              '"><button type="button" class="rr-go" data-rr-go="' +
              r.id +
              '"><span class="rr-dot rr-' +
              r.kind +
              '" aria-hidden="true">' +
              GLYPH[r.kind] +
              "</span><span><strong>" +
              esc(LABEL[r.kind]) +
              "</strong> on " +
              esc(titles(r) || "this ride") +
              (v.text ? "<br><small>" + esc(v.text) + "</small>" : r.note ? "<br><small>" + esc(r.note) + "</small>" : "") +
              "</span></button></li>"
            );
          })
          .join("") +
        "</ul>";
    }

    async function load() {
      try {
        const res = await fetch(opts.url(), { credentials: "same-origin" });
        if (!res.ok) return;
        reports = (await res.json()).reports || [];
        render();
      } catch (e) {
        /* a picture beside the plan; an outage costs the pins and nothing else */
      }
    }

    // --- Reporting -------------------------------------------------------------

    function arm(on) {
      armed = on;
      if (button) button.setAttribute("aria-pressed", on ? "true" : "false");
      M.setMapCursor(opts.map, on ? "crosshair" : null);
      if (on) toast("Press the road where it is");
    }

    // A report has to land ON a road this page draws, or it attaches to no route and
    // nobody planning one is ever warned. A press is projected onto the nearest drawn
    // line and accepted within a fingertip of it at the current zoom, so a press made
    // zoomed out to a state cannot place a report kilometers off the road.
    const PRESS_PX = 24;
    function snapPress(lngLat) {
      let best = null;
      let bestM = Infinity;
      for (const track of opts.tracks()) {
        const s = window.TBShape.snapToTrack(track, lngLat);
        if (!s) continue;
        const m = window.TBShape.haversineM(s.lngLat, lngLat);
        if (m < bestM) {
          bestM = m;
          best = s.lngLat;
        }
      }
      return best && bestM <= M.metersPerPixel(opts.map, lngLat[1]) * PRESS_PX ? best : null;
    }

    function dialog(at) {
      const d = document.createElement("dialog");
      d.className = "modal rr-dialog";
      d.innerHTML =
        '<form method="dialog" class="rr-form"><h2>Report the road here</h2>' +
        '<fieldset class="rr-kinds"><legend>What is it?</legend>' +
        KINDS.map(
          (k, i) =>
            '<label><input type="radio" name="kind" value="' + k.id + '"' + (i === 0 ? " checked" : "") + "> " + esc(k.label) + "</label>",
        ).join("") +
        "</fieldset>" +
        '<label class="rr-note">What should other riders know? <textarea name="note" maxlength="400" rows="3"></textarea></label>' +
        '<fieldset class="rr-season-fields" hidden><legend>Seasonal</legend>' +
        '<label><input type="checkbox" name="seasonal"> Closed every year</label>' +
        '<div class="rr-dates" hidden><label>From <input type="date" name="from"></label><label>To <input type="date" name="to"></label>' +
        "<small>Only the month and day are kept.</small></div></fieldset>" +
        '<p class="rr-public">Any rider who opens a ride passing here sees this report, but not who made it.</p>' +
        '<p class="rr-error" role="alert"></p>' +
        '<div class="rr-actions"><button type="button" class="btn-quiet" value="cancel">Cancel</button><button type="submit" class="btn">Report</button></div></form>';
      document.body.appendChild(d);
      const f = d.querySelector("form");
      const seasonBox = f.querySelector(".rr-season-fields");
      const dates = f.querySelector(".rr-dates");
      const err = f.querySelector(".rr-error");
      const sync = () => {
        seasonBox.hidden = f.kind.value !== "closure";
        dates.hidden = seasonBox.hidden || !f.seasonal.checked;
      };
      f.addEventListener("change", sync);
      f.querySelector('[value="cancel"]').addEventListener("click", () => d.close());
      d.addEventListener("close", () => d.remove());
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const body = { kind: f.kind.value, note: f.note.value, at };
        if (!seasonBox.hidden && f.seasonal.checked) {
          const start = S.mmddFromInput(f.from.value);
          const end = S.mmddFromInput(f.to.value);
          if (start == null || end == null) {
            err.textContent = "Pick both dates for the season.";
            return;
          }
          body.season = { start, end };
        }
        const res = await fetch("/api/road-reports", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).catch(() => null);
        if (!res || !res.ok) {
          const data = res ? await res.json().catch(() => ({})) : {};
          err.textContent = data.error || "That did not save. Try again in a moment.";
          return;
        }
        d.close();
        toast("Reported. Thanks.");
        load();
      });
      d.showModal();
    }

    if (opts.canReport) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "map-report";
      button.title = "Report a road condition";
      button.setAttribute("aria-label", "Report a road condition");
      button.setAttribute("aria-pressed", "false");
      button.innerHTML = '<span class="rr-diamond" aria-hidden="true"><b>!</b></span>';
      button.addEventListener("click", () => arm(!armed));
      M.addMapButton(opts.map, button);
      M.onMapClick(opts.map, (lngLat) => {
        if (!armed) return;
        tookAt = Date.now();
        const on = snapPress(lngLat);
        if (!on) return toast("Zoom in and press right on the road", true);
        arm(false);
        dialog(on);
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && armed) arm(false);
      });
    }

    document.addEventListener("click", async (e) => {
      const w = e.target.closest && e.target.closest("[data-rr-withdraw]");
      if (w) {
        const res = await fetch("/api/road-reports/" + w.dataset.rrWithdraw + "/withdraw", {
          method: "POST",
          credentials: "same-origin",
        }).catch(() => null);
        if (res && res.ok) {
          toast("Report withdrawn");
          load();
        } else toast("That did not go through", true);
        return;
      }
      const go = e.target.closest && e.target.closest("[data-rr-go]");
      if (go) {
        const r = reports.find((x) => String(x.id) === go.dataset.rrGo);
        if (r) M.panTo(opts.map, r.at, 13);
      }
    });

    // A host page with its own map-click behavior asks this first. Both listeners
    // fire on one press and either may run first, so "was armed a moment ago"
    // covers the order in which this one has already disarmed.
    const tookClick = () => armed || Date.now() - tookAt < 400;

    return { load, render, tookClick };
  }

  window.TBRoadReports = { create };
})(window);
