import 'dotenv/config'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFile } from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { eq, sql } from 'drizzle-orm'
import { db } from './db/index'
import { rides, days as daysTable, points as pointsTable, routeLegs, type RideRow, type UserRow } from './db/schema'
import { withSession, type AuthEnv } from './auth/middleware'
import { METERS_PER_MILE, type Track } from './maps/kml'
import { DAY_COLORS } from './maps/palette'
import { ROLE_META } from './maps/roles'
import { buildNativeJson, loadNativeRide, loadRideForExport, rideStartDate } from './maps/export'
import { DOWNLOADS, originalIsCurrent, storedExtFor } from './maps/downloads'
import { buildExportName, NATIVE_EXT } from './maps/filename'
import { buildZip } from './maps/zip'
import { readMapFile, thumbFilePath } from './maps/storage'
import { detailsForViewer, type PointDetailsOut } from './maps/point-details'
import { placesRoutes } from './routes/places'
import { bikesRoutes } from './routes/bikes'
import { startThumbnailSweep } from './maps/thumbnail-sweep'
import { startQuotaSweep } from './account/quota-sweep'
import { startAccountPurge } from './account/purge'
import { startTrashPurge } from './trash/purge'
import { startVoteResolver } from './votes/resolve'
import { adminRoutes } from './routes/admin'
import { authRoutes } from './routes/auth'
import { homeRoutes } from './routes/home'
import { inviteRoutes } from './routes/invites'
import { surveyRoutes } from './routes/survey'
import { feedbackRoutes } from './routes/feedback'
import { ridesRoutes } from './routes/rides'
import { mapsRoutes } from './routes/maps'
import { pageRoutes } from './routes/pages'
import { friendRoutes } from './routes/friends'
import { riderRoutes } from './routes/riders'
import { commentRoutes } from './routes/comments'
import { suggestionRoutes } from './routes/suggestions'
import { rosterRoutes } from './routes/roster'
import { followRoutes } from './routes/follows'
import { rendezvousRoutes } from './routes/rendezvous'
import { profileRoutes } from './routes/profile'
import { builderRoutes } from './routes/builder'
import { importRoutes } from './routes/import'
import { trashRoutes } from './routes/trash'
import { handoffRoutes } from './routes/handoff'
import { roadbookRoutes } from './routes/roadbook'
import { brandRoutes } from './routes/brand'
import { settingsRoutes } from './routes/settings'
import { accountRoutes } from './routes/account'
import { builderLabel } from './members/policy'
import { memberOrOwner } from './members/service'
import { groupRange } from './bikes/group-range'
import { liveRoutes } from './routes/live'
import { routingRoutes } from './routes/routing'
import { googleMapsLoader, page, panelShell, rideTimeline } from './views/layout'
import { asset } from './views/assets'
import { devReloadRoutes, startLiveReload } from './dev/livereload'
import { APP_COLOR, DRAIN_GRACE_MS, GMAPS_KEY, GMAPS_MAP_ID, IS_DEV, PORT } from './config'
import { health } from './health'
import { installShutdown, isDraining } from './shutdown'
import { APP_VERSION, BUILD_SHA } from './version'
import { canClone, isSharedCacheable } from './access/policy'
import { grantsFor, viewableRide } from './access/query'
import { resolveStrand } from './subgroups/service'
import { unitsFor } from './views/prefs'
import type { Units } from './views/units'

// The visibility gate now lives in src/access/query.ts, as viewableRide().
// This is a name kept rather than a function: six call sites below read
// getViewable and it says what it does, but the RULE it applies is in one place
// shared with handoff.tsx and roadbook.tsx, which each carried their own copy
// of it until 2026-08-26.
//
// Everything the old comment here argued for is still true and is now argued
// for in that file: not-found rather than forbidden at every refusal, so a link
// cannot be used to learn that a ride or an account exists; the owner join, so
// Delete Me darkens a rider's links immediately and Save Me brings them back;
// and LIVE_RIDE, so trashing a ride kills its share link on the spot.
const getViewable = (slug: string, viewer: UserRow | null): Promise<RideRow | undefined> => viewableRide(slug, viewer)

const app = new Hono<AuthEnv>()

