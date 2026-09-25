// A tick-all box at the head of each notification column (Email, Browser, Mute),
// per group. Ticking it sets every row in that column of that group; it shows
// checked, clear or mixed from the rows. One `change` on the form after the
// rows are set, so autosave.js makes one save rather than one per row.
(function () {
  "use strict";

  const heads = document.querySelectorAll(".notif-col-all");
  if (heads.length === 0) return;

  const rowsOf = (head) =>
    Array.from(head.closest("table").querySelectorAll(`tbody input[name$=":${head.dataset.col}"]`));

  function paint(head) {
    const rows = rowsOf(head);
    const on = rows.filter((r) => r.checked).length;
    head.checked = on === rows.length && on > 0;
    head.indeterminate = on > 0 && on < rows.length;
  }

  heads.forEach((head) => {
    head.hidden = false;
    paint(head);
    head.addEventListener("change", () => {
      const rows = rowsOf(head);
      rows.forEach((r) => {
        r.checked = head.checked;
      });
      head.indeterminate = false;
      if (rows[0]) rows[0].dispatchEvent(new Event("change", { bubbles: true }));
    });
  });

  // A row changed by hand repaints its column's head.
  document.addEventListener("change", (e) => {
    const box = e.target;
    if (!(box instanceof HTMLInputElement) || !box.name) return;
    const table = box.closest(".notif-table");
    if (!table) return;
    table.querySelectorAll(".notif-col-all").forEach(paint);
  });
})();
