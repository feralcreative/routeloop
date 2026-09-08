// "EVERYTHING THE APP HOLDS ABOUT YOU" HAS TO MEAN IT.
//
// `src/account/archive.ts` already carries a comment saying so, and saying that
// a field added to `user_profiles` and not added there leaves a rider's own
// archive quietly incomplete with nothing to raise it. That comment was correct
// and it did not stop the thing it warns about: `clock`, `volume_units` and
// `avoid_places` were added on 2026-09-07 and the archive was not touched.
//
// TEXT, NOT BEHAVIOR, and for the ordinary reason — `vitest.config.ts` is scoped
// to pure logic and CI runs no Postgres, so building an archive here is not
// available. Both files are read as source and their key lists compared. Same
// arrangement as test/map-globals.test.ts and test/calendar-day-copy.test.ts.
//
// THE TWO EXCLUSIONS ARE NAMED RATHER THAN INFERRED, so adding a third is a
// decision somebody writes down instead of a test quietly getting looser.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The column names declared on one pgTable block.
 *
 * TWO INDENTATIONS, because the two tables are written differently: a table with
 * no extra config puts its columns at two spaces (`pgTable('x', {`), and one
 * with an index or a CHECK puts them at four (`pgTable(\n  'x',\n  {`). Matching
 * only the first is how this returned three columns for `bikes` and passed the
 * sanity floor by accident — which is exactly the shape of failure it exists to
 * catch, so the floor stays.
 */
function columnsOf(src: string, table: string): string[] {
  const start = src.indexOf(`export const ${table} = pgTable(`)
  expect(start, `${table} not found in schema.ts`).toBeGreaterThan(-1)
  // The column object ends at whichever comes first: the table's closing `})`,
  // or the `(t) => [` config callback that follows it.
  const ends = ['\n})', '\n  ],', '\n  (t) =>'].map((e) => src.indexOf(e, start)).filter((i) => i > -1)
  const end = Math.min(...ends)
  return [...src.slice(start, end).matchAll(/^ {2,4}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1])
}

// userId is the FK that IS the primary key, and an archive is already one
// rider's — writing their own id into it says nothing. avatarBytes is
// bookkeeping for a file the archive ships in full, so the number is a fact
// about storage rather than about the rider.
const NOT_IN_ARCHIVE = new Set(['userId', 'avatarBytes'])

// ownerId is the rider whose archive this is, said once at the top rather than
// on every row. photoHash is a cache-busting fingerprint for a URL — bookkeeping
// about serving rather than anything the rider gave us, and the picture itself
// is in the zip, which is the fact that matters.
const NOT_IN_BIKE_ARCHIVE = new Set(['ownerId', 'photoHash'])

describe('the account archive', () => {
  it('carries every user_profiles column a rider could have filled in', () => {
    const cols = columnsOf(readFileSync('src/db/schema.ts', 'utf8'), 'userProfiles')
    // Sanity: if the regex ever stops matching, an empty list would make this
    // test pass while checking nothing.
    expect(cols.length).toBeGreaterThan(30)

    const arc = readFileSync('src/account/archive.ts', 'utf8')
    const from = arc.indexOf('    profile: profile')
    expect(from, 'the archive no longer has a `profile:` block in the shape this reads').toBeGreaterThan(-1)
    const to = arc.indexOf('      : null,', from)
    const shipped = new Set([...arc.slice(from, to).matchAll(/^ {10}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]))

    const missing = cols.filter((c) => !NOT_IN_ARCHIVE.has(c) && !shipped.has(c))
    expect(missing).toEqual([])
  })

  // THE PADDOCK WAS ABSENT ENTIRELY until 2026-09-07, which is a stronger form
  // of the same failure: not one column missed, but a whole table nobody had
  // noticed was not in "everything the app holds about you".
  it('carries every bikes column a rider could have filled in', () => {
    const cols = columnsOf(readFileSync('src/db/schema.ts', 'utf8'), 'bikes')
    expect(cols.length).toBeGreaterThan(10)

    const arc = readFileSync('src/account/archive.ts', 'utf8')
    const from = arc.indexOf('function archiveBike(')
    expect(from, 'archiveBike is gone or renamed').toBeGreaterThan(-1)
    const to = arc.indexOf('\n}', from)
    const shipped = new Set([...arc.slice(from, to).matchAll(/^ {4}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]))

    const missing = cols.filter((c) => !NOT_IN_BIKE_ARCHIVE.has(c) && !shipped.has(c))
    expect(missing).toEqual([])
  })
})

