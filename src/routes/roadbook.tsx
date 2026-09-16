// The printable roadbook (#25) — the sheet a rider tapes to the tank bag.
//
// **This is a stop-by-stop roadbook, not a turn-by-turn cue sheet, and that is
// a limit of the data rather than a choice.** `route_legs` stores geometry,
// distance and duration and nothing else; maneuvers are a separate field on the
// Directions response, they are what the call is priced on, and they would be
// blank for every imported ride regardless. Printing "turn left in 0.4 mi"
// would mean re-requesting every leg with a wider field mask at print time.
//
// What a rider actually needs taped to a tank bag is the thing this can answer
// honestly: where the stops are, how far apart, how far since the last fuel,
// and what time you should be there. That is a roadbook. It is what rally
// riders carry and it does not go stale when a road closes.
//
// No JavaScript. It is a page you print.
import { Hono } from 'hono'
import type { AuthEnv } from '../auth/middleware'
import { loadRideForExport } from '../maps/export'
import { METERS_PER_MILE } from '../maps/kml'
import { ROLE_META, type Role } from '../maps/roles'
import { fmtDuration, routeRows } from '../maps/roadbook-rows'
import { fmtClock, fmtDateLong } from '../views/date-format'
import { clockFor, dateFormatFor } from '../views/prefs'
import { page, wordsOf } from '../views/layout'
import { StrandSwitch } from '../views/strand-switch'
import { viewableRide } from '../access/query'
import { resolveStrand } from '../subgroups/service'
import { type Units, distanceFrom, distanceUnit, twistFrom, twistUnit } from '../views/units'
import { unitsFor } from '../views/prefs'
import { Wd, wd, wn } from '../views/vocab'
import { SEP } from '../views/sep'

export const roadbookRoutes = new Hono<AuthEnv>()

const mi = (m: number) => m / METERS_PER_MILE

/**
 * One decimal, in the rider's own unit (#150).
 *
 * ONE DECIMAL IN BOTH, deliberately. A kilometer is the shorter unit so the same
 * road prints a bigger number, and dropping to a whole unit for metric would
 * make the roadbook LESS precise for the rider who chose the finer scale. The
 * printed page has room for the digit either way.
 */
const fmtMi = (m: number, units: Units) => distanceFrom(m, units).toFixed(1)

// The rows themselves live in src/maps/roadbook-rows.ts since 2026-09-14, when
// the on-the-road page (#69) became a second reader. Re-exported here so the
// test and anything else that imported them from the route keep working.
export { fmtDuration, routeRows, type Row } from '../maps/roadbook-rows'

const roleTitles = (roles: Role[]) => roles.map((r) => ROLE_META[r]?.title ?? r).join(SEP)