// THE FIRST ROUTE IN THE FILE, and both of the things it is above are the
// reason it is here rather than anywhere else.
//
// ABOVE THE LEGACY_HOSTS REDIRECT, because the deploy probes with
// `Host: 127.0.0.1` and that table would answer a health check with a 301 the
// moment somebody added a hostname to it. A probe that follows a redirect to
// the canonical name is measuring the tunnel and Cloudflare, not this container.
//
// ABOVE withSession, because a health check that takes a session lookup is
// measuring the wrong thing — and once this is what the deploy gates on, it is
// also a session lookup every thirty seconds forever for no reader.
//
// The DB probe is deliberately `select 1` and not a real query. The question is
// whether the pool can reach Postgres at all; anything richer would start
// reporting the health of whatever table it happened to touch.
app.get('/healthz', async (c) => {
  let dbUp = false
  try {
    await db.execute(sql`select 1`)
    dbUp = true
  } catch {
    // Deliberately swallowed: a health endpoint that 500s tells the deploy far
    // less than one that answers 503 and says which half is broken.
  }
  const { status, body } = health({
    version: APP_VERSION,
    build: BUILD_SHA,
    color: APP_COLOR,
    dbUp,
    draining: isDraining(),
    uptimeSec: process.uptime(),
  })
  // No-store, or the tunnel's cache could hand the deploy gate the PREVIOUS
  // container's answer — which is this project's silent-success failure mode
  // wearing a different hat.
  c.header('Cache-Control', 'no-store')
  return c.json(body, status)
})

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
app.route('/', bikesRoutes)
app.route('/', mapsRoutes)
app.route('/', builderRoutes)
app.route('/', importRoutes)
app.route('/', trashRoutes)
app.route('/', roadbookRoutes)
app.route('/', brandRoutes)
app.route('/', settingsRoutes)
app.route('/', accountRoutes)
app.route('/', handoffRoutes)
app.route('/', rosterRoutes)
app.route('/', commentRoutes)
app.route('/', liveRoutes)
app.route('/', suggestionRoutes)
app.route('/', followRoutes)
app.route('/', rendezvousRoutes)
app.route('/', friendRoutes)
// Literal paths, and ahead of pageRoutes whose /:handle{@…} route would not
// catch them anyway — kept together with the other rider-facing modules.
app.route('/', riderRoutes)
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
  // Whether to offer Clone is asked here rather than inside viewHtml because
  // the answer can need the database — a friends-visible ride is clonable by a
  // friend, and being a friend is a lookup. grantsFor short-circuits to nothing
  // on a public ride, which is every ride this button has ever appeared on, so
  // the common path costs no query.
  const grants = await grantsFor(m, viewer)
  const clonable = canClone(m, viewer, grants)
  // THE ROSTER AND THE BUILDER LINK BOTH COME OFF THIS ROW, AND grantsFor()
  // CANNOT ANSWER EITHER. It short-circuits to `{}` for a public or unlisted
  // ride — correctly, since neither needs a grant to be READ — so `isMember` is
  // undefined for a member of a public ride, and reading it as false was hiding
  // the roster link from exactly those riders. That was the same root cause as
  // the missing builder link (#212), found while fixing it.
  //
  // memberOrOwner() rather than membershipOf(), so this and `/builder/:id`
  // resolve the viewer's standing through one implementation and cannot start
  // disagreeing about who is on the roster.
  const member = await memberOrOwner(m, viewer?.id ?? null)
  const onRoster = member !== null
  const label = builderLabel(member)
  const builderLink = label ? { href: `/builder/${m.id}`, label } : null
  // One shell for both sources. ride.json has served them identically since the
  // timeline work added per-leg spans — an imported ride is one day with one
  // leg — so the ported engine renders it without special-casing.
  // THE RANGE IS FOR MEMBERS ONLY, AND IT IS TRIMMED TO TWO FIELDS.
  //
  // A roster is gated on membership rather than on visibility — who is coming
  // is a fact about people, and a share link is permission to see a route — so
  // GroupRange's `riderName` and `bikeLabel` must not reach a stranger holding
  // a public ride's URL. They are dropped here rather than gated downstream:
  // what the viewer's range circle needs is a number and a fuel type, and the
  // two identifying fields have no use on that surface at all.
  //
  // Null for a non-member means no circle, which is the same answer a member
  // with no bike on file gets. Nothing on the page distinguishes them, so the
  // absence of a circle never reports whether somebody is on the roster.
  const full = onRoster ? await groupRange(m.id) : null
  const range = full ? { miles: full.miles, fuelType: full.fuelType } : null
  return c.html(viewHtml(m, viewer, clonable, onRoster, await unitsFor(c), builderLink, range))
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

  // Subgroups reach the client BY UID, never by id — the same rule the builder
  // payload follows, and the reason is stronger here: this is a public document
  // and a database id in it is a number about the installation rather than
  // about the ride.
  const strand = await resolveStrand(m.id, c.get('user')?.id ?? null, c.req.query('group'))
  const subgroupUidOf = new Map(strand.all.map((g) => [g.id, g.uid]))

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
      // WHOSE DAY THIS IS, by subgroup uid. EVERY day is sent, tagged rather
      // than filtered, for exactly the reason the losing alternates are: the
      // viewer draws the whole converge-and-split shape — feeders converging,
      // the trunk drawn once — and dims the ones this reader is not on. A
      // filtered payload could not draw the shape at all.
      //
      // The lossy exports do the opposite and filter, because a GPX file cannot
      // say "this is somebody else's morning" and a rider handed one would ride
      // it.
      subgroupUid: r.subgroupId ? (subgroupUidOf.get(r.subgroupId) ?? null) : null,
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
    // The converge-and-split shape, for the legend and the focus control. An
    // empty array on every ride that has none, which is nearly all of them, so
    // a client tests one thing rather than three.
    subgroups: strand.all.map((g) => ({ uid: g.uid, name: g.name, color: g.color })),
    // Which one THIS reader is on, derived from their membership — #67's
    // "highlight my path" without asking anybody anything. Null for a planner,
    // for a stranger with the link, and for a rider in no subgroup.
    mySubgroup: strand.group?.uid ?? null,
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
      'Cache-Control': isSharedCacheable(m.visibility)
        ? 'public, max-age=31536000, immutable'
        : 'private, max-age=31536000, immutable',
    },
  })
})

