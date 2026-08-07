// Server-side proxy for Google Routes API.
//
// This exists because the Routes key is IP-restricted rather than referrer-
// restricted: a browser cannot use it, and making it public would hand out a
// billable credential. The builder therefore asks the origin for a leg and the
// origin asks Google.
//
// It also gives the leg cache somewhere to live. A rider dragging a stop
// re-routes the same pair of coordinates over and over, and Routes bills per
// call.
import { Hono } from 'hono'
import { z } from 'zod'
import { requireActiveApi, requireAuthApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { GMAPS_SERVER_KEY } from '../config'
import { MAX_VIAS_PER_LEG } from '../maps/ride-graph'

export const routingRoutes = new Hono<AuthEnv>()

const ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes'

// Ask for nothing beyond the three values a leg is made of. The field mask is
// what Google prices this call on, so every extra field is money.
const FIELD_MASK = 'routes.polyline.geoJsonLinestring,routes.distanceMeters,routes.duration'

// DRIVE, not TWO_WHEELER. TWO_WHEELER is only served in a handful of South and
// Southeast Asian markets; in the US it returns `{}` — an empty 200 with no
// route and no error — which would read as "no road route" for every leg.
// Verified 2026-07-28: identical request routed in Jakarta and returned empty
// in California.
const TRAVEL_MODE = 'DRIVE'

// Matches MAX_VIAS_PER_LEG in src/maps/ride-graph.ts, which is what the save
// path enforces. They used to disagree — this allowed 25 and the schema
// allowed 20 — so a leg with 21 shaping points routed happily and then failed
// validation the moment the rider tried to keep it. A cap that only bites
// after the work is done is worse than no cap.
const MAX_VIAS = MAX_VIAS_PER_LEG

// The whole app stores and speaks [lng, lat] — GeoJSON order, which is what
// Mapbox used and what `route_legs.geometry` holds. Google speaks {latitude,
// longitude}. Reversed coordinates still produce a valid-looking route, just in
// the wrong place, so the conversion happens here and only here.
type LngLat = [number, number]

function toGoogleWaypoint([lng, lat]: LngLat) {
  return { location: { latLng: { latitude: lat, longitude: lng } } }
}

const coord = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])

const routeRequest = z.object({
  origin: coord,
  destination: coord,
  vias: z.array(coord).max(MAX_VIAS).optional(),
})

// Google returns duration as a string of seconds — "1234s", not 1234.
function parseDuration(d: unknown): number {
  if (typeof d !== 'string') return 0
  const n = Number.parseFloat(d.replace(/s$/, ''))
  return Number.isFinite(n) ? Math.round(n) : 0
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

// Small bounded cache. Editing a ride re-requests the same leg constantly, and
// a plain Map with a cap is enough — this is per-process and deliberately not
// shared state.
const CACHE_MAX = 500
const cache = new Map<string, RouteLeg>()

type RouteLeg = { geometry: LngLat[]; distanceM: number; durationS: number }

function cacheKey(origin: LngLat, destination: LngLat, vias: LngLat[]): string {
  const pt = ([lng, lat]: LngLat) => `${round6(lng)},${round6(lat)}`
  return [origin, ...vias, destination].map(pt).join(';')
}

function remember(key: string, leg: RouteLeg): RouteLeg {
  if (cache.size >= CACHE_MAX) {
    // Oldest insertion first — Map preserves insertion order.
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, leg)
  return leg
}

routingRoutes.post('/api/route', requireAuthApi, requireActiveApi, requireSameOrigin, async (c) => {
  if (!GMAPS_SERVER_KEY) {
    return c.json({ error: 'routing is not configured' }, 503)
  }

  const parsed = routeRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'origin and destination are required as [lng, lat]' }, 400)
  }

  const origin = parsed.data.origin as LngLat
  const destination = parsed.data.destination as LngLat
  const vias = (parsed.data.vias ?? []) as LngLat[]

  const key = cacheKey(origin, destination, vias)
  const hit = cache.get(key)
  if (hit) return c.json(hit)

  let res: Response
  try {
    res = await fetch(ROUTES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GMAPS_SERVER_KEY,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        origin: toGoogleWaypoint(origin),
        destination: toGoogleWaypoint(destination),
        // `via: true` makes these pass-through points rather than stopovers.
        // Without it Google treats every shaping point as somewhere the rider
        // stops, which adds stopover semantics to a point that only ever meant
        // "go this way" — and can bend the route to arrive at it properly.
        intermediates: vias.map((v) => ({ ...toGoogleWaypoint(v), via: true })),
        travelMode: TRAVEL_MODE,
        polylineEncoding: 'GEO_JSON_LINESTRING',
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    // A timeout or a DNS failure is ours, not the rider's.
    console.error('[routing] Routes API unreachable:', err instanceof Error ? err.stack : err)
    return c.json({ error: 'routing service unavailable' }, 502)
  }

  if (!res.ok) {
    // The body can carry the key back in an error echo, so log the status and
    // Google's message but never the request.
    const detail = await res.text().catch(() => '')
    console.error(`[routing] Routes API ${res.status}: ${detail.slice(0, 300)}`)
    return c.json({ error: 'routing service rejected the request' }, 502)
  }

  const data = (await res.json().catch(() => null)) as {
    routes?: { polyline?: { geoJsonLinestring?: { coordinates?: unknown } }; distanceMeters?: number; duration?: unknown }[]
  } | null

  const route = data?.routes?.[0]
  const rawCoords = route?.polyline?.geoJsonLinestring?.coordinates

  // An empty `routes` array is how Routes reports "no path", with HTTP 200.
  if (!route || !Array.isArray(rawCoords) || rawCoords.length < 2) {
    return c.json({ error: 'no road route between those points' }, 422)
  }

  const geometry: LngLat[] = []
  for (const p of rawCoords) {
    if (!Array.isArray(p) || p.length < 2) continue
    const lng = Number(p[0])
    const lat = Number(p[1])
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
    geometry.push([round6(lng), round6(lat)])
  }

  if (geometry.length < 2) {
    return c.json({ error: 'no road route between those points' }, 422)
  }

  const leg: RouteLeg = {
    geometry,
    distanceM: Math.round(Number(route.distanceMeters) || 0),
    durationS: parseDuration(route.duration),
  }

  return c.json(remember(key, leg))
})

