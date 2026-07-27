import 'dotenv/config'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFile } from 'node:fs/promises'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from './db/index'
import {
  rides,
  routes as routesTable,
  points as pointsTable,
  routeLegs,
  type RideRow,
  type UserRow,
} from './db/schema'
import { withSession, type AuthEnv } from './auth/middleware'
import { METERS_PER_MILE, type Track } from './maps/kml'
import { ROLE_META } from './maps/roles'
import { mapFilePath } from './maps/storage'
import { authRoutes } from './routes/auth'
import { dashboardRoutes } from './routes/dashboard'
import { mapsRoutes } from './routes/maps'
import { profileRoutes } from './routes/profile'
import { rideRoutes } from './routes/rides'
import { esc, jsonScript, MAPBOX_CSS_LINK, page, panelShell } from './views/layout'
import { GMAPS_KEY, MAPBOX_GL_VERSION, MAPBOX_TOKEN, PORT } from './config'

// Visibility gate: public/unlisted are viewable by anyone with the link;
// private only by its owner. Anything else (private to a non-owner, unknown
// slug) is treated as not-found so we never confirm it exists.
async function getViewable(slug: string, viewer: UserRow | null): Promise<RideRow | undefined> {
  if (!slug) return undefined
  const [r] = await db.select().from(rides).where(eq(rides.slug, slug)).limit(1)
  if (!r) return undefined
  if (r.visibility === 'public' || r.visibility === 'unlisted') return r
  if (viewer && viewer.id === r.ownerId) return r
  return undefined
}

// Color for listing swatches and the legacy metadata contract: the first
// route's color (imports have exactly one route).
async function firstRouteColor(rideId: number): Promise<string> {
  const [r] = await db
    .select({ color: routesTable.color })
    .from(routesTable)
    .where(and(eq(routesTable.rideId, rideId), eq(routesTable.position, 0)))
    .limit(1)
  return r?.color ?? '#0000cc'
}

const app = new Hono<AuthEnv>()

// Keep the former domains alive during the one-year transition, but make the
// canonical host unambiguous for cookies, sharing, and search engines. Each
// legacy host maps to its own environment so staging never lands on prod. This
// also runs ahead of every route, which is what keeps a legacy hostname from
// reaching /auth/cloudflare — only the canonical host is Access-protected.
const LEGACY_HOSTS: Readonly<Record<string, string>> = {
  'tankbag.app': 'routeloop.app',
  'www.tankbag.app': 'routeloop.app',
  'stage.tankbag.app': 'stage.routeloop.app',
}

app.use('*', async (c, next) => {
  const host = (c.req.header('host') ?? '').split(':', 1)[0].toLowerCase()
  const canonical = LEGACY_HOSTS[host]
  if (canonical) {
    const url = new URL(c.req.url)
    return c.redirect(`https://${canonical}${url.pathname}${url.search}`, 301)
  }
  await next()
})

// Static viewer assets (js/css/img/video) straight from public/. serveStatic
// honors Range requests, which the splash video needs — without 206 support a
// browser cannot seek and some will refuse to start playback at all.
app.use('/js/*', serveStatic({ root: './public' }))
app.use('/style/*', serveStatic({ root: './public' }))
app.use('/img/*', serveStatic({ root: './public' }))
app.use('/video/*', serveStatic({ root: './public' }))
app.use('/favicon.ico', serveStatic({ path: './public/img/favicon.ico' }))

// Resolves the session once per request so every template can render the right
// header. Mounted after the static assets so they skip the database entirely.
app.use('*', withSession)

app.route('/', authRoutes)
app.route('/', dashboardRoutes)
app.route('/', mapsRoutes)
app.route('/', rideRoutes)
app.route('/', profileRoutes)

// Signed-in home: the rider's latest work alongside public community picks.
// The gate is hand-rolled rather than requireActive because this route reads the
// user afterwards; keep the two branches in step with that middleware.
app.get('/', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/login', 302)
  if (user.status !== 'active') return c.redirect('/welcome', 302)

  const selectCards = () =>
    db
      .select({ ride: rides, color: routesTable.color })
      .from(rides)
      .leftJoin(routesTable, and(eq(routesTable.rideId, rides.id), eq(routesTable.position, 0)))

  const [recent, popular] = await Promise.all([
    selectCards().where(eq(rides.ownerId, user.id)).orderBy(desc(rides.updatedAt)).limit(10),
    selectCards()
      .where(eq(rides.visibility, 'public'))
      .orderBy(desc(rides.viewCount), desc(rides.createdAt))
      .limit(10),
  ])
  return c.html(homeHtml(rideCards(recent), rideCards(popular, true), user))
})

