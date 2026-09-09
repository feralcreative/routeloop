// TELL EVERY RIDER WHAT CHANGED, ONCE PER RELEASE.
//
// #288. Removing the feedback shield took "What's new" with it, and the footer
// does not render on a map page — `variant: 'map'` skips `.page-wrap`, which is
// what wraps `siteFooter()` — so the builder and the viewer had no route to the
// release notes at all. Ziad's call, 2026-09-08: rather than putting the link
// back on a fourth surface, a release becomes an ordinary notification. The
// account chip renders on EVERY page including the map ones, so its unread badge
// is the affordance, and the centre mixes releases with everything else in one
// chronological list because they are all rows in one table.
//
// **THE FAN-OUT IS A ROW PER RIDER AND THAT IS THE POINT.** One announcement row
// plus per-rider read markers would need two new tables, and the centre would
// then have to merge two sources to order them by time, the badge would be two
// counts, and none of the existing preference or read machinery would apply. A
// row each buys all of it for the price of N inserts, and N is the roster of a
// closed alpha.
import { db } from '../db/index'
import { announcedReleases, users } from '../db/schema'
import { content } from '../views/content'
import { latestRelease } from '../releases/latest'
import { releaseEmail } from '../emails'
import { notify } from './service'

/**
 * Announce the build's own release note, if it has not been announced already.
 *
 * **THE INSERT IS THE LOCK.** `onConflictDoNothing` on the primary key either
 * wins or reports nothing, atomically, in one statement — so of the two
 * containers a blue/green deploy starts, exactly one fans out and the other
 * simply returns. There is no lease and no expiry, for the reason the deploy
 * lock is a `mkdir`: test-then-write has a window that hands it to both.
 *
 * **CLAIMED BEFORE THE SENDS, NEVER AFTER.** A crash midway through the fan-out
 * leaves some riders told and the release marked done, which loses a message.
 * The other order re-announces to EVERYBODY on the next boot, which is worse and
 * is unbounded — a container that crash-loops mails the roster on every restart.
 *
 * Returns how many riders were told, for the log line and for a test to assert
 * on. Zero is the ordinary answer: every boot after the first for a given
 * release, which is most boots.
 */
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

export async function announceRelease(): Promise<number> {
  const release = latestRelease(content(NOTES_FILE))
  // No release section at all is a real state — a fresh checkout has one — and
  // announcing nothing is correct rather than an error.
  if (!release) return 0

  const claimed = await db
    .insert(announcedReleases)
    .values({ id: release.id })
    .onConflictDoNothing()
    .returning({ id: announcedReleases.id })
  if (claimed.length === 0) return 0

  // EVERY RIDER, INCLUDING PENDING AND SUSPENDED ONES. A release note is not
  // about their account, `notify` writes a row rather than sending by default,
  // and filtering on status would mean somebody approved next week opens a
  // centre that begins mid-story. The email arm is off by default and gated on
  // the rider's own preference, so the loud channel is not affected either way.
  const riders = await db.select({ id: users.id }).from(users)
  for (const rider of riders) {
    notify(rider.id, {
      event: 'release',
      title: release.title,
      body: 'See what changed in this build.',
      // A PATH, never an absolute URL — see the column comment on
      // notifications.url. The centre is what opens it.
      url: '/release-notes',
      email: { template: releaseEmail, props: { title: release.title } },
    })
  }
  return riders.length
}
