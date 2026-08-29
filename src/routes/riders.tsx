// The riders screen: one page, two tabs — Friends and All riders.
//
// It was two pages. `/friends` carried a rider's own list in four sections and
// `/riders` carried the roster of everyone, and a rider looking for a person had
// to know which of the two to open. Ziad's call, 2026-08-27 (#179).
//
// **THIS REVERSES A RECORDED DECISION, and the old one is struck rather than
// left standing to be re-discovered.** src/views/layout.tsx put Friends under
// the account menu on the grounds that "/riders is the roster — everyone — and
// this is the rider's own list, which is a different question about a different
// set of people". That is true and it is not the point: both are lists of riders
// with buttons beside them, and one place to look beats two correct places.
//
// TWO URLS, ONE PAGE, DELIBERATELY. `/friends` still renders — the friend-request
// and friend-accepted emails both link to it, and a redirect would have been a
// second thing to keep in step with them. It simply opens on the Friends tab.
// `/riders` opens there too; a search, or `?tab=all`, opens the roster.
//
// **MOST ACTIVE IS NOT HERE AND ITS ABSENCE IS A DECISION.** #179 named a third
// tab ranking riders by rides, points and legs. Building it is easy and that is
// not what it costs: the lede on this page promises "names and handles only",
// and a leaderboard publishes every rider's activity to every other rider. That
// is a data-exposure question rather than a UI one, so it is split out rather
// than smuggled in behind a tab.
//
// The friendship VERBS stay in routes/friends.tsx. This file decides what to
// show; that one decides what may be done.
import { Hono } from 'hono'
import type { Context } from 'hono'
import { and, ne, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { users } from '../db/schema'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { allow, clientIp } from '../auth/ratelimit'
import {
  listBlocked,
  listFriends,
  listIncoming,
  listSent,
  notBlockedWith,
  viewsOf,
  type RiderCard,
} from '../friends/service'
import { followingSet } from '../follows/service'
import { FriendActions } from '../views/friend-actions'
import { FriendForm } from '../views/friend-form'
import { FollowForm } from '../views/follow-form'
import { page } from '../views/layout'
import { asset } from '../views/assets'

export const riderRoutes = new Hono<AuthEnv>()

type Tab = 'friends' | 'all'

/** A roster row. Exactly what a public profile shows, which is the whole rule. */
type RosterRow = { id: number; displayName: string; username: string }

function RiderRow({ rider, children }: { rider: { displayName: string; username: string }; children?: unknown }) {
  return (
    <li>
      <a class="friend-who" href={`/@${rider.username}`}>
        <span class="rider-display">{rider.displayName}</span>
        <span class="rider-handle">@{rider.username}</span>
      </a>
      <div class="friend-acts">{children}</div>
    </li>
  )
}

function Section({
  title,
  note,
  riders,
  children,
}: {
  title: string
  note?: string
  riders: RiderCard[]
  children: (r: RiderCard) => unknown
}) {
  if (riders.length === 0) return null
  return (
    <section class="friend-section">
      <h2>
        {title} <span class="friend-count">{riders.length}</span>
      </h2>
      {note && <p class="lede">{note}</p>}
      <ul class="rider-list friend-list">
        {riders.map((r) => (
          <RiderRow rider={r}>{children(r)}</RiderRow>
        ))}
      </ul>
    </section>
  )
}

/**
 * The roster query.
 *
 * Three predicates that are each load-bearing and each easy to leave out:
 * `deletion_requested_at is null` keeps a leaving rider off the list from the
 * moment they ask; `notBlockedWith` drops BOTH halves of every blocked pair,
 * without which the roster is a way around a block and the search box is a way
 * around it by name; and `ne(id, me)` keeps a rider from being offered a friend
 * button beside their own name.
 *
 * Capped at 200 with no pager, which is what the search box is for.
 *
 * It shows exactly what a public profile shows and nothing more — display name
 * and handle — because it is the same question asked in bulk. Anything a rider
 * has not chosen to publish stays off both. In particular no email, which is
 * what separates this from /admin.
 */
async function loadRoster(meId: number, q: string): Promise<RosterRow[]> {
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, username: users.username })
    .from(users)
    .where(
      and(
        q
          ? sql`${users.status} = 'active' and ${users.username} is not null
                and ${users.deletionRequestedAt} is null
                and (lower(${users.username}) like lower(${'%' + q + '%'})
                     or lower(${users.displayName}) like lower(${'%' + q + '%'}))`
          : sql`${users.status} = 'active' and ${users.username} is not null
                and ${users.deletionRequestedAt} is null`,
        notBlockedWith(meId),
        ne(users.id, meId),
      ),
    )
    .orderBy(users.displayName)
    .limit(200)
  return rows.map((r) => ({ id: r.id, displayName: r.displayName, username: r.username! }))
}

/**
 * One render for both URLs.
 *
 * BOTH PANELS ARE IN THE DOM AND `hidden` HIDES ONE, which is the pattern
 * public/js/tabs.js implements and the dashboard already uses — the panels are
 * cheap (four small friend queries and one capped roster), and a tab that
 * fetched would need a loading state, an error state and a client module for a
 * page load nobody notices. It also means the page works with JavaScript off:
 * the strip is buttons, so with no script the first panel shows and the other
 * is reachable by its own URL, which is why both tabs still have one.
 */
