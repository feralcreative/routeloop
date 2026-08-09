// Live reload for local development. Two halves: an SSE endpoint the browser
// subscribes to, and the client snippet that consumes it (injected by
// views/layout.tsx). Both are gated on IS_DEV at their call sites, so neither
// the route nor the script can reach a deployed environment.
//
// Why this rather than Browsersync: Browsersync proxies the app on a second
// port and rewrites the HTML on the way through, so you browse at an origin the
// app never sees — awkward in a codebase whose CSRF gate, OAuth redirect and
// cookie Secure flag all key off APP_ORIGIN. This needs no proxy, no second
// port and no dependency.
//
// A stylesheet change swaps the <link> in place instead of reloading the page,
// which is the whole point on map pages: a reload destroys the Google Maps
// instance, the viewport and whatever ride is loaded, so tweaking one panel
// rule would otherwise cost you your place on every save.
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { watch } from 'node:fs'
import { join } from 'node:path'

const PUBLIC_DIR = join(process.cwd(), 'public')

// Identifies this process to the browser. `tsx watch` restarts the server on
// any src/ change, which drops every connection; EventSource reconnects on its
// own, sees a different id and reloads, so server-rendered changes appear
// without a manual refresh. A reconnect to the *same* process (a sleeping
// laptop, a dropped socket) keeps the page as it is.
const BOOT_ID = `${process.pid}-${Date.now()}`

// Separate counters rather than one counter plus a "last kind", so a CSS write
// and a JS write inside the same poll window cannot mask each other.
const versions = { css: 0, js: 0 }

// Long enough to collapse the burst of events a single sass compile produces,
// short enough to feel immediate.
const DEBOUNCE_MS = 60

// Clients poll these counters instead of registering a callback each. The
// difference matters for a disconnect the runtime never reports as an abort:
// a poll loop notices on its own terms, where a queued write would sit forever.
const POLL_MS = 200

/**
 * Watches a directory under public/ and bumps `versions[key]` when a file we
 * care about changes.
 *
 * The directory is watched rather than the file because a compiler that writes
 * atomically (write to a temp name, rename over the target) replaces the inode,
 * and a watch bound to a single file goes deaf the first time that happens.
 */
function watchDir(dir: string, matches: (file: string) => boolean, key: keyof typeof versions): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    watch(join(PUBLIC_DIR, dir), (_event, file) => {
      if (!file || !matches(String(file))) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        versions[key]++
      }, DEBOUNCE_MS)
    })
  } catch {
    // A missing directory is not worth taking the dev server down for; the
    // other watcher, and the rest of the app, carry on without it.
  }
}

export function startLiveReload(): void {
  // Only the compiled stylesheet. Its .map sibling is rewritten by the same
  // compile and would double every event for nothing.
  watchDir('style', (f) => f === 'main.min.css', 'css')
  // Viewer scripts are served straight from public/ and are invisible to
  // `tsx watch`, so nothing else notices when one changes.
  watchDir('js', (f) => f.endsWith('.js'), 'js')
}

export const devReloadRoutes = new Hono()

devReloadRoutes.get('/__dev/reload', (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'boot', data: BOOT_ID })
    const seen = { ...versions }
    // Two abort checks because they fail independently: `stream.aborted` covers
    // a cancelled response body, the request signal covers the socket closing
    // under it. Without both, a closed tab can leave this loop spinning for the
    // life of the process.
    while (!stream.aborted && !c.req.raw.signal.aborted) {
      if (versions.js !== seen.js) {
        seen.js = versions.js
        seen.css = versions.css
        await stream.writeSSE({ event: 'reload', data: String(seen.js) })
      } else if (versions.css !== seen.css) {
        seen.css = versions.css
        await stream.writeSSE({ event: 'css', data: String(seen.css) })
      }
      await stream.sleep(POLL_MS)
    }
  }),
)

/**
 * The client half, inlined into every page in development.
 *
 * Deliberately dependency-free and defensive: this runs before anything else on
 * the page and must never be the reason a dev page fails to render.
 */
export function liveReloadScript(): string {
  return `<script>
(() => {
  let boot = null;
  const es = new EventSource('/__dev/reload');
  es.addEventListener('boot', (e) => {
    // First hello establishes the baseline; a different one means the server
    // restarted while we were away and the HTML may be stale.
    if (boot === null) boot = e.data;
    else if (e.data !== boot) location.reload();
  });
  es.addEventListener('reload', () => location.reload());
  es.addEventListener('css', () => {
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      const href = link.getAttribute('href') || '';
      if (!href.startsWith('/style/')) continue;
      // Swap rather than mutate the href: the replacement only takes over once
      // it has loaded, so no frame is ever painted unstyled.
      const next = link.cloneNode();
      next.setAttribute('href', href.split('?')[0] + '?v=' + Date.now());
      next.addEventListener('load', () => link.remove());
      next.addEventListener('error', () => next.remove());
      link.parentNode.insertBefore(next, link.nextSibling);
    }
  });
})();
</script>`
}
