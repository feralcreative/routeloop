/**
 * Fills in days.twistiness_dpm / twistiness_best_dpm for rows written before
 * those columns existed.
 *
 *   npx tsx utils/backfill-twistiness.ts           # only rows that are null
 *   npx tsx utils/backfill-twistiness.ts --all     # recompute every row
 *   npx tsx utils/backfill-twistiness.ts --dry-run # report, change nothing
 *
 * --all is the one to reach for after changing the thresholds in
 * src/maps/twist.ts, since every stored figure is then stale.
 *
 * Reads geometry only and writes two integers, so it is safe to re-run. It is
 * still refused against a non-local database: this walks every leg of every
 * day in the table, which is not something to point at production casually.
 */
import 'dotenv/config'
import { asc, isNull, or } from 'drizzle-orm'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/index'
import { days, routeLegs } from '../src/db/schema'
import { isLocalDatabaseUrl, redactDatabaseUrl } from '../src/config'
import { twistiness, twistLabel } from '../src/maps/twist'
import type { Track } from '../src/maps/kml'

const args = process.argv.slice(2)
const all = args.includes('--all')
const dryRun = args.includes('--dry-run')

const url = process.env.DATABASE_URL ?? ''
if (!isLocalDatabaseUrl(url)) {
  console.error('Refusing to run: DATABASE_URL does not look local.')
  console.error(`  ${redactDatabaseUrl(url)}`)
  process.exit(1)
}

const targets = all
  ? await db.select().from(days).orderBy(asc(days.id))
  : await db
      .select()
      .from(days)
      .where(or(isNull(days.twistinessDpm), isNull(days.twistinessBestDpm)))
      .orderBy(asc(days.id))

if (targets.length === 0) {
  console.log('Nothing to do—every day already has a figure.')
  process.exit(0)
}

console.log(`${targets.length} day${targets.length === 1 ? '' : 's'} to ${dryRun ? 'check' : 'update'}\n`)

let written = 0
let skipped = 0

for (const day of targets) {
  // One day at a time rather than loading every leg in the database at once:
  // geometry is the largest column in the schema and a full trip's worth of it
  // does not need to be resident to compute one number.
  const legs = await db
    .select({ geometry: routeLegs.geometry })
    .from(routeLegs)
    .where(eq(routeLegs.dayId, day.id))
    .orderBy(asc(routeLegs.position))

  const track = legs.flatMap((l) => (l.geometry ?? []) as Track) as Track
  const twist = twistiness(track)

  if (!twist) {
    // Left null, not zeroed. A day with no geometry has not been measured;
    // saying "straight" would be a claim the data does not support.
    skipped++
    console.log(`  day ${String(day.id).padStart(4)}  no geometry, left null`)
    continue
  }

  if (!dryRun) {
    await db
      .update(days)
      .set({ twistinessDpm: twist.dpm, twistinessBestDpm: twist.bestDpm })
      .where(eq(days.id, day.id))
  }
  written++
  console.log(
    `  day ${String(day.id).padStart(4)}  ${String(twist.dpm).padStart(4)}°/mi` +
      `  best ${String(twist.bestDpm).padStart(4)} over ${String(twist.bestMiles).padStart(4)} mi` +
      `  ${twistLabel(twist.dpm)}`,
  )
}

console.log(`\n${dryRun ? 'Would update' : 'Updated'} ${written}, left ${skipped} null.`)
process.exit(0)
