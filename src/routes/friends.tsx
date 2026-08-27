// Friendships: the page a rider manages them on, and the five verbs.
//
// SERVER-RENDERED FORMS, NOT THE JSON API — the same choice /trash made and for
// the same reason. Every verb here is one button press with no state to keep in
// sync, and a redirect back to where you pressed it is the whole interaction. A
// fetch layer would be a client module, an error surface and a re-render, all
// to avoid a page load nobody notices.
//
// The rules are in src/friends/policy.ts and the queries in service.ts. Nothing
// in this file decides whether a verb is allowed; it decides what to show.
import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { users } from '../db/schema'
import { currentUser, requireActive, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import {
  acceptFriend,
  blockRider,
  listBlocked,
  listFriends,
  listIncoming,
  listSent,
  removeFriend,
  requestFriend,
  unblockRider,
  type FriendResult,
  type RiderCard,
} from '../friends/service'
import { notifyFriendAccepted, notifyFriendRequest } from '../friends/notify'
import { page } from '../views/layout'
import { FriendForm } from '../views/friend-form'
import type { FriendVerb } from '../friends/policy'

export const friendRoutes = new Hono<AuthEnv>()

// Typed on FriendResult rather than `unknown`, which is what it was: the handler
// now reads `ok` to decide whether to notify, and `unknown` would have made that
// a cast. Every verb in service.ts already returns this shape.
const VERBS: Record<FriendVerb, (viewerId: number, otherId: number) => Promise<FriendResult>> = {
  request: requestFriend,
  accept: acceptFriend,
  remove: removeFriend,
  block: blockRider,
  unblock: unblockRider,
} as const

/**
 * Where to send the rider back to.
 *
 * An open redirect is the classic hole in a "return to where you were" field,
 * so this is an allow-shape rather than a sanitize: one leading slash, no
 * second one (`//evil.example` is a protocol-relative URL a browser follows
 * off-site), no backslash (some browsers normalize it to a slash), and nothing
 * else gets through. Anything that fails lands on /friends, which is always a
 * sensible answer.
 */
function safeBack(raw: unknown): string {
  if (typeof raw !== 'string') return '/friends'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/friends'
  return raw
}

/**
 * Every verb, one handler.
 *
 * The rider is named by HANDLE rather than by id because a handle is what the
 * pages this is submitted from already have, and it is the only rider
 * identifier this app treats as public. An id would work and would be one query
 * shorter; it would also mean putting raw user ids in page source for the first
 * time, for no gain.
 *
 * THE ANSWER IS THE SAME WHETHER IT WORKED OR NOT. Every path redirects, none
 * reports which refusal it hit, and an unknown handle is indistinguishable from
 * a blocked one. That is deliberate and it is the whole reason a block works:
 * a rider who has been blocked must not be able to tell a block from a typo,
 * because a distinguishable refusal is a notification. The cost is that a
 * genuine mistake is silent too, which is the right trade at this size.
 */
friendRoutes.post(
  '/friends/:verb{request|accept|remove|block|unblock}',
  requireActive,
  requireSameOrigin,
  async (c) => {
    const user = currentUser(c)
    const verb = c.req.param('verb') as FriendVerb
    const form = await c.req.parseBody()
    const back = safeBack(form.back)
    const handle = typeof form.handle === 'string' ? form.handle.trim() : ''
    if (!handle) return c.redirect(back, 303)

    const [other] = await db
      .select({ id: users.id })
      .from(users)
      // Same predicate the roster and the public profile use: a pending, blocked
      // or leaving account has no presence, so it cannot be friended either.
      .where(
        sql`lower(${users.username}) = lower(${handle}) and ${users.status} = 'active'
          and ${users.deletionRequestedAt} is null`,
      )
      .limit(1)

    // A rider cannot befriend themselves, and this is where that is caught rather
    // than in pairOf — which throws, and a 500 is a worse answer to a replayed
    // form than doing nothing.
    if (!other || other.id === user.id) return c.redirect(back, 303)

    const result = await VERBS[verb](user.id, other.id)

    // NOTIFY ONLY ON A VERB THAT ACTUALLY HAPPENED, and only for the two that
    // mail at all — see src/friends/notify.ts for why block, unblock and remove
    // send nothing. The ok:true check is the load-bearing half: a refused
    // request may have been refused BECAUSE the other rider blocked this one,
    // and mailing on it would announce the block to the person it was against,
    // which is the one thing this whole subsystem is built to prevent.
    if (result?.ok) {
      if (verb === 'request') notifyFriendRequest(user.id, other.id)
      // Reversed on purpose: the rider who pressed Accept is `user`, and the one
      // who hears about it is the one who asked.
      else if (verb === 'accept') notifyFriendAccepted(user.id, other.id)
    }
    return c.redirect(back, 303)
  },
)

function RiderRow({ rider, children }: { rider: RiderCard; children?: unknown }) {
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

friendRoutes.get('/friends', requireActive, async (c) => {
  const user = currentUser(c)
  const [incoming, friends, sent, blocked] = await Promise.all([
    listIncoming(user.id),
    listFriends(user.id),
    listSent(user.id),
    listBlocked(user.id),
  ])
  const back = '/friends'
  const empty = incoming.length + friends.length + sent.length + blocked.length === 0

  const body = (
    <>
      <h1>Friends</h1>
      <p class="lede">
        Riders you know. A friend can see any ride you set to <strong>Friends</strong>, and take a copy of&nbsp;one.
      </p>

      {/*
        Incoming first, and above the friends list rather than below it: it is
        the only section here that is waiting on the rider to do something.
      */}
      <Section title="Waiting on you" riders={incoming}>
        {(r) => (
          <>
            <FriendForm verb="accept" handle={r.username} label="Accept" back={back} />
            <FriendForm verb="remove" handle={r.username} label="Decline" back={back} variant="btn-sign btn-regulatory" />
          </>
        )}
      </Section>

      <Section title="Your friends" riders={friends}>
        {(r) => <FriendForm verb="remove" handle={r.username} label="Unfriend" back={back} variant="btn-quiet" />}
      </Section>

      <Section title="Asked" note="Sent and not yet answered." riders={sent}>
        {(r) => <FriendForm verb="remove" handle={r.username} label="Withdraw" back={back} variant="btn-quiet" />}
      </Section>

      {/*
        Only riders THIS rider blocked. Nobody is ever shown who blocked them —
        a list that told you would be the notification a block must never be.
      */}
      <Section
        title="Blocked"
        note="They cannot find you on the roster, and neither can you find them."
        riders={blocked}
      >
        {(r) => <FriendForm verb="unblock" handle={r.username} label="Unblock" back={back} variant="btn-quiet" />}
      </Section>

      {empty && (
        <p class="empty">
          Nobody yet. Find someone on the <a href="/riders">riders</a> page and ask.
        </p>
      )}
    </>
  ).toString()

  return c.html(page({ title: 'Friends', user, bodyClass: 'content-page friends-page', body, navKey: 'friends' }))
})
