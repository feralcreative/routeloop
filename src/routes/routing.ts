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
import { type AddressHit, type GoogleComponent, addressParts } from '../maps/address'

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

/** Re-exported under the name this module has always used, so the endpoint below
 *  reads as it did. The type itself lives in src/maps/address.ts now, with the
 *  decomposition it belongs to. */
type GeocodeHit = AddressHit

// Same shape and reasoning as the leg cache above: a rider tabbing between four
// address fields re-submits the same string repeatedly, and Geocoding bills per
// call. Keyed on the normalized query, so "  main st " and "Main St" share.
const GEO_CACHE_MAX = 500

/** THE WHOLE RESPONSE IS CACHED, NOT JUST THE TOP HIT, and that matters since
 *  #101: the suggestion list is built from the same billed call, so caching only
 *  the first result would give a rider a dropdown the first time they typed an
 *  address and an empty one every time after — working, then silently not. */
type GeocodeAnswer = GeocodeHit & { suggestions: GeocodeHit[] }

const geoCache = new Map<string, GeocodeAnswer | null>()

function rememberGeo(key: string, hit: GeocodeAnswer | null): GeocodeAnswer | null {
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
    error_message?: string
    results?: {
      formatted_address?: string
      geometry?: { location?: { lat?: number; lng?: number } }
      address_components?: GoogleComponent[]
    }[]
  } | null

  // **A FAILURE IS NOT A MISS, AND IT MUST NOT BE CACHED AS ONE.**
  //
  // Geocoding reports "found nothing" as HTTP 200 with ZERO_RESULTS, the same
  // way Routes reports "no path" as 200 with an empty array. It also reports
  // OVER_QUERY_LIMIT, REQUEST_DENIED and INVALID_REQUEST as HTTP 200 — so a
  // handler that treats every non-OK status the same way tells a rider their
  // address does not exist when the truth is that the key is out of quota or was
  // never authorized for this API.
  //
  // Observed 2026-08-27, which is what prompted this: every local lookup came
  // back "no match for that address" and the API was actually answering
  // OVER_QUERY_LIMIT with "verify your project has an active billing account".
  // The rider-facing message was wrong and the failure was invisible.
  //
  // Worse, the old code called rememberGeo(key, null) on it — so a quota blip
  // POISONED THE CACHE for that address for the life of the process, and the
  // address kept reading as nonexistent long after the quota reset. Only a real
  // ZERO_RESULTS is cached now.
  //
  // Same shape as the Places 403 handling this file already does: a 503 naming
  // the reason, because "the service is unavailable" is a different thing for a
  // rider to be told than "we looked and it is not there".
  const status = data?.status
  if (status && status !== 'OK' && status !== 'ZERO_RESULTS') {
    console.error(`[geocode] Geocoding API status ${status}: ${data?.error_message ?? ''}`)
    return c.json({ error: 'address lookup is unavailable right now' }, 503)
  }

  const top = data?.results?.[0]
  const loc = top?.geometry?.location
  if (status !== 'OK' || !loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) {
    rememberGeo(key, null)
    return c.json({ error: 'no match for that address' }, 404)
  }

  // Capped at five: the list is a dropdown under a form field, and Geocoding
  // occasionally returns a dozen near-identical matches for a vague query.
  const suggestions: GeocodeHit[] = []
  for (const r of (data?.results ?? []).slice(0, 5)) {
    const l = r.geometry?.location
    if (!l || !Number.isFinite(l.lat) || !Number.isFinite(l.lng)) continue
    suggestions.push({
      lat: round6(Number(l.lat)),
      lng: round6(Number(l.lng)),
      label: r.formatted_address ?? q,
      parts: addressParts(r.address_components),
    })
  }

  // THE TOP-LEVEL SHAPE IS UNCHANGED and `suggestions` is added beside it. The
  // geocoder's existing caller reads lat/lng/label off the root and is untouched;
  // the dropdown reads the array. One response, one billed call, two consumers.
  return c.json(
    rememberGeo(key, {
      lat: round6(Number(loc.lat)),
      lng: round6(Number(loc.lng)),
      label: top?.formatted_address ?? q,
      parts: addressParts(top?.address_components),
      suggestions,
    })!,
  )
})

// --- Place category search --------------------------------------------------

// "Find me a gas station in Oakdale", which Autocomplete cannot answer.
//
// Autocomplete matches NAMES and ADDRESSES. Asked for a category it returns the
// businesses literally called that — searching "gas station in oakdale ca"
// returned exactly one result, a place named "76 Gas Station", while the ARCO,
// the Shell and the other 76 in the same town went unmentioned. Enumerating a
// kind of place is Text Search's job, which is a different endpoint on a
// different SKU.
//
// THE PLACE IN THE QUERY IS NOT GEOCODED SEPARATELY. Text Search reads "X in Y"
// itself — the API's own documented example is "Spicy Vegetarian Food in Sydney,
// Australia" — so the whole phrase goes through as `textQuery` and the extra
// Geocoding call that would otherwise be needed never happens. `near` is for the
// case with no place in the text at all: a category chip, which anchors to the
// day's last point or the map viewport.
//
// Here rather than in the browser for the cache. Text Search bills per call and
// costs materially more than the Autocomplete session it sits beside, and a
// rider tapping the same chip twice or retyping a query must not pay twice. Same
// argument, and the same bounded-Map shape, as the leg cache above.
const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'

