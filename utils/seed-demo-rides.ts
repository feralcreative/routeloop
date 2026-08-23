/**
 * Demo ride generator — populates the dev database with enough varied rides to
 * see what the dashboard, the public listing and the viewer actually look like
 * in use, rather than with one seeded sample.
 *
 *   npx tsx utils/seed-demo-rides.ts            # ~12 rides, appended
 *   npx tsx utils/seed-demo-rides.ts --reset    # delete demo rides first
 *   npx tsx utils/seed-demo-rides.ts --straight # no API calls, straight legs
 *   npx tsx utils/seed-demo-rides.ts --owner=me@example.com
 *   npx tsx utils/seed-demo-rides.ts --count=20
 *
 * Legs are routed through the real Routes API so the tracks follow actual
 * roads — a viewer full of straight lines tells you nothing about how the
 * product reads. That costs one billable call per leg, so the results are
 * cached on disk between runs and --straight skips routing entirely.
 *
 * DEV ONLY. It refuses to run against anything but a local database.
 */
import 'dotenv/config'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { and, eq, inArray, like } from 'drizzle-orm'
import { db } from '../src/db/index'
import { users, rides, days, points, routeLegs, waypointRoleEnum } from '../src/db/schema'
import { generateSlug } from '../src/maps/slug'
import { newUid } from '../src/maps/uid'
import { GMAPS_SERVER_KEY, OWNER_EMAIL, isLocalDatabaseUrl, redactDatabaseUrl } from '../src/config'

// schema.ts exports row types but not the role union, so derive it from the
// enum itself — that way adding a role in one place cannot drift from this file.
type WaypointRole = (typeof waypointRoleEnum.enumValues)[number]

const METERS_PER_MILE = 1609.344
const CACHE_PATH = 'utils/.demo-route-cache.json'

// Demo rides are tagged in the description so --reset can find and remove them
// without touching anything you built by hand.
const DEMO_MARKER = '[demo]'

type LngLat = [number, number]
type Stop = { name: string; lngLat: LngLat; roles: WaypointRole[]; durationMin?: number | null }
type Leg = { geometry: LngLat[]; distanceM: number; durationS: number }

// ---------------------------------------------------------------- guard ------

// A generator that TRUNCATEs and inserts a dozen fake rides must never point at
// a deployed database. The test itself lives in config.ts, because the dev
// sign-in route needs the same answer and two copies of it could drift.
function assertLocal(): void {
  const url = process.env.DATABASE_URL ?? ''
  if (!isLocalDatabaseUrl(url)) {
    console.error('Refusing to run: DATABASE_URL does not look local.')
    console.error(`  ${redactDatabaseUrl(url)}`)
    process.exit(1)
  }
}

// ------------------------------------------------------------- ingredients ---

