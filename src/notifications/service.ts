// The one door every notification goes through.
//
// The rules are ./policy.ts and the catalog ./catalog.ts; this is the half that
// reads and writes tables, which is why it is not in either of those — the
// rule-from-query split every other module here follows.
//
// **ONE `notify()` AND NOT ONE NOTIFIER PER EVENT.** There were three notifier
// modules before this (auth, feedback, friends) and each re-derived the same
// shape: look up the recipient, decide, send, swallow. Thirteen events would
// have been thirteen copies of that, and the copies drift — the first one to
// forget the preference check is a rider being mailed something they turned off,
// with nothing to raise it. The senders now say WHO, WHICH EVENT and WHAT, and
// this decides everything else.
//
// **IT IS VOID AND NEVER THROWS**, like the three notifiers it generalizes: a
// mail or an insert failing must not turn a successful button press into an
// error page, and the `.catch()` is attached SYNCHRONOUSLY because Node's
// default `--unhandled-rejections=throw` terminates the process on a floating
// rejection. Same reasoning as sendTemplateDetached, which is what it wraps.
//
// **CALL IT AFTER THE CALLER'S TRANSACTION HAS COMMITTED.** It does its own
// reads, and an SMTP round trip inside a transaction holds a pooled connection
// open for a network call — the rule notifyNewSignup and notifyNewReport both
// carry, unchanged.
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { notificationPrefs, notifications, users } from '../db/schema'
import { sendTemplateDetached } from '../auth/mailer'
import type { EmailTemplate } from '../emails/types'
import { EVENTS, type Channel, type NotificationEvent } from './catalog'
import { enabledFor, prefMap, type PrefRow } from './policy'

/** How long a raised notification is kept before the poll prunes it. Long
 *  enough that a rider who left a tab open over a weekend does not lose the
 *  record, short enough that the table is not a log. */
export const NOTIFICATION_RETENTION_DAYS = 14

/** One rider's stored answers, ready for `enabledFor`. */
export async function prefsOf(userId: number): Promise<Map<string, boolean>> {
  const rows = await db
    .select({ event: notificationPrefs.event, channel: notificationPrefs.channel, enabled: notificationPrefs.enabled })
    .from(notificationPrefs)
    .where(eq(notificationPrefs.userId, userId))
  return prefMap(rows as PrefRow[])
}

/**
 * Store a rider's answers for the events one form carried.
 *
 * **EVERY SUBMITTED EVENT IS WRITTEN, INCLUDING THE OFF ONES.** An unticked
 * checkbox sends nothing, so "absent from the body" has to mean off for the
 * group being saved — and a delete would make it mean "never asked" instead,
 * which is the one other thing absence already means. `rowsFromForm` in
 * ./policy.ts is where that decision is written down; this just upserts what it
 * returns.
 */
export async function savePrefs(userId: number, rows: readonly PrefRow[]): Promise<void> {
  if (rows.length === 0) return
  await db
    .insert(notificationPrefs)
    .values(rows.map((r) => ({ userId, event: r.event, channel: r.channel, enabled: r.enabled, updatedAt: new Date() })))
    .onConflictDoUpdate({
      target: [notificationPrefs.userId, notificationPrefs.event, notificationPrefs.channel],
      set: { enabled: sql`excluded.enabled`, updatedAt: new Date() },
    })
}

/**
 * What one notification is.
 *
 * `title` and `body` are the BROWSER's copy and are rendered by the caller,
 * because the caller is the only code holding the ride, the rider and the verb
 * together. They are stored rather than re-derived at raise time, so a
 * notification about a ride that has since been deleted still says what it said
 * — the reasoning `comments.point_label` carries.
 *
 * `email` is optional, and its absence is a real state rather than an oversight:
 * an event can be worth a toast and not worth a message. Nothing in the catalog
 * uses that today, and the field exists so that the first event which does is a
 * caller change and not a signature change.
 */
export type Notice<P> = {
  event: NotificationEvent
  title: string
  body: string
  /** A PATH, never an absolute URL — see the column comment. */
  url?: string
  email?: { template: EmailTemplate<P>; props: P; replyTo?: string; limitKey?: string }
}

