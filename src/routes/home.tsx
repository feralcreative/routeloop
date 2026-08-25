// THE DASHBOARD, at `/`. This is the page with the numbers on it: hero miles,
// tiles, the storage meter, the twist rollup, role bars, the twelve-month chart.
//
// AND THE RIDER'S OWN RIDES, since 2026-08-24. That is the second time this page
// has held a list and the two are not the same mistake, so the history matters.
//
// It was once the first ten of your rides beside the first ten popular public
// ones — a ride list with a copy of /explore?sort=popular bolted on. Splitting
// that out to /rides in August fixed the /explore half and left the other: `/`
// kept a six-ride "picking up where you left off" strip, so the nav still had two
// doors onto a rider's own rides. Ziad's call on 2026-08-24, answering the third
// of #103's four open questions: one door. /rides 302s here and the full list
// sits under the stats.
//
// The list is CAPPED at RIDE_PAGE with `?rides=all` to lift it. The page it
// absorbed was unpaginated, and an unbounded list hanging under eight blocks of
// stats gets worse the more a rider uses the app.
//
// Naming, because it has confused everyone including its own author: the file
// is `home.tsx` and the route is `/`, but `public/js/dashboard.js` and
// `style/_dashboard.scss` are BOTH THIS PAGE'S. They are named for what the page
// is rather than for what the file is called, and they were the honest names even
// while `src/routes/rides.tsx` held the list. That file is now a redirect.
//
// EVERY NUMBER HERE IS RENDERED SERVER-SIDE AS TEXT. The one chart is progressive
// enhancement over a table that is already correct without it — the roadbook and
// the hand-off pages set that precedent deliberately, and a stats page that goes
// blank without script would be the first thing in the app to do so.
//
// Saddle time IS reported here as of 2026-08-24, and it used to be the one thing
// this page deliberately withheld: the import path writes no leg duration, so a
// lifetime "hours in the saddle" undercounted by however much of the library was
// imported — silently, and in the flattering direction. It is estimated from
// distance now, the same way both clients estimate an unrouted leg, and the hero
// says when part of the figure was figured rather than measured. See
// src/maps/ride-time.ts and src/stats/shape.ts.
import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, days as daysTable, type RideRow } from '../db/schema'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { page } from '../views/layout'
import { asset } from '../views/assets'
import { cachedUsedBytes, loadStats } from '../stats/query'
import { shapeStats } from '../stats/shape'
import type { DashboardStats, MonthPoint, RoleBar, Tile } from '../stats/shape'

export const homeRoutes = new Hono<AuthEnv>()

// How many of a rider's own rides this page draws before it offers the rest.
//
// It was RECENT = 6, a "picking up where you left off" strip beside a full list
// at /rides. That page folded into this one on 2026-08-24, so this number stopped
// being a teaser and became a cap — and a cap is what it has to be: the old list
// was unpaginated, and hanging an unbounded one under eight blocks of stats
// makes the page worse the more a rider uses the app.
//
// `?rides=all` renders every one. A query parameter rather than script, because
// this page renders every number as text and a "show all" that needs JavaScript
// would be the first thing on it that does not.
const RIDE_PAGE = 24

// The ceiling `?rides=all` raises the cap to, rather than removing it. Nobody is
// near this — the largest dev corpus is twenty rides — and it exists so the page
// cannot be made slow by a rider who imports a folder every week for a year.
const RIDE_CEILING = 500

// --- Pieces ------------------------------------------------------------------

// Deliberately not views/cards.tsx: this row carries a visibility pill and an
// edit link that the public card must never show. Same shape, different
// contract — merging them would mean a flag that only ever means "am I the
// owner", which is the thing the two separate components already say.
//
// Moved here from src/routes/rides.tsx on 2026-08-24 when that page folded into
// this one. The contract above survived the move unchanged.
function OwnRideRow({ ride, color }: { ride: RideRow; color: string | null }) {
  return (
    <li class="cardrow">
      <a class="card" href={`/m/${ride.slug}`}>
        {ride.thumbHash ? (
          // The picture takes the swatch's slot when there is one; the color dot
          // is what a ride falls back to before its first sweep, and for one with
          // no geometry to draw. `?v=` is the request hash, which is what lets the
          // route serve this immutable — a changed picture is a changed URL.
          //
          // Lazy, because this list is now every ride a rider owns rather than
          // six. width/height are the CSS box, so the row does not reflow as each
          // one lands.
          <img
            class="card-thumb"
            src={`/api/public/maps/${ride.slug}/thumb.png?v=${ride.thumbHash}`}
            alt=""
            width="160"
            height="100"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span class="swatch" style={{ background: color ?? '#0000cc' }}></span>
        )}
        <span>{ride.title}</span>
        <span class="pill">{ride.visibility}</span>
        <span class="meta">
          {ride.stopCount} stops · {Number(ride.totalMiles)} mi
        </span>
      </a>
      {/* Every own ride is editable now, imported ones included — this used to
          test `ride.source === 'native'` because the builder could not open an
          import. It can; see canEditRide in ./maps. */}
      <a class="editlink" href={`/builder/${ride.id}`}>
        Edit
      </a>
    </li>
  )
}

