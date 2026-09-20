// Records the guided tour as frames for the sign-in page's sneak peek.
//
//   npx tsx utils/record-tour-replay.ts            # dev server up on 6686, DEV_LOGIN_EMAIL set
//   npx tsx utils/record-tour-replay.ts --steps name,via   # re-record a subset, keep the rest
//
// **IT DRIVES THE REAL TOUR, ONCE, AND WRITES WHAT IT SAW.** The live tour
// (public/js/tour.js) is a real planning session on a real ride, and making it
// public would mean unauthenticated writes and a Maps load per crawler — so
// the sign-in page gets a RECORDING instead: one screenshot per card with the
// card, the overlay, and the cursor hidden, the box the card pointed at as a
// fraction of the viewport, and the card's own title and copy. public/js/
// replay.js draws the ring and the card back over the frame; nothing on that
// page is live. The recorder signs in through /dev/login, opens /builder?tour,
// and presses Next forty-two times through window.TBTour, waiting for each
// demonstration to land the way a rider would. Zero Google spend beyond the
// tiles the tour already loads.
//
// **FRAMES CONTAIN GOOGLE MAPS IMAGERY AND THE RECORDER NEVER CROPS.** Google's
// logo and attribution stay in every frame at the viewport's bottom edge, and
// the player shows whole frames on a desktop. On a phone the player pans, and
// carries its own credit line for that reason.
//
// **IT REFUSES A `--base` THAT IS NOT LOCALHOST.** The paddock, the roster,
// /riders and the viewer frames show whatever the recording account and the
// database hold, and those frames are public — so frames can only ever come
// from a dev database, seeded (utils/seed-dev.sh), never from a copy of prod.
// The account is whoever DEV_LOGIN_EMAIL names; the seed's Demo Rider is the
// one meant.
//
// **REPRODUCIBLE, NOT DETERMINISTIC.** Tiles, fonts and the clock differ run to
// run, so a re-record changes bytes and therefore filenames — which is what
// the content hash in each name is for. test/replay.test.ts pins the manifest
// against tour.js so a card edited without a re-record fails loudly.
//
// utils/ is outside tsconfig; check this file by hand with the tsc line in
// AGENTS.md before relying on it.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Rect = { x: number; y: number; w: number; h: number }
type StepInfo = {
  id: string
  part?: number
  intro?: true
  chooser?: true
  page: string
  demo: boolean
  running?: string
  extra: string[]
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
  version: 1
  recordedAt: string
  viewport: { w: number; h: number; dpr: number }
  pad: number
  radius: number
  base: string
  parts: { n: number; name: string; blurb: string }[]
  steps: ManifestStep[]
}

// ——— Arguments ———

const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const has = (name: string): boolean => args.includes(`--${name}`)

const BASE = flag('base', 'http://localhost:6686').replace(/\/+$/, '')
const OUT = flag('out', 'public/tour')
const [VW, VH] = flag('viewport', '1280x800').split('x').map(Number)
const DPR = Number(flag('dpr', '2'))
const QUALITY = Number(flag('quality', '78'))
const ONLY = flag('steps', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const HEADED = has('headed')

// Playwright's networkidle never fires here (live reload and the builder's
// presence stream are both open forever), so settling is a fixed beat after
// the builder's own save promise. Long enough for tiles on a fresh pan.
const SETTLE_MS = 1500
// What a demonstration is given before the recorder gives up on it: past the
// tour's own DEMO_TIMEOUT_MS, after which the card offers Next regardless.
const DEMO_WAIT_MS = 35_000
const STEP_WAIT_MS = 30_000

if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(BASE)) {
  console.error(`refusing --base ${BASE}: frames may only be recorded against a dev server on localhost`)
  process.exit(2)
}
if (!Number.isFinite(VW) || !Number.isFinite(VH) || VW < 320 || VH < 320) {
  console.error(`bad --viewport ${flag('viewport', '')}: want WxH in pixels`)
  process.exit(2)
}

const FRAMES_DIR = join(OUT, 'replay')
const MANIFEST = join(OUT, 'replay.json')

