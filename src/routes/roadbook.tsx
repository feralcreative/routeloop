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
import { eq } from 'drizzle-orm'
import { db } from '../db/index'
import { rides } from '../db/schema'
import type { AuthEnv } from '../auth/middleware'
import { loadRideForExport, type ExportPoint, type ExportRoute } from '../maps/export'
import { METERS_PER_MILE } from '../maps/kml'
import { ROLE_META, type Role } from '../maps/roles'
import { page } from '../views/layout'

export const roadbookRoutes = new Hono<AuthEnv>()

const mi = (m: number) => m / METERS_PER_MILE
const fmtMi = (m: number) => mi(m).toFixed(1)

// "4h 20m", or "35m" under the hour. A dash rather than "0m" when the router
// never answered for a leg — a dash reads as unknown, 0m reads as instant.
//
// Used for dwell too, where the raw minutes are unreadable: an overnight camp
// stop printed "658m" before this, which nobody parses at a glance.
function fmtDuration(seconds: number): string {
  if (seconds <= 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

const fmtClock = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })

const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })

const roleTitles = (roles: Role[]) => roles.map((r) => ROLE_META[r]?.title ?? r).join(' · ')

// A row is a stop or a POI, already in along-the-route order.
export type Row = {
  point: ExportPoint
  n: number | null // stop number; POIs are not numbered
  fromPrevM: number | null
  atM: number | null
  sinceFuelM: number | null
  arrive: Date | null
}

// Everything the sheet needs, computed once per day.
//
// `sinceFuel` is the column that earns its place: the distance since the last
// stop that could fill a tank. A rider with a 180-mile range needs to see 210
// coming, and no other view in the app says it.
//
// It reads *as you arrive*, so a fuel stop shows the distance you just covered
// on that tank rather than the 0 you are about to reset to. That is the number
// worth printing: it tells you what the bike actually did on the last tank, and
// the 0 says nothing you did not already know from the word "Gas" in the row.
export function dayRows(route: ExportRoute): Row[] {
  // A point with no measured distance goes last and reports nothing. Sorting it
  // to zero would put it at the start of the day and print "0.0" beside it,
  // which is a claim about where it is rather than an admission that nobody
  // measured. Imported rides and older seeded POIs both have these.
  const ordered = [...route.points].sort(
    (a, b) => (a.distFromStartM ?? Number.POSITIVE_INFINITY) - (b.distFromStartM ?? Number.POSITIVE_INFINITY),
  )

  // Riding seconds are known per day, not per leg-between-stops, so they are
  // spread across the day's distance. That is an estimate and the header says
  // so; the alternative is no clock at all, which is worse on a sheet whose
  // whole job is telling you whether you are behind.
  const perMeter = route.distanceM > 0 ? route.durationS / route.distanceM : 0

  const rows: Row[] = []
  let n = 0
  let prevM = 0
  let fuelAtM = 0
  let sawFuel = false
  let clock = route.startAt ? new Date(route.startAt) : null

  for (const p of ordered) {
    const isPoi = p.kind === 'poi'
    const at = p.distFromStartM

    if (at == null) {
      rows.push({ point: p, n: isPoi ? null : ++n, fromPrevM: null, atM: null, sinceFuelM: null, arrive: null })
      continue
    }

    if (clock) clock = new Date(clock.getTime() + (at - prevM) * perMeter * 1000)
    const arrive = clock ? new Date(clock) : null
    if (clock && p.durationMin) clock = new Date(clock.getTime() + p.durationMin * 60_000)

    rows.push({
      point: p,
      n: isPoi ? null : ++n,
      // null, not 0, for the first point of the day: there is no leg before it.
      // Same convention as atM and sinceFuelM — a dash means "no answer", and
      // relying on 0 being falsy in the template would make the value itself a
      // lie for anything that read it directly.
      fromPrevM: rows.length === 0 ? null : at - prevM,
      atM: at,
      sinceFuelM: sawFuel ? at - fuelAtM : null,
      arrive,
    })

    // Charge counts: an EV rider's range question is the same question.
    if (p.roles.includes('gas') || p.roles.includes('charge')) {
      fuelAtM = at
      sawFuel = true
    }
    prevM = at
  }
  return rows
}

