// Rider cards: the size switch over each section (#341).
//
// One handler at the document, because every section carries its own switch
// and its own key. A click swaps the grid's size class and the pressed state
// and writes `routeloop.riderCards` — a map of section name to size — which
// CARDS_RESTORE in routes/riders.tsx reads back before first paint. Nothing is
// re-rendered: the rows are server-rendered forms, and the grid is only ever
// reclassed.
(() => {
  const KEY = "routeloop.riderCards";
  const SIZES = ["lg", "md", "sm"];

  function read() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || "{}");
      return v && typeof v === "object" ? v : {};
    } catch (_) {
      return {};
    }
  }

  document.addEventListener("click", (e) => {
    const btn = e.target instanceof Element && e.target.closest(".card-size button[data-size]");
    if (!btn) return;
    const size = btn.getAttribute("data-size");
    if (!SIZES.includes(size)) return;
    const block = btn.closest("[data-cards]");
    if (!block) return;
    const grid = block.querySelector(".rider-cards");
    if (grid) grid.className = "rider-cards rider-cards--" + size;
    block.querySelectorAll(".card-size button").forEach((b) => {
      b.setAttribute("aria-pressed", b === btn ? "true" : "false");
    });
    const stored = read();
    stored[block.getAttribute("data-cards")] = size;
    try {
      localStorage.setItem(KEY, JSON.stringify(stored));
    } catch (_) {
      // Private mode or a full store: the size still changes, it just does not stick.
    }
  });
})();
