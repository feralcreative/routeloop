// The Google Maps hand-off (#66) — the page that gets a planned ride into the
// thing the rider actually navigates with.
//
// Most riders are on a phone, not a dedicated unit, so this is the hand-off
// that matters most. Google Maps takes nine waypoints per link, which is the
// constraint everything here is shaped by: a day becomes an ordered series of
// links rather than one, and holding the route to the roads it was planned on
// is paid for in links rather than in points per link.
//
// The number this page refuses to hide is the longest unpinned stretch. Between
// two consecutive points Maps routes however it likes, so a day handed over as
// six stops leaves it twenty-odd miles of freedom at the worst point. Saying so
// is the difference between this and every tool that claims a clean hand-off
// and delivers a route that wandered.
//
// No JavaScript beyond the density links, which are plain hrefs — a page that
// has to work on a phone at a fuel stop with one bar should not need a bundle.
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db/index'
import { rides } from '../db/schema'
import type { AuthEnv } from '../auth/middleware'
import { loadRideForExport } from '../maps/export'
import { linkLabel, routeLinks, type GmapsRouteLinks } from '../maps/gmaps-links'
import { METERS_PER_MILE } from '../maps/kml'
import { page } from '../views/layout'

export const handoffRoutes = new Hono<AuthEnv>()

const fmtMi = (m: number) => (m / METERS_PER_MILE).toFixed(1)

// What the rider is choosing between is not a point count — it is how much room
// the nav app has, against how many times they have to stop and tap. The labels
// say that; the numbers behind them are an implementation detail.
const DENSITIES = [
  { key: 'off', label: 'Stops only', points: 0, note: 'Hands over your stops and lets Maps pick the roads between them' },
  { key: 'light', label: 'Light', points: 25, note: 'Holds the shape of the route with a few extra links' },
  { key: 'tight', label: 'Tight', points: 60, note: 'Pins it down closely, at the cost of more links' },
] as const


const densityOf = (raw: string | undefined): (typeof DENSITIES)[number] =>
  DENSITIES.find((d) => d.key === raw) ?? DENSITIES[1]

handoffRoutes.get('/m/:slug/navigate', async (c) => {
  // c.get('user'), not currentUser(): open to anyone with the link, and
  // currentUser() throws outside an auth gate.
  const user = c.get('user') ?? null
  const slug = c.req.param('slug')

  // The same visibility gate the viewer and the roadbook use. A hand-off page
  // is the ride, rendered differently — it must not be a way around who may
  // see it.
  const [m] = await db.select().from(rides).where(eq(rides.slug, slug)).limit(1)
  const viewable = m && (m.visibility === 'public' || m.visibility === 'unlisted' || (user && user.id === m.ownerId))
  if (!m || !viewable) return c.text('Not found', 404)

  const ride = await loadRideForExport(m.id, { title: m.title, description: m.description })
  if (ride.routes.length === 0) return c.text('Not found', 404)

  const density = densityOf(c.req.query('density'))
  const days: GmapsRouteLinks[] = ride.routes.map((r) => routeLinks(r, { shapingPoints: density.points }))
  const totalLinks = days.reduce((n, d) => n + d.links.length, 0)
  // The worst day is what the rider should be told about, not an average that
  // hides it.
  const gaps = days.map((d) => d.longestGapM).filter((g): g is number => g !== null)
  const worstGapM = gaps.length > 0 ? Math.max(...gaps) : null

  return c.html(
    page({
      title: `${m.title} — navigate`,
      user,
      bodyClass: 'handoff-page',
      body: (
        <>
          <header class="ho-head">
            <h1>{m.title}</h1>
            <p class="ho-summary">
              {totalLinks} {totalLinks === 1 ? 'link' : 'links'} across {ride.routes.length}{' '}
              {ride.routes.length === 1 ? 'day' : 'days'}
            </p>
            <p class="ho-note">
              Open a link and Google Maps starts from where you are. Ride it, and when you arrive open the next one.
            </p>
          </header>

          <section class="ho-density">
            <h2>How tightly to hold the route</h2>
            <ul class="ho-choices">
              {DENSITIES.map((d) => (
                <li class={d.key === density.key ? 'is-on' : ''}>
                  <a href={`?density=${d.key}`} aria-current={d.key === density.key ? 'true' : undefined}>
                    {d.label}
                  </a>
                  <span class="ho-choice-note">{d.note}</span>
                </li>
              ))}
            </ul>
            {worstGapM !== null && (
              <p class="ho-honest">
                Between two points Maps picks its own roads. On the worst stretch of this ride that is{' '}
                <strong>{fmtMi(worstGapM)} miles</strong>
                {density.points > 0 ? ' with these extra points in' : ' with your stops alone'}.
              </p>
            )}
          </section>

          {ride.routes.map((r, dayIndex) => {
            const day = days[dayIndex]
            return (
              <section class="ho-day">
                <h2>{day.title?.trim() || `Day ${dayIndex + 1}`}</h2>
                {day.links.length === 0 ? (
                  <p class="ho-empty">Nothing to navigate — this day has no stops yet.</p>
                ) : (
                  <ol class="ho-links">
                    {day.links.map((link) => (
                      <li>
                        <a class="ho-go" href={link.url} target="_blank" rel="noopener noreferrer">
                          {linkLabel(day, link, dayIndex)}
                        </a>
                        <p class="ho-stops">
                          {link.points.map((p) => p.name || 'Unnamed stop').join(' → ')}
                          {link.shaping > 0 && (
                            <span class="ho-shaping"> · {link.shaping} points holding the route</span>
                          )}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
                {day.skippedPois > 0 && (
                  <p class="ho-skipped">
                    {day.skippedPois} {day.skippedPois === 1 ? 'point of interest is' : 'points of interest are'} not in
                    these links. Routing through one would bend the road to reach it.
                  </p>
                )}
              </section>
            )
          })}

          <section class="ho-caveats">
            <h2>What this does not promise</h2>
            <ul>
              <li>
                Maps carries nine waypoints per link. That is the reason a day is several links, and the reason the
                distance above is not zero.
              </li>
              <li>
                Stops arrive as pins rather than names. The coordinates are exact; Google only shows a name for a place
                it recognises.
              </li>
              <li>
                Your own Maps settings still apply. Avoid highways or avoid tolls will move the route regardless of
                what is in the link.
              </li>
            </ul>
          </section>
        </>
      ).toString(),
    }),
  )
})
