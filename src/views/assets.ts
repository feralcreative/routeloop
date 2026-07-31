// Content-hash cache-busting for same-origin static assets.
//
// Assets ship with a long max-age (see the Cloudflare config) and have stable
// filenames, so without this a new deploy depends on an edge purge to refresh
// the CDN — and end users' browsers still hold the old file for the full
// max-age regardless of that purge. Appending a content hash makes an asset's
// URL change when, and only when, its bytes change, so browsers and Cloudflare
// fetch the new version automatically and cache the old and new URLs
// independently. A deploy no longer relies on anyone clearing a cache.
//
// Only ever called with literal in-repo paths (never user input), so there is
// no path-traversal surface. The query string is ignored by serveStatic and is
// part of Cloudflare's cache key by default, which is exactly what makes it bust.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// serveStatic already resolves './public' against cwd, so the process runs from
// the app root; mirror that here.
const PUBLIC_DIR = join(process.cwd(), 'public')

// Keyed by URL path, guarded by mtime: production hashes each file once (the
// bytes are fixed for the life of the container), while a dev edit changes the
// mtime and re-hashes on the next request without a restart.
const cache = new Map<string, { mtimeMs: number; token: string }>()

export function asset(path: string): string {
  try {
    const file = join(PUBLIC_DIR, path)
    const { mtimeMs } = statSync(file)
    const hit = cache.get(path)
    if (hit && hit.mtimeMs === mtimeMs) return `${path}?v=${hit.token}`
    const token = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10)
    cache.set(path, { mtimeMs, token })
    return `${path}?v=${token}`
  } catch {
    // A missing or unreadable asset must never break the page — fall back to the
    // bare path, which will 404 on its own if the file is genuinely absent.
    return path
  }
}
