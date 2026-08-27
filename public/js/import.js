// The import review table. Progressive enhancement over the form in
// src/routes/import.tsx — that form posts a plain multipart body and works with
// this file absent, blocked or broken, which is why nothing here is required to
// complete an import.
//
// WHAT IT IS FOR, in one line: guess harder, then let the rider correct the
// guess. Filenames written by this app's export already say which ride they
// belong to, which day they are and when that day starts, so dropping a folder
// fills the form in from what the files already know — and #129 is the other
// half of that bargain, because a guess a rider cannot correct is worse than no
// guess at all. A misread day order discovered here costs one edit; discovered
// in the builder it costs a rebuild.
//
// See public/js/filename.js for the convention, src/maps/filename.ts for why it
// is shaped that way, and src/maps/manifest.ts for what the corrections mean on
// the server.
//
// THE FILES NEVER LEAVE THE PAGE UNTIL THE RIDER COMMITS. Ziad's call,
// 2026-08-26: there is no staging upload, no stage id and no temp directory —
// the review runs entirely on what the browser already holds, and Import posts
// the files and the manifest together in one body. The cost is stated rather
// than hidden: **a zip cannot be reviewed**, because nothing unzips in the
// browser, so an archive's row says so and its days are read on the way in.
(function () {
  "use strict";

  var TBF = window.TBFilename;
  var form = document.querySelector(".import-form");
  var input = document.getElementById("f-route");
  var zone = document.getElementById("dropzone");
  var panel = document.getElementById("import-plan");
  var titleField = document.getElementById("f-title");
  var manifestField = document.getElementById("f-manifest");
  var submit = form && form.querySelector('button[type="submit"]');
  if (!TBF || !form || !input || !zone || !panel || !titleField || !manifestField || !submit) return;

  var SUBMIT_LABEL = submit.textContent;

  // Whether the ride name in the box was put there by us. A rider's own typing
  // outranks anything read off a filename and must survive a re-drop — the same
  // distinction the builder's end-time field draws with its endManual flag, and
  // for the same reason: inferring it by comparison breaks the moment the
  // inputs change.
  var titleAuto = false;

  // THE MODEL, NOT THE DOM. Every edit writes here and the row is re-rendered
  // from it, which is the same rule the builder's panel follows and for the same
  // reason: reordering rows moves their inputs, and a value living only in an
  // input is a value a move can lose. Each row is
  // { file, name, ext, title, date, time, zip, conforming }.
  var rows = [];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // UTC to match how the server reads these dates back off the filename, how the
  // manifest is parsed, and how every surface in the app renders a day's clock.
  // A day's time is a wall clock at the departure point — 9am means 9am where
  // the bike is — so nothing here converts it into the reader's own zone.
  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function dateValue(d) {
    return d ? d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) : "";
  }

  function timeValue(d, hasTime) {
    return d && hasTime ? pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) : "";
  }

  // --- Building the model -----------------------------------------------------

  function build() {
    var files = Array.prototype.slice.call(input.files || []);
    var names = [];
    var zips = [];
    files.forEach(function (f) {
      if (/\.zip$/i.test(f.name)) zips.push(f);
      else names.push(f);
    });

    var plan = TBF.planImport(
      names.map(function (f) {
        return f.name;
      }),
    );

    // planImport() sorts by day number where every file carries one, and its
    // `index` is the position the file arrived in — which is what maps a planned
    // row back to its File after that sort.
    rows = plan.files.map(function (p) {
      return {
        file: names[p.index],
        name: p.fileName,
        ext: p.ext || "",
        title: p.title ? TBF.titleFromSlug(p.title) : "",
        // WHETHER THE NAME IN THE BOX IS OURS OR THE RIDER'S, and it is the same
        // distinction titleAuto draws for the ride name above. The box is
        // pre-filled from the filename, so without this every row would post a
        // title as though it had been typed — and a typed title outranks the
        // file's own <trk><name>, which the browser cannot read. Importing one
        // file with JavaScript on and off would then give it two different day
        // names. Measured, not theorized: a GPX whose track is named
        // "Oakland to Mt Shasta" came in as "Oakland To Mt Shasta", capitalised
        // by titleFromSlug out of the filename.
        titleAuto: true,
        date: dateValue(p.date),
        time: timeValue(p.date, p.hasTime),
        zip: false,
        conforming: p.conforming,
      };
    });

    // Archives last, and always last: their contents are unknown here, so there
    // is no position for them to hold among rows that know their day number.
    zips.forEach(function (f) {
      rows.push({ file: f, name: f.name, ext: "zip", title: "", date: "", time: "", zip: true, conforming: false });
    });

    if (plan.ride && (titleAuto || !titleField.value.trim())) {
      titleField.value = plan.ride;
      titleAuto = true;
    }

    return plan;
  }

  // --- Notes ------------------------------------------------------------------

  function duplicateNames() {
    var seen = {};
    var dupes = {};
    rows.forEach(function (r) {
      var key = r.name.toLowerCase();
      if (seen[key]) dupes[key] = true;
      seen[key] = true;
    });
    return dupes;
  }

  function notes(plan) {
    var out = [];
    var zips = rows.filter(function (r) {
      return r.zip;
    }).length;
    if (zips > 0) {
      out.push(
        zips === 1
          ? "One archive—its days are read when it uploads, so it cannot be reviewed here."
          : zips + " archives—their days are read when they upload, so they cannot be reviewed here.",
      );
    }
    var plain = rows.filter(function (r) {
      return !r.zip && !r.conforming;
    }).length;
    if (plain > 0 && !plan.allConforming) {
      out.push(
        plain === rows.length
          ? "These do not follow the naming convention, so nothing was read off them. Name the days below."
          : "Some of these do not follow the naming convention. What was read off the rest is filled in below.",
      );
    }
    if (plan.reordered) out.push("Reordered by day number.");
    if (plan.rideConflict) out.push("Heads up: these files name different rides. They will import as one.");
    if (Object.keys(duplicateNames()).length > 0) {
      out.push("Two files with the same name—check you did not add one twice.");
    }
    // A DATE COLLISION IS NOT AN ERROR, and this says so rather than flagging it
    // like one: two days of one ride genuinely can start on the same date, and a
    // rider who did that on purpose should not be told they are wrong.
    var dates = rows
      .filter(function (r) {
        return r.date;
      })
      .map(function (r) {
        return r.date;
      });
    if (dates.length > 1 && new Set(dates).size !== dates.length) out.push("Two days share a date.");
    return out;
  }

  // --- Rendering --------------------------------------------------------------

  function rowHtml(r, i, dupes, last) {
    var dupe = dupes[r.name.toLowerCase()];
    return (
      '<li class="plan-row' +
      (r.conforming ? "" : " is-plain") +
      (r.zip ? " is-zip" : "") +
      (dupe ? " is-dupe" : "") +
      '" data-i="' +
      i +
      '">' +
      // A grip, not a button: the drag is the mouse path and the two arrows
      // below are the keyboard one. Item 16's rule, and it is why those arrows
      // are real controls rather than a nicety — a drag handle cannot be
      // operated from a keyboard at all.
      '<span class="plan-grip" aria-hidden="true">⠿</span>' +
      '<span class="plan-day">' +
      (r.zip ? "—" : "Day " + (i + 1)) +
      "</span>" +
      (r.zip
        ? '<span class="plan-zip-name">' + esc(r.name) + "</span>"
        : '<label class="plan-field"><span class="visually-hidden">Name for ' +
          esc(r.name) +
          '</span><input type="text" class="plan-title" data-i="' +
          i +
          '" maxlength="150" placeholder="' +
          esc(r.name) +
          '" value="' +
          esc(r.title) +
          '" autocomplete="off"></label>' +
          '<label class="plan-field plan-field--date"><span class="visually-hidden">Date for ' +
          esc(r.name) +
          '</span><input type="date" class="plan-date" data-i="' +
          i +
          '" value="' +
          esc(r.date) +
          '"></label>' +
          '<label class="plan-field plan-field--time"><span class="visually-hidden">Start time for ' +
          esc(r.name) +
          '</span><input type="time" class="plan-time" data-i="' +
          i +
          '" value="' +
          esc(r.time) +
          '"></label>') +
      '<span class="plan-ext">.' +
      esc(r.ext || "?") +
      "</span>" +
      '<span class="plan-actions">' +
      '<button type="button" class="plan-btn" data-move="-1" data-i="' +
      i +
      '"' +
      (i === 0 ? " disabled" : "") +
      ' title="Move up"><span class="visually-hidden">Move ' +
      esc(r.name) +
      " up</span>↑</button>" +
      '<button type="button" class="plan-btn" data-move="1" data-i="' +
      i +
      '"' +
      (last ? " disabled" : "") +
      ' title="Move down"><span class="visually-hidden">Move ' +
      esc(r.name) +
      " down</span>↓</button>" +
      '<button type="button" class="plan-btn plan-drop" data-drop="' +
      i +
      '" title="Leave this file out"><span class="visually-hidden">Leave ' +
      esc(r.name) +
      " out</span>✕</button>" +
      "</span>" +
      "</li>"
    );
  }

  function render(plan) {
    if (rows.length === 0) {
      panel.hidden = true;
      panel.innerHTML = "";
      manifestField.value = "";
      submit.textContent = SUBMIT_LABEL;
      return;
    }

    var dupes = duplicateNames();
    var noteList = notes(plan);
    var days = rows.length;

    panel.innerHTML =
      '<p class="plan-head"><span class="plan-count">' +
      esc(String(days)) +
      (days === 1 ? " file" : " files") +
      (plan.ride ? ' from <strong class="plan-ride">' + esc(plan.ride) + "</strong>" : "") +
      '</span><span class="plan-hint">Drag to reorder. Edit anything that looks wrong.</span>' +
      "</p>" +
      '<ol class="plan-list" id="plan-list">' +
      rows
        .map(function (r, i) {
          return rowHtml(r, i, dupes, i === rows.length - 1);
        })
        .join("") +
      "</ol>" +
      (noteList.length
        ? '<ul class="plan-notes">' +
          noteList
            .map(function (n) {
              return "<li>" + esc(n) + "</li>";
            })
            .join("") +
          "</ul>"
        : "");
    panel.hidden = false;

    initDrag(document.getElementById("plan-list"));

    var zips = rows.filter(function (r) {
      return r.zip;
    }).length;
    submit.textContent = zips > 0 ? SUBMIT_LABEL : "Import " + days + (days === 1 ? " day" : " days");
  }

  // Re-render without re-reading the files, for an edit that changed the model.
  var lastPlan = { ride: null, allConforming: true, reordered: false, rideConflict: false, files: [] };
  function refresh() {
    render(lastPlan);
  }

  function reload() {
    lastPlan = build();
    render(lastPlan);
  }

  // --- Editing ----------------------------------------------------------------

  // Delegated, because every row is re-rendered on any structural change and a
  // listener bound to a row would go with it.
  panel.addEventListener("input", function (e) {
    var el = e.target;
    var i = Number(el.getAttribute("data-i"));
    var r = rows[i];
    if (!r) return;
    // NO RE-RENDER ON A KEYSTROKE. The model is updated in place and the DOM is
    // already showing what the rider typed — re-rendering here would rebuild the
    // input under the cursor and lose the caret position on every character.
    if (el.classList.contains("plan-title")) {
      r.title = el.value;
      r.titleAuto = false;
    } else if (el.classList.contains("plan-date")) r.date = el.value;
    else if (el.classList.contains("plan-time")) r.time = el.value;
  });

  panel.addEventListener("click", function (e) {
    var move = e.target.closest("[data-move]");
    if (move) {
      var from = Number(move.getAttribute("data-i"));
      var to = from + Number(move.getAttribute("data-move"));
      if (to < 0 || to >= rows.length) return;
      rows.splice(to, 0, rows.splice(from, 1)[0]);
      refresh();
      // Focus follows the row, or a rider moving a file three places has to find
      // the button again after every press.
      var moved = panel.querySelector('[data-move="' + move.getAttribute("data-move") + '"][data-i="' + to + '"]');
      if (moved && !moved.disabled) moved.focus();
      else {
        var other = panel.querySelector(
          '[data-move="' + -Number(move.getAttribute("data-move")) + '"][data-i="' + to + '"]',
        );
        if (other) other.focus();
      }
      return;
    }

    var drop = e.target.closest("[data-drop]");
    if (drop) {
      rows.splice(Number(drop.getAttribute("data-drop")), 1);
      refresh();
    }
  });

  // A rider who edits the name owns it from then on.
  titleField.addEventListener("input", function () {
    titleAuto = false;
  });

  // --- Drag to reorder --------------------------------------------------------

  // SortableJS, the same pinned copy the builder uses. If the CDN fails this
  // returns quietly and the two arrows on every row are still the whole
  // capability — which is also the keyboard path, because a drag handle is not
  // one.
  function initDrag(listEl) {
    if (!listEl || !window.Sortable) return;
    if (listEl._sortable) listEl._sortable.destroy();
    listEl._sortable = window.Sortable.create(listEl, {
      draggable: ".plan-row",
      // `handle` rather than `filter`, so the row's own inputs are never part of
      // a drag gesture and need none of the preventOnFilter dance the builder
      // needs — a click into a text field here is an ordinary click.
      handle: ".plan-grip",
      animation: 150,
      ghostClass: "is-dragging",
      forceFallback: true,
      fallbackClass: "plan-drag-ghost",
      fallbackOnBody: true,
      delay: 200,
      delayOnTouchOnly: true,
      onEnd: function (evt) {
        if (evt.oldIndex === evt.newIndex) return;
        rows.splice(evt.newIndex, 0, rows.splice(evt.oldIndex, 1)[0]);
        refresh();
      },
    });
  }

  // --- Committing -------------------------------------------------------------

  // The manifest is built from what is ACTUALLY IN THE INPUT after the rebuild,
  // never from the model alone. src/maps/manifest.ts requires one entry per
  // posted file, in order, names matching — so if the rebuild below did not take,
  // the manifest describes the real list rather than the intended one and the
  // server applies the edits to the right files.
  function manifestFor(files) {
    return files.map(function (f) {
      var r =
        rows.find(function (row) {
          return row.file === f;
        }) || null;
      return {
        fileName: f.name,
        // Only a name the rider actually typed. An untouched box is an
        // unanswered question, so the server falls back to what the FILE says
        // its day is called — see the note in build() above.
        title: r && !r.zip && !r.titleAuto ? r.title.trim() : "",
        // A time with no date is not a start, so it is dropped rather than being
        // stamped onto a date the rider never gave.
        startAt: r && !r.zip && r.date ? (r.time ? r.date + "T" + r.time : r.date) : "",
      };
    });
  }

  form.addEventListener("submit", function (e) {
    if (rows.length === 0) return;

    var wanted = rows.map(function (r) {
      return r.file;
    });

    // REBUILDING THE FILE INPUT IS WHAT MAKES A DROPPED ROW ACTUALLY NOT UPLOAD,
    // and what makes the rider's order the posted order. A FileList cannot be
    // edited, so a DataTransfer is built and assigned wholesale.
    //
    // Verified rather than assumed: if the assignment does not take — an old
    // browser, or a policy that refuses it — the input still holds the original
    // selection, and a manifest describing the intended list would be refused by
    // the server for names that do not line up. Reading the input back is what
    // keeps this degrading to "imports in the order shown" instead of failing.
    try {
      var dt = new DataTransfer();
      wanted.forEach(function (f) {
        dt.items.add(f);
      });
      input.files = dt.files;
    } catch (err) {
      /* falls through to whatever the input still holds */
    }

    var posted = Array.prototype.slice.call(input.files || []);
    if (posted.length === 0) {
      e.preventDefault();
      return;
    }
    manifestField.value = JSON.stringify(manifestFor(posted));
  });

  // --- The drop zone ----------------------------------------------------------

  input.addEventListener("change", reload);

  // dragover must be canceled or the browser navigates to the dropped file,
  // which loses the form and looks like a crash.
  ["dragenter", "dragover"].forEach(function (evt) {
    zone.addEventListener(evt, function (e) {
      e.preventDefault();
      zone.classList.add("is-over");
    });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    zone.addEventListener(evt, function (e) {
      e.preventDefault();
      zone.classList.remove("is-over");
    });
  });

  zone.addEventListener("drop", function (e) {
    var dropped = e.dataTransfer && e.dataTransfer.files;
    if (!dropped || dropped.length === 0) return;
    input.files = dropped;
    reload();
  });

  // The whole zone opens the picker, so the box is not decoration around a
  // control that still has to be hit exactly. Clicks on the input itself are
  // left alone or this would recurse.
  zone.addEventListener("click", function (e) {
    if (e.target !== input) input.click();
  });

  zone.hidden = false;
  reload();
})();