// The field mask is what Google prices this on, so every field is money.
// `primaryType` is the one worth questioning: it is only used to tag a result
// with a role (a `gas_station` becomes Gas), and it can put the call in a higher
// SKU than the other three. Drop it first if the bill argues — roleForType()
// already treats an unknown type as untagged rather than guessing.
const PLACES_FIELD_MASK = 'places.displayName,places.formattedAddress,places.location,places.primaryType'

// Eight is a dropdown, not a directory. Text Search will return twenty and the
// rider will read four.
const MAX_PLACE_RESULTS = 8

// A CORRIDOR SEARCH IS NOT A DROPDOWN, so it asks for the twenty. #50 filters
// what comes back to a band either side of the day's line and throws most of it
// away — eight results biased at one point routinely survives as two, which
// reads as "there is nowhere" rather than "we only looked in one place".
//
// **THIS COSTS NOTHING EXTRA, and that is the belief the change rests on rather
// than something measured here: Text Search (New) is billed per REQUEST, not per
// result, so twenty and eight are the same call and the same money.** Worth
// confirming against a real bill before leaning on it further. Twenty is the
// API's own ceiling.
const MAX_CORRIDOR_RESULTS = 20

// Used only when `near` is supplied and no radius is. Wide enough to cover a
// town and its outskirts, narrow enough that "coffee" anchored to a stop does
// not answer with the next county.
const DEFAULT_BIAS_RADIUS_M = 25_000

const placeSearchRequest = z.object({
  // Bounded for the same reason the geocode query is: this endpoint spends our
  // key, so it cannot be a pipe for arbitrary volume.
  query: z.string().trim().min(2).max(200),
  near: coord.optional(),
  radiusM: z.number().int().min(500).max(50_000).optional(),
  // Opt-in, so every existing caller keeps the eight-result dropdown it was
  // written for and only the corridor search asks for the wider set.
  wide: z.boolean().optional(),
})

type PlaceHit = { name: string; address: string; lngLat: LngLat; type: string | null }

const PLACES_CACHE_MAX = 300
const placesCache = new Map<string, PlaceHit[]>()

function rememberPlaces(key: string, hits: PlaceHit[]): PlaceHit[] {
  if (placesCache.size >= PLACES_CACHE_MAX) {
    const oldest = placesCache.keys().next().value
    if (oldest !== undefined) placesCache.delete(oldest)
  }
  placesCache.set(key, hits)
  return hits
}

routingRoutes.post('/api/places/search', requireAuthApi, requireActiveApi, requireSameOrigin, async (c) => {
  if (!GMAPS_SERVER_KEY) {
    return c.json({ error: 'place search is not configured' }, 503)
  }

  const parsed = placeSearchRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'a search query is required' }, 400)
  }

  const { query, near, radiusM, wide } = parsed.data
  // `wide` is part of the cache key: the narrow and the wide answer to the same
  // query are different lists, and serving one for the other would give a
  // corridor search eight results because a dropdown asked first.
  const key = [
    query.toLowerCase().replace(/\s+/g, ' '),
    near ? near.map(round6).join(',') : '',
    radiusM ?? '',
    wide ? 'w' : '',
  ].join('|')
  const cached = placesCache.get(key)
  if (cached) return c.json({ places: cached })

  const body: Record<string, unknown> = {
    textQuery: query,
    maxResultCount: wide ? MAX_CORRIDOR_RESULTS : MAX_PLACE_RESULTS,
  }
  if (near) {
    body.locationBias = {
      circle: {
        center: { latitude: near[1], longitude: near[0] },
        radius: radiusM ?? DEFAULT_BIAS_RADIUS_M,
      },
    }
  }

  let res: Response
  try {
    res = await fetch(PLACES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GMAPS_SERVER_KEY,
        'X-Goog-FieldMask': PLACES_FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    console.error('[places] Text Search unreachable:', err instanceof Error ? err.stack : err)
    return c.json({ error: 'place search is unavailable' }, 502)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // The body can echo the key back in an error, so only the status and a
    // bounded slice are logged — same rule as the Routes proxy above.
    console.error(`[places] Text Search ${res.status}: ${detail.slice(0, 300)}`)
    // THE ONE FAILURE WORTH NAMING SEPARATELY. A server key restricted to Routes
    // and Geocoding answers every Text Search with 403 API_KEY_SERVICE_BLOCKED,
    // which is a console change and not a code problem — and reporting it as a
    // generic outage would send whoever meets it looking in the wrong place.
    if (res.status === 403 && detail.includes('API_KEY_SERVICE_BLOCKED')) {
      return c.json({ error: 'category search is not enabled on the server key—add Places API (New) to it' }, 503)
    }
    return c.json({ error: 'place search rejected the request' }, 502)
  }

  const data = (await res.json().catch(() => null)) as {
    places?: {
      displayName?: { text?: string }
      formattedAddress?: string
      location?: { latitude?: number; longitude?: number }
      primaryType?: string
    }[]
  } | null

  // No match is a 200 with the array absent, not an error — the same way Routes
  // reports "no path" and Geocoding reports ZERO_RESULTS. An empty list is a
  // real answer and it is cached, because a query that found nothing gets
  // retyped as often as one that found something.
  const hits: PlaceHit[] = (data?.places ?? [])
    .map((p) => {
      const lat = p.location?.latitude
      const lng = p.location?.longitude
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
      return {
        name: p.displayName?.text ?? '',
        address: p.formattedAddress ?? '',
        lngLat: [round6(Number(lng)), round6(Number(lat))] as LngLat,
        type: p.primaryType ?? null,
      }
    })
    .filter((h): h is PlaceHit => h !== null)

  return c.json({ places: rememberPlaces(key, hits) })
})
