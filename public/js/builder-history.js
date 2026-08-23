// Undo/redo and crash recovery for the ride builder.
//
// Two protections that are deliberately not the same thing:
//
//   History — recover from a mistake you made and noticed. In memory, per
//             session, lost on reload.
//   Draft   — recover from a crash, a closed tab or a dead phone, including
//             for a ride that has never been saved and has no id. Survives
//             reload; that is the whole point of it.
//
// Kept out of builder.js so it can be tested: test/builder-history.test.ts
// evals this file and drives window.TBHistory, the same trick
// test/twist-client.test.ts uses on twist.js. builder.js owns every DOM and
// map concern; nothing here touches either.
(function (window) {
  "use strict";

  // ---- Snapshots ----------------------------------------------------------
  //
  // What a snapshot copies is decided by what the builder mutates in place,
  // which is not obvious and not uniform:
  //
  //   leg.geometry   never mutated in place — always replaced wholesale, so it
  //                  is SHARED by reference. This is what makes a snapshot
  //                  cost ~50 object copies instead of ~19,000 coordinate
  //                  pairs for a long day, and what makes a 100-step stack
  //                  affordable at all.
  //   leg.viaPoints  WAS in that category and no longer is. Drag-to-shape
  //                  splices into it in place, so it must be copied like
  //                  roles. This is the same trap twice: a field is safe to
  //                  share right up until someone adds the feature that
  //                  mutates it, and nothing fails loudly when they do — the
  //                  snapshot just quietly gains the edit it was taken to
  //                  protect against.
  //   roles          the exception, and the trap. point.roles.splice() and
  //                  .push() mutate it in place, so it MUST be copied. Sharing
  //                  it would let a later role toggle reach back and rewrite
  //                  history that has already been taken.
  //   stops/pois     arrays are reversed, swapped, pushed and spliced; the
  //                  objects themselves are written field-by-field on drag and
  //                  on every keystroke. Both need copying.
  //
  // Everything else on `state` is UI or identity and is deliberately absent —
  // restoring a map handle or a marker list would fight the renderer.
  function copyDetails(d) {
    if (!d) return null;
    return { ...d, links: (d.links || []).map((l) => ({ ...l })) };
  }

  function snapshotRoute(r) {
    return {
      // Spread carries endManual, which payload() drops. Losing it would turn
      // an end time the rider typed by hand back into a derived one, silently.
      ...r,
      // roles and details are both COPIED rather than shared, and for the same
      // reason: the editor mutates them in place. roles because splice() does;
      // details because the field editor assigns into the object a field at a
      // time. Share either and undo restores a point whose contents already
      // changed underneath the snapshot — the failure is silent and looks like
      // undo simply not working on that field.
      //
      // `links` needs its own copy inside details for the same reason again: it
      // is an array the editor pushes to and splices.
      stops: (r.stops || []).map((s) => ({ ...s, roles: (s.roles || []).slice(), details: copyDetails(s.details) })),
      pois: (r.pois || []).map((p) => ({ ...p, roles: (p.roles || []).slice(), details: copyDetails(p.details) })),
      legs: (r.legs || []).map((l) => ({ ...l, viaPoints: (l.viaPoints || []).slice() })),
    };
  }

  function snapshot(state) {
    return {
      meta: { ...state.meta },
      days: (state.days || []).map(snapshotRoute),
    };
  }

  // Restoring builds fresh objects rather than handing the stored ones back.
  //
  // Two reasons, both load-bearing. A snapshot can be restored more than once
  // (undo, redo, undo again) and must not be aliased by the live state after
  // the first. And the async leg completion in builder.js guards on object
  // identity — `state.days[r] !== day` — so fresh objects make an
  // in-flight routing response discard itself. Reuse the references and a
  // response that left before the undo lands on the leg after it.
  function restore(state, snap) {
    state.meta = { ...snap.meta };
    state.days = snap.days.map(snapshotRoute);
    // Sequence numbers indexed the old days. Anything still in flight is
    // now unwanted, and a stale counter would let it through.
    state.legSeq = [];
    return state;
  }

  // ---- History ------------------------------------------------------------

  const DEFAULT_MAX = 100;

  // A stack of past states plus a redo tail. Snapshot-based rather than
  // command-based: the builder has twenty-odd mutation sites and writing an
  // inverse for each is twenty chances to write one wrong. Copying is cheap
  // here precisely because geometry is shared.
  function createHistory(opts) {
    const max = (opts && opts.max) || DEFAULT_MAX;
    const past = [];
    const future = [];
    // The field a run of keystrokes belongs to, so typing a name is one undo
    // step rather than one per character.
    let coalesceKey = null;

    return {
      // `label` names the action for the button tooltip: "Undo move stop".
      // `coalesce` groups consecutive edits to the same field — pass a stable
      // key like "name:2:0" and repeated pushes with that key fold into the
      // first, which is what stops a typed word eating twenty undo steps.
      push(snap, label, coalesce) {
        if (coalesce && coalesce === coalesceKey && past.length > 0) return;
        coalesceKey = coalesce || null;
        past.push({ snap, label: label || "change" });
        // Oldest goes first. 100 is far past any real editing session, and
        // the cap exists to bound memory rather than to be reached.
        if (past.length > max) past.shift();
        // A new edit after an undo abandons the branch that was undone, which
        // is what every editor does.
        future.length = 0;
      },
      // Undo needs the state as it is *now* to put on the redo stack — the
      // caller passes it in rather than the module holding a reference.
      undo(current) {
        if (past.length === 0) return null;
        const entry = past.pop();
        future.push({ snap: current, label: entry.label });
        coalesceKey = null;
        return entry;
      },
      redo(current) {
        if (future.length === 0) return null;
        const entry = future.pop();
        past.push({ snap: current, label: entry.label });
        coalesceKey = null;
        return entry;
      },
      canUndo: () => past.length > 0,
      canRedo: () => future.length > 0,
      undoLabel: () => (past.length ? past[past.length - 1].label : null),
      redoLabel: () => (future.length ? future[future.length - 1].label : null),
      // Typing then clicking elsewhere should not fold the click into the run.
      breakCoalesce() {
        coalesceKey = null;
      },
      depth: () => past.length,
      clear() {
        past.length = 0;
        future.length = 0;
        coalesceKey = null;
      },
    };
  }

  // ---- Draft --------------------------------------------------------------

  // Bump to invalidate every stored draft, the way site.js versions the alpha
  // splash. A draft written by an older shape must never be handed to a newer
  // builder that expects different fields.
  const DRAFT_VERSION = 1;
  const PREFIX = "routeloop.builderDraft.";
  const KEEP = 10;

  const keyFor = (rideId) => PREFIX + (rideId == null || rideId === "" ? "new" : String(rideId));

  // Private-mode Safari throws on localStorage access, so every read has to
  // degrade to "no draft" rather than taking the builder down with it.
  function safeGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function safeRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (e) {
      /* nothing to do */
    }
  }

  // Geometry is dropped on the way in, and this is the important decision in
  // the file. A 300-mile day is roughly 19,000 coordinate pairs; a multi-day
  // ride serialized whole can pass the ~5 MB origin limit and take the write
  // down with it. Legs are derived data — the router can rebuild them — while
  // the stops are the thing that cannot be recovered from anywhere. So a draft
  // keeps what is irreplaceable and re-days the rest.
  function stripped(days) {
    return (days || []).map((r) => ({
      ...r,
      stops: (r.stops || []).map((s) => ({ ...s, roles: (s.roles || []).slice() })),
      pois: (r.pois || []).map((p) => ({ ...p, roles: (p.roles || []).slice() })),
      legs: (r.legs || []).map((l) => ({
        distanceM: l.distanceM,
        durationS: l.durationS,
        viaPoints: (l.viaPoints || []).slice(),
      })),
    }));
  }

  // Newest first, so pruning can drop from the tail.
  function list() {
    const out = [];
    let n = 0;
    try {
      n = window.localStorage.length;
    } catch (e) {
      return out;
    }
    for (let i = 0; i < n; i++) {
      let k = null;
      try {
        k = window.localStorage.key(i);
      } catch (e) {
        continue;
      }
      if (!k || k.indexOf(PREFIX) !== 0) continue;
      const raw = safeGet(k);
      if (!raw) continue;
      try {
        const v = JSON.parse(raw);
        out.push({ key: k, savedAt: v.savedAt || 0, rideId: v.rideId == null ? null : v.rideId });
      } catch (e) {
        // Unparseable is worse than absent: it will never restore and will
        // sit in the quota forever.
        safeRemove(k);
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  function prune(keep) {
    const n = typeof keep === "number" ? keep : KEEP;
    const all = list();
    for (let i = n; i < all.length; i++) safeRemove(all[i].key);
    return Math.max(0, all.length - n);
  }

  const Draft = {
    VERSION: DRAFT_VERSION,
    key: keyFor,
    list,
    prune,

    // Returns true when the draft is on disk, false when it could not be
    // written. The caller is expected to tell the rider on false — a draft
    // someone believes exists and does not is worse than no draft at all.
    write(rideId, state, now) {
      const body = JSON.stringify({
        v: DRAFT_VERSION,
        savedAt: typeof now === "number" ? now : Date.now(),
        rideId: rideId == null ? null : rideId,
        legsStripped: true,
        meta: { ...state.meta },
        // From state.days, not payload(): payload() drops days with no
        // stops, and a day you added and have not filled in yet is exactly
        // the kind of work a draft exists to keep.
        days: stripped(state.days),
      });
      const key = keyFor(rideId);
      try {
        window.localStorage.setItem(key, body);
        return true;
      } catch (e) {
        // Out of room: drop the drafts nobody is coming back for, then try
        // once more. Two failures means this ride is simply too big for the
        // quota and the rider needs to hear it.
        prune(2);
        try {
          window.localStorage.setItem(key, body);
          return true;
        } catch (e2) {
          return false;
        }
      }
    },

    read(rideId) {
      const raw = safeGet(keyFor(rideId));
      if (!raw) return null;
      let v;
      try {
        v = JSON.parse(raw);
      } catch (e) {
        safeRemove(keyFor(rideId));
        return null;
      }
      // A draft from an older schema is discarded rather than guessed at.
      if (!v || v.v !== DRAFT_VERSION || !Array.isArray(v.days)) {
        safeRemove(keyFor(rideId));
        return null;
      }
      return v;
    },

    clear(rideId) {
      safeRemove(keyFor(rideId));
    },

    // A first save turns the "new" slot into a real ride id. Without this the
    // orphan sits there and offers itself the next time a new ride is started.
    adopt(rideId) {
      const raw = safeGet(keyFor(null));
      safeRemove(keyFor(null));
      if (!raw || rideId == null) return false;
      try {
        const v = JSON.parse(raw);
        v.rideId = rideId;
        window.localStorage.setItem(keyFor(rideId), JSON.stringify(v));
        return true;
      } catch (e) {
        return false;
      }
    },
  };

  window.TBHistory = { snapshot, snapshotRoute, restore, createHistory, Draft, DEFAULT_MAX };
})(typeof window !== "undefined" ? window : this);
