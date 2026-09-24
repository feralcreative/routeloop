// TELL EVERY RIDER WHAT CHANGED, ONCE PER RELEASE, AND CARRY THE WHOLE HISTORY.
//
// #288. Removing the feedback shield took "What's new" with it, and the footer does not
// render on a map page, so the builder and the viewer had no route to the release notes
// at all. Rather than putting the link back on a fourth surface, a release becomes an
// ordinary notification: the account chip renders on EVERY page, so its unread badge is
// the affordance.
//
// **THE PAGE KEEPS 100% OF THE NOTES AND EVERY RELEASE IS REFERENCED HERE.** A
// notification carries the heading, a sentence derived from the release's own first
// bullet, and a link to that entry's anchor.
//
// **THE FAN-OUT IS A ROW PER RIDER AND THAT IS THE POINT.** One announcement row plus
// per-rider read markers would need two new tables, the center would have to merge two
// sources to order them, the badge would be two counts, and none of the existing
// preference or read machinery would apply.
import { and, eq, ne, notInArray, or } from 'drizzle-orm'
import { db } from '../db/index'
import { announcedReleases, notifications, users } from '../db/schema'
import { content } from '../views/content'
import { allReleases, type Release } from '../releases/latest'
import { releaseEmail } from '../emails'
import { notify } from './service'

/**
 * The notes file, as `content()` names it.
 *
 * **THE EXTENSION IS PART OF THE NAME** — `content()` joins it onto
 * src/content/ and throws when the file is not there. Omitting it here threw on
 * every boot, and the throw was swallowed by the catch at the call site, so the
 * feature was silently off with the app otherwise perfectly healthy. Exported so
 * a test can assert it resolves rather than trusting the string.
 */
export const NOTES_FILE = 'release-notes.html'

/** Where a release's notification points: the page, at that entry. */
export const releaseUrl = (r: Release): string => `/release-notes#${r.id}`

/**
 * The day an announcement id names, in either shape the file has:
 * "13-september-2026-…" or the month-only catch-all, "july-2026-…" — which
 * used to open with "before-all-that-", hence a search rather than an anchor.
 * Two ids on one day are one release under two headings, because the file
 * keeps one section per day; the id itself when no day can be read, so such
 * an id pairs with nothing and is treated as its own release.
 */
export const releaseDay = (id: string): string =>
  id.match(/(?:^|-)(\d{1,2}-[a-z]+-\d{4})(?:-|$)/)?.[1] ?? id.match(/(?:^|-)([a-z]+-\d{4})(?:-|$)/)?.[1] ?? id

/** Under the 400-character `body` column by construction — see `summarize`. */
const bodyOf = (r: Release): string => r.summary

/**
 * Announce every release the database has not seen, newest first.
 *
 * **ONE PASS RATHER THAN AN ANNOUNCE PLUS A SEPARATE BACKFILL SCRIPT.** The claim is
 * per release, so the first boot after this ships takes all forty-two and every boot
 * after that takes none — the same code path, where a backfill that has to be
 * remembered and run by hand is the class of data migration AGENTS.md records as
 * failing silently.
 *
 * **ONLY THE NEWEST IS NEW.** Everything older is written straight in as READ and never
 * mailed: forty-two unread would put a badge on every rider that they cannot clear in
 * one sitting, and mailing a rider who had switched the channel on would send
 * forty-two messages at once.
 *
 * **`created_at` IS THE RELEASE'S OWN DATE, NOT NOW.** The center orders by it, so
 * stamping the batch with the moment it ran would put the whole history in a block at
 * the top in file order.
 *
 * **THE INSERT IS THE LOCK.** `onConflictDoNothing` on the primary key either wins or
 * reports nothing, atomically, so of the two containers a blue/green deploy starts
 * exactly one announces. No lease and no expiry, for the reason the deploy lock is a
 * `mkdir`.
 *
 * **CLAIMED BEFORE THE SENDS, NEVER AFTER.** A crash midway loses a message; the other
 * order re-announces to EVERYBODY on the next boot, which is unbounded.
 */