app.get('/api/public/maps/:slug/zip/:format{kml|gpx|geojson|csv}', async (c) => {
  const format = c.req.param('format')
  const spec = DOWNLOADS[format]
  const m = await getViewable(c.req.param('slug'), c.get('user'))
  if (!m || !spec) return c.text('Not found', 404)

  // #67's per-rider export: a member downloads their own approach plus the
  // shared days, not everybody's. Derived from membership, `?group=all` for the
  // whole ride. `?group` is ignored entirely on a ride with no subgroups.
  const strand = await resolveStrand(m.id, c.get('user')?.id ?? null, c.req.query('group'))
  const ride = await loadRideForExport(m.id, { title: m.title, description: m.description }, strand.subgroupId)
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

  const strand = await resolveStrand(m.id, c.get('user')?.id ?? null, c.req.query('group'))

  // The stored original wins where there is one AND IT IS STILL TRUE. Generating
  // it otherwise would be lossy for no reason: the file carries styling, folders
  // and per-point detail this app does not model and therefore cannot reproduce.
  //
  // EXCEPT WHEN THE RIDE HAS BEEN EDITED SINCE — see originalIsCurrent(). A save
  // does not rewrite the file and nothing clears it, so an imported ride that
  // has been re-cut in the builder would otherwise hand back the pre-edit
  // upload, silently. Until #172 that took typing the URL to reach; there is a
  // button on it now.
  //
  // EXCEPT WHEN A STRAND WAS ASKED FOR. A stored original is the whole ride as
  // it was uploaded and knows nothing about subgroups, so handing it to a rider
  // who asked for their own approach would answer a different question than the
  // one they asked — silently, and with more days than they expect. An imported
  // ride has no subgroups in practice, so this branch is nearly always taken.
  if (spec.hasStored(m) && originalIsCurrent(m) && strand.subgroupId === undefined) {
    // readMapFile, not mapFilePath + readFile: the file may be under either
    // spelling and this is the only thing that knows both. Serving the brotli
    // bytes straight through with `Content-Encoding: br` was considered and
    // rejected — it interacts badly with Content-Disposition: attachment, and
    // decompressing costs milliseconds on files this size.
    const buf = await readMapFile(m.ownerId, m.id, storedExtFor(spec, m))
    if (buf) return new Response(buf, { headers })
    // Falls through to generation rather than 404ing. A row that says the file
    // exists and a filesystem that disagrees is a real failure mode after a
    // restore, and the rows are still enough to build a usable file.
  }

  const ride = await loadRideForExport(m.id, { title: m.title, description: m.description }, strand.subgroupId)
  if (ride.days.length === 0) return c.text('Not found', 404) // pre-pivot rows
  return new Response(spec.build(ride), { headers })
})

// --- Templates ------------------------------------------------------------

