// The export cart (#131). A search box, a list of what you picked, and one zip.
//
// It replaced a page that rendered every ride the rider owned times every format
// it could leave as. That was a wall at a dozen rides and unusable at a hundred,
// and there was no way to take two rides at once.
//
// THE INTERACTION IS THE BUILDER'S, NOT GOOGLE'S. Debounced input, a list under
// the field, arrow keys and Enter, nothing submitted — the shape of
// #search-results in public/js/builder.js. What is NOT borrowed is its data
// source: that one asks Google Places, this one asks /api/rides/search, which
// only ever sees the rider's own rides.
//
// The list is positioned OVER what follows rather than pushing it down. A
// results list that shoves the cart around on every keystroke cannot be used
// with a mouse — the row you were reaching for has moved by the time you get
// there.
(function () {
  "use strict";

  var form = document.querySelector(".export-cart");
  var search = document.getElementById("ex-search");
  var results = document.getElementById("ex-results");
  var cartEl = document.getElementById("ex-cart");
  var cartField = document.getElementById("f-cart");
  var go = document.getElementById("ex-go");
  if (!form || !search || !results || !cartEl || !cartField || !go) return;

  var FORMATS = [];
  try {
    FORMATS = JSON.parse(form.getAttribute("data-formats") || "[]");
  } catch (e) {
    return;
  }
  if (FORMATS.length === 0) return;

  // Ride shape: { slug, title, date, format }. One ride may appear more than
  // once in different formats — the naming convention keeps those files distinct
  // by extension, so nothing collides inside the zip.
  var cart = [];
  var found = [];
  var active = -1;
  var timer = null;
  var seq = 0;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // UTC, like every other date this app prints: a day's clock is a wall clock at
  // the departure point and is never converted into the reader's zone.
  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }

  // --- Search -----------------------------------------------------------------

  function closeResults() {
    results.hidden = true;
    results.innerHTML = "";
    found = [];
    active = -1;
  }

  function renderResults() {
    if (found.length === 0) {
      results.innerHTML = '<p class="ex-empty">No rides match that.</p>';
      results.hidden = false;
      return;
    }
    results.innerHTML =
      '<ul class="ex-hits" role="listbox">' +
      found
        .map(function (r, i) {
          return (
            '<li class="ex-hit' +
            (i === active ? " is-active" : "") +
            '" role="option" aria-selected="' +
            (i === active) +
            '" data-i="' +
            i +
            '"><span class="ex-hit-title">' +
            esc(r.title) +
            '</span><span class="ex-hit-date">' +
            esc(fmtDate(r.date)) +
            "</span></li>"
          );
        })
        .join("") +
      "</ul>";
    results.hidden = false;
  }

  function run(q) {
    if (!q.trim()) return closeResults();
    // Every response carries the number of the request that asked for it, so a
    // slow answer to an old query cannot overwrite a fast answer to a new one.
    // Two keystrokes and one slow network is all it takes.
    var mine = ++seq;
    fetch("/api/export/search?q=" + encodeURIComponent(q), { headers: { Accept: "application/json" } })
      .then(function (r) {
        return r.ok ? r.json() : { rides: [] };
      })
      .then(function (data) {
        if (mine !== seq) return;
        found = data.rides || [];
        active = found.length ? 0 : -1;
        renderResults();
      })
      .catch(function () {
        if (mine === seq) closeResults();
      });
  }

  search.addEventListener("input", function () {
    clearTimeout(timer);
    var q = search.value;
    timer = setTimeout(function () {
      run(q);
    }, 200);
  });

  search.addEventListener("keydown", function (e) {
    if (e.key === "Escape") return closeResults();
    if (results.hidden || found.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : found.length - 1)) % found.length;
      renderResults();
      return;
    }
    // Enter ADDS AND DOES NOT SUBMIT. The form's submit button downloads a zip,
    // and a rider pressing Enter in a search box means "that one", not "I am
    // finished" — this is the whole reason the results list is not a <form> of
    // its own.
    if (e.key === "Enter") {
      e.preventDefault();
      if (found[active]) add(found[active]);
    }
  });

  results.addEventListener("click", function (e) {
    var hit = e.target.closest(".ex-hit");
    if (hit) add(found[Number(hit.getAttribute("data-i"))]);
  });

  // A click anywhere else closes the list. `mousedown` rather than `click`, so
  // the list is gone before a click on the page behind it lands.
  document.addEventListener("mousedown", function (e) {
    if (!results.hidden && !results.contains(e.target) && e.target !== search) closeResults();
  });

  // --- The cart ---------------------------------------------------------------

  function add(ride) {
    if (!ride) return;
    // The same ride in the same format twice is a duplicate file in one zip, so
    // the first format is the default and adding again is a no-op the rider can
    // see: the row is already there.
    var already = cart.some(function (c) {
      return c.slug === ride.slug && c.format === FORMATS[0].format;
    });
    if (!already) cart.push({ slug: ride.slug, title: ride.title, date: ride.date, format: FORMATS[0].format });
    search.value = "";
    closeResults();
    renderCart();
    search.focus();
  }

  function renderCart() {
    cartEl.innerHTML = cart
      .map(function (c, i) {
        return (
          '<li class="ex-row" data-i="' +
          i +
          '"><span class="ex-row-title">' +
          esc(c.title) +
          '</span><span class="ex-row-date">' +
          esc(fmtDate(c.date)) +
          '</span><label class="ex-row-format"><span class="visually-hidden">Format for ' +
          esc(c.title) +
          '</span><select data-i="' +
          i +
          '">' +
          FORMATS.map(function (f) {
            return (
              '<option value="' +
              esc(f.format) +
              '"' +
              (f.format === c.format ? " selected" : "") +
              ">" +
              esc(f.label) +
              "</option>"
            );
          }).join("") +
          '</select></label><button type="button" class="ex-remove" data-remove="' +
          i +
          '"><span class="visually-hidden">Remove ' +
          esc(c.title) +
          "</span>✕</button></li>"
        );
      })
      .join("");
    go.disabled = cart.length === 0;
    go.textContent = cart.length > 1 ? "Download " + cart.length + " files" : "Download";
  }

  cartEl.addEventListener("change", function (e) {
    var i = Number(e.target.getAttribute("data-i"));
    if (cart[i]) cart[i].format = e.target.value;
  });

  cartEl.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-remove]");
    if (!btn) return;
    cart.splice(Number(btn.getAttribute("data-remove")), 1);
    renderCart();
  });

  form.addEventListener("submit", function (e) {
    if (cart.length === 0) return e.preventDefault();
    cartField.value = JSON.stringify(
      cart.map(function (c) {
        return { slug: c.slug, format: c.format };
      }),
    );
  });

  renderCart();
})();
