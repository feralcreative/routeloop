// Generating route files from stored rows, as opposed to streaming back the
// original a rider uploaded.
//
// Every ride can be exported this way, imported or native — the database is the
// one shape both have in common. Where a stored original exists it is still the
// better answer for its own format (it is byte-for-byte what the rider had),
// and the download routes prefer it; this is what makes a format available that
// the ride never arrived in.
//
// GeoJSON first because it is the format that loses the least: it carries
// arbitrary `properties`, so a ride exported here and re-imported keeps its
// roles, its POI/stop distinction and its per-route colors, none of which
// survive a trip through KML or GPX. See the note on ExtractedPoint.kind.
import { eq } from 'drizzle-orm'
import { db } from '../db/index'
import type { PointDetailsOut } from './point-details'
import { points as pointsTable, routes as routesTable, routeLegs, rides, type TimeAnchor } from '../db/schema'
import { METERS_PER_MILE, type Track } from './kml'
import { formatRoleName, type Role } from './roles'
import { activeRoutes } from './alts'
import { relegRoute } from './track-split'
import { subgroupsOf } from '../subgroups/service'
import { strandOf } from '../subgroups/policy'

export type ExportPoint = {
  lat: number
  lng: number
  name: string
  description: string | null
  roles: Role[]
  kind: 'stop' | 'poi'
  durationMin: number | null
  distFromStartM: number | null
}

export type ExportRoute = {
  title: string | null
  color: string
  distanceM: number
  // Riding seconds, summed from the legs. 0 for a leg the router never answered
  // for, the same as everywhere else — a consumer wanting a time for one of
  // those estimates it from distance rather than treating the route as shorter.
  durationS: number
  startAt: Date | null
  endAt: Date | null
  twistinessDpm: number | null
  twistinessBestDpm: number | null
  track: Track
  points: ExportPoint[]
}

export type ExportRide = {
  title: string
  description: string | null
  routes: ExportRoute[]
  /**
   * How many losing alternates loadRideForExport left out, so a caller can say
   * so rather than letting a rider count the routes and find one missing.
   */
  hiddenAlts: number
}

// Legs are stored per routed segment and share their joints, so consecutive
// duplicates are dropped on the way out. This is the same concatenation
// ride.json does, minus the leg index bookkeeping that only the timeline needs.
function concatLegs(legs: Array<{ geometry: Track }>): Track {
  const track: Track = []
  for (const leg of legs) {
    for (const pt of leg.geometry) {
      const last = track[track.length - 1]
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) track.push(pt)
    }
  }
  return track
}

/**
 * The ride as something to consume: GPX, KML, the roadbook, the hand-off page,
 * the zip.
 *
 * ACTIVE DAYS ONLY, UNCONDITIONALLY, and that is the point of doing it here.
 * Every caller — the four serializers, the roadbook, the hand-off page, the zip
 * and the account export — wants the ride a rider is going to ride, not the
 * options they weighed. Filtering in the loader rather than in each of them
 * means the next caller cannot forget, which is the failure this codebase has
 * had before with byte columns and with the route cap.
 *
 * A GPX/KML/CSV/GeoJSON round trip therefore DROPS the alternates, deliberately.
 * None of those formats can express "this is an option", so a re-import would
 * silently promote every losing alternate to a real route and hand the rider a
 * ride with twice the mileage. Losing them is the smaller lie. The lossless path
 * is the native JSON, which goes through loadNativeRide below and keeps
 * everything.
 *
 * ONE SUBGROUP AT A TIME, when asked. `subgroupId` narrows the ride to the routes
 * that rider actually rides — their own approach plus every shared route — which
 * is #67's per-rider hand-off in one argument. It is a SECOND filter stacked on
 * the alternates one, applied after it, and the order does not matter because a
 * losing alternate on a feeder route is dropped by either.
 *
 * `undefined` means the whole ride and is what every existing caller passes by
 * omission. `null` is NOT the same thing: it means "the trunk", the routes
 * everybody rides, which is what a rider in no subgroup gets — see strandOf.
 */
