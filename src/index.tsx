import 'dotenv/config'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFile } from 'node:fs/promises'
import { eq, sql } from 'drizzle-orm'
import { db } from './db/index'
import {
  rides,
  days as daysTable,
  points as pointsTable,
  routeLegs,
  users,
  type RideRow,
  type UserRow,
} from './db/schema'
import { withSession, type AuthEnv } from './auth/middleware'
import { METERS_PER_MILE, type Track } from './maps/kml'
import { DAY_COLORS } from './maps/palette'
import { ROLE_META } from './maps/roles'
import { buildNativeJson, loadNativeRide, loadRideForExport, rideStartDate } from './maps/export'
import { DOWNLOADS, storedExtFor } from './maps/downloads'
import { buildExportName, NATIVE_EXT } from './maps/filename'
import { buildZip } from './maps/zip'
import { mapFilePath, thumbFilePath } from './maps/storage'
import { detailsForViewer, type PointDetailsOut } from './maps/point-details'
import { placesRoutes } from './routes/places'
import { startThumbnailSweep } from './maps/thumbnail-sweep'
import { adminRoutes } from './routes/admin'
import { authRoutes } from './routes/auth'
import { homeRoutes } from './routes/home'
import { inviteRoutes } from './routes/invites'
import { surveyRoutes } from './routes/survey'
import { feedbackRoutes } from './routes/feedback'
import { ridesRoutes } from './routes/rides'
import { mapsRoutes } from './routes/maps'
import { pageRoutes } from './routes/pages'
import { profileRoutes } from './routes/profile'
import { builderRoutes } from './routes/builder'
import { importRoutes } from './routes/import'
import { handoffRoutes } from './routes/handoff'
import { roadbookRoutes } from './routes/roadbook'
import { brandRoutes } from './routes/brand'
import { settingsRoutes } from './routes/settings'
import { accountRoutes } from './routes/account'
import { canEditRide } from './routes/maps'
import { routingRoutes } from './routes/routing'
import { googleMapsLoader, page, panelShell, rideTimeline } from './views/layout'
import { asset } from './views/assets'
import { devReloadRoutes, startLiveReload } from './dev/livereload'
import { GMAPS_KEY, GMAPS_MAP_ID, IS_DEV, PORT } from './config'

// Visibility gate: public/unlisted are viewable by anyone with the link;
// private only by its owner. Anything else (private to a non-owner, unknown
// slug) is treated as not-found so we never confirm it exists.
//
// The owner join is what makes "Delete Me" darken a rider's links immediately.
// It has to be asked here rather than inferred from anything on the ride: this
// function reads only the rides row, so no owner state has ever reached it, and
// a blocked owner's public rides are still served today for exactly that reason.
//
// Answering not-found rather than gone, deliberately — the same answer an
// unknown slug gets, so a link cannot be used to learn that an account existed
// and is on its way out. Nothing about the ride changes, which is what makes
// Save Me free: clearing the flag brings every link back.
async function getViewable(slug: string, viewer: UserRow | null): Promise<RideRow | undefined> {
  if (!slug) return undefined
  const [row] = await db
    .select({ ride: rides, ownerLeavingAt: users.deletionRequestedAt })
    .from(rides)
    .innerJoin(users, eq(users.id, rides.ownerId))
    .where(eq(rides.slug, slug))
    .limit(1)
  if (!row) return undefined
  if (row.ownerLeavingAt) return undefined

  const r = row.ride
  if (r.visibility === 'public' || r.visibility === 'unlisted') return r
  if (viewer && viewer.id === r.ownerId) return r
  return undefined
}

const app = new Hono<AuthEnv>()

