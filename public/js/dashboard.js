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