roadbookRoutes.get('/m/:slug/roadbook', async (c) => {
  // c.get('user'), not currentUser() — this route is open to anyone with the
  // link, and currentUser() throws outside an auth gate. It threw a 500 at an
  // anonymous request for a private ride, which is a worse answer than 404 in
  // every way including what it tells the asker.
  const user = c.get('user') ?? null
  const slug = c.req.param('slug')

  // The same visibility gate the viewer uses. A roadbook is the ride, rendered
  // differently — it must not be a way around who may see it.
  const [m] = await db.select().from(rides).where(eq(rides.slug, slug)).limit(1)
  const viewable = m && (m.visibility === 'public' || m.visibility === 'unlisted' || (user && user.id === m.ownerId))
  if (!m || !viewable) return c.text('Not found', 404)

  const ride = await loadRideForExport(m.id, { title: m.title, description: m.description })
  if (ride.routes.length === 0) return c.text('Not found', 404)

  const totalM = ride.routes.reduce((n, r) => n + r.distanceM, 0)
  const totalS = ride.routes.reduce((n, r) => n + r.durationS, 0)
  const anyClock = ride.routes.some((r) => r.startAt)

  return c.html(
    page({
      title: `${m.title} – roadbook`,
      user,
      bodyClass: 'roadbook-page',
      body: (
        <>
          <header class="rb-head">
            <h1>{m.title}</h1>
            <p class="rb-summary">
              {ride.routes.length} {ride.routes.length === 1 ? 'day' : 'days'} · {fmtMi(totalM)} mi
              {totalS > 0 && <> · {fmtDuration(totalS)} riding</>}
            </p>
            {m.description && <p class="rb-note">{m.description}</p>}
            {anyClock && (
              <p class="rb-caveat">
                Times are estimates: the day’s riding time spread evenly over its distance, plus the time planned at
                each stop. Traffic, weather and the way you actually ride are not in them.
              </p>
            )}
          </header>

          {ride.routes.map((r, i) => {
            const rows = dayRows(r)
            return (
              <section class="rb-day">
                <h2>
                  <span class="rb-day-swatch" style={`background:${r.color}`}></span>
                  {r.title || `Day ${i + 1}`}
                </h2>
                <p class="rb-day-meta">
                  {r.startAt && <>{fmtDate(r.startAt)} · </>}
                  {fmtMi(r.distanceM)} mi
                  {r.durationS > 0 && <> · {fmtDuration(r.durationS)} riding</>}
                  {r.twistinessDpm != null && <> · {r.twistinessDpm}°/mi</>}
                </p>

                {rows.length === 0 ? (
                  <p class="rb-empty">No stops on this day.</p>
                ) : (
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
                            {row.point.roles.length > 0 && <span class="rb-roles">{roleTitles(row.point.roles)}</span>}
                            {row.point.description && <span class="rb-desc">{row.point.description}</span>}
                          </td>
                          <td class="rb-num">{row.fromPrevM ? fmtMi(row.fromPrevM) : '—'}</td>
                          <td class="rb-num">{row.atM == null ? '—' : fmtMi(row.atM)}</td>
                          {/* Blank until the first fuel stop: "miles since fuel" has no
                              answer before there has been any. */}
                          <td class="rb-num">{row.sinceFuelM == null ? '—' : fmtMi(row.sinceFuelM)}</td>
                          {r.startAt && <td class="rb-num">{row.arrive ? fmtClock(row.arrive) : '—'}</td>}
                          <td class="rb-num">
                            {row.point.durationMin ? fmtDuration(row.point.durationMin * 60) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