// Keep the former domains alive during the one-year transition, but make the
// canonical host unambiguous for cookies, sharing, and search engines. Each
// legacy host maps to its own environment so staging never lands on prod. It
// runs ahead of every route, so a request arriving on a legacy hostname is
// redirected before any auth handler sees it.
//
// The direction has now reversed twice: to routeloop.app, back to tankbag.app on
// 2026-07-29, and back to routeloop.app on 2026-08-11. Both hostnames still
// resolve to the same container over their own tunnel routes, so no tunnel
// change is needed — only which name wins.
//
// This table is inverted on a flip, never find-and-replaced. Replacing the
// strings in place maps a host to itself, and a 301 to itself is an infinite
// redirect loop that takes the whole site down.
//
// rollchart.app is a third name Ziad owns and has never used. Its entries are
// deliberately INERT: nothing routes that hostname to this container, so no
// request can arrive under it and nothing here runs. They exist so that if the
// name is ever pointed at the tunnel, it lands on the canonical host instead of
// serving a second copy of the site with its own session cookies — which is the
// actual failure an unlisted hostname causes, and a quiet one, because the site
// looks fine under the wrong name. No stage entry, because there is no
// stage.rollchart.app and inventing one would be config for a thing that has
// never existed.
const LEGACY_HOSTS: Readonly<Record<string, string>> = {
  'tankbag.app': 'routeloop.app',
  'www.tankbag.app': 'routeloop.app',
  'stage.tankbag.app': 'stage.routeloop.app',
  'rollchart.app': 'routeloop.app',
  'www.rollchart.app': 'routeloop.app',
  'www.routeloop.app': 'routeloop.app',
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

// Static viewer assets (js/css/img/video/font) straight from public/. serveStatic
// honors Range requests, which the splash video needs — without 206 support a
// browser cannot seek and some will refuse to start playback at all.
app.use('/js/*', serveStatic({ root: './public' }))
app.use('/style/*', serveStatic({ root: './public' }))
app.use('/img/*', serveStatic({ root: './public' }))
app.use('/video/*', serveStatic({ root: './public' }))
app.use('/font/*', serveStatic({ root: './public' }))
app.use('/favicon.ico', serveStatic({ path: './public/img/favicon/favicon.ico' }))

// Live reload, development only — see src/dev/livereload.ts. Mounted up here
// with the static assets so a connection that stays open for the whole session
// never holds a session lookup behind it.
if (IS_DEV) {
  app.route('/', devReloadRoutes)
  startLiveReload()
}

// Resolves the session once per request so every template can render the right
// header. Mounted after the static assets so they skip the database entirely.
app.use('*', withSession)

// /dashboard was the rides list until 2026-08-15, when it became /rides — see
// the header of src/routes/rides.tsx for why the old name was wrong, and for
// why /rides then folded into / on 2026-08-24. This keeps a bookmark or a pasted
// link working.
//
// It sits ahead of every route module rather than inside one, next to the
// LEGACY_HOSTS redirect it is the path-level twin of, so there is one place to
// look for "why did this URL move". A 301 rather than a 302: this URL is gone
// for good and a browser caching that is the desired outcome, which is not true
// of the /rides → / hop.
//
// POINTED STRAIGHT AT THE DESTINATION rather than at /rides, which would work
// and would cost every one of these visitors a second round trip. A redirect
// chain is also the shape that quietly becomes a loop the next time one of these
// is edited.
app.get('/dashboard', (c) => c.redirect('/', 301))

app.route('/', authRoutes)
app.route('/', adminRoutes)
app.route('/', homeRoutes)
// Both carry literal paths and mount before pageRoutes, whose /:handle{@…}
// regex param is the greediest thing in the table.
app.route('/', inviteRoutes)
app.route('/', surveyRoutes)
// Ahead of pageRoutes for the same reason as the two above. Its own internal
// ordering matters too — /feedback/mine and /feedback/thanks are registered
// before /feedback/:publicId inside the module, or the parameterized route
// swallows them.
app.route('/', feedbackRoutes)
app.route('/', ridesRoutes)
// All literal `/api/places` and `/api/place-groups` paths, so ordering against
// the parameterized modules does not matter — mounted here to sit with the other
// API modules rather than for any routing reason.
app.route('/', placesRoutes)
app.route('/', mapsRoutes)
app.route('/', builderRoutes)
app.route('/', importRoutes)
app.route('/', roadbookRoutes)
app.route('/', brandRoutes)
app.route('/', settingsRoutes)
app.route('/', accountRoutes)
app.route('/', handoffRoutes)
app.route('/', pageRoutes)
app.route('/', profileRoutes)
app.route('/', routingRoutes)

// Viewer page. Native rides render on the ported engine from structured rows;
// imported rides stay on the legacy main.js shell until Phase 4 unifies them.
app.get('/m/:slug', async (c) => {
  const viewer = c.get('user') ?? null
  const m = await getViewable(c.req.param('slug'), viewer)
  if (!m) return c.text('Not found', 404)
  await db
    .update(rides)
    .set({ viewCount: sql`${rides.viewCount} + 1` })
    .where(eq(rides.id, m.id))
  // One shell for both sources. ride.json has served them identically since the
  // timeline work added per-leg spans — an imported ride is one day with one
  // leg — so the ported engine renders it without special-casing.
  return c.html(viewHtml(m, viewer))
})

// The normalized public contract: everything the viewer needs, for both
// sources, derived from structured rows only. One shape for imported and native
// rides is what let the two shells collapse into one.
// Attaches a stop's private details, and ONLY when the map holds any — which it
// does only for the owner. A non-owner's stop object comes out with no `details`
// key at all rather than `details: null`, so the public shape is exactly what it
// was before this feature and nothing downstream has to learn a new field.
function withDetails<T extends object>(
  out: T,
  p: { uid: string; durationMin: number | null },
  details: Map<string, PointDetailsOut>,
) {
  const d = details.get(p.uid)
  return d ? { ...out, durationMin: p.durationMin, details: d } : { ...out, durationMin: p.durationMin }
}

app.get('/api/public/rides/:slug/ride.json', async (c) => {
  const m = await getViewable(c.req.param('slug'), c.get('user'))
  if (!m) return c.json({ error: 'not found' }, 404)

  // Private stop details, and ONLY for the owner — detailsForViewer returns an
  // empty map for everyone else, so a share-link viewer and a ride with nothing
  // filled in produce byte-identical output. That is the point: whether a stop
  // has a gate code must not itself be observable.
  //
  // Note this is a second query rather than a join. `point_details` is a
  // separate table so that no `select()` over `points` can carry a confirmation
  // number to a public viewer by accident, and joining here would give that back.
  const details = await detailsForViewer(m.id, m.ownerId, c.get('user'))

  const dayRows = await db.select().from(daysTable).where(eq(daysTable.rideId, m.id)).orderBy(daysTable.position)
  if (dayRows.length === 0) return c.json({ error: 'not found' }, 404) // pre-pivot rows: legacy viewer only

  const daysOut = []
  for (const r of dayRows) {
    const pts = await db.select().from(pointsTable).where(eq(pointsTable.dayId, r.id)).orderBy(pointsTable.position)
    const legs = await db
      .select({ geometry: routeLegs.geometry, distanceM: routeLegs.distanceM, durationS: routeLegs.durationS })
      .from(routeLegs)
      .where(eq(routeLegs.dayId, r.id))
      .orderBy(routeLegs.position)

    // Concatenate leg geometries and record where each leg lands in the result.
    // Note this drops *any* consecutive duplicate, not just the shared joints
    // between legs — imported tracks carry repeats mid-leg too, so a leg's span
    // here is usually shorter than its stored geometry. That was harmless when
    // the output was one flat line; it is load-bearing now that indices point
    // into it. `track` stays exactly what it always was —
    // every consumer renders it, and one concat path serving both imported and
    // native rides is deliberate (see the route_legs comment in schema.ts). The
    // index pairs are additive: without them a client receives a single flat
    // line and cannot tell where one leg ends and the next begins, which is
    // precisely what mapping a moment to a leg requires.
    //
    // Consecutive legs share their joint, so leg n+1's startIndex is leg n's
    // endIndex rather than the point after it. That is the same continuity the
    // geometry has: the next leg starts where the previous one ended.
    const track: Track = []
    const legsOut: { distanceM: number; durationS: number; startIndex: number; endIndex: number }[] = []
    for (const leg of legs) {
      // A leg with no geometry has nowhere on the track to point at. It cannot
      // arise from the builder (the payload requires two points per leg) and an
      // imported ride carries its whole track as one leg, so this guards a
      // malformed row rather than a real shape.
      if (leg.geometry.length === 0) continue
      let startIndex = -1
      for (const pt of leg.geometry) {
        const last = track[track.length - 1]
        if (!last || last[0] !== pt[0] || last[1] !== pt[1]) track.push(pt)
        // Whether or not the point was a duplicate, it now sits at the end of
        // the track — so the first point's home is the same index either way.
        if (startIndex < 0) startIndex = track.length - 1
      }
      legsOut.push({
        distanceM: leg.distanceM,
        durationS: leg.durationS,
        startIndex,
        endIndex: track.length - 1,
      })
    }

    const pointOut = (p: (typeof pts)[number]) => ({
      kind: p.kind,
      lat: p.lat,
      lng: p.lng,
      name: p.name,
      description: p.description ?? '',
      roles: p.roles,
      distFromStartMi: p.distFromStartM == null ? null : Math.round((p.distFromStartM / METERS_PER_MILE) * 10) / 10,
    })
    daysOut.push({
      title: r.title,
      color: r.color,
      startAt: r.startAt?.toISOString() ?? null,
      endAt: r.endAt?.toISOString() ?? null,
      distanceMi: Math.round((r.distanceM / METERS_PER_MILE) * 10) / 10,
      // Degrees of heading change per mile, and the same over the twistiest
      // 20-mile stretch. Null on any day stored before the column existed, or
      // one with no geometry at all — a client must not render null as 0.
      twistinessDpm: r.twistinessDpm,
      twistinessBestDpm: r.twistinessBestDpm,
      // ALTERNATES. Every day is sent, losing ones included — ride.json is what
      // the viewer draws from, and it has to draw the alternates in order to
      // ghost them. This is the opposite choice from the lossy exports, which
      // never see a losing alternate at all; the difference is that a viewer can
      // show "this is an option" and a GPX file cannot.
      //
      // altGroup is a within-this-ride partition key and nothing more. A client
      // may compare two days' values and must not store one.
      altGroup: r.altGroup,
      altActive: r.altActive,
      track,
      // Each entry spans [startIndex, endIndex] of `track`. Note durationS is
      // 0 for a leg the router never answered for, the same as it is in the
      // builder — a client wanting a time for one of those estimates it from
      // distanceM rather than treating the day as that much shorter.
      legs: legsOut,
      // ONE ORDERED LIST, both kinds, `kind` on each element — the same shape
      // the builder payload and the native JSON have carried since 2026-08-23.
      //
      // This used to be two arrays, `stops` and `pois`, and the reason was that
      // the viewer draws markers and a timeline and never renders the points as a
      // sequence, so the interleaved order bought it nothing. That reason went
      // away on 2026-08-24, when a POI became part of the route: `legs[i]` joins
      // `points[i]` to `points[i+1]`, so the schedule in ride-time.js walks the
      // points and the legs together and two arrays cannot tell it the order.
      //
      // Both kinds carry durationMin — time spent at a viewpoint is time spent.
      // `details` is absent rather than null for a non-owner, so whether a stop
      // has a gate code is not observable.
      points: pts.map((p) => withDetails(pointOut(p), p, details)),
    })
  }

  // Every format is offered for every ride now. An imported ride streams its
  // stored original where it has one and the rest are generated from the rows,
  // so which formats a ride can be downloaded as no longer depends on which one
  // it arrived in. See the DOWNLOADS table.
  return c.json({
    title: m.title,
    description: m.description ?? '',
    source: m.source,
    totalMiles: Number(m.totalMiles),
    // Only offered when a KML was actually stored. A GPX-only import has none,
    // and advertising the link would give the viewer a download button that
    // 404s.
    kmlUrl: `/api/public/maps/${m.slug}/kml`,
    gpxUrl: `/api/public/maps/${m.slug}/gpx`,
    geojsonUrl: `/api/public/maps/${m.slug}/geojson`,
    csvUrl: `/api/public/maps/${m.slug}/csv`,
    // The only lossless one — days, colors, times and via points survive it.
    nativeUrl: `/api/public/maps/${m.slug}/${NATIVE_EXT}`,
    // One file per day, zipped and named by the convention. Offered only for a
    // multi-day ride: a one-day ride zips to an archive holding the file you
    // could have downloaded directly, which is a worse version of the button
    // sitting next to it.
    dayZipBase: daysOut.length > 1 ? `/api/public/maps/${m.slug}/zip` : null,
    // A page, not a file: the printable stop-by-stop sheet.
    roadbookUrl: `/m/${m.slug}/roadbook`,
    externalUrl: m.externalUrl || null,
    days: daysOut,
  })
})

// Every download names itself by the convention in maps/filename.ts, so a
// folder of them re-imports as the ride it came from rather than as whatever
// order the browser happened to list them in.
//
// A whole-ride download carries the ride's start date and no day field: it is
// all the days, so there is no one day to name. The per-day zip below is what
// gets a date onto each individual day, which for GPX and KML is the only place
// a date can survive at all.
async function attachment(m: RideRow, ext: string): Promise<string> {
  const name = buildExportName({ ride: m.title, date: await rideStartDate(m.id), ext })
  return `attachment; filename="${name}"`
}

// The lossless one, and its own route because it carries ride-level fields the
// others do not and is never streamed from a stored file — a native JSON is
// generated from the rows by definition.
//
// Registered under both names. `tankbag.json` is what this route was called
// until 2026-08-11, and the ride page linked it, so it is in riders' bookmarks
// and in whatever scripts they pointed at it. Both must stay ahead of the
// generic `:format` route below for the same reason the zip route does.
app.on('GET', ['/api/public/maps/:slug/routeloop.json', '/api/public/maps/:slug/tankbag.json'], async (c) => {
  const m = await getViewable(c.req.param('slug'), c.get('user'))
  if (!m) return c.text('Not found', 404)
  const native = await loadNativeRide(
    m.id,
    {
      title: m.title,
      description: m.description,
      visibility: m.visibility,
      externalUrl: m.externalUrl,
    },
    // The owner's own backup carries their reservations; a stranger downloading
    // a PUBLIC ride's native JSON gets the same file without them.
    await detailsForViewer(m.id, m.ownerId, c.get('user')),
  )
  if ((native.ride as { days: unknown[] }).days.length === 0) return c.text('Not found', 404)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  }
  if (c.req.query('dl') !== undefined) {
    headers['Content-Disposition'] = await attachment(m, NATIVE_EXT)
  }
  return new Response(buildNativeJson(native), { headers })
})

