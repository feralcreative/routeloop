// Show me around — the table against the tree. #133.
//
// **THE FAILURE THIS EXISTS FOR IS A KEY WITH NO COPY, WHICH IS SILENT.** A
// control carrying `data-tip="route-rev"` when the table calls it `route-reverse`
// does not throw and does not log: `public/js/tips.js` bails, leaves the native
// `title` alone, and the control simply goes on behaving the way it did before
// the feature existed. Nobody notices until somebody hovers that one button, and
// there is no browser suite to hover it.
//
// **AND THE OPPOSITE, WHICH IS WHAT MAKES THIS TWO ASSERTIONS.** Copy for a
// control that was renamed or deleted stays in the table forever, reads as
// covered, and is the reason a later count of "how many controls explain
// themselves" is wrong.
//
// It reads the tree as TEXT, the arrangement test/us-english.test.ts and
// test/archive-completeness.test.ts both use: CI has no browser and this needs
// none.
import { describe, expect, it, beforeAll } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { TIPS, toTips, DEFAULT_TIPS, TIPS_CHOICES } from '../src/views/tips'

let BODY: Record<string, string>
let STEPS: { id: string; at?: string; wait?: unknown }[]

beforeAll(() => {
  // Same harness as test/drag-index.test.ts, with `document` stubbed as well —
  // tips.js reads <html> on load to decide whether to install anything, and
  // answering "off" is what keeps it from wiring listeners into a suite that has
  // no DOM to wire them to. tour.js looks for the Shepherd preload by id and
  // gives up without one. Both tables are built either way.
  const win: Record<string, unknown> = { addEventListener: () => {} }
  const doc = {
    documentElement: { getAttribute: () => 'off' },
    readyState: 'complete',
    addEventListener: () => {},
    getElementById: () => null,
    // The scrubber step's text is a function that looks for its control, so
    // calling it here needs a document that answers "not there".
    querySelectorAll: () => [],
  }
  new Function('window', 'document', readFileSync('public/js/tips.js', 'utf8'))(win, doc)
  new Function('window', 'document', readFileSync('public/js/tour.js', 'utf8'))(win, doc)
  BODY = (win as any).TBTips.BODY
  STEPS = (win as any).TBTour.STEPS
})

// Every file that could carry a control. The `.tsx` views render markup as JSX
// and `public/js/*.js` assembles it as strings; both spell the attribute the
// same way, which is what lets one regex cover both.
const SOURCES = execSync('git ls-files "src/*.ts" "src/*.tsx" "public/js/*.js"', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => f !== 'public/js/tips.js')

function keysInTree(): { key: string; file: string }[] {
  const out: { key: string; file: string }[] = []
  for (const f of SOURCES) {
    for (const m of readFileSync(f, 'utf8').matchAll(/data-tip="([a-z0-9-]+)"/g)) {
      out.push({ key: m[1], file: f })
    }
  }
  return out
}

describe('tips', () => {
  it('finds the marked controls at all', () => {
    // The sanity floor test/archive-completeness.test.ts records the need for: a
    // regex that silently matches nothing is a test that passes forever.
    expect(keysInTree().length).toBeGreaterThan(20)
  })

  it('has copy for every control that asks for it', () => {
    const missing = keysInTree()
      .filter((k) => !BODY[k.key])
      .map((k) => `${k.file}: data-tip="${k.key}" has no entry in public/js/tips.js`)
    expect(missing.join('\n')).toBe('')
  })

  it('has no copy for a control that no longer exists', () => {
    const used = new Set(keysInTree().map((k) => k.key))
    const orphans = Object.keys(BODY).filter((k) => !used.has(k))
    expect(orphans.join(', ')).toBe('')
  })

  it('writes a sentence rather than a second label', () => {
    // A body shorter than this is a restatement of the title above it, which is
    // the exact failure #133 was filed about — the native tooltip already says
    // the short thing.
    const terse = Object.entries(BODY)
      .filter(([, v]) => v.length < 60)
      .map(([k, v]) => `${k}: ${v}`)
    expect(terse.join('\n')).toBe('')
  })
})

describe('tour', () => {
  it('is three parts, each with more than one step, and four steps that wait', () => {
    // The shape Ziad chose: three parts a rider can take in any order or skip,
    // narrated, with exactly four steps that do not move on until the rider has
    // done the thing — the name, two points, and a start time. More waits is a
    // different tour.
    const parts = new Set(STEPS.map((s: any) => s.part).filter(Boolean))
    expect([...parts].sort()).toEqual([1, 2, 3])
    for (const n of parts) expect(STEPS.filter((s: any) => s.part === n).length).toBeGreaterThan(1)
    expect(STEPS.filter((s) => s.wait).length).toBe(4)
    // The welcome and closing cards belong to no part and carry the chooser.
    expect(STEPS.filter((s: any) => !s.part).every((s: any) => s.chooser)).toBe(true)
  })

  it('opens the tab a step lives on', () => {
    // A control on a shut tab has no box and Shepherd centers the card with
    // no spotlight, silently. Every step anchored inside the Groups or Riders
    // panel has to say which tab to open first.
    const src = readFileSync('src/routes/builder.ts', 'utf8')
    const onGroups = [...src.matchAll(/id="(sg-[a-z-]+)"/g)].map((m) => '#' + m[1])
    const onRiders = [...src.matchAll(/id="(riders-[a-z-]+)"/g)].map((m) => '#' + m[1])
    const bad = STEPS.filter((s: any) => s.at && (onGroups.includes(s.at) || onRiders.includes(s.at)) && !s.tab)
    expect(bad.map((s) => s.id).join(', ')).toBe('')
  })

  it('anchors every step on a control that exists', () => {
    // A `data-tip` key must be one the tree carries; a selector must appear in
    // the source somewhere. Either failing is a step that centers itself with
    // no spotlight and nothing to point at, which Shepherd does silently.
    const keys = new Set(keysInTree().map((k) => k.key))
    const src = SOURCES.map((f) => readFileSync(f, 'utf8')).join('\n')
    const bad = STEPS.filter((s) => s.at).filter((s) => {
      const at = s.at as string
      if (/^[.#]/.test(at)) {
        const name = at.slice(1)
        return !new RegExp(`(class="[^"]*\\b${name}\\b|id="${name}"|class="${name}|"${name}")`).test(src)
      }
      return !keys.has(at)
    })
    expect(bad.map((s) => `${s.id} -> ${s.at}`).join('\n')).toBe('')
  })

  it('reads as a tour and not as a second set of labels', () => {
    const thin = STEPS.filter(
      (s: any) => !s.title || String(typeof s.text === 'function' ? s.text() : s.text).length < 80,
    ).map((s) => s.id)
    expect(thin.join(', ')).toBe('')
  })
})

describe('toTips', () => {
  it('defaults to on, which is the direction the feature depends on', () => {
    expect(DEFAULT_TIPS).toBe('on')
    // A rider with no user_profiles row, a hand-crafted request, and a value
    // from an older release all land here.
    expect(toTips(undefined)).toBe('on')
    expect(toTips(null)).toBe('on')
    expect(toTips('yes')).toBe('on')
  })

  it('takes the two real answers', () => {
    expect(toTips('on')).toBe('on')
    expect(toTips('off')).toBe('off')
  })

  it('offers exactly the members it stores', () => {
    expect(TIPS_CHOICES.map((c) => c.id)).toEqual([...TIPS])
  })
})
