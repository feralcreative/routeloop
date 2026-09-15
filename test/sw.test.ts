// The service worker (#69), driven with a fake `self`.
//
// There is no browser suite, and a worker's failure modes are the silent kind:
// a denylist with a hole in it caches the builder's API for a rider on a
// borrowed phone, and a precache naming a file that does not exist fails the
// install with nothing on the page to say so. So the worker's source is
// evaluated here with fakes for `self`, `caches` and `fetch`, and its handlers
// are driven with the requests that matter.
//
// The second half reads the source of go.js, sw.js and the manifest as TEXT
// and pins what has to agree across them — the filename.ts/filename.js
// arrangement, for the cache name the page writes and the worker reads.
import { describe, expect, it, beforeEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRECACHE_PATHS, OFFLINE_PATH, precacheUrls, swBuild, swScript } from '../src/views/sw'

const ORIGIN = 'https://routeloop.app'
const SW_SRC = readFileSync('public/js/sw.js', 'utf8')
const GO_SRC = readFileSync('public/js/go.js', 'utf8')

// --- A tiny Cache API ---------------------------------------------------------

class FakeCache {
  store = new Map<string, Response>()
  puts: string[] = []
  private keyOf(req: Request | string): string {
    return typeof req === 'string' ? new URL(req, ORIGIN).href : req.url
  }
  async match(req: Request | string, opts?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
    const key = this.keyOf(req)
    if (this.store.has(key)) return this.store.get(key)!.clone()
    if (opts?.ignoreSearch) {
      const path = new URL(key).pathname
      for (const [k, v] of this.store) if (new URL(k).pathname === path) return v.clone()
    }
    return undefined
  }
  async put(req: Request | string, res: Response): Promise<void> {
    const key = this.keyOf(req)
    this.puts.push(key)
    this.store.set(key, res)
  }
  async addAll(urls: string[]): Promise<void> {
    for (const u of urls) {
      const res = await (globalThis as any).__fetch(new Request(new URL(u, ORIGIN).href))
      if (!res.ok) throw new TypeError(`addAll: ${u} -> ${res.status}`)
      await this.put(u, res)
    }
  }
  async delete(req: Request | string): Promise<boolean> {
    return this.store.delete(this.keyOf(req))
  }
  async keys(): Promise<Request[]> {
    return [...this.store.keys()].map((k) => new Request(k))
  }
}

class FakeCaches {
  caches = new Map<string, FakeCache>()
  async open(name: string): Promise<FakeCache> {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache())
    return this.caches.get(name)!
  }
  async keys(): Promise<string[]> {
    return [...this.caches.keys()]
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name)
  }
  async match(req: Request | string, opts?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
    for (const c of this.caches.values()) {
      const hit = await c.match(req, opts)
      if (hit) return hit
    }
    return undefined
  }
}

type Handlers = Record<string, (event: any) => void>

function boot(opts: { build?: string; precache?: string[]; network?: (req: Request) => Promise<Response> } = {}) {
  const handlers: Handlers = {}
  const caches = new FakeCaches()
  const network =
    opts.network ??
    (async (req: Request) => new Response('ok ' + new URL(req.url).pathname, { status: 200, headers: { 'Content-Type': 'text/plain' } }))
  ;(globalThis as any).__fetch = network
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (name: string, fn: (e: any) => void) => {
      handlers[name] = fn
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  }
  const src = SW_SRC.replace('"__RL_BUILD__"', JSON.stringify(opts.build ?? 'test-build')).replace(
    '"__RL_PRECACHE__"',
    JSON.stringify(JSON.stringify(opts.precache ?? ['/style/main.min.css?v=abc', '/offline'])),
  )
  new Function('self', 'caches', 'fetch', 'Response', 'Request', 'URL', src)(self, caches, network, Response, Request, URL)
  return { handlers, caches, network }
}

