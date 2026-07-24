// The ride builder's API and page shells. A ride payload is the full graph —
// ride meta + routes + stops/POIs + routed legs — saved whole (PUT is a
// full-replace inside one transaction). The builder MVP sends exactly one
// route; the API accepts many from day one (multi-day rides are the trip
// phase, the schema and this surface are already shaped for them).
import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index'
import {
  rides,
  routes as routesTable,
  points as pointsTable,
  routeLegs,
  type RideRow,
} from '../db/schema'
import { currentUser, requireAuth, requireAuthApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import {
  METERS_PER_MILE,
  distFromStartAlongTrack,
  sanitizeText,
  trackMeters,
  type Track,
} from '../maps/kml'
import { MAX_ROLES_PER_POINT, ROLES, ROLE_META } from '../maps/roles'
import { generateSlug } from '../maps/slug'
import { turnstileEnabled, verifyTurnstile } from '../maps/turnstile'
import { fields, firstIssue, ownRide } from './maps'

export const rideRoutes = new Hono<AuthEnv>()

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN ?? ''

// A native ride is DB rows, not files — caps bound the rows since byte quota
// does not apply. 8 MB JSON backstop over the structural caps.
const BODY_LIMIT = 8 * 1024 * 1024
const MAX_ROUTES = 31
const MAX_STOPS = 200
const MAX_POIS = 200
const MAX_VIAS_PER_LEG = 20
const MAX_PTS_PER_LEG = 25000
const MAX_PTS_PER_RIDE = 200000

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

// --- Payload schema --------------------------------------------------------

const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])

const stopSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  name: z.string().max(255).default(''),
  description: z.string().max(2000).default(''),
  roles: z.array(z.enum(ROLES)).max(MAX_ROLES_PER_POINT).default([]),
  durationMin: z.number().int().min(0).max(43200).nullable().default(null), // ≤ 30 days
})
const poiSchema = stopSchema.omit({ durationMin: true })

const legSchema = z.object({
  geometry: z.array(lngLat).min(2).max(MAX_PTS_PER_LEG),
  distanceM: z.number().int().min(0),
  durationS: z.number().int().min(0),
  viaPoints: z.array(lngLat).max(MAX_VIAS_PER_LEG).default([]),
})

const routeSchema = z
  .object({
    title: z.string().max(150).default(''),
    color: fields.color.default('#0000cc'),
    startAt: z.iso.datetime({ offset: true }).nullable().default(null),
    endAt: z.iso.datetime({ offset: true }).nullable().default(null),
    stops: z.array(stopSchema).min(1).max(MAX_STOPS),
    pois: z.array(poiSchema).max(MAX_POIS).default([]),
    legs: z.array(legSchema),
  })
  .refine((r) => r.legs.length === Math.max(0, r.stops.length - 1), {
    message: 'legs must connect consecutive stops (stops - 1 legs)',
  })

const ridePayload = z
  .object({
    title: fields.title,
    description: fields.description.default(''),
    visibility: fields.visibility.default('private'),
    external_url: fields.external_url.default(''),
    routes: z.array(routeSchema).min(1).max(MAX_ROUTES),
  })
  .refine(
    (p) => p.routes.reduce((n, r) => n + r.legs.reduce((m, l) => m + l.geometry.length, 0), 0) <= MAX_PTS_PER_RIDE,
    { message: `ride exceeds ${MAX_PTS_PER_RIDE} track points` },
  )

type RidePayload = z.infer<typeof ridePayload>

// --- Integrity + persistence ----------------------------------------------

// Normalizes a validated payload in place: rounds coordinates, sanitizes all
// user text, and clamps client-claimed leg distances to reality — Directions
// distances are authoritative in the honest case, but a claimed value that
// deviates > 15 % from the haversine length of the submitted geometry is
// replaced by the haversine value, so spoofing is bounded.
function normalize(p: RidePayload): void {
  for (const r of p.routes) {
    r.title = sanitizeText(r.title)
    for (const s of [...r.stops, ...r.pois]) {
      s.lat = round6(s.lat)
      s.lng = round6(s.lng)
      s.name = sanitizeText(s.name)
      s.description = sanitizeText(s.description)
    }
    for (const l of r.legs) {
      l.geometry = l.geometry.map(([lng, lat]) => [round6(lng), round6(lat)])
      l.viaPoints = l.viaPoints.map(([lng, lat]) => [round6(lng), round6(lat)])
      const actual = Math.round(trackMeters(l.geometry as Track))
      if (actual > 0 && Math.abs(l.distanceM - actual) > actual * 0.15) l.distanceM = actual
    }
  }
}

// Ride-level caches derived from the normalized payload.
function rideTotals(p: RidePayload) {
  let meters = 0
  let seconds = 0
  let stops = 0
  for (const r of p.routes) {
    meters += r.legs.reduce((n, l) => n + l.distanceM, 0)
    seconds += r.legs.reduce((n, l) => n + l.durationS, 0)
    seconds += r.stops.reduce((n, s) => n + (s.durationMin ?? 0) * 60, 0)
    stops += r.stops.length
  }
  return { totalMiles: (meters / METERS_PER_MILE).toFixed(1), totalDurationS: seconds, stopCount: stops }
}

