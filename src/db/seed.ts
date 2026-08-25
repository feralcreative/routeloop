import 'dotenv/config'
import { access, readFile } from 'node:fs/promises'
import { newUid } from '../maps/uid'
import { sql } from 'drizzle-orm'
import { db } from './index'
import { users, rides, days, points, routeLegs } from './schema'
import { METERS_PER_MILE, processKml } from '../maps/kml'
import { mapFilePath } from '../maps/storage'
import { splitDayTrack } from '../maps/track-split'

// Dev seed: one user + the sample ride, structured rows extracted from a real
// KML — so dev exercises the same rows the import pipeline and the builder
// produce, rather than synthetic geometry that cannot reproduce an import bug.
//
// WHERE THE KML COMES FROM, and why there are two answers.
//
// The good one is the rider's own storage: owner 1, ride 1, which is what the
// ids come out as after the TRUNCATE below RESTARTs IDENTITY. That is a real
// 185-mile import and by far the better dev dataset.
//
// It is also GITIGNORED, so it is not there on a fresh clone, on CI, or on a
// second machine whose storage has not synced — and this used to be a hardcoded
// relative `storage/1/1.kml` that ignored STORAGE_PATH entirely. When the file
// was missing the failure was a bare ENOENT from readFile, thrown AFTER the
// TRUNCATE had already run, so the seed emptied the database and then died. That
// is how it was actually met: the path was stale after the project moved, and
// the reported symptom was `npm run dev` failing with no usable error.
//
// So: ask the storage layer for the path rather than building one, and fall back
// to the committed fixture when it is not there. The fixture is a small ride
// rather than a good one, so this says which it used.
const SEED_KML = mapFilePath(1, 1, 'kml')
const FIXTURE_KML = 'test/fixtures/coast-run.kml'

const exists = async (p: string) =>
  await access(p).then(
    () => true,
    () => false,
  )

async function seedKmlPath(): Promise<string> {
  if (SEED_KML && (await exists(SEED_KML))) return SEED_KML
  if (await exists(FIXTURE_KML)) {
    console.log(`  ! ${SEED_KML ?? 'storage'} not found — falling back to ${FIXTURE_KML} (a much smaller ride)`)
    return FIXTURE_KML
  }
  throw new Error(`no seed KML: looked for ${SEED_KML ?? '<storage>'} and ${FIXTURE_KML}`)
}

async function main() {
  // RESOLVED AND READ BEFORE THE TRUNCATE, which is the whole point. Every way
  // this can fail — no file, unreadable file, KML that does not parse — has to
  // fail while the database is still intact.
  const kmlPath = await seedKmlPath()
  const kmlText = await readFile(kmlPath, 'utf8')
  const kml = processKml(kmlText)
  if (kml.track.length < 2) throw new Error(`${kmlPath} has no usable track`)

  // ONE LEG PER PAIR OF POINTS, cut from the KML track — the same shape the
  // import path writes, and the shape daySchema requires.
  //
  // This used to write the whole track as a SINGLE leg alongside N stops, which
  // was the pre-track-split import shape: a seeded sample ride could not be
  // opened in the builder, and autosave on it would have failed validation every
  // time. See src/maps/track-split.ts.
  //
  // Computed up here with the parse rather than after the inserts, so the ride's
  // stop_count can be taken from it — and so anything it can throw on throws
  // while the database is still intact.
  const split = splitDayTrack(kml.track, kml.points)

  await db.execute(sql`TRUNCATE rides, user_identities, users RESTART IDENTITY CASCADE`)

  const [u] = await db
    .insert(users)
    // The dev owner: active (the schema default) and able to manage riders, so
    // /admin is reachable locally without a hand-written UPDATE.
    .values({ displayName: 'Demo Rider', email: 'demo@routeloop.app', canManageRiders: true })
    .returning()

  const distM = Math.round(kml.trackMeters)

  const [ride] = await db
    .insert(rides)
    .values({
      ownerId: u.id,
      slug: 'sample-route-one',
      title: 'Sample Route One',
      description: 'A seeded demo route so the viewer has something to render.',
      visibility: 'public',
      source: 'imported',
      gpxPresent: true,
      totalMiles: (kml.trackMeters / METERS_PER_MILE).toFixed(1),
      // The stops of the SPLIT list, not the raw KML waypoint count. splitDayTrack
      // can synthesize an endpoint, and a point it places is not necessarily a
      // stop — so the raw count drifts from what rideTotals() would compute for
      // the same ride.
      stopCount: split.points.filter((p) => p.kind !== 'poi').length,
      kmlBytes: 134565,
      gpxBytes: 247907,
    })
    .returning()

  const [route] = await db
    .insert(days)
    .values({ rideId: ride.id, position: 0, color: '#0066cc', distanceM: distM })
    .returning()

  const prefix: number[] = [0]
  for (const l of split.legs) prefix.push(prefix[prefix.length - 1] + l.distanceM)

  if (split.points.length > 0) {
    await db.insert(points).values(
      split.points.map((p, i) => ({
        dayId: route.id,
        kind: p.kind === 'poi' ? ('poi' as const) : ('stop' as const),
        position: i,
        uid: newUid(),
        lat: p.lat,
        lng: p.lng,
        name: p.name,
        description: p.description,
        roles: p.roles,
        distFromStartM: prefix[Math.min(i, prefix.length - 1)],
      })),
    )
  }
  if (split.legs.length > 0) {
    await db.insert(routeLegs).values(
      split.legs.map((l, i) => ({ dayId: route.id, position: i, geometry: l.geometry, distanceM: l.distanceM })),
    )
  }

  console.log(
    `seeded user #${u.id} + ride 'sample-route-one' (${split.points.length} points, ${(kml.trackMeters / METERS_PER_MILE).toFixed(1)} mi)`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