// One file per day, zipped, each named by the convention.
//
// This is the download that makes a round trip lossless for the formats that
// are not: a day's date cannot live inside a GPX or a KML, so it lives in the
// filename, and one file per day is what gives every day a filename of its own.
// Drag the archive back into /import and the ride comes back with its days in
// order and dated.
//
// Always generated, never streamed from stored originals. A stored file is one
// file for the whole ride by definition — an imported ride's original has no
// per-day split to hand back — so preferring it here would silently answer a
// different question than the one asked.
//
// Its own path segment rather than a `.zip` suffix on the existing route: a
// suffix would have to be spelled inside the format regex, and a `:format`
// param that sometimes carries an extension is exactly the kind of thing that
// reads fine and matches wrong.
// The ride's generated thumbnail. Registered ahead of the generic `:format`
// route below for the same reason the zip route is — that route is constrained
// to four extensions today, but the convention in this file is that the specific
// path comes first, and the zip route is the standing evidence for why.
//
// Served from here rather than from public/ because the file lives under
// STORAGE_PATH, outside the web root, and because a private ride's picture has
// to pass the same visibility gate the ride does. getViewable is that gate.
app.get('/api/public/maps/:slug/thumb.png', async (c) => {
  const m = await getViewable(c.req.param('slug'), c.get('user'))
  if (!m || !m.thumbHash) return c.text('Not found', 404)

  const path = thumbFilePath(m.ownerId, m.id)
  const buf = path ? await readFile(path).catch(() => null) : null
  // A row that says a thumbnail exists and a filesystem that disagrees is a real
  // state after a restore. 404 rather than falling through to anything: the card
  // already knows how to draw its color swatch instead.
  if (!buf) return c.text('Not found', 404)

  return new Response(buf, {
    headers: {
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
      // The card links to `?v=<thumb_hash>`, so a changed picture is a changed
      // URL and this can be immutable. `private` for anything not public: the
      // slug is unguessable, but an unlisted or private ride's picture has no
      // business in a shared cache at the edge.
      'Cache-Control':
        m.visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, max-age=31536000, immutable',
    },
  })
})