// Inserts the route graph for a ride. Callers run this inside a transaction,
// on a ride that has no routes (fresh insert or after a full-replace delete).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
async function insertRideGraph(tx: Tx, rideId: number, p: RidePayload): Promise<void> {
  for (let ri = 0; ri < p.routes.length; ri++) {
    const r = p.routes[ri]
    const legDistM = r.legs.map((l) => l.distanceM)
    const [route] = await tx
      .insert(routesTable)
      .values({
        rideId,
        position: ri,
        title: r.title,
        color: r.color,
        startAt: r.startAt ? new Date(r.startAt) : null,
        endAt: r.endAt ? new Date(r.endAt) : null,
        distanceM: legDistM.reduce((a, b) => a + b, 0),
        durationS: r.legs.reduce((n, l) => n + l.durationS, 0),
      })
      .returning()

    // Stops: cumulative distance is the prefix sum of leg distances.
    const prefix: number[] = [0]
    for (const d of legDistM) prefix.push(prefix[prefix.length - 1] + d)
    const stopRows = r.stops.map((s, i) => ({
      routeId: route.id,
      kind: 'stop' as const,
      position: i,
      lat: s.lat,
      lng: s.lng,
      name: s.name,
      description: s.description || null,
      roles: s.roles,
      durationMin: s.durationMin,
      distFromStartM: prefix[Math.min(i, prefix.length - 1)],
    }))

    // POIs: projected onto the route's concatenated track.
    const track = r.legs.flatMap((l) => l.geometry) as Track
    const poiDists = distFromStartAlongTrack(track, r.pois)
    const poiRows = r.pois.map((s, i) => ({
      routeId: route.id,
      kind: 'poi' as const,
      position: null,
      lat: s.lat,
      lng: s.lng,
      name: s.name,
      description: s.description || null,
      roles: s.roles,
      durationMin: null,
      distFromStartM: poiDists[i],
    }))

    const allPoints = [...stopRows, ...poiRows]
    if (allPoints.length > 0) await tx.insert(pointsTable).values(allPoints)
    if (r.legs.length > 0) {
      await tx.insert(routeLegs).values(
        r.legs.map((l, i) => ({
          routeId: route.id,
          position: i,
          geometry: l.geometry as Track,
          distanceM: l.distanceM,
          durationS: l.durationS,
          viaPoints: l.viaPoints as Track,
        })),
      )
    }
  }
}

async function parseRideBody(
  c: Context<AuthEnv>,
): Promise<{ data: RidePayload; error?: never } | { data?: never; error: string }> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return { error: 'invalid JSON body' }
  }
  const parsed = ridePayload.safeParse(raw)
  if (!parsed.success) return { error: firstIssue(parsed.error) }
  normalize(parsed.data)
  return { data: parsed.data }
}

// --- API -------------------------------------------------------------------

const jsonLimit = bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: 'payload too large' }, 413) })

rideRoutes.post('/api/rides', requireAuthApi, requireSameOrigin, jsonLimit, async (c) => {
  const user = currentUser(c)

  // Same bot gate as import: enforced once Turnstile keys are set. The token
  // rides in the X-Turnstile-Token header for JSON requests.
  if (turnstileEnabled()) {
    const token = c.req.header('X-Turnstile-Token') ?? ''
    if (!(await verifyTurnstile(token, c.req.header('CF-Connecting-IP')))) {
      return c.json({ error: 'bot check failed — reload and try again' }, 403)
    }
  }

  const body = await parseRideBody(c)
  if (!body.data) return c.json({ error: body.error }, 400)
  const p = body.data

  const created = await db.transaction(async (tx) => {
    const [ride] = await tx
      .insert(rides)
      .values({
        ownerId: user.id,
        slug: generateSlug(),
        title: p.title,
        description: p.description || null,
        visibility: p.visibility,
        source: 'native',
        externalUrl: p.external_url || null,
        ...rideTotals(p),
      })
      .returning()
    await insertRideGraph(tx, ride.id, p)
    return ride
  })
  console.log(`[rides] user ${user.id} created ride ${created.id} (${created.stopCount} stops)`)
  return c.json({ id: created.id, slug: created.slug }, 201)
})

rideRoutes.put('/api/rides/:id', requireAuthApi, requireSameOrigin, jsonLimit, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)
  if (ride.source !== 'native') {
    return c.json({ error: 'imported rides are not editable yet — re-import or plan a new ride' }, 409)
  }

  const body = await parseRideBody(c)
  if (!body.data) return c.json({ error: body.error }, 400)
  const p = body.data

  await db.transaction(async (tx) => {
    await tx
      .update(rides)
      .set({
        title: p.title,
        description: p.description || null,
        visibility: p.visibility,
        externalUrl: p.external_url || null,
        ...rideTotals(p),
        updatedAt: new Date(),
      })
      .where(eq(rides.id, ride.id))
    // Full replace: routes cascade to points and legs.
    await tx.delete(routesTable).where(eq(routesTable.rideId, ride.id))
    await insertRideGraph(tx, ride.id, p)
  })
  return c.json({ id: ride.id, slug: ride.slug })
})