// EVERY TABLE, NOT JUST EVERY COLUMN — the check that was missing.
//
// The two tests above compare COLUMN lists on two named tables, which is a real
// guard and is why `clock` and `volume_units` cannot go missing again. What it
// cannot see is a whole table nobody thought to export: `notification_prefs`
// landed on 2026-09-07 with its own rider-owned data and both tests passed,
// because neither of them was looking at it. So did `places`, `friendships`,
// `follows`, `ride_comments`, `ride_suggestions`, `alt_votes`, `feedback` and
// `survey_responses` — none of which had ever been in the zip at all.
//
// **THE EXPORT IS COMPLETE BY DEFINITION AND THE EXCLUSIONS ARE THE ONLY
// ARGUMENT.** Ziad's call, 2026-09-07: the infrastructure is his, the
// information inside it is the rider's, forever. So a table holding something of
// theirs is either exported or it is on the list below with a reason — and the
// list is what somebody has to edit, deliberately, to make this test looser.
describe('the archive covers every table that holds rider data', () => {
  /** Every `pgTable('name', …)` in the schema, however the block is formatted. */
  function tablesIn(src: string): string[] {
    return [...src.matchAll(/pgTable\(\s*'([a-z_]+)'/g)].map((m) => m[1])
  }

  // NAMED, WITH THE REASON, one line each.
  const EXCLUDED: Record<string, string> = {
    // Credentials, not data. A live session id in a zip is an account handed to
    // whoever opens it.
    sessions: 'credential',
    login_tokens: 'credential',
    // The beta gate. Describes how somebody got in rather than anything of
    // theirs, and an invite names an email address that is not the exporter's.
    invites: 'not rider data',
    invite_redemptions: 'not rider data',
    // Already inside each ride, in five formats — a better record than a
    // flattened row, and the reason the ride directories exist.
    routes: 'inside the ride files',
    points: 'inside the ride files',
    route_legs: 'inside the ride files',
    point_details: 'inside the ride files',
    ride_subgroups: 'inside the ride files',
    route_riders: 'inside the ride files',
    // The roster of a ride is a fact about OTHER people. This rider's own row on
    // every ride ships as `memberships`; the rest is those riders' to export.
    ride_members: 'other people, exported as memberships',
    // Someone else's vote on this rider's report. Their row, not his.
    feedback_votes: 'other people',
    // Shipped as metadata beside each report — see everythingElse().
    feedback_attachments: 'metadata only, in feedback',
    // The rider's own identity row, already the `account` block.
    users: 'the account block',
    // Raised messages, delivered and pruned within a fortnight. The PREFERENCE
    // is exported; the toast is transport, not a record.
    notifications: 'transport, not a record',
    // Diagnostics attached to a report: build sha, viewport, user agent. Ours
    // about our own failure rather than anything the rider wrote.
    feedback_diagnostics: 'our diagnostics',
  }

  it('exports or explicitly excludes every table', () => {
    const schema = readFileSync('src/db/schema.ts', 'utf8')
    // COMMENTS STRIPPED FIRST, or the check passes on a mention. This file's
    // own prose names `sessions`, `routes` and `point_details` while explaining
    // why they are NOT exported — so a table that had only ever been written
    // about would count as covered, which is the exact opposite of what is being
    // asked. Same reason test/content.test.ts strips them.
    const gather = readFileSync('src/account/export.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
    const tables = tablesIn(schema)
    // Sanity floor, the same reason the column tests carry one: a regex that
    // stops matching would make this pass while checking nothing.
    expect(tables.length).toBeGreaterThan(20)

    // A table counts as exported when the gather names its drizzle binding.
    const camel = (t: string) => t.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    const missing = tables.filter((t) => !(t in EXCLUDED) && !new RegExp(`\\b${camel(t)}\\b`).test(gather))
    expect(missing, 'tables holding rider data that the export never reads').toEqual([])
  })

  it('excludes nothing that no longer exists', () => {
    // The mirror: a reason left behind for a table that has been renamed or
    // dropped is a reason nobody will re-examine, and it makes the list look
    // more considered than it is.
    const tables = new Set(tablesIn(readFileSync('src/db/schema.ts', 'utf8')))
    const stale = Object.keys(EXCLUDED).filter((t) => !tables.has(t))
    expect(stale, 'excluded tables that are not in the schema any more').toEqual([])
  })
})