/**
 * The recipients that are people. A GUIDE RIDER — one of the seeded accounts
 * the guided tour invites onto its demo ride — is on a real roster and would
 * otherwise collect a real "you were added" row every time a new rider takes
 * the tour, forever, with nobody to read it. Filtered here, at the two doors
 * every sender goes through, rather than at each of the thirteen senders.
 */
async function humansOnly(ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return []
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), eq(users.isGuide, false)))
  return rows.map((r) => r.id)
}

/**
 * Tell one rider one thing, on whichever channels they asked for.
 *
 * **THE PREFERENCE IS CHECKED BEFORE THE INSERT, NOT BEFORE THE RAISE.** A rider
 * who turns the browser channel on must not be handed a backlog of everything
 * that happened while it was off — which is what storing unconditionally and
 * filtering at poll time would produce, and which is nobody's idea of switching
 * a setting on.
 */
export function notify<P>(userId: number, notice: Notice<P>): void {
  void (async () => {
    if ((await humansOnly([userId])).length === 0) return
    const prefs = await prefsOf(userId)
    const want = (ch: Channel) => enabledFor(prefs, notice.event, ch)

    if (notice.email && want('email')) {
      // The address is read here rather than passed in: every caller would
      // otherwise carry a users lookup it has no other use for, and
      // sendTemplateDetached already treats a null recipient as a skip.
      const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1)
      sendTemplateDetached(row?.email, notice.email.template, notice.email.props, {
        replyTo: notice.email.replyTo,
        limitKey: notice.email.limitKey,
      })
    }

    // ALWAYS STORED, WHATEVER THE BROWSER PREFERENCE SAYS — and this REVERSES
    // what this function did until the account menu grew a Notifications item.
    // The row used to be written only when the browser channel was on, on the
    // reasoning that switching the channel on should not surface a backlog of
    // toasts. That reasoning was right about TOASTS and wrong about the record:
    // browser notifications are off by default, so a center built on the old
    // rule would be empty for nearly everybody, and a rider would be told they
    // have no activity when the truth was that they had never opted into a
    // channel they were never asked about.
    //
    // The preference now gates the RAISE and nothing else — `claimPending()` is
    // where it is read — so the backlog problem it was written for is still
    // answered: a rider turning the channel on gets toasts from that point, not
    // for everything they have missed.
    await db.insert(notifications).values({
      userId,
      event: notice.event,
      title: notice.title,
      body: notice.body,
      url: notice.url ?? null,
    })
  })().catch((err) => {
    console.warn(`[notify] ${notice.event} failed:`, err instanceof Error ? err.message : err)
  })
}

/**
 * The same thing to several riders.
 *
 * **IT IS NOT A LOOP OVER `notify()` AND THE REASON IS THE PREFERENCE READ.**
 * A ride's roster is routinely a dozen people, and one query per rider per
 * notification is a dozen round trips to answer a question one `IN` answers. The
 * browser rows go in as ONE insert for the same reason.
 *
 * `body` may be a function of the recipient, because "you were added" and "Dana
 * was added" are the same event told two ways and splitting them into two calls
 * would put the roster walk in every caller.
 */
export function notifyMany<P>(
  userIds: readonly number[],
  build: (userId: number) => Notice<P>,
  event: NotificationEvent,
): void {
  if (userIds.length === 0) return
  void (async () => {
    const people = await humansOnly(userIds)
    if (people.length === 0) return
    const rows = await db
      .select({
        userId: notificationPrefs.userId,
        event: notificationPrefs.event,
        channel: notificationPrefs.channel,
        enabled: notificationPrefs.enabled,
      })
      .from(notificationPrefs)
      .where(and(inArray(notificationPrefs.userId, people), eq(notificationPrefs.event, event)))

    // One map per rider, so a rider with no rows gets an empty one and every
    // default — the common case, which must not need a branch.
    const byUser = new Map<number, PrefRow[]>()
    for (const r of rows) {
      const list = byUser.get(r.userId)
      if (list) list.push(r as PrefRow)
      else byUser.set(r.userId, [r as PrefRow])
    }

    const wantEmail: number[] = []
    const toStore: Array<{ userId: number; event: string; title: string; body: string; url: string | null }> = []
    const notices = new Map<number, Notice<P>>()

    for (const id of people) {
      const prefs = prefMap(byUser.get(id) ?? [])
      const notice = build(id)
      notices.set(id, notice)
      if (notice.email && enabledFor(prefs, event, 'email')) wantEmail.push(id)
      // Unconditional, like notify() above and for the same reason: the row is
      // the RECORD and the browser preference decides only whether a toast is
      // raised from it. See claimPending().
      toStore.push({ userId: id, event, title: notice.title, body: notice.body, url: notice.url ?? null })
    }

    if (toStore.length > 0) await db.insert(notifications).values(toStore)

    if (wantEmail.length > 0) {
      const addrs = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.id, wantEmail))
      for (const a of addrs) {
        const notice = notices.get(a.id)
        if (!notice?.email) continue
        sendTemplateDetached(a.email, notice.email.template, notice.email.props, {
          replyTo: notice.email.replyTo,
          limitKey: notice.email.limitKey,
        })
      }
    }
  })().catch((err) => {
    console.warn(`[notify] ${event} (many) failed:`, err instanceof Error ? err.message : err)
  })
}

