import 'dotenv/config'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { desc, eq } from 'drizzle-orm'
import { db } from './db/index'
import { maps as mapsTable, type MapRow, type UserRow } from './db/schema'
import { withSession, type AuthEnv } from './auth/middleware'
import { authRoutes } from './routes/auth'
import { dashboardRoutes } from './routes/dashboard'
import { esc, page } from './views/layout'

const PORT = Number(process.env.PORT ?? 6686)
const GMAPS_KEY = process.env.GMAPS_KEY ?? ''
const STORAGE = resolve(process.env.STORAGE_PATH ?? './moto-storage')

// Visibility gate: only public/unlisted are viewable (no auth yet); anything
// else (private / unknown) is treated as not-found so we never confirm it exists.
async function getViewable(slug: string): Promise<MapRow | undefined> {
  if (!slug) return undefined
  const [m] = await db.select().from(mapsTable).where(eq(mapsTable.slug, slug)).limit(1)
  if (!m || (m.visibility !== 'public' && m.visibility !== 'unlisted')) return undefined
  return m
}

const app = new Hono<AuthEnv>()

// Static viewer assets (js/css/img) straight from public/.
app.use('/js/*', serveStatic({ root: './public' }))
app.use('/style/*', serveStatic({ root: './public' }))
app.use('/img/*', serveStatic({ root: './public' }))
app.use('/favicon.ico', serveStatic({ path: './public/favicon.ico' }))

// Resolves the session once per request so every template can render the right
// header. Mounted after the static assets so they skip the database entirely.
app.use('*', withSession)

app.route('/', authRoutes)
app.route('/', dashboardRoutes)

// Home listing (mirrors app/views/home.php).
app.get('/', async (c) => {
  const rows = await db
    .select()
    .from(mapsTable)
    .where(eq(mapsTable.visibility, 'public'))
    .orderBy(desc(mapsTable.createdAt))
  const cards = rows
    .map(
      (m) =>
        `<li><a class="card" href="/m/${esc(m.slug)}"><span class="swatch" style="background:${esc(m.color)}"></span><span>${esc(m.title)}</span><span class="meta">${m.waypointCount} stops &middot; ${Number(m.totalMiles)} mi</span></a></li>`,
    )
    .join('')
  return c.html(homeHtml(cards || '<p class="empty">No public maps yet.</p>', c.get('user')))
})

// Viewer page (mirrors app/views/view.php).
app.get('/m/:slug', async (c) => {
  const m = await getViewable(c.req.param('slug'))
  if (!m) return c.text('Not found', 404)
  return c.html(viewHtml(m, GMAPS_KEY))
})

// Seam 1: metadata JSON (one-element array — the legend renders fine with one).
app.get('/api/public/maps/:slug', async (c) => {
  const m = await getViewable(c.req.param('slug'))
  if (!m) return c.json({ error: 'not found' }, 404)
  return c.json([
    {
      name: m.title,
      color: m.color,
      kmlUrl: `/api/public/maps/${m.slug}/kml`,
      gpxUrl: m.gpxPresent ? `/api/public/maps/${m.slug}/gpx` : null,
      externalUrl: m.externalUrl || null,
      gpxPresent: m.gpxPresent,
      waypointCount: m.waypointCount,
      totalMiles: Number(m.totalMiles),
    },
  ])
})

// Seam 2 + GPX: gated file streams from outside-the-web-root storage.
app.get('/api/public/maps/:slug/kml', async (c) => {
  const m = await getViewable(c.req.param('slug'))
  if (!m) return c.text('Not found', 404)
  return streamFile(c, m, 'kml', 'application/vnd.google-earth.kml+xml')
})
app.get('/api/public/maps/:slug/gpx', async (c) => {
  const m = await getViewable(c.req.param('slug'))
  if (!m || !m.gpxPresent) return c.text('Not found', 404)
  return streamFile(c, m, 'gpx', 'application/gpx+xml')
})

async function streamFile(c: Context, m: MapRow, ext: string, type: string): Promise<Response> {
  // Path built only from integer ids, then containment-checked against STORAGE.
  const path = resolve(STORAGE, String(m.ownerId), `${m.id}.${ext}`)
  if (path !== STORAGE && !path.startsWith(STORAGE + sep)) return c.text('Not found', 404)
  let buf: Buffer
  try {
    buf = await readFile(path)
  } catch {
    return c.text('Not found', 404)
  }
  const headers: Record<string, string> = {
    'Content-Type': `${type}; charset=utf-8`,
    'X-Content-Type-Options': 'nosniff',
  }
  if (c.req.query('dl') !== undefined) {
    const safe = m.title.replace(/[^A-Za-z0-9._-]+/g, '-') || 'route'
    headers['Content-Disposition'] = `attachment; filename="${safe}.${ext}"`
  }
  return new Response(buf, { headers })
}

// --- Templates ------------------------------------------------------------
function viewHtml(m: MapRow, gmapsKey: string): string {
  const metadataUrl = `/api/public/maps/${m.slug}`
  const desc = m.description ? `<p class="description">${esc(m.description)}</p>` : ''
  return `<!doctype html>
<html lang="en-US">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(m.title)} — tankbag</title>
  <link href="https://fonts.googleapis.com/css?family=Lato:300,400,700,900" rel="stylesheet">
  <link rel="stylesheet" href="/style/main.min.css">
</head>
<body>
  <div id="map"></div>

  <div id="info-panel" class="floating-panel">
    <button class="collapse-toggle" aria-label="Collapse panel">
      <img src="/img/icons/icon-collapse.svg" alt="Collapse" class="collapse-icon">
    </button>

    <h1 class="panel-title">${esc(m.title)}</h1>

    <div class="panel-contents-wrapper">
      <div class="panel-content">
        <div class="details">${desc}</div>
        <div class="routes">
          <table class="route-table"></table>
          <label class="toggle-checkbox">
            <input type="checkbox" id="toggle-arrows" checked>
            Show Direction of Travel
          </label>
        </div>
      </div>
    </div>
  </div>

  <noscript><p style="padding:1em">JavaScript is required to view the map.</p></noscript>

  <script>window.MOTO = { metadataUrl: ${JSON.stringify(metadataUrl)} };</script>
  <script src="/js/main.js" defer></script>
  <script async defer
    src="https://maps.googleapis.com/maps/api/js?key=${esc(gmapsKey)}&v=beta&libraries=maps,geometry&callback=initMap"
    onerror="console.error('Maps API failed to load')"></script>
</body>
</html>`
}

function homeHtml(cards: string, user: UserRow | null): string {
  return page({
    title: 'tankbag',
    user,
    body: `<h1>tankbag</h1>
  <div class="sub">Public road-trip maps</div>
  <ul class="cards">${cards}</ul>`,
  })
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`tankbag dev → http://127.0.0.1:${info.port}`)
})