export async function loadRideForExport(
  rideId: number,
  meta: { title: string; description: string | null },
  subgroupId?: number | null,
  /**
   * The route uids this viewer is on, or null for no narrowing.
   *
   * **IT OUTRANKS `subgroupId`, AND THAT IS THE POINT.** A strand is a GROUP's
   * run and was only ever an approximation of a rider's: somebody who joins for
   * the middle of a ride is on neither group's strand. Where both are given they
   * agree in the ordinary case — a rider is on their group's strand by
   * construction — and where they disagree it is because somebody joined or left
   * partway, which is what the uids know and the strand does not. See
   * resolveStrand, which is the only thing that fills either in.
   */
  routeUids?: string[] | null,
): Promise<ExportRide> {
  const allRoutes = await db
    .select()
    .from(routesTable)
    .where(eq(routesTable.rideId, rideId))
    .orderBy(routesTable.position)

  const mine = (rows: typeof allRoutes) => (routeUids ? rows.filter((r) => routeUids.includes(r.uid)) : rows)
  const routeRows = mine(
    subgroupId === undefined ? activeRoutes(allRoutes) : strandOf(activeRoutes(allRoutes), subgroupId),
  )
  // Counted against what THIS reader would otherwise have seen, not against the
  // whole ride: telling a rider on the Seattle approach that four alternates
  // were hidden, three of them on a route they are not on, is a number about
  // somebody else's ride.
  // Counted against what THIS reader would otherwise have seen, so the rider
  // narrowing is applied to the comparison too — otherwise a friend riding three
  // routes of a nine-route tour is told six alternates were hidden, which is a
  // number about somebody else's ride.
  const visibleToReader = mine(subgroupId === undefined ? allRoutes : strandOf(allRoutes, subgroupId))
  const hiddenAlts = visibleToReader.length - routeRows.length

  const out: ExportRoute[] = []
  for (const r of routeRows) {
    const pts = await db.select().from(pointsTable).where(eq(pointsTable.routeId, r.id)).orderBy(pointsTable.position)
    const legs = await db
      .select({ geometry: routeLegs.geometry, distanceM: routeLegs.distanceM, durationS: routeLegs.durationS })
      .from(routeLegs)
      .where(eq(routeLegs.routeId, r.id))
      .orderBy(routeLegs.position)

    out.push({
      title: r.title,
      color: r.color,
      distanceM: r.distanceM,
      durationS: legs.reduce((n, l) => n + l.durationS, 0),
      startAt: r.startAt,
      endAt: r.endAt,
      twistinessDpm: r.twistinessDpm,
      twistinessBestDpm: r.twistinessBestDpm,
      track: concatLegs(legs),
      // Stops first, in stop order, then POIs — the order the importer will
      // read them back in, and the order the builder stores them.
      points: pts.map((p) => ({
        lat: p.lat,
        lng: p.lng,
        name: p.name,
        description: p.description,
        roles: p.roles,
        kind: p.kind,
        durationMin: p.durationMin,
        distFromStartM: p.distFromStartM,
      })),
    })
  }

  return { title: meta.title, description: meta.description, routes: out, hiddenAlts }
}

/**
 * The ride's start, for naming a download. Its own query because the stored-
 * original branch of a download never loads the ride and would otherwise have
 * to, just to name the file it is about to stream back untouched.
 *
 * Position 0 rather than the earliest date: the rider's route order is the ride's
 * order, and a route dated before route 1 is a mistake to preserve, not to sort away.
 */
export async function rideStartDate(rideId: number): Promise<Date | null> {
  const [first] = await db
    .select({ startAt: routesTable.startAt })
    .from(routesTable)
    .where(eq(routesTable.rideId, rideId))
    .orderBy(routesTable.position)
    .limit(1)
  return first?.startAt ?? null
}

const mi = (m: number | null): number | null => (m == null ? null : Math.round((m / METERS_PER_MILE) * 10) / 10)

type Feature = { type: 'Feature'; geometry: unknown; properties: Record<string, unknown> }