// Both viewers render the same panel — only the engine below it differs — so the
// markup lives in one place and the two shells just pick their scripts.
// `timeline` is opt-in rather than default because the legacy shell's main.js
// knows nothing about it — rendering the control there would give an imported
// ride a slider that does nothing. It goes away with main.js in Phase 4.
function viewerPanel(
  m: RideRow,
  builderLink: BuilderLink | null = null,
  clonable = false,
  signedIn = false,
  rosterUrl: string | null = null,
): string {
  return panelShell({
    title: m.title,
    contents: (
      <>
        <div class="details">
          {m.description && <p class="description">{m.description}</p>}
          {/*
            Rendered for any MEMBER, not only an owner, and the label is what
            that rider can actually do — see builderLabel in members/policy.ts.
            `/builder/:id` admits everyone from `view` upward and turns its
            writes off below `edit`, because comments and suggestions both hang
            off the row list and the stop details; a below-edit rider genuinely
            belongs there. What must never happen is this link promising an edit
            the page then refuses, which is why the wording comes off the ladder
            rather than being written here.

            A rider who is not on the roster is shown nothing rather than a
            disabled control, since there is no action to enable.
          */}
          {builderLink && (
            <a class="panel-edit" href={builderLink.href}>
              {builderLink.label}
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
          {/*
            Members only, and rendered as nothing for everyone else rather than
            as a disabled control — the same rule the Edit link above follows.
            Who is coming on a ride is a fact about people; a share link is
            permission to see a route, not to see the roster.
          */}
          {rosterUrl && (
            <a class="panel-roster-link" href={rosterUrl}>
              Riders and the vote
            </a>
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
/** Where the panel's builder link points and what it says, or null for a rider
 *  who is not on the roster. Resolved in the route because it needs the
 *  database — see memberOrOwner. */
export type BuilderLink = { href: string; label: string }

/** What the viewer is told about the group's tank: a number and what it drinks,
 *  and deliberately not whose it is. See the call site for why. */
export type ViewerRange = { miles: number | null; fuelType: 'gas' | 'electric' | null } | null

function viewHtml(
  m: RideRow,
  user: UserRow | null,
  clonable: boolean,
  onRoster: boolean,
  units: Units,
  builderLink: BuilderLink | null,
  range: ViewerRange,
): string {
  return page({
    title: m.title,
    user,
    variant: 'map',
    noscript: VIEWER_NOSCRIPT,
    // Matches areaFromPath('/m/:slug') in src/feedback/policy.ts.
    feedbackArea: 'map',
    body: `  <div id="map"></div>\n\n  ${viewerPanel(
      m,
      builderLink,
      clonable,
      Boolean(user),
      onRoster ? `/m/${m.slug}/riders` : null,
    )}\n\n  ${rideTimeline()}`,
    tb: {
      rideUrl: `/api/public/rides/${m.slug}/ride.json`,
      gmapsKey: GMAPS_KEY,
      mapId: GMAPS_MAP_ID,
      roles: ROLE_META,
      dayColors: DAY_COLORS,
      units,
      range,
    },
    scripts: `${googleMapsLoader(GMAPS_KEY)}
  <script src="${asset('/js/map-common.js')}" defer></script>
  <script src="${asset('/js/ride-time.js')}" defer></script>
  <script src="${asset('/js/twist.js')}" defer></script>
  <script src="${asset('/js/alts.js')}" defer></script>
  <script src="${asset('/js/route-shape.js')}" defer></script>
  <script src="${asset('/js/day-distance.js')}" defer></script>
  <script src="${asset('/js/range-circle.js')}" defer></script>
  <script src="${asset('/js/viewer.js')}" defer></script>`,
  })
}

// `serve()` is typed as `Server | Http2Server | Http2SecureServer` because it
// can be handed a createServer. We never do and never enable HTTP/2, so it is
// always the plain HTTP server — which is the only one of the three that has
// closeIdleConnections/closeAllConnections, the two methods the drain needs.
const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  // localhost with the trailing slash so the terminal renders it as one
  // clickable link; 127.0.0.1 is what the container healthcheck probes, not
  // what a person is meant to open.
  console.log(`routeloop dev → http://localhost:${info.port}/`)
}) as HttpServer

// Before the sweeps, so a SIGTERM arriving during startup is still caught.
installShutdown(server, DRAIN_GRACE_MS)

// After serve(), so a slow first pass cannot delay the port binding — the
// container's healthcheck is what the deploy waits on. The timer is unref'd, so
// this never holds the process open.
startThumbnailSweep()
// Repairs users.used_bytes from the authoritative sum, on the same cadence. Not
// part of the sweep above and not gated on a Maps key: it touches no external
// service, and what it protects is a rider's ability to upload at all. See the
// header of src/account/quota-sweep.ts.
startQuotaSweep()
// The bin, hourly rather than every five minutes: this enforces a thirty-day
// deadline, so an hour of slack is invisible. See src/trash/purge.ts.
startTrashPurge()
// Elects each alternate group's leader on rides whose vote has closed. A ride
// with no deadline is never selected, which is every ride until an owner sets
// one — see src/votes/resolve.ts.
startVoteResolver()
// The account purge, which does nothing unless PURGE_ACCOUNTS is set. It is the
// only job here that destroys a person's account, and it had no runner at all
// until now — /account/delete promised a date and nothing kept it.
startAccountPurge()
