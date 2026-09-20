// The sneak peek on the sign-in page: the guided tour, replayed from a
// recording. Loaded on /login only.
//
// **A RECORDING, NOT THE TOUR.** The live tour (tour.js) is a real planning
// session on a real ride behind a real sign-in, and none of that can be
// offered to a visitor. utils/record-tour-replay.ts drove it once and wrote
// /tour/replay.json: one frame per card, the box the card pointed at as a
// fraction of the viewport, and the card's own copy. This file puts the ring
// and the card back over each frame. Nothing here is live and nothing is
// pressed but Back, Next, and Exit.
//
// **THE DIALOG IS A NATIVE <dialog> AND showModal() DOES THE WORK**: the
// role, aria-modal, the focus trap, Escape, inertness for the page behind it,
// and the ::backdrop. Same door errorDialog() in builder.js uses. The shell is
// server-rendered by src/views/replay.tsx and this file only fills it.
//
// **THE MASK IS ONE EVEN-ODD SVG PATH IN FRAME PIXELS**: the frame's rect
// minus a rounded rect per box, padded by the manifest's `pad` at its
// `radius` — the live overlay's construction under a new name — with a
// non-scaling stroke so the ring is three pixels at any size. The SVG's
// viewBox is the recorded viewport, so the path is written once in the
// recorder's coordinates and scales with the frame.
//
// **A PHONE PANS THE FRAME; A DESKTOP SHOWS IT WHOLE.** At phone width the
// frame is kept at its recorded size and translated and scaled so the card's
// box fills the width — `fit()`, pure and tested. On a desktop the frame is
// contained in the stage and the card floats in the first corner that does
// not cover the box — `corner()`, likewise.
//
// The manifest is fetched on the first open, never on page load: the sign-in
// page is the app's front door and this is a sideshow.
(function () {
  "use strict";

  var FADE_MS = 350;
  var MAX_SCALE = 3;
  var CARD_MARGIN_PX = 16;
  // The bottom corners sit clear of the attribution strip along a frame's
  // bottom edge, which Google requires to stay visible.
  var CARD_BOTTOM_PX = 40;

  var dialog = document.getElementById("replay");
  var opener = document.querySelector("[data-replay-open]");
  var url = window.TB && window.TB.replay;
  if (!dialog || !opener || !url || typeof dialog.showModal !== "function") {
    exportApi();
    return;
  }

  // The view is what the frame is fitted to; the caption floats in the stage
  // around it and, on a phone, below it.
  var stage = dialog.querySelector(".replay-view");
  var frameEl = dialog.querySelector(".replay-frame");
  var imgs = dialog.querySelectorAll(".replay-img");
  var maskSvg = dialog.querySelector(".replay-mask");
  var dimPath = dialog.querySelector(".replay-dim");
  var ringPath = dialog.querySelector(".replay-ring");
  var card = dialog.querySelector(".replay-card");
  var progress = dialog.querySelector(".replay-progress i");
  var where = dialog.querySelector(".replay-where");
  var titleEl = dialog.querySelector(".replay-title");
  var textEl = dialog.querySelector(".replay-text");
  var partsEl = dialog.querySelector(".replay-parts");
  var backBtn = dialog.querySelector("[data-replay-back]");
  var nextBtn = dialog.querySelector("[data-replay-next]");
  var exitBtn = dialog.querySelector("[data-replay-exit]");
  var live = dialog.querySelector(".replay-live");
  var pageEl = dialog.querySelector(".replay-page");

  var manifest = null;
  var loading = null;
  var i = 0;
  var front = 0;
  var showSeq = 0;

  opener.hidden = false;

  function load() {
    if (loading) return loading;
    loading = fetch(url, { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("replay " + r.status);
        return r.json();
      })
      .then(function (m) {
        if (!m || !m.steps || !m.steps.length) throw new Error("replay: empty manifest");
        manifest = m;
        return m;
      });
    loading.catch(function () {
      loading = null;
    });
    return loading;
  }

  function frameUrl(step) {
    return manifest.base + step.frame;
  }

  function preload(n) {
    if (!manifest || n < 0 || n >= manifest.steps.length) return;
    var im = new Image();
    im.decoding = "async";
    im.src = frameUrl(manifest.steps[n]);
  }

  // The steps a rider counts through: everything but the chooser card.
  function counted() {
    return manifest.steps.filter(function (s) {
      return !s.chooser;
    });
  }

  function partOf(step) {
    if (!step.part) return null;
    for (var k = 0; k < manifest.parts.length; k++) if (manifest.parts[k].n === step.part) return manifest.parts[k];
    return null;
  }

  function phone() {
    return window.matchMedia("(max-width: 767px)").matches;
  }

  // Two paths in frame pixels: the dim is the whole frame minus a rounded
  // rect per box (even-odd), and the ring is those rects alone, stroked.
  function maskFor(step) {
    var W = manifest.viewport.w;
    var H = manifest.viewport.h;
    var holes = "";
    var boxes = [];
    if (step.box) boxes.push(step.box);
    (step.extra || []).forEach(function (b) {
      boxes.push(b);
    });
    boxes.forEach(function (b) {
      var pad = manifest.pad;
      var r = manifest.radius;
      var x = b.x * W - pad;
      var y = b.y * H - pad;
      var w = b.w * W + pad * 2;
      var h = b.h * H + pad * 2;
      holes += roundedRect(x, y, w, h, Math.min(r, w / 2, h / 2));
    });
    return { dim: "M0 0H" + W + "V" + H + "H0Z" + holes, ring: holes, W: W, H: H, any: boxes.length > 0 };
  }

  function roundedRect(x, y, w, h, r) {
    var arc = "A" + r + " " + r + " 0 0 1 ";
    return [
      "M" + (x + r) + " " + y,
      "H" + (x + w - r),
      arc + (x + w) + " " + (y + r),
      "V" + (y + h - r),
      arc + (x + w - r) + " " + (y + h),
      "H" + (x + r),
      arc + x + " " + (y + h - r),
      "V" + (y + r),
      arc + (x + r) + " " + y,
      "Z",
    ].join("");
  }

  function pageWord(page) {
    switch (page) {
      case "profile":
        return "Your account";
      case "roster":
        return "The ride’s riders";
      case "riders":
        return "Riders";
      case "viewer":
        return "The ride’s page";
      default:
        return "The builder";
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function partsHtml() {
    return manifest.parts
      .map(function (p) {
        var n = '<b class="replay-part-n">' + p.n + "</b>";
        var name = '<span class="replay-part-name">' + esc(p.name) + "</span>";
        var blurb = '<span class="replay-part-blurb">' + p.blurb + "</span>";
        return '<li class="replay-part replay-part-' + p.n + '">' + n + name + blurb + "</li>";
      })
      .join("");
  }

  function show(n) {
    if (!manifest) return;
    n = Math.max(0, Math.min(manifest.steps.length - 1, n));
    i = n;
    var seq = ++showSeq;
    var step = manifest.steps[n];
    var part = partOf(step);
    var list = counted();
    var k = list.indexOf(step);
    var last = n === manifest.steps.length - 1;

    // The image lands on the back layer and is brought forward once decoded,
    // so a slow frame never shows half-painted; CSS owns the fade.
    var back = imgs[1 - front];
    back.src = frameUrl(step);
    var painted = back.decode ? back.decode().catch(function () {}) : Promise.resolve();
    painted.then(function () {
      if (seq !== showSeq) return;
      imgs[front].classList.remove("is-front");
      back.classList.add("is-front");
      front = 1 - front;
    });

    var m = maskFor(step);
    maskSvg.setAttribute("viewBox", "0 0 " + m.W + " " + m.H);
    dimPath.setAttribute("d", m.dim);
    ringPath.setAttribute("d", m.ring);
    maskSvg.classList.toggle("is-empty", !m.any);

    // The card. Our own copy, so innerHTML; it may carry <b>.
    where.textContent = part ? "Part " + part.n + " · " + part.name : "";
    titleEl.textContent = step.title;
    textEl.innerHTML = "<p>" + step.text + "</p>";
    pageEl.textContent = pageWord(step.page);
    if (step.chooser) {
      partsEl.innerHTML = partsHtml();
      partsEl.hidden = false;
    } else {
      partsEl.hidden = true;
    }
    for (var p = 1; p <= 5; p++) dialog.classList.toggle("replay-part-" + p, (part ? part.n : 1) === p);
    // The live tour's arithmetic: this card over the counted ones, so the
    // first card already shows a sliver and the chooser shows none.
    progress.style.width = k < 0 ? "0" : Math.round(((k + 1) / list.length) * 100) + "%";

    backBtn.disabled = n === 0;
    nextBtn.textContent = last ? "Done" : step.chooser ? "Start" : "Next";
    nextBtn.setAttribute("data-last", last ? "1" : "");

    live.textContent = part
      ? "Part " +
        part.n +
        " of " +
        manifest.parts.length +
        ", card " +
        (k + 1) +
        " of " +
        list.length +
        ": " +
        step.title
      : step.title;

    place(step);
    preload(n + 1);
    preload(n - 1);
  }

  // Where the card goes and how the frame sits, decided from the live sizes.
  function place(step) {
    if (phone()) {
      var f = fit(
        { w: stage.clientWidth, h: stage.clientHeight },
        { w: manifest.viewport.w, h: manifest.viewport.h },
        step.box,
        manifest.pad,
        MAX_SCALE,
      );
      frameEl.style.setProperty("--s", f.s);
      frameEl.style.setProperty("--tx", f.tx);
      frameEl.style.setProperty("--ty", f.ty);
      card.setAttribute("data-corner", "");
      return;
    }
    frameEl.style.removeProperty("--s");
    frameEl.style.removeProperty("--tx");
    frameEl.style.removeProperty("--ty");
    // The box in stage pixels: the frame is contained and centered.
    var fr = frameEl.getBoundingClientRect();
    var st = stage.getBoundingClientRect();
    var scale = fr.width / manifest.viewport.w;
    var box = step.box
      ? {
          x: fr.left - st.left + step.box.x * manifest.viewport.w * scale,
          y: fr.top - st.top + step.box.y * manifest.viewport.h * scale,
          w: step.box.w * manifest.viewport.w * scale,
          h: step.box.h * manifest.viewport.h * scale,
        }
      : null;
    var c = corner(
      { w: st.width, h: st.height },
      { w: card.offsetWidth, h: card.offsetHeight },
      box,
      CARD_MARGIN_PX,
      CARD_BOTTOM_PX,
    );
    card.setAttribute("data-corner", c);
  }

  /**
   * How a phone shows a frame: the scale and translation that put the card's
   * box across the stage's width, clamped so no edge shows a gap and the
   * frame is never blown up past `maxScale`. No box means the whole frame
   * fitted to the width. Pure; test/replay.test.ts pins it.
   */
  function fit(stageSize, frameSize, box, pad, maxScale) {
    var fitW = stageSize.w / frameSize.w;
    var s = fitW;
    if (box) s = stageSize.w / (box.w * frameSize.w + pad * 2);
    s = Math.max(fitW, Math.min(maxScale || MAX_SCALE, s));
    var tx = 0;
    var ty = 0;
    var scaledW = frameSize.w * s;
    var scaledH = frameSize.h * s;
    if (box) {
      var cx = (box.x + box.w / 2) * frameSize.w * s;
      var cy = (box.y + box.h / 2) * frameSize.h * s;
      tx = stageSize.w / 2 - cx;
      ty = stageSize.h / 2 - cy;
    }
    // No gap at any edge: the frame must cover the stage where it can.
    tx = Math.min(0, Math.max(stageSize.w - scaledW, tx));
    if (scaledH >= stageSize.h) ty = Math.min(0, Math.max(stageSize.h - scaledH, ty));
    else ty = (stageSize.h - scaledH) / 2;
    return { s: round(s), tx: round(tx), ty: round(ty) };
  }

  /**
   * The first of bottom-right, bottom-left, top-right, top-left whose card
   * rect does not cover the box. Bottom-right when nothing is pointed at,
   * and when every corner covers it. Pure; test/replay.test.ts pins it.
   */
  function corner(stageSize, cardSize, box, margin, bottom) {
    var order = ["br", "bl", "tr", "tl"];
    if (!box) return order[0];
    for (var n = 0; n < order.length; n++) {
      var r = cornerRect(order[n], stageSize, cardSize, margin, bottom == null ? margin : bottom);
      if (!overlaps(r, box)) return order[n];
    }
    return order[0];
  }

  function cornerRect(c, stageSize, cardSize, margin, bottom) {
    var x = c[1] === "r" ? stageSize.w - margin - cardSize.w : margin;
    var y = c[0] === "b" ? stageSize.h - bottom - cardSize.h : margin;
    return { x: x, y: y, w: cardSize.w, h: cardSize.h };
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  // ——— Opening and closing ———

  // The backdrop is held through TBSplash while the dialog is open: the
  // splash plays two <video>s in turn, and pausing "the" one would leave the
  // other running behind the player.
  function open() {
    dialog.setAttribute("data-state", "loading");
    if (window.TBSplash) window.TBSplash.pause();
    dialog.showModal();
    load().then(
      function () {
        dialog.setAttribute("data-state", "ready");
        frameEl.style.setProperty("--fw", manifest.viewport.w);
        frameEl.style.setProperty("--fh", manifest.viewport.h);
        show(i);
        nextBtn.focus();
      },
      function () {
        dialog.setAttribute("data-state", "failed");
        exitBtn.focus();
      },
    );
  }

  function close(reset) {
    if (reset) i = 0;
    if (dialog.open) dialog.close();
  }

  dialog.addEventListener("close", function () {
    if (window.TBSplash) window.TBSplash.resume();
    opener.focus();
  });

  opener.addEventListener("click", open);
  backBtn.addEventListener("click", function () {
    show(i - 1);
  });
  nextBtn.addEventListener("click", function () {
    if (nextBtn.getAttribute("data-last")) close(true);
    else show(i + 1);
  });
  exitBtn.addEventListener("click", function () {
    close(false);
  });

  dialog.addEventListener("keydown", function (e) {
    if (!manifest || dialog.getAttribute("data-state") !== "ready") return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
      case "PageDown":
      case " ":
        if (e.target !== nextBtn || e.key !== " ") {
          e.preventDefault();
          nextBtn.click();
        }
        break;
      case "ArrowLeft":
      case "ArrowUp":
      case "PageUp":
        e.preventDefault();
        if (i > 0) show(i - 1);
        break;
    }
  });

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    if (!dialog.open || !manifest) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      place(manifest.steps[i]);
    }, 80);
  });

  exportApi();

  // Declared, so it is hoisted for the early return above — the arithmetic
  // is exported even where the page has no dialog, which is what the test
  // harness reads.
  function exportApi() {
    window.TBReplay = { fit: fit, corner: corner, FADE_MS: FADE_MS };
  }
})();