// `firstRoute` exists for the per-route zip, where each file holds one route but is
// route N of a ride. Without it every file in the archive would call itself route 1,
// and the `route` property is the only thing in a GeoJSON that says otherwise.
export function buildGeoJson(ride: ExportRide, firstRoute = 1): string {
  const features: Feature[] = []

  ride.routes.forEach((r, n) => {
    const i = firstRoute + n - 1
    const routeName = r.title || `Route ${i + 1}`

    if (r.track.length > 1) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: r.track },
        properties: {
          name: routeName,
          route: i + 1,
          distanceMi: mi(r.distanceM),
          twistinessDpm: r.twistinessDpm,
          twistinessBestDpm: r.twistinessBestDpm,
          // simplestyle-spec, which geojson.io, GitHub and Mapbox all render.
          // Costs three keys and means the route colors survive into any of them
          // instead of every route drawing the same default blue.
          stroke: r.color,
          'stroke-width': 4,
          'stroke-opacity': 0.9,
        },
      })
    }

    for (const p of r.points) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: {
          // Both spellings on purpose. The prefixed name is the documented
          // convention and is all a tool that shows only a label will see; the
          // array is what our own importer prefers, because a prefix in a name
          // a rider typed themselves is a guess and an array is not.
          name: formatRoleName(p.roles, p.name),
          roles: p.roles,
          kind: p.kind,
          route: i + 1,
          description: p.description ?? undefined,
          durationMin: p.durationMin ?? undefined,
          distFromStartMi: mi(p.distFromStartM) ?? undefined,
        },
      })
    }
  })

  // Compact, deliberately. Indenting puts every coordinate component on its own
  // line, and a route's track is thousands of them — it tripled a real ride from
  // 150 KB to 460 KB while making the file harder to read, not easier. Anything
  // a person opens this in pretty-prints it anyway. `undefined` values drop out.
  return JSON.stringify({
    type: 'FeatureCollection',
    properties: { name: ride.title, description: ride.description ?? undefined },
    features,
  })
}

// --- CSV -------------------------------------------------------------------

// The stop list, and only the stop list. A CSV cannot hold a track, so this is
// lossy by construction and says so by omission rather than by writing a
// straight line between stops and calling it a route.
//
// Quoting is RFC 4180: a field is quoted when it contains the delimiter, a
// quote or a newline, and a quote inside becomes two. csv.ts parses the same
// grammar, so a file written here reads back exactly.
//
// Deliberately does NOT neutralize leading =, +, - or @. A spreadsheet reads
// those as formulas, but this file's contract is byte-identical round-tripping
// (test/round-trip.test.ts) and a stop legitimately named "-" would come back
// changed. src/survey/csv.ts writes free text a person will open in Excel and
// therefore does guard it, in its own escaper. The two look alike and must not
// be merged; test/survey-csv.test.ts asserts they still differ.
//
// Exported only so that test can make that assertion.
export const csvCell = (v: string | number | null | undefined): string => {
  if (v == null) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const CSV_HEADER = ['route', 'kind', 'name', 'lat', 'lng', 'roles', 'durationMin', 'description', 'distFromStartMi']

export function buildCsv(ride: ExportRide, firstRoute = 1): string {
  const lines = [CSV_HEADER.join(',')]

  ride.routes.forEach((r, n) => {
    const i = firstRoute + n - 1
    for (const p of r.points) {
      lines.push(
        [
          i + 1,
          p.kind,
          // Unprefixed here, with roles in their own column: a spreadsheet has
          // somewhere to put them, unlike a KML <name>. The importer reads
          // either, so a file edited by hand into the prefixed form still works.
          p.name,
          p.lat,
          p.lng,
          p.roles.join('/'),
          p.durationMin,
          p.description,
          mi(p.distFromStartM),
        ]
          .map(csvCell)
          .join(','),
      )
    }
  })

  // CRLF: the line ending RFC 4180 specifies, and the one Excel needs to not
  // treat the whole file as a single row.
  return lines.join('\r\n') + '\r\n'
}

// --- XML -------------------------------------------------------------------

// Names and descriptions are rider-supplied and reach a file other software
// parses, so they are escaped on the way out. `&` first, or it would re-escape
// the ampersands the later replacements introduce.
//
// Note what is *not* here: no DOCTYPE, ever. The importer refuses any document
// carrying one, and a file this app writes has to be a file this app will read.
const xml = (v: string | null | undefined): string =>
  (v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

// --- KML -------------------------------------------------------------------

// KML colors are `aabbggrr` — alpha first and the RGB bytes reversed. Getting
// this backwards does not fail, it just draws every route in the wrong color,
// which is why it has a test rather than a comment alone.
function kmlColor(css: string): string {
  const hex = /^#?([0-9a-f]{6})$/i.exec(css.trim())
  if (!hex) return 'ff0000cc'
  const [r, g, b] = [hex[1].slice(0, 2), hex[1].slice(2, 4), hex[1].slice(4, 6)]
  return `ff${b}${g}${r}`.toLowerCase()
}

const kmlCoords = (track: Track): string => track.map(([lng, lat]) => `${lng},${lat}`).join(' ')

// firstRoute as in buildGeoJson — it shifts the route numbering used for folder
// names and style ids so a per-route file says which route it actually is.
export function buildKml(ride: ExportRide, firstRoute = 1): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    `    <name>${xml(ride.title)}</name>`,
  ]
  if (ride.description) out.push(`    <description>${xml(ride.description)}</description>`)

  ride.routes.forEach((r, n) => {
    const i = firstRoute + n - 1
    out.push(
      `    <Style id="route${i + 1}"><LineStyle><color>${kmlColor(r.color)}</color><width>4</width></LineStyle></Style>`,
    )
  })

  ride.routes.forEach((r, n) => {
    const i = firstRoute + n - 1
    const routeName = r.title || `Route ${i + 1}`
    // A Folder per route so Google Earth's sidebar shows the routes separately.
    // The importer flattens them back to one route — see the round-trip tests,
    // where that loss is asserted rather than left to be discovered.
    out.push('    <Folder>', `      <name>${xml(routeName)}</name>`)

    for (const p of r.points) {
      // The role prefix is the only place a KML can carry a role: a Placemark
      // has a name and a description and nowhere else to put one. This is the
      // convention parseRoleName reads back and the README documents.
      out.push('      <Placemark>', `        <name>${xml(formatRoleName(p.roles, p.name))}</name>`)
      if (p.description) out.push(`        <description>${xml(p.description)}</description>`)
      out.push(`        <Point><coordinates>${p.lng},${p.lat}</coordinates></Point>`, '      </Placemark>')
    }

    if (r.track.length > 0) {
      out.push(
        '      <Placemark>',
        `        <name>${xml(routeName)}</name>`,
        `        <styleUrl>#route${i + 1}</styleUrl>`,
        '        <LineString>',
        '          <tessellate>1</tessellate>',
        `          <coordinates>${kmlCoords(r.track)}</coordinates>`,
        '        </LineString>',
        '      </Placemark>',
      )
    }
    out.push('    </Folder>')
  })

  out.push('  </Document>', '</kml>', '')
  return out.join('\n')
}