export async function announceReleases(): Promise<number> {
  const releases = allReleases(content(NOTES_FILE))
  // No release section at all is a real state — a fresh checkout has one — and
  // announcing nothing is correct rather than an error.
  if (releases.length === 0) return 0

  // **A RENAMED HEADING IS THE SAME RELEASE, AND ITS ROWS ARE RENAMED WITH IT.** The
  // heading is the announcement's identity, so a retitled entry has a new id and every
  // rider's center holds rows under the old one. Those rows carry the rider's own state,
  // and the first version of this reconcile threw that away: it deleted the orphans and
  // wrote the release again as read, which cleared an unread badge nobody had cleared.
  //
  // One release per day is the rule the file follows, so the DATE that opens every id is
  // what pairs an orphan with its live release. The claim moves with the rows, BEFORE
  // the insert below, so the renamed release conflicts there and is not written twice.
  // Orphans with no live release on their day are the merge case.
  //
  // Reconciled on every boot rather than by a one-off statement, because a data fix that
  // runs nowhere is the class of migration AGENTS.md records as failing silently.
  const live = releases.map((r) => releaseUrl(r))
  const dayOf = releaseDay
  const liveIds = new Set(releases.map((r) => r.id))
  const liveByDay = new Map(releases.map((r) => [dayOf(r.id), r]))
  const claims = await db.select({ id: announcedReleases.id }).from(announcedReleases)
  const claimedIds = new Set(claims.map((c) => c.id))
  const renamed: string[] = []
  for (const { id: oldId } of claims) {
    if (liveIds.has(oldId)) continue
    const target = liveByDay.get(dayOf(oldId))
    // Already renamed onto this release by an earlier orphan of the same day,
    // or claimed by a boot that ran before this one: nothing to move onto.
    if (!target || claimedIds.has(target.id)) continue
    await db
      .update(notifications)
      .set({ title: target.title, body: bodyOf(target), url: releaseUrl(target) })
      .where(and(eq(notifications.event, 'release'), eq(notifications.url, `/release-notes#${oldId}`)))
    await db.update(announcedReleases).set({ id: target.id }).where(eq(announcedReleases.id, oldId))
    claimedIds.add(target.id)
    renamed.push(oldId)
  }
  if (renamed.length > 0) console.log(`[announce] moved ${renamed.length} release(s) under renamed headings`)

  // **THE TITLE AND THE SUMMARY FOLLOW THE FILE EVEN WHEN THE ID DOES NOT.**
  // The summary is derived from the entry's first item, and an id survives a
  // change to that — so a row can hold a sentence the page no longer says.
  for (const r of releases) {
    await db
      .update(notifications)
      .set({ title: r.title, body: bodyOf(r) })
      .where(
        and(
          eq(notifications.event, 'release'),
          eq(notifications.url, releaseUrl(r)),
          or(ne(notifications.title, r.title), ne(notifications.body, bodyOf(r))),
        ),
      )
  }

  const claimed = await db
    .insert(announcedReleases)
    .values(releases.map((r) => ({ id: r.id })))
    .onConflictDoNothing()
    .returning({ id: announcedReleases.id })
  const won = new Set(claimed.map((c) => c.id))
  const mine = releases.filter((r) => won.has(r.id))

  // **WHAT IS STILL ORPHANED AFTER THE RENAME IS A SECTION THAT NO LONGER
  // EXISTS**, and the rows and the claim under it go — seen on 2026-09-13, when
  // eight days were merged to one section each and every merged day showed
  // twice. The claim goes too, so a heading renamed BACK is announced again
  // rather than remembered as done with no row to show for it.
  const orphans = await db
    .delete(notifications)
    .where(and(eq(notifications.event, 'release'), notInArray(notifications.url, live)))
    .returning({ url: notifications.url })
  await db.delete(announcedReleases).where(
    notInArray(
      announcedReleases.id,
      releases.map((r) => r.id),
    ),
  )
  if (orphans.length > 0) console.log(`[announce] removed ${orphans.length} release rows under merged headings`)
  if (mine.length === 0) return 0

  // EVERY RIDER, INCLUDING PENDING AND SUSPENDED ONES. A release note is not
  // about their account, the old ones are written as read, and filtering on
  // status would mean somebody approved next week opens a center that begins
  // mid-story.
  const riders = await db.select({ id: users.id }).from(users)
  if (riders.length === 0) return mine.length

  // `mine` is newest-first, so the head is the one that shipped with this build.
  // It is only NEW if it is also the newest release in the file — a deploy that
  // adds an OLD entry to the history announces it quietly rather than raising a
  // badge for something that shipped in July.
  const [head, ...older] = mine
  const isNew = head.id === releases[0].id
  const quiet = isNew ? older : mine

  if (quiet.length > 0) {
    const now = new Date()
    await db.insert(notifications).values(
      quiet.flatMap((r) =>
        riders.map((rider) => ({
          userId: rider.id,
          event: 'release',
          title: r.title,
          body: bodyOf(r),
          url: releaseUrl(r),
          createdAt: new Date(r.at),
          // READ ON ARRIVAL, and `delivered_at` with it: a toast for a release
          // from July is not a notification, it is a popup about the past.
          readAt: now,
          deliveredAt: now,
        })),
      ),
    )
  }

  // **THE NEW ONE KEEPS `now()` WHILE THE HISTORY TAKES ITS OWN DATE, AND THAT ASYMMETRY
  // IS DELIBERATE.** It is the row the unread badge is pointing at, so it has to be
  // findable at the top of the list — a release dated a few days back but deployed today
  // would otherwise land mid-list. In the ordinary case the two are the same day anyway.
  if (isNew) {
    for (const rider of riders) {
      notify(rider.id, {
        event: 'release',
        title: head.title,
        body: bodyOf(head),
        // A PATH, never an absolute URL — see the column comment on
        // notifications.url. The center is what opens it.
        url: releaseUrl(head),
        email: { template: releaseEmail, props: { title: head.title, url: releaseUrl(head) } },
      })
    }
  }

  return mine.length
}
