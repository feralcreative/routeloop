/**
 * Rewrites stored times that were saved as instants into the wall clock the
 * rider actually typed.
 *
 *   npx tsx utils/shift-days-to-wall-clock.ts --zone America/Los_Angeles --dry-run
 *   npx tsx utils/shift-days-to-wall-clock.ts --zone America/Los_Angeles
 *
 * A DAY'S CLOCK IS A WALL CLOCK AT THE DEPARTURE POINT as of 2026-08-24, carried
 * as UTC — see the header of public/js/day-clock.js. Everything written before
 * that carries an INSTANT instead: the builder took the digits out of a
 * `datetime-local` field and attached the browser's offset, so a 9am departure
 * planned in California is sitting in the table as `16:00+00`. Every surface
 * that renders one reads it as UTC, which is why the printed roadbook said
 * 4:00 PM for a day the builder showed as 9:00 AM.
 *
 * There is no schema change and nothing rejects the old rows, so this is a data
 * migration that fails silently if it is skipped — the same shape as
 * utils/split-imported-legs.ts, and for the same reason it is a script rather
 * than a file in drizzle/.
 *
 * `--zone` IS REQUIRED AND IS A GUESS, which is the honest thing to say about
 * it. The zone a row was typed in was never stored; that is the whole bug. All
 * this can do is un-apply an offset the caller names, so pass the zone the rides
 * were actually planned in. A ride planned in one zone and stamped with another
 * comes out wrong by the difference.
 *
 * WHAT IT CHANGES: days.start_at, days.end_at, point_details.check_in_at and
 * point_details.check_out_at. Nothing else — no schema, no geometry, no caches.
 *
 * NOT IDEMPOTENT, and it cannot be made so: a row holding 09:00 is
 * indistinguishable from one holding 09:00 that has already been shifted. Run it
 * once, after a db-backup, and use --dry-run first. It is refused against a
 * non-local database.
 */
import 'dotenv/config'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/index'
import { isLocalDatabaseUrl, redactDatabaseUrl } from '../src/config'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const zoneArg = args.indexOf('--zone')
const zone = zoneArg >= 0 ? args[zoneArg + 1] : null

if (!zone) {
  console.error('Refusing to guess: pass --zone, e.g. --zone America/Los_Angeles')
  console.error('It is the zone the rides were PLANNED in, which nothing recorded.')
  process.exit(1)
}

// Belt and braces. The zone is BOUND as a parameter everywhere below, so this is
// not what stands between an operator and an injection — it is here to reject a
// typo with a sentence rather than a Postgres error.
if (!/^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)*$/.test(zone)) {
  console.error(`That does not look like an IANA zone name: ${zone}`)
  process.exit(1)
}

const url = process.env.DATABASE_URL ?? ''
if (!isLocalDatabaseUrl(url)) {
  console.error('Refusing to run: DATABASE_URL does not look local.')
  console.error(`  ${redactDatabaseUrl(url)}`)
  process.exit(1)
}

// Postgres rejects an unknown zone name at statement time, which would leave a
// half-applied run. Ask it up front instead — after the local check, so a remote
// database is never touched at all.
const known = await db
  .execute(sql`select (now() at time zone ${zone}) is not null as ok`)
  .then((r: any) => Boolean(r.rows?.[0]?.ok))
if (!known) {
  console.error(`Postgres does not know the zone ${zone}.`)
  process.exit(1)
}

// `x at time zone $zone` turns the stored instant into the naive wall clock a
// rider in that zone saw. `at time zone 'UTC'` then pins those same digits back
// into the column as UTC, which is the carrier the app now reads. Two steps, not
// one: assigning a naive timestamp straight into a timestamptz column would
// interpret it in the SESSION's zone, which is neither of the two we mean.
//
// Only the COLUMN NAME is raw — a parameter cannot name a column. The zone is
// bound like any other value.
const toWallClock = (col: string) => sql`(${sql.raw(col)} at time zone ${zone}) at time zone 'UTC'`

const before = await db
  .execute(
    sql`select
          (select count(*) from days where start_at is not null or end_at is not null) as days,
          (select count(*) from point_details where check_in_at is not null or check_out_at is not null) as details`,
  )
  .then((r: any) => r.rows[0] as { days: number; details: number })

console.log(`Zone: ${zone}`)
console.log(`Days with a time: ${before.days}`)
console.log(`Stop details with a time: ${before.details}`)

if (dryRun) {
  const sample = await db
    .execute(
      sql`select id, start_at::text as was, ${toWallClock('start_at')}::text as becomes
          from days where start_at is not null order by id limit 5`,
    )
    .then((r: any) => r.rows as { id: number; was: string; becomes: string }[])
  console.log('\nFirst few day starts:')
  for (const r of sample) console.log(`  day ${r.id}: ${r.was}  ->  ${r.becomes}`)
  console.log('\nDry run—nothing written.')
  process.exit(0)
}

await db.transaction(async (tx) => {
  await tx.execute(sql`update days set start_at = ${toWallClock('start_at')} where start_at is not null`)
  await tx.execute(sql`update days set end_at = ${toWallClock('end_at')} where end_at is not null`)
  await tx.execute(
    sql`update point_details set check_in_at = ${toWallClock('check_in_at')} where check_in_at is not null`,
  )
  await tx.execute(
    sql`update point_details set check_out_at = ${toWallClock('check_out_at')} where check_out_at is not null`,
  )
})

console.log(
  `\nShifted ${before.days} day${before.days === 1 ? '' : 's'} and ${before.details} stop detail${before.details === 1 ? '' : 's'}.`,
)
process.exit(0)