// Viewer page. Native rides render on the Mapbox shell from structured rows;
// imported rides stay on the legacy Google shell until Phase 4 unifies them.
app.get('/m/:slug', async (c) => {
  const viewer = c.get('user') ?? null
  const m = await getViewable(c.req.param('slug'), viewer)
  if (!m) return c.text('Not found', 404)
  await db
    .update(rides)
    .set({ viewCount: sql`${rides.viewCount} + 1` })
    .where(eq(rides.id, m.id))
  return c.html(m.source === 'native' ? nativeViewHtml(m, viewer) : viewHtml(m, GMAPS_KEY, viewer))
})

// The normalized public contract: everything the Mapbox viewer needs, for
// both sources, derived from structured rows only.
app.get('/api/public/rides/:slug/ride.json', async (c) => {
  const m = await getViewable(c.req.param('slug'), c.get('user'))
  if (!m) return c.json({ error: 'not found' }, 404)

  const routeRows = await db
    .select()
    .from(routesTable)
    .where(eq(routesTable.rideId, m.id))
    .orderBy(routesTable.position)
  if (routeRows.length === 0) return c.json({ error: 'not found' }, 404) // pre-pivot rows: legacy viewer only

  const routesOut = []
  for (const r of routeRows) {
    const pts = await db
      .select()
      .from(pointsTable)
      .where(eq(pointsTable.routeId, r.id))
      .orderBy(pointsTable.position)
    const legs = await db
      .select({ geometry: routeLegs.geometry })
      .from(routeLegs)
      .where(eq(routeLegs.routeId, r.id))
      .orderBy(routeLegs.position)

    // Concatenate leg geometries, dropping duplicated joints.
    const track: Track = []
    for (const leg of legs) {
      for (const pt of leg.geometry) {
        const last = track[track.length - 1]
        if (!last || last[0] !== pt[0] || last[1] !== pt[1]) track.push(pt)
      }
    }

    const pointOut = (p: (typeof pts)[number]) => ({
      lat: p.lat,
      lng: p.lng,
      name: p.name,
      description: p.description ?? '',
      roles: p.roles,
      distFromStartMi: p.distFromStartM == null ? null : Math.round((p.distFromStartM / METERS_PER_MILE) * 10) / 10,
    })
    routesOut.push({
      title: r.title,
      color: r.color,
      startAt: r.startAt?.toISOString() ?? null,
      distanceMi: Math.round((r.distanceM / METERS_PER_MILE) * 10) / 10,
      track,
      stops: pts.filter((p) => p.kind === 'stop').map((p) => ({ ...pointOut(p), durationMin: p.durationMin })),
      pois: pts.filter((p) => p.kind === 'poi').map(pointOut),
    })
  }

  // Downloads: imported rides stream their stored originals; native
  // generation lands with exports (Phase 3), until then no links.
  const isImported = m.source === 'imported'
  return c.json({
    title: m.title,
    description: m.description ?? '',
    source: m.source,
    totalMiles: Number(m.totalMiles),
    kmlUrl: isImported ? `/api/public/maps/${m.slug}/kml` : null,
    gpxUrl: isImported && m.gpxPresent ? `/api/public/maps/${m.slug}/gpx` : null,
    externalUrl: m.externalUrl || null,
    routes: routesOut,
  })
})

// Seam 1: legacy metadata JSON for the Google-Maps viewer (one-element array —
// the legend renders fine with one). Retires with main.js in Phase 4.
app.get('/api/public/maps/:slug', async (c) => {
  const m = await getViewable(c.req.param('slug'), c.get('user'))
  if (!m) return c.json({ error: 'not found' }, 404)
  return c.json([
    {
      name: m.title,
      color: await firstRouteColor(m.id),
      kmlUrl: `/api/public/maps/${m.slug}/kml`,
      gpxUrl: m.gpxPresent ? `/api/public/maps/${m.slug}/gpx` : null,
      externalUrl: m.externalUrl || null,
      gpxPresent: m.gpxPresent,
      waypointCount: m.stopCount,
      totalMiles: Number(m.totalMiles),
    },
  ])
})