// Real places, so the routing engine returns real roads and the map looks like
// somewhere. Roughly grouped by region so a ride's stops are plausibly a day.
const REGIONS: { name: string; places: { name: string; lngLat: LngLat }[] }[] = [
  {
    name: 'Sierra',
    places: [
      { name: 'Oakdale', lngLat: [-120.8471, 37.7666] },
      { name: 'Sonora', lngLat: [-120.3822, 37.9829] },
      { name: 'Twain Harte', lngLat: [-120.2277, 38.0385] },
      { name: 'Pinecrest', lngLat: [-120.0093, 38.1929] },
      { name: 'Kennedy Meadows', lngLat: [-119.7452, 38.3199] },
      { name: 'Bridgeport', lngLat: [-119.2312, 38.2555] },
      { name: 'Lee Vining', lngLat: [-119.1207, 37.9575] },
      { name: 'Mammoth Lakes', lngLat: [-118.9723, 37.6485] },
    ],
  },
  {
    name: 'Coast',
    places: [
      { name: 'Half Moon Bay', lngLat: [-122.4286, 37.4636] },
      { name: 'Pescadero', lngLat: [-122.3833, 37.2552] },
      { name: 'Davenport', lngLat: [-122.1972, 37.0113] },
      { name: 'Santa Cruz', lngLat: [-122.0308, 36.9741] },
      { name: 'Watsonville', lngLat: [-121.7569, 36.9102] },
      { name: 'Monterey', lngLat: [-121.8947, 36.6002] },
      { name: 'Carmel Valley', lngLat: [-121.7269, 36.4794] },
      { name: 'Big Sur', lngLat: [-121.8081, 36.2704] },
    ],
  },
  {
    name: 'North Bay',
    places: [
      { name: 'Fairfax', lngLat: [-122.5886, 37.9871] },
      { name: 'Point Reyes Station', lngLat: [-122.8064, 38.0685] },
      { name: 'Marshall', lngLat: [-122.8955, 38.1613] },
      { name: 'Bodega Bay', lngLat: [-123.0481, 38.3332] },
      { name: 'Jenner', lngLat: [-123.1147, 38.4499] },
      { name: 'Guerneville', lngLat: [-122.9958, 38.5016] },
      { name: 'Healdsburg', lngLat: [-122.8692, 38.6102] },
      { name: 'Calistoga', lngLat: [-122.5797, 38.5788] },
    ],
  },
  {
    name: 'Desert',
    places: [
      { name: 'Barstow', lngLat: [-117.0228, 34.8958] },
      { name: 'Victorville', lngLat: [-117.2911, 34.5362] },
      { name: 'Lucerne Valley', lngLat: [-116.9631, 34.4436] },
      { name: 'Yucca Valley', lngLat: [-116.4322, 34.1142] },
      { name: 'Joshua Tree', lngLat: [-116.3131, 34.1345] },
      { name: 'Twentynine Palms', lngLat: [-116.0542, 34.1356] },
      { name: 'Amboy', lngLat: [-115.7444, 34.5578] },
      { name: 'Ludlow', lngLat: [-116.1633, 34.7203] },
    ],
  },
  {
    name: 'Cascades',
    places: [
      { name: 'Redding', lngLat: [-122.3917, 40.5865] },
      { name: 'Shasta Lake', lngLat: [-122.3711, 40.6799] },
      { name: 'McCloud', lngLat: [-122.1391, 41.2529] },
      { name: 'Mount Shasta', lngLat: [-122.3103, 41.3099] },
      { name: 'Weed', lngLat: [-122.3861, 41.4227] },
      { name: 'Etna', lngLat: [-122.8947, 41.4568] },
      { name: 'Yreka', lngLat: [-122.6347, 41.7354] },
      { name: 'Happy Camp', lngLat: [-123.3789, 41.7932] },
    ],
  },
]

const TITLE_SHAPES = [
  (a: string, b: string) => `${a} to ${b}`,
  (a: string, b: string) => `${a} → ${b} loop`,
  (a: string) => `${a} run`,
  (a: string, b: string) => `The long way to ${b}`,
  (a: string) => `${a} breakfast ride`,
  (a: string, b: string) => `${a}/${b} overnighter`,
  (a: string) => `Sunday ${a} blast`,
  (a: string, b: string) => `${b} via the back roads`,
]

const DESCRIPTIONS = [
  'Mostly twisties, one long straight in the middle to stretch.',
  'Fuel before you leave, the middle section has nothing for 80 miles.',
  'Cold in the morning, layer up. Great pavement the whole way.',
  'Slow going in places—gravel on the corners after the last storm.',
  'The classic. Ridden it a dozen times and it never gets old.',
  'Backroad alternative to the usual slab route. Adds an hour, worth it.',
  '',
  '',
]

const ROUTE_COLORS = [
  '#0066cc', '#cc0000', '#8800dd', '#ff6f00', '#dd00dd', '#006064',
  '#4a148c', '#4e342e', '#00aaaa', '#a0740b', '#003300', '#550000',
]

const STOP_FLAVOR: { roles: WaypointRole[]; names: string[]; dur?: [number, number] }[] = [
  { roles: ['gas'], names: ['Chevron', 'Shell', '76', 'Valero', 'Arco'], dur: [5, 15] },
  { roles: ['food'], names: ['The Diner', 'Roadside Cafe', 'Taqueria', 'Burger stand'], dur: [30, 75] },
  { roles: ['coffee'], names: ['Coffee stop', 'Espresso bar', 'The roastery'], dur: [15, 30] },
  { roles: ['view'], names: ['Overlook', 'Vista point', 'The pullout', 'Summit view'], dur: [10, 20] },
  { roles: ['gas', 'food'], names: ['Fuel + lunch', 'Truck stop'], dur: [40, 60] },
  { roles: ['break'], names: ['Leg stretch', 'Shade break', 'Regroup'], dur: [10, 20] },
  { roles: ['camp'], names: ['Campground', 'The dispersed spot'], dur: [600, 720] },
  { roles: ['hotel'], names: ['Motel', 'The inn', 'Lodge'], dur: [540, 660] },
  { roles: ['drinks'], names: ['The saloon', 'Brewery'], dur: [45, 90] },
  { roles: ['grocery'], names: ['Market', 'General store'], dur: [15, 25] },
  { roles: ['meet'], names: ['Meet point', 'Parking lot rendezvous'], dur: [15, 30] },
  { roles: ['wtf'], names: ['The giant thermometer', 'Roadside dinosaur', 'Shoe tree'], dur: [10, 20] },
]

