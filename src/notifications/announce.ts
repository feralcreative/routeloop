// TELL EVERY RIDER WHAT CHANGED, ONCE PER RELEASE, AND CARRY THE WHOLE HISTORY.
//
// #288. Removing the feedback shield took "What's new" with it, and the footer
// does not render on a map page — `variant: 'map'` skips `.page-wrap`, which is
// what wraps `siteFooter()` — so the builder and the viewer had no route to the
// release notes at all. Ziad's call, 2026-09-08: rather than putting the link
// back on a fourth surface, a release becomes an ordinary notification. The
// account chip renders on EVERY page, so its unread badge is the affordance, and
// the center mixes releases with everything else in one chronological list
// because they are all rows in one table.
//
// **THE PAGE KEEPS 100% OF THE NOTES AND EVERY RELEASE IS REFERENCED HERE.**
// Ziad's call, 2026-09-09. A notification carries the heading, a sentence or two
// derived from the release's own first bullet, and a link to that entry's anchor
// on `/release-notes` — the page stays exactly as it was, and is now the archive
// rather than the thing a rider has to remember to visit.
//
// **THE FAN-OUT IS A ROW PER RIDER AND THAT IS THE POINT.** One announcement row
// plus per-rider read markers would need two new tables, and the center would
// then have to merge two sources to order them by time, the badge would be two
// counts, and none of the existing preference or read machinery would apply. A
// row each buys all of it for the price of N inserts.
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

/** Under the 400-character `body` column by construction — see `summarize`. */
const bodyOf = (r: Release): string => r.summary

/**
 * Announce every release the database has not seen, newest first.
 *
 * **ONE PASS RATHER THAN AN ANNOUNCE PLUS A SEPARATE BACKFILL SCRIPT.** The
 * claim is per release, so the first boot after this ships takes all forty-two
 * and every boot after that takes none — which is the same code path, and a
 * backfill that has to be remembered and run by hand is the class of data
 * migration AGENTS.md records as failing silently.
 *
 * **ONLY THE NEWEST IS NEW.** Everything older is written straight in as READ
 * and never mailed: forty-two unread would put a badge on every rider that they
 * cannot clear in one sitting, which is the furniture problem `_nav.scss`
 * already warns about, and mailing a rider who had switched the channel on would
 * send forty-two messages at once. The history is there to scroll; the badge
 * stays honest.
 *
 * **`created_at` IS THE RELEASE'S OWN DATE, NOT NOW.** The center orders by it,
 * so stamping the batch with the moment it ran would put the whole history in a
 * block at the top in file order — the opposite of mixing chronologically with
 * everything else, which is the whole point of putting them here.
 *
 * **THE INSERT IS THE LOCK.** `onConflictDoNothing` on the primary key either
 * wins or reports nothing, atomically, so of the two containers a blue/green
 * deploy starts exactly one announces and the other returns. There is no lease
 * and no expiry, for the reason the deploy lock is a `mkdir`: test-then-write has
 * a window that hands it to both.
 *
 * **CLAIMED BEFORE THE SENDS, NEVER AFTER.** A crash midway leaves some riders
 * told and the release marked done, which loses a message. The other order
 * re-announces to EVERYBODY on the next boot, which is worse and is unbounded —
 * a container that crash-loops mails the roster on every restart.
 *
 * Returns how many releases were announced. Zero is the ordinary answer: every
 * boot after the first for a given set, which is most boots.
 */
export async function announceReleases(): Promise<number> {
  const releases = allReleases(content(NOTES_FILE))
  // No release section at all is a real state — a fresh checkout has one — and
  // announcing nothing is correct rather than an error.
  if (releases.length === 0) return 0

  const claimed = await db
    .insert(announcedReleases)
    .values(releases.map((r) => ({ id: r.id })))
    .onConflictDoNothing()
    .returning({ id: announcedReleases.id })
  if (claimed.length === 0) return 0

  const won = new Set(claimed.map((c) => c.id))
  const mine = releases.filter((r) => won.has(r.id))

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

  // **THE NEW ONE KEEPS `now()` WHILE THE HISTORY TAKES ITS OWN DATE, AND THAT
  // ASYMMETRY IS DELIBERATE.** `notify()` stamps the default, which is the moment
  // the build came up. It is the row the unread badge is pointing at, so it has
  // to be findable at the top of the list — and a release dated a few days back
  // but deployed today would otherwise land mid-list, where a rider following
  // the badge cannot see what it is for. In the ordinary case the two are the
  // same day anyway, because a release note is written for the deploy that
  // carries it. The history has no badge and belongs where it happened.
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