/**
 * What the open page should raise, and claiming it in the same breath.
 *
 * **STAMPING IS THE CLAIM AND IT HAPPENS BEFORE THE ROWS ARE RETURNED**, so two
 * tabs polling at the same moment cannot both raise the same notification. The
 * `returning()` on the UPDATE is what makes that one statement rather than a
 * select followed by a write with a window between them.
 *
 * **PRUNING RIDES ALONG RATHER THAN ON A TIMER.** It is bounded (one rider's own
 * old rows), it costs no sixth `unref()`d interval beside the five in index.tsx,
 * and a rider who has stopped visiting has no rows pruned — which is correct,
 * because the account purge takes them wholesale and nothing else is looking.
 */
export async function claimPending(userId: number, limit = 10) {
  const cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * 86_400_000)
  await db.delete(notifications).where(and(eq(notifications.userId, userId), lt(notifications.createdAt, cutoff)))

  // WHICH EVENTS THIS RIDER WANTS A TOAST FOR, read here rather than at write
  // time — the row is stored for everybody and this is the gate. An event with
  // no stored row takes `defaultFor('browser')`, which is off, so a rider who
  // has never touched the settings page is polled for nothing and toasted for
  // nothing while their center still fills up.
  const prefs = await prefsOf(userId)
  const wanted = EVENTS.filter((e) => enabledFor(prefs, e.key, 'browser')).map((e) => e.key)
  if (wanted.length === 0) return []

  const due = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(eq(notifications.userId, userId), isNull(notifications.deliveredAt), inArray(notifications.event, wanted)),
    )
    .orderBy(notifications.createdAt)
    .limit(limit)
  if (due.length === 0) return []

  return db
    .update(notifications)
    .set({ deliveredAt: new Date() })
    .where(
      inArray(
        notifications.id,
        due.map((d) => d.id),
      ),
    )
    .returning({
      id: notifications.id,
      event: notifications.event,
      title: notifications.title,
      body: notifications.body,
      url: notifications.url,
    })
}

/**
 * How many the rider has not read, for the badge on the account chip.
 *
 * **UNREAD IS `read_at`, NEVER `delivered_at`.** A toast firing says the message
 * crossed their screen for four seconds; it does not say they looked at it, and
 * on the default settings no toast ever fires at all. Sharing one column would
 * make the badge wrong in both directions at once.
 *
 * Read on every page render for a signed-in rider, which is why it is a bare
 * `count(*)` over the partial index rather than a select of the rows.
 */
export async function unreadCount(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
  return row?.n ?? 0
}

/** The center's list: newest first, capped. Unread and read together, because a
 *  rider opening this wants to see what happened rather than to be shown an
 *  empty page the moment they have caught up. */
export async function recentNotifications(userId: number, limit = 50) {
  return db
    .select({
      id: notifications.id,
      event: notifications.event,
      title: notifications.title,
      body: notifications.body,
      url: notifications.url,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
    })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
}

/**
 * Mark everything read.
 *
 * **CALLED AFTER THE LIST IS READ, NOT BEFORE.** The page renders which ones
 * were unread — that is the whole reason to visit it — so stamping first would
 * show a rider a page on which nothing is new, every time, and they would never
 * see the thing the badge was counting.
 */
export async function markAllRead(userId: number): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
}
