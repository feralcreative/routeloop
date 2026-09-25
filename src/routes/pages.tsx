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
import { withAnchors } from '../releases/latest'
import type { Context } from 'hono'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, routes as routesTable, userProfiles, users } from '../db/schema'
import { page, wordsOf, type NavKey } from '../views/layout'
import { raw } from 'hono/html'
import { content } from '../views/content'
import { faqTokens } from '../views/faq-tokens'
import { stageTokens } from '../views/stage'
import { rideCards } from '../views/cards'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { allow, clientIp } from '../auth/ratelimit'
import { LIVE_RIDE } from '../trash/service'
import { LISTED_RIDE } from '../access/query'
import { viewOf } from '../friends/service'
import { FriendActions } from '../views/friend-actions'
import { FollowForm } from '../views/follow-form'
import { followViewOf } from '../follows/service'
import { dateFormatFor, unitsFor, volumeFor } from '../views/prefs'
import { wd, wds, type Words } from '../views/vocab'
import { avatarSrc, initialsOf } from '../views/layout'
import { SEP } from '../views/sep'
import { twistScale } from '../views/twist-scale'
import { fmtCount, fmtDistance, fmtHours, rollUpTwist } from '../stats/shape'
import { followCounts } from '../follows/service'
import { bikeLabel, mlToTank } from '../bikes/policy'
import { canSeePaddock, profileDepth, toProfileVisibility, type ProfileVisibility } from '../profiles/policy'
import { friendCount, paddockOf, publicStats, type PublicStats } from '../profiles/service'
import { distanceUnit, type Units } from '../views/units'
import type { DateFormat } from '../views/date-format'
import type { BikeRow } from '../db/schema'

export const pageRoutes = new Hono<AuthEnv>()

// Each legal page carries its own date. A date matters more than a version
// number to a reader deciding whether anything changed since they last looked —
// which is exactly why the two cannot share one: bumping privacy would date-
// stamp a change to terms that never happened, and the privacy page promises
// the date only moves when something actually moved.
const PRIVACY_EFFECTIVE = '17 September 2026'
const TERMS_EFFECTIVE = '1 August 2026'

// Two spans that used to be written as the years they started, which quietly
// went stale every January. Stated as durations and worked out at render time
// instead. Computed on the server rather than in the browser so there is no
// flash of the wrong number and the page still reads correctly with JS off.
// MOVED TO views/faq-tokens.ts, because faqLink() reads a single answer out of
// the same file for its popover (#268) and `content()` throws on an unsupplied
// token. Two copies of the years would go stale independently, which is the
// thing stating them as durations was meant to stop.

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
// SELECT here is a slow page the route it matters. 24 a page, offset paging —
// keyset would be better under real load but needs a stable tiebreak, and at
// alpha scale offset is honest and simple.
const PER_PAGE = 24

pageRoutes.get('/explore', async (c) => {
  const sort = c.req.query('sort') === 'new' ? 'new' : 'popular'
  const page_ = Math.max(1, Number(c.req.query('page') ?? 1) || 1)
  const offset = (page_ - 1) * PER_PAGE

  const order = sort === 'new' ? [desc(rides.createdAt)] : [desc(rides.viewCount), desc(rides.createdAt)]

  // One extra row answers "is there a next page" without a second count query.
  // The owner join drops a leaving rider's rides from the listing the moment
  // they hit Delete Me. It is an inner join on users rather than a filter on the
  // ride, because nothing on a rides row knows anything about its owner — this
  // query never looked at users at all before.
  const rows = await db
    .select({ ride: rides, color: routesTable.color })
    .from(rides)
    .innerJoin(users, eq(users.id, rides.ownerId))
    .leftJoin(routesTable, and(eq(routesTable.rideId, rides.id), eq(routesTable.position, 0)))
    // LISTED_RIDE, not `visibility = 'public'` written out: /explore is a list
    // nobody asked for by name, and which levels belong in one is isListed()'s
    // call in src/access/policy.ts, not this query's. `friends` is deliberately
    // NOT among them — a friend may view such a ride, but surfacing it here
    // would publish it on the owner's behalf.
    .where(and(LISTED_RIDE, isNull(users.deletionRequestedAt), LIVE_RIDE))
    .orderBy(...order)
    .limit(PER_PAGE + 1)
    .offset(offset)

  const hasNext = rows.length > PER_PAGE
  const cards = rows.slice(0, PER_PAGE)
  const units = await unitsFor(c)
  const w = wordsOf({ user: c.get('user') ?? null })

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
        Public {wds(w, 'journey')} other people have planned. Open one, or clone it as a starting point for your own.
      </p>
      <nav class="explore-tabs">
        <Tab key_="popular" label="Most viewed" />
        <Tab key_="new" label="Newest" />
      </nav>
      {raw(rideCards(cards, sort === 'popular', { units, words: w }))}
      <nav class="explore-pager">
        {page_ > 1 && <PageLink n={page_ - 1} label="← Newer page" />}
        {hasNext && <PageLink n={page_ + 1} label="Older page →" />}
      </nav>
    </>
  ).toString()

  return render(c, 'Explore', body, 'content-page explore-page', 'explore')
})