// --- GPX -------------------------------------------------------------------

// The decision this whole format hinges on: **stops are `<wpt>` and the shaping
// points are `<trkpt>`. Nothing is ever written as `<rte>`/`<rtept>`.**
//
// A `<rte>` is a list of places to navigate *between*, so a GPS given one picks
// its own way from each point to the next — usually the fast way and rarely the
// good one, and a missed turn throws out the rest of the route. That is exactly
// the failure the FAQ describes under "Why does my GPS ignore the route I
// planned?", and the answer there is that Tankbag puts in enough intermediate
// points to leave the device no room to form an opinion. Exporting those points
// as route points instead of track points hands that room straight back and
// makes the app's central promise false.
//
// A `<trk>` is a record of a path actually taken. Devices follow it rather than
// re-deriving it, which is the behavior riders are here for.
export function buildGpx(ride: ExportRide, firstRoute = 1): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Tankbag" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <metadata>',
    `    <name>${xml(ride.title)}</name>`,
  ]
  if (ride.description) out.push(`    <desc>${xml(ride.description)}</desc>`)
  out.push('  </metadata>')

  // Waypoints before tracks, which is the element order the GPX schema
  // requires (wpt, then rte, then trk) rather than a stylistic choice.
  for (const r of ride.routes) {
    for (const p of r.points) {
      out.push(`  <wpt lat="${p.lat}" lon="${p.lng}">`, `    <name>${xml(formatRoleName(p.roles, p.name))}</name>`)
      if (p.description) out.push(`    <desc>${xml(p.description)}</desc>`)
      // `type` is where a GPX can carry a category, and some devices show it.
      // The importer does not read it back — the name prefix is what round
      // rides — but writing it costs a line and loses nothing.
      if (p.roles.length > 0) out.push(`    <type>${xml(p.roles.join('/'))}</type>`)
      out.push('  </wpt>')
    }
  }

  ride.routes.forEach((r, n) => {
    if (r.track.length === 0) return
    out.push('  <trk>', `    <name>${xml(r.title || `Route ${firstRoute + n}`)}</name>`, '    <trkseg>')
    for (const [lng, lat] of r.track) out.push(`      <trkpt lat="${lat}" lon="${lng}"/>`)
    out.push('    </trkseg>', '  </trk>')
  })

  out.push('</gpx>', '')
  return out.join('\n')
}