async function ridersPage(c: Context<AuthEnv>, tab: Tab) {
  const me = currentUser(c)
  const q = (c.req.query('q') ?? '').trim().slice(0, 30)
  // A search is an answer to "which tab did you want", so it wins over the
  // route's own default. Otherwise a rider searching from the roster would be
  // handed back their friends list with their query still in the box.
  const active: Tab = q
    ? 'all'
    : ((c.req.query('tab') === 'all' ? 'all' : c.req.query('tab') === 'friends' ? 'friends' : tab) as Tab)
  const back = `/riders?tab=${active}${q ? `&q=${encodeURIComponent(q)}` : ''}`

  const [incoming, friends, sent, blocked, roster] = await Promise.all([
    listIncoming(me.id),
    listFriends(me.id),
    listSent(me.id),
    listBlocked(me.id),
    loadRoster(me.id, q),
  ])

  const [views, followed] = await Promise.all([
    viewsOf(
      me.id,
      roster.map((r) => r.id),
    ),
    followingSet(
      me.id,
      roster.map((r) => r.id),
    ),
  ])

  const on = (t: Tab) => t === active
  const noFriends = incoming.length + friends.length + sent.length + blocked.length === 0

  const body = (
    <>
      <h1>Riders</h1>
      <p class="lede">
        Everyone planning here, and the ones you ride with. Names and handles only—anything else is on a rider’s own
        profile, and only if they put it there.
      </p>

      <div class="page-tabs" role="tablist" aria-label="Riders" data-tabs>
        <button
          type="button"
          class={`page-tab${on('friends') ? ' is-active' : ''}`}
          role="tab"
          id="tab-friends"
          aria-controls="panel-friends"
          aria-selected={on('friends') ? 'true' : 'false'}
          tabindex={on('friends') ? undefined : -1}
        >
          Friends <span class="tab-count">{friends.length}</span>
        </button>
        <button
          type="button"
          class={`page-tab${on('all') ? ' is-active' : ''}`}
          role="tab"
          id="tab-all"
          aria-controls="panel-all"
          aria-selected={on('all') ? 'true' : 'false'}
          tabindex={on('all') ? undefined : -1}
        >
          All riders <span class="tab-count">{roster.length}</span>
        </button>
      </div>

      <div
        class="page-tabpanel"
        id="panel-friends"
        role="tabpanel"
        aria-labelledby="tab-friends"
        tabindex={0}
        hidden={!on('friends')}
      >
        <p class="lede">
          A friend can see any ride you set to <strong>Friends</strong>, and take a copy of&nbsp;one.
        </p>

        {/* Incoming first, and above the friends list rather than below it: it
            is the only section here that is waiting on the rider to do
            something. */}
        <Section title="Waiting on you" riders={incoming}>
          {(r) => (
            <>
              <FriendForm verb="accept" handle={r.username} label="Accept" back={back} />
              <FriendForm
                verb="remove"
                handle={r.username}
                label="Decline"
                back={back}
                variant="btn-sign btn-regulatory"
              />
            </>
          )}
        </Section>

        <Section title="Your friends" riders={friends}>
          {(r) => <FriendForm verb="remove" handle={r.username} label="Unfriend" back={back} variant="btn-quiet" />}
        </Section>

        <Section title="Asked" note="Sent and not yet answered." riders={sent}>
          {(r) => <FriendForm verb="remove" handle={r.username} label="Withdraw" back={back} variant="btn-quiet" />}
        </Section>

        {/* Only riders THIS rider blocked. Nobody is ever shown who blocked them
            — a list that told you would be the notification a block must never
            be. */}
        <Section
          title="Blocked"
          note="They cannot find you on the roster, and neither can you find them."
          riders={blocked}
        >
          {(r) => <FriendForm verb="unblock" handle={r.username} label="Unblock" back={back} variant="btn-quiet" />}
        </Section>

        {noFriends && (
          <p class="empty">
            Nobody yet. Find someone under <strong>All riders</strong> and ask.
          </p>
        )}
      </div>

      <div
        class="page-tabpanel"
        id="panel-all"
        role="tabpanel"
        aria-labelledby="tab-all"
        tabindex={0}
        hidden={!on('all')}
      >
        {/* The form GETs /riders and carries the tab with it, so the results
            come back on the tab the rider was looking at rather than on the
            page's default. */}
        <form class="rider-search" method="get" action="/riders">
          <input type="hidden" name="tab" value="all" />
          <label class="visually-hidden" for="rider-q">
            Search riders
          </label>
          <input id="rider-q" name="q" type="search" maxlength={30} placeholder="Search by name or handle" value={q} />
          <button class="btn" type="submit">
            Search
          </button>
        </form>
        {roster.length > 0 ? (
          <ul class="rider-list">
            {roster.map((r) => (
              <RiderRow rider={r}>
                <FriendActions handle={r.username} view={views.get(r.id) ?? 'none'} back={back} />
                <FollowForm handle={r.username} view={followed.has(r.id) ? 'following' : 'none'} back={back} />
              </RiderRow>
            ))}
          </ul>
        ) : (
          <p class="empty">{q ? 'Nobody matches that.' : 'Nobody else here yet.'}</p>
        )}
      </div>
    </>
  ).toString()

  return c.html(
    page({
      title: 'Riders',
      user: me,
      bodyClass: 'content-page riders-page',
      body,
      navKey: 'riders',
      scripts: `<script src="${asset('/js/tabs.js')}" defer></script>`,
    }),
  )
}

// Signed-in only. Not because the data is sensitive — it is all on the public
// profiles already — but because an anonymous bulk list of every account is a
// scraping target with no upside. The rate limit is on the roster half and
// stays where it was.
riderRoutes.get('/riders', requireActive, async (c) => {
  if (!allow('roster', clientIp(c.req.raw.headers), { max: 60 })) {
    return c.text('Slow down a moment.', 429)
  }
  return ridersPage(c, 'friends')
})

// Kept, not redirected: both friendship emails link here.
riderRoutes.get('/friends', requireActive, async (c) => ridersPage(c, 'friends'))
