/**
 * Re-cuts stored rides whose legs do not match the current N points, N−1 rule.
 *
 *   npx tsx utils/split-imported-legs.ts           # every day with the wrong leg count
 *   npx tsx utils/split-imported-legs.ts --dry-run # report, change nothing
 *   npx tsx utils/split-imported-legs.ts --ride 42 # one ride
 *
 * An imported day used to be stored as ONE route_legs row carrying the whole
 * track, however many points sat along it. The builder's model is N points and
 * N−1 legs, so those rides could not be opened, saved or exported as valid
 * native JSON — see src/maps/track-split.ts. New imports are split on the way
 * in; this brings the ones already in the table up to the same shape.
 *
 * BOTH KINDS ANCHOR A LEG as of 2026-08-24, so the target shape is points−1 legs
 * rather than stops−1. That makes EVERY day written before that date with a POI on
 * it work to do, not just the unsplit imports this script was written for — a day
 * carrying stops−1 legs opens in the builder and gets straight placeholder legs
 * drawn out to each POI and back, silently, on the first edit. Run this before
 * anyone opens a ride that predates the change.
 *
 * The two shapes are treated differently and the day loop says why: one leg means
 * an unsplit import whose point order came out of a file, so it is sorted along
 * the track; several legs means a day somebody arranged, so the order is kept and
 * only the cuts move.
 *
 * WHAT IT CHANGES, and nothing else: the route_legs rows of a day, and the
 * position and dist_from_start_m of its points (splitting puts them in
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
 * Idempotent — a day already carrying points−1 legs is skipped — but it rewrites
 * the largest column in the schema, so it is refused against a non-local
 * database and wants a db-backup first regardless.
 */
import 'dotenv/config'
import { asc, eq } from 'drizzle-orm'
import { db } from '../src/db/index'
import { days, points, rides, routeLegs } from '../src/db/schema'
import { isLocalDatabaseUrl, redactDatabaseUrl } from '../src/config'
import { concatSplitLegs, relegDay, splitDayTrack } from '../src/maps/track-split'
import { type ExtractedPoint, type Track } from '../src/maps/kml'
import { newUid } from '../src/maps/uid'

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
    const label = `ride ${String(ride.id).padStart(4)} day ${day.position}`

    // Already the right shape — N points and N−1 legs, with at least the two
    // points a day needs to have a leg at all.
    if (pts.length >= 2 && legs.length === pts.length - 1) {
      skipped++
      continue
    }
    // Nothing to work from. A trackless import (a CSV) is a list of points with
    // no geometry and is left exactly as it is; the builder fills its legs in
    // memory when it is opened.
    if (legs.length === 0) {
      skipped++
      continue
    }
    // TWO SHAPES REACH HERE AND THEY NEED DIFFERENT TREATMENT.
    //
    // ONE leg is an unsplit import: the whole track in a single row, with points
    // whose order came out of a file and means nothing. splitDayTrack projects
    // them and sorts along the track, which is the only order available.
    //
    // SEVERAL legs is a day written under the pre-2026-08-24 rule — stops−1 legs,
    // with POIs sitting inside them anchoring nothing. Those points ARE in the
    // rider's order, so relegDay keeps it and re-cuts the concatenated track at
    // every one of them. Sorting here would rearrange a day somebody arranged.
    //
    // Left alone by both: nothing. Every day that reaches this line has geometry
    // and the wrong number of legs, and opening one in the builder would have it
    // silently filled with straight placeholder legs out to each POI and back.
    const track = concatSplitLegs(legs as Array<{ geometry: Track }>)
    const unsplit = legs.length === 1
    // The uid rides along, which ExtractedPoint has no field for — it is carried
    // through splitDayTrack's sort at runtime and read back off the other side
    // with a cast. A point's uid is its durable identity and what point_details
    // is keyed by, so minting fresh ones here would orphan every gate code and
    // confirmation number on the day. A synthesized endpoint has none and gets
    // one below.
    const extracted = pts.map((p) => ({
      lat: p.lat,
      lng: p.lng,
      name: p.name,
      description: p.description,
      roles: p.roles,
      kind: p.kind,
      durationMin: p.durationMin,
      uid: p.uid,
    })) as ExtractedPoint[]

    const out = unsplit
      ? splitDayTrack(track, extracted)
      : { points: extracted, legs: relegDay(track, extracted), synthesizedStart: false, synthesizedEnd: false }
    const ordered = out.points as Array<ExtractedPoint & { uid?: string }>
    // The prefix sum of the new legs, which is what insertRideGraph writes and
    // what a point's distance from the start now means. This used to project each
    // point onto the track; the prefix is exact and never null.
    const prefix: number[] = [0]
    for (const leg of out.legs) prefix.push(prefix[prefix.length - 1] + leg.distanceM)

    console.log(
      `  ${label}  ${String(ordered.length).padStart(3)} points  ` +
        `${String(legs.length).padStart(3)} leg${legs.length === 1 ? ' ' : 's'} -> ${String(out.legs.length).padStart(3)} legs` +
        (out.synthesizedStart || out.synthesizedEnd ? '  +ends' : ''),
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
      // Deleted and re-inserted rather than updated in place: the split reorders
      // them, so every row's position changes and there is no stable pairing to
      // update against. `points.id` is referenced by nothing — `uid` is the
      // durable identity and it is carried across, which is what keeps each
      // point's private details attached.
      await tx.delete(points).where(eq(points.dayId, day.id))
      await tx.insert(points).values(
        ordered.map((p, n) => ({
          dayId: day.id,
          kind: p.kind === 'poi' ? ('poi' as const) : ('stop' as const),
          // DENSE OVER BOTH KINDS. This wrote `null` for every POI, which was the
          // model until 2026-08-23 and has been a NOT NULL violation since — the
          // script would have thrown on the first day carrying a POI.
          position: n,
          lat: p.lat,
          lng: p.lng,
          name: p.name,
          description: p.description,
          roles: p.roles,
          durationMin: p.durationMin ?? null,
          distFromStartM: prefix[Math.min(n, prefix.length - 1)],
          // The THIRD place points are inserted, and it supplied no uid at all —
          // also a NOT NULL violation, and one that would have hit every day.
          uid: p.uid ?? newUid(),
        })),
      )
    })
    split++
  }
}

console.log(`\n${dryRun ? 'Would split' : 'Split'} ${split} day${split === 1 ? '' : 's'}, skipped ${skipped}.`)
process.exit(0)