// --- Native Tankbag JSON ---------------------------------------------------

// The lossless one, and the only format that is.
//
// Every other export flattens something: KML and GPX cannot say whether a point
// is a stop or a POI or how long you sat there, CSV drops the geometry, GeoJSON
// keeps the points but the importer rebuilds one route out of many. This is the
// builder's own save payload, so a ride exported here and imported back is the
// same ride — routes, colors, times, via points and all — because it goes
// through the same schema and the same insert the builder's save does.
//
// The version key is a version, not decoration: the importer refuses a file
// without one rather than guessing, which is also what keeps a plain GeoJSON
// from being mistaken for one.
//
// Version 2 (2026-08-09) renamed the ride's `routes` array to `routes`, following
// the table. Version 3 (2026-08-11) renamed the version key itself from
// `tankbag` to `routeloop` with the product. Version 4 (2026-08-23) merged each
// route's `stops` and `pois` into one ordered `points` array, following the
// schema — a point is created as a POI and promoted later, so the kind became a
// flag on an element rather than a choice of which array to put it in.
//
// Version 5 (2026-08-24) is the first bump that is not a rename. A POI became
// part of the route, so a route carries `points - 1` legs where every version
// before it carried `stops - 1`. The shape of the file is unchanged; the
// INVARIANT is not, which is exactly the kind of change a version key is for —
// nothing about a v4 file looks wrong, it just has too few legs, and routeSchema
// would refuse the whole import with no way for a rider to tell why.
//
// ALL FOUR OLDER SHAPES STILL IMPORT — see nativeVersion and upgradeNativeRide
// below, which is why the version is worth having at all. Riders have v2, v3 and
// v4 files on disk and a backup that will not restore is not a backup.
export const NATIVE_FORMAT_VERSION = 6

export type NativeRide = {
  /** Written by this app. */
  routeloop?: number
  /** The same field, under the name this app shipped under until 2026-08-11. */
  tankbag?: number
  exportedFrom: string
  ride: unknown
}

/**
 * The format version, from whichever key carries it.
 *
 * Two keys mean the same thing here because the file is the only lossless way a
 * rider holds a ride, and refusing the ones they already downloaded would make
 * them unrestorable. Read both; `loadNativeRide` writes only the current one.
 */
export const nativeVersion = (file: NativeRide): number => file.routeloop ?? file.tankbag ?? 0

export const isNativeRide = (v: unknown): v is NativeRide =>
  typeof v === 'object' &&
  v !== null &&
  (typeof (v as NativeRide).routeloop === 'number' || typeof (v as NativeRide).tankbag === 'number')

/**
 * Brings an older native file up to the current format, in place of the caller
 * having to know what changed between versions.
 *
 * Two migrations touch the ride payload.
 *
 * The array of routes has been called `routes` (v1), `days` (v2 to v5) and
 * `routes` again (v6). Every file from v2 to v5 therefore needs its `days` key
 * remapped, and a v1 file already carries the current one. The remap is done
 * here rather than by teaching `ridePayload` to accept either key, because the
 * schema also validates live builder saves — and a builder that can still post
 * `days` is a second name kept alive forever by accident, which is the thing the
 * rename was undoing. Same reasoning for the stops/pois merge below.
 *
 * v3 and earlier carried each route's points as two arrays. They are concatenated
 * STOPS FIRST, which is the order those files were written in and the order the
 * builder displayed them in: a v3 file's POIs had no stored order at all, so
 * there is no sequence to recover and appending them is the only honest reading.
 * The kind is stamped explicitly rather than left to the schema default, because
 * a v3 stop must not silently become a POI.
 *
 * v3 also changed only the envelope's version key, which `nativeVersion` already
 * absorbs, so there is nothing else to do about it.
 *
 * v4 and earlier carried `stops - 1` legs, because a POI anchored none. A route
 * needs `points - 1` now, so every route's legs are re-cut from its own track at
 * every point — see relegRoute. Nothing is re-routed and no coordinate is invented;
 * the concatenated geometry is unchanged. A route the file left with no legs at all
 * (a CSV import, which has no line to cut) stays that way and the builder fills
 * it with straight placeholders on load, exactly as it did before.
 *
 * Returns the ride payload for `ridePayload` to validate. An unrecognized or
 * newer version is not this function's problem: the caller checks that first.
 */
