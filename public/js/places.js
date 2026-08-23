// The saved-place manager on the profile page.
//
// Organizing only: rename a place, refile it into a group, delete it, and manage
// the groups themselves. **Places are CREATED in the builder**, from "Save to my
// places" on a stop, because a place needs a pin and the builder is where the
// map is. A create-from-scratch flow here wants the address picker from roadmap
// item 19 rather than a pair of lat/lng boxes.
//
// Every write goes through /api/places as JSON. This region sits INSIDE the
// profile form but is not part of its submit — a nested <form> would be invalid
// markup and the outer submit would swallow these controls.
(function () {
  "use strict";

  const host = document.querySelector("[data-places-manager]");
  if (!host) return;

  // Mirrors esc() in map-common.js. Duplicated rather than imported because this
  // file loads on the profile page, which has no map and therefore no TBMap —
  // pulling the map bundle in for one four-line function would be the worse
  // trade.
  function esc(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  let sections = [];
  let groups = [];

  async function api(path, options) {
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
    return data;
  }

  async function load() {
    try {
      const data = await api("/api/places");
      sections = data.sections || [];
      groups = sections.filter((s) => s.group).map((s) => s.group);
      render();
    } catch (e) {
      host.innerHTML = '<p class="field-hint">Could not load your places. Reload to try again.</p>';
    }
  }

  function groupOptions(selectedId) {
    return (
      '<option value=""' +
      (selectedId == null ? " selected" : "") +
      ">No group</option>" +
      groups
        .map(
          (g) =>
            '<option value="' +
            g.id +
            '"' +
            (String(g.id) === String(selectedId) ? " selected" : "") +
            ">" +
            esc(g.name) +
            "</option>",
        )
        .join("")
    );
  }

  function placeRow(pl, groupId) {
    // The name is an input rather than text: renaming is the commonest edit and
    // making it a click-to-edit affordance would add a mode for no gain.
    return (
      '<li class="place-row" data-id="' +
      pl.id +
      '">' +
      '<input class="place-name" type="text" maxlength="255" value="' +
      esc(pl.name) +
      '" aria-label="Place name">' +
      '<select class="place-group-pick" aria-label="Group">' +
      groupOptions(groupId) +
      "</select>" +
      '<span class="place-meta">' +
      esc(pl.address || "") +
      "</span>" +
      '<button type="button" class="place-del linkbtn" data-act="delete-place">Delete</button>' +
      "</li>"
    );
  }

  function render() {
    if (!sections.length) {
      host.innerHTML =
        '<p class="field-hint">Nothing saved yet. Open a ride in the builder, and on any stop choose ' +
        "&ldquo;Save to my places&rdquo;.</p>" +
        groupAdder();
      wire();
      return;
    }

    host.innerHTML =
      sections
        .map((sec) => {
          const gid = sec.group ? sec.group.id : null;
          const head = sec.group
            ? '<div class="place-group-head">' +
              '<input class="group-name" type="text" maxlength="80" value="' +
              esc(sec.group.name) +
              '" data-group="' +
              sec.group.id +
              '" aria-label="Group name">' +
              '<button type="button" class="linkbtn" data-act="delete-group" data-group="' +
              sec.group.id +
              '">Delete group</button></div>'
            : '<div class="place-group-head"><strong>Not in a group</strong></div>';
          return (
            '<section class="place-group">' +
            head +
            '<ul class="place-list">' +
            sec.places.map((pl) => placeRow(pl, gid)).join("") +
            "</ul></section>"
          );
        })
        .join("") + groupAdder();
    wire();
  }

  function groupAdder() {
    return (
      '<div class="place-group-add">' +
      '<input type="text" maxlength="80" placeholder="New group name" data-new-group aria-label="New group name">' +
      '<button type="button" class="linkbtn" data-act="add-group">Add group</button></div>'
    );
  }

  // One delegated listener per event, rebound after each render because render()
  // replaces the whole region.
  function wire() {
    host.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => act(btn));
    });
    // `change`, not `input`: a keystroke is not a decision, and saving on every
    // one would be a request per character. Blur or Enter is when the rider has
    // finished the thought.
    // `.place-group-pick`, NOT `.place-group` — that is the SECTION's class, and
    // binding it here caught the section as well as the select. A change event
    // bubbling out of any input then arrived as `save(section)`, where
    // `closest('.place-row')` is null and the next line threw. Found in the
    // browser, not in a test; nothing automated covers this file.
    host.querySelectorAll(".place-name, .place-group-pick, .group-name").forEach((el) => {
      el.addEventListener("change", () => save(el));
    });
  }

  async function act(btn) {
    const which = btn.dataset.act;
    try {
      if (which === "add-group") {
        const input = host.querySelector("[data-new-group]");
        const name = input.value.trim();
        if (!name) return;
        await api("/api/place-groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        input.value = "";
        return load();
      }
      if (which === "delete-group") {
        // Says what actually happens. Deleting a group keeps its places — the FK
        // is `set null`, not cascade — and a rider who expects otherwise would
        // hesitate over a bare "are you sure".
        if (!window.confirm("Delete this group? The places in it are kept and become ungrouped.")) return;
        await api("/api/place-groups/" + btn.dataset.group, { method: "DELETE" });
        return load();
      }
      if (which === "delete-place") {
        const row = btn.closest(".place-row");
        const name = row.querySelector(".place-name").value;
        if (!window.confirm("Delete " + name + " from your places? Rides that already use it are unaffected.")) return;
        await api("/api/places/" + row.dataset.id, { method: "DELETE" });
        return load();
      }
    } catch (e) {
      window.alert(e.message);
    }
  }

  async function save(el) {
    try {
      if (el.classList.contains("group-name")) {
        await api("/api/place-groups/" + el.dataset.group, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: el.value.trim() }),
        });
        return load();
      }

      const row = el.closest(".place-row");
      if (!row) return;
      const id = row.dataset.id;
      const current = sections.flatMap((s) => s.places).find((p) => String(p.id) === String(id));
      if (!current) return;
      const groupSel = row.querySelector(".place-group-pick").value;
      // PUT is a full replace, so every field the row does not edit has to be
      // sent back as it was. Omitting phone, address or links here would silently
      // erase them — they are editable in the builder, not on this screen.
      await api("/api/places/" + id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: row.querySelector(".place-name").value.trim() || current.name,
          lat: current.lat,
          lng: current.lng,
          roles: current.roles || [],
          phone: current.phone || "",
          address: current.address || "",
          links: current.links || [],
          groupId: groupSel ? Number(groupSel) : null,
        }),
      });
      return load();
    } catch (e) {
      window.alert(e.message);
      load();
    }
  }

  load();
})();
