// `/rides`: every ride a rider can ride, in five tabs — theirs, their friends',
// the riders they follow, everyone's, and the recycle bin.
//
// THIS URL HAS MOVED THREE TIMES AND THE THIRD MOVE UNDID THE SECOND. It was
// `dashboard.tsx` at `/dashboard` until 2026-08-15, when it became `/rides` on
// the grounds that the old URL described the page as a dashboard while the
// actual dashboard was `/`. That was true, and it fixed the wrong half of the
// problem: the app still had two doors onto a rider's own rides — `/` carrying
// a six-ride "Picking up where you left off" strip, and this page carrying the
// full list. Folded into `/` on 2026-08-24, Ziad's call, answering the third
// of #103's four open questions: one door, the full list under the stats.
//
// BACK OUT TO ITS OWN PAGE ON 2026-09-15, Ziad's call, and the phone is why.
// The job on a phone is to look up a planned ride and load it, and a list
// hanging under eight blocks of stats is not a page a thumb can use — and it
// is the page the installed app opens on (`start_url` in the manifest). The
// dashboard keeps the numbers and one link here; the nav's Rides group has
// "Your rides" first again. The old "one door" reasoning is struck rather than
// left to be rediscovered: there are two doors because there are two pages,
// and the Dash link names the other one.
//
// The markup is the dashboard's Rides block moved whole, comments included,
// with two changes: the joined rides are INSIDE Your rides rather than above
// the strip, and the tab count is a count query rather than `loadStats` —
// this page draws no stat and pays for none.
import { Hono } from 'hono'
import { raw } from 'hono/html'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, routes as routesTable } from '../db/schema'
import { currentUser, requireActive, type AuthEnv } from '../auth/middleware'
import { page, wordsOf } from '../views/layout'
import { asset } from '../views/assets'
import { rideCards } from '../views/cards'
import { JoinedRideCard, OwnRideCard } from '../views/ride-lists'
import { RIDE_CEILING, RIDE_PAGE, pageOwned, rideTabOf } from '../rides/tabs'
import { followingRides, friendsRides, publicRides } from '../access/query'
import { LIVE_RIDE, listBinnedRides } from '../trash/service'
import { binRidesHtml } from '../views/bin'
import { dateFormatFor, unitsFor } from '../views/prefs'
import { ridesImOn } from '../members/service'
import { Wds, aWd, cap, wds, type Words } from '../views/vocab'

export const ridesRoutes = new Hono<AuthEnv>()

// The empty state of the first tab, for a rider on no rides at all. The
// dashboard's FirstRun panel says the same thing at length and is NOT repeated
// here: this is the list page, and what an empty list needs is the two doors
// out of it — the builder and the importer — rather than a second tour of the
// app. The other four tabs render whatever they hold; a rider with no rides
// of their own can still have friends with some.
function Nothing({ w }: { w: Words }) {
  return (
    <div class="rides-empty">
      <p class="empty">Nothing planned yet.</p>
      <p class="rides-empty-doors">
        <a class="btn" href="/builder">
          Plan {aWd(w, 'journey')}
        </a>
        <a class="linkbtn" href="/import">
          Import a file
        </a>
      </p>
    </div>
  )
}