// Owner load for the builder — the same shape PUT accepts, vias included.
rideRoutes.get('/api/rides/:id', requireAuthApi, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)
  return c.json(await loadRidePayload(ride))
})

export async function loadRidePayload(ride: RideRow) {
  const routeRows = await db
    .select()
    .from(routesTable)
    .where(eq(routesTable.rideId, ride.id))
    .orderBy(routesTable.position)
  const out = {
    id: ride.id,
    slug: ride.slug,
    source: ride.source,
    title: ride.title,
    description: ride.description ?? '',
    visibility: ride.visibility,
    external_url: ride.externalUrl ?? '',
    routes: [] as unknown[],
  }
  for (const r of routeRows) {
    const pts = await db.select().from(pointsTable).where(eq(pointsTable.routeId, r.id)).orderBy(pointsTable.position)
    const legs = await db.select().from(routeLegs).where(eq(routeLegs.routeId, r.id)).orderBy(routeLegs.position)
    out.routes.push({
      title: r.title,
      color: r.color,
      startAt: r.startAt?.toISOString() ?? null,
      endAt: r.endAt?.toISOString() ?? null,
      stops: pts
        .filter((p) => p.kind === 'stop')
        .map((p) => ({
          lat: p.lat,
          lng: p.lng,
          name: p.name,
          description: p.description ?? '',
          roles: p.roles,
          durationMin: p.durationMin,
        })),
      pois: pts
        .filter((p) => p.kind === 'poi')
        .map((p) => ({ lat: p.lat, lng: p.lng, name: p.name, description: p.description ?? '', roles: p.roles })),
      legs: legs.map((l) => ({
        geometry: l.geometry,
        distanceM: l.distanceM,
        durationS: l.durationS,
        viaPoints: l.viaPoints,
      })),
    })
  }
  return out
}

// --- Builder pages ---------------------------------------------------------

rideRoutes.get('/builder', requireAuth, (c) => c.html(builderHtml(null)))

rideRoutes.get('/builder/:id', requireAuth, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.text('Not found', 404)
  if (ride.source !== 'native') return c.text('Imported rides are not editable yet', 409)
  return c.html(builderHtml(ride.id))
})

function builderHtml(rideId: number | null): string {
  return `<!doctype html>
<html lang="en-US">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${rideId ? 'Edit ride' : 'Plan a ride'} — tankbag</title>
  <link href="https://fonts.googleapis.com/css?family=Lato:300,400,700,900" rel="stylesheet">
  <link href="https://api.mapbox.com/mapbox-gl-js/v3.10.0/mapbox-gl.css" rel="stylesheet">
  <link rel="stylesheet" href="/style/main.min.css">
</head>
<body class="builder-page">
  <div id="map"></div>

  <div id="info-panel" class="floating-panel builder-panel">
    <button class="collapse-toggle" aria-label="Collapse panel">
      <img src="/img/icons/icon-collapse.svg" alt="Collapse" class="collapse-icon">
    </button>

    <h1 class="panel-title">${rideId ? 'Edit ride' : 'Plan a ride'}</h1>

    <div class="panel-contents-wrapper">
      <div class="panel-content">
        <div class="ride-meta">
          <input id="ride-title" type="text" maxlength="150" placeholder="Ride title" autocomplete="off">
          <textarea id="ride-description" maxlength="2000" placeholder="Description (optional)" rows="2"></textarea>
          <div class="meta-row">
            <input id="route-color" type="color" value="#0066cc" title="Route color">
            <select id="ride-visibility" title="Visibility">
              <option value="private" selected>Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>
            <div class="add-mode" role="radiogroup" title="What a map click adds">
              <button type="button" class="mode-btn active" data-mode="stop">+ Stop</button>
              <button type="button" class="mode-btn" data-mode="poi">+ POI</button>
            </div>
          </div>
        </div>

        <div class="search-wrap">
          <input id="search" type="text" placeholder="Search for a place…" autocomplete="off">
          <ul id="search-results" hidden></ul>
        </div>

        <div class="totals" id="totals"></div>
        <ol class="point-list" id="stop-list"></ol>
        <div class="poi-head" id="poi-head" hidden>Points of interest</div>
        <ul class="point-list" id="poi-list"></ul>

        <div class="builder-actions">
          <button id="save" class="btn" type="button">Save ride</button>
          <span id="save-status" class="save-status"></span>
        </div>
      </div>
    </div>
  </div>

  <noscript><p style="padding:1em">JavaScript is required to plan a ride.</p></noscript>

  <script>window.TB = ${JSON.stringify({ token: MAPBOX_TOKEN, roles: ROLE_META, rideId })};</script>
  <script src="https://api.mapbox.com/mapbox-gl-js/v3.10.0/mapbox-gl.js"></script>
  <script src="/js/map-common.js" defer></script>
  <script src="/js/builder.js" defer></script>
</body>
</html>`
}