const POI_FLAVOR: { roles: WaypointRole[]; names: string[] }[] = [
  { roles: ['view'], names: ['Nice view here', 'Photo spot', 'Canyon overlook'] },
  { roles: ['poi'], names: ['Old bridge', 'Historic marker', 'Abandoned station'] },
  { roles: ['wtf'], names: ['What even is this', 'Unexplained statue'] },
  { roles: [], names: ['Watch for gravel', 'Blind crest', 'Cattle on road'] },
]

// ------------------------------------------------------------------ rng -------

// Seeded so repeated runs produce the same set — a demo database that reshuffles
// every time makes it impossible to tell a UI change from new data.
let seed = 0x5eed
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0x100000000
}
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]
const between = (lo: number, hi: number): number => Math.floor(rnd() * (hi - lo + 1)) + lo

function shuffled<T>(a: T[]): T[] {
  const c = [...a]
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[c[i], c[j]] = [c[j], c[i]]
  }
  return c
}

// -------------------------------------------------------------- routing ------

type Cache = Record<string, Leg>
let cache: Cache = {}

async function loadCache(): Promise<void> {
  try {
    cache = JSON.parse(await readFile(CACHE_PATH, 'utf8')) as Cache
  } catch {
    cache = {}
  }
}
async function saveCache(): Promise<void> {
  await mkdir('utils', { recursive: true })
  await writeFile(CACHE_PATH, JSON.stringify(cache), 'utf8')
}

const key = (a: LngLat, b: LngLat) => `${a[0]},${a[1]}>${b[0]},${b[1]}`

function haversine(coords: LngLat[]): number {
  let m = 0
  for (let i = 1; i < coords.length; i++) {
    const [lng1, lat1] = coords[i - 1]
    const [lng2, lat2] = coords[i]
    const rad = Math.PI / 180
    const dLat = (lat2 - lat1) * rad
    const dLng = (lng2 - lng1) * rad
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2
    m += 2 * 6371008.8 * Math.asin(Math.sqrt(h))
  }
  return m
}

function straightLeg(a: LngLat, b: LngLat): Leg {
  const geometry: LngLat[] = [a, b]
  const distanceM = Math.round(haversine(geometry))
  return { geometry, distanceM, durationS: Math.round(distanceM / 20) }
}

// DRIVE, not TWO_WHEELER — the latter returns an empty 200 outside a few Asian
// markets. Same reasoning as src/routes/routing.ts; see docs/STATUS.md.
async function routeLeg(a: LngLat, b: LngLat, straightOnly: boolean): Promise<Leg> {
  if (straightOnly) return straightLeg(a, b)
  const k = key(a, b)
  if (cache[k]) return cache[k]
  if (!GMAPS_SERVER_KEY) return straightLeg(a, b)

  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GMAPS_SERVER_KEY,
      'X-Goog-FieldMask': 'routes.polyline.geoJsonLinestring,routes.distanceMeters,routes.duration',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: a[1], longitude: a[0] } } },
      destination: { location: { latLng: { latitude: b[1], longitude: b[0] } } },
      travelMode: 'DRIVE',
      polylineEncoding: 'GEO_JSON_LINESTRING',
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)

  if (!res || !res.ok) return straightLeg(a, b)
  const data = (await res.json().catch(() => null)) as {
    routes?: { polyline?: { geoJsonLinestring?: { coordinates?: unknown } }; distanceMeters?: number; duration?: unknown }[]
  } | null

  const r = data?.routes?.[0]
  const raw = r?.polyline?.geoJsonLinestring?.coordinates
  if (!r || !Array.isArray(raw) || raw.length < 2) return straightLeg(a, b)

  const round6 = (n: number) => Math.round(n * 1e6) / 1e6
  const geometry: LngLat[] = []
  for (const p of raw as unknown[]) {
    if (!Array.isArray(p) || p.length < 2) continue
    const lng = Number(p[0])
    const lat = Number(p[1])
    if (Number.isFinite(lng) && Number.isFinite(lat)) geometry.push([round6(lng), round6(lat)])
  }
  if (geometry.length < 2) return straightLeg(a, b)

  const durS = typeof r.duration === 'string' ? Math.round(Number.parseFloat(r.duration.replace(/s$/, ''))) : 0
  const leg: Leg = {
    geometry,
    distanceM: Math.round(Number(r.distanceMeters) || 0),
    durationS: Number.isFinite(durS) ? durS : 0,
  }
  cache[k] = leg
  return leg
}

