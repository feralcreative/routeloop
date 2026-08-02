// The ride builder's API and page shells. A ride payload is the full graph —
// ride meta + routes + stops/POIs + routed legs — saved whole (PUT is a
// full-replace inside one transaction). The builder MVP sends exactly one
// route; the API accepts many from day one (multi-day rides are the trip
// phase, the schema and this surface are already shaped for them).
import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index'
import {
  rides,
  routes as routesTable,
  points as pointsTable,
  routeLegs,
  userProfiles,
  type RideRow,
  type UserRow,
} from '../db/schema'
import { currentUser, requireActive, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import {
  METERS_PER_MILE,
  distFromStartAlongTrack,
  sanitizeText,
  trackMeters,
  type Track,
} from '../maps/kml'
import { MAX_ROLES_PER_POINT, ROLES, ROLE_META } from '../maps/roles'
import { twistiness } from '../maps/twist'
import { faqLink, googleMapsLoader, page, panelShell } from '../views/layout'
import { asset } from '../views/assets'
import { GMAPS_KEY, GMAPS_MAP_ID } from '../config'
import { generateSlug } from '../maps/slug'
import { turnstileEnabled, verifyTurnstile } from '../maps/turnstile'
import { canEditRide, fields, firstIssue, ownRide } from './maps'

export const rideRoutes = new Hono<AuthEnv>()


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
    // The same concatenation the POI projection below uses, hoisted so the
    // track is walked once for both.
    const track = r.legs.flatMap((l) => l.geometry) as Track
    const twist = twistiness(track)
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
        // null rather than 0 for a day with nothing to measure — see schema.ts.
        twistinessDpm: twist?.dpm ?? null,
        twistinessBestDpm: twist?.bestDpm ?? null,
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

    // POIs: projected onto the route's concatenated track (built above).
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

rideRoutes.post('/api/rides', requireActiveApi, requireSameOrigin, jsonLimit, async (c) => {
  const user = currentUser(c)

  // Same bot gate as import: enforced once Turnstile keys are set. The token
  // rides in the X-Turnstile-Token header for JSON requests.
  if (turnstileEnabled()) {
    const token = c.req.header('X-Turnstile-Token') ?? ''
    if (!(await verifyTurnstile(token, c.req.header('CF-Connecting-IP')))) {
      return c.json({ error: 'bot check failed—reload and try again' }, 403)
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

// Clone a public ride into the caller's account as a private draft.
//
// Reads the stored graph and rebuilds it through the same insertRideGraph the
// builder's save uses, so a clone is a first-class native ride rather than a
// second representation that drifts.
//
// Deliberately dropped:
//   - descriptions, on the ride and on every stop. Those are the author's
//     writing, and stop notes are where "gate code 4417, park behind the barn"
//     lives. Copying them hands one rider's private notes to a stranger.
//   - visibility. A clone lands private no matter what the original was; making
//     it public is a decision the new owner takes deliberately.
//   - via points, which are shaping for a route the cloner will now edit.
rideRoutes.post('/api/rides/:id/clone', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not found' }, 404)

  const [src] = await db.select().from(rides).where(eq(rides.id, id)).limit(1)
  // Only public rides are clonable, and only native ones can be rebuilt: an
  // imported ride's graph exists, but the builder cannot open the result.
  if (!src || src.visibility !== 'public' || src.source !== 'native') {
    return c.json({ error: 'not found' }, 404)
  }

  const srcRoutes = await db
    .select()
    .from(routesTable)
    .where(eq(routesTable.rideId, src.id))
    .orderBy(routesTable.position)

  const payloadRoutes = []
  for (const r of srcRoutes) {
    const pts = await db
      .select()
      .from(pointsTable)
      .where(eq(pointsTable.routeId, r.id))
      .orderBy(pointsTable.position)
    const legs = await db
      .select()
      .from(routeLegs)
      .where(eq(routeLegs.routeId, r.id))
      .orderBy(routeLegs.position)

    const point = (p: (typeof pts)[number]) => ({
      lat: p.lat,
      lng: p.lng,
      name: p.name,
      description: '',
      roles: p.roles,
    })

    payloadRoutes.push({
      title: r.title,
      color: r.color,
      // Times belong to the trip the author planned, not to whenever the cloner
      // rides it. The timeline re-derives from legs and stops either way.
      startAt: null,
      endAt: null,
      stops: pts.filter((p) => p.kind === 'stop').map((p) => ({ ...point(p), durationMin: p.durationMin })),
      pois: pts.filter((p) => p.kind === 'poi').map(point),
      legs: legs.map((l) => ({
        geometry: l.geometry,
        distanceM: l.distanceM,
        durationS: l.durationS,
        viaPoints: [],
      })),
    })
  }

  const p: RidePayload = {
    title: src.title,
    description: '',
    visibility: 'private',
    external_url: '',
    routes: payloadRoutes,
  }

  const created = await db.transaction(async (tx) => {
    const [ride] = await tx
      .insert(rides)
      .values({
        ownerId: user.id,
        slug: generateSlug(),
        title: p.title,
        description: null,
        visibility: 'private',
        source: 'native',
        externalUrl: null,
        ...rideTotals(p),
      })
      .returning()
    await insertRideGraph(tx, ride.id, p)
    return ride
  })

  console.log(`[rides] user ${user.id} cloned ride ${src.id} -> ${created.id}`)
  return c.json({ id: created.id, slug: created.slug }, 201)
})

rideRoutes.put('/api/rides/:id', requireActiveApi, requireSameOrigin, jsonLimit, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)
  if (ride.source !== 'native') {
    return c.json({ error: 'imported rides are not editable yet—re-import or plan a new ride' }, 409)
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
rideRoutes.get('/api/rides/:id', requireActiveApi, async (c) => {
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

// The rider's saved home, but only if they asked for it and it geocoded. Gating
// on the server rather than in builder.js is deliberate: the edit route below
// never loads this, so an existing ride cannot grow a home stop on every save
// even if the client logic were wrong.
async function homeSeed(userId: number): Promise<{ lat: number; lng: number } | null> {
  const [p] = await db
    .select({ lat: userProfiles.homeLat, lng: userProfiles.homeLng })
    .from(userProfiles)
    .where(and(eq(userProfiles.userId, userId), eq(userProfiles.addHomeToRides, true)))
    .limit(1)
  return p?.lat != null && p?.lng != null ? { lat: p.lat, lng: p.lng } : null
}

// The public starting point, sent to every builder page rather than only the
// new-ride one: an existing ride can be made public at any time, and that is
// exactly when the swap is offered.
//
// Unlike homeSeed this is not gated on a preference — it is not seeding
// anything, only standing by in case a home-started ride is about to be shared.
type PublicStart = { lat: number; lng: number; label: string }

async function publicStart(userId: number): Promise<PublicStart | null> {
  const [p] = await db
    .select({ lat: userProfiles.startLat, lng: userProfiles.startLng, label: userProfiles.startLabel })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
  if (p?.lat == null || p?.lng == null) return null
  return { lat: p.lat, lng: p.lng, label: p.label?.trim() || 'Meeting point' }
}

rideRoutes.get('/builder', requireActive, async (c) => {
  const user = currentUser(c)
  const [home, start] = await Promise.all([homeSeed(user.id), publicStart(user.id)])
  return c.html(builderHtml(null, user, home, start))
})

rideRoutes.get('/builder/:id', requireActive, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.text('Not found', 404)
  // Same predicate the viewer's edit button reads, so the button and this gate
  // cannot drift into offering an action that is then refused.
  if (!canEditRide(ride, user)) return c.text('Imported rides are not editable yet', 409)
  return c.html(builderHtml(ride.id, user, null, await publicStart(user.id)))
})

function builderHtml(
  rideId: number | null,
  user: UserRow,
  home: { lat: number; lng: number } | null,
  publicStart: PublicStart | null,
): string {
  // The day slider is a focus control, not a navigation one: every day stays
  // drawn on the map at all times and the slider only changes which one is
  // emphasised. Seeing the whole trip on one map is the product.
  const contents = `        <div class="ride-meta">
          <input id="ride-title" name="title" type="text" maxlength="150" placeholder="Plan a ride" autocomplete="off">
          <textarea id="ride-description" name="description" maxlength="2000" placeholder="Description (optional)" rows="2"></textarea>
          <div class="meta-row">
            <select id="ride-visibility" name="visibility" title="Visibility">
              <option value="private" selected>Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>${faqLink('visibility', 'private, unlisted and public')}
            <div class="add-mode" role="radiogroup" title="What a map click adds">
              <button type="button" class="mode-btn active" data-mode="stop">+ Stop</button>
              <button type="button" class="mode-btn" data-mode="poi">+ POI</button>
            </div>${faqLink('waypoint-poi-stop', 'the difference between a stop and a POI')}
          </div>
        </div>

        <div class="day-scrub" id="day-scrub">
          <div class="day-scrub-head">
            <span class="day-scrub-label" id="day-label">All days</span>
            <button type="button" class="day-add" id="day-add" title="Add a day">+ Day</button>
          </div>
          <input id="day-slider" class="day-slider" type="range" min="0" max="0" step="1" value="0"
                 aria-label="Focus a day, or all days" title="Drag to focus one day">
          <div class="day-ticks" id="day-ticks" aria-hidden="true"></div>
        </div>

        <div class="day-head" id="day-head" hidden>
          <input id="route-color" name="route-color" type="color" value="#0066cc" title="Day color">
          <input id="route-title" name="route-title" type="text" maxlength="150" placeholder="Day name (optional)" autocomplete="off">
          <span class="day-actions">
            <button type="button" id="day-rev" title="Reverse this day—re-routes every leg">⇄</button>
            <button type="button" id="day-up" title="Move day earlier">↑</button>
            <button type="button" id="day-down" title="Move day later">↓</button>
            <button type="button" id="day-del" title="Delete this day">✕</button>
          </span>
        </div>

        <div class="day-times" id="day-times">
          <label class="day-time">
            <span>Starts</span>
            <input id="route-start" name="route-start" type="datetime-local">
          </label>
          <label class="day-time">
            <span>Ends</span>
            <input id="route-end" name="route-end" type="datetime-local"
                   title="Worked out from the start time and the day's riding and stops. Type your own to override, or clear it to go back to automatic.">
          </label>
          <span class="day-times-note" id="day-times-note"></span>
        </div>

        <div class="trip-timeline" id="trip-timeline">
          <input id="time-slider" class="time-slider" type="range" min="0" max="0" step="60" value="0"
                 aria-label="Move through the trip in time" title="Drag to move through the trip">
          <div class="time-readout" id="time-readout"></div>
        </div>

        <div class="search-wrap">
          <input id="search" name="search" type="text" placeholder="Search for a place…" autocomplete="off">
          <ul id="search-results" hidden></ul>
        </div>

        <div class="totals" id="totals"></div>
        <ol class="point-list" id="stop-list"></ol>
        <div class="poi-head" id="poi-head" hidden>Points of interest</div>
        <ul class="point-list" id="poi-list"></ul>

        <div class="builder-actions">
          <button id="save" class="btn" type="button">Save ride</button>
          <button id="discard" class="btn-quiet" type="button" disabled>Discard changes</button>
          <span id="save-status" class="save-status"></span>
        </div>`

  return page({
    title: rideId ? 'Edit ride' : 'Plan a ride',
    user,
    variant: 'map',
    bodyClass: 'builder-page',
    navKey: 'builder',
    noscript: 'JavaScript is required to plan a ride.',
    body: `  <div id="map"></div>\n\n  ${panelShell({
      title: rideId ? 'Edit ride' : undefined,
      extraClass: 'builder-panel',
      contents,
    })}`,
    tb: { gmapsKey: GMAPS_KEY, mapId: GMAPS_MAP_ID, roles: ROLE_META, rideId, home, publicStart },
    scripts: `${googleMapsLoader(GMAPS_KEY)}
  <script src="${asset('/js/map-common.js')}" defer></script>
  <script src="${asset('/js/ride-time.js')}" defer></script>
  <script src="${asset('/js/twist.js')}" defer></script>
  <script src="${asset('/js/builder.js')}" defer></script>`,
  })
}
