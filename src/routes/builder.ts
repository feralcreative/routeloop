// The ride builder's API and page shells. A ride payload is the full graph —
// ride meta + days + stops/POIs + routed legs — saved whole (PUT is a
// full-replace inside one transaction). The builder MVP sent exactly one day;
// the API accepted many from day one, and the builder caught up on 2026-07-30.
import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index'
import {
  rides,
  days as daysTable,
  points as pointsTable,
  routeLegs,
  userProfiles,
  type RideRow,
  type UserRow,
} from '../db/schema'
import { currentUser, requireActive, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { METERS_PER_MILE, distFromStartAlongTrack, sanitizeText, trackMeters, type Track } from '../maps/kml'
import { DAY_COLORS } from '../maps/palette'
import { MAX_ROLES_PER_POINT, ROLES, ROLE_META } from '../maps/roles'
import { twistiness } from '../maps/twist'
import { faqLink, googleMapsLoader, page, panelShell } from '../views/layout'
import { asset } from '../views/assets'
import { GMAPS_KEY, GMAPS_MAP_ID } from '../config'
import { generateSlug } from '../maps/slug'
import { turnstileEnabled, verifyTurnstile } from '../maps/turnstile'
import { canEditRide, ownRide } from './maps'
import { fields, firstIssue } from '../maps/fields'
import {
  MAX_POIS,
  MAX_DAYS,
  MAX_STOPS,
  insertRideGraph,
  normalize,
  ridePayload,
  rideTotals,
  type RidePayload,
} from '../maps/ride-graph'

export const builderRoutes = new Hono<AuthEnv>()

// A native ride is DB rows, not files — caps bound the rows since byte quota
// does not apply. 8 MB JSON backstop over the structural caps.
const BODY_LIMIT = 8 * 1024 * 1024
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

builderRoutes.post('/api/rides', requireActiveApi, requireSameOrigin, jsonLimit, async (c) => {
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
builderRoutes.post('/api/rides/:id/clone', requireActiveApi, requireSameOrigin, async (c) => {
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
    .from(daysTable)
    .where(eq(daysTable.rideId, src.id))
    .orderBy(daysTable.position)

  const payloadDays = []
  for (const r of srcRoutes) {
    const pts = await db
      .select()
      .from(pointsTable)
      .where(eq(pointsTable.dayId, r.id))
      .orderBy(pointsTable.position)
    const legs = await db
      .select()
      .from(routeLegs)
      .where(eq(routeLegs.dayId, r.id))
      .orderBy(routeLegs.position)

    const point = (p: (typeof pts)[number]) => ({
      lat: p.lat,
      lng: p.lng,
      name: p.name,
      description: '',
      roles: p.roles,
    })

    payloadDays.push({
      title: r.title,
      color: r.color,
      // Times belong to the ride the author planned, not to whenever the cloner
      // rides it. The timeline re-derives from legs and stops either way.
      startAt: null,
      endAt: null,
      // Both kinds carry a duration, so a clone keeps the POI dwell too —
      // dropping it would quietly shorten every cloned day.
      stops: pts.filter((p) => p.kind === 'stop').map((p) => ({ ...point(p), durationMin: p.durationMin })),
      pois: pts.filter((p) => p.kind === 'poi').map((p) => ({ ...point(p), durationMin: p.durationMin })),
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
    days: payloadDays,
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

// THIS CHURNS EVERY POINT AND DAY ID, ON PURPOSE, AND THE BUILDER NOW CALLS IT
// CONSTANTLY. Decided 2026-08-15 while planning autosave (#89): the full replace
// below deletes the ride's days — cascading to points and legs — and re-inserts
// them, so `points.id` and `days.id` are different rows after every save. The
// builder used to save when a rider pressed a button, perhaps a dozen times in a
// session; it now flushes on idle, which is two orders of magnitude more often.
//
// That is still safe TODAY for exactly one reason: nothing anywhere references a
// point across a save. The client payload carries no ids, the exports rebuild
// from the graph, and the roadbook reads it whole.
//
// It stops being safe the moment anything does — rich stop details (#15), a
// comment on a stop, a photo attached to one. **Any feature that needs a point
// to keep its identity has to fix this first**, and the fix is not small: send
// ids in the payload, diff here, and update in place, which rewrites
// insertRideGraph, ridePayload and loadRidePayload — the path the native JSON
// import shares. Do not add the reference and hope; the failure is silent and
// looks like data that wandered off.
builderRoutes.put('/api/rides/:id', requireActiveApi, requireSameOrigin, jsonLimit, async (c) => {
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
    await tx.delete(daysTable).where(eq(daysTable.rideId, ride.id))
    await insertRideGraph(tx, ride.id, p)
  })
  return c.json({ id: ride.id, slug: ride.slug })
})

// Owner load for the builder — the same shape PUT accepts, vias included.
builderRoutes.get('/api/rides/:id', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)
  return c.json(await loadRidePayload(ride))
})

export async function loadRidePayload(ride: RideRow) {
  const dayRows = await db
    .select()
    .from(daysTable)
    .where(eq(daysTable.rideId, ride.id))
    .orderBy(daysTable.position)
  const out = {
    id: ride.id,
    slug: ride.slug,
    source: ride.source,
    title: ride.title,
    description: ride.description ?? '',
    visibility: ride.visibility,
    external_url: ride.externalUrl ?? '',
    days: [] as unknown[],
  }
  for (const r of dayRows) {
    const pts = await db.select().from(pointsTable).where(eq(pointsTable.dayId, r.id)).orderBy(pointsTable.position)
    const legs = await db.select().from(routeLegs).where(eq(routeLegs.dayId, r.id)).orderBy(routeLegs.position)
    out.days.push({
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
        .map((p) => ({
          lat: p.lat,
          lng: p.lng,
          name: p.name,
          description: p.description ?? '',
          roles: p.roles,
          // Same shape as a stop now. Omitting this is how a saved POI dwell
          // silently disappears on the next load.
          durationMin: p.durationMin,
        })),
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

builderRoutes.get('/builder', requireActive, async (c) => {
  const user = currentUser(c)
  const [home, start] = await Promise.all([homeSeed(user.id), publicStart(user.id)])
  return c.html(builderHtml(null, user, home, start))
})

builderRoutes.get('/builder/:id', requireActive, async (c) => {
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
  // emphasised. Seeing the whole ride on one map is the product.
  // Three bands, each naming the scope of what it holds: the ride, the day
  // across all its days, and the one day being edited. Before this the panel was
  // a flat run of divs and nothing said whether a given control changed one day
  // or the whole ride — the day scrubber sat next to the day's own colour
  // picker, and the ride timeline sat between two day-level blocks.
  //
  // The order changed with the grouping: the timeline and the totals moved up
  // into the ride band, which is where they always belonged.
  //
  // THERE IS NO SAVE BUTTON, and no Discard either. The builder autosaves on
  // idle — see the autosave block in public/js/builder.js for the timing and for
  // the two conditions that hold a flush. What is left in .builder-actions is
  // undo, redo, a status readout and the link to the public page.
  //
  // Two details in that row are load-bearing rather than cosmetic, both serving
  // the rule that nothing in the panel changes size as its value changes:
  //
  //   #save-status is aria-hidden and #save-announce below it is the live
  //   region. A polite region on the readout itself would say "Unsaved changes,
  //   Saving, Saved" aloud on every edit burst — three announcements a minute
  //   for something a sighted rider takes in peripherally. The live region
  //   speaks only for an error or a blocked save, which are the states that
  //   need acting on. Its width is fixed in _builder.scss for the same reason.
  //
  //   #view-link ships from first paint and is revealed by the first successful
  //   save, using visibility rather than the hidden attribute. An element that
  //   appeared would shove the status beside it, which is the exact jump this
  //   whole epic is about.
  const contents = `        <div class="panel-band panel-band--ride">
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

        <div class="panel-band panel-band--ride">
          <div class="day-scrub" id="day-scrub">
            <div class="day-scrub-head">
              <span class="day-scrub-label" id="day-label">All days</span>
              <button type="button" class="day-add" id="day-add" title="Add a day">+ Day</button>
            </div>
            <input id="day-slider" class="day-slider" type="range" min="0" max="0" step="1" value="0"
                   aria-label="Focus a day, or all days" title="Drag to focus one day">
            <div class="day-ticks" id="day-ticks" aria-hidden="true"></div>
          </div>

          <div class="ride-timeline" id="ride-timeline">
            <input id="time-slider" class="time-slider" type="range" min="0" max="0" step="60" value="0"
                   aria-label="Move through the ride in time" title="Drag to move through the ride">
            <div class="time-readout" id="time-readout"></div>
          </div>

          <div class="totals" id="totals"></div>
        </div>

        <p class="day-pick-hint" id="day-pick-hint" hidden>Pick a day on the slider to edit it.</p>

        <div class="panel-band panel-band--day" id="day-band">
          <div class="day-head" id="day-head" hidden>
            <input id="day-color" name="day-color" type="color" value="#0066cc" title="Day color">
            <input id="day-title" name="day-title" type="text" maxlength="150" placeholder="Day name (optional)" autocomplete="off">
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
              <input id="day-start" name="day-start" type="datetime-local">
            </label>
            <label class="day-time">
              <span>Ends</span>
              <input id="day-end" name="day-end" type="datetime-local"
                     title="Worked out from the start time and the day's riding and stops. Type your own to override, or clear it to go back to automatic.">
            </label>
            <span class="day-times-note" id="day-times-note"></span>
          </div>

          <div class="search-wrap">
            <input id="search" name="search" type="text" placeholder="Search for a place…" autocomplete="off">
            <ul id="search-results" hidden></ul>
          </div>

          <ol class="point-list" id="stop-list"></ol>
        </div>

        <div class="builder-actions">
          <button id="undo" class="btn-quiet" type="button" disabled title="Nothing to undo">Undo</button>
          <button id="redo" class="btn-quiet" type="button" disabled title="Nothing to redo">Redo</button>
          <span id="save-status" class="save-status" data-state="new" aria-hidden="true">
            <span class="save-dot"></span>
            <span class="save-text">Not saved yet</span>
          </span>
          <a id="view-link" class="view-link is-empty" href="#" target="_blank" rel="noopener">View</a>
        </div>
        <span id="save-announce" class="visually-hidden" role="status" aria-live="polite"></span>
        <div id="recover-bar" class="tb-banner is-recover" hidden>
          <span id="recover-text"></span>
          <button id="recover-yes" class="linkbtn" type="button">Restore</button>
          <button id="recover-no" class="linkbtn" type="button">Discard</button>
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
    tb: {
      gmapsKey: GMAPS_KEY,
      mapId: GMAPS_MAP_ID,
      roles: ROLE_META,
      dayColors: DAY_COLORS,
      rideId,
      home,
      publicStart,
    },
    scripts: `${googleMapsLoader(GMAPS_KEY)}
  <script src="${asset('/js/map-common.js')}" defer></script>
  <script src="${asset('/js/ride-time.js')}" defer></script>
  <script src="${asset('/js/twist.js')}" defer></script>
  <script src="${asset('/js/builder-history.js')}" defer></script>
  <script src="${asset('/js/route-shape.js')}" defer></script>
  <script src="${asset('/js/builder.js')}" defer></script>`,
  })
}