export function upgradeNativeRide(file: NativeRide): object {
  let ride = (file.ride ?? {}) as Record<string, unknown>
  // v6 RENAMED THE ARRAY BACK TO `routes`, WHICH IS THE SECOND TIME THIS KEY HAS
  // MOVED. v1 called it `routes`, v2 renamed it to `days`, and v6 renames it
  // back — so a v1 file already carries the current key and every file from v2
  // to v5 carries `days`. Both readings are handled by the one branch below,
  // which is why the old v1-only remap is gone rather than sitting beside it.
  //
  // **THE VERSION HAD TO BUMP EVEN THOUGH NOTHING ABOUT THE DATA CHANGED.** A v5
  // file written yesterday says `days` and a file written today says `routes`;
  // leaving both at 5 would put two incompatible shapes under one version
  // number, and the importer would have no way to tell which it was holding.
  // Riders have these on disk and a backup that will not restore is not a
  // backup.
  if (Array.isArray((ride as { days?: unknown }).days) && ride.routes === undefined) {
    const { days, ...rest } = ride as { days?: unknown } & Record<string, unknown>
    ride = { ...rest, routes: days }
  }
  if (nativeVersion(file) < 4 && Array.isArray(ride.routes)) {
    ride = {
      ...ride,
      routes: ride.routes.map((d) => {
        if (typeof d !== 'object' || d === null) return d
        const route = d as Record<string, unknown>
        if (route.points !== undefined) return route
        const stops = Array.isArray(route.stops) ? route.stops : []
        const pois = Array.isArray(route.pois) ? route.pois : []
        const { stops: _s, pois: _p, ...rest } = route
        return {
          ...rest,
          points: [
            ...stops.map((pt) => ({ ...(pt as object), kind: 'stop' })),
            ...pois.map((pt) => ({ ...(pt as object), kind: 'poi' })),
          ],
        }
      }),
    }
  }
  if (nativeVersion(file) < 5 && Array.isArray(ride.routes)) {
    ride = {
      ...ride,
      routes: ride.routes.map((d) => {
        if (typeof d !== 'object' || d === null) return d
        const route = d as Record<string, unknown>
        const points = Array.isArray(route.points) ? route.points : []
        const legs = Array.isArray(route.legs) ? route.legs : []
        // Nothing to cut, or nothing missing. A route already holding one leg per
        // pair is left alone rather than re-cut — re-cutting would be a no-op on
        // a well-formed route and a guess on a malformed one.
        if (legs.length === Math.max(0, points.length - 1)) return route
        const track = concatLegs(legs as Array<{ geometry: Track }>)
        if (track.length < 2) return route
        const cut = relegRoute(track, points as Array<{ lat: number; lng: number }>)

        // The recorded riding time is SPREAD ACROSS THE NEW LEGS by distance
        // rather than zeroed. A v4 route's legs carried real durations the router
        // had answered for, and dropping them would make the route silently
        // shorter — legDurationS() would estimate each new leg from its distance
        // at a nominal 45 mph, which is not what the rider planned around.
        // Distributing keeps the route's total intact, which is the figure every
        // surface actually shows.
        const totalS = (legs as Array<{ durationS?: number }>).reduce((n, l) => n + (l.durationS ?? 0), 0)
        const totalM = cut.reduce((n, l) => n + l.distanceM, 0)
        return {
          ...route,
          legs: cut.map((l) => ({
            ...l,
            durationS: totalM > 0 ? Math.round((totalS * l.distanceM) / totalM) : 0,
            viaPoints: [],
          })),
        }
      }),
    }
  }
  return ride
}

