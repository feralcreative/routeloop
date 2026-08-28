// Turning a SortableJS drop into an index into day.points.
//
// This is four lines of arithmetic that shipped wrong for four days and cost
// #166, so it lives here rather than inside the onEnd closure in builder.js —
// where no test could reach it. Pure: no DOM, no Sortable, no state.
//
// **THE TRAP IT EXISTS TO HOLD: Sortable reports TWO pairs of indices and only
// one pair means what this app needs.** `oldIndex`/`newIndex` count EVERY child
// of the list. `oldDraggableIndex`/`newDraggableIndex` count only the children
// matching the `draggable` selector. A point list renders an `.insert-slot`
// hairline above every row plus one trailing `.add-row`, so it holds 2n+1
// children for n points and the raw index runs at roughly double the one
// `day.points` is addressed by.
//
// Nothing here can tell which pair it was handed — that is the caller's job and
// the reason the caller is one line long. What this file CAN do is be exercised
// with the numbers Sortable actually reported, which is what test/drag-index.test.ts
// does: the failing pairs are recorded there as regression cases.
(function (window) {
  "use strict";

  // Where a same-day drag lands, or null when it is not an edit.
  //
  // `from` is the dragged row's own point index (its `data-i`), `to` is
  // Sortable's newDraggableIndex, and `count` is day.points.length.
  //
  // Null rather than `from` for a non-move, because the caller must not run its
  // beginEdit/markDirty path for a drop that changed nothing — and null is the
  // one answer that cannot be mistaken for a position. Returning `from` was
  // effectively what the buggy version did, and the early return it triggered is
  // why a lost drag never even marked the ride dirty.
  //
  // The clamp is real rather than defensive: `.add-row` is filtered so it can
  // never be the dragged item, but it IS a child of the list and always last, so
  // a drop below every row can still report one past the end.
  function dropTarget(from, to, count) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(count)) return null;
    if (count <= 1) return null;
    if (from < 0 || from >= count) return null;
    var at = Math.max(0, Math.min(count - 1, to));
    return at === from ? null : at;
  }

  // Where a CROSS-DAY drag lands in the destination list.
  //
  // Clamped to `count` rather than `count - 1`, and that difference is the whole
  // reason this is a second function: the point is being INSERTED into a list it
  // is not yet in, so landing one past the last element is appending and is a
  // legitimate answer. In the same-day case the point is already in the array
  // and `count - 1` is the last position that exists.
  function insertTarget(to, count) {
    if (!Number.isInteger(to) || !Number.isInteger(count) || count < 0) return 0;
    return Math.max(0, Math.min(count, to));
  }

  window.TBDragIndex = { dropTarget: dropTarget, insertTarget: insertTarget };
})(typeof window !== "undefined" ? window : this);
