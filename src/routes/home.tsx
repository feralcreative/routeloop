// THE DASHBOARD, at `/`. This is the page with the numbers on it: hero miles,
// tiles, the storage meter, the twist rollup, role bars, the twelve-month chart.
//
// It used to be the first ten of your rides beside the first ten popular public
// ones — a ride list with a copy of /explore?sort=popular bolted on, which gave
// the nav two doors into the same room. The ride list now belongs to /rides
// alone and this page answers a different question.
//
// Naming, because it has confused everyone including its own author: the file
// is `home.tsx` and the route is `/`, but `public/js/dashboard.js` and
// `style/_dashboard.scss` are BOTH THIS PAGE'S. They are named for what the page
// is rather than for what the file is called, and they are the honest names —
// `src/routes/rides.tsx` is the ride list and owns neither.
//
// EVERY NUMBER HERE IS RENDERED SERVER-SIDE AS TEXT. The one chart is progressive
// enhancement over a table that is already correct without it — the roadbook and
// the hand-off pages set that precedent deliberately, and a stats page that goes
// blank without script would be the first thing in the app to do so.
//
// What is deliberately absent: any figure derived from riding time. The import
// path never writes routes.duration_s or rides.total_duration_s, so a lifetime
// "hours in the saddle" would undercount by however much of the library was
// imported — silently, and in the flattering direction. See src/stats/shape.ts.
import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { raw } from 'hono/html'
import { db } from '../db/index'
import { rides, days as daysTable } from '../db/schema'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { page } from '../views/layout'
import { asset } from '../views/assets'
import { rideCards } from '../views/cards'
import { cachedUsedBytes, loadStats } from '../stats/query'
import { shapeStats } from '../stats/shape'
import type { DashboardStats, MonthPoint, RoleBar, Tile } from '../stats/shape'

export const homeRoutes = new Hono<AuthEnv>()

const RECENT = 6

// --- Pieces ------------------------------------------------------------------

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
              one hue is the whole colour requirement — a ramp across seventeen
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
      {/* Direct labels, always. Identity is never carried by colour alone. */}
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

  const [stats, cached, recent] = await Promise.all([
    loadStats(user.id),
    cachedUsedBytes(user.id),
    db
      .select({ ride: rides, color: daysTable.color })
      .from(rides)
      .leftJoin(daysTable, and(eq(daysTable.rideId, rides.id), eq(daysTable.position, 0)))
      .where(eq(rides.ownerId, user.id))
      .orderBy(desc(rides.updatedAt))
      .limit(RECENT),
  ])

  const s = shapeStats(stats, cached, new Date())
  const drawChart = s.months.some((m) => m.n > 0)

  if (s.storageDrift) {
    // Not shown to the rider — the number they see is the authoritative sum
    // either way. Logged because used_bytes has no reconciler and this is the
    // only place in the app that can notice it has drifted.
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

          <section class="stat-block">
            <h2>Picking up where you left off</h2>
            {raw(rideCards(recent))}
            <p>
              <a class="linkbtn" href="/rides">
                All your rides
              </a>
            </p>
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
