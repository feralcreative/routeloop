// The server half of the service worker (#69): the precache list, the build
// stamp, and the one function that turns public/js/sw.js into what /sw.js
// serves.
//
// WHY A ROUTE AND NOT A STATIC FILE. A worker has to be served from the scope
// it controls — `/sw.js` for the whole site — and serveStatic mounts under
// `/js/`. It also has to know the build, so the shell cache is replaced when
// the shell changes, and a static file cannot know that. So the source lives
// with the other scripts (which is what gets it minified in the image) and the
// route reads it, fills in two placeholders and sends it with `no-cache`.
//
// THE BUILD STAMP IS THE SHA PLUS A HASH OF THE PRECACHE URLS. On prod the sha
// alone would do; on dev it is empty, and the asset hashes inside the list are
// what change when a file is edited — so hashing the list keys the shell cache
// on its exact contents on both.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { asset } from './assets'
import { BUILD_SHA } from '../version'

// Bare paths. Every one is wrapped in asset() at serve time so the worker
// caches the exact URL the pages reference; `/offline` is the one page in the
// list and carries no hash. test/sw.test.ts checks each file exists.
//
// What the go page loads, and nothing the go page does not: the shell is what
// makes a kept ride's page RENDER offline, not a copy of the site.
export const PRECACHE_PATHS = [
  '/style/main.min.css',
  '/js/motion.js',
  '/js/units.js',
  '/js/vocab.js',
  '/js/feedback-buffer.js',
  '/js/site.js',
  '/js/notifications.js',
  // Emitted by page() on every prod page (src/views/analytics.ts). Offline it
  // loads and finds no Google to talk to, which is fine; a kept page that
  // 404s one of its own scripts is not, so it is in the shell like the rest.
  '/js/consent.js',
  '/js/go-progress.js',
  '/js/keep.js',
  '/js/go.js',
  '/font/overpass-latin.woff2',
  '/font/overpass-latin-ext.woff2',
  '/img/favicon/favicon-96x96.png',
  '/img/favicon/favicon.svg',
  '/img/favicon/apple-touch-icon.png',
  '/img/site.webmanifest',
] as const

export const OFFLINE_PATH = '/offline'

// The page surface in the two default schemes, for the theme-color meta.
// Declared rather than read out of the built stylesheet at request time, the
// role-colors.ts arrangement: test/theme-color.test.ts compiles the palette and
// fails if `$white` moves under these.
export const THEME_COLOR = { light: '#ffffff', dark: '#0a0e11' } as const

const SW_SOURCE = join(process.cwd(), 'public', 'js', 'sw.js')

let cached: { mtimeMs: number; body: string } | null = null

export function precacheUrls(): string[] {
  return [...PRECACHE_PATHS.map((p) => asset(p)), OFFLINE_PATH]
}

export function swBuild(urls: string[]): string {
  const h = createHash('sha256').update(JSON.stringify(urls)).digest('hex').slice(0, 10)
  return `${BUILD_SHA || 'dev'}-${h}`
}

/**
 * The worker's script with its placeholders filled. Re-read when the source's
 * mtime changes, so a dev edit lands without a restart and production reads
 * the file once.
 */
export function swScript(): string {
  const { mtimeMs } = statSync(SW_SOURCE)
  const urls = precacheUrls()
  const build = swBuild(urls)
  if (!cached || cached.mtimeMs !== mtimeMs) {
    cached = { mtimeMs, body: readFileSync(SW_SOURCE, 'utf8') }
  }
  return cached.body.replace('"__RL_BUILD__"', JSON.stringify(build)).replace('"__RL_PRECACHE__"', JSON.stringify(JSON.stringify(urls)))
}