// The overlay's cut-out padding and radius, read out of tour.js so the player
// cuts the same hole the live tour does. One source; the test pins the copy.
const tourSource = readFileSync('public/js/tour.js', 'utf8')
const readConst = (name: string): number => {
  const m = new RegExp(`${name}:\\s*(\\d+)`).exec(tourSource)
  if (!m) throw new Error(`tour.js no longer says ${name}`)
  return Number(m[1])
}
const PAD = readConst('modalOverlayOpeningPadding')
const RADIUS = readConst('modalOverlayOpeningRadius')
// The notice modal's dismissal key and version, so no frame shows it.
const splashVersion = /ALPHA_SPLASH_VERSION = "([^"]+)"/.exec(readFileSync('public/js/site.js', 'utf8'))?.[1]

// Mirrors urlFor() in tour.js exactly. The viewer's path must match the whole
// pathname, or the roster's URL matches it too.
const urlFor = (page: string, p: { rideId: number; slug: string }): string => {
  switch (page) {
    case 'roster':
      return `/m/${p.slug}/riders`
    case 'viewer':
      return `/m/${p.slug}`
    case 'riders':
      return '/riders'
    case 'profile':
      return '/paddock'
    default:
      return `/builder/${p.rideId}`
  }
}
const onPage = (url: string, page: string, p: { rideId: number; slug: string }): boolean =>
  new URL(url).pathname.replace(/\/+$/, '') === urlFor(page, p)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const round4 = (n: number) => Math.round(n * 10_000) / 10_000
/** A viewport rect as fractions of the viewport, clamped to it. */
const frac = (r: Rect | null): Rect | null => {
  if (!r) return null
  const x0 = Math.max(0, Math.min(VW, r.x))
  const y0 = Math.max(0, Math.min(VH, r.y))
  const x1 = Math.max(0, Math.min(VW, r.x + r.w))
  const y1 = Math.max(0, Math.min(VH, r.y + r.h))
  if (x1 <= x0 || y1 <= y0) return null
  return { x: round4(x0 / VW), y: round4(y0 / VH), w: round4((x1 - x0) / VW), h: round4((y1 - y0) / VH) }
}

// ——— The run ———

let browser: Browser | null = null
let context: BrowserContext | null = null
let page: Page | null = null
let pos: { rideId: number; slug: string } | null = null
let finished = false
let currentStep = '(none)'

