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
// roles, its POI/stop distinction and its per-day colours, none of which
// survive a trip through KML or GPX. See the note on ExtractedPoint.kind.
import { eq } from 'drizzle-orm'
import { db } from '../db/index'
import { points as pointsTable, routes as routesTable, routeLegs } from '../db/schema'
import { METERS_PER_MILE, type Track } from './kml'
import { formatRoleName, type Role } from './roles'

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
  twistinessDpm: number | null
  twistinessBestDpm: number | null
  track: Track
  points: ExportPoint[]
}

export type ExportRide = {
  title: string
  description: string | null
  routes: ExportRoute[]
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

export async function loadRideForExport(
  rideId: number,
  meta: { title: string; description: string | null },
): Promise<ExportRide> {
  const routeRows = await db
    .select()
    .from(routesTable)
    .where(eq(routesTable.rideId, rideId))
    .orderBy(routesTable.position)

  const out: ExportRoute[] = []
  for (const r of routeRows) {
    const pts = await db.select().from(pointsTable).where(eq(pointsTable.routeId, r.id)).orderBy(pointsTable.position)
    const legs = await db
      .select({ geometry: routeLegs.geometry, distanceM: routeLegs.distanceM })
      .from(routeLegs)
      .where(eq(routeLegs.routeId, r.id))
      .orderBy(routeLegs.position)

    out.push({
      title: r.title,
      color: r.color,
      distanceM: r.distanceM,
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

  return { title: meta.title, description: meta.description, routes: out }
}

const mi = (m: number | null): number | null => (m == null ? null : Math.round((m / METERS_PER_MILE) * 10) / 10)

type Feature = { type: 'Feature'; geometry: unknown; properties: Record<string, unknown> }

export function buildGeoJson(ride: ExportRide): string {
  const features: Feature[] = []

  ride.routes.forEach((r, i) => {
    const dayName = r.title || `Day ${i + 1}`

    if (r.track.length > 1) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: r.track },
        properties: {
          name: dayName,
          day: i + 1,
          distanceMi: mi(r.distanceM),
          twistinessDpm: r.twistinessDpm,
          twistinessBestDpm: r.twistinessBestDpm,
          // simplestyle-spec, which geojson.io, GitHub and Mapbox all render.
          // Costs three keys and means the day colours survive into any of them
          // instead of every day drawing the same default blue.
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
          day: i + 1,
          description: p.description ?? undefined,
          durationMin: p.durationMin ?? undefined,
          distFromStartMi: mi(p.distFromStartM) ?? undefined,
        },
      })
    }
  })

  // Compact, deliberately. Indenting puts every coordinate component on its own
  // line, and a day's track is thousands of them — it tripled a real ride from
  // 150 KB to 460 KB while making the file harder to read, not easier. Anything
  // a person opens this in pretty-prints it anyway. `undefined` values drop out.
  return JSON.stringify({
    type: 'FeatureCollection',
    properties: { name: ride.title, description: ride.description ?? undefined },
    features,
  })
}
