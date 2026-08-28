// The one chart on the dashboard: rides planned per month, twelve months.
//
// The dashboard is `/`, served by src/routes/home.tsx — NOT src/routes/rides.tsx,
// which is the ride list and was called dashboard.tsx until 2026-08-15. This
// file kept its name because it names the page correctly; the route module was
// the thing that had it wrong.
//
// PROGRESSIVE ENHANCEMENT, NOT THE SOURCE OF TRUTH. The same twelve numbers are
// already in the page as a table before this file runs, and that table stays in
// the DOM whether or not the chart draws. If uPlot fails to load, if the browser
// has JavaScript off, if the canvas cannot be created — the page is still
// correct, just less pretty. That is the same bargain the roadbook and hand-off
// pages already make deliberately.
//
// uPlot rather than a bigger library because this app has no bundler: files in
// public/js are hand-written and served as-is, so a dependency cannot be
// tree-shaken and arrives whole. uPlot is 50 KB on disk against Chart.js's ~200,
// for one line.
(() => {
  "use strict";

  const el = document.getElementById("rides-chart");
  const months = (window.TB && window.TB.months) || [];
  // Nothing to draw, or the library never arrived. Either way the table below
  // is already showing the numbers, so this exits quietly.
  if (!el || !months.length || typeof uPlot === "undefined") return;

  // Indices, not timestamps. The x axis is twelve labeled buckets, not a
  // continuous time range — treating it as time would put the ticks at real
  // month boundaries of uneven width and invite a reading ("February is
  // narrower") that means nothing here.
  const xs = months.map((_, i) => i);
  const ys = months.map((m) => m.n);
  const labels = months.map((m) => m.label);
  const peak = Math.max(1, ...ys);

  const css = (name, fallback) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  const series = css("--viz-series-1", "#1565c0");
  const ink = css("--viz-ink-muted", "#777");
  const grid = css("--viz-grid", "#e8e8e8");

  function size() {
    // Height is fixed and width follows the container. A chart that grows with
    // its data is a chart whose shape changes meaning between two riders.
    return { width: Math.max(240, el.clientWidth), height: 150 };
  }

  const opts = {
    ...size(),
    // No title and no legend: one series, and the section heading above already
    // names it. A legend box for a single series is furniture.
    legend: { show: false },
    cursor: {
      y: false,
      points: { size: 8 },
      // Snap to a month rather than tracking pixel-wise, since the data is
      // twelve discrete buckets.
      drag: { x: false, y: false },
    },
    scales: { x: { time: false }, y: { range: [0, Math.ceil(peak * 1.15)] } },
    axes: [
      {
        stroke: ink,
        grid: { show: false },
        ticks: { show: false },
        // Every other label on a narrow screen, so twelve short months never
        // overlap into mush.
        values: (_u, splits) =>
          splits.map((i) => {
            const label = labels[i];
            if (label === undefined) return null;
            return el.clientWidth < 420 && i % 2 === 1 ? null : label;
          }),
      },
      {
        stroke: ink,
        grid: { stroke: grid, width: 1 },
        ticks: { show: false },
        // Rides are whole things. A y axis reading 0.5 rides is nonsense.
        incrs: [1, 2, 5, 10, 20, 50, 100],
        values: (_u, splits) => splits.map((v) => (Number.isInteger(v) ? v : null)),
      },
    ],
    series: [
      { value: (_u, i) => labels[i] ?? "" },
      {
        stroke: series,
        width: 2,
        fill: `${series}22`,
        points: { show: true, size: 8, stroke: series, fill: "#fff", width: 2 },
        value: (_u, v) => (v == null ? "" : `${v} ride${v === 1 ? "" : "s"}`),
      },
    ],
  };

  const plot = new uPlot(opts, [xs, ys], el);
  el.removeAttribute("aria-hidden");

  // Redraw on resize. ResizeObserver rather than a window listener because the
  // nav drawer and the responsive grid can change this element's width without
  // the window changing at all.
  if (typeof ResizeObserver !== "undefined") {
    let frame = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => plot.setSize(size()));
    }).observe(el);
  }
})();

