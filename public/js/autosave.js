// Group autosave for the Settings tab.
//
// Ziad's call, 2026-09-07: every option on Settings and Profile saves itself,
// the Save buttons go, and each question group carries a thin border that says
// where it is — amber unsaved, amber while saving, green saved, then back to
// neutral. Red is NOT the unsaved color: `error` already owns red, and a failed
// save is the one state a rider must not mistake for anything else. Amber is
// advice and red is a verdict, which is the app's own vocabulary.
//
// **IT POSTS THE FORM'S OWN ACTION, SO THERE IS NO NEW ENDPOINT.** Each settings
// form already has a handler that writes one column and redirects; this sends
// the same body to the same place with `fetch` and ignores the redirect. Nothing
// server-side changed, which also means a group whose handler is added later
// autosaves the moment it carries the attribute.
//
// **THE BUTTONS ARE HIDDEN HERE, NOT DELETED IN THE MARKUP.** With JavaScript
// off the page is exactly what it was: six plain forms, six Save buttons, six
// POSTs. profile.tsx's header records that a settings page should not stop
// working without script, and this keeps that true for three lines.
//
// **THE PROFILE TAB IS NOT DRIVEN FROM HERE.** It has had its own autosave since
// #100 and it saves the WHOLE form to one endpoint; profile.js drives the same
// border states from there. Two mechanisms because they are two shapes — one
// form per question here, one form for everything there — and merging them would
// mean the profile posting six times for one edit.
(() => {
  "use strict";

  // Long enough that typing is not a write per keystroke, short enough that a
  // rider who changes a radio and looks away sees it land. Matches profile.js.
  const IDLE_MS = 1200;
  // How long "Saved" stays green before the group goes quiet again. The state
  // is worth seeing and not worth keeping — a page of green borders says
  // nothing, which is the same reason the ride's own Saved chip fades.
  const SETTLE_MS = 2000;

  // THE SAME WORDS THE BUILDER USES, AND THAT IS THE POINT OF COPYING THEM.
  // `SAVE_TEXT` in builder.js says "Saving…" and "Saved" for a ride; a rider who
  // has learned what those mean on one surface should not have to learn a second
  // vocabulary for the other. The two lists are not shared in code — this file
  // loads on every chrome page and builder.js does not load at all outside the
  // builder — so they are two copies on purpose, and the words are what has to
  // stay in step rather than the object.
  //
  // `dirty` is worded rather than left blank because the amber border appears at
  // that moment: an edge that changes color with nothing saying why is the thing
  // a readout exists to answer.
  const SAVE_TEXT = {
    dirty: "Unsaved changes",
    saving: "Saving…",
    saved: "Saved",
    error: "Not saved",
  };

  // WHAT A SAVED SETTING CHANGES ON <html>, AND WHY IT HAS TO.
  //
  // The palettes all live in one stylesheet keyed on these attributes, and
  // layout.tsx stamps them server-side — so the old form POST repainted the page
  // by RELOADING it. Autosave removed the reload, which meant picking Dark saved
  // the choice and changed nothing on screen. Re-stamping is the whole fix: no
  // stylesheet is refetched, the browser just re-resolves the custom properties.
  //
  // THE "STAMP NOTHING" VALUE IS PART OF THE TABLE, mirroring layout.tsx exactly.
  // `default` is the bare `:root` block, and `system` for scheme and motion is
  // load-bearing rather than tidy: there is no `data-scheme="system"` rule and
  // there cannot be one, because the server does not know the reader's OS
  // setting — the ABSENCE is what lets prefers-color-scheme answer. Stamping the
  // word would match nothing and pin the rider to light.
  const STAMP = {
    theme: { attr: "data-theme", bare: "default" },
    scheme: { attr: "data-scheme", bare: "system" },
    motion: { attr: "data-motion", bare: "system" },
    dateFormat: { attr: "data-date-format", bare: null },
    clock: { attr: "data-clock", bare: "locale" },
  };

  function restamp(form) {
    const root = document.documentElement;
    let touched = false;
    Object.keys(STAMP).forEach((name) => {
      const field = form.elements[name];
      if (!field) return;
      const value = field.value;
      if (value === undefined) return;
      const { attr, bare } = STAMP[name];
      if (value === bare) root.removeAttribute(attr);
      else root.setAttribute(attr, value);
      touched = true;
    });
    // TBFmt reads the two formatting attributes ONCE and caches, on the
    // reasoning that neither changes without a page load. That was true until
    // this function existed, so it is told to forget.
    if (touched && window.TBFmt && window.TBFmt.forget) window.TBFmt.forget();
  }

  function init(group) {
    const form = group.matches("form") ? group : group.querySelector("form");
    if (!form || !form.action) return;

    // Hidden rather than removed: with script off these are the only way to
    // save, and the markup is what makes that true.
    form.querySelectorAll("[data-js-hide]").forEach((el) => {
      el.hidden = true;
    });

    // THE READOUT IS BUILT HERE RATHER THAN RENDERED IN THE MARKUP, and that is
    // the same reasoning the hidden Save buttons carry from the other side: with
    // script off there is no autosave, so there is nothing for a readout to
    // report and a permanently blank line under every group would be furniture
    // describing a mechanism that is not running. It exists exactly when it has
    // something to say.
    //
    // It goes in `.setting-actions` — the row the Save button was hidden out of —
    // so the space is one that already existed rather than a new one, which is
    // what keeps this from adding a line to all nine groups. A form without that
    // row falls back to the form itself.
    //
    // `aria-live="polite"` and not `assertive`: a save a rider triggered by
    // ticking a box is not an interruption, and the border is the visual half of
    // the same message.
    const note = document.createElement("span");
    note.className = "save-note";
    note.setAttribute("aria-live", "polite");
    (form.querySelector(".setting-actions") || form).appendChild(note);

    // HIDDEN WHEN IT HAS NOTHING TO SAY, so `.setting-actions` goes on
    // collapsing exactly as it did — that row is keyed on having no VISIBLE
    // child, and a permanently-present readout would reserve a line under all
    // nine groups for a message that is on screen for about two seconds.
    const write = (text) => {
      note.textContent = text;
      note.hidden = text === "";
    };
    write("");

    let timer = null;
    let settle = null;
    let inFlight = false;
    let again = false;

    const say = (state) => {
      clearTimeout(settle);
      group.dataset.save = state;
      write(SAVE_TEXT[state] || "");
      // The text goes with the border, not before it. "Saved" left standing over
      // a group that has gone quiet again is a stale claim about a save that
      // happened two seconds and possibly several edits ago.
      if (state === "saved") {
        settle = setTimeout(() => {
          delete group.dataset.save;
          write("");
        }, SETTLE_MS);
      }
    };

    async function flush() {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      say("saving");
      try {
        const res = await fetch(form.action, {
          method: "POST",
          // The handler answers 303 to the page it came from. `manual` stops the
          // browser following it and fetching the whole settings page back for
          // nothing — an opaqueredirect response is the success signal.
          redirect: "manual",
          body: new FormData(form),
          credentials: "same-origin",
        });
        // An opaque redirect reports status 0 and type "opaqueredirect", which
        // is what a 303 looks like through `redirect: manual`. Treating that as
        // failure is the trap here — it is the ordinary success path.
        if (res.type !== "opaqueredirect" && !res.ok) throw new Error(String(res.status));
        // AFTER the save, not before: a palette that flips and then fails to
        // store is a page lying about what it holds.
        restamp(form);
        say("saved");
      } catch {
        // Nothing is reverted. What the rider chose is still on screen and the
        // button is still in the DOM — un-hiding it is the honest fallback,
        // because a control that failed to save itself should hand back the one
        // that does not depend on script.
        form.querySelectorAll("[data-js-hide]").forEach((el) => {
          el.hidden = false;
        });
        say("error");
      } finally {
        inFlight = false;
        if (again) {
          again = false;
          flush();
        }
      }
    }

    function queue() {
      say("dirty");
      clearTimeout(timer);
      timer = setTimeout(flush, IDLE_MS);
    }

    // `change` covers radios, checkboxes and a select, which is every control in
    // the Settings tab bar one textarea; `input` is what makes the textarea feel
    // the same as the rest rather than waiting for a blur.
    form.addEventListener("change", queue);
    form.addEventListener("input", (e) => {
      if (e.target.tagName === "TEXTAREA") queue();
    });

    // A rider who presses Save anyway — script on, button un-hidden after a
    // failure — gets the ordinary form POST, which is what it always did.
  }

  function start() {
    document.querySelectorAll("[data-autosave]").forEach(init);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