ridesRoutes.get('/rides', requireActive, async (c) => {
  const user = currentUser(c)

  // `?show=all` lifts the cap. Anything else, including a missing parameter and
  // any value a bot invents, reads as "capped" — the safe answer is the bounded
  // query, so this tests for the one string rather than for truthiness. It was
  // `?rides=all` on the dashboard, where the word said which list; here the
  // page is the list, and `/rides?rides=all` reads as a stutter. Nothing links
  // it from mail, so the old spelling has no bookmarks to keep.
  const showAll = c.req.query('show') === 'all'

  // Which tab opens (#343): `/trash` lands here with `?tab=bin`. The rule is
  // rideTabOf's, in src/rides/tabs.ts.
  const tab = rideTabOf(c.req.query('tab'))
  const binError = c.req.query('error')

  const [owned, [{ n: ownedCount }], joined, friendly, publik, feed, binned, dateFormat, units] = await Promise.all([
    db
      .select({ ride: rides, color: routesTable.color })
      .from(rides)
      .leftJoin(routesTable, and(eq(routesTable.rideId, rides.id), eq(routesTable.position, 0)))
      .where(and(eq(rides.ownerId, user.id), LIVE_RIDE))
      // updatedAt, not createdAt. The old /rides sorted by creation because it
      // was a catalog; this list has to do that job AND the "pick up where you
      // left off" one the dashboard strip used to do, and the ride you touched
      // last is the answer to the second.
      .orderBy(desc(rides.updatedAt))
      // One more than the cap, which is what tells us there IS more without a
      // second count query. The extra row is sliced off before rendering.
      //
      // `?show=all` raises the ceiling rather than removing it. The list this
      // replaced had no limit at all and that was the defect, so "all" must not
      // reintroduce it — a rider with ten thousand rides gets a bounded page and
      // a query that finishes.
      .limit(showAll ? RIDE_CEILING : RIDE_PAGE + 1),
    // THE COUNT ON THE TAB. The dashboard read it off loadStats(), which this
    // page does not run — eight aggregates to label one tab — so it is the one
    // count query the "one more than the cap" trick above exists to avoid, and
    // it is worth it here because the number is on screen whether or not the
    // list is capped.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(rides)
      .where(and(eq(rides.ownerId, user.id), LIVE_RIDE)),
    // THE RIDES SOMEBODY ELSE PUT THIS RIDER ON. Without this a membership is
    // unfindable: a member can open a private ride they were added to, but only
    // if they were separately handed the link — which makes the invite do
    // nothing the link was not already doing. Owned rides are excluded inside
    // ridesImOn, because they are the list above them.
    ridesImOn(user.id),
    // THE TWO TABS BESIDE THE RIDER'S OWN. Both are bounded lists rather than
    // the whole corpus — this is a page of tabs, not /explore — and both
    // exclude the viewer's own rides, which are the first tab.
    //
    // friendsRides is the viewer-dependent list src/access/query.ts's header
    // spent a paragraph saying nothing needed yet. Its rule is isFriendListed()
    // and test/access-lists.test.ts pins it against canView().
    friendsRides(user.id, RIDE_PAGE),
    publicRides(user.id, RIDE_PAGE),
    // THE FEED (#34). Public rides by riders this one follows — LISTED rides
    // only, because following grants no visibility: it is one-way and never
    // agreed to, so it cannot open anything a stranger could not already open.
    // See the note on the `follows` table in src/db/schema.ts.
    followingRides(user.id, RIDE_PAGE),
    // THE BIN'S RIDES (#343): the fifth tab. Owner-only by construction, soonest
    // purge first, and the places half of the bin lives on /places.
    listBinnedRides(user.id),
    dateFormatFor(c),
    unitsFor(c),
  ])

  const { visible: visibleRides, hasMore } = pageOwned(owned, showAll)
  // What the app calls things (#321) — the rider's own preset, since this
  // page is about no one ride.
  const w = wordsOf({ user })

  const body = (
    <>
      <h1>Your {wds(w, 'journey')}</h1>
      {/*
      THREE TABS: the rider's own rides, their friends', and everyone's.
      Ziad's call, 2026-08-26. One strip rather than three stacked sections
      because they answer the same question about three audiences, and a
      page that ran all three at full length would be one nobody reaches
      the bottom of.

      RIDING WITH OTHERS IS INSIDE THE FIRST ONE since 2026-09-15 — see the
      note on that panel.

      The behavior is public/js/tabs.js, shared with the builder's panel.
      `data-tabs` is the auto-wiring hook, so this strip needs no code of
      its own. It also means the page WORKS WITH JAVASCRIPT OFF, just not
      as a tab strip: every panel below is rendered, and only the two that
      are `hidden` are hidden — a rider with no JS sees the first list and
      can still reach /explore and /friends from the nav. That is the same
      bargain the dashboard's chart makes.
    */}
      <section class="rides-section">
        <div class="page-tabs" role="tablist" aria-label="Rides" data-tabs>
          <button
            type="button"
            class={`page-tab${tab === 'mine' ? ' is-active' : ''}`}
            role="tab"
            id="tab-mine"
            aria-controls="rides-mine"
            aria-selected={tab === 'mine' ? 'true' : 'false'}
            tabindex={tab === 'mine' ? undefined : -1}
          >
            Your {wds(w, 'journey')} <span class="tab-count">{ownedCount + joined.length}</span>
          </button>
          <button
            type="button"
            class={`page-tab${tab === 'friends' ? ' is-active' : ''}`}
            role="tab"
            id="tab-friends"
            data-tip="rides-friends"
            title="Rides your friends have shared"
            aria-controls="rides-friends"
            aria-selected={tab === 'friends' ? 'true' : 'false'}
            tabindex={tab === 'friends' ? undefined : -1}
          >
            Friends <span class="tab-count">{friendly.length}</span>
          </button>
          {/*
          FOLLOWING SITS BEFORE PUBLIC, because the strip runs from the
          narrowest audience to the widest — yours, your friends', the
          riders you chose to watch, then everyone. Following after Public
          would put the general case in the middle of two specific ones.
        */}
          <button
            type="button"
            class={`page-tab${tab === 'following' ? ' is-active' : ''}`}
            role="tab"
            id="tab-following"
            data-tip="rides-following"
            title={`${Wds(w, 'journey')} from ${wds(w, 'person')} you follow`}
            aria-controls="rides-following"
            aria-selected={tab === 'following' ? 'true' : 'false'}
            tabindex={tab === 'following' ? undefined : -1}
          >
            Following <span class="tab-count">{feed.length}</span>
          </button>
          <button
            type="button"
            class={`page-tab${tab === 'public' ? ' is-active' : ''}`}
            role="tab"
            id="tab-public"
            aria-controls="rides-public"
            aria-selected={tab === 'public' ? 'true' : 'false'}
            tabindex={tab === 'public' ? undefined : -1}
          >
            Public <span class="tab-count">{publik.length}</span>
          </button>
          {/*
          THE BIN IS THE LAST TAB (#343). Ziad's call, 2026-09-13: the bin
          is where a ride goes, so it belongs beside the lists it left.
          The count shows even at zero — an empty bin reading 0 is the
          answer to "did that delete work", where a tab that vanishes is
          a question.
        */}
          <button
            type="button"
            class={`page-tab${tab === 'bin' ? ' is-active' : ''}`}
            role="tab"
            id="tab-bin"
            aria-controls="rides-bin"
            aria-selected={tab === 'bin' ? 'true' : 'false'}
            tabindex={tab === 'bin' ? undefined : -1}
          >
            Recycle bin <span class="tab-count">{binned.length}</span>
          </button>
        </div>

        {/*
        ONE LIST OF EVERY RIDE THIS RIDER CAN RIDE: their own first, then
        the ones somebody else put them on. Ziad's call, 2026-09-15. On
        the dashboard the joined rides sat ABOVE the strip as their own
        section — a different question, membership rather than
        visibility — and that reasoning is struck: on a phone the list a
        rider opens is "what can I ride", and two lists answering it is
        one more thing to scroll past. The two cards stay two cards, and
        the card says which is which: OwnRideCard carries a visibility
        pill and an edit link, JoinedRideCard the RSVP and who owns it.

        The cap applies to the OWNED rides only. The joined list is short
        by construction — somebody has to add you — and paging it would
        hide the one carrying news.
      */}
        <div
          class={`page-tabpanel${tab === 'mine' ? ' is-active' : ''}`}
          role="tabpanel"
          id="rides-mine"
          aria-labelledby="tab-mine"
          tabindex={0}
          hidden={tab !== 'mine'}
        >
          {visibleRides.length === 0 && joined.length === 0 ? (
            <Nothing w={w} />
          ) : (
            <ul class="ride-cards ride-cards--dense">
              {visibleRides.map((r) => (
                <OwnRideCard {...r} units={units} />
              ))}
              {joined.map((j) => (
                <JoinedRideCard ride={j.ride} rsvp={j.rsvp} owner={j.owner} units={units} />
              ))}
            </ul>
          )}
          {hasMore && (
            <p>
              <a class="linkbtn" href="/rides?show=all">
                Show all {ownedCount}
              </a>
            </p>
          )}
        </div>

        {/*
        Rides a friend set to Friends — isFriendListed() in
        src/access/policy.ts, which is the rule, and NOT their public ones:
        those are the next tab, and a ride in both reads as a duplicate
        rather than as two answers.
      */}
        <div
          class={`page-tabpanel${tab === 'friends' ? ' is-active' : ''}`}
          role="tabpanel"
          id="rides-friends"
          aria-labelledby="tab-friends"
          tabindex={0}
          hidden={tab !== 'friends'}
        >
          {raw(
            rideCards(friendly, false, {
              units,
              dense: true,
              empty: `Nothing here yet. ${cap(aWd(w, 'journey'))} shows up when a friend sets one to Friends.`,
            }),
          )}
        </div>

        {/*
        Every row here is a ride /explore would also show — following is
        not a key to anything. The empty state names the verb rather than
        the tab, because a rider whose feed is empty has almost always not
        followed anybody rather than followed quiet people.
      */}
        <div
          class={`page-tabpanel${tab === 'following' ? ' is-active' : ''}`}
          role="tabpanel"
          id="rides-following"
          aria-labelledby="tab-following"
          tabindex={0}
          hidden={tab !== 'following'}
        >
          {raw(
            rideCards(feed, false, {
              units,
              dense: true,
              empty: `Nothing here yet. Follow ${aWd(w, 'person')} and their public ${wds(w, 'journey')} show up in this tab.`,
            }),
          )}
          <p>
            <a class="linkbtn" href="/riders">
              Find {wds(w, 'person')} to follow
            </a>
          </p>
        </div>

        {/*
        Ordered by update rather than by view count, because this strip is
        "what is happening" and /explore is still the surface that ranks —
        which is what the link below it is for.
      */}
        <div
          class={`page-tabpanel${tab === 'public' ? ' is-active' : ''}`}
          role="tabpanel"
          id="rides-public"
          aria-labelledby="tab-public"
          tabindex={0}
          hidden={tab !== 'public'}
        >
          {raw(
            rideCards(publik, false, {
              units,
              dense: true,
              empty: `Nobody else has published ${aWd(w, 'journey')} yet.`,
            }),
          )}
          <p>
            <a class="linkbtn" href="/explore">
              Explore all public {wds(w, 'journey')}
            </a>
          </p>
        </div>

        <div
          class={`page-tabpanel${tab === 'bin' ? ' is-active' : ''}`}
          role="tabpanel"
          id="rides-bin"
          aria-labelledby="tab-bin"
          tabindex={0}
          hidden={tab !== 'bin'}
        >
          {raw(binRidesHtml(binned, dateFormat, binError, w))}
        </div>
      </section>
    </>
  ).toString()

  return c.html(
    page({
      title: `Your ${wds(w, 'journey')}`,
      user,
      navKey: 'rides',
      // NOT `content-page`: that caps the page at a 44rem reading measure, which
      // is right for prose and wrong for a grid of cards — the dashboard drew
      // this same grid at the full $page-max, and three columns of thumbnails
      // in a 44rem column is a strip down the middle of a wide screen.
      bodyClass: 'rides-page',
      body,
      // Both UNCONDITIONAL. tabs.js because the strip is always here; rides.js
      // because the in-place binning is the page's job — on the dashboard it
      // rode along with dashboard.js, which shipped only when there was a chart
      // to draw or a record to count up, so a rider with neither got a Delete
      // that navigated. That gate was about the chart and never about this.
      scripts: `<script src="${asset('/js/tabs.js')}" defer></script>\n  <script src="${asset('/js/rides.js')}" defer></script>`,
    }),
  )
})
