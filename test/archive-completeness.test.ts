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