// --- Geocoding --------------------------------------------------------------

// Address to coordinates, for the two address blocks on the profile page.
//
// Here rather than in the browser for the same reason routing is: the key that
// may call Geocoding is IP-restricted to the server, so a client-side call
// cannot use it. This replaces the direct Mapbox call profile.js used to make,
// which was the last thing keeping MAPBOX_TOKEN alive.
const GEOCODE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json'

const geocodeRequest = z.object({
  // Generous but bounded. Long enough for a full international address, short
  // enough that the endpoint cannot be used to shovel data at Google on our key.
  q: z.string().trim().min(4).max(300),
})

type GeocodeHit = { lat: number; lng: number; label: string }

// Same shape and reasoning as the leg cache above: a rider tabbing between four
// address fields re-submits the same string repeatedly, and Geocoding bills per
// call. Keyed on the normalized query, so "  main st " and "Main St" share.
const GEO_CACHE_MAX = 500
const geoCache = new Map<string, GeocodeHit | null>()

function rememberGeo(key: string, hit: GeocodeHit | null): GeocodeHit | null {
  if (geoCache.size >= GEO_CACHE_MAX) {
    const oldest = geoCache.keys().next().value
    if (oldest !== undefined) geoCache.delete(oldest)
  }
  geoCache.set(key, hit)
  return hit
}

routingRoutes.post('/api/geocode', requireAuthApi, requireActiveApi, requireSameOrigin, async (c) => {
  if (!GMAPS_SERVER_KEY) {
    return c.json({ error: 'geocoding is not configured' }, 503)
  }

  const parsed = geocodeRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'an address is required' }, 400)
  }

  const q = parsed.data.q
  const key = q.toLowerCase().replace(/\s+/g, ' ')

  // A miss is cached too. Repeating a lookup that already failed costs the same
  // as one that succeeds, and a half-typed address gets submitted a lot.
  if (geoCache.has(key)) {
    const hit = geoCache.get(key) ?? null
    return hit ? c.json(hit) : c.json({ error: 'no match for that address' }, 404)
  }

  let res: Response
  try {
    const url = `${GEOCODE_ENDPOINT}?address=${encodeURIComponent(q)}&key=${encodeURIComponent(GMAPS_SERVER_KEY)}`
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    console.error('[geocode] Geocoding API unreachable:', err instanceof Error ? err.stack : err)
    return c.json({ error: 'geocoding service unavailable' }, 502)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error(`[geocode] Geocoding API ${res.status}: ${detail.slice(0, 300)}`)
    return c.json({ error: 'geocoding service rejected the request' }, 502)
  }

  const data = (await res.json().catch(() => null)) as {
    status?: string
    results?: { formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }[]
  } | null

  // Geocoding reports "found nothing" as HTTP 200 with ZERO_RESULTS, the same
  // way Routes reports "no path" as 200 with an empty array.
  const top = data?.results?.[0]
  const loc = top?.geometry?.location
  if (data?.status !== 'OK' || !loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) {
    if (data?.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error(`[geocode] Geocoding API status ${data.status}`)
    }
    rememberGeo(key, null)
    return c.json({ error: 'no match for that address' }, 404)
  }

  return c.json(
    rememberGeo(key, {
      lat: round6(Number(loc.lat)),
      lng: round6(Number(loc.lng)),
      label: top?.formatted_address ?? q,
    })!,
  )
})