// ------------------------------------------------------------ generation -----

function makeStops(region: (typeof REGIONS)[number], count: number): Stop[] {
  const places = shuffled(region.places).slice(0, count)
  return places.map((p, i) => {
    // The first stop starts the ride and the last one ends it; neither carries
    // a duration, which is how the schema models "ends".
    if (i === 0) return { name: p.name, lngLat: p.lngLat, roles: ['start' as WaypointRole], durationMin: null }
    if (i === places.length - 1) {
      return { name: p.name, lngLat: p.lngLat, roles: ['finish' as WaypointRole], durationMin: null }
    }
    const flavor = pick(STOP_FLAVOR)
    const dur = flavor.dur ? between(flavor.dur[0], flavor.dur[1]) : null
    return { name: `${pick(flavor.names)}, ${p.name}`, lngLat: p.lngLat, roles: flavor.roles, durationMin: dur }
  })
}

// POIs sit near the track without being on it — nudged off a random track point
// so they read as things you passed rather than stops you made.
function makePois(track: LngLat[], count: number) {
  const out: { name: string; lngLat: LngLat; roles: WaypointRole[] }[] = []
  if (track.length < 3) return out
  for (let i = 0; i < count; i++) {
    const at = track[between(1, track.length - 2)]
    const flavor = pick(POI_FLAVOR)
    out.push({
      name: pick(flavor.names),
      lngLat: [+(at[0] + (rnd() - 0.5) * 0.02).toFixed(6), +(at[1] + (rnd() - 0.5) * 0.02).toFixed(6)],
      roles: flavor.roles,
    })
  }
  return out
}

