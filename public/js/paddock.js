// The Paddock — a rider's bikes, on its own tab of the account page (#319).
//
// Mirrors places.js deliberately: same delegated-listener shape, same
// save-on-change editing. It sat inside the profile form until #319 and was
// never part of its submit, so every write here goes to /api/bikes as JSON —
// except the photo, which is multipart because that is what a file input posts.
//
// RANGES ARE MILES ON THIS SIDE OF THE WIRE. The column stores meters; the API
// converts both ways so nothing here has to know that. See src/bikes/policy.ts.
(function () {
  "use strict";

  const host = document.querySelector("[data-paddock]");
  if (!host) return;

  // Mirrors esc() in places.js, duplicated for the same reason it is: the
  // profile page has no map and therefore no TBMap to import it from.
  function esc(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  let bikes = [];
  let max = 0;
  let tankUnit = "gal";

  // What the app calls things (#321), from the rider's own preset — this page
  // is about no one ride. The motorcycle words when vocab.js is absent.
  const W = (id) => (window.TBVocab ? window.TBVocab.w(id) : { vehicle: "bike", tank: "tank" }[id] || id);
  const Ws = (id) => (window.TBVocab ? window.TBVocab.many(id) : W(id) + "s");
  const Wc = (id) => {
    const s = W(id);
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  const an = (word) => (/^[aeiou]/i.test(word) ? "an " : "a ") + word;

  async function api(path, options) {
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
    return data;
  }

  function fail(message) {
    const bar = host.querySelector("[data-paddock-error]");
    if (bar) {
      bar.textContent = message;
      bar.hidden = false;
    }
  }

  async function load() {
    try {
      const data = await api("/api/bikes");
      bikes = data.bikes || [];
      max = data.max || 0;
      tankUnit = data.tankUnit || tankUnit;
      render();
    } catch (e) {
      host.innerHTML = '<p class="field-hint">Could not load your bikes. Reload to try again.</p>';
    }
  }

  // The photo slot doubles as the file input's label, so the whole frame is the
  // drop target for a click. A bike with no photo gets a silhouette rather than
  // an empty box — an empty frame reads as broken.
  function photoCell(bike) {
    const img = bike.photoUrl
      ? '<img class="bike-photo-img" src="' + esc(bike.photoUrl) + '" alt="" width="160" height="120" loading="lazy">'
      : '<span class="bike-photo-empty" aria-hidden="true">no photo</span>';
    return (
      '<div class="bike-photo">' +
      '<label class="bike-photo-frame">' +
      img +
      '<input type="file" accept="image/jpeg,image/png" data-act="photo" hidden>' +
      '<span class="visually-hidden">Photo for ' +
      esc(bike.label) +
      "</span></label>" +
      (bike.photoUrl
        ? '<button type="button" class="linkbtn" data-act="photo-clear">Remove photo</button>'
        : '<span class="field-hint">JPEG or PNG</span>') +
      "</div>"
    );
  }

  function field(bike, name, label, attrs) {
    const v = bike[name];
    return (
      '<label class="bike-field"><span>' +
      esc(label) +
      "</span>" +
      '<input data-field="' +
      name +
      '" ' +
      attrs +
      ' value="' +
      esc(v == null ? "" : v) +
      '"></label>'
    );
  }

  // THE EMPTY PADDOCK IS ONE BLANK ROW, NOT A HINT. Ziad's call, 2026-09-13
  // (#319): at least one bike should be on file — the fuel overlay and the
  // tour's fuel part both read a range — and "No bikes yet" plus an add box
  // asked for a name before showing what a bike record even is. The row is the
  // real form with no id behind it; the first field a rider commits POSTs the
  // bike and the row becomes that bike in place, without a re-render taking the
  // field they have moved on to (#188).
  const BLANK = { id: "", label: "Your first " + W("vehicle"), fuelType: "gas", isDefault: true };

  function isNew(row) {
    return row.classList.contains("is-new");
  }

  function bikeRow(bike) {
    const fuel = ["gas", "electric"]
      .map(
        (f) =>
          '<option value="' +
          f +
          '"' +
          (bike.fuelType === f ? " selected" : "") +
          ">" +
          (f === "gas" ? "Gas" : "Electric") +
          "</option>",
      )
      .join("");

    return (
      '<li class="bike' +
      (bike.id === "" ? " is-new" : "") +
      '" data-id="' +
      bike.id +
      '">' +
      photoCell(bike) +
      '<div class="bike-fields">' +
      '<p class="bike-name">' +
      esc(bike.label) +
      (bike.isDefault ? ' <span class="pill">default</span>' : "") +
      "</p>" +
      field(bike, "nickname", "Nickname", 'type="text" maxlength="80" placeholder="the orange one"') +
      field(bike, "make", "Make", 'type="text" maxlength="60"') +
      field(bike, "model", "Model", 'type="text" maxlength="80"') +
      field(bike, "year", "Year", 'type="number" min="1885" max="2100" step="1"') +
      '<label class="bike-field"><span>Fuel</span><select data-field="fuelType">' +
      fuel +
      "</select></label>" +
      field(bike, "usableRangeMi", "Range (mi)", 'type="number" min="1" step="1" placeholder="unmeasured"') +
      field(bike, "comfortRangeMi", "Comfortable (mi)", 'type="number" min="1" step="1" placeholder="unmeasured"') +
      // THE UNIT COMES FROM THE SERVER, never from a constant here. `tankUnit`
      // is the rider's own resolved preference (#270), so this file owns no
      // conversion and no opinion about gallons — the same reason the ranges
      // arrive already in miles.
      field(
        bike,
        "tank",
        Wc("tank") + " (" + esc(bike.tankUnit || tankUnit) + ")",
        'type="number" min="0.1" step="0.1" placeholder="unmeasured"',
      ) +
      "</div>" +
      '<div class="bike-actions">' +
      (bike.isDefault ? "" : '<button type="button" class="linkbtn" data-act="default">Make default</button>') +
      (bike.id === "" ? "" : '<button type="button" class="linkbtn" data-act="delete">Delete</button>') +
      "</div></li>"
    );
  }

  function render() {
    const list =
      '<ul class="bike-list">' +
      (bikes.length ? bikes.map(bikeRow).join("") : bikeRow(BLANK)) +
      "</ul>" +
      (bikes.length
        ? ""
        : '<p class="field-hint">Fill in what you know; the range is what the app plans ' +
          esc(W("fuel") || "fuel") +
          " stops around.</p>");

    // The add box stays under the blank row, for a rider who would rather name
    // a bike than fill one in.
    const adder =
      bikes.length >= max
        ? '<p class="field-hint">That is as many ' + esc(Ws("vehicle")) + " as we hold (" + max + ").</p>"
        : '<div class="bike-add">' +
          '<input type="text" maxlength="80" placeholder="Nickname or make and model" data-new-bike aria-label="New ' +
          esc(W("vehicle")) +
          '">' +
          '<button type="button" class="linkbtn" data-act="add">Add ' +
          esc(an(W("vehicle"))) +
          "</button></div>";

    host.innerHTML = '<p class="notice is-error" data-paddock-error hidden></p>' + list + adder;
    wire();
  }

  // One delegated pass, rebound after each render because render() replaces the
  // whole region — the same arrangement places.js uses.
  function wire() {
    host.querySelectorAll("[data-act]").forEach((el) => {
      const act = el.getAttribute("data-act");
      // A file input fires change, not click; everything else is a button.
      el.addEventListener(act === "photo" ? "change" : "click", () => run(el, act));
    });
    // Saved when the rider leaves the field rather than on every keystroke: a
    // PUT per character would be a write storm, and `change` already covers
    // both typing and picking from a select.
    host.querySelectorAll("[data-field]").forEach((el) => {
      el.addEventListener("change", () => save(el.closest(".bike")));
    });
  }

  function idOf(el) {
    const row = el.closest(".bike");
    return row ? row.getAttribute("data-id") : null;
  }

  // The whole bike goes up on every edit rather than a patch of one field. The
  // PUT replaces the record, so sending a subset would blank whatever was left
  // out — the same trap the feedback queue's moderation handler documents.
  function payload(row) {
    const read = (name) => {
      const el = row.querySelector('[data-field="' + name + '"]');
      return el ? el.value : "";
    };
    return {
      nickname: read("nickname"),
      make: read("make"),
      model: read("model"),
      year: read("year"),
      fuelType: read("fuelType") || "gas",
      usableRangeMi: read("usableRangeMi"),
      comfortRangeMi: read("comfortRangeMi"),
      tank: read("tank"),
    };
  }

  // A FIELD SAVE PATCHES THE ROW; IT MUST NOT RE-RENDER. This is #188, and the
  // failure was one line: `await load()` here, which rebuilds host.innerHTML and
  // therefore destroys the input the rider has just clicked into.
  //
  // The sequence is worth writing down because nothing about it is visible in
  // the code that causes it. `change` fires on BLUR, so the click that moves the
  // rider from Make to Model is what triggers the save. The PUT is async, so
  // focus has already landed on Model by the time the response arrives — and
  // then the re-render replaces Model with a new node and focus falls back to
  // <body>. Every field after the first edit therefore needed clicking twice,
  // and the second click worked because by then there was nothing left to save.
  //
  // Patching is safe here in a way it would not be on a sorted list: bikes are
  // ordered by `position`, so no field on this form can reorder the list. Only
  // the derived label can change, and that is one text node.
  function patchRow(row, bike) {
    const name = row.querySelector(".bike-name");
    if (name) {
      name.innerHTML = esc(bike.label) + (bike.isDefault ? ' <span class="pill">default</span>' : "");
    }
    // The server normalizes: a range goes miles -> meters -> miles and can come
    // back a mile off what was typed. Writing the answer back is what `load()`
    // used to do for free. The field the rider is IN is skipped — it holds their
    // cursor, and the value there is the one we just sent anyway.
    row.querySelectorAll("[data-field]").forEach((el) => {
      if (el === document.activeElement) return;
      const v = bike[el.getAttribute("data-field")];
      el.value = v == null ? "" : v;
    });
  }

  async function save(row) {
    if (!row) return;
    try {
      // The blank row's first commit creates the bike; it then IS that bike,
      // so the row takes the id and every later change is an ordinary PUT.
      const fresh = isNew(row);
      const bike = await api(fresh ? "/api/bikes" : "/api/bikes/" + row.getAttribute("data-id"), {
        method: fresh ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload(row)),
      });
      if (fresh) {
        row.classList.remove("is-new");
        row.setAttribute("data-id", String(bike.id));
        bikes.push(bike);
        const acts = row.querySelector(".bike-actions");
        if (acts) acts.innerHTML = '<button type="button" class="linkbtn" data-act="delete">Delete</button>';
        wire();
      }
      const i = bikes.findIndex((b) => String(b.id) === row.getAttribute("data-id"));
      if (i >= 0) bikes[i] = bike;
      patchRow(row, bike);
    } catch (e) {
      fail(e.message);
    }
  }

  async function run(el, act) {
    const id = idOf(el);
    try {
      if (act === "add") {
        const input = host.querySelector("[data-new-bike]");
        const typed = (input && input.value.trim()) || "";
        if (!typed) return;
        // Whatever they typed becomes the nickname. Make and model are theirs to
        // fill in after — asking for three fields before a bike exists is how a
        // ten-second job turns into a form.
        await api("/api/bikes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nickname: typed }),
        });
      } else if (act === "delete") {
        // Confirmed, unlike a ride: a bike is NOT in the recycle bin, so this
        // one really is gone.
        if (!window.confirm("Delete this " + W("vehicle") + "? This cannot be undone.")) return;
        await api("/api/bikes/" + id, { method: "DELETE" });
      } else if (act === "default") {
        await api("/api/bikes/" + id + "/default", { method: "POST" });
      } else if (act === "photo-clear") {
        await api("/api/bikes/" + id + "/photo", { method: "DELETE" });
      } else if (act === "photo") {
        const file = el.files && el.files[0];
        if (!file) return;
        if (!id) {
          fail("Fill in a field first so the " + W("vehicle") + " exists, then add its photo.");
          return;
        }
        const form = new FormData();
        form.append("photo", file);
        await api("/api/bikes/" + id + "/photo", { method: "POST", body: form });
      }
      await load();
    } catch (e) {
      fail(e.message);
    }
  }

  load();
})();
