// The ride list's one enhancement: binning a ride without losing your place.
//
// Moved whole from public/js/dashboard.js on 2026-09-15, when the list left the
// dashboard for /rides. It shipped there only when the dashboard had a chart
// to draw or a record to count up, which was a gate about the chart and never
// about this — a rider with neither got a Delete that navigated. Here it ships
// with the page, always.
//
// The delete control on a ride card is a plain form posting to /trash/rides/:id/bin,
// and that handler redirects to `/rides`. A full navigation is a NEW DOCUMENT at scroll
// position zero, so binning the fourth of ten rides threw the rider back to the top
// of the page every time — and tidying up is exactly the task you do several times
// in a row.
//
// PROGRESSIVE ENHANCEMENT, the same bargain the chart and the count-up make. The
// form is untouched and still works with script off; this intercepts the submit and
// calls DELETE /api/maps/:id, which does the identical work — trashRide(), same
// gate, same transaction — and answers { ok, purgeAfter }. No new endpoint.
//
// THE TAB COUNTS MOVE AND THE BIN LIST DOES NOT, and that is the decision. On
// the dashboard nothing was recomputed, because the stat tiles and the records
// are aggregates the browser cannot redo. Here the only numbers on the page are
// the two counts on the strip — yours down one, the bin up one — and leaving
// those stale while the card under them says "Moved to the recycle bin" would
// have the page disagree with itself. The bin panel's own rows are server-
// rendered and stay as of page load; opening that tab after a delete shows the
// count and not yet the row, and the undo below is what keeps that honest —
// the page is not wrong, it is a moment ago.
//
// The bin IS the confirmation, which is why there is no "are you sure?" — see the
// comment on the form in ride-lists.tsx. An undo in the card's own place is the strongest
// version of that argument rather than a softening of it: the ride is recoverable
// for thirty days either way, and this makes the first ten seconds of that free.
(() => {
  "use strict";

  const list = document.querySelectorAll(".ride-card-del[data-ride-id]");
  if (!list.length) return;

  // The strip's counts. Patched by hand because the strip is server-rendered;
  // absent on a page with no strip, which is why each is null-checked.
  function bump(tabId, by) {
    const el = document.querySelector("#" + tabId + " .tab-count");
    if (!el) return;
    const n = Number(el.textContent);
    if (Number.isFinite(n)) el.textContent = String(Math.max(0, n + by));
  }

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
        bump("tab-mine", 1);
        bump("tab-bin", -1);
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
        bump("tab-mine", -1);
        bump("tab-bin", 1);
      } catch {
        // The request failed and the rider pressed Delete, so fall back to the
        // form rather than leaving a dead button. form.submit() does not re-fire
        // this handler, so there is no loop.
        form.submit();
      }
    });
  });
})();
