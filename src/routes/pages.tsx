// Public content pages: FAQ, privacy, terms.
//
// All three are readable signed out. That is a requirement rather than a
// preference for /privacy — Google's OAuth consent screen review fetches it
// without a session, and the consent screen cannot be published past its
// 100-user cap until it resolves.
//
// The FAQ copy is maintained in docs/ops/faq.md, which is the source of truth
// and carries the answers that are not publishable yet. Anything reworded here
// should go back to that file.
import { Hono } from 'hono'
import type { Context } from 'hono'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, routes as routesTable, userProfiles, users } from '../db/schema'
import { page, type NavKey } from '../views/layout'
import { raw } from 'hono/html'
import { content } from '../views/content'
import { rideCards } from '../views/cards'
import { requireActive, type AuthEnv } from '../auth/middleware'
import { allow, clientIp } from '../auth/ratelimit'

export const pageRoutes = new Hono<AuthEnv>()

// Both legal pages carry this. A date matters more than a version number to a
// reader deciding whether anything changed since they last looked.
const EFFECTIVE = '1 August 2026'

// Two spans that used to be written as the years they started, which quietly
// went stale every January. Stated as durations and worked out at render time
// instead. Computed on the server rather than in the browser so there is no
// flash of the wrong number and the page still reads correctly with JS off.
const yearsSince = (year: number): number => new Date().getFullYear() - year
const RIDING_YEARS = yearsSince(1999)
const WEB_YEARS = yearsSince(1993)

// One question, collapsed. <details> rather than a scripted accordion: the
// platform already gets the keyboard, the ARIA and find-in-page right, and a
// reader with no JS still sees every answer.
//
// The id is passed rather than slugged from the question, and that is
// deliberate. These ids are a public contract — other pages link to them (see
// faqLink in layout.ts) and so does anyone who shares a link. Deriving them
// from the wording would silently break every one of those the first time a
// question is rephrased.
const render = (c: Context, title: string, body: string, bodyClass: string, navKey?: NavKey) =>
  c.html(page({ title, user: c.get('user') ?? null, bodyClass, body, navKey }))

// Browsable gallery of public rides.
//
// Paged rather than unbounded: this is the one query in the app whose row count
// grows with the whole userbase rather than with one rider's data, so a bare
// SELECT here is a slow page the day it matters. 24 a page, offset paging —
// keyset would be better under real load but needs a stable tiebreak, and at
// alpha scale offset is honest and simple.
const PER_PAGE = 24

pageRoutes.get('/explore', async (c) => {
  const sort = c.req.query('sort') === 'new' ? 'new' : 'popular'
  const page_ = Math.max(1, Number(c.req.query('page') ?? 1) || 1)
  const offset = (page_ - 1) * PER_PAGE

  const order = sort === 'new' ? [desc(rides.createdAt)] : [desc(rides.viewCount), desc(rides.createdAt)]

  // One extra row answers "is there a next page" without a second count query.
  const rows = await db
    .select({ ride: rides, color: routesTable.color })
    .from(rides)
    .leftJoin(routesTable, and(eq(routesTable.rideId, rides.id), eq(routesTable.position, 0)))
    .where(eq(rides.visibility, 'public'))
    .orderBy(...order)
    .limit(PER_PAGE + 1)
    .offset(offset)

  const hasNext = rows.length > PER_PAGE
  const cards = rows.slice(0, PER_PAGE)

  const Tab = ({ key_, label }: { key_: string; label: string }) => (
    <a class={`explore-tab${sort === key_ ? ' is-on' : ''}`} href={`/explore?sort=${key_}`}>
      {label}
    </a>
  )
  const PageLink = ({ n, label }: { n: number; label: string }) => (
    <a class="explore-page" href={`/explore?sort=${sort}&page=${n}`}>
      {label}
    </a>
  )

  const body = (
    <>
      <h1>Explore</h1>
      <p class="lede">
        Public rides other people have planned. Open one, or clone it as a starting point for your own.
      </p>
      <nav class="explore-tabs">
        <Tab key_="popular" label="Most viewed" />
        <Tab key_="new" label="Newest" />
      </nav>
      {raw(rideCards(cards, sort === 'popular'))}
      <nav class="explore-pager">
        {page_ > 1 && <PageLink n={page_ - 1} label="← Newer page" />}
        {hasNext && <PageLink n={page_ + 1} label="Older page →" />}
      </nav>
    </>
  ).toString()

  return render(c, 'Explore', body, 'content-page explore-page', 'explore')
})

