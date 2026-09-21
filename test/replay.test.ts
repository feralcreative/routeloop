// The sign-in page's sneak peek: the recording in public/tour/replay.json
// against the tour it was recorded from, and the player's arithmetic.
//
// **A CARD EDITED WITHOUT A RE-RECORD FAILS HERE**, naming the step. The
// manifest carries each card's title and copy as they were the day the
// recorder ran, and the player shows the manifest's — so a tour.js edit that
// is not followed by `npx tsx utils/record-tour-replay.ts` would put stale
// words on the front door with nothing else to say so.
//
// Same harness as test/tips.test.ts: `window` and `document` stubbed, the two
// plain scripts run through `new Function`, and the globals read back.
import { beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

type Rect = { x: number; y: number; w: number; h: number }
type Step = {
  id: string
  part?: number
  intro?: boolean
  chooser?: boolean
  page?: string
  running?: string
  title: string
  text: string | (() => string)
  replay?: string
  demo?: unknown
}
type ManifestStep = {
  id: string
  part?: number
  intro?: true
  chooser?: true
  page: string
  title: string
  text: string
  running?: string
  frame: string
  box: Rect | null
  extra: Rect[]
}
type Manifest = {
  version: number
  viewport: { w: number; h: number; dpr: number }
  pad: number
  radius: number
  base: string
  parts: { n: number; name: string; blurb: string }[]
  steps: ManifestStep[]
}
type Fit = (
  stage: { w: number; h: number },
  frame: { w: number; h: number },
  box: Rect | null,
  pad: number,
  maxScale?: number,
) => { s: number; tx: number; ty: number }
type Corner = (
  stage: { w: number; h: number },
  card: { w: number; h: number },
  box: Rect | null,
  margin: number,
  bottom?: number,
) => string

const MANIFEST = 'public/tour/replay.json'
const FRAMES = 'public/tour/replay'

let STEPS: Step[]
let PARTS: unknown
let fit: Fit
let corner: Corner
let manifest: Manifest

beforeAll(() => {
  const win: Record<string, unknown> = { addEventListener: () => {} }
  const doc = {
    documentElement: { getAttribute: () => 'off' },
    readyState: 'complete',
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  new Function('window', 'document', readFileSync('public/js/tour.js', 'utf8'))(win, doc)
  new Function('window', 'document', readFileSync('public/js/replay.js', 'utf8'))(win, doc)
  const tour = win.TBTour as { STEPS: Step[]; PARTS: unknown }
  STEPS = tour.STEPS
  PARTS = tour.PARTS
  const replay = win.TBReplay as { fit: Fit; corner: Corner }
  fit = replay.fit
  corner = replay.corner
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
})

const textOf = (s: Step): string => s.replay ?? (typeof s.text === 'function' ? s.text() : s.text)

describe('split card anchors', () => {
  function scene() {
    const route = () => {
      let shut = true
      let clicks = 0
      const section = {
        classList: { contains: () => shut },
        querySelector: () => ({
          click: () => {
            shut = !shut
            clicks++
          },
        }),
      }
      const row = {
        querySelector: () => ({ value: 'Pescadero' }),
        closest: () => section,
        getBoundingClientRect: () => ({ width: shut ? 0 : 300, height: shut ? 0 : 40 }),
      }
      return { row, clicks: () => clicks }
    }
    let target: ReturnType<typeof route> | null = route()
    const win: Record<string, unknown> = { addEventListener: () => {} }
    const doc = {
      documentElement: { getAttribute: () => 'off' },
      readyState: 'complete',
      addEventListener: () => {},
      getElementById: () => null,
      querySelector: () => target?.row ?? null,
      querySelectorAll: () => (target ? [target.row] : []),
    }
    new Function('window', 'document', readFileSync('public/js/tour.js', 'utf8'))(win, doc)
    const steps = (win.TBTour as { STEPS: { id: string; at: () => ReturnType<typeof route>['row'] | null }[] }).STEPS
    return {
      anchor: (id: string) => steps.find((s) => s.id === id)!.at(),
      target: () => target!,
      replace: () => {
        target = route()
      },
      remove: () => {
        target = null
      },
    }
  }

  for (const id of ['split', 'splitoff-row']) {
    it(`${id} opens its folded route and leaves an open route open`, () => {
      const s = scene()
      expect(s.target().row.getBoundingClientRect().height).toBe(0)
      expect(s.anchor(id)).toBe(s.target().row)
      expect(s.target().row.getBoundingClientRect().height).toBeGreaterThan(0)
      s.anchor(id)
      expect(s.target().clicks()).toBe(1)
    })

    it(`${id} resolves a replacement row after a frame or backward navigation`, () => {
      const s = scene()
      const previous = s.anchor(id)
      s.replace()
      expect(s.anchor(id)).not.toBe(previous)
      expect(s.anchor(id)).toBe(s.target().row)
      expect(s.target().row.getBoundingClientRect().height).toBeGreaterThan(0)
    })

    it(`${id} tolerates a row that has not arrived yet`, () => {
      const s = scene()
      s.remove()
      expect(s.anchor(id)).toBeNull()
    })
  }
})

describe('the recording', () => {
  it('has one frame per step, in the tour’s order', () => {
    expect(manifest.version).toBe(1)
    expect(manifest.steps.map((s) => s.id)).toEqual(STEPS.map((s) => s.id))
  })

  it('carries each card’s own words and shape', () => {
    for (const m of manifest.steps) {
      const s = STEPS.find((x) => x.id === m.id)!
      expect(m.title, `${m.id} title`).toBe(s.title)
      expect(m.text, `${m.id} text — re-record with utils/record-tour-replay.ts`).toBe(textOf(s))
      expect(m.part, `${m.id} part`).toBe(s.part)
      expect(m.intro, `${m.id} intro`).toBe(s.intro ? true : undefined)
      expect(m.chooser, `${m.id} chooser`).toBe(s.chooser ? true : undefined)
      expect(m.page, `${m.id} page`).toBe(s.page ?? 'builder')
      expect(m.running, `${m.id} running`).toBe(s.running)
    }
  })

  it('names the parts exactly as the tour does', () => {
    expect(manifest.parts).toEqual(PARTS)
  })

  it('cuts the same hole the live overlay does', () => {
    const src = readFileSync('public/js/tour.js', 'utf8')
    const num = (name: string) => Number(new RegExp(`${name}:\\s*(\\d+)`).exec(src)![1])
    expect(manifest.pad).toBe(num('modalOverlayOpeningPadding'))
    expect(manifest.radius).toBe(num('modalOverlayOpeningRadius'))
  })

  it('points at something on every card but the centered ones', () => {
    const inUnit = (r: Rect) => r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= 1 && r.y + r.h <= 1
    for (const m of manifest.steps) {
      if (m.intro || m.chooser) {
        expect(m.box, `${m.id} is centered`).toBeNull()
        continue
      }
      expect(m.box, `${m.id} box`).not.toBeNull()
      expect(inUnit(m.box!), `${m.id} box ${JSON.stringify(m.box)}`).toBe(true)
      for (const e of m.extra) expect(inUnit(e), `${m.id} extra`).toBe(true)
    }
  })

  it('names every frame by its own bytes, with none left over', () => {
    const named = new Set<string>()
    for (const m of manifest.steps) {
      expect(m.frame).toMatch(/^[a-z0-9-]+-[0-9a-f]{10}\.webp$/)
      const file = join(FRAMES, m.frame)
      expect(existsSync(file), `${m.frame} exists`).toBe(true)
      const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10)
      expect(m.frame.endsWith(`-${hash}.webp`), `${m.frame} is named by its hash`).toBe(true)
      named.add(m.frame)
    }
    const onDisk = readdirSync(FRAMES).filter((f) => f.endsWith('.webp'))
    expect(onDisk.filter((f) => !named.has(f))).toEqual([])
    expect(manifest.base).toBe('/tour/replay/')
  })

  it('is one recording at one size', async () => {
    const { w, h, dpr } = manifest.viewport
    for (const m of manifest.steps) {
      const meta = await sharp(join(FRAMES, m.frame)).metadata()
      expect([meta.width, meta.height], m.frame).toEqual([w * dpr, h * dpr])
    }
  })
})

describe('the player', () => {
  it('is loaded by the sign-in page and only there', () => {
    const auth = readFileSync('src/routes/auth.tsx', 'utf8')
    expect(auth).toContain("asset('/js/replay.js')")
    expect(auth).toContain("asset('/tour/replay.json')")
    expect(readFileSync('src/views/replay.tsx', 'utf8')).toContain('data-replay-open')
    const others = readdirSync('src/routes').filter((f) => f !== 'auth.tsx')
    for (const f of others) expect(readFileSync(join('src/routes', f), 'utf8'), f).not.toContain('replay.js')
  })

  describe('fit', () => {
    const stage = { w: 390, h: 500 }
    const frame = { w: 1280, h: 800 }

    it('shows the whole width with no box', () => {
      const f = fit(stage, frame, null, 6)
      expect(f.s).toBeCloseTo(390 / 1280, 3)
      expect(f.tx).toBe(0)
      // Shorter than the stage: centered vertically.
      expect(f.ty).toBeCloseTo((500 - 800 * (390 / 1280)) / 2, 2)
    })

    it('fills the width with a narrow box, up to the ceiling', () => {
      const box = { x: 0.02, y: 0.08, w: 0.05, h: 0.04 }
      const f = fit(stage, frame, box, 6, 3)
      expect(f.s).toBe(3)
    })

    it('never shows a gap past the right edge', () => {
      const box = { x: 0.95, y: 0.5, w: 0.05, h: 0.05 }
      const f = fit(stage, frame, box, 6, 3)
      expect(f.s).toBe(3)
      // Centering the box would leave the frame's right edge inside the
      // stage; the translation is clamped so the edge meets it instead.
      expect(f.tx).toBe(390 - 1280 * 3)
    })

    it('never shows a gap above the top edge', () => {
      const box = { x: 0.4, y: 0.01, w: 0.2, h: 0.03 }
      const f = fit(stage, frame, box, 6, 3)
      expect(f.ty).toBe(0)
    })
  })

  describe('corner', () => {
    const stage = { w: 1280, h: 800 }
    const card = { w: 480, h: 300 }

    it('sits bottom-right when nothing is pointed at', () => {
      expect(corner(stage, card, null, 16)).toBe('br')
    })

    it('takes the first corner that does not cover the box', () => {
      // A panel row on the left: bottom-right is clear.
      expect(corner(stage, card, { x: 20, y: 380, w: 330, h: 40 }, 16)).toBe('br')
      // The lower right of the map: bottom-left is the first clear corner.
      expect(corner(stage, card, { x: 700, y: 400, w: 580, h: 400 }, 16)).toBe('bl')
      // A box across the whole bottom: top-right.
      expect(corner(stage, card, { x: 0, y: 700, w: 1280, h: 100 }, 16)).toBe('tr')
      // The whole map, full height: nothing is clear, and bottom-right is the default.
      expect(corner(stage, card, { x: 380, y: 0, w: 900, h: 800 }, 16)).toBe('br')
    })

    it('keeps the bottom corners clear of the attribution strip', () => {
      // A box the card misses when it sits 16px up and covers when it sits 40px up.
      expect(corner(stage, card, { x: 800, y: 465, w: 400, h: 15 }, 16, 16)).toBe('br')
      expect(corner(stage, card, { x: 800, y: 465, w: 400, h: 15 }, 16, 40)).toBe('bl')
    })
  })
})
