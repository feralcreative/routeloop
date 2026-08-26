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
import { raw } from 'hono/html'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, days as daysTable, type RideRow } from '../db/schema'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { page } from '../views/layout'
import { asset } from '../views/assets'
import { icon } from '../views/icon'
import { CardFace } from '../views/cards'
import { cachedGlobalStats, cachedUsedBytes, loadStats } from '../stats/query'
import { shapeStats } from '../stats/shape'
import type { DashboardStats, MonthPoint, RecordTile, RoleBar, Tile } from '../stats/shape'
import { LIVE_RIDE } from '../trash/service'

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

// Deliberately not views/cards.tsx's own Card: this one carries a visibility pill
// and an edit link that the public card must never show. Same shape, different
// contract — merging them would mean a flag that only ever means "am I the
// owner", which is the thing the two separate components already say.
//
// What IS shared is CardFace, the picture-or-color-block, because that part has
// no contract of its own. It is also the part with the traps in it — the `?v=`
// immutability hash, the lazy loading, the source dimensions that keep the grid
// from reflowing — and those had already been copied once.
//
// Moved here from src/routes/rides.tsx on 2026-08-24 when that page folded into
// this one. Became a card on 2026-08-25 with the rest of them (#135).
//
// THE EDIT LINK AND THE PILL SIT OUTSIDE THE ANCHOR, and that is not a layout
// preference: an <a> inside an <a> is invalid HTML and browsers recover from it
// by closing the outer one early, which silently drops half the card out of the
// link. The foot is a sibling of the link, and the card's own padding is what
// makes the two read as one object.
function OwnRideCard({ ride, color }: { ride: RideRow; color: string | null }) {
  return (
    <li class="ride-card">
      <a class="ride-card-link" href={`/m/${ride.slug}`}>
        <CardFace slug={ride.slug} thumbHash={ride.thumbHash} color={color} />
        <span class="ride-card-body">
          <span class="ride-card-title">{ride.title}</span>
          <span class="ride-card-meta">
            {ride.stopCount} stops · {Number(ride.totalMiles)} mi
          </span>
        </span>
      </a>
      <div class="ride-card-foot">
        <span class="pill">{ride.visibility}</span>
        {/* Every own ride is editable now, imported ones included — this used to
            test `ride.source === 'native'` because the builder could not open an
            import. It can; see canEditRide in ./maps. */}
        <a class="editlink" href={`/builder/${ride.id}`}>
          Edit
        </a>
      </div>
    </li>
  )
}