// The count-up on "Your records" (#136).
//
// A SECOND IIFE, not a branch of the one above. The chart exits early when it
// has nothing to draw, and folding this into it would mean a rider with records
// but no rides in the last twelve months — an old library, or one imported in a
// batch — gets no animation for a reason that has nothing to do with records.
//
// THE RENDERED TEXT IS ALREADY THE FINAL VALUE. This reads it, counts from zero
// up to it, and lands back on exactly the string the server wrote. Nothing here
// is the source of the number: script off, `prefers-reduced-motion`, an old
// browser without requestAnimationFrame — every one of those shows the real
// figure immediately, which is the same bargain the chart makes with its table.
(() => {
  "use strict";

  const els = document.querySelectorAll("[data-count]");
  if (!els.length) return;

  // Asked for, not guessed at. A rider who has turned motion down is telling us
  // this specifically, and a number ticking up is exactly the kind of motion the
  // setting exists to stop.
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const DURATION = 900;

  // Only the digits move. The value arrives formatted — "1,204" — so the commas
  // have to be put back on every frame or the card's width jumps at each
  // thousand. Anything that is not a plain grouped integer is left alone rather
  // than guessed at.
  const parse = (text) => {
    if (!/^\d{1,3}(,\d{3})*$/.test(text)) return null;
    return Number(text.replace(/,/g, ""));
  };

  // Fast at the start, settling at the end — the shape that reads as a figure
  // arriving rather than as a progress bar.
  const ease = (t) => 1 - Math.pow(1 - t, 3);

  els.forEach((el) => {
    const final = el.getAttribute("data-count");
    const target = parse(final);
    if (target === null || target === 0) return;

    // Reserve the width the final value needs before the first frame. The digits
    // are tabular, but "0" and "1,204" are still different widths, and without
    // this the card resizes for the whole animation.
    el.style.minWidth = `${el.getBoundingClientRect().width}px`;
    el.textContent = "0";

    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / DURATION);
      if (t >= 1) {
        // The server's own string, not a reformatted one. Whatever this element
        // said before the animation is what it says after it.
        el.textContent = final;
        el.style.minWidth = "";
        return;
      }
      el.textContent = Math.round(target * ease(t)).toLocaleString("en-US");
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
})();

// --- Binning a ride without losing your place (#175) -------------------------
//
// The delete control on a ride card is a plain form posting to /trash/rides/:id/bin,
// and that handler redirects to `/`. A full navigation is a NEW DOCUMENT at scroll
// position zero, so binning the fourth of ten rides threw the rider back to the top
// of the page every time — and tidying up is exactly the task you do several times
// in a row.
//
// PROGRESSIVE ENHANCEMENT, the same bargain the chart and the count-up make. The
// form is untouched and still works with script off; this intercepts the submit and
// calls DELETE /api/maps/:id, which does the identical work — trashRide(), same
// gate, same transaction — and answers { ok, purgeAfter }. No new endpoint.
//
// THE PAGE'S NUMBERS GO STALE AND THAT IS THE DECISION, not an oversight. The
// reload used to refresh the stat tiles and "Your records" for free. Recomputing
// them here is only possible for the counts: the records are max() aggregates and
// a deleted ride may need the NEXT-largest one, which the browser does not have.
// Half-updating would leave the tiles right and the records naming a ride that is
// gone, which is worse than both being as of page load. So they are left, and the
// undo below is what keeps that honest — the page is not wrong, it is a moment ago.
//
// The bin IS the confirmation, which is why there is no "are you sure?" — see the
// comment on the form in home.tsx. An undo in the card's own place is the strongest
// version of that argument rather than a softening of it: the ride is recoverable
// for thirty days either way, and this makes the first ten seconds of that free.
(() => {
  "use strict";

  const list = document.querySelectorAll(".ride-card-del[data-ride-id]");
  if (!list.length) return;

  // A restore can be REFUSED. Trashing freed the rider's quota and they may have
  // spent it since, so /restore answers 409 with a reason. That has to be shown
  // rather than swallowed — an undo button that silently does nothing is worse
  // than no undo button.
  function fail(card, message) {
    const note = document.createElement("p");
    note.className = "ride-card-undo-error";
    note.setAttribute("role", "status");
    note.textContent = message;
    card.replaceChildren(note);
  }

  function undoCard(id, original) {
    const card = document.createElement("li");
    card.className = "ride-card ride-card--binned";

    const said = document.createElement("span");
    // Announced, because the card the rider was looking at has just been replaced
    // by different content in the same place. Polite rather than assertive: it is
    // the result of something they did, not an interruption.
    //
    // THE TEXT IS WRITTEN AFTER THE REGION IS IN THE DOM, further down, and that
    // ordering is the whole reason it gets announced. A live region inserted with
    // its content already in it is not reliably read — several screen readers only
    // report a CHANGE to a region they were already watching.
    card.setAttribute("role", "status");

    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "linkbtn";
    undo.textContent = "Undo";
    undo.addEventListener("click", async () => {
      undo.disabled = true;
      try {
        const res = await fetch(`/api/maps/${id}/restore`, {
          method: "POST",
          headers: { accept: "application/json" },
          credentials: "same-origin",
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          // The 409 carries the real reason — over quota, most likely. Anything
          // else is a genuine failure and the reload is the honest way out.
          return fail(card, body.error || "That could not be restored.");
        }
        // The ride is back, and this page cannot rebuild the card it replaced —
        // the markup carries the title, slug, stop count, mileage and visibility,
        // none of which the restore answers with. A reload is the correct move
        // rather than a lazy one, and it is what the rider asked for by undoing.
        window.location.reload();
      } catch {
        fail(card, "That could not be restored.");
      }
    });

    card.append(said, undo);
    original.replaceWith(card);
    // In the DOM first, then the text — see the note on role="status" above.
    said.textContent = "Moved to the recycle bin.";
  }

  list.forEach((form) => {
    form.addEventListener("submit", async (e) => {
      const id = form.dataset.rideId;
      const card = form.closest(".ride-card");
      // No id or no card and the interception has nothing to act on, so the plain
      // POST is left to do its job. Degrading to the old behavior beats swallowing
      // the submit.
      if (!id || !card) return;

      e.preventDefault();
      const button = form.querySelector("button");
      if (button) button.disabled = true;

      try {
        const res = await fetch(`/api/maps/${id}`, {
          method: "DELETE",
          headers: { accept: "application/json" },
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error(String(res.status));
        undoCard(id, card);
      } catch {
        // The request failed and the rider pressed Delete, so fall back to the
        // form rather than leaving a dead button. form.submit() does not re-fire
        // this handler, so there is no loop.
        form.submit();
      }
    });
  });
})();
