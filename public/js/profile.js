// Resolves both address blocks to coordinates so the builder never has to
// geocode. The form works fine without this: a failed or skipped lookup just
// leaves the hidden coordinate fields empty, and the server stores the address
// as text.
//
// Goes through POST /api/geocode rather than calling a provider directly. The
// key that may call Geocoding is IP-restricted to the server, so a browser
// cannot use it — the same reason POST /api/route exists. This is what retired
// the last Mapbox dependency.
(function () {
  "use strict";

  const form = document.querySelector(".profile-form");
  if (!form) return;

  // Two addresses now: home, and the public starting point a shared ride begins
  // from instead. They geocode identically, so the whole thing is a factory
  // rather than two copies that drift.
  const BLOCKS = [
    {
      fields: ["addressLine", "city", "state", "postalCode"],
      lat: "f-homeLat",
      lng: "f-homeLng",
      status: "geocode-status",
      lookup: "f-homeLookup",
      label: "f-homeLabel",
    },
    {
      fields: ["startAddressLine", "startCity", "startState", "startPostalCode"],
      lat: "f-startLat",
      lng: "f-startLng",
      status: "start-geocode-status",
      lookup: "f-startLookup",
      label: "f-startLabel",
    },
  ];

  function wire(block) {
    const status = document.getElementById(block.status);
    const latEl = document.getElementById(block.lat);
    const lngEl = document.getElementById(block.lng);
    const parts = block.fields.map((n) => document.getElementById("f-" + n));
    if (!status || !latEl || !lngEl || parts.some((el) => !el)) return;

    // The address the current coordinates belong to. Lets an untouched form keep
    // the saved coordinates instead of re-fetching them on every page load.
    let resolvedFor = parts.map((el) => el.value.trim()).join(", ");
    let timer = null;
    let seq = 0;

    function query() {
      return parts
        .map((el) => el.value.trim())
        .filter(Boolean)
        .join(", ");
    }

    function clearCoords(message) {
      latEl.value = "";
      lngEl.value = "";
      status.textContent = message || "";
    }

    async function resolve() {
      const q = query();
      if (q === resolvedFor) return;

      // Too little to be worth a lookup, and a stale coordinate pair must not
      // survive the address being emptied.
      if (q.length < 6) {
        resolvedFor = q;
        clearCoords("");
        return;
      }

      // Out-of-order responses would otherwise let a slow earlier request
      // overwrite a fast later one.
      const mine = ++seq;
      status.textContent = "Looking up address…";

      try {
        const res = await fetch("/api/geocode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: q }),
        });
        if (mine !== seq) return;

        // 404 is "no match", which is a normal answer rather than a failure: the
        // address is still saved as text and the rider is told so.
        if (res.status === 404) {
          resolvedFor = q;
          clearCoords("Could not place that address. It will still be saved as text.");
          return;
        }
        if (!res.ok) throw new Error("geocode failed: " + res.status);

        const hit = await res.json();
        if (mine !== seq) return;

        lngEl.value = String(hit.lng);
        latEl.value = String(hit.lat);
        resolvedFor = q;
        status.textContent = "Matched: " + (hit.label || q);
      } catch (e) {
        if (mine !== seq) return;
        resolvedFor = q;
        clearCoords("Address lookup is unavailable right now. It will still be saved as text.");
      }
    }

    parts.forEach(function (el) {
      el.addEventListener("blur", function () {
        clearTimeout(timer);
        timer = setTimeout(resolve, 150);
      });
    });

    // Catches someone who fills the last field and submits without leaving it. The
    // lookup is not awaited — blocking a save on a network call is exactly the
    // failure mode this whole file is written to avoid.
    form.addEventListener("submit", function () {
      clearTimeout(timer);
    });
  }

  BLOCKS.forEach(wire);

  // --- Place lookup -----------------------------------------------------------
  //
  // A Google Places search above each block: a business, a landmark or an
  // address. Picking one fills the name (when it is a named place and the name is
  // still empty), the four address fields and the coordinates, then saves the
  // block. It replaced the Geocoding dropdown on the address line, which could
  // only ever match street addresses.
  //
  // ONE SESSION TOKEN PER LOOKUP: every keystroke carries it and the Details call
  // that resolves the pick closes it, so Google bills the lookup as one session.
  function newSession() {
    return (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, "");
  }

  function suggestions(block) {
    const line = document.getElementById(block.lookup);
    if (!line) return;
    const wrap = line.closest(".addr-lookup");
    if (wrap) wrap.hidden = false;
    const status = document.getElementById(block.status);

    const list = document.createElement("ul");
    list.className = "addr-suggest";
    list.setAttribute("role", "listbox");
    list.id = block.lookup + "-list";
    list.hidden = true;
    line.setAttribute("role", "combobox");
    line.setAttribute("aria-expanded", "false");
    line.setAttribute("aria-autocomplete", "list");
    line.setAttribute("aria-controls", list.id);
    line.insertAdjacentElement("afterend", list);

    let items = [];
    let active = -1;
    let timer = null;
    let seq = 0;
    let session = newSession();

    function close() {
      list.hidden = true;
      list.replaceChildren();
      line.setAttribute("aria-expanded", "false");
      line.removeAttribute("aria-activedescendant");
      items = [];
      active = -1;
    }

    function mark(i) {
      active = i;
      Array.prototype.forEach.call(list.children, function (li, n) {
        li.classList.toggle("is-active", n === i);
        li.setAttribute("aria-selected", n === i ? "true" : "false");
      });
      if (i >= 0 && list.children[i]) line.setAttribute("aria-activedescendant", list.children[i].id);
      else line.removeAttribute("aria-activedescendant");
    }

    async function post(url, body) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) throw new Error(data.error || "place lookup failed");
      return data;
    }

    // FILLS EVERY FIELD THE RESULT KNOWS AND LEAVES ALONE THE ONES IT DOES NOT:
    // an empty component means "no answer", not "clear what the rider typed".
    async function choose(item) {
      close();
      if (status) status.textContent = "Looking up " + item.main + "…";
      let hit;
      try {
        hit = await post("/api/places/details", { id: item.id, session: session });
      } catch (e) {
        if (status) status.textContent = e.message;
        return;
      } finally {
        session = newSession();
      }
      const map = {};
      map[block.fields[0]] = hit.parts && hit.parts.addressLine;
      map[block.fields[1]] = hit.parts && hit.parts.city;
      map[block.fields[2]] = hit.parts && hit.parts.state;
      map[block.fields[3]] = hit.parts && hit.parts.postalCode;
      Object.keys(map).forEach(function (name) {
        const el = document.getElementById("f-" + name);
        if (el && map[name]) el.value = map[name];
      });
      const labelEl = document.getElementById(block.label);
      if (labelEl && hit.name && !labelEl.value.trim()) labelEl.value = hit.name;
      const latEl = document.getElementById(block.lat);
      const lngEl = document.getElementById(block.lng);
      if (latEl) latEl.value = String(hit.lat);
      if (lngEl) lngEl.value = String(hit.lng);
      if (status) status.textContent = "Matched: " + hit.label;
      line.value = "";
      // The pick is what commits an address; one listener owns that save.
      line.dispatchEvent(new Event("addr:chosen", { bubbles: true }));
    }

    function render(hits) {
      items = hits;
      list.replaceChildren();
      hits.forEach(function (hit, i) {
        const li = document.createElement("li");
        li.id = block.lookup + "-suggest-" + i;
        li.className = "addr-suggest-item";
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", "false");
        const main = document.createElement("strong");
        main.textContent = hit.main;
        li.appendChild(main);
        if (hit.secondary) li.appendChild(document.createTextNode(" " + hit.secondary));
        li.addEventListener("mousedown", function (e) {
          // mousedown, not click: the input blurs before a click lands.
          e.preventDefault();
          choose(hit);
        });
        list.appendChild(li);
      });
      list.hidden = hits.length === 0;
      line.setAttribute("aria-expanded", hits.length > 0 ? "true" : "false");
      mark(-1);
    }

    async function look() {
      const q = line.value.trim();
      if (q.length < 3) return close();
      const mine = ++seq;
      try {
        const data = await post("/api/places/autocomplete", { q: q, session: session });
        if (mine !== seq) return;
        render(data.suggestions || []);
      } catch (e) {
        if (mine !== seq) return;
        close();
        if (status) status.textContent = e.message;
      }
    }

    line.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(look, 250);
    });

    line.addEventListener("keydown", function (e) {
      // Enter in the lookup never submits the form: it is not a field.
      if (e.key === "Enter" && (list.hidden || active < 0)) {
        e.preventDefault();
        return;
      }
      if (list.hidden || items.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mark((active + 1) % items.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        mark(active <= 0 ? items.length - 1 : active - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        choose(items[active]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });

    line.addEventListener("blur", function () {
      setTimeout(close, 120);
    });
  }

  BLOCKS.forEach(suggestions);

  // --- Autosave (#100) -------------------------------------------------------
  //
  // The form saved on a button, so a rider who edited a field and navigated away
  // lost it silently. This flushes to POST /api/profile after a pause and on
  // blur, and the button stays as the no-JS path — it is not removed, it is
  // relabeled by the indicator beside it.
  //
  // **WHAT IS NOT AUTOSAVED, and it is most of the interesting part.**
  //
  // The USERNAME field. Claiming a name writes username_history and holds it, so
  // an idle timer firing mid-typing would claim "zia" before the rider finishes
  // "ziad" — and the name they wanted is then taken by their own keystroke.
  //
  // The two ADDRESS BLOCKS. Autosave and the geocoder both act on a pause in
  // typing: a rider who stops to read a suggestion would get "123 Ma" saved and
  // geocoded underneath them. #101 takes those fields over on a SELECTION
  // trigger, which is the only event that means "this is the address I want".
  //
  // The server enforces all of this too — it ignores any field not on its own
  // list — so a hand-crafted request cannot autosave a username either.
  const EXCLUDED = /^(username|addressLine|city|state|postalCode|start[A-Z]|home(Lat|Lng))/;

  const status = document.getElementById("profile-autosave");
  if (!status) return;

  const IDLE_MS = 1200;
  let timer = null;
  let inFlight = false;
  let again = false;

  // THE STATE IS ON THE GROUP AS WELL AS THE LINE, since 2026-09-07. Ziad's call:
  // each question group carries a thin border saying where it is — amber unsaved
  // and while saving, green saved, red only when a save actually failed. The
  // status line stays because it is the only thing that can name WHICH field was
  // refused, which a border cannot.
  //
  // WHICH GROUPS LIGHT UP IS TRACKED RATHER THAN GUESSED. The profile is ONE form
  // posting every watched field at once, so "the group that changed" is not
  // something the response can say — `dirty` is collected as the rider types and
  // the whole set resolves together on the answer.
  const dirtyGroups = new Set();

  // SETTLE, so a page of green borders does not accumulate. The state is worth
  // seeing and not worth keeping — same reason the ride's own Saved chip fades.
  const SETTLE_MS = 2000;
  let settle = null;

  function paintGroups(state) {
    clearTimeout(settle);
    dirtyGroups.forEach(function (g) {
      g.dataset.save = state;
    });
    if (state === "saved") {
      const done = Array.from(dirtyGroups);
      dirtyGroups.clear();
      settle = setTimeout(function () {
        done.forEach(function (g) {
          delete g.dataset.save;
        });
      }, SETTLE_MS);
    }
  }

  function say(state, text) {
    status.dataset.state = state;
    status.textContent = text;
    paintGroups(state);
  }

  function watched(el) {
    return el.name && !EXCLUDED.test(el.name) && el.type !== "submit" && el.type !== "hidden";
  }

  // The field's own error line, placed the way the server-rendered one is so the
  // two look identical. NEVER focuses and never rewrites the input — a rider is
  // still typing in it, and moving their caret or reverting their text to make a
  // point about validation is worse than the invalid value.
  function showError(name, message) {
    const input = form.elements[name];
    if (!input || !input.closest) return;
    const field = input.closest(".field");
    if (!field) return;
    let line = field.querySelector(".field-error-live");
    if (!message) {
      if (line) line.remove();
      input.removeAttribute("aria-invalid");
      return;
    }
    if (!line) {
      line = document.createElement("p");
      line.className = "field-error field-error-live";
      field.appendChild(line);
    }
    line.textContent = message;
    input.setAttribute("aria-invalid", "true");
  }

  async function flush() {
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    say("saving", "Saving…");

    const data = new FormData();
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!watched(el)) return;
      if (el.type === "checkbox") {
        if (el.checked) data.append(el.name, "on");
      } else if (el.type === "radio") {
        if (el.checked) data.append(el.name, el.value);
      } else {
        data.append(el.name, el.value);
      }
    });
    // Says "I sent every checkbox", so the server can read an absent one as
    // unchecked rather than as "not included in this partial save".
    data.append("_flags", "1");

    try {
      const res = await fetch("/api/profile", { method: "POST", body: data, credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      const out = await res.json();
      Array.prototype.forEach.call(form.elements, function (el) {
        if (watched(el) && el.type !== "checkbox" && el.type !== "radio") showError(el.name, null);
      });
      const bad = Object.keys(out.errors || {});
      bad.forEach(function (name) {
        showError(name, out.errors[name]);
      });
      // THE PARTIAL CASE IS THE INTERESTING ONE and it is reported honestly:
      // some fields were written and some were not, and saying only "Saved"
      // would be a lie about the ones that were refused.
      if (bad.length > 0) say("error", bad.length === 1 ? "One field not saved" : bad.length + " fields not saved");
      else say("saved", "Saved");
    } catch {
      // Nothing is reverted and nothing is cleared. The rider's text is still in
      // the form and the button below still works, which is the whole fallback.
      say("error", "Not saved—use the button");
    } finally {
      inFlight = false;
      if (again) {
        again = false;
        flush();
      }
    }
  }

  function queue() {
    say("dirty", "Unsaved changes");
    clearTimeout(timer);
    timer = setTimeout(flush, IDLE_MS);
  }

  form.addEventListener("input", function (e) {
    if (!watched(e.target)) return;
    // The fieldset the edit happened in, so the border lands on the group the
    // rider is actually looking at rather than on all of them.
    const group = e.target.closest(".profile-form > fieldset");
    if (group) dirtyGroups.add(group);
    queue();
  });

  // THE ADDRESS BLOCK'S OWN COMMIT (#101), and it is the only thing that writes
  // those fields without the button.
  //
  // A pick from the suggestion list is the one event that means "this is the
  // address I want" — which is exactly what the idle timer cannot know, and why
  // the address fields are excluded from it. So the address save is a full form
  // POST rather than the partial autosave: the fields are interdependent (a city
  // without its postal code is worse than neither) and the server's own
  // whole-form handler already knows how to write them together, coordinates
  // included.
  form.addEventListener("addr:chosen", function () {
    say("saving", "Saving…");
    // Submitted rather than fetched, because the whole-form handler redirects and
    // re-renders — which is what shows the rider the parsed, normalized address
    // it actually stored. The page reload is the confirmation.
    form.submit();
  });
  form.addEventListener("change", function (e) {
    if (!watched(e.target)) return;
    // A checkbox fires `change` and not `input`, so the group has to be picked
    // up here too or the share flags save with no border.
    const group = e.target.closest(".profile-form > fieldset");
    if (group) dirtyGroups.add(group);
    queue();
  });
  // On blur as well as on the timer, so leaving a field commits it rather than
  // waiting out the pause — the case #100 names is a rider who edits and
  // navigates away.
  form.addEventListener(
    "focusout",
    function (e) {
      if (watched(e.target) && timer) {
        clearTimeout(timer);
        flush();
      }
    },
    true,
  );

  // A pending flush must not be lost to a navigation. Not awaited and not
  // preventing the unload — a confirm dialog on a profile edit is worse than the
  // edit, and the timer is 1.2s so the window is small.
  window.addEventListener("pagehide", function () {
    if (timer) {
      clearTimeout(timer);
      flush();
    }
  });
})();
