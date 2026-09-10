// EVERY KNOCKOUT IN THE FOLDER REACHES `--icon-ink`, IN WHATEVER SPELLING IT
// WAS EXPORTED WITH.
//
// **THE BUG THIS EXISTS FOR.** The flip was a CSS attribute match on
// `[fill="white"]`, which is one of five spellings these files actually use:
// `bug`, `help` and `info` carry `#ffffff`/`#FFFFFF`, and `record-distance`,
// `record-ride`, `record-twist` and `record-views` put the knockout on
// `stroke` rather than `fill`. All seven therefore kept a WHITE glyph on every
// black-legend field — 1.23:1 on `$yield`, 1.53:1 on `$warning` — which is
// #282 by another door. Reported by Ziad off /icons, 2026-09-09, after a first
// answer that explained the near-threshold column classification and never
// checked whether the flip reached the marks at all.
//
// **THIS IS THE HALF `test/sign-legend.test.ts` CANNOT SEE, WHICH IS WHY IT IS
// ITS OWN FILE.** That one compiles the stylesheet and asks whether a
// black-legend tone names an ink; it is blind to whether the ARTWORK exposes
// one to name. The two together are the guard: the sheet says black, and the
// file has something to paint black.
//
// **IT READS THE FOLDER RATHER THAN A LIST, so a mark re-exported with a sixth
// spelling fails on the day it lands** — which is the failure mode of the whole
// arrangement, because the loader normalizes on read and a re-export is exactly
// what it is built to survive.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { icon } from '../src/views/icon'

const DIR = join(process.cwd(), 'public', 'img', 'icons')

const names = readdirSync(DIR)
  .filter((f) => f.startsWith('icon-') && f.endsWith('.svg'))
  .map((f) => f.slice('icon-'.length, -'.svg'.length))
  .sort()

// Marks whose whites are artwork rather than a knockout, mirroring
// FIXED_PALETTE in src/views/icon.ts. Two copies, because that one is the rule
// and this one is the expectation — and a name added there without a reason
// worth writing down here is the thing to catch.
const FIXED_PALETTE = new Set(['vmc'])

/** Every white fill or stroke, in every spelling, on either property. */
const anyWhite = (svg: string) => [...svg.matchAll(/(?:fill|stroke)="(?:white|#fff|#ffffff)"/gi)].map((m) => m[0])

describe('the icon folder', () => {
  it('has marks in it, or the sweep below asserts nothing', () => {
    expect(names.length).toBeGreaterThan(20)
  })

  it.each(names.filter((n) => !FIXED_PALETTE.has(n)))('%s leaves no unreachable white', (name: string) => {
    expect(anyWhite(icon(name))).toEqual([])
  })

  // The other direction, and the one that catches a normalizer that stopped
  // running: a mark whose FILE has a knockout must come out of the loader with
  // a property on it. Without this, a regex that matched nothing would pass the
  // sweep above for the wrong reason.
  it.each(
    names.filter((n) => !FIXED_PALETTE.has(n) && anyWhite(readFileSync(join(DIR, `icon-${n}.svg`), 'utf8')).length > 0),
  )('%s exposes its knockout as --icon-ink', (name: string) => {
    expect(icon(name)).toContain('var(--icon-ink, #fff)')
  })

  // THE DEFAULT IS THE OLD BEHAVIOR, BYTE FOR BYTE. This is what lets the
  // change reach every existing call site without touching one: an unset
  // property resolves to the same #fff the files painted.
  it('defaults the ink to white so an unchanged caller is unchanged', () => {
    expect(icon('gas')).toContain('fill="var(--icon-ink, #fff)"')
  })

  // A fixed-palette mark is left exactly as drawn. `vmc` is somebody's club
  // logo with no currentColor in it at all; handing its 62 whites to the
  // property would let any surface recolor it.
  it.each([...FIXED_PALETTE])('%s is left as drawn', (name: string) => {
    expect(icon(name)).not.toContain('--icon-ink')
    expect(anyWhite(icon(name)).length).toBeGreaterThan(0)
  })

  // The normalizer is anchored on `="`, so it must not have eaten a rule or a
  // width off any mark that carries one.
  it.each(names)('%s keeps its non-color fill and stroke attributes', (name: string) => {
    const before = readFileSync(join(DIR, `icon-${name}.svg`), 'utf8')
    const kinds = (s: string) => [...s.matchAll(/(fill|stroke)-[a-z]+="[^"]*"/g)].map((m) => m[0]).sort()
    expect(kinds(icon(name))).toEqual(kinds(before))
  })
})
