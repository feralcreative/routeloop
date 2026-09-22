// The jargon table on the Preferences tab (#321): what the page has to do on
// its own that the forms cannot.
//
// 1. TYPING IN THE CUSTOM BOX PICKS CUSTOM. Ziad's call, 2026-09-13. The radio
//    and the box are one choice, and a rider who has typed a word has made it.
// 2. THE PICKERS MOVE THE TABLE. Each row's default pill carries the word the
//    current preset would use, so picking Car turns Ride into Trip on the
//    journey row without a reload; which pill is ticked is the rider's own and
//    is never touched. A power term under Pedal is switched off, since there is
//    nothing to plan fuel around. (Until 2026-09-21 each row was a pill for
//    every preset's word with a "default" mark that moved between them; it is
//    the default pill and Custom now — Ziad's call.)
//
// Saving stays autosave.js's job: the three forms carry `data-autosave` like
// every other setting, and this only touches the DOM between saves. The
// preset words are worked out by public/js/vocab.js against the same table the
// server renders from, so the two cannot disagree about which word is which.
(function () {
  "use strict";

  const table = document.querySelector("[data-jargon]");
  if (!table || !window.TBVocab || !window.TBVocabData) return;

  const rows = Array.from(table.querySelectorAll("tr[data-term]"));

  // Which radio each row is currently following, by value. A row whose checked
  // radio is not the preset's word has been chosen by hand and stays put.
  function presetWords() {
    const d = window.TBVocabData;
    return window.TBVocab.resolve(d.terms, { vehicle: d.profile.vehicle, power: d.profile.power, jargon: {} }, null);
  }

  function markRow(row, preset) {
    const term = row.getAttribute("data-term");
    const axis = row.getAttribute("data-axis");
    const word = preset[term];
    const off = axis === "power" && word === null;
    row.classList.toggle("is-off", off);
    // A regional row has no preset; its default is its first option and the
    // server rendered it.
    if (off || axis === "regional") return;
    const cell = row.querySelector(".jargon-word");
    if (cell && word) cell.textContent = window.TBVocab.cap(word.one);
  }

  // The Default column's head says which pair the words come from —
  // "(Motorcycle, Gas)" — read off the pickers' own checked labels so it
  // cannot say something the radios do not.
  function markHead() {
    const head = table.querySelector(".jargon-preset");
    if (!head) return;
    const pick = (name) => {
      const r = document.querySelector('[data-jargon-preset] input[name="' + name + '"]:checked');
      const label = r && r.closest(".choice") && r.closest(".choice").querySelector(".choice-label");
      return label ? label.textContent.trim() : "";
    };
    head.textContent = "(" + pick("vehicle") + ", " + pick("power") + ")";
  }

  function markAll() {
    const preset = presetWords();
    rows.forEach((row) => markRow(row, preset));
    markHead();
  }

  // THE POWER FOLLOWS THE VEHICLE, GRAYED RATHER THAN GONE. Ziad's call,
  // 2026-09-21: a power the vehicle cannot use — Pedal under a motorcycle or a
  // car, Gas under a bicycle — is disabled, so the option is still there to be
  // read and the vehicle is the one thing to change. One direction only: gating
  // the vehicles on the power as well was built first and was too convoluted.
  // The rule is toPower()'s own; the server renders the same gate for first
  // paint (account-page.tsx), and the vehicle branch below moves the checked
  // power when the new vehicle cannot use it, as the server does.
  function gate() {
    const d = window.TBVocabData;
    document.querySelectorAll('[data-jargon-preset] input[name="power"]').forEach((r) => {
      r.disabled = window.TBVocab.toPower(r.value, d.profile.vehicle) !== r.value;
    });
  }
  gate();

  // A preset picker changed: update the data the whole page reads, drop
  // vocab.js's cache, and move the table. The box the rider is in is left
  // alone — this touches radios and marks, never a text field.
  document.querySelectorAll("[data-jargon-preset]").forEach((form) => {
    form.addEventListener("change", (e) => {
      const input = e.target;
      if (!(input instanceof HTMLInputElement) || input.type !== "radio") return;
      const d = window.TBVocabData;
      if (input.name === "vehicle") {
        d.profile.vehicle = input.value;
        d.profile.power = window.TBVocab.toPower(d.profile.power, input.value);
        // Bicycle coerces Gas to Pedal server-side too; show that here so the
        // Power picker does not claim a pair the row will not store.
        const powerForm = document.querySelector(
          '[data-jargon-preset] input[name="power"][value="' + d.profile.power + '"]',
        );
        if (powerForm) powerForm.checked = true;
      } else if (input.name === "power") {
        d.profile.power = window.TBVocab.toPower(input.value, d.profile.vehicle);
        if (d.profile.power !== input.value) {
          const fixed = form.querySelector('input[name="power"][value="' + d.profile.power + '"]');
          if (fixed) fixed.checked = true;
        }
      }
      window.TBVocab.forget();
      gate();
      markAll();
    });
  });

  // Typing picks Custom; the change event the box fires afterwards is what
  // queues the save, through autosave.js like everything else.
  table.addEventListener("input", (e) => {
    const box = e.target;
    if (!(box instanceof HTMLInputElement) || box.type !== "text") return;
    const custom = box.closest(".jargon-pick--custom");
    const radio = custom && custom.querySelector('input[type="radio"]');
    if (radio && box.value.trim()) radio.checked = true;
  });
})();