async function main(): Promise<void> {
  const t0 = Date.now()
  const existing: Manifest | null = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null
  if (ONLY.length && !existing) throw new Error(`--steps needs an existing ${MANIFEST} to keep the rest from`)
  mkdirSync(FRAMES_DIR, { recursive: true })

  browser = await chromium.launch({
    channel: 'chrome',
    headless: !HEADED,
    // The vector map is WebGL; headless Chrome renders it through SwiftShader
    // and this flag is what keeps that path on in recent builds.
    args: ['--enable-unsafe-swiftshader'],
  })
  context = await browser.newContext({
    viewport: { width: VW, height: VH },
    deviceScaleFactor: DPR,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  })
  // Aborted rather than left open: a source edit during a five-minute run
  // would otherwise reload the page under the tour.
  await context.route('**/__dev/reload', (r) => r.abort())
  await context.addInitScript(
    ({ key, version }) => {
      try {
        if (version) window.localStorage.setItem(key, version)
      } catch {
        /* a frame with the notice on it is the only cost */
      }
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style')
        s.textContent = '#dev-toggle,#dev-scheme,.dev-marker{display:none!important}'
        document.head.appendChild(s)
      })
    },
    { key: 'routeloop.alphaSplash', version: splashVersion ?? '' },
  )
  page = await context.newPage()
  page.on('dialog', (d) => void d.accept())
  page.on('pageerror', (e) => console.warn(`[${currentStep}] page error: ${e.message}`))
  page.on('console', (m) => {
    // The aborted live-reload stream reports as a failed resource; skip it.
    if (m.type() === 'error' && !/ERR_FAILED/.test(m.text()))
      console.warn(`[${currentStep}] console.error: ${m.text()}`)
  })

  // Sign in. A page that is not `/` afterwards is the dev door closed — see
  // docs/debugging.md under "/dev/login returns 404".
  await page.goto(`${BASE}/dev/login`, { waitUntil: 'load' })
  if (!/^\/(rides)?\/?$/.test(new URL(page.url()).pathname)) {
    throw new Error(`/dev/login did not sign in (landed on ${page.url()}); DEV_LOGIN_EMAIL set, Host localhost?`)
  }

  // Start the tour. `?tour` on a blank builder makes the ride and lands on it.
  await page.goto(`${BASE}/builder?tour`, { waitUntil: 'load' })
  await page.waitForURL(/\/builder\/\d+$/, { timeout: STEP_WAIT_MS })
  await waitActive(page)
  pos = await page.evaluate(() => {
    const raw = window.sessionStorage.getItem('routeloop.tour')
    const p = raw ? JSON.parse(raw) : null
    return p ? { rideId: p.rideId as number, slug: p.slug as string } : null
  })
  if (!pos) throw new Error('the tour started but saved no position')

  const steps: StepInfo[] = await page.evaluate(() =>
    (window as unknown as TourWindow).TBTour.STEPS.map((s) => ({
      id: s.id,
      ...(s.part ? { part: s.part } : {}),
      ...(s.intro ? { intro: true as const } : {}),
      ...(s.chooser ? { chooser: true as const } : {}),
      page: s.page || 'builder',
      demo: typeof s.demo === 'function',
      ...(s.running ? { running: s.running } : {}),
      extra: s.extra || [],
    })),
  )
  const parts = await page.evaluate(() => (window as unknown as TourWindow).TBTour.PARTS)
  console.log(`tour ride #${pos.rideId} (${pos.slug}), ${steps.length} steps`)

  const out: ManifestStep[] = []
  const written = new Set<string>()
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    currentStep = step.id
    if (i > 0) {
      const crossing = step.page !== steps[i - 1].page
      // Fire and forget: on a crossing the show promise never resolves and
      // the context is torn down under the call.
      await page.evaluate(() => void (window as unknown as TourWindow).TBTour.tour.next()).catch(() => {})
      if (crossing) {
        await page.waitForURL((u) => onPage(u.toString(), step.page, pos!), { timeout: STEP_WAIT_MS })
        await waitActive(page)
      }
    }
    await page.waitForFunction(
      (id) => {
        const t = (window as unknown as TourWindow).TBTour.tour
        const s = t && t.getCurrentStep()
        return !!(s && s.id === id && s.isOpen())
      },
      step.id,
      { timeout: STEP_WAIT_MS },
    )
    if (step.demo) {
      await page.waitForFunction(
        () => {
          const s = (window as unknown as TourWindow).TBTour.tour.getCurrentStep()
          return !!(s && s.el && s.el.classList.contains('is-satisfied'))
        },
        undefined,
        { timeout: DEMO_WAIT_MS },
      )
    }

    if (ONLY.length && !ONLY.includes(step.id)) {
      const kept = existing!.steps.find((s) => s.id === step.id)
      if (!kept) throw new Error(`--steps: ${step.id} is not in the existing manifest; record it too`)
      out.push(kept)
      written.add(kept.frame)
      process.stdout.write(`  ${step.id}: kept\n`)
      continue
    }

    const captured = await capture(page, step)
    out.push(captured)
    written.add(captured.frame)
    process.stdout.write(`  ${step.id}: ${captured.frame}\n`)
  }

  // Through the tour's own door, so the ride and the tour bike are destroyed
  // and the session's record of them is cleared.
  currentStep = '(finishing)'
  await page.evaluate(() => void (window as unknown as TourWindow).TBTour.tour.complete()).catch(() => {})
  await page.waitForURL((u) => /^\/(rides)?\/?$/.test(u.pathname), { timeout: STEP_WAIT_MS })
  finished = true

  const manifest: Manifest = {
    version: 1,
    recordedAt: new Date().toISOString(),
    viewport: { w: VW, h: VH, dpr: DPR },
    pad: PAD,
    radius: RADIUS,
    base: '/tour/replay/',
    parts,
    steps: out,
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
  let pruned = 0
  for (const f of readdirSync(FRAMES_DIR)) {
    if (f.endsWith('.webp') && !written.has(f)) {
      unlinkSync(join(FRAMES_DIR, f))
      pruned++
    }
  }
  const bytes = [...written].reduce((n, f) => n + readFileSync(join(FRAMES_DIR, f)).length, 0)
  console.log(
    `${out.length} frames, ${(bytes / 1_048_576).toFixed(1)} MB, ${pruned} pruned, ${Math.round((Date.now() - t0) / 1000)}s`,
  )
}

async function waitActive(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as TourWindow
      return !!(w.TBTour && w.TBTour.tour && w.TBTour.tour.isActive())
    },
    undefined,
    { timeout: STEP_WAIT_MS },
  )
}

