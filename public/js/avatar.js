// The avatar crop box (#99).
//
// A circular crop the rider positions and sizes, over any aspect ratio, in place
// of a server-side center crop that beheads anyone who uploads a landscape
// photo. **Outside the circle is SHADED, NOT HIDDEN**, so they can see what they
// are cutting off rather than guessing at it.
//
// **BESPOKE RATHER THAN A LIBRARY, AND THAT IS A DECISION WITH A REASON.** #99
// flags the crop library as its open question, and AGENTS.md requires human
// approval for a new dependency — so this takes the option that needs none. It
// is about 150 lines because the job is genuinely small once the geometry is
// written down: one square viewport, one image, a scale and an offset. If the
// touch handling ever proves fiddly enough to want cropperjs, that is a decision
// to make on its merits and nothing here blocks it.
//
// **THE CROP IS A HINT AND THE SERVER RE-CUTS ANYWAY.** What is posted is the
// rectangle in the SOURCE image's own pixels, and clampCrop() in
// src/account/avatar.ts puts it inside the image whatever arrives. Nothing here
// is enforcement; a browser is not a place to enforce anything.
(function () {
  "use strict";

  const root = document.getElementById("avatar-crop");
  if (!root) return;

  const input = document.getElementById("avatar-file");
  const canvas = document.getElementById("avatar-canvas");
  const openBtn = document.getElementById("avatar-open");
  const saveBtn = document.getElementById("avatar-save");
  const cancelBtn = document.getElementById("avatar-cancel");
  const removeBtn = document.getElementById("avatar-remove");
  const zoom = document.getElementById("avatar-zoom");
  const status = document.getElementById("avatar-status");
  const img = document.getElementById("avatar-current");
  if (!input || !canvas || !saveBtn || !zoom) return;

  const ctx = canvas.getContext("2d");
  // The on-screen viewport is square and the circle is inscribed in it, so one
  // number describes both. Read from the canvas rather than hardcoded so the
  // stylesheet stays in charge of the size.
  const VIEW = canvas.width;

  let image = null; // the decoded HTMLImageElement
  let scale = 1; // source pixels -> viewport pixels
  let minScale = 1;
  let offX = 0; // viewport-space translation of the image's top-left
  let offY = 0;
  let file = null;

  function say(text, bad) {
    if (!status) return;
    status.textContent = text || "";
    status.dataset.state = bad ? "error" : "";
  }

  // THE CLAMP THAT KEEPS THE CIRCLE COVERED. The image may never be dragged far
  // enough to expose a gap inside the crop square — a rider who could would get
  // an avatar with a transparent wedge in it, and the server would faithfully
  // encode the wedge. So the offset is bounded by how much image there is beyond
  // the viewport at the current scale.
  function clampOffsets() {
    const w = image.naturalWidth * scale;
    const h = image.naturalHeight * scale;
    offX = Math.min(0, Math.max(VIEW - w, offX));
    offY = Math.min(0, Math.max(VIEW - h, offY));
  }

  function draw() {
    if (!image) return;
    clampOffsets();
    ctx.clearRect(0, 0, VIEW, VIEW);
    ctx.drawImage(image, offX, offY, image.naturalWidth * scale, image.naturalHeight * scale);

    // The shade, drawn as a full-canvas fill with the circle punched out of it.
    // `evenodd` on a path holding a rect and a circle is what punches it — the
    // alternative, compositing with destination-out, would erase the photo
    // instead of dimming around it.
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.beginPath();
    ctx.rect(0, 0, VIEW, VIEW);
    ctx.arc(VIEW / 2, VIEW / 2, VIEW / 2, 0, Math.PI * 2);
    ctx.fill("evenodd");
    ctx.restore();

    // A hairline on the circle itself, so the edge is legible over a dark photo
    // where the shade alone would not read.
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(VIEW / 2, VIEW / 2, VIEW / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Viewport square -> source pixels. This is what gets posted, and it is the
  // only arithmetic in this file the server depends on.
  function cropRect() {
    return {
      x: Math.round(-offX / scale),
      y: Math.round(-offY / scale),
      size: Math.round(VIEW / scale),
    };
  }

  function fit() {
    // COVER, NOT CONTAIN. The crop square must be full at the smallest zoom, so
    // the starting scale is the one that makes the SHORTER side match the
    // viewport — with contain, a landscape photo would open with bars inside the
    // circle and the rider would have to zoom in before they could save.
    minScale = Math.max(VIEW / image.naturalWidth, VIEW / image.naturalHeight);
    scale = minScale;
    offX = (VIEW - image.naturalWidth * scale) / 2;
    offY = (VIEW - image.naturalHeight * scale) / 2;
    zoom.min = "1";
    zoom.max = "4";
    zoom.step = "0.01";
    zoom.value = "1";
    draw();
  }

  function setZoom(factor, anchorX, anchorY) {
    const next = Math.max(minScale, Math.min(minScale * 4, minScale * factor));
    if (next === scale) return;
    // Zoom about a point rather than about the origin, so the pixel under the
    // pointer stays under the pointer. Zooming about (0,0) makes the image
    // appear to slide away as it grows, which reads as broken.
    const ax = anchorX == null ? VIEW / 2 : anchorX;
    const ay = anchorY == null ? VIEW / 2 : anchorY;
    offX = ax - ((ax - offX) * next) / scale;
    offY = ay - ((ay - offY) * next) / scale;
    scale = next;
    draw();
  }

  zoom.addEventListener("input", function () {
    setZoom(Number(zoom.value));
  });

  // --- Dragging ---------------------------------------------------------------
  //
  // Pointer events rather than mouse+touch, so one code path covers a trackpad,
  // a finger and a stylus. setPointerCapture is what keeps a drag alive when the
  // pointer leaves the canvas mid-gesture.
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener("pointerdown", function (e) {
    if (!image) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    // The canvas is displayed at a CSS size that may differ from its pixel size,
    // so a pointer delta has to be scaled into canvas space or the image lags
    // behind the finger on a phone.
    const rect = canvas.getBoundingClientRect();
    const k = rect.width ? VIEW / rect.width : 1;
    offX += (e.clientX - lastX) * k;
    offY += (e.clientY - lastY) * k;
    lastX = e.clientX;
    lastY = e.clientY;
    draw();
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  canvas.addEventListener(
    "wheel",
    function (e) {
      if (!image) return;
      // Only when there is something to zoom, so the page still scrolls past a
      // crop box the rider is not using.
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const k = rect.width ? VIEW / rect.width : 1;
      const factor = (scale / minScale) * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
      setZoom(factor, (e.clientX - rect.left) * k, (e.clientY - rect.top) * k);
      zoom.value = String(scale / minScale);
    },
    { passive: false },
  );

  // --- Loading a file ---------------------------------------------------------

  // REVEALED BY SCRIPT, which is the whole progressive-enhancement contract for
  // this block: the markup ships it hidden, so a rider with no JavaScript sees
  // their current picture and no control that lies about being usable. There is
  // no honest server-side fallback for "position this circle", so the honest
  // no-script state is no upload rather than a broken one.
  if (openBtn) {
    openBtn.hidden = false;
    openBtn.addEventListener("click", function () {
      input.click();
    });
  }

  input.addEventListener("change", function () {
    const chosen = input.files && input.files[0];
    if (!chosen) return;
    file = chosen;
    const url = URL.createObjectURL(chosen);
    const next = new Image();
    next.onload = function () {
      URL.revokeObjectURL(url);
      image = next;
      root.hidden = false;
      fit();
      say("");
    };
    next.onerror = function () {
      URL.revokeObjectURL(url);
      // The server refuses an SVG by sniffing the bytes; this is only about a
      // file the BROWSER cannot decode, which is a different and friendlier
      // failure to report here than after an upload.
      say("That image could not be read.", true);
    };
    next.src = url;
  });

  cancelBtn &&
    cancelBtn.addEventListener("click", function () {
      root.hidden = true;
      image = null;
      file = null;
      input.value = "";
      say("");
    });

  saveBtn.addEventListener("click", async function () {
    if (!file || !image) return;
    saveBtn.disabled = true;
    say("Uploading…");
    const rect = cropRect();
    const data = new FormData();
    data.append("avatar", file);
    data.append("cropX", String(rect.x));
    data.append("cropY", String(rect.y));
    data.append("cropSize", String(rect.size));
    try {
      const res = await fetch("/api/profile/avatar", { method: "POST", body: data, credentials: "same-origin" });
      const out = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) return say(out.error || "That could not be uploaded.", true);
      // Swap the picture in place rather than reloading: the rider may be
      // mid-edit elsewhere on this form, and a reload would throw away anything
      // autosave has not flushed yet.
      if (img && out.url) {
        img.src = out.url;
        img.hidden = false;
        const initials = document.getElementById("avatar-initials");
        if (initials) initials.hidden = true;
      }
      if (removeBtn) removeBtn.hidden = false;
      root.hidden = true;
      image = null;
      file = null;
      input.value = "";
      say("Saved");
    } catch {
      say("That could not be uploaded.", true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  removeBtn &&
    removeBtn.addEventListener("click", async function () {
      removeBtn.disabled = true;
      try {
        const res = await fetch("/api/profile/avatar", { method: "DELETE", credentials: "same-origin" });
        if (!res.ok) return say("That could not be removed.", true);
        // A RELOAD HERE AND NOT ON UPLOAD, because removing falls BACK rather
        // than going blank: `users.avatar_url` may still hold the picture Google
        // gave them, and only the server knows whether it does. Guessing would
        // show initials to a rider who still has a Google picture.
        window.location.reload();
      } catch {
        say("That could not be removed.", true);
      } finally {
        removeBtn.disabled = false;
      }
    });
})();
