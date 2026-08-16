/**
 * Re-cuts imported rides written before the import split its tracks into legs.
 *
 *   npx tsx utils/split-imported-legs.ts           # every day still holding one leg
 *   npx tsx utils/split-imported-legs.ts --dry-run # report, change nothing
 *   npx tsx utils/split-imported-legs.ts --ride 42 # one ride
 *
 * An imported day used to be stored as ONE route_legs row carrying the whole
 * track, however many stops sat along it. The builder's model is N stops and
 * N−1 legs, so those rides could not be opened, saved or exported as valid
 * native JSON — see src/maps/track-split.ts. New imports are split on the way
 * in; this brings the ones already in the table up to the same shape.
 *
 * WHAT IT CHANGES, and nothing else: the route_legs rows of a day, and the
 * position and dist_from_start_m of its stops (splitting puts them in
 * along-track order, which is the order their legs connect them in). Geometry
 * is only ever sliced — every coordinate written was already there, and
 * concatenating the new legs reproduces the old single leg exactly.
 *
 * IT ALSO GIVES A DAY WITH NO STOPS TWO, at the ends of its track, and that is
 * not cosmetic. Most GPX files carry a track and no waypoints at all, so a great
 * many imported days have geometry and nothing anchoring it. The builder drops a
 * day with no stops at save time — payload() filters them, because the API
 * requires at least one stop per day — so opening one of those rides and letting
 * autosave fire would have deleted the day and its track outright. Anything this
 * script leaves behind must have at least two stops.
 *
 * NOT changed: days.distance_m, days.twistiness_*, rides.total_miles and
 * rides.stop_count. All four are measured against the whole track and a change
 * in how it is sliced is not a reason for a stored figure to move.
 *
 * Idempotent — a day already carrying stops−1 legs is skipped — but it rewrites
 * the largest column in the schema, so it is refused against a non-local
 * database and wants a db-backup first regardless.
 */
import 'dotenv/config'
import { asc, eq } from 'drizzle-orm'
import { db } from '../src/db/index'
import { days, points, rides, routeLegs } from '../src/db/schema'
import { isLocalDatabaseUrl, redactDatabaseUrl } from '../src/config'
import { splitDayTrack } from '../src/maps/track-split'
import { distFromStartAlongTrack, type ExtractedPoint, type Track } from '../src/maps/kml'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const rideArg = args.indexOf('--ride')
const onlyRide = rideArg >= 0 ? Number(args[rideArg + 1]) : null

const url = process.env.DATABASE_URL ?? ''
if (!isLocalDatabaseUrl(url)) {
  console.error('Refusing to run: DATABASE_URL does not look local.')
  console.error(`  ${redactDatabaseUrl(url)}`)
  process.exit(1)
}

const imported = await db
  .select({ id: rides.id, title: rides.title })
  .from(rides)
  .where(eq(rides.source, 'imported'))
  .orderBy(asc(rides.id))

const targets = onlyRide == null ? imported : imported.filter((r) => r.id === onlyRide)

if (targets.length === 0) {
  console.log(onlyRide == null ? 'No imported rides.' : `Ride ${onlyRide} is not an imported ride.`)
  process.exit(0)
}

console.log(`${targets.length} imported ride${targets.length === 1 ? '' : 's'} to ${dryRun ? 'check' : 'split'}\n`)

let split = 0
let skipped = 0

for (const ride of targets) {
  // A day at a time: geometry is the largest column in the schema and a ride
  // can carry thirty-one days of it.
  const dayRows = await db.select().from(days).where(eq(days.rideId, ride.id)).orderBy(asc(days.position))

  for (const day of dayRows) {
    const legs = await db.select().from(routeLegs).where(eq(routeLegs.dayId, day.id)).orderBy(asc(routeLegs.position))
    const pts = await db.select().from(points).where(eq(points.dayId, day.id)).orderBy(asc(points.position))
    const stopCount = pts.filter((p) => p.kind === 'stop').length
    const label = `ride ${String(ride.id).padStart(4)} day ${day.position}`

    // Already the right shape — N stops and N−1 legs, with at least the two
    // stops a day needs to have a leg at all.
    if (stopCount >= 2 && legs.length === stopCount - 1) {
      skipped++
      continue
    }
    // Nothing to work from. A trackless import (a CSV) is a list of stops with
    // no geometry and is left exactly as it is; the builder fills its legs in
    // memory when it is opened.
    if (legs.length === 0) {
      skipped++
      continue
    }
    if (legs.length !== 1) {
      console.log(`  ${label}  SKIPPED — ${legs.length} legs against ${stopCount} stops, not a shape this wrote`)
      skipped++
      continue
    }

    // The whole-track leg is the only geometry there is; splitting it is the
    // point. Anything else means this day has already been through here.
    const track = legs[0].geometry as Track
    const extracted: ExtractedPoint[] = pts.map((p) => ({
      lat: p.lat,
      lng: p.lng,
      name: p.name,
      description: p.description,
      roles: p.roles,
      kind: p.kind,
      durationMin: p.durationMin,
    }))

    const out = splitDayTrack(track, extracted)
    const ordered = [...out.stops, ...out.pois]
    const dists = track.length > 0 ? distFromStartAlongTrack(track, ordered) : ordered.map(() => null)

    console.log(
      `  ${label}  ${String(stopCount).padStart(3)} stops  1 leg -> ${String(out.legs.length).padStart(3)} legs` +
        (out.synthesizedStart || out.synthesizedEnd ? '  +ends' : '') +
        (out.demoted > 0 ? `  ${out.demoted} demoted to POI` : ''),
    )

    if (dryRun) {
      split++
      continue
    }

    await db.transaction(async (tx) => {
      await tx.delete(routeLegs).where(eq(routeLegs.dayId, day.id))
      await tx.insert(routeLegs).values(
        out.legs.map((leg, i) => ({
          dayId: day.id,
          position: i,
          geometry: leg.geometry,
          distanceM: leg.distanceM,
        })),
      )
      // Stops are rewritten rather than deleted and re-inserted: their ids are
      // not referenced anywhere, but rewriting in place keeps the row count and
      // anything a future feature hangs off them.
      await tx.delete(points).where(eq(points.dayId, day.id))
      let stopPos = 0
      await tx.insert(points).values(
        ordered.map((p, n) => ({
          dayId: day.id,
          kind: p.kind === 'poi' ? ('poi' as const) : ('stop' as const),
          position: p.kind === 'poi' ? null : stopPos++,
          lat: p.lat,
          lng: p.lng,
          name: p.name,
          description: p.description,
          roles: p.roles,
          durationMin: p.durationMin ?? null,
          distFromStartM: dists[n],
        })),
      )
    })
    split++
  }
}

console.log(`\n${dryRun ? 'Would split' : 'Split'} ${split} day${split === 1 ? '' : 's'}, skipped ${skipped}.`)
process.exit(0)