app.get('/api/public/maps/:slug/zip/:format{kml|gpx|geojson|csv}', async (c) => {
  const format = c.req.param('format')
  const spec = DOWNLOADS[format]
  const m = await getViewable(c.req.param('slug'), c.get('user'))
  if (!m || !spec) return c.text('Not found', 404)

  const ride = await loadRideForExport(m.id, { title: m.title, description: m.description })
  if (ride.days.length === 0) return c.text('Not found', 404)

  const files = ride.days.map((day, i) => ({
    name: buildExportName({
      ride: m.title,
      day: i + 1,
      date: day.startAt,
      title: day.title,
      ext: format,
    }),
    // One day, built by the same serializer the whole-ride download uses —
    // there is no second code path for a day, only a ride that happens to have
    // one day in it. firstDay keeps that day calling itself day i+1.
    body: Buffer.from(spec.build({ ...ride, days: [day] }, i + 1), 'utf8'),
  }))

  // The ride's own start date on every entry, so extracting an archive does not
  // stamp a rider's files with today. Falls back to the zip epoch, which is
  // what keeps an undated ride's archive byte-identical between exports.
  const zip = buildZip(files, ride.days[0].startAt ?? undefined)
  const name = buildExportName({ ride: m.title, date: await rideStartDate(m.id), ext: `${format}.zip` })

  return new Response(zip, {
    headers: {
      'Content-Type': 'application/zip',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="${name}"`,
    },
  })
})

app.get('/api/public/maps/:slug/:format{kml|gpx|geojson|csv}', async (c) => {
  const format = c.req.param('format')
  const spec = DOWNLOADS[format]
  const m = await getViewable(c.req.param('slug'), c.get('user'))
  if (!m || !spec) return c.text('Not found', 404)

  const headers: Record<string, string> = {
    'Content-Type': `${spec.type}; charset=utf-8`,
    'X-Content-Type-Options': 'nosniff',
  }
  if (c.req.query('dl') !== undefined) headers['Content-Disposition'] = await attachment(m, format)

  // The stored original wins where there is one. Generating it instead would
  // be lossy for no reason: the file carries styling, folders and per-point
  // detail this app does not model and therefore cannot reproduce.
  if (spec.hasStored(m)) {
    const path = mapFilePath(m.ownerId, m.id, storedExtFor(spec, m))
    if (path) {
      const buf = await readFile(path).catch(() => null)
      if (buf) return new Response(buf, { headers })
    }
    // Falls through to generation rather than 404ing. A row that says the file
    // exists and a filesystem that disagrees is a real failure mode after a
    // restore, and the rows are still enough to build a usable file.
  }

  const ride = await loadRideForExport(m.id, { title: m.title, description: m.description })
  if (ride.days.length === 0) return c.text('Not found', 404) // pre-pivot rows
  return new Response(spec.build(ride), { headers })
})

// --- Templates ------------------------------------------------------------

// Both viewers render the same panel — only the engine below it differs — so the
// markup lives in one place and the two shells just pick their scripts.
// `timeline` is opt-in rather than default because the legacy shell's main.js
// knows nothing about it — rendering the control there would give an imported
// ride a slider that does nothing. It goes away with main.js in Phase 4.
function viewerPanel(m: RideRow, editUrl: string | null = null, clonable = false, signedIn = false): string {
  return panelShell({
    title: m.title,
    contents: (
      <>
        <div class="details">
          {m.description && <p class="description">{m.description}</p>}
          {/*
            Only rendered for a rider who can actually open the builder on this
            ride — see canEditRide. A viewer who cannot edit is shown nothing
            rather than a disabled control, since there is no action to enable.
          */}
          {editUrl && (
            <a class="panel-edit" href={editUrl}>
              Edit this ride
            </a>
          )}
          {/*
            Offered to a signed-in rider who does not own this public ride —
            cloning your own is what the builder is for.
          */}
          {clonable && (
            <button class="panel-clone" type="button" data-clone={m.id}>
              Clone this ride
            </button>
          )}
        </div>
        {/*
          The timeline used to sit here, between the details and the day table.
          It is now a bar across the bottom edge of the map — rideTimeline() in
          src/views/layout.tsx, rendered beside the panel rather than inside it.
          Every ride still gets it, and it still hides itself when a ride carries
          no dates, which is the same answer the opt-in used to give imports.
        */}
        <div class="days">
          <table class="day-table"></table>
          <label class="toggle-checkbox">
            <input type="checkbox" id="toggle-arrows" checked />
            Show Direction of Travel
          </label>
        </div>
      </>
    ).toString(),
  })
}

const VIEWER_NOSCRIPT = 'JavaScript is required to view the map.'

// The viewer shell, for every ride regardless of source.
function viewHtml(m: RideRow, user: UserRow | null): string {
  return page({
    title: m.title,
    user,
    variant: 'map',
    noscript: VIEWER_NOSCRIPT,
    // Matches areaFromPath('/m/:slug') in src/feedback/policy.ts.
    feedbackArea: 'map',
    body: `  <div id="map"></div>\n\n  ${viewerPanel(
      m,
      canEditRide(m, user) ? `/builder/${m.id}` : null,
      Boolean(user && user.status === 'active' && user.id !== m.ownerId && m.visibility === 'public'),
      Boolean(user),
    )}\n\n  ${rideTimeline()}`,
    tb: {
      rideUrl: `/api/public/rides/${m.slug}/ride.json`,
      gmapsKey: GMAPS_KEY,
      mapId: GMAPS_MAP_ID,
      roles: ROLE_META,
      dayColors: DAY_COLORS,
    },
    scripts: `${googleMapsLoader(GMAPS_KEY)}
  <script src="${asset('/js/map-common.js')}" defer></script>
  <script src="${asset('/js/ride-time.js')}" defer></script>
  <script src="${asset('/js/twist.js')}" defer></script>
  <script src="${asset('/js/alts.js')}" defer></script>
  <script src="${asset('/js/viewer.js')}" defer></script>`,
  })
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`routeloop dev → http://127.0.0.1:${info.port}`)
})

// After serve(), so a slow first pass cannot delay the port binding — the
// container's healthcheck is what the deploy waits on. The timer is unref'd, so
// this never holds the process open.
startThumbnailSweep()