// Seam 2 + GPX: gated file streams from outside-the-web-root storage.
app.get('/api/public/maps/:slug/kml', async (c) => {
  const m = await getViewable(c.req.param('slug'), c.get('user'))
  if (!m) return c.text('Not found', 404)
  return streamFile(c, m, 'kml', 'application/vnd.google-earth.kml+xml')
})
app.get('/api/public/maps/:slug/gpx', async (c) => {
  const m = await getViewable(c.req.param('slug'), c.get('user'))
  if (!m || !m.gpxPresent) return c.text('Not found', 404)
  return streamFile(c, m, 'gpx', 'application/gpx+xml')
})

async function streamFile(c: Context, m: RideRow, ext: 'kml' | 'gpx', type: string): Promise<Response> {
  // Path built only from integer ids, containment-checked in mapFilePath.
  const path = mapFilePath(m.ownerId, m.id, ext)
  if (!path) return c.text('Not found', 404)
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

// Both viewers render the same panel — only the engine below it differs — so the
// markup lives in one place and the two shells just pick their scripts.
function viewerPanel(m: RideRow): string {
  const desc = m.description ? `<p class="description">${esc(m.description)}</p>` : ''
  return panelShell({
    title: m.title,
    contents: `        <div class="details">${desc}</div>
        <div class="routes">
          <table class="route-table"></table>
          <label class="toggle-checkbox">
            <input type="checkbox" id="toggle-arrows" checked>
            Show Direction of Travel
          </label>
        </div>`,
  })
}

const VIEWER_NOSCRIPT = 'JavaScript is required to view the map.'

// The unified Mapbox viewer shell (native rides now; everything in Phase 4).
function nativeViewHtml(m: RideRow, user: UserRow | null): string {
  return page({
    title: m.title,
    user,
    variant: 'map',
    head: MAPBOX_CSS_LINK,
    noscript: VIEWER_NOSCRIPT,
    body: `  <div id="map"></div>\n\n  ${viewerPanel(m)}`,
    tb: {
      rideUrl: `/api/public/rides/${m.slug}/ride.json`,
      token: MAPBOX_TOKEN,
      roles: ROLE_META,
    },
    scripts: `<script src="https://api.mapbox.com/mapbox-gl-js/${MAPBOX_GL_VERSION}/mapbox-gl.js"></script>
  <script src="/js/map-common.js" defer></script>
  <script src="/js/viewer.js" defer></script>`,
  })
}

// Legacy Google shell, imported rides only. main.js reads window.MOTO rather
// than window.TB, so it gets its globals through `scripts`. Retires in Phase 4.
function viewHtml(m: RideRow, gmapsKey: string, user: UserRow | null): string {
  return page({
    title: m.title,
    user,
    variant: 'map',
    noscript: VIEWER_NOSCRIPT,
    body: `  <div id="map"></div>\n\n  ${viewerPanel(m)}`,
    scripts: `${jsonScript('MOTO', { metadataUrl: `/api/public/maps/${m.slug}` })}
  <script src="/js/main.js" defer></script>
  <script async defer
    src="https://maps.googleapis.com/maps/api/js?key=${esc(gmapsKey)}&v=beta&libraries=maps,geometry&callback=initMap"
    onerror="console.error('Maps API failed to load')"></script>`,
  })
}

type CardRow = { ride: RideRow; color: string | null }

function rideCards(rows: CardRow[], showViews = false): string {
  if (rows.length === 0) return '<p class="empty">No rides yet.</p>'
  return `<ul class="cards">${rows
    .map(
      ({ ride: m, color }) =>
        `<li><a class="card" href="/m/${esc(m.slug)}"><span class="swatch" style="background:${esc(color ?? '#0000cc')}"></span><span>${esc(m.title)}</span><span class="meta">${m.stopCount} stops &middot; ${Number(m.totalMiles)} mi${showViews ? ` &middot; ${m.viewCount} views` : ''}</span></a></li>`,
    )
    .join('')}</ul>`
}

function homeHtml(recentCards: string, popularCards: string, user: UserRow): string {
  return page({
    title: 'Home',
    user,
    navKey: 'home',
    body: `<main class="home">
      <h1>Welcome back, ${esc(user.displayName)}</h1>
      <p><a class="btn" href="/builder">Plan a ride</a></p>
      <div class="home-sections">
        <section class="home-section"><h2>Your recent rides</h2>${recentCards}</section>
        <section class="home-section"><h2>Popular public rides</h2>${popularCards}</section>
      </div>
    </main>`,
  })
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`routeloop dev → http://127.0.0.1:${info.port}`)
})
