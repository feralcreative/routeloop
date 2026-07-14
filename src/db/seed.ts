import 'dotenv/config'
import { sql } from 'drizzle-orm'
import { db } from './index'
import { users, maps } from './schema'

// Dev seed: one user + the sample map, matching the KML/GPX already on disk at
// moto-storage/1/1.{kml,gpx} (owner id 1, map id 1 after RESTART IDENTITY).
async function main() {
  await db.execute(sql`TRUNCATE maps, user_identities, users RESTART IDENTITY CASCADE`)

  const [u] = await db
    .insert(users)
    .values({ displayName: 'Demo Rider', email: 'demo@tankbag.app' })
    .returning()

  await db.insert(maps).values({
    ownerId: u.id,
    slug: 'sample-route-one',
    title: 'Sample Route One',
    description: 'A seeded demo route so the viewer has something to render.',
    color: '#0066cc',
    visibility: 'public',
    gpxPresent: true,
    waypointCount: 12,
    totalMiles: '52.4',
    kmlBytes: 134565,
    gpxBytes: 247907,
  })

  console.log(`seeded user #${u.id} + map 'sample-route-one'`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