function StatTile({ tile }: { tile: Tile }) {
  return (
    <li class="stat-tile" title={tile.hint}>
      <span class="stat-value">{tile.value}</span>
      <span class="stat-label">{tile.label}</span>
      {/*
        The comparison columns (#137). A number alone says nothing about whether
        it is a lot, so each tile carries what the average rider has and what the
        highest anyone has.

        A dl rather than two spans, because these ARE label/value pairs and the
        markup should say so — "avg" beside "6.7" is not decoration, it is what
        makes the figure mean anything. The pair is rendered only when the tile
        carries one; the "roads you insisted on" tile has no cohort figure and
        gets nothing rather than a zero it never measured.

        No names anywhere, ever. The pool is every rider and every ride including
        private ones, which is only acceptable because these are two anonymous
        aggregates — see loadGlobalStats in src/stats/query.ts.
      */}
      {tile.spread && (
        <dl class="stat-spread">
          <div>
            <dt>avg</dt>
            <dd>{tile.spread.avg}</dd>
          </div>
          <div>
            <dt>top</dt>
            <dd>{tile.spread.top}</dd>
          </div>
        </dl>
      )}
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
          // One custom property per row carries the role's hue to both the badge
          // and the fill, so the two can never disagree about what a category
          // looks like. Absent when the color is null, which leaves the fallback
          // in _dashboard.scss to paint a grey bar — see roleColor().
          <li class="role-bar" style={b.color ? `--role-color:${b.color}` : undefined}>
            {/*
              INLINE SVG, and `<img src>` is the trap here. Each mark is a disc
              filled `currentColor` with the glyph knocked out white, and
              currentColor inside an externally-referenced SVG resolves against
              that file's own context rather than this page's — an <img> renders
              a black disc no matter what CSS surrounds it. icon() reads and
              caches; see src/views/icon.ts.
            */}
            <span class="role-mark">{raw(icon(b.role))}</span>
            <span class="role-label">{b.label}</span>
            {/*
              The bar is a div, not a chart. Magnitude is carried by length, and
              the color carries WHICH CATEGORY rather than how much of it.

              This row used to be one hue for all seventeen, on the argument that
              "a ramp across seventeen rows would imply an ordering the categories
              do not have". That reasoning is correct and it is not what is
              happening here — a SEQUENTIAL ramp implies rank, and this is a
              CATEGORICAL ring: seventeen hues at one fixed lightness, so no
              member reads as larger or later than another. src/maps/role-colors.ts
              is the derivation.

              Color is redundant here, never load-bearing: every row also carries
              its own mark and its own text label, which is what lets the ring
              stay put under the colorblind theme instead of pretending seventeen
              categories can be told apart by hue.
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

// "Your records" (#136), which is the most celebratory block on this page and
// used to look like the least — four bordered boxes with the figure set at
// 1.15rem, the same weight the app gives a form label.
//
// The markup was already right; what it lacked was emphasis. Four moves, and
// each one is visible in the class names below: the numeral is set large, the
// unit is split off it so the emphasis lands on the figure rather than on "mi",
// each record carries its own mark, and the card gets an accent edge in the
// mark's own color.
//
// THE FOUR MARKS ARE PLACEHOLDERS. `icon-record-*.svg` are simple geometry in
// the house shape — a currentColor disc with a white glyph — standing in until
// Ziad draws the real ones, 2026-08-25. Replacing a file is the whole job:
// nothing here reads the drawing, and the name follows from the record's kind.
//
// `kind` also picks the accent, in _dashboard.scss. One field drives the mark and
// the color together, so a fifth record cannot arrive with one and not the other.
//
// EACH RECORD SHOWS THE MAP OF THE RIDE THAT HOLDS IT, and links to it, since
// 2026-08-26. Two of the four had no ride to name before that — the longest day
// and the twistiest stretch were `max()` aggregates — so shape.ts and query.ts
// both changed to carry a slug for all four.
//
// The picture goes ABOVE the content rather than behind the figure. A numeral
// over a dimmed map is the more celebratory of the two and it puts text on an
// image in six palettes and two schemes, which test/palette-contrast.test.ts
// cannot measure — every scrim that holds one palette's text color is guesswork
// against the other five.
//
// `record-body` exists because the padding moved off the card: a face flush to
// the top edge needs the card to have none, and the text below it still does.
function Records({ records }: { records: RecordTile[] }) {
  return (
    <section class="stat-block">
      <h2>Your records</h2>
      <ul class="record-list">
        {records.map((r) => (
          <li class={`record record--${r.kind}`}>
            <RecordCard r={r} />
          </li>
        ))}
      </ul>
    </section>
  )
}

// One record's contents, wrapped in a link when there is a ride to link to.
//
// A SPAN WHEN THERE IS NO SLUG, rather than an anchor with no href. All four
// records carry one today, so this is the branch that never runs — and it runs
// the day a fifth record is a figure about the rider rather than about a ride,
// which is exactly when nobody will be looking at this file.
function RecordCard({ r }: { r: RecordTile }) {
  const inner = (
    <>
      {/* No picture at all when there is no ride, rather than a blank face: a
          record with nothing to show is the card exactly as it looked before,
          and a grid of four is short enough that one card of a different height
          reads as deliberate rather than broken. The ride-card grid cannot do
          that, which is why CardFace still draws a blank face for one. */}
      {r.slug && <CardFace slug={r.slug} thumbHash={r.thumbHash ?? null} color={null} block="record" />}
      <span class="record-body">
        <span class="record-mark">{raw(icon(`record-${r.kind}`))}</span>
        <span class="record-label">{r.label}</span>
        {/*
              `numeric` picks the size, and it is not decoration. Two of these
              four are words — a twistiness label, a ride's title — and either one
              set at the numeral's size is a headline running off its own card.

              data-count is what dashboard.js counts up to, and it is set only on
              the figures. The rendered text is already the final value, so a
              rider with script off, or one who asked for reduced motion, reads
              the number rather than a zero waiting to be animated.
            */}
        <span class={r.numeric ? 'record-value is-figure' : 'record-value is-text'}>
          <span class="record-figure" data-count={r.numeric ? r.value : undefined}>
            {r.value}
          </span>
          {r.unit && <span class="record-unit">{r.unit}</span>}
        </span>
        {r.hint && <span class="record-hint">{r.hint}</span>}
      </span>
    </>
  )

  return r.slug ? (
    <a class="record-link" href={`/m/${r.slug}`}>
      {inner}
    </a>
  ) : (
    <span class="record-link is-static">{inner}</span>
  )
}