// The rider roster moved to routes/riders.tsx on 2026-08-29 (#179), where it is
// one tab of a two-tab screen alongside a rider's own friends list. Nothing of
// it stayed here — including the query, whose three predicates (a leaving rider
// dropped, both halves of every blocked pair dropped, and the viewer themselves
// dropped) are load-bearing and are documented where they now live.

// Public rider profile at /@handle.
//
// The privacy rule, as one list:
//
//   always       username, display name (last name only via share_last_name)
//   by depth     avatar, bio, joined month, counts, stats, public rides
//   opt-in       socials (share_socials), paddock (share_paddock)
//   never        first name, email, addresses, coordinates, phone, payment handles
//
// How much a viewer gets is `profileDepth()` in src/profiles/policy.ts. A minimal
// page is name and handle only: friend emails and rosters link here, so a hidden
// rider still has somewhere to be added from.
//
// Hono does not match `/@:username`, so this is a regex param pinned to the
// username charset: a bad handle 404s at the router.
pageRoutes.get('/:handle{@[A-Za-z0-9_]{3,30}}', async (c) => {
  const handle = c.req.param('handle').slice(1) // drop the @
  const [row] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      username: users.username,
      status: users.status,
      deletionRequestedAt: users.deletionRequestedAt,
      isGuide: users.isGuide,
      avatarUrl: users.avatarUrl,
      createdAt: users.createdAt,
      avatarBytes: userProfiles.avatarBytes,
      lastName: userProfiles.lastName,
      shareLastName: userProfiles.shareLastName,
      shareSocials: userProfiles.shareSocials,
      sharePaddock: userProfiles.sharePaddock,
      profileVisibility: userProfiles.profileVisibility,
      bio: userProfiles.bio,
      instagram: userProfiles.instagram,
      facebook: userProfiles.facebook,
      youtube: userProfiles.youtube,
      strava: userProfiles.strava,
    })
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(sql`lower(${users.username}) = lower(${handle})`)
    .limit(1)

  // Pending, blocked, leaving and tour-guide accounts all get the same 404 as a
  // handle never claimed, so the page cannot probe account states.
  if (!row?.username || row.status !== 'active' || row.deletionRequestedAt || row.isGuide) {
    return c.text('Not found', 404)
  }

  const viewer = c.get('user') ?? null
  const isSelf = viewer?.id === row.id
  const visibility = toProfileVisibility(row.profileVisibility)
  const depth = profileDepth(visibility, row.id, viewer)
  const full = depth === 'full'
  const showPaddock = full && canSeePaddock(visibility, row.sharePaddock ?? false, row.id, viewer)

  // Signed-in, active, and not yourself. Friend and follow are two independent
  // relationships, so two lookups.
  const canAsk = viewer !== null && viewer.status === 'active' && !isSelf
  const [view, followView_] = canAsk
    ? await Promise.all([viewOf(viewer.id, row.id), followViewOf(viewer.id, row.id)])
    : (['none', 'none'] as const)

  const [cards, stats, friends, follows, bikes, units, dateFormat, volume] = full
    ? await Promise.all([
        db
          .select({ ride: rides, color: routesTable.color })
          .from(rides)
          .leftJoin(routesTable, and(eq(routesTable.rideId, rides.id), eq(routesTable.position, 0)))
          // LISTED_RIDE, as on /explore: an unlisted or friends-only ride has no
          // business in a list.
          .where(and(eq(rides.ownerId, row.id), LISTED_RIDE, LIVE_RIDE))
          .orderBy(desc(rides.viewCount), desc(rides.createdAt))
          .limit(50),
        publicStats(row.id),
        friendCount(row.id),
        followCounts(row.id),
        showPaddock ? paddockOf(row.id) : Promise.resolve([]),
        unitsFor(c),
        dateFormatFor(c),
        volumeFor(c),
      ])
    : [[], null, 0, null, [], 'imperial' as const, 'en-US' as const, 'gallons' as const]

  const w = wordsOf({ user: viewer })
  const surname = row.shareLastName && row.lastName ? ` ${row.lastName}` : ''
  const name = `${row.displayName}${surname}`
  const face = full ? avatarSrc({ id: row.id, avatarUrl: row.avatarUrl, avatarBytes: row.avatarBytes ?? 0 }) : null
  const liters = volume === 'liters'

  const body = (
    <>
      {isSelf && (
        <p class="notice profile-self">
          {SELF_NOTE[visibility]} <a href="/profile#public-page">Change who can see&nbsp;it</a>
        </p>
      )}
      <header class="profile-head">
        {full &&
          (face ? (
            <img class="rider-face profile-face" src={face} alt="" />
          ) : (
            <span class="rider-face profile-face is-initials" aria-hidden="true">
              {initialsOf(row.displayName) || '?'}
            </span>
          ))}
        <div class="profile-who">
          <h1 class="profile-name">{name}</h1>
          <p class="profile-handle">@{row.username}</p>
          {full && (
            <p class="profile-meta">
              Planning since {fmtMonthYear(row.createdAt, dateFormat)}
              {SEP}
              {plural(friends, 'friend')}
              {SEP}
              {plural(follows?.followers ?? 0, 'follower')}
            </p>
          )}
          {canAsk && (
            <div class="profile-acts friend-acts">
              <FriendActions handle={row.username} view={view} back={`/@${row.username}`} />
              <FollowForm handle={row.username} view={followView_} back={`/@${row.username}`} />
            </div>
          )}
        </div>
      </header>

      {full && row.bio && <p class="profile-bio">{row.bio}</p>}
      {full && row.shareSocials && <SocialLinks row={row} />}

      {full && stats && stats.rides > 0 && <PublicStatTiles stats={stats} units={units} words={w} />}

      {showPaddock && bikes.length > 0 && (
        <section class="profile-section">
          <h2>Paddock</h2>
          <ul class="profile-bikes">
            {bikes.map((b) => (
              <BikeCard bike={b} units={units} liters={liters} />
            ))}
          </ul>
        </section>
      )}

      {full && (
        <section class="profile-section">
          <h2>Public {wds(w, 'journey')}</h2>
          {cards.length > 0 ? (
            raw(rideCards(cards, false, { units, words: w }))
          ) : (
            <p class="field-hint">Nothing public&nbsp;yet.</p>
          )}
        </section>
      )}
    </>
  ).toString()

  return render(c, name, body, `content-page profile-page${full ? '' : ' is-minimal'}`)
})

