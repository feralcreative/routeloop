// Elevation and weather along a ride (#23, #24), for the timeline on both map pages.
// Read from what is STORED, so the builder asks again after a save rather than
// posting its geometry: a proxy that takes arbitrary coordinates is a free
// Open-Meteo relay for anybody holding a session.
import { Hono } from 'hono'
import { asc, eq, inArray } from 'drizzle-orm'
import type { AuthEnv } from '../auth/middleware'
import { currentUser, requireActiveApi } from '../auth/middleware'
import { db } from '../db/index'
import { routeLegs, routes as routesTable, type RideRow } from '../db/schema'
import { activeRoutes } from '../maps/alts'
import { routeElevation, routeWeather, type ElevationPoint, type WeatherPoint } from '../maps/conditions'
import type { Track } from '../maps/kml'
import { viewableRide } from '../access/query'
import { canViewAsMember } from '../members/policy'
import { builderRide } from './builder'

export const conditionsRoutes = new Hono<AuthEnv>()

type Conditions = Record<string, { elevation: ElevationPoint[]; complete: boolean; weather: WeatherPoint[] }>

// `?route=<uid>` asks for one route: the client walks the ride a route at a time
// so a long ride fills in progressively instead of spending the free tier's whole
// minute on one request.
async function rideConditions(ride: RideRow, only?: string): Promise<Conditions> {
  const all = activeRoutes(
    await db.select().from(routesTable).where(eq(routesTable.rideId, ride.id)).orderBy(asc(routesTable.position)),
  ).filter((r) => !only || r.uid === only)
  if (!all.length) return {}
  const legs = await db
    .select({ routeId: routeLegs.routeId, geometry: routeLegs.geometry })
    .from(routeLegs)
    .where(
      inArray(
        routeLegs.routeId,
        all.map((r) => r.id),
      ),
    )
    .orderBy(asc(routeLegs.routeId), asc(routeLegs.position))
  const byRoute = new Map<number, Track[]>()
  for (const l of legs) {
    const list = byRoute.get(l.routeId) ?? []
    list.push(l.geometry)
    byRoute.set(l.routeId, list)
  }
  const out: Conditions = {}
  // Sequential, so routes that share a road fill the caches for each other.
  for (const r of all) {
    const g = byRoute.get(r.id) ?? []
    const ele = await routeElevation(g)
    out[r.uid] = {
      elevation: ele.points,
      complete: ele.complete,
      weather: await routeWeather(g, r.startAt?.toISOString() ?? null, r.endAt?.toISOString() ?? null),
    }
  }
  return out
}

conditionsRoutes.get('/m/:slug/conditions.json', async (c) => {
  const ride = await viewableRide(c.req.param('slug'), c.get('user') ?? null)
  if (!ride) return c.json({ error: 'not found' }, 404)
  c.header('Cache-Control', 'no-store')
  return c.json({ routes: await rideConditions(ride, c.req.query('route')) })
})

conditionsRoutes.get('/api/rides/:id/conditions', requireActiveApi, async (c) => {
  const found = await builderRide(currentUser(c).id, c.req.param('id'))
  if (!found || !canViewAsMember(found.member)) return c.json({ error: 'not found' }, 404)
  c.header('Cache-Control', 'no-store')
  return c.json({ routes: await rideConditions(found.ride, c.req.query('route')) })
})