async function capture(p: Page, step: StepInfo): Promise<ManifestStep> {
  // Let the builder's save land first, then tiles, then the re-pin.
  await p.evaluate(() => {
    const b = (window as unknown as TourWindow).TBBuilder
    return b && b.settled ? b.settled().catch(() => undefined) : undefined
  })
  await p.evaluate(() => document.fonts.ready.then(() => undefined))
  await sleep(SETTLE_MS)
  await twoFrames(p)

  // NO NAMED FUNCTION INSIDE AN evaluate(): tsx transpiles with keepNames, which
  // wraps a declared or const-assigned function in a `__name()` helper that
  // does not exist in the page. Inline arrows are left alone.
  const measured = await p.evaluate((extra) => {
    const w = window as unknown as TourWindow
    const s = w.TBTour.tour.getCurrentStep()
    const step = w.TBTour.STEPS.find((x) => x.id === s.id)!
    const text = step.replay ?? (typeof step.text === 'function' ? step.text() : step.text)
    const rects = [s.getTarget(), ...extra.map((sel) => document.querySelector(sel))].map((el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    })
    return { title: step.title, text, box: rects[0], extra: rects.slice(1) }
  }, step.extra)

  const hide = await p.addStyleTag({
    content: '.shepherd-element,.shepherd-modal-overlay-container,.tour-caret,.tour-spot{visibility:hidden!important}',
  })
  await twoFrames(p)
  const png = await p.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' })
  await hide.evaluate((el) => (el as HTMLElement).remove())

  const webp = await sharp(png).webp({ quality: QUALITY, effort: 5 }).toBuffer()
  const hash = createHash('sha256').update(webp).digest('hex').slice(0, 10)
  const frame = `${step.id}-${hash}.webp`
  writeFileSync(join(FRAMES_DIR, frame), webp)

  return {
    id: step.id,
    ...(step.part ? { part: step.part } : {}),
    ...(step.intro ? { intro: true as const } : {}),
    ...(step.chooser ? { chooser: true as const } : {}),
    page: step.page,
    title: measured.title,
    text: measured.text,
    ...(step.running ? { running: step.running } : {}),
    frame,
    // A centered card points at nothing; a chooser and an intro are centered.
    box: step.intro || step.chooser ? null : frac(measured.box),
    extra: measured.extra.map(frac).filter((r): r is Rect => !!r),
  }
}

const twoFrames = (p: Page) =>
  p.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

// What the recorder reads off the page. tour.js and builder.js are plain
// scripts, so these are declared here rather than imported.
type TourStep = {
  id: string
  part?: number
  intro?: boolean
  chooser?: boolean
  page?: string
  demo?: unknown
  running?: string
  extra?: string[]
  title: string
  text: string | (() => string)
  replay?: string
}
type TourWindow = Window & {
  TBTour: {
    STEPS: TourStep[]
    PARTS: { n: number; name: string; blurb: string }[]
    tour: {
      isActive(): boolean
      next(): unknown
      complete(): unknown
      cancel(): unknown
      getCurrentStep(): { id: string; el: HTMLElement | null; isOpen(): boolean; getTarget(): Element | null }
    }
  }
  TBBuilder?: { settled?: () => Promise<unknown> }
}

main()
  .catch((e) => {
    console.error(`failed at ${currentStep}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    process.exitCode = 1
  })
  .finally(async () => {
    // Leave nothing behind: a tour still running is canceled through its own
    // door; one that never got that far is binned by the endpoint directly.
    try {
      if (page && !finished) {
        const active = await page
          .evaluate(() => {
            const w = window as unknown as TourWindow
            return !!(w.TBTour && w.TBTour.tour && w.TBTour.tour.isActive())
          })
          .catch(() => false)
        if (active) {
          await page.evaluate(() => void (window as unknown as TourWindow).TBTour.tour.cancel()).catch(() => {})
          await page.waitForURL((u) => /^\/(rides)?\/?$/.test(u.pathname), { timeout: 15_000 }).catch(() => {})
        } else if (pos) {
          await page
            .evaluate(
              (rideId) =>
                fetch('/api/tour/done', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
                  body: JSON.stringify({ rideId }),
                }).then(() => undefined),
              pos.rideId,
            )
            .catch(() => {})
        }
      }
    } finally {
      await context?.close().catch(() => {})
      await browser?.close().catch(() => {})
    }
  })