const SELF_NOTE: Record<ProfileVisibility, string> = {
  public: 'This is your page as anyone sees it, signed in or not.',
  members: 'This is your page as signed-in riders see it. Anyone else gets your name and handle only.',
  hidden: 'Your page is hidden. Everyone else sees your name and handle only.',
}

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

const fmtMonthYear = (d: Date, f: DateFormat) => d.toLocaleDateString(f, { month: 'long', year: 'numeric', timeZone: 'UTC' })

function PublicStatTiles({ stats, units, words }: { stats: PublicStats; units: Units; words: Words }) {
  const twist = rollUpTwist(stats.twist, units)
  return (
    <section class="profile-section">
      <h2>By the numbers</h2>
      <ul class="stat-tiles">
        <li class="stat-tile">
          <span class="stat-head">
            <span class="stat-value">{fmtCount(stats.rides)}</span>
            <span class="stat-label">public {stats.rides === 1 ? wd(words, 'journey') : wds(words, 'journey')}</span>
          </span>
        </li>
        <li class="stat-tile">
          <span class="stat-head">
            <span class="stat-value">{fmtDistance(stats.distanceM, units)}</span>
            <span class="stat-label">{distanceUnit(units)} planned</span>
          </span>
        </li>
        <li class="stat-tile">
          <span class="stat-head">
            <span class="stat-value">{fmtHours(stats.durationS)}</span>
            <span class="stat-label">hours of riding</span>
          </span>
        </li>
        {twist && (
          <li class="stat-tile" title={`${twist.dpm} ${twist.unit}`}>
            <span class="stat-label">Twistiness</span>
            {raw(twistScale(twist.rank, twist.label))}
          </li>
        )}
      </ul>
    </section>
  )
}

