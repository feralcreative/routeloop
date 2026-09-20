// The sneak peek on the sign-in page: the sign that opens it and the player's
// shell. public/js/replay.js fills the shell from /tour/replay.json; see the
// header of that file and utils/record-tour-replay.ts for what a replay is.
//
// SERVER-RENDERED AND JSX-ESCAPED, the alphaSplash()/releaseNotesModal()
// arrangement: the shell is markup the page always carries, and the script
// only ever writes the recording's own copy into it. The sign ships `hidden`
// because the player needs script; replay.js un-hides it once it has wired
// the dialog, so with script off the page is exactly what it was.
//
// A native <dialog>, opened with showModal(): the role, aria-modal, the focus
// trap, Escape and the backdrop come free, and it lands in the top layer above
// the splash's video and scrim. Two <img> layers crossfade by class; the mask
// is one SVG whose two paths replay.js writes — a dim over everything but the
// box, and the ring around it.

/** The sign beside the Google button. Hidden until replay.js wires it. */
export function replaySign(): string {
  return (
    <button type="button" class="btn replay-open" data-replay-open hidden>
      Sneak peek
    </button>
  ).toString()
}

/** The player. Empty until opened; the recorded viewport's size is set once
 *  the manifest arrives. */
export function replayDialog(): string {
  return (
    <dialog class="replay" id="replay" aria-labelledby="replay-title" data-state="closed">
      <div class="replay-stage">
        <div class="replay-frame" style="--fw:1280;--fh:800">
          <img class="replay-img" alt="" decoding="async" />
          <img class="replay-img" alt="" decoding="async" />
          <svg class="replay-mask is-empty" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 1280 800">
            <path class="replay-dim" d="" />
            <path class="replay-ring" d="" />
          </svg>
        </div>
        {/* Shown only on a phone, where the pan crops Google's own attribution
            out of the frame. On a desktop the frame is whole and carries it. */}
        <p class="replay-credit">Map imagery ©&nbsp;Google</p>
        <p class="replay-loading">Loading the preview…</p>
        <p class="replay-failed">The preview did not load. Try again in a moment.</p>
      </div>
      <section class="replay-card" data-corner="br">
        <div class="replay-progress" aria-hidden="true">
          <i></i>
        </div>
        <p class="replay-where" hidden></p>
        <h2 class="replay-title" id="replay-title">
          Sneak peek
        </h2>
        <div class="replay-text"></div>
        <ol class="replay-parts" hidden></ol>
        <p class="replay-page"></p>
        <div class="replay-acts">
          <button type="button" class="btn btn-quiet" data-replay-back disabled>
            Back
          </button>
          <button type="button" class="btn btn-quiet" data-replay-exit>
            Exit
          </button>
          <button type="button" class="btn" data-replay-next autofocus>
            Next
          </button>
        </div>
      </section>
      <p class="replay-live visually-hidden" aria-live="polite"></p>
    </dialog>
  ).toString()
}
