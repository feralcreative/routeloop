// The arithmetic that turns a SortableJS drop into a position in day.points.
//
// This test exists because the four lines it covers shipped wrong and nothing
// caught it. There is no browser suite, so a drag was verifiable only by hand —
// and by hand it LOOKED fine, because the row numbers are positional ordinals
// recomputed on every render. A list reads 1, 2, 3… 8 no matter where a point
// actually landed, so a wrong drop is invisible unless you follow the names.
//
// The recorded pairs below are what Sortable actually reported on /builder/8 on
// 2026-08-28, not numbers invented to fit. Same harness as route-shape.test.ts.
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

let D: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/drag-index.js', 'utf8'))(win)
  D = (win as any).TBDragIndex
})

describe('dropTarget', () => {
  it('moves a point one slot down', () => {
    expect(D.dropTarget(0, 1, 8)).toBe(1)
  })

  it('moves a point one slot up', () => {
    expect(D.dropTarget(7, 6, 8)).toBe(6)
  })

  it('moves a point across the whole list', () => {
    expect(D.dropTarget(0, 7, 8)).toBe(7)
    expect(D.dropTarget(7, 0, 8)).toBe(0)
  })

  // A drop that did not move anything must not reach the caller's edit path, or
  // an unchanged ride is marked dirty and autosaved for nothing.
  it('is null when the point did not move', () => {
    expect(D.dropTarget(3, 3, 8)).toBeNull()
  })

  // .add-row is a child of the list and always last, so a drop below every row
  // can report one past the end.
  it('clamps a drop past the end onto the last position', () => {
    expect(D.dropTarget(2, 8, 8)).toBe(7)
    expect(D.dropTarget(2, 99, 8)).toBe(7)
  })

  it('clamps a negative index to the top', () => {
    expect(D.dropTarget(4, -3, 8)).toBe(0)
  })

  // A day of one point has nowhere to drop to; a day of none cannot be dragged
  // in at all.
  it('is null when there is nothing to reorder', () => {
    expect(D.dropTarget(0, 0, 1)).toBeNull()
    expect(D.dropTarget(0, 0, 0)).toBeNull()
  })

  it('is null for a row index outside the day', () => {
    expect(D.dropTarget(9, 2, 8)).toBeNull()
    expect(D.dropTarget(-1, 2, 8)).toBeNull()
  })

  it('is null for values that are not integers', () => {
    expect(D.dropTarget(NaN, 2, 8)).toBeNull()
    expect(D.dropTarget(0, undefined, 8)).toBeNull()
    expect(D.dropTarget(0, 2, undefined)).toBeNull()
  })

  // THE REGRESSION, in the numbers Sortable reported for #166.
  //
  // A point list holds 2n+1 children — an .insert-slot above every row, plus one
  // trailing .add-row — so the RAW index runs at roughly double the draggable
  // one. Handing the raw number to this function reproduces both halves of the
  // bug exactly, which is what these two cases pin.
  describe('#166 — the raw child index is not the point index', () => {
    // Dragging point 7 of 8 up one slot: raw 13, draggable 6.
    it('the silent no-op: raw 13 clamps onto the point itself', () => {
      expect(D.dropTarget(7, 13, 8)).toBeNull() // what shipped: no move, never dirtied
      expect(D.dropTarget(7, 6, 8)).toBe(6) // what the rider meant
    })

    // Dragging point 0 down one slot: raw 3, draggable 1.
    it('the overshoot: raw 3 moves the point three places', () => {
      expect(D.dropTarget(0, 3, 8)).toBe(3) // what shipped, and it saved
      expect(D.dropTarget(0, 1, 8)).toBe(1) // what the rider meant
    })
  })
})

// THE CALL SITE IS WHAT REGRESSED, AND THE CASES ABOVE CANNOT SEE IT.
//
// dropTarget() is handed a number; it has no way to know whether the caller read
// the raw pair or the draggable pair, so every case above passes just as happily
// against the version that shipped #166. Putting `evt.newIndex` back in
// builder.js would be silent to them.
//
// So this reads the source. It is the same move test/viz-categories.test.ts and
// test/palette-contrast.test.ts make when they compile the SCSS to get their
// numbers: the build is the thing that has to be right, so the build is what
// gets checked rather than a second copy of the reasoning.
describe('builder.js reads the draggable indices, not the raw ones', () => {
  const SRC = readFileSync('public/js/builder.js', 'utf8')

  // initDayDrag is the one handler where the raw pair is correct, because
  // #day-list holds nothing but .day-section children and the two pairs agree.
  // Every other use is a bug, so the test is: all of them are in there.
  const dayDragStart = SRC.indexOf('function initDayDrag')
  const dayDragEnd = SRC.indexOf('\n  function ', dayDragStart + 1)

  it('finds the day-drag handler, so the exemption below means something', () => {
    expect(dayDragStart).toBeGreaterThan(-1)
    expect(dayDragEnd).toBeGreaterThan(dayDragStart)
  })

  it('uses evt.newIndex / evt.oldIndex nowhere but the day-drag handler', () => {
    const offenders: string[] = []
    for (const m of SRC.matchAll(/evt\.(newIndex|oldIndex)/g)) {
      const at = m.index ?? 0
      if (at < dayDragStart || at > dayDragEnd) {
        offenders.push(`${m[0]} at line ${SRC.slice(0, at).split('\n').length}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('routes both point-list drops through TBDragIndex', () => {
    expect(SRC).toContain('DRAG.dropTarget(')
    expect(SRC).toContain('DRAG.insertTarget(')
  })
})

describe('insertTarget', () => {
  it('inserts where the point was dropped', () => {
    expect(D.insertTarget(0, 7)).toBe(0)
    expect(D.insertTarget(3, 7)).toBe(3)
  })

  // The difference from dropTarget, and the reason the two are separate: the
  // point is not in this array yet, so one past the last element is an append
  // rather than an overrun.
  it('allows an append one past the end', () => {
    expect(D.insertTarget(7, 7)).toBe(7)
  })

  it('clamps beyond the end and below zero', () => {
    expect(D.insertTarget(99, 7)).toBe(7)
    expect(D.insertTarget(-4, 7)).toBe(0)
  })

  it('puts the first point of an empty day at the top', () => {
    expect(D.insertTarget(0, 0)).toBe(0)
    expect(D.insertTarget(5, 0)).toBe(0)
  })

  it('falls back to the top for values that are not integers', () => {
    expect(D.insertTarget(undefined, 7)).toBe(0)
    expect(D.insertTarget(NaN, 7)).toBe(0)
  })
})
