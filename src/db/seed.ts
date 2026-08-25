import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { newUid } from '../maps/uid'
import { sql } from 'drizzle-orm'
import { db } from './index'
import { users, rides, days, points, routeLegs } from './schema'
import { distFromStartAlongTrack, METERS_PER_MILE, processKml } from '../maps/kml'

// Dev seed: one user + the sample ride, structured rows extracted from the KML
// already on disk at storage/1/1.kml (owner id 1, ride id 1 after
// RESTART IDENTITY) — so dev exercises the same rows the import pipeline and
// the builder produce.
async function main() {
  await db.execute(sql`TRUNCATE rides, user_identities, users RESTART IDENTITY CASCADE`)

  const [u] = await db
    .insert(users)
    // The dev owner: active (the schema default) and able to manage riders, so
    // /admin is reachable locally without a hand-written UPDATE.
    .values({ displayName: 'Demo Rider', email: 'demo@routeloop.app', canManageRiders: true })
    .returning()

  const kml = processKml(await readFile('storage/1/1.kml', 'utf8'))
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
      stopCount: kml.points.length,
      kmlBytes: 134565,
      gpxBytes: 247907,
    })
    .returning()

  const [route] = await db
    .insert(days)
    .values({ rideId: ride.id, position: 0, color: '#0066cc', distanceM: distM })
    .returning()

  const stopDists = distFromStartAlongTrack(kml.track, kml.points)
  if (kml.points.length > 0) {
    await db.insert(points).values(
      kml.points.map((p, i) => ({
        dayId: route.id,
        kind: 'stop' as const,
        position: i,
        uid: newUid(),
        lat: p.lat,
        lng: p.lng,
        name: p.name,
        description: p.description,
        roles: p.roles,
        distFromStartM: stopDists[i],
      })),
    )
  }
  await db.insert(routeLegs).values({ dayId: route.id, position: 0, geometry: kml.track, distanceM: distM })

  console.log(
    `seeded user #${u.id} + ride 'sample-route-one' (${kml.points.length} stops, ${(kml.trackMeters / METERS_PER_MILE).toFixed(1)} mi)`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
