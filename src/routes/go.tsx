// The on-the-road page (#69) — `/m/:slug/go`, the surface a rider opens on a
// phone at a fuel stop, in gloves, on one bar. It is the Google Maps hand-off
// (#66) grown into the thing #69 asked for: the leg-loader with progress, the
// ride's files handed to whatever the rider navigates with, the roadbook folded
// in as a list, and a copy the phone keeps for when there is no signal.
//
// It was `/m/:slug/navigate` from 2026-08-03 to 2026-09-14 — the links, the
// density choice and the honest worst-gap line all come from there, and that
// URL 301s here. Its header still holds:
//
// Most riders are on a phone, not a dedicated unit, so this is the hand-off
// that matters most. Google Maps takes nine waypoints per link, which is the
// constraint everything here is shaped by: a route becomes an ordered series of
// links rather than one, and holding the route to the roads it was planned on
// is paid for in links rather than in points per link.
//
// The number this page refuses to hide is the longest unpinned stretch. Between
// two consecutive points Maps routes however it likes, so a route handed over as
// six stops leaves it twenty-odd miles of freedom at the worst point. Saying so
// is the difference between this and every tool that claims a clean hand-off
// and delivers a route that wandered.
//
// THREE THINGS ABOUT HOW IT RENDERS, each of which the offline copy depends on:
//
//   - ALL THREE DENSITIES ARE IN THE PAGE and go.js shows one. A density used to
//     be a `?density=` query, which made three URLs for one page — and a kept
//     copy would have held whichever one the rider happened to be on. One page,
//     switched client-side, is one cache entry. With no script the server marks
//     one block `is-on`, so the page still shows a single list.
//   - EVERY LINK STARTS FROM WHERE THE RIDER IS (`fromCurrentLocation: 'every'`).
//     The old page passed nothing and its copy said Maps would start from you;
//     it did not, and offered Preview instead of Start at every stop. See the
//     option's comment in src/maps/gmaps-links.ts.
//   - THE SPLASH VARIANT, WITH ITS OWN BAR. No site header: at a fuel stop the
//     nav offers nothing, and — the half that matters — a kept copy of this HTML
//     then bakes in no avatar and no unread count. The bar carries the title, the
//     map and the roadbook.
//
// What it must not become: a planning surface. Planning stays a big-screen
// job and this is the digital counterpart to the printed roadbook.
import { Hono } from 'hono'
import type { AuthEnv } from '../auth/middleware'
import { loadRideForExport, rideStartDate } from '../maps/export'
import { linkLabel, routeLinks, type GmapsRouteLinks } from '../maps/gmaps-links'
import { buildExportName, NATIVE_EXT } from '../maps/filename'
import { fmtDuration, routeRows } from '../maps/roadbook-rows'
import { ROLE_META, type Role } from '../maps/roles'
import { fmtClock, fmtDateLong } from '../views/date-format'
import { page, wordsOf } from '../views/layout'
import { clockFor, dateFormatFor, unitsFor } from '../views/prefs'
import { StrandSwitch } from '../views/strand-switch'
import { type Units, distanceFrom, distanceUnit } from '../views/units'
import { Wd, wd, wn } from '../views/vocab'
import { viewableRide } from '../access/query'
import { resolveStrand } from '../subgroups/service'
import { SEP } from '../views/sep'
import { asset } from '../views/assets'

export const goRoutes = new Hono<AuthEnv>()

const fmtDist = (m: number, units: Units) => distanceFrom(m, units).toFixed(1)

const roleTitles = (roles: Role[]) => roles.map((r) => ROLE_META[r]?.title ?? r).join(SEP)

// What the rider is choosing between is not a point count — it is how much room
// the nav app has, against how many times they have to stop and tap. The labels
// say that; the numbers behind them are an implementation detail.
export const DENSITIES = [
  {
    key: 'off',
    label: 'Stops only',
    points: 0,
    note: 'Hands over your stops and lets Maps pick the roads between them',
  },
  { key: 'light', label: 'Light', points: 25, note: 'Holds the shape of the route with a few extra links' },
  { key: 'tight', label: 'Tight', points: 60, note: 'Pins it down closely, at the cost of more links' },
] as const