// What `/` is before a rider has planned anything — #103's second open call,
// answered 2026-08-25.
//
// It was one line of copy and two links. That is the right SHAPE for an empty
// list inside a page that has other things on it, and the wrong one here,
// because on a first visit this is not an empty section — it is the ENTIRE page.
// A rider who has just been let in sees no hero, no tiles, no chart and no
// records, so the only thing this screen can do is say what the app is for and
// point at the two doors in.
//
// THREE STEPS, NOT A FEATURE LIST. Each one names something the app actually
// does and where it happens, in the order a ride goes through them, so the
// sequence doubles as a map of the nav. No numbered ordinals in the markup —
// they are an ol, and the numbers are the browser's.
//
// STILL PURE TEXT AND LINKS. Every other block on this page renders server-side
// with the chart as the only enhancement, and a first-run panel that needed
// script would be the first thing here to go blank without it.
//
// No hand-placed &nbsp; anywhere below, deliberately. `text-wrap: pretty` is set
// on p, li and .lede in style/_base.scss and covers every paragraph a browser
// renders; the two surfaces that bind their own last two words are the emails,
// where no client supports the property, and the printed roadbook. This is
// neither.
//
// The third door is deliberately quieter than the other two: /explore is a real
// way to start — clone someone else's route — but it is not what this app is
// for, and giving it equal weight would suggest browsing is the point.
function FirstRun() {
  return (
    <section class="first-run">
      <h2>Nothing planned yet</h2>
      <p class="lede">
        Plan a multi-day ride on one map, then take it with you. Once you have one, this page fills up with what you
        have covered — miles, days, the stops you keep making, and the twistiest roads you have picked.
      </p>

      <ol class="first-run-steps">
        <li>
          <strong>Build the route</strong>
          <span>
            Drop stops day by day, drag the line onto the road you actually want, and mark the places you will ride past
            without stopping.
          </span>
        </li>
        <li>
          <strong>Take it with you</strong>
          <span>
            Hand the day off to Google Maps on your phone, or export GPX, KML, GeoJSON or CSV for whatever is on the
            bars.
          </span>
        </li>
        <li>
          <strong>Share it, or don't</strong>
          <span>
            Send one link and everyone riding sees the same plan. Every ride starts private and stays that way until you
            change it.
          </span>
        </li>
      </ol>

      <p class="first-run-actions">
        <a class="btn" href="/builder">
          Plan your first ride
        </a>{' '}
        <a class="linkbtn" href="/import">
          or import one you already have
        </a>
      </p>

      <p class="first-run-aside">
        Not sure where to start? <a href="/explore">See what other people have planned</a> and clone one as a starting
        point.
      </p>
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

  const [stats, cached, owned, global] = await Promise.all([
    loadStats(user.id),
    cachedUsedBytes(user.id),
    db
      .select({ ride: rides, color: daysTable.color })
      .from(rides)
      .leftJoin(daysTable, and(eq(daysTable.rideId, rides.id), eq(daysTable.position, 0)))
      .where(and(eq(rides.ownerId, user.id), LIVE_RIDE))
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
    // Cohort averages, shared by every viewer and cached for a minute — four
    // aggregates per dashboard render becomes four per minute. In the same
    // Promise.all as the rest because a cache hit resolves immediately and a
    // miss should not be serialized behind the rider's own queries.
    cachedGlobalStats(),
  ])

  const hasMore = !showAll && owned.length > RIDE_PAGE
  const visibleRides = hasMore ? owned.slice(0, RIDE_PAGE) : owned

  const s = shapeStats(stats, cached, new Date(), global)
  const drawChart = s.months.some((m) => m.n > 0)

  // dashboard.js carries two unrelated enhancements now — the chart, and the
  // count-up on the record figures (#136) — so it ships when EITHER has something
  // to do. uPlot still ships only for the chart: it is 50 KB, and a rider whose
  // library predates the last twelve months would otherwise pay for it to draw
  // nothing.
  const countsUp = s.records.some((r) => r.numeric)
  const needsScript = drawChart || countsUp

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

          {s.records.length > 0 && <Records records={s.records} />}

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
            {/*
              DENSER THAN THE BROWSING SURFACES, and the modifier is the whole
              difference. /explore and a public profile are pages whose entire job
              is the list, so a card there can be large. This one hangs under
              eight blocks of stats and can run to twenty-four rides, so it packs
              four or five across instead of three. Ziad's call, 2026-08-25 —
              one component, one extra class, rather than two card designs.
            */}
            <ul class="ride-cards ride-cards--dense">
              {visibleRides.map((r) => (
                <OwnRideCard {...r} />
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
        <FirstRun />
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
      scripts: needsScript
        ? `${drawChart ? `<script src="${asset('/js/uplot.min.js')}"></script>` : ''}<script src="${asset('/js/dashboard.js')}"></script>`
        : undefined,
    }),
  )
})