// Straight from the rows, in the shape ridePayload validates. Note this reads
// legs rather than the concatenated track: the leg boundaries are where the
// stops are, and losing them is what makes every other format lossy.
//
// EVERY DAY, INCLUDING THE LOSING ALTERNATES — the opposite of
// loadRideForExport above, and the reason the two are separate functions rather
// than one with a flag. This is the lossless format: it is what a rider gets
// back if they re-import, and what the account archive ships. Dropping an
// alternate here would make the "you can always get your data out" promise
// false in exactly the case where the rider did the most work.
export async function loadNativeRide(
  rideId: number,
  meta: {
    title: string
    description: string | null
    visibility: string
    externalUrl: string | null
    /** Defaulted rather than required, so the two existing callers do not have
     *  to be changed to pass something every ride already has a value for. */
    timeAnchor?: TimeAnchor
  },
  // Private stop details, already resolved for whoever is asking — an empty map
  // for anyone but the owner.
  //
  // Passed in rather than looked up here, and that is the safety property: this
  // function is reachable by a stranger, because a PUBLIC ride's native JSON is
  // a public download. If it fetched details itself it would have to know who
  // was asking, and the route someone forgot to tell it, every gate code in the
  // ride would ship in the file. Defaulting to empty means forgetting fails
  // CLOSED — the export is merely incomplete, not a leak.
  details: Map<string, PointDetailsOut> = new Map(),
): Promise<NativeRide> {
  const routeRows = await db
    .select()
    .from(routesTable)
    .where(eq(routesTable.rideId, rideId))
    .orderBy(routesTable.position)
  const groups = await subgroupsOf(rideId)
  const subgroupUid = new Map(groups.map((g) => [g.id, g.uid]))
  const [rideRow] = await db
    .select({ primary: rides.primarySubgroupId, trunk: rides.trunkSubgroupId })
    .from(rides)
    .where(eq(rides.id, rideId))
    .limit(1)
  const primaryUid = rideRow?.primary ? (subgroupUid.get(rideRow.primary) ?? null) : null
  const trunkUid = rideRow?.trunk ? (subgroupUid.get(rideRow.trunk) ?? null) : null

  const out = []
  for (const r of routeRows) {
    const pts = await db.select().from(pointsTable).where(eq(pointsTable.routeId, r.id)).orderBy(pointsTable.position)
    const legs = await db.select().from(routeLegs).where(eq(routeLegs.routeId, r.id)).orderBy(routeLegs.position)

    // uid rides along so a re-import reattaches details to the right stops. It
    // is not sensitive on its own — nothing is authorized by knowing one — and
    // without it a rider's own backup restores as a ride whose stops have all
    // lost their reservations.
    const point = (p: (typeof pts)[number]) => {
      const d = details.get(p.uid)
      return {
        lat: p.lat,
        lng: p.lng,
        name: p.name,
        // The public address, carried because this is the format that promises
        // to lose nothing. The four lossy formats do not write it — the same
        // call as the route's clock: what a GPX cannot say, none of them says.
        address: p.address,
        description: p.description ?? '',
        roles: p.roles,
        durationMin: p.durationMin,
        slackMin: p.slackMin,
        uid: p.uid,
        ...(d ? { details: d } : {}),
      }
    }

    out.push({
      // The route's uid rides along for the same reason a point's does above:
      // this is the format that promises to lose nothing, and a re-import that
      // minted fresh ones would silently drop every vote cast on an alternate.
      // Not sensitive — nothing is authorized by knowing one.
      //
      // Additive and optional on the way back in, exactly as a point's is, so
      // this needs no format-version bump: a v5 file written yesterday has no
      // route uids and ensureUids() fills them in.
      uid: r.uid,
      // Whose route this is, by uid — see routes.subgroup_id. Additive and optional
      // for the same reason, and null on every file written before #67.
      subgroupUid: r.subgroupId ? (subgroupUid.get(r.subgroupId) ?? null) : null,
      title: r.title,
      color: r.color,
      startAt: r.startAt?.toISOString() ?? null,
      endAt: r.endAt?.toISOString() ?? null,
      altGroup: r.altGroup,
      altActive: r.altActive,
      // What the route asks of the router (#29). Additive and optional on the way
      // back in like the uid above, so this needs no format-version bump and a
      // v5 file written before it imports with no preference — which is what
      // those routes meant.
      //
      // THE NATIVE JSON IS THE ONLY FORMAT THAT CARRIES IT, AND THERE IS NO
      // FIDELITY ROW FOR IT ON PURPOSE. ExportRoute — the shape every lossy writer
      // is handed — does not have the field at all, so a row asserting that GPX,
      // KML, GeoJSON and CSV do not write it would be proving that a value none
      // of them can see does not appear, which is a tautology dressed as a
      // guarantee. The real guarantee is structural and one level up: give
      // ExportRoute the field and the matrix becomes the right place to record
      // what each format then does with it.
      routePrefs: r.routePrefs ?? null,
      // ONE ORDERED LIST as of format version 4. The read is ordered by
      // position, which every point carries now, so the rider's own sequence is
      // what round-trips — the thing the two-array shape could not express.
      points: pts.map((p) => ({ kind: p.kind, ...point(p) })),
      // ONE LEG PER PAIR OF POINTS, repaired here rather than trusted.
      //
      // A route stored before 2026-08-24 carries stops−1 legs, and no schema change
      // was needed for the rule to move — so those rows are still sitting there
      // until utils/split-imported-legs.ts is run. Writing them into a v5 file
      // would produce a backup that will not restore: the file declares the
      // current version, so the importer's v<5 repair does not run on it, and
      // routeSchema rejects the whole ride.
      //
      // A backup that will not restore is not a backup, and this is the one
      // format that promises to lose nothing, so the leg count is made right on
      // the way out. Same helper the importer's repair uses, so a stored route and
      // a re-imported one come out identical.
      legs: relegNative(pts, legs),
    })
  }

  return {
    routeloop: NATIVE_FORMAT_VERSION,
    exportedFrom: 'routeloop.app',
    ride: {
      title: meta.title,
      description: meta.description ?? '',
      visibility: meta.visibility,
      external_url: meta.externalUrl ?? '',
      // THE SUBGROUPS COME ACROSS BUT THE RIDERS DO NOT, and the split is
      // deliberate. A subgroup is part of the PLAN — the Oakland approach is a
      // route, and a file that lost it would restore as a pile of unrelated
      // routes. Who is in it is a set of accounts on this installation, which
      // means nothing in somebody else's file and would be a roster of real
      // people traveling in an export. `ride_members` is deliberately not
      // serialized anywhere.
      subgroups: groups.map((g) => ({ uid: g.uid, name: g.name, color: g.color })),
      primarySubgroup: primaryUid,
      trunkSubgroup: trunkUid,
      timeAnchor: meta.timeAnchor ?? 'departure',
      routes: out,
    },
  }
}