roadbookRoutes.get('/m/:slug/roadbook', async (c) => {
  // c.get('user'), not currentUser() — this route is open to anyone with the
  // link, and currentUser() throws outside an auth gate. It threw a 500 at an
  // anonymous request for a private ride, which is a worse answer than 404 in
  // every way including what it tells the asker.
  const user = c.get('user') ?? null
  const slug = c.req.param('slug')
  // Signed in: their choice. Anonymous with the link: their browser's. See
  // dateFormatFor — a shared ride is printable by anyone, so this route has to
  // work with no user at all.
  const dateFormat = await dateFormatFor(c)
  // The rider's own clock beside their own date order (#270). Signed-out — a
  // shared ride is printable by anyone — resolves to `locale`, which is what the
  // date format alone already said.
  const clock = await clockFor(c)

  // The same visibility gate the viewer uses — literally the same function now.
  // A roadbook is the ride, rendered differently; it must not be a way around
  // who may see it, and it was a way around two narrower things until this call
  // replaced the copy that used to live here. It now also goes dark for a
  // leaving owner and for a trashed ride, neither of which the local copy knew
  // about.
  const m = await viewableRide(slug, user)
  if (!m) return c.text('Not found', 404)

  // ACTIVE DAYS ONLY — loadRideForExport has already dropped the losing
  // alternates, so every reduce and every section below is over the ride as it
  // will be ridden and needs no filtering of its own. A roadbook is a thing you
  // print and carry; printing the road you decided against is worse than useless
  // on a tank bag. `ride.hiddenAlts` is how many were left out.
  // WHOSE ROADBOOK. A rider on the Sacramento approach opens this and gets
  // their own — their approach plus every shared route, and nothing about
  // Oakland's morning. Derived from membership rather than asked for; `?group`
  // overrides it and `?group=all` is the planner's way back to the whole ride.
  const strand = await resolveStrand(m.id, user?.id ?? null, c.req.query('group'))
  const ride = await loadRideForExport(
    m.id,
    { title: m.title, description: m.description },
    strand.subgroupId,
    strand.routeUids,
  )
  if (ride.routes.length === 0) return c.text('Not found', 404)

  const units = await unitsFor(c)
  const w = wordsOf({ user, ride: m })
  const totalM = ride.routes.reduce((n, r) => n + r.distanceM, 0)
  const totalS = ride.routes.reduce((n, r) => n + r.durationS, 0)
  const anyClock = ride.routes.some((r) => r.startAt)

  return c.html(
    page({
      title: `${m.title} – ${wd(w, 'roadbook')}`,
      user,
      words: w,
      ride: m,
      bodyClass: 'roadbook-page',
      body: (
        <>
          <header class="rb-head">
            <h1>{m.title}</h1>
            <p class="rb-summary">
              {ride.routes.length} {wn(w, 'route', ride.routes.length)}
              {SEP}
              {fmtMi(totalM, units)} {distanceUnit(units)}
              {totalS > 0 && (
                <>
                  {SEP}
                  {fmtDuration(totalS)} {wd(w, 'travel')}
                </>
              )}
            </p>
            {m.description && <p class="rb-note">{m.description}</p>}
            {/* A roadbook is a thing you print and carry, so which one you
                printed has to be on it. Renders nothing on a ride with no
                subgroups, which is nearly all of them. */}
            <StrandSwitch strand={strand} base={`/m/${m.slug}/roadbook`} />
            {anyClock && (
              <p class="rb-caveat">
                Times are estimates: the {wd(w, 'route')}’s {wd(w, 'travel')} time spread evenly over its distance, plus
                the time planned at each stop. Traffic, weather, and the way you actually go are not in&nbsp;them.
              </p>
            )}
          </header>

          {ride.routes.map((r, i) => {
            const rows = routeRows(r)
            return (
              <section class="rb-route">
                <h2>
                  <span class="rb-route-swatch" style={`background:${r.color}`}></span>
                  {r.title || `${Wd(w, 'route')} ${i + 1}`}
                </h2>
                <p class="rb-route-meta">
                  {r.startAt && (
                    <>
                      {fmtDateLong(r.startAt, dateFormat)}
                      {SEP}
                    </>
                  )}
                  {fmtMi(r.distanceM, units)} {distanceUnit(units)}
                  {r.durationS > 0 && (
                    <>
                      {SEP}
                      {fmtDuration(r.durationS)} {wd(w, 'travel')}
                    </>
                  )}
                  {/* Converted for display, and the STORED figure stays degrees
                    per mile — see rollUpTwist() in src/stats/shape.ts for why the
                    band labels are not converted with it. */}
                  {r.twistinessDpm != null && (
                    <>
                      {' '}
                      {SEP}
                      {Math.round(twistFrom(r.twistinessDpm, units))}
                      {twistUnit(units)}
                    </>
                  )}
                </p>

                {rows.length === 0 ? (
                  <p class="rb-empty">No stops on this route.</p>
                ) : (
                  /* THE WRAPPER IS FOR THE PHONE. Eight columns at 0.9rem do
                     not fit 358px, and on screen the table had no narrow rule
                     at all: it squeezed every column to a word and wrapped the
                     stop names three lines deep. `.rb-scroll` scrolls sideways
                     under the seam (_roadbook.scss) and is a plain div at every
                     other width and in print. Sideways rather than stacked
                     rows, because a mileage column is read by scanning DOWN
                     it — that is what the tabular figures are for — and
                     stacking the rows would destroy the one thing the sheet
                     exists to line up. */
                  <div class="rb-scroll">
                    <table class="rb-table">
                      <thead>
                        <tr>
                          <th class="rb-n">#</th>
                          <th>Stop</th>
                          <th class="rb-num">Leg</th>
                          <th class="rb-num">Total</th>
                          <th class="rb-num">Fuel</th>
                          {r.startAt && <th class="rb-num">At</th>}
                          <th class="rb-num">Stay</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr class={row.n === null ? 'rb-poi' : undefined}>
                            <td class="rb-n">{row.n ?? '·'}</td>
                            <td>
                              <span class="rb-name">{row.point.name || 'Unnamed'}</span>
                              {row.point.roles.length > 0 && (
                                <span class="rb-roles">{roleTitles(row.point.roles)}</span>
                              )}
                              {row.point.description && <span class="rb-desc">{row.point.description}</span>}
                            </td>
                            <td class="rb-num">{row.fromPrevM ? fmtMi(row.fromPrevM, units) : '—'}</td>
                            <td class="rb-num">{row.atM == null ? '—' : fmtMi(row.atM, units)}</td>
                            {/* Blank until the first fuel stop: "miles since fuel" has no
                              answer before there has been any. */}
                            <td class="rb-num">{row.sinceFuelM == null ? '—' : fmtMi(row.sinceFuelM, units)}</td>
                            {r.startAt && (
                              <td class="rb-num">{row.arrive ? fmtClock(row.arrive, dateFormat, clock) : '—'}</td>
                            )}
                            <td class="rb-num">
                              {row.point.durationMin ? fmtDuration(row.point.durationMin * 60) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )
          })}

          <p class="rb-print no-print">
            <button class="btn" type="button" onclick="window.print()">
              Print
            </button>
            <a class="btn is-quiet" href={`/m/${m.slug}`}>
              Back to the map
            </a>
          </p>
        </>
      ).toString(),
    }),
  )
})
