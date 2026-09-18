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

// KEEP, FROM THE LIST. The Keep sign on each card (RideCardGo in
// src/views/ride-lists.tsx) does what Keep on this phone does on the On the
// road page, through the same keep.js: fetch the ride's manifest from
// /m/:slug/keep.json, store the page, the roadbook and the files, write the
// registry row. Its own IIFE because the one above returns early on a page
// with nothing to bin, and a rider on somebody else's rides still keeps them.
//
// THE SIGN SHIPS HIDDEN AND THIS IS THE ONLY THING THAT SHOWS IT, and only
// where the browser can hold a copy — a Cache API and a service worker. The
// label is the state and the press is the opposite of it: Keep keeps, Kept
// removes the copy (Ziad's call, 2026-09-17 — a rider has to be able to
// unkeep a ride from the list), and Update, the state of a copy the ride has
// moved on from, keeps it again. Removing needs no network: the registry row
// already names every URL the copy holds, and forget() takes it as-is.
(() => {
  "use strict";

  const K = window.TBKeep;
  const G = window.TBGo;
  const signs = document.querySelectorAll("button[data-keep]");
  if (!signs.length || !K || !G || !K.canCache) return;

  function paint(sign, row) {
    const s = row ? G.staleness(row, sign.dataset.updated || null, Date.now()) : null;
    const stale = !!(s && s.changed);
    sign.hidden = false;
    sign.disabled = false;
    sign.classList.toggle("is-kept", !!row && !stale);
    sign.classList.toggle("is-stale", stale);
    sign.classList.remove("is-error");
    sign.textContent = !row ? "Keep" : stale ? "Update" : "Kept";
    sign.title = !row
      ? "Keep this ride on this phone, for when there is no signal"
      : (s ? s.text : "Kept") +
        (row.bytes ? " \u00b7 " + G.fmtBytes(row.bytes) : "") +
        (stale ? " \u00b7 press to keep it again" : " \u00b7 press to remove it from this phone");
  }

  signs.forEach((sign) => {
    const slug = sign.dataset.keep;
    K.readRow(slug)
      .then((row) => paint(sign, row))
      .catch(() => paint(sign, null));

    sign.addEventListener("click", () => {
      sign.disabled = true;
      // Every label the sign can carry fits the fixed width _rides.scss gives
      // it — Keeping, Removing, "3 of 5", Retry — so the row never re-measures.
      if (sign.classList.contains("is-kept")) {
        sign.textContent = "Removing";
        K.readRow(slug)
          .then((row) => (row ? K.forget(row) : null))
          .then(() => paint(sign, null))
          .catch((err) => {
            sign.disabled = false;
            sign.classList.add("is-error");
            sign.textContent = "Retry";
            sign.title = "Could not remove it: " + (err && err.message ? err.message : "unknown error");
          });
        return;
      }
      sign.textContent = "Keeping";
      fetch("/m/" + encodeURIComponent(slug) + "/keep.json", { credentials: "same-origin", cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then((m) =>
          K.keep(m, (done, total) => {
            sign.textContent = done + " of " + total;
          }),
        )
        .then((row) => paint(sign, row))
        .catch((err) => {
          sign.disabled = false;
          sign.classList.add("is-error");
          sign.textContent = "Retry";
          sign.title = "Could not keep it: " + (err && err.message ? err.message : "unknown error");
        });
    });
  });
})();

// ON THIS PHONE: which rides the phone should hold, as a set. Ziad's call,
// 2026-09-17. The switch above the list holds four positions — None, Last 30
// days, This year, All — and keep-policy.js is the rule that turns one into a
// yes or no per ride, by when the ride last changed. The choice is per phone,
// in localStorage, and the set is RE-DERIVED ON EVERY VISIT to this page while
// online: rides that now match and are not kept are kept, kept copies the
// ride has moved on from are kept again, and rides the POLICY kept that no
// longer match are removed. That last clause is the whole reason the registry
// row carries `via`: a ride the rider kept by hand is theirs and no policy
// touches it, so switching from All to None empties what All filled and
// leaves a hand-kept ride where it was.
//
// THE LIST COMES FROM /rides/keep.json, NOT FROM THE CARDS. The page is
// capped at a screenful and "All" means all. The cards' signs are repainted
// afterwards from the registry, so the list and the switch agree.
//
// ONE RIDE AT A TIME, in order, with the count on the status line — a phone on
// one bar of signal fetching forty GPX files at once is a phone that fails
// forty times at once. A failure skips that ride and carries on; the line says
// how many did not make it.
(() => {
  "use strict";

  const K = window.TBKeep;
  const G = window.TBGo;
  const P = window.TBKeepPolicy;
  const box = document.querySelector(".keep-policy");
  if (!box || !K || !G || !P || !K.canCache) return;

  const buttons = Array.from(box.querySelectorAll("button[data-policy]"));
  const status = box.querySelector(".keep-policy-status");

  function readPolicy() {
    try {
      const v = window.localStorage.getItem(P.STORE_KEY);
      return P.isPolicy(v) ? v : "none";
    } catch (e) {
      return "none";
    }
  }

  function writePolicy(v) {
    try {
      window.localStorage.setItem(P.STORE_KEY, v);
    } catch (e) {
      /* private mode: the choice holds for this page and is asked again */
    }
  }

  function paintPolicy(policy) {
    buttons.forEach((b) => b.setAttribute("aria-pressed", b.dataset.policy === policy ? "true" : "false"));
  }

  function say(text) {
    status.textContent = text;
  }

  // "3 rides · 4.2 MB on this phone", from the registry — every kept ride,
  // by hand or by policy, because the question is what the phone holds.
  function describe() {
    return K.listRows().then((rows) => {
      const bytes = rows.reduce((n, r) => n + (r.bytes || 0), 0);
      say(
        rows.length === 0
          ? "Nothing kept on this phone"
          : rows.length + (rows.length === 1 ? " ride" : " rides") + " \u00b7 " + G.fmtBytes(bytes) + " on this phone",
      );
    });
  }

  // Repaint every card's sign from the registry after a sync, so a ride the
  // policy just kept reads Kept without a reload. The signs' own IIFE above
  // owns the painting; this only pokes each one the way it pokes itself.
  function repaintSigns() {
    document.querySelectorAll("button[data-keep]").forEach((sign) => {
      K.readRow(sign.dataset.keep).then((row) => {
        const s = row ? G.staleness(row, sign.dataset.updated || null, Date.now()) : null;
        const stale = !!(s && s.changed);
        sign.classList.toggle("is-kept", !!row && !stale);
        sign.classList.toggle("is-stale", stale);
        sign.textContent = !row ? "Keep" : stale ? "Update" : "Kept";
      });
    });
  }

  let running = false;

  function sync(policy) {
    if (running) return Promise.resolve();
    running = true;
    buttons.forEach((b) => (b.disabled = true));
    const now = Date.now();
    let failed = 0;

    const wanted =
      policy === "none"
        ? Promise.resolve([])
        : fetch("/rides/keep.json", { credentials: "same-origin", cache: "no-store" })
            .then((r) => {
              if (!r.ok) throw new Error("HTTP " + r.status);
              return r.json();
            })
            .then((body) => (body.rides || []).filter((r) => P.matches(policy, r.updatedAt, now)));

    return Promise.all([wanted, K.listRows()])
      .then(([rides, rows]) => {
        const kept = new Map(rows.map((r) => [r.slug, r]));
        const want = new Set(rides.map((r) => r.slug));

        // What the policy kept and no longer wants goes first, so a phone
        // near its quota frees space before it fills it.
        const stale = rows.filter((r) => r.via === "policy" && !want.has(r.slug));
        const todo = rides.filter((r) => {
          const row = kept.get(r.slug);
          return !row || (G.staleness(row, r.updatedAt, now) || {}).changed;
        });

        let step = Promise.resolve();
        stale.forEach((row, i) => {
          step = step.then(() => {
            say("Removing " + (i + 1) + " of " + stale.length);
            return K.forget(row).catch(() => {
              failed += 1;
            });
          });
        });
        todo.forEach((r, i) => {
          step = step.then(() => {
            say("Keeping " + (i + 1) + " of " + todo.length + " \u00b7 " + r.title);
            const row = kept.get(r.slug);
            // A hand-kept ride being refreshed stays hand-kept.
            const via = row && row.via === "hand" ? "hand" : "policy";
            return fetch("/m/" + encodeURIComponent(r.slug) + "/keep.json", {
              credentials: "same-origin",
              cache: "no-store",
            })
              .then((res) => {
                if (!res.ok) throw new Error("HTTP " + res.status);
                return res.json();
              })
              .then((m) => K.keep(m, null, via))
              .catch(() => {
                failed += 1;
              });
          });
        });
        return step;
      })
      .then(describe)
      .then(() => {
        if (failed) say(status.textContent + " \u00b7 " + failed + " could not be kept");
      })
      .catch((err) => {
        say("Could not sync: " + (err && err.message ? err.message : "unknown error"));
      })
      .then(() => {
        running = false;
        buttons.forEach((b) => (b.disabled = false));
        repaintSigns();
      });
  }

  const policy = readPolicy();
  paintPolicy(policy);
  box.hidden = false;

  buttons.forEach((b) => {
    b.addEventListener("click", () => {
      const next = b.dataset.policy;
      if (!P.isPolicy(next)) return;
      writePolicy(next);
      paintPolicy(next);
      sync(next);
    });
  });

  // On load: say what is held, and if a policy is set and we are online, bring
  // the phone up to date. A policy of None syncs nothing on load — it removes
  // only when chosen, so a rider who picked None last month and kept a ride by
  // hand since is not surprised by a sweep.
  if (policy !== "none" && navigator.onLine) sync(policy);
  else describe();
})();
