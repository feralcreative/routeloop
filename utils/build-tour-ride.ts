// Builds the guided tour's demo ride ONCE and exports it.
//
// Ziad's call, 2026-09-11: plan a demo route, export it to GPX, and use that
// from now on. The tour never routes live; it replays this ride. So this
// script is the one place the routing calls for the tour are ever made — it
// runs on a development machine against the dev database, and its outputs are
// what get committed:
//
//   public/tour/coast-run.gpx             the ride as GPX (the durable source)
//   public/tour/coast-run.routeloop.json  the same ride as native JSON, which
//                                         keeps the vias, groups and roles GPX
//                                         cannot carry
//
// It also leaves the ride in the dev database so the meeting-point proposal
// can be run on it from the builder (that is a second one-time call, made from
// the browser) and so the export can be re-run after that.
//
//   npx tsx utils/build-tour-ride.ts            # routes, inserts, exports
//   npx tsx utils/build-tour-ride.ts --export N # re-exports ride N only
//
// Nothing here is typed by a rider: coordinates are hand-authored and Google
// snaps them to the road. Five Routes requests, no Places request.
import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/index'
import { rides, users } from '../src/db/schema'
import { generateSlug } from '../src/maps/slug'
import { newUid } from '../src/maps/uid'
import { insertRideGraph, normalize, ridePayload, rideTotals, type RidePayload } from '../src/maps/ride-graph'
import { buildGpx, buildNativeJson, loadNativeRide, loadRideForExport } from '../src/maps/export'
import { seedOwner } from '../src/members/service'
import { seedMainGroup } from '../src/subgroups/service'
import { fetchRouteLeg } from '../src/routes/routing'

type LngLat = [number, number]

// ——— The story, as coordinates ———
//
// Oakland to Santa Cruz by way of Skyline and the coast, which is a ride people
// in the Bay Area actually do. [lng, lat] like everything else in this app.
const OAKLAND: LngLat = [-122.279, 37.7955] // Jack London Square
const ALICES: LngLat = [-122.2572, 37.3873] // Alice's Restaurant, Skyline & 84
const PESCADERO: LngLat = [-122.3836, 37.2555]
const SANTA_CRUZ: LngLat = [-122.0308, 36.9741]
const BIG_BASIN: LngLat = [-122.2224, 37.1722] // the via: inland through the redwoods instead of Highway 1
const SAN_JOSE: LngLat = [-121.8863, 37.3382]
const REDWOOD_CITY: LngLat = [-122.2364, 37.4852] // where the split-off rider heads home
const LA_HONDA: LngLat = [-122.2708, 37.3157] // the split-off's via, so it is 84 and not 1

// A wall clock carried as UTC — see public/js/route-clock.js. The tour shifts
// every time by one delta at load, so the date here is only an anchor.
const T0 = '2026-09-19T09:00:00.000Z'

const point = (
  lngLat: LngLat,
  name: string,
  opts: { kind?: 'stop' | 'poi'; roles?: string[]; durationMin?: number | null; address?: string | null } = {},
) => ({
  kind: opts.kind ?? (opts.roles?.length ? 'stop' : 'poi'),
  lng: lngLat[0],
  lat: lngLat[1],
  name,
  address: opts.address ?? null,
  description: '',
  roles: opts.roles ?? [],
  durationMin: opts.durationMin ?? null,
  slackMin: null,
  uid: newUid(),
  details: null,
})

async function leg(from: LngLat, to: LngLat, vias: LngLat[] = []) {
  const r = await fetchRouteLeg(from, to, vias)
  if (!r.ok) throw new Error(`routing failed: ${r.error}`)
  return { geometry: r.leg.geometry, distanceM: r.leg.distanceM, durationS: r.leg.durationS, viaPoints: vias }
}

