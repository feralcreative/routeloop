// TWO FUNCTIONS WITH ONE NAME IN ONE SCOPE, which is legal JavaScript and a bug
// every time it happens here.
//
// THE FAILURE THIS EXISTS FOR. `previewOf` was the shape drag's preview polyline
// from the day drag-to-shape shipped. #238 added the search-result dots and
// called their accessor `previewOf` too, a few hundred lines further down the
// same IIFE — so the later declaration replaced the earlier one for the whole
// file, and dragging a leg onto another road called the wrong one, got
// `{pins, onHover, onPick}` back, and died on `preview.setPath is not a
// function`. Shipped 2026-09-03 and reported the same day.
//
// NOTHING ELSE CATCHES IT. `node --check` accepts a redeclaration, prettier has
// no opinion, and the typecheck does not read `public/js/`. The general answer
// is a linter with `no-redeclare`, which is a dependency and therefore Ziad's
// call; this is the guard that costs nothing in the meantime.
//
// SCOPED TO map-common.js AND BY INDENTATION, deliberately. That file is one
// IIFE whose own functions all sit at exactly two spaces, so same-indent IS
// same-scope there and the check has no false positives. It is also the file
// that keeps growing — the range ring, the fuel walls, the search dots and the
// meeting-point approaches all landed in it — which is what makes a collision
// likely rather than theoretical. site.js deliberately has two `open`/`close`
// pairs in separate closures, which is why this is not a repo-wide grep.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('map-common.js declarations', () => {
  it('declares no function name twice in the IIFE', () => {
    const src = readFileSync('public/js/map-common.js', 'utf8')
    const seen = new Map<string, number[]>()
    src.split('\n').forEach((line, i) => {
      const m = /^ {2}function ([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(line)
      if (!m) return
      const at = seen.get(m[1]) ?? []
      at.push(i + 1)
      seen.set(m[1], at)
    })

    const clashes = [...seen.entries()]
      .filter(([, lines]) => lines.length > 1)
      .map(([name, lines]) => `${name} at lines ${lines.join(' and ')}`)

    // Named in the message rather than counted, because the whole difficulty of
    // this bug was that nothing pointed at the two places.
    expect(clashes).toEqual([])
  })

  // A canary for the check itself: if the file ever stops using two-space
  // indentation for its own functions, the test above silently passes by
  // matching nothing at all.
  it('still finds the functions it is meant to be checking', () => {
    const src = readFileSync('public/js/map-common.js', 'utf8')
    const count = src.split('\n').filter((l) => /^ {2}function [A-Za-z_$]/.test(l)).length
    expect(count).toBeGreaterThan(30)
  })
})