function StatTile({ tile }: { tile: Tile }) {
  return (
    <li class="stat-tile" title={tile.hint}>
      <span class="stat-value">{tile.value}</span>
      <span class="stat-label">{tile.label}</span>
    </li>
  )
}

function Meter({ stats }: { stats: DashboardStats }) {
  const m = stats.meter
  if (!m) return <></>
  return (
    <section class="stat-block">
      <h2>Imported files</h2>
      <div class="meter" role="img" aria-label={`${m.used} of ${m.quota} used`}>
        <span class="meter-fill" style={`width:${m.pct.toFixed(1)}%`}></span>
      </div>
      <p class="stat-note">
        {m.used} of {m.quota}. Rides you build here take no space at all — only imported files count.
      </p>
    </section>
  )
}

function RoleChart({ bars, exceeds }: { bars: RoleBar[]; exceeds: boolean }) {
  if (bars.length === 0) return <></>
  return (
    <section class="stat-block">
      <h2>What you stop for</h2>
      <ul class="role-bars">
        {bars.map((b) => (
          <li class="role-bar">
            <span class="role-label">{b.label}</span>
            {/*
              The bar is a div, not a chart. Magnitude is carried by length, so
              one hue is the whole color requirement — a ramp across seventeen
              rows would imply an ordering the categories do not have.
            */}
            <span class="role-track">
              <span class="role-fill" style={`width:${Math.max(2, b.share * 100).toFixed(1)}%`}></span>
            </span>
            <span class="role-n">{b.n}</span>
          </li>
        ))}
      </ul>
      {exceeds && (
        // Without this the arithmetic looks broken: a stop tagged gas AND food
        // is counted in both bars, so the bars total more than the waypoints do.
        <p class="stat-note">A stop can be more than one thing, so these add up to more than your waypoint count.</p>
      )}
    </section>
  )
}