export type DensityKey = (typeof DENSITIES)[number]['key']

const DEFAULT_DENSITY: DensityKey = 'light'

const densityOf = (raw: string | undefined): DensityKey =>
  DENSITIES.find((d) => d.key === raw)?.key ?? DEFAULT_DENSITY

// The files the page hands over, in the order the buttons appear. GPX first and
// biggest because it is the one every nav app reads; KML for the ones that
// prefer it; the native JSON so a rider can bring the ride back into Routeloop
// from a phone that has nothing else. GeoJSON and CSV are deliberately absent —
// neither is a format any nav app imports, and a button that lands a file
// nowhere is a button the rider taps once.
const FILES = [
  { format: 'gpx', label: 'GPX', ext: 'gpx', mime: 'application/gpx+xml', note: 'Rever, Kurviger, Scenic, Calimoto, OsmAnd, Garmin' },
  { format: 'kml', label: 'KML', ext: 'kml', mime: 'application/vnd.google-earth.kml+xml', note: 'Google Earth and a few others' },
  { format: 'native', label: 'Routeloop file', ext: NATIVE_EXT, mime: 'application/json', note: 'Everything, for bringing the ride back into Routeloop' },
] as const

// THE KEEP MANIFEST: the six fields a kept ride's registry row holds (see
// public/js/keep.js), built once here for the page's `window.TB.go` and for the
// endpoint below, so the two cannot describe different files. The URLs carry
// `?group` forward so a kept copy is whose copy the page is, and `?dl` so the
// server names the files; names come from the same convention the download
// route uses, because the client never parses a Content-Disposition header it
// may not see through a cache.
async function keepManifest(m: { id: number; slug: string; title: string; updatedAt: Date }, groupQ: string | undefined) {
  const group = groupQ ? `&group=${encodeURIComponent(groupQ)}` : ''
  const startDate = await rideStartDate(m.id)
  const files = FILES.map((f) => ({
    format: f.format,
    label: f.label,
    note: f.note,
    mime: f.mime,
    url: `/api/public/maps/${m.slug}/${f.format === 'native' ? NATIVE_EXT : f.format}?dl${group}`,
    name: buildExportName({ ride: m.title, date: startDate, ext: f.ext }),
  }))
  const q = groupQ ? `?group=${encodeURIComponent(groupQ)}` : ''
  return {
    slug: m.slug,
    title: m.title,
    updatedAt: m.updatedAt.toISOString(),
    pageUrl: `/m/${m.slug}/go${q}`,
    roadbookUrl: `/m/${m.slug}/roadbook${q}`,
    files,
  }
}

// The manifest on its own, for a Keep sign pressed somewhere other than the go
// page — the ride list, since 2026-09-17. Same gate as the page: a manifest
// names a ride's files, and it must not be a way to learn a private ride's
// title. `no-store` because a rider keeping a ride wants the ride as it is now,
// and the `updatedAt` in here is what tells a kept copy it has gone stale.
goRoutes.get('/m/:slug/keep.json', async (c) => {
  const user = c.get('user') ?? null
  const m = await viewableRide(c.req.param('slug'), user)
  if (!m) return c.json({ error: 'not found' }, 404)
  c.header('Cache-Control', 'no-store')
  return c.json(await keepManifest(m, c.req.query('group')))
})

