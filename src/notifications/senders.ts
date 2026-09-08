// One function per event, and the recipient lookups they share.
//
// **THIS IS ONE FILE WHERE THE PRECEDENT IS ONE PER MODULE, AND THE DEPARTURE IS
// DELIBERATE.** src/auth/notify.ts, src/feedback/notify.ts and
// src/friends/notify.ts are each a module's own notifier, which was right when
// there were three of them and each read a different table for a different
// reason. Ten more would have been ten copies of the same four helpers — who
// owns this ride, who is on its roster, what is this ride called, what date
// format does the recipient read — and the copies drift. The catalog is already
// one list; the senders that satisfy it are one file beside it.
//
// **EVERY FUNCTION HERE IS `void` AND NEVER THROWS**, because `notify()` is, and
// because the rule they all inherit is that a notification failing must not turn
// a successful button press into an error page. They are also all
// **CALL-AFTER-COMMIT**: each does its own reads, and an SMTP round trip inside
// the caller's transaction holds a pooled connection open for a network call.
//
// **THE THREE OLDER NOTIFIERS WERE NOT MOVED HERE.** friend-request,
// friend-accepted and feedback-status now go THROUGH `notify()` so a rider can
// turn them off, but their recipient logic stayed where it was — the friendship
// pair lookup and `canReplyTo` are rules about friendships and reports rather
// than about notification, and hauling them in would put two unrelated domains
// in this file to save nothing.
import { and, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../db/index'
import { rideMembers, rides, userProfiles, users } from '../db/schema'
import type { Rsvp } from '../db/schema'
import { RSVP_LABELS } from '../members/policy'
import { fmtDateNumeric, toDateFormat, type DateFormat } from '../views/date-format'
import { newFollowerEmail } from '../emails/new-follower'
import { quotaFullEmail } from '../emails/quota-full'
import { rideAddedEmail } from '../emails/ride-added'
import { rideCommentEmail } from '../emails/ride-comment'
import { ridePurgeSoonEmail } from '../emails/ride-purge-soon'
import { rideRsvpEmail } from '../emails/ride-rsvp'
import { rideSuggestionEmail } from '../emails/ride-suggestion'
import { suggestionDecidedEmail } from '../emails/suggestion-decided'
import { accountPurgeSoonEmail } from '../emails/account-purge-soon'
import { voteResolvedEmail } from '../emails/vote-resolved'
import { notify, notifyMany } from './service'

// ── The shared lookups ───────────────────────────────────────────────────────

type RideCard = { id: number; title: string; slug: string; ownerId: number }

/** Title and slug, which every ride notification needs and none of the callers
 *  has in hand — most of them hold an id from a route param. */
async function rideCard(rideId: number): Promise<RideCard | null> {
  const [r] = await db
    .select({ id: rides.id, title: rides.title, slug: rides.slug, ownerId: rides.ownerId })
    .from(rides)
    .where(eq(rides.id, rideId))
    .limit(1)
  return r ?? null
}

/**
 * Everyone who can decide things about this ride, minus one person.
 *
 * **IT IS THE `owner` ROLE AND NOT `rides.owner_id`, BECAUSE CO-OWNERS EXIST.**
 * More than one member may hold `role = 'owner'`, and a co-owner who can delete
 * the ride and change its visibility is somebody who should hear that a
 * suggestion arrived on it. `rides.owner_id` means the creator and the quota
 * holder, which is a different question.
 *
 * `except` is the actor, always. Telling somebody what they just did is the
 * single most common way a notification system loses a rider's trust, and it is
 * cheaper to exclude here than to remember at nine call sites.
 */
async function ownersOf(rideId: number, except: number): Promise<number[]> {
  const rows = await db
    .select({ id: rideMembers.riderId })
    .from(rideMembers)
    .where(and(eq(rideMembers.rideId, rideId), eq(rideMembers.role, 'owner'), ne(rideMembers.riderId, except)))
  return rows.map((r) => r.id)
}

/** The whole roster minus the actor. */
async function rosterOf(rideId: number, except: number | null): Promise<number[]> {
  const rows = await db
    .select({ id: rideMembers.riderId })
    .from(rideMembers)
    .where(
      except === null
        ? eq(rideMembers.rideId, rideId)
        : and(eq(rideMembers.rideId, rideId), ne(rideMembers.riderId, except)),
    )
  return rows.map((r) => r.id)
}

/** A rider's display name, for the "who did it" half of every message. */
async function nameOf(userId: number): Promise<string> {
  const [u] = await db.select({ n: users.displayName }).from(users).where(eq(users.id, userId)).limit(1)
  return u?.n ?? 'Somebody'
}

/**
 * The date format ONE recipient reads in.
 *
 * **A DATE IN A NOTIFICATION HAS TO BE FORMATTED FOR WHOEVER IS READING IT, AND
 * `dateFormatFor()` CANNOT DO IT** — that one takes a request Context and falls
 * back to `Accept-Language`, which is the browser of whoever triggered the event
 * rather than of the person being told about it. A sweep has no request at all.
 * So this reads the recipient's own column, and falls back to the app default
 * rather than to a header that does not exist here.
 */
async function dateFormatOf(userId: number): Promise<DateFormat> {
  const [p] = await db
    .select({ f: userProfiles.dateFormat })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
  return toDateFormat(p?.f)
}

/** Several recipients' formats in one round trip, for the sweeps. A rider with
 *  no profile row is absent from the map and takes the default. */
async function dateFormatsOf(userIds: readonly number[]): Promise<Map<number, DateFormat>> {
  if (userIds.length === 0) return new Map()
  const rows = await db
    .select({ id: userProfiles.userId, f: userProfiles.dateFormat })
    .from(userProfiles)
    .where(inArray(userProfiles.userId, [...userIds]))
  return new Map(rows.map((r) => [r.id, toDateFormat(r.f)]))
}

// ── Rides ────────────────────────────────────────────────────────────────────

/**
 * Somebody commented on a ride.
 *
 * **TO THE OWNERS AND NOT TO THE WHOLE ROSTER.** Commenting is roster-only, so
 * every member could in principle be told — and on a twelve-person ride that
 * turns one remark into eleven messages and trains everybody to ignore the lot.
 * The owner is the one who can act on a comment; everyone else sees it on the
 * ride. A per-thread subscription is the shape that would widen this honestly,
 * and it is not built.
 */
export function notifyRideComment(
  rideId: number,
  commenterId: number,
  body: string,
  pointLabel: string | null,
): void {
  void (async () => {
    const [ride, commenterName, owners] = await Promise.all([
      rideCard(rideId),
      nameOf(commenterId),
      ownersOf(rideId, commenterId),
    ])
    if (!ride || owners.length === 0) return
    // Trimmed HERE rather than in the template, so both channels carry the same
    // excerpt and neither decides how much of somebody's comment to reproduce.
    const excerpt = body.length > 140 ? `${body.slice(0, 137).trimEnd()}…` : body
    notifyMany(
      owners,
      () => ({
        event: 'ride_comment' as const,
        title: `${commenterName} commented on ${ride.title}`,
        body: excerpt,
        url: `/m/${ride.slug}`,
        email: {
          template: rideCommentEmail,
          props: { commenterName, rideTitle: ride.title, rideSlug: ride.slug, excerpt, pointLabel },
        },
      }),
      'ride_comment',
    )
  })().catch((err) => console.warn('[notify] ride_comment failed:', err))
}

/** Somebody proposed a change. To the owners, who are the only people who can
 *  decide it — `canDecide` is the owner and deliberately not an edit-level
 *  rider, so telling anyone else would be telling them about a button they do
 *  not have. */
export function notifyRideSuggestion(
  rideId: number,
  proposerId: number,
  routeLabel: string,
  note: string | null,
): void {
  void (async () => {
    const [ride, proposerName, owners] = await Promise.all([
      rideCard(rideId),
      nameOf(proposerId),
      ownersOf(rideId, proposerId),
    ])
    if (!ride || owners.length === 0) return
    notifyMany(
      owners,
      () => ({
        event: 'ride_suggestion' as const,
        title: `${proposerName} suggested a change to ${ride.title}`,
        body: note ?? `A new version of ${routeLabel}, for you to accept or discard.`,
        url: `/m/${ride.slug}`,
        email: {
          template: rideSuggestionEmail,
          props: { proposerName, rideTitle: ride.title, rideSlug: ride.slug, routeLabel, note },
        },
      }),
      'ride_suggestion',
    )
  })().catch((err) => console.warn('[notify] ride_suggestion failed:', err))
}

/**
 * The owner decided. To the PROPOSER, which is the one direction this goes.
 *
 * **WITHDRAW MUST NOT CALL THIS.** A withdrawn suggestion was withdrawn by the
 * proposer, so the message would tell them what they had just done — and the
 * template has no third value to say it with. Only accept and discard.
 */
export function notifySuggestionDecided(
  rideId: number,
  proposerId: number,
  ownerId: number,
  routeLabel: string,
  accepted: boolean,
): void {
  void (async () => {
    const [ride, ownerName] = await Promise.all([rideCard(rideId), nameOf(ownerId)])
    if (!ride) return
    notify(proposerId, {
      event: 'suggestion_decided',
      title: accepted
        ? `${ownerName} took your suggestion for ${ride.title}`
        : `${ownerName} passed on your suggestion for ${ride.title}`,
      body: accepted ? `${routeLabel} is your version now.` : `${routeLabel} is staying as it was.`,
      url: `/m/${ride.slug}`,
      email: {
        template: suggestionDecidedEmail,
        props: { ownerName, rideTitle: ride.title, rideSlug: ride.slug, routeLabel, accepted },
      },
    })
  })().catch((err) => console.warn('[notify] suggestion_decided failed:', err))
}

/**
 * A vote closed with a winner. To the whole roster, including the owner.
 *
 * **NOBODY IS EXCLUDED HERE AND THAT IS THE ONE EXCEPTION TO THE ACTOR RULE**:
 * there is no actor. A sweep elected it, ten minutes after a deadline nobody was
 * watching, so there is no "you just did this" to avoid telling anybody.
 */
export function notifyVoteResolved(rideId: number, winnerLabel: string, choices: number): void {
  void (async () => {
    const [ride, roster] = await Promise.all([rideCard(rideId), rosterOf(rideId, null)])
    if (!ride || roster.length === 0) return
    notifyMany(
      roster,
      () => ({
        event: 'vote_resolved' as const,
        title: `${ride.title}: the group picked ${winnerLabel}`,
        body: `${winnerLabel} is the active route now.`,
        url: `/m/${ride.slug}`,
        email: {
          template: voteResolvedEmail,
          props: { rideTitle: ride.title, rideSlug: ride.slug, winnerLabel, choices },
        },
      }),
      'vote_resolved',
    )
  })().catch((err) => console.warn('[notify] vote_resolved failed:', err))
}

// ── Roster ───────────────────────────────────────────────────────────────────

/** Somebody put you on a ride. To the rider who was added, and to nobody else —
 *  the owner did it and the rest of the roster finds out by looking. */
export function notifyRideAdded(rideId: number, addedId: number, byId: number, startAt: Date | null): void {
  void (async () => {
    const [ride, ownerName, format] = await Promise.all([rideCard(rideId), nameOf(byId), dateFormatOf(addedId)])
    if (!ride) return
    const startsOn = startAt ? fmtDateNumeric(startAt, format) : null
    notify(addedId, {
      event: 'ride_added',
      title: `${ownerName} put you on ${ride.title}`,
      body: startsOn ? `It sets off ${startsOn}. Say whether you are coming.` : 'Say whether you are coming.',
      url: `/m/${ride.slug}`,
      email: {
        template: rideAddedEmail,
        props: { ownerName, rideTitle: ride.title, rideSlug: ride.slug, startsOn },
      },
    })
  })().catch((err) => console.warn('[notify] ride_added failed:', err))
}

/**
 * Somebody answered. To the owners.
 *
 * **`invited` IS NOT AN ANSWER AND MUST NOT REACH HERE.** It is the state a
 * rider is PUT IN when they are added, so mailing it would tell the owner that
 * the person they just added has not replied yet. The caller filters it; this
 * asserts nothing, because a defensive check here would hide the call site
 * getting it wrong rather than fix it.
 */
export function notifyRsvp(rideId: number, riderId: number, rsvp: Rsvp, goingCount: number): void {
  void (async () => {
    const [ride, riderName, owners] = await Promise.all([rideCard(rideId), nameOf(riderId), ownersOf(rideId, riderId)])
    if (!ride || owners.length === 0) return
    const answer = RSVP_LABELS[rsvp]
    notifyMany(
      owners,
      () => ({
        event: 'ride_rsvp' as const,
        title: `${riderName} on ${ride.title}: ${answer}`,
        body: `${goingCount} going so far.`,
        url: `/m/${ride.slug}`,
        email: {
          template: rideRsvpEmail,
          props: { riderName, rideTitle: ride.title, rideSlug: ride.slug, answer, goingCount },
        },
      }),
      'ride_rsvp',
    )
  })().catch((err) => console.warn('[notify] ride_rsvp failed:', err))
}

// ── People ───────────────────────────────────────────────────────────────────

/**
 * Somebody followed you.
 *
 * **A RIDER WITH NO HANDLE CANNOT BE THE SUBJECT OF THIS**, because both the
 * link and the message name them by one — the same precondition
 * src/friends/notify.ts's `pair()` enforces, and for the same reason. Nothing is
 * sent rather than a message about `@null`.
 *
 * There is no unfollow counterpart and there must not be: telling somebody they
 * were unfollowed is the mirror of telling somebody they were blocked.
 */
export function notifyNewFollower(followerId: number, followedId: number): void {
  void (async () => {
    const [f] = await db
      .select({ name: users.displayName, handle: users.username })
      .from(users)
      .where(eq(users.id, followerId))
      .limit(1)
    if (!f?.handle) return
    notify(followedId, {
      event: 'new_follower',
      title: `${f.name} is following you`,
      body: 'Following is one-way and opens nothing of yours.',
      url: `/@${f.handle}`,
      email: { template: newFollowerEmail, props: { followerName: f.name, followerHandle: f.handle } },
    })
  })().catch((err) => console.warn('[notify] new_follower failed:', err))
}

// ── Account ──────────────────────────────────────────────────────────────────

/** A ride in the bin is a week from being destroyed. One message per ride, from
 *  the hourly trash sweep. */
export function notifyRidePurgeSoon(
  rows: readonly { ownerId: number; title: string; purgeAfter: Date }[],
  now: Date,
): void {
  if (rows.length === 0) return
  void (async () => {
    const formats = await dateFormatsOf(rows.map((r) => r.ownerId))
    for (const r of rows) {
      const format = formats.get(r.ownerId) ?? toDateFormat(undefined)
      // Ceiled, so "in 1 day" never renders as "in 0 days" for a purge that has
      // not happened yet — the rider still has the rest of today.
      const daysLeft = Math.max(1, Math.ceil((r.purgeAfter.getTime() - now.getTime()) / 86_400_000))
      const purgeOn = fmtDateNumeric(r.purgeAfter, format)
      notify(r.ownerId, {
        event: 'trash_purge_soon',
        title: daysLeft === 1 ? `${r.title} is deleted for good tomorrow` : `${r.title} is deleted for good in ${daysLeft} days`,
        body: `Restoring it from your bin before ${purgeOn} keeps it.`,
        url: '/trash',
        email: { template: ridePurgeSoonEmail, props: { rideTitle: r.title, daysLeft, purgeOn } },
      })
    }
  })().catch((err) => console.warn('[notify] trash_purge_soon failed:', err))
}

/** Storage is nearly full. From the five-minutely quota sweep, once per
 *  crossing — the anti-repeat stamp is that sweep's business, not this one's. */
export function notifyQuotaFull(userId: number, used: string, quota: string, percent: number): void {
  notify(userId, {
    event: 'quota_full',
    title: `Your storage is ${percent}% full`,
    body: `${used} of ${quota}. Only files you imported count against it.`,
    url: '/trash',
    email: { template: quotaFullEmail, props: { percent, used, quota } },
  })
}

/** The account deletion the rider asked for is a week away. */
export function notifyAccountPurgeSoon(userId: number, purgeAfter: Date, now: Date): void {
  void (async () => {
    const format = await dateFormatOf(userId)
    const daysLeft = Math.max(1, Math.ceil((purgeAfter.getTime() - now.getTime()) / 86_400_000))
    const purgeOn = fmtDateNumeric(purgeAfter, format)
    notify(userId, {
      event: 'account_purge_soon',
      title: daysLeft === 1 ? 'Your account is deleted tomorrow' : `Your account is deleted in ${daysLeft} days`,
      body: 'Signing in cancels it. Doing nothing goes ahead with it.',
      url: '/login',
      email: { template: accountPurgeSoonEmail, props: { daysLeft, purgeOn } },
    })
  })().catch((err) => console.warn('[notify] account_purge_soon failed:', err))
}