async function runInstallActivate(h: Handlers) {
  const waits: Promise<unknown>[] = []
  h.install({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
  await Promise.all(waits)
  waits.length = 0
  h.activate({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
  await Promise.all(waits)
}

// Drives the fetch handler and reports whether it took the request at all.
async function drive(h: Handlers, url: string, init: { method?: string; mode?: string } = {}) {
  const request = new Request(new URL(url, ORIGIN).href, { method: init.method ?? 'GET' })
  if (init.mode) Object.defineProperty(request, 'mode', { value: init.mode })
  const box: { responded: Promise<Response> | null } = { responded: null }
  h.fetch({
    request,
    respondWith: (p: Promise<Response> | Response) => {
      box.responded = Promise.resolve(p)
    },
    waitUntil: () => {},
  })
  // Let the handler's synchronous part settle.
  await Promise.resolve()
  const response: Response | null = box.responded ? await box.responded : null
  return { taken: box.responded !== null, response }
}

// --- The handlers --------------------------------------------------------------

describe('install and activate', () => {
  it('precaches the shell atomically and replaces old shells, never the kept cache', async () => {
    const { handlers, caches } = boot({ build: 'new' })
    ;(await caches.open('routeloop-shell-old')).store.set(ORIGIN + '/x', new Response('old'))
    ;(await caches.open('routeloop-kept')).store.set(ORIGIN + '/_kept/coast', new Response('{}'))
    await runInstallActivate(handlers)
    expect(await caches.keys()).toEqual(expect.arrayContaining(['routeloop-shell-new', 'routeloop-kept']))
    expect(await caches.keys()).not.toContain('routeloop-shell-old')
    const shell = await caches.open('routeloop-shell-new')
    expect(await shell.match('/offline')).toBeTruthy()
    expect(await shell.match('/style/main.min.css?v=abc')).toBeTruthy()
  })

  it('fails the install loudly when a precached file is missing', async () => {
    const { handlers } = boot({
      precache: ['/js/does-not-exist.js'],
      network: async () => new Response('nope', { status: 404 }),
    })
    const waits: Promise<unknown>[] = []
    handlers.install({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await expect(Promise.all(waits)).rejects.toThrow(/addAll/)
  })
})

describe('what the worker never touches', () => {
  let h: Handlers
  beforeEach(async () => {
    const b = boot()
    h = b.handlers
    await runInstallActivate(h)
  })

  it('leaves non-GET requests alone', async () => {
    expect((await drive(h, '/api/public/maps/coast/gpx', { method: 'POST' })).taken).toBe(false)
  })

  it('leaves other origins alone', async () => {
    expect((await drive(h, 'https://maps.googleapis.com/maps/api/js')).taken).toBe(false)
    expect((await drive(h, 'https://cdn.jsdelivr.net/npm/sortablejs')).taken).toBe(false)
  })

  // The builder's API, the notification poll, admin, sign-in, and every
  // non-public API. A hole here caches a rider's private data on a borrowed
  // phone or serves a stale save.
  it('never intercepts the denylist', async () => {
    for (const p of [
      '/api/rides/8',
      '/api/rides/8/live',
      '/api/notifications/pending',
      '/api/places/search',
      '/api/tour/start',
      '/api/profile',
      '/admin',
      '/admin/riders',
      '/login',
      '/logout',
      '/auth/google/callback',
      '/account/download',
      '/healthz',
      '/sw.js',
      '/build/8',
      '/import',
      '/export',
      '/settings',
      '/profile',
      '/riders',
      '/friends',
      '/notifications',
      '/feedback',
    ]) {
      expect((await drive(h, p)).taken, p).toBe(false)
    }
  })

  it('leaves the viewer payload alone even for a kept ride', async () => {
    // ride.json is the viewer's contract and not on a kept page; it is neither
    // a ride page nor a by-slug file, so it falls to the browser.
    expect((await drive(h, '/api/public/rides/coast/ride.json')).taken).toBe(false)
  })
})

describe('the shell', () => {
  it('serves a hashed asset from the shell', async () => {
    const { handlers } = boot()
    await runInstallActivate(handlers)
    const exact = await drive(handlers, '/style/main.min.css?v=abc')
    expect(exact.taken).toBe(true)
    expect(await exact.response!.text()).toContain('/style/main.min.css')
  })

  // A kept page from an older deploy asks for the old hash. Offline, the shell
  // answers by path rather than leaving the page unstyled.
  it('falls back by path when the hash is from an older deploy', async () => {
    const b = boot({ network: async () => Promise.reject(new TypeError('offline')) })
    ;(await b.caches.open('routeloop-shell-test-build')).store.set(ORIGIN + '/style/main.min.css?v=abc', new Response('css'))
    const byPath = await drive(b.handlers, '/style/main.min.css?v=old')
    expect(byPath.taken).toBe(true)
    expect(await byPath.response!.text()).toBe('css')
  })
})

describe('a kept ride', () => {
  const kept = async (caches: FakeCaches, slug: string) =>
    (await caches.open('routeloop-kept')).store.set(ORIGIN + '/_kept/' + slug, new Response('{"slug":"' + slug + '"}'))

  it('is not cached until it is kept', async () => {
    const { handlers, caches } = boot()
    await runInstallActivate(handlers)
    const r = await drive(handlers, '/m/coast/go')
    expect(r.taken).toBe(true) // taken for the offline fallback, but nothing stored
    expect(r.response!.status).toBe(200)
    expect((await caches.open('routeloop-kept')).puts).toEqual([])
  })

  it('refreshes a kept ride from the network and stores what came back', async () => {
    const { handlers, caches } = boot()
    await runInstallActivate(handlers)
    await kept(caches, 'coast')
    for (const p of ['/m/coast/go', '/m/coast/roadbook', '/api/public/maps/coast/gpx?dl', '/api/public/maps/coast/routeloop.json?dl']) {
      const r = await drive(handlers, p)
      expect(r.taken, p).toBe(true)
      expect(r.response!.status).toBe(200)
    }
    const c = await caches.open('routeloop-kept')
    expect(c.puts).toEqual([
      ORIGIN + '/m/coast/go',
      ORIGIN + '/m/coast/roadbook',
      ORIGIN + '/api/public/maps/coast/gpx?dl',
      ORIGIN + '/api/public/maps/coast/routeloop.json?dl',
    ])
  })

  it('does not store a failed response', async () => {
    const { handlers, caches } = boot({ network: async () => new Response('gone', { status: 404 }) })
    await runInstallActivate(handlers).catch(() => {})
    await kept(caches, 'coast')
    await drive(handlers, '/m/coast/go')
    expect((await caches.open('routeloop-kept')).puts).toEqual([])
  })

  it('answers a kept ride from cache when the network is gone', async () => {
    const { handlers, caches } = boot({ network: async () => Promise.reject(new TypeError('offline')) })
    await kept(caches, 'coast')
    const c = await caches.open('routeloop-kept')
    c.store.set(ORIGIN + '/m/coast/go', new Response('the page'))
    c.store.set(ORIGIN + '/api/public/maps/coast/gpx?dl', new Response('<gpx/>'))
    const page = await drive(handlers, '/m/coast/go', { mode: 'navigate' })
    expect(await page.response!.text()).toBe('the page')
    const gpx = await drive(handlers, '/api/public/maps/coast/gpx?dl')
    expect(await gpx.response!.text()).toBe('<gpx/>')
  })

  it('sends an unkept navigation to the offline page when the network is gone', async () => {
    const { handlers, caches } = boot({ network: async () => Promise.reject(new TypeError('offline')) })
    ;(await caches.open('routeloop-shell-test-build')).store.set(ORIGIN + '/offline', new Response('no signal'))
    const r = await drive(handlers, '/m/other/go', { mode: 'navigate' })
    expect(await r.response!.text()).toBe('no signal')
    const any = await drive(handlers, '/', { mode: 'navigate' })
    expect(await any.response!.text()).toBe('no signal')
  })
})

// --- What has to agree across files ---------------------------------------------

describe('the pieces agree', () => {
  it('names the kept cache the same in go.js and sw.js', () => {
    const inGo = /KEPT_CACHE = "([^"]+)"/.exec(GO_SRC)?.[1]
    const inSw = /var KEPT = "([^"]+)"/.exec(SW_SRC)?.[1]
    expect(inGo).toBe('routeloop-kept')
    expect(inSw).toBe(inGo)
    expect(/REGISTRY_PREFIX = "\/_kept\/"/.test(GO_SRC)).toBe(true)
    expect(/REGISTRY_PREFIX = "\/_kept\/"/.test(SW_SRC)).toBe(true)
  })

  it('carries both placeholders in the source and none in what is served', () => {
    expect(SW_SRC).toContain('"__RL_BUILD__"')
    expect(SW_SRC).toContain('"__RL_PRECACHE__"')
    const served = swScript()
    expect(served).not.toContain('__RL_BUILD__')
    expect(served).not.toContain('__RL_PRECACHE__')
    expect(served).toContain(JSON.stringify(swBuild(precacheUrls())))
  })

  it('precaches only files that exist, plus the offline page', () => {
    for (const p of PRECACHE_PATHS) {
      expect(existsSync(join('public', p)), p).toBe(true)
    }
    const urls = precacheUrls()
    expect(urls[urls.length - 1]).toBe(OFFLINE_PATH)
    // Every page the go route loads is in the shell: a script missing here is a
    // kept page that renders and does nothing.
    const go = readFileSync('src/routes/go.tsx', 'utf8')
    for (const m of go.matchAll(/asset\('(\/js\/[^']+)'\)/g)) {
      expect(PRECACHE_PATHS as readonly string[], m[1]).toContain(m[1])
    }
  })

  it('keys the build on the sha and the list', () => {
    const a = swBuild(['/a'])
    const b = swBuild(['/b'])
    expect(a).not.toBe(b)
    expect(a).toMatch(/^(dev|[0-9a-f]+)-[0-9a-f]{10}$/)
  })

  it('has a manifest that installs as minimal-ui with icons that exist', () => {
    const m = JSON.parse(readFileSync('public/img/site.webmanifest', 'utf8'))
    // minimal-ui, not standalone: iOS standalone has no download manager, so a
    // GPX link traps the rider in a full-screen preview with no way back.
    expect(m.display).toBe('minimal-ui')
    expect(m.scope).toBe('/')
    expect(m.start_url).toBe('/')
    expect(m.id).toBe('/')
    expect(Array.isArray(m.icons) && m.icons.length).toBeGreaterThan(0)
    for (const icon of m.icons) expect(existsSync(join('public', icon.src)), icon.src).toBe(true)
    expect(m.icons.some((i: any) => i.purpose === 'maskable')).toBe(true)
  })
})