async function buildPayload(): Promise<RidePayload> {
  const main = { uid: newUid(), name: 'Oakland', color: '#0066cc' }
  const sanJose = { uid: newUid(), name: 'San Jose crew', color: '#a3541c' }

  console.log('[tour] routing five legs…')
  const l1 = await leg(OAKLAND, ALICES)
  const l2 = await leg(ALICES, PESCADERO)
  const l3direct = await leg(PESCADERO, SANTA_CRUZ)
  const l3shaped = await leg(PESCADERO, SANTA_CRUZ, [BIG_BASIN])
  const home = await leg(PESCADERO, REDWOOD_CITY, [LA_HONDA])

  const raw = {
    title: 'Coast run (tour source)',
    description: 'The guided tour’s demo ride. Built by utils/build-tour-ride.ts; do not edit by hand.',
    visibility: 'private',
    external_url: '',
    subgroups: [main, sanJose],
    primarySubgroup: main.uid,
    trunkSubgroup: null,
    stopByMin: 16 * 60,
    timeAnchor: 'departure',
    routes: [
      {
        uid: newUid(),
        subgroupUid: null,
        title: 'Coast run',
        color: '#0066cc',
        startAt: T0,
        endAt: null,
        altGroup: null,
        altActive: true,
        routePrefs: null,
        points: [
          point(OAKLAND, 'Oakland', { roles: ['start'], address: 'Jack London Square, Oakland, CA' }),
          point(ALICES, 'Alice’s Restaurant', {
            roles: ['coffee'],
            durationMin: 30,
            address: '17288 Skyline Blvd, Woodside, CA 94062',
          }),
          point(PESCADERO, 'Pescadero', { roles: ['food'], durationMin: 45, address: 'Pescadero, CA 94060' }),
          point(SANTA_CRUZ, 'Santa Cruz', { roles: ['finish'], address: 'Santa Cruz, CA' }),
        ],
        legs: [l1, l2, l3shaped],
      },
      {
        // The unshaped last leg, kept as its own route so the pre-via road
        // survives the export. The tour shows this one first, then the via.
        uid: newUid(),
        subgroupUid: null,
        title: 'Pescadero to Santa Cruz, direct',
        color: '#5c5c5c',
        startAt: null,
        endAt: null,
        altGroup: null,
        altActive: true,
        routePrefs: null,
        points: [point(PESCADERO, 'Pescadero', { roles: ['start'] }), point(SANTA_CRUZ, 'Santa Cruz', { roles: ['finish'] })],
        legs: [l3direct],
      },
      {
        // A joining group contributes a starting point and nothing else.
        uid: newUid(),
        subgroupUid: sanJose.uid,
        title: 'San Jose crew',
        color: '#a3541c',
        startAt: null,
        endAt: null,
        altGroup: null,
        altActive: true,
        routePrefs: null,
        points: [point(SAN_JOSE, 'San Jose', { roles: ['start'], address: 'San Jose, CA' })],
        legs: [],
      },
      {
        // The split-off: one rider leaves at Pescadero and heads home over 84.
        uid: newUid(),
        subgroupUid: null,
        title: 'Home via 84',
        color: '#2a7a2a',
        startAt: null,
        endAt: null,
        altGroup: null,
        altActive: true,
        routePrefs: null,
        points: [point(PESCADERO, 'Pescadero', { roles: ['split'] }), point(REDWOOD_CITY, 'Redwood City', { roles: ['finish'] })],
        legs: [home],
      },
    ],
  }
  const parsed = ridePayload.safeParse(raw)
  if (!parsed.success) throw new Error(`payload invalid: ${JSON.stringify(parsed.error.issues[0])}`)
  normalize(parsed.data)
  return parsed.data
}

async function insert(p: RidePayload): Promise<number> {
  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.status, 'active')).orderBy(users.id).limit(1)
  if (!owner) throw new Error('no active user to own the ride')
  return db.transaction(async (tx) => {
    const [ride] = await tx
      .insert(rides)
      .values({
        ownerId: owner.id,
        slug: generateSlug(),
        title: p.title,
        description: p.description || null,
        visibility: p.visibility,
        source: 'native',
        ...rideTotals(p),
      })
      .returning()
    await insertRideGraph(tx, ride.id, p)
    await seedOwner(tx, ride.id, owner.id)
    await seedMainGroup(tx, ride.id)
    return ride.id
  })
}

async function exportRide(rideId: number) {
  const [ride] = await db.select().from(rides).where(eq(rides.id, rideId)).limit(1)
  if (!ride) throw new Error(`ride ${rideId} not found`)
  const meta = { title: ride.title, description: ride.description, visibility: ride.visibility, externalUrl: ride.externalUrl }
  await mkdir('public/tour', { recursive: true })
  const forExport = await loadRideForExport(rideId, meta)
  await writeFile('public/tour/coast-run.gpx', buildGpx(forExport))
  const native = await loadNativeRide(rideId, meta)
  await writeFile('public/tour/coast-run.routeloop.json', buildNativeJson(native) + '\n')
  console.log(`[tour] exported ride ${rideId} → public/tour/coast-run.gpx and coast-run.routeloop.json`)
}

async function main() {
  const i = process.argv.indexOf('--export')
  if (i > -1) {
    await exportRide(Number(process.argv[i + 1]))
  } else {
    const p = await buildPayload()
    const id = await insert(p)
    console.log(`[tour] inserted ride ${id}`)
    await exportRide(id)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