function Activity({ months }: { months: MonthPoint[] }) {
  const total = months.reduce((n, m) => n + m.n, 0)
  if (total === 0) return <></>
  const peak = months.reduce((n, m) => Math.max(n, m.n), 0)
  return (
    <section class="stat-block">
      <h2>Rides planned, last 12 months</h2>
      {/*
        The chart draws into this if uPlot loads. The table underneath is not a
        fallback bolted on afterwards — it is the accessible form of the same
        data, and it stays in the DOM either way.
      */}
      <div class="chart" id="rides-chart" aria-hidden="true"></div>
      <table class="chart-table">
        <caption class="visually-hidden">Rides planned per month over the last 12 months</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Rides</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr>
              <th scope="row">{m.label}</th>
              <td class="num">
                <span class="mini-bar" style={`width:${peak === 0 ? 0 : (m.n / peak) * 100}%`}></span>
                {m.n}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Sharing({ stats }: { stats: DashboardStats }) {
  const total = stats.visibility.reduce((n, v) => n + v.n, 0)
  if (total === 0) return <></>
  return (
    <section class="stat-block">
      <h2>Who can see them</h2>
      <div class="split" role="img" aria-label={stats.visibility.map((v) => `${v.n} ${v.label}`).join(', ')}>
        {stats.visibility
          .filter((v) => v.n > 0)
          .map((v) => (
            <span class={`split-seg split-${v.key}`} style={`flex:${v.n}`}></span>
          ))}
      </div>
      {/* Direct labels, always. Identity is never carried by color alone. */}
      <ul class="split-key">
        {stats.visibility.map((v) => (
          <li>
            <span class={`key-dot split-${v.key}`}></span>
            {v.label} <strong>{v.n}</strong>
          </li>
        ))}
      </ul>
    </section>
  )
}

// --- The page ----------------------------------------------------------------

homeRoutes.get('/', requireActive, async (c) => {
  const user = currentUser(c)

  // `?rides=all` lifts the cap. Anything else, including a missing parameter and
  // any value a bot invents, reads as "capped" — the safe answer is the bounded
  // query, so this tests for the one string rather than for truthiness.
  const showAll = c.req.query('rides') === 'all'

  const [stats, cached, owned] = await Promise.all([
    loadStats(user.id),
    cachedUsedBytes(user.id),
    db
      .select({ ride: rides, color: daysTable.color })
      .from(rides)
      .leftJoin(daysTable, and(eq(daysTable.rideId, rides.id), eq(daysTable.position, 0)))
      .where(eq(rides.ownerId, user.id))
      // updatedAt, not createdAt. /rides sorted by creation because it was a
      // catalogue; this list has to do that job AND the "pick up where you left
      // off" one the strip above it used to do, and the ride you touched last is
      // the answer to the second.
      .orderBy(desc(rides.updatedAt))
      // One more than the cap, which is what tells us there IS more without a
      // second count query. The extra row is sliced off before rendering.
      //
      // `?rides=all` raises the ceiling rather than removing it. The list this
      // replaced had no limit at all and that was the defect, so "all" must not
      // reintroduce it — a rider with ten thousand rides gets a bounded page and
      // a query that finishes.
      .limit(showAll ? RIDE_CEILING : RIDE_PAGE + 1),
  ])

  const hasMore = !showAll && owned.length > RIDE_PAGE
  const visibleRides = hasMore ? owned.slice(0, RIDE_PAGE) : owned

  const s = shapeStats(stats, cached, new Date())
  const drawChart = s.months.some((m) => m.n > 0)

  if (s.storageDrift) {
    // Still not shown to the rider — the number they see is the authoritative
    // sum either way, and the drift is a bug in our bookkeeping rather than
    // anything they can act on.
    //
    // It IS repaired now: src/account/quota-sweep.ts rewrites the tally from the
    // authoritative sum every five minutes, so a wrong quota check has a bounded
    // life instead of an unbounded one. This log survives that on purpose — the
    // sweep says a drift was corrected, and this says which page saw it and for
    // whom, which is what makes the increment/decrement path findable.
    console.warn(`[stats] used_bytes drift for user ${user.id}: cache ${cached} vs actual ${stats.totals.storedBytes}`)
  }

  const body = (
    <main class="home">
      <h1>Welcome back, {user.displayName}</h1>

      {s.hasRides ? (
        <>
          <section class="hero-stat">
            <span class="hero-value">{s.heroMiles}</span>
            <span class="hero-label">
              miles planned
              {/*
                Saddle time rides in the hero rather than as a fifth tile: the
                four tiles are counts of things, this is a duration, and #137 is
                about to give each of those four a yours/average/top row that a
                lifetime total has no equivalent of.

                `title` carries the estimated-or-measured note. It is the same
                affordance StatTile uses for its hint, and it is the one place
                the page can admit that part of the figure is a guess without
                putting a caveat in the middle of a headline.
              */}
              {s.saddle && (
                <span title={s.saddle.note}>
                  {' · '}
                  {s.saddle.hours} hours riding{s.saddle.estimated && '*'}
                </span>
              )}
              {s.twist && <> · {s.twist.label} overall</>}
            </span>
          </section>

          <ul class="stat-tiles">
            {s.tiles.map((t) => (
              <StatTile tile={t} />
            ))}
          </ul>

          {s.records.length > 0 && (
            <section class="stat-block">
              <h2>Your records</h2>
              <ul class="record-list">
                {s.records.map((r) => (
                  <li>
                    <span class="record-label">{r.label}</span>
                    <span class="record-value">{r.value}</span>
                    {r.hint && <span class="record-hint">{r.hint}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <RoleChart bars={s.roles} exceeds={s.rolesExceedPoints} />
          <Activity months={s.months} />
          <Sharing stats={s} />
          <Meter stats={s} />

          {/*
            The whole list, not a strip. This was six rides under "Picking up
            where you left off" with a link out to /rides; that page folded into
            this one on 2026-08-24, so the heading names what it now holds.

            OwnRideRow rather than rideCards(): every ride here is the viewer's
            own, so each carries a visibility pill and an edit link that the
            public card must never show.
          */}
          <section class="stat-block">
            <h2>Your rides</h2>
            <p class="sub">
              {stats.totals.rides} {stats.totals.rides === 1 ? 'ride' : 'rides'}
            </p>
            <ul class="cards">
              {visibleRides.map((r) => (
                <OwnRideRow {...r} />
              ))}
            </ul>
            {hasMore && (
              <p>
                <a class="linkbtn" href="/?rides=all">
                  Show all {stats.totals.rides}
                </a>
              </p>
            )}
          </section>
        </>
      ) : (
        <section class="stat-block">
          <p class="lede">
            Nothing planned yet. Build a ride and this page fills up with what you have covered — miles, days, the
            stops you keep making, the twistiest roads you have picked.
          </p>
          <p>
            <a class="btn" href="/builder">
              Plan your first ride
            </a>{' '}
            <a class="linkbtn" href="/import">
              or import one you already have
            </a>
          </p>
        </section>
      )}
    </main>
  ).toString()

  return c.html(
    page({
      title: 'Home',
      user,
      navKey: 'home',
      body,
      // Only when there is something to draw. A rider with no rides pays for no
      // chart code at all — which is most of the point of loading it here rather
      // than in the shared layout.
      //
      // No stylesheet: uPlot's own CSS is 1.8 KB of layout primitives and is
      // inlined into _dashboard.scss instead, so the chart costs one request
      // rather than two and can be themed with the rest of the page.
      tb: drawChart ? { months: s.months } : undefined,
      scripts: drawChart
        ? `<script src="${asset('/js/uplot.min.js')}"></script><script src="${asset('/js/dashboard.js')}"></script>`
        : undefined,
    }),
  )
})
