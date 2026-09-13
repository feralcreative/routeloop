// The jargon table on the Preferences tab (#321): the two things the page has
// to do on its own that the forms cannot.
//
// 1. TYPING IN A CUSTOM BOX PICKS CUSTOM. Ziad's call, 2026-09-13. The radio
//    and the box are one choice, and a rider who has typed a word has made it.
// 2. THE PICKERS MOVE THE TABLE. Each row's "from your vehicle" mark sits on
//    whichever option the current preset would use, and a row that was
//    following the preset keeps following it — so picking Car ticks Trip on
//    the journey row without a reload. A power term under Pedal is switched
//    off, since there is nothing to plan fuel around.
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
    if (off || axis === "regional") return;
    const wasFollowing = row.getAttribute("data-follows");
    const checked = row.querySelector('input[type="radio"]:checked');
    row.querySelectorAll('input[type="radio"]').forEach((r) => {
      const mark = r.parentElement.querySelector("small");
      if (mark) mark.remove();
      if (word && r.value === word.one) {
        const small = document.createElement("small");
        small.textContent = " · from your vehicle";
        r.parentElement.querySelector("span").appendChild(small);
        if (checked && wasFollowing !== null && checked.value === wasFollowing) r.checked = true;
      }
    });
    row.setAttribute("data-follows", word ? word.one : "");
  }

  function markAll() {
    const preset = presetWords();
    rows.forEach((row) => markRow(row, preset));
  }

  // Seed each row's "following" value from what the server rendered: the
  // preset's word is the first radio on a preset-bound row.
  rows.forEach((row) => {
    const first = row.querySelector('input[type="radio"]');
    if (first && row.getAttribute("data-axis") !== "regional") row.setAttribute("data-follows", first.value);
  });

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