async function main(): Promise<void> {
  assertLocal()
  const args = new Set(process.argv.slice(2))
  const straightOnly = args.has('--straight')
  const reset = args.has('--reset')
  const count = Number(process.argv.find((a) => /^--count=\d+$/.test(a))?.split('=')[1] ?? 12)

  await loadCache()

  // Ownership decides whether these show up on YOUR dashboard, and whether the
  // private ones are visible at all. Default to the owner account rather than
  // whichever user happens to be id 1 — that is usually the seed's demo user,
  // and rides parked under it are invisible to the account you actually sign in
  // with.
  const wanted = (process.argv.find((a) => a.startsWith('--owner='))?.split('=')[1] ?? OWNER_EMAIL)
    .trim()
    .toLowerCase()

  let [owner] = await db.select().from(users).where(eq(users.email, wanted)).limit(1)
  if (!owner) {
    ;[owner] = await db.select().from(users).orderBy(users.id).limit(1)
    if (owner) console.log(`No account for ${wanted}; falling back to ${owner.email}`)
  }
  if (!owner) {
    console.error('No users in the database. Run `npx tsx src/db/seed.ts` first.')
    process.exit(1)
  }

  if (reset) {
    const demo = await db.select({ id: rides.id }).from(rides).where(like(rides.description, `%${DEMO_MARKER}%`))
    if (demo.length) {
      await db.delete(rides).where(inArray(rides.id, demo.map((d) => d.id)))
      console.log(`removed ${demo.length} existing demo ride(s)`)
    }
  }

  let made = 0
  for (let n = 0; n < count; n++) {
    const region = REGIONS[n % REGIONS.length]
    // Most rides are a single day; every fourth is a multi-day trip, which is
    // what exercises the legend's per-route rows.
    const routeCount = n % 4 === 3 ? between(2, 3) : 1
    const color0 = ROUTE_COLORS[n % ROUTE_COLORS.length]

    const routeSpecs: { stops: Stop[]; legs: Leg[]; color: string }[] = []
    for (let r = 0; r < routeCount; r++) {
      const stops = makeStops(region, between(3, 7))
      const legs: Leg[] = []
      for (let i = 0; i < stops.length - 1; i++) {
        legs.push(await routeLeg(stops[i].lngLat, stops[i + 1].lngLat, straightOnly))
      }
      routeSpecs.push({ stops, legs, color: ROUTE_COLORS[(n + r) % ROUTE_COLORS.length] })
    }

    const first = routeSpecs[0].stops[0].name
    const last = routeSpecs[0].stops[routeSpecs[0].stops.length - 1].name
    const shape = pick(TITLE_SHAPES)
    const title = shape(first.split(',').pop()!.trim(), last.split(',').pop()!.trim())

    const totalM = routeSpecs.reduce((s, r) => s + r.legs.reduce((t, l) => t + l.distanceM, 0), 0)
    const totalS = routeSpecs.reduce((s, r) => s + r.legs.reduce((t, l) => t + l.durationS, 0), 0)
    const stopTotal = routeSpecs.reduce((s, r) => s + r.stops.length, 0)
    const desc = pick(DESCRIPTIONS)

    const [ride] = await db
      .insert(rides)
      .values({
        ownerId: owner.id,
        slug: generateSlug(),
        title,
        // The marker is what --reset keys on; keep it in the stored text.
        description: `${desc}${desc ? ' ' : ''}${DEMO_MARKER}`.trim(),
        visibility: n % 5 === 0 ? 'private' : n % 3 === 0 ? 'unlisted' : 'public',
        source: 'native',
        totalMiles: (totalM / METERS_PER_MILE).toFixed(1),
        totalDurationS: totalS,
        stopCount: stopTotal,
        viewCount: between(0, 400),
      })
      .returning()

    for (let r = 0; r < routeSpecs.length; r++) {
      const spec = routeSpecs[r]
      const distanceM = spec.legs.reduce((t, l) => t + l.distanceM, 0)
      const [route] = await db
        .insert(days)
        .values({
          rideId: ride.id,
          position: r,
          title: routeSpecs.length > 1 ? `Day ${r + 1}` : '',
          color: spec.color,
          distanceM,
          durationS: spec.legs.reduce((t, l) => t + l.durationS, 0),
        })
        .returning()

      // Cumulative distance to each stop is the sum of the legs before it —
      // this is what the viewer's From Start / From Gas columns read.
      let cum = 0
      const stopRows = spec.stops.map((s, i) => {
        const distFromStartM = i === 0 ? 0 : (cum += spec.legs[i - 1].distanceM)
        return {
          dayId: route.id,
          kind: 'stop' as const,
          position: i,
          lat: s.lngLat[1],
          lng: s.lngLat[0],
          name: s.name,
          description: '',
          roles: s.roles,
          durationMin: s.durationMin ?? null,
          distFromStartM: Math.round(distFromStartM),
          // NOT NULL since drizzle/0006. This file is not in tsconfig.json, so
          // a missing column here fails at runtime rather than at typecheck.
          uid: newUid(),
        }
      })
      await db.insert(points).values(stopRows)

      const track = spec.legs.flatMap((l) => l.geometry)
      const pois = makePois(track, between(0, 3))
      if (pois.length) {
        await db.insert(points).values(
          // POIs continue the day's numbering after its stops — every point
          // carries a position since drizzle/0008, both kinds, dense from 0.
          pois.map((p, i) => ({
            dayId: route.id,
            kind: 'poi' as const,
            position: spec.stops.length + i,
            lat: p.lngLat[1],
            lng: p.lngLat[0],
            name: p.name,
            description: '',
            roles: p.roles,
            uid: newUid(),
          })),
        )
      }

      await db.insert(routeLegs).values(
        spec.legs.map((l, i) => ({
          dayId: route.id,
          position: i,
          geometry: l.geometry,
          distanceM: l.distanceM,
          durationS: l.durationS,
        })),
      )
    }

    made++
    console.log(
      `  ${String(made).padStart(2)}. ${title}` +
        `  (${routeSpecs.length} route${routeSpecs.length > 1 ? 's' : ''}, ${stopTotal} stops, ` +
        `${(totalM / METERS_PER_MILE).toFixed(0)} mi, ${ride.visibility})`,
    )
  }

  await saveCache()
  console.log(`\nCreated ${made} demo rides for ${owner.email}. Re-run with --reset to replace them.`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