/**
 * A route's legs in the shape the current format requires, re-cutting only when
 * the stored rows do not already have it.
 *
 * The untouched path is the normal one — a route saved by the builder since
 * 2026-08-24 already carries points−1 legs, and this hands them straight back
 * with their shaping points intact. Only a route left behind by the migration is
 * re-cut, and it loses its `viaPoints`: a shaping point belongs to the pair of
 * points its leg used to join, and every one of those pairs has just changed.
 */
function relegNative(
  pts: Array<{ lat: number; lng: number }>,
  legs: Array<{ geometry: Track; distanceM: number; durationS: number; viaPoints: Track | null }>,
) {
  const asIs = legs.map((l) => ({
    geometry: l.geometry,
    distanceM: l.distanceM,
    durationS: l.durationS,
    viaPoints: l.viaPoints ?? [],
  }))
  if (legs.length === Math.max(0, pts.length - 1)) return asIs
  const track = concatLegs(legs)
  if (track.length < 2) return asIs

  const cut = relegRoute(track, pts)
  // The recorded riding time spread across the new legs by distance, so the
  // route's total survives — see the same reasoning in upgradeNativeRide.
  const totalS = legs.reduce((n, l) => n + l.durationS, 0)
  const totalM = cut.reduce((n, l) => n + l.distanceM, 0)
  return cut.map((l) => ({
    geometry: l.geometry,
    distanceM: l.distanceM,
    durationS: totalM > 0 ? Math.round((totalS * l.distanceM) / totalM) : 0,
    viaPoints: [] as Track,
  }))
}

export const buildNativeJson = (r: NativeRide): string => JSON.stringify(r)