// The rider roster.
//
// Shows exactly what a public profile shows and nothing more — display name and
// handle — because it is the same question asked in bulk. Anything a rider has
// not chosen to publish stays off both. In particular no email, which is what
// separates this from /admin.
//
// Signed-in only. That is not because the data is sensitive (it is all on the
// public profiles already) but because an anonymous bulk list of every account
// is a scraping target with no upside.
pageRoutes.get('/riders', requireActive, async (c) => {
  if (!allow('roster', clientIp(c.req.raw.headers), { max: 60 })) {
    return c.text('Slow down a moment.', 429)
  }

  const q = (c.req.query('q') ?? '').trim().slice(0, 30)

  const rows = await db
    .select({ displayName: users.displayName, username: users.username })
    .from(users)
    .where(
      q
        ? sql`${users.status} = 'active' and ${users.username} is not null
              and (lower(${users.username}) like lower(${'%' + q + '%'})
                   or lower(${users.displayName}) like lower(${'%' + q + '%'}))`
        : sql`${users.status} = 'active' and ${users.username} is not null`,
    )
    .orderBy(users.displayName)
    .limit(200)

  const body = (
    <>
      <h1>Riders</h1>
      <p class="lede">
        Everyone planning here. Names and handles only &mdash; anything else is on a rider's own profile, and only if
        they put it there.
      </p>
      <form class="rider-search" method="get" action="/riders">
        <label class="visually-hidden" for="rider-q">
          Search riders
        </label>
        <input id="rider-q" name="q" type="search" maxlength={30} placeholder="Search by name or handle" value={q} />
        <button class="btn" type="submit">
          Search
        </button>
      </form>
      {rows.length > 0 ? (
        <ul class="rider-list">
          {rows.map((r) => (
            <li>
              <a href={`/@${r.username!}`}>
                <span class="rider-display">{r.displayName}</span>
                <span class="rider-handle">@{r.username!}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p class="empty">Nobody matches that.</p>
      )}
    </>
  ).toString()

  return render(c, 'Riders', body, 'content-page riders-page', 'riders')
})

// Public rider profile at /@handle.
//
// What appears here is the whole privacy decision made visible, so the rule is
// written as one list rather than scattered through the template:
//
//   shown        username, display name, public rides
//   opt-in       last name, and only via share_last_name
//   never        first name, email, home address, coordinates, payment handles
//
// Payment handles are "never" rather than "opt-in" on purpose. They are for
// settling up with people you are actually riding with, which is a relationship
// this app does not model yet (#12). A handle on a public page is a payment
// request open to strangers.
// Hono does not match `/@:username` — a literal prefix in front of a param is
// not something its router handles, and the route simply never fires. A regex
// param does work, and pinning the charset to the username rule means a bad
// handle 404s at the router instead of reaching a query.
pageRoutes.get('/:handle{@[A-Za-z0-9_]{3,30}}', async (c) => {
  const handle = c.req.param('handle').slice(1) // drop the @
  const [row] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      username: users.username,
      status: users.status,
      lastName: userProfiles.lastName,
      shareLastName: userProfiles.shareLastName,
    })
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(sql`lower(${users.username}) = lower(${handle})`)
    .limit(1)

  // A pending or blocked account has no public presence. Same 404 as a handle
  // that was never claimed, so the page cannot be used to probe account states.
  if (!row?.username || row.status !== 'active') return c.text('Not found', 404)

  const cards = await db
    .select({ ride: rides, color: routesTable.color })
    .from(rides)
    .leftJoin(routesTable, and(eq(routesTable.rideId, rides.id), eq(routesTable.position, 0)))
    .where(and(eq(rides.ownerId, row.id), eq(rides.visibility, 'public')))
    .orderBy(desc(rides.viewCount), desc(rides.createdAt))
    .limit(50)

  const surname = row.shareLastName && row.lastName ? ` ${row.lastName}` : ''
  const body = (
    <>
      <h1 class="profile-name">
        {row.displayName}
        {surname}
      </h1>
      <p class="profile-handle">@{row.username}</p>
      <h2>Public rides</h2>
      {raw(rideCards(cards))}
    </>
  ).toString()

  return render(c, row.displayName, body, 'content-page profile-page')
})

pageRoutes.get('/faq', (c) =>
  render(c, 'Questions', content('faq.html', { RIDING_YEARS, WEB_YEARS }), 'content-page faq-page'),
)
pageRoutes.get('/privacy', (c) => render(c, 'Privacy', content('privacy.html', { EFFECTIVE }), 'content-page'))
pageRoutes.get('/terms', (c) => render(c, 'Terms', content('terms.html', { EFFECTIVE }), 'content-page'))