goRoutes.get('/m/:slug/go', async (c) => {
  // c.get('user'), not currentUser(): open to anyone with the link, and
  // currentUser() throws outside an auth gate.
  const user = c.get('user') ?? null
  const slug = c.req.param('slug')

  // The same visibility gate the viewer and the roadbook use — literally the
  // same function now. A hand-off page is the ride, rendered differently; it
  // must not be a way around who may see it. It also goes dark for a leaving
  // owner and for a trashed ride.
  const m = await viewableRide(slug, user)
  if (!m) return c.text('Not found', 404)

  // ACTIVE ROUTES ONLY, via loadRideForExport. Nothing below needs to know about
  // alternates as a result: the link count, the worst-gap figure and the
  // per-route headings are all over the ride as it will be ridden. Handing a
  // rider a Google Maps link for a route they chose not to do is the one
  // outcome this page must not produce.
  // WHOSE HAND-OFF. #67's per-rider export: mine starts in Oakland, Dylan's in
  // Sacramento, and neither is handed the other's morning. Derived from
  // membership; `?group=all` is the planner's way back to the whole ride.
  const groupQ = c.req.query('group')
  const strand = await resolveStrand(m.id, user?.id ?? null, groupQ)
  const ride = await loadRideForExport(
    m.id,
    { title: m.title, description: m.description },
    strand.subgroupId,
    strand.routeUids,
  )
  if (ride.routes.length === 0) return c.text('Not found', 404)

  const units = await unitsFor(c)
  const dateFormat = await dateFormatFor(c)
  const clock = await clockFor(c)
  const w = wordsOf({ user, ride: m })

  // `?density=` still works — it is in riders' bookmarks from the old page —
  // and it only decides which block is `is-on` at first paint. go.js reads the
  // same query, then localStorage, and switches from there.
  const density = densityOf(c.req.query('density'))
  const byDensity = DENSITIES.map((d) => ({
    ...d,
    routes: ride.routes.map((r): GmapsRouteLinks => routeLinks(r, { shapingPoints: d.points, fromCurrentLocation: 'every' })),
  })).map((d) => {
    const gaps = d.routes.map((r) => r.longestGapM).filter((g): g is number => g !== null)
    return {
      ...d,
      totalLinks: d.routes.reduce((n, r) => n + r.links.length, 0),
      worstGapM: gaps.length > 0 ? Math.max(...gaps) : null,
    }
  })

  // The same six fields the keep.json endpoint serves; see keepManifest above.
  const { files, pageUrl, roadbookUrl } = await keepManifest(m, groupQ)

  const totalM = ride.routes.reduce((n, r) => n + r.distanceM, 0)
  const anyClock = ride.routes.some((r) => r.startAt)

  return c.html(
    page({
      title: `${m.title} – on the road`,
      user,
      words: w,
      ride: m,
      variant: 'splash',
      splash: false,
      bodyClass: 'go-page',
      feedbackArea: 'sharing',
      tb: {
        go: {
          slug: m.slug,
          title: m.title,
          updatedAt: m.updatedAt.toISOString(),
          pageUrl,
          roadbookUrl,
          density,
          files,
          routes: ride.routes.map((r, i) => ({ uid: r.uid, title: r.title?.trim() || `${Wd(w, 'route')} ${i + 1}` })),
        },
      },
      scripts: `<script src="${asset('/js/go-progress.js')}" defer></script>
<script src="${asset('/js/keep.js')}" defer></script>
<script src="${asset('/js/go.js')}" defer></script>`,
      body: (
        <>
          <header class="go-bar">
            <h1 class="go-title">{m.title}</h1>
            <nav class="go-bar-links" aria-label="This ride">
              <a href={`/m/${m.slug}`}>Map</a>
              <a href={roadbookUrl}>{Wd(w, 'roadbook')}</a>
            </nav>
          </header>

          <p class="go-summary">
            {ride.routes.length} {wn(w, 'route', ride.routes.length)}
            {SEP}
            {fmtDist(totalM, units)} {distanceUnit(units)}
          </p>
          <StrandSwitch strand={strand} base={`/m/${m.slug}/go`} />

          {/* SEND. The buttons are inert until go.js has the files in memory —
              Safari drops the share sheet's permission at the first await, so the
              fetch has to have happened before the tap. With no script they are
              plain download links, which is what every phone did before this
              page existed. */}
          <section class="go-send" id="go-send">
            <h2>Send to your nav app</h2>
            <ul class="go-files">
              {files.map((f) => (
                <li>
                  <a class="btn go-file" href={f.url} download={f.name} data-format={f.format}>
                    {f.label}
                  </a>
                  <span class="go-file-note">{f.note}</span>
                </li>
              ))}
            </ul>
            <p class="go-hint" id="go-send-hint" hidden></p>
          </section>

          {/* KEEP. Hidden until go.js confirms the browser can — a section that
              offers to keep a ride on a phone that cannot is a promise the page
              would break. */}
          <section class="go-keep" id="go-keep" hidden>
            <h2>Keep on this phone</h2>
            <p class="go-keep-why">
              This page, the {wd(w, 'roadbook')} and the files above, ready with no signal. Nothing else on the
              site is kept.
            </p>
            <p class="go-keep-actions">
              <button class="btn" type="button" id="go-keep-btn">
                Keep on this phone
              </button>
              <button class="btn btn-quiet" type="button" id="go-forget-btn" hidden>
                Remove from this phone
              </button>
            </p>
            <p class="go-keep-status" id="go-keep-status" aria-live="polite"></p>
            <p class="go-install" id="go-install" hidden></p>
          </section>

          {/* LEGS. Three blocks, one per density, and one is shown. The pill is
              the Route | Ride construction from the timeline bar. */}
          <section class="go-legs-section">
            <div class="go-legs-head">
              <h2>Google Maps, one leg at a time</h2>
              <div class="go-density-set" role="group" aria-label="How tightly to hold the route">
                {DENSITIES.map((d) => (
                  <button
                    class="go-density-btn"
                    type="button"
                    data-density={d.key}
                    aria-pressed={d.key === density ? 'true' : 'false'}
                    title={d.note}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <p class="go-note">
              Tap a leg and Maps starts from where you are. Ride it, and when you arrive tap the next one. Your place is
              remembered on this phone.
            </p>

            {byDensity.map((d) => (
              <div class={`go-density${d.key === density ? ' is-on' : ''}`} data-density={d.key} hidden={d.key !== density}>
                <p class="go-density-line">
                  <strong>{d.totalLinks}</strong> {d.totalLinks === 1 ? 'leg' : 'legs'}
                  {SEP}
                  {d.note}
                  {d.worstGapM !== null && (
                    <>
                      {' '}
                      Between two points Maps picks its own roads; on the worst stretch that is{' '}
                      <strong>
                        {fmtDist(d.worstGapM, units)} {distanceUnit(units)}
                      </strong>
                      .
                    </>
                  )}
                </p>
                {ride.routes.map((r, routeIndex) => {
                  const route = d.routes[routeIndex]
                  return (
                    <section class="go-route">
                      <h3>
                        <span class="go-route-swatch" style={`background:${r.color}`}></span>
                        {route.title?.trim() || `${Wd(w, 'route')} ${routeIndex + 1}`}
                      </h3>
                      {route.links.length === 0 ? (
                        <p class="go-empty">Nothing to navigate—this {wd(w, 'route')} has no stops yet.</p>
                      ) : (
                        <ol class="go-legs">
                          {route.links.map((link) => (
                            <li>
                              <a
                                class="btn go-leg"
                                href={link.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                data-route={r.uid}
                                data-part={String(link.part)}
                                data-parts={String(link.parts)}
                              >
                                <span class="go-leg-stack">
                                  <span class="go-leg-label">{linkLabel(route, link, routeIndex)}</span>
                                  {/* A leg of nothing but shaping points has no stop to name, and
                                      a blank second line reads as a rendering fault. */}
                                  <span class="go-leg-stops">
                                    {link.points.length > 0
                                      ? link.points.map((p) => p.name || 'Unnamed stop').join(' → ')
                                      : `On the way${SEP}${link.shaping} points holding the road`}
                                  </span>
                                </span>
                              </a>
                            </li>
                          ))}
                        </ol>
                      )}
                    </section>
                  )
                })}
              </div>
            ))}

            <p class="go-next-row">
              <button class="btn go-next" type="button" id="go-next" hidden>
                Next leg
              </button>
              <button class="btn btn-quiet" type="button" id="go-reset" hidden>
                Start over
              </button>
            </p>
          </section>

          {/* THE ROADBOOK, AS A LIST. Same rows as the printed sheet, computed
              by the same function, so the two cannot disagree about a mileage. */}
          <section class="go-roadbook">
            <h2>{Wd(w, 'roadbook')}</h2>
            {anyClock && (
              <p class="go-note">
                Times are estimates: the {wd(w, 'route')}’s {wd(w, 'travel')} time spread evenly over its distance,
                plus the time planned at each&nbsp;stop.
              </p>
            )}
            {ride.routes.map((r, i) => {
              const rows = routeRows(r)
              return (
                <section class="go-route">
                  <h3>
                    <span class="go-route-swatch" style={`background:${r.color}`}></span>
                    {r.title || `${Wd(w, 'route')} ${i + 1}`}
                    <span class="go-route-meta">
                      {r.startAt && (
                        <>
                          {fmtDateLong(r.startAt, dateFormat)}
                          {SEP}
                        </>
                      )}
                      {fmtDist(r.distanceM, units)} {distanceUnit(units)}
                      {r.durationS > 0 && (
                        <>
                          {SEP}
                          {fmtDuration(r.durationS)}
                        </>
                      )}
                    </span>
                  </h3>
                  {rows.length === 0 ? (
                    <p class="go-empty">No stops on this {wd(w, 'route')}.</p>
                  ) : (
                    <ol class="go-stops">
                      {rows.map((row) => (
                        <li class={row.n === null ? 'go-stop go-poi' : 'go-stop'}>
                          <span class="go-stop-n">{row.n ?? '·'}</span>
                          <span class="go-stop-main">
                            <span class="go-stop-name">{row.point.name || 'Unnamed'}</span>
                            {row.point.roles.length > 0 && <span class="go-stop-roles">{roleTitles(row.point.roles)}</span>}
                          </span>
                          <span class="go-stop-nums">
                            {row.fromPrevM != null && <span class="go-num">+{fmtDist(row.fromPrevM, units)}</span>}
                            {row.atM != null && <span class="go-num go-num-total">{fmtDist(row.atM, units)}</span>}
                            {row.sinceFuelM != null && (
                              <span class="go-num go-num-fuel" title="Since the last fuel stop">
                                ⛽ {fmtDist(row.sinceFuelM, units)}
                              </span>
                            )}
                            {r.startAt && row.arrive && (
                              <span class="go-num go-num-at">{fmtClock(row.arrive, dateFormat, clock)}</span>
                            )}
                            {row.point.durationMin ? (
                              <span class="go-num go-num-stay">stay {fmtDuration(row.point.durationMin * 60)}</span>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              )
            })}
          </section>

          <section class="go-caveats">
            <h2>What this does not promise</h2>
            <ul>
              <li>
                Maps carries nine waypoints per link. That is the reason a {wd(w, 'route')} is several legs, and the
                reason the distance above is not&nbsp;zero.
              </li>
              <li>
                Stops arrive as pins rather than names. The coordinates are exact; Google only shows a name for a place
                it&nbsp;recognizes.
              </li>
              <li>
                Your own Maps settings still apply. Avoid highways or avoid tolls will move the route regardless of what
                is in the&nbsp;link.
              </li>
            </ul>
          </section>
        </>
      ).toString(),
    }),
  )
})

// The old address. In riders' bookmarks and in the docs since August, so it is
// a redirect and not a 404; the query rides along because `?density=` and
// `?group=` both still mean something on the new page.
goRoutes.get('/m/:slug/navigate', (c) => {
  const q = new URL(c.req.url).search
  return c.redirect(`/m/${c.req.param('slug')}/go${q}`, 301)
})