function BikeCard({ bike, units, liters }: { bike: BikeRow; units: Units; liters: boolean }) {
  const label = bikeLabel(bike)
  const spec = [bike.year ? String(bike.year) : null, bike.make, bike.model].filter(Boolean).join(' ')
  const facts = [
    bike.fuelType === 'electric' ? 'Electric' : null,
    bike.usableRangeM ? `${fmtDistance(bike.usableRangeM, units)} ${distanceUnit(units)} range` : null,
    bike.tankMl && bike.fuelType !== 'electric'
      ? `${mlToTank(bike.tankMl, liters)} ${liters ? 'L' : 'gal'} tank`
      : null,
  ].filter(Boolean)
  return (
    <li class="profile-bike">
      {bike.photoHash ? (
        <img
          class="profile-bike-photo"
          src={`/bikes/${bike.id}/photo?v=${bike.photoHash}`}
          alt={label}
          loading="lazy"
        />
      ) : (
        <span class="profile-bike-photo is-empty" aria-hidden="true"></span>
      )}
      <span class="profile-bike-name">{label}</span>
      {bike.nickname && spec && <span class="profile-bike-spec">{spec}</span>}
      {facts.length > 0 && <span class="profile-bike-facts">{facts.join(SEP)}</span>}
    </li>
  )
}

/**
 * The four social links, composed from stored HANDLES.
 *
 * **THE URL IS BUILT HERE AND NEVER STORED, WHICH IS THE WHOLE SECURITY DESIGN.**
 * A rider-supplied `href` would need a scheme allow-list — `javascript:` in an
 * attribute is stored XSS and JSX escaping does not stop it. A handle cannot
 * carry a scheme, so there is no allow-list to forget: the origin is a literal
 * in this file and only the last path segment comes from the rider.
 *
 * `rel="noopener noreferrer"` on every one, and `nofollow` besides — a public
 * profile with a rider-controlled outbound link is a link farm the moment this
 * app is worth spamming.
 */
function SocialLinks({
  row,
}: {
  row: { instagram: string | null; facebook: string | null; youtube: string | null; strava: string | null }
}) {
  const links = [
    {
      label: 'Instagram',
      handle: row.instagram,
      href: (h: string) => `https://instagram.com/${encodeURIComponent(h)}`,
    },
    { label: 'Facebook', handle: row.facebook, href: (h: string) => `https://facebook.com/${encodeURIComponent(h)}` },
    { label: 'YouTube', handle: row.youtube, href: (h: string) => `https://youtube.com/@${encodeURIComponent(h)}` },
    {
      label: 'Strava',
      handle: row.strava,
      href: (h: string) => `https://strava.com/athletes/${encodeURIComponent(h)}`,
    },
  ].filter((l) => l.handle)

  if (links.length === 0) return null

  return (
    <ul class="profile-links">
      {links.map((l) => (
        <li>
          <a href={l.href(l.handle as string)} rel="noopener noreferrer nofollow" target="_blank">
            {l.label}
          </a>
        </li>
      ))}
    </ul>
  )
}

pageRoutes.get('/faq', (c) => render(c, 'Questions', content('faq.html', faqTokens()), 'content-page faq-page'))
// The same copy in two places, from one file. The page is the no-JavaScript path and
// the linkable URL; the fragment is what the modal fetches on first open.
// **THE ANCHORS ARE INJECTED, NOT AUTHORED.** #288's notifications link to
// `/release-notes#<id>`, and that id has to equal `releaseId(heading)` exactly or the
// link lands nowhere. Doing it here also leaves the authoring contract at the top of
// the file true as written.
pageRoutes.get('/release-notes', (c) =>
  render(c, 'What’s new', withAnchors(content('release-notes.html')), 'content-page release-notes-page'),
)
pageRoutes.get('/api/release-notes', (c) => c.html(withAnchors(content('release-notes.html'))))
pageRoutes.get('/privacy', (c) =>
  render(c, 'Privacy', content('privacy.html', { EFFECTIVE: PRIVACY_EFFECTIVE }), 'content-page'),
)
pageRoutes.get('/terms', (c) =>
  render(c, 'Terms', content('terms.html', { EFFECTIVE: TERMS_EFFECTIVE, ...stageTokens() }), 'content-page'),
)
