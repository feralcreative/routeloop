// The import drop box. Progressive enhancement over the form in
// src/routes/import.tsx — that form posts a plain multipart body and works with
// this file absent, blocked or broken, which is why nothing here is required to
// complete an import.
//
// What it adds is the part a rider should not have to type: filenames written by
// this app's export already say which trip they belong to, which day they are
// and when that day starts, so dropping a folder fills the form in from what the
// files already know. See public/js/filename.js for the convention, and
// src/maps/filename.ts for why it is shaped that way.
//
// It shows what it read rather than acting on it silently. A misread day order
// discovered here costs one glance; discovered in the builder it costs a rebuild.
(function () {
  "use strict";

  var TBF = window.TBFilename;
  var form = document.querySelector(".import-form");
  var input = document.getElementById("f-route");
  var zone = document.getElementById("dropzone");
  var panel = document.getElementById("import-plan");
  var titleField = document.getElementById("f-title");
  var submit = form && form.querySelector('button[type="submit"]');
  if (!TBF || !form || !input || !zone || !panel || !titleField || !submit) return;

  var SUBMIT_LABEL = submit.textContent;

  // Whether the trip name in the box was put there by us. A rider's own typing
  // outranks anything read off a filename and must survive a re-drop — the same
  // distinction the builder's end-time field draws with its endManual flag, and
  // for the same reason: inferring it by comparison breaks the moment the
  // inputs change.
  var titleAuto = false;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // UTC to match how the server reads these dates back off the filename, and how
  // the roadbook renders them. Local formatting here would show a rider one day
  // in this list and a different one on the printed sheet.
  function fmtDate(d) {
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  }

  function fmtTime(d) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  }

  function row(f, n) {
    var day = f.day != null ? "d" + String(f.day).padStart(2, "0") : "—";
    var when = "—";
    if (f.date) when = fmtDate(f.date) + (f.hasTime ? " " + fmtTime(f.date) : "");
    // The day's name, in the same precedence the server applies: a title read
    // off the filename is a guess and is marked as one by being the fallback.
    var name = f.title ? TBF.titleFromSlug(f.title) : "Day " + (n + 1);
    return (
      '<li class="plan-row' +
      (f.conforming ? "" : " is-plain") +
      '">' +
      '<span class="plan-day">' +
      esc(day) +
      "</span>" +
      '<span class="plan-when">' +
      esc(when) +
      "</span>" +
      '<span class="plan-name">' +
      esc(name) +
      "</span>" +
      '<span class="plan-ext">.' +
      esc(f.ext || "?") +
      "</span>" +
      "</li>"
    );
  }

  function notes(plan, zips) {
    var out = [];
    if (zips > 0) {
      out.push(
        zips === 1
          ? "One archive—its days are read when it uploads."
          : zips + " archives—their days are read when they upload.",
      );
    }
    if (plan.files.length > 0 && !plan.allConforming) {
      out.push(
        plan.files.some(function (f) {
          return f.conforming;
        })
          ? "Some of these do not follow the naming convention, so they import in the order shown."
          : "These do not follow the naming convention, so they import in the order shown.",
      );
    }
    if (plan.reordered) out.push("Reordered by day number.");
    if (plan.rideConflict) out.push("Heads up: these files name different rides. They will import as one.");
    return out;
  }

  function render() {
    var files = Array.prototype.slice.call(input.files || []);
    if (files.length === 0) {
      panel.hidden = true;
      panel.innerHTML = "";
      submit.textContent = SUBMIT_LABEL;
      return;
    }

    // A zip's contents cannot be read here without shipping a zip reader to the
    // browser for a preview. The server expands it; this says so rather than
    // showing an archive as though it were one day.
    var zips = 0;
    var names = [];
    files.forEach(function (f) {
      if (/\.zip$/i.test(f.name)) zips++;
      else names.push(f.name);
    });

    var plan = TBF.planImport(names);

    if (plan.ride && (titleAuto || !titleField.value.trim())) {
      titleField.value = plan.ride;
      titleAuto = true;
    }

    var noteList = notes(plan, zips);
    panel.innerHTML =
      '<p class="plan-head">' +
      esc(String(files.length)) +
      (files.length === 1 ? " file" : " files") +
      (plan.ride ? ' from <strong class="plan-ride">' + esc(plan.ride) + "</strong>" : "") +
      "</p>" +
      (names.length ? '<ol class="plan-list">' + plan.files.map(row).join("") + "</ol>" : "") +
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

    var days = names.length + zips;
    submit.textContent = zips > 0 ? SUBMIT_LABEL : "Import " + days + (days === 1 ? " day" : " days");
  }

  // A rider who edits the name owns it from then on.
  titleField.addEventListener("input", function () {
    titleAuto = false;
  });

  input.addEventListener("change", render);

  // dragover must be cancelled or the browser navigates to the dropped file,
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
    // Assigning the FileList wholesale rather than rebuilding it through a
    // DataTransfer: the server sorts by day field, so the order here does not
    // need to be the final order and there is nothing to rearrange.
    input.files = dropped;
    render();
  });

  // The whole zone opens the picker, so the box is not decoration around a
  // control that still has to be hit exactly. Clicks on the input itself are
  // left alone or this would recurse.
  zone.addEventListener("click", function (e) {
    if (e.target !== input) input.click();
  });

  zone.hidden = false;
  render();
})();
