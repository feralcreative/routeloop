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
import { prefsKey, routePrefsSchema, toRouteModifiers, wantsTwisty, type RoutePrefs } from '../maps/route-prefs'
import { twistiness } from '../maps/twist'
import { requireActiveApi, requireAuthApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { GMAPS_SERVER_KEY } from '../config'
import { MAX_VIAS_PER_LEG } from '../maps/ride-graph'
import { type AddressHit, type GoogleComponent, addressParts } from '../maps/address'
import { searchPlaces } from '../maps/places'

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
  // WHAT THE DAY ASKS OF THE ROUTER (#29). Optional, so a client that predates
  // it — an open tab mid-edit across the deploy — keeps working and keeps
  // getting the routes it got yesterday.
  prefs: routePrefsSchema.nullable().optional(),
})

// Google returns duration as a string of seconds — "1234s", not 1234.
function parseDuration(d: unknown): number {
  if (typeof d !== 'string') return 0
  const n = Number.parseFloat(d.replace(/s$/, ''))
  return Number.isFinite(n) ? Math.round(n) : 0
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

type RawRoute = {
  polyline?: { geoJsonLinestring?: { coordinates?: unknown } }
  distanceMeters?: number
  duration?: unknown
}

/** A route's coordinates as a Track, or null when it has none worth measuring. */
function trackOf(route: RawRoute | undefined): LngLat[] | null {
  const raw = route?.polyline?.geoJsonLinestring?.coordinates
  if (!Array.isArray(raw)) return null
  const out: LngLat[] = []
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) continue
    const lng = Number(p[0])
    const lat = Number(p[1])
    if (Number.isFinite(lng) && Number.isFinite(lat)) out.push([lng, lat])
  }
  return out.length >= 2 ? out : null
}

/**
 * The twistiest of the routes Google returned (#28).
 *
 * Keeps Google's own order as the tie-break and as the fallback: it returns
 * these best-first by its own reckoning, so an unscoreable set should come back
 * exactly as it arrived rather than in some order of ours.
 */
function twistiest(routes: RawRoute[]): RawRoute | undefined {
  if (routes.length <= 1) return routes[0]
  let best = routes[0]
  let bestScore = -1
  for (const r of routes) {
    const track = trackOf(r)
    const t = track ? twistiness(track) : null
    // Strictly greater, so the first of two equal routes wins and Google's order
    // survives a tie.
    if (t && t.dpm > bestScore) {
      bestScore = t.dpm
      best = r
    }
  }
  return best
}

// Small bounded cache. Editing a ride re-requests the same leg constantly, and
// a plain Map with a cap is enough — this is per-process and deliberately not
// shared state.
const CACHE_MAX = 500
const cache = new Map<string, RouteLeg>()

type RouteLeg = { geometry: LngLat[]; distanceM: number; durationS: number }

function cacheKey(origin: LngLat, destination: LngLat, vias: LngLat[], prefs: RoutePrefs | null | undefined): string {
  const pt = ([lng, lat]: LngLat) => `${round6(lng)},${round6(lat)}`
  // THE PREFERENCES ARE PART OF THE REQUEST AND THEREFORE PART OF THE KEY.
  // Without them an avoid-highways leg and a plain one between the same two
  // points share an entry, so whichever was asked for first is what both get —
  // and the toggle reads as broken while the cache behaves exactly as written.
  // prefsKey() is empty when nothing is set, so every key from before this
  // feature is byte-identical and no existing entry is invalidated.
  const key = [origin, ...vias, destination].map(pt).join(';')
  const p = prefsKey(prefs)
  return p ? `${key}|${p}` : key
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
  const parsed = routeRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'origin and destination are required as [lng, lat]' }, 400)
  }

  const out = await fetchRouteLeg(
    parsed.data.origin as LngLat,
    parsed.data.destination as LngLat,
    (parsed.data.vias ?? []) as LngLat[],
    parsed.data.prefs ?? null,
  )
  if (out.ok) return c.json(out.leg)
  if (out.error === 'unconfigured') return c.json({ error: 'routing is not configured' }, 503)
  if (out.error === 'no-route') return c.json({ error: 'no road route between those points' }, 422)
  if (out.error === 'unreachable') return c.json({ error: 'routing service unavailable' }, 502)
  return c.json({ error: 'routing service rejected the request' }, 502)
})

/** Why a leg could not be fetched. The route above turns these into statuses; a
 *  caller that can carry on without a road treats them all the same. */
export type RouteError = 'unconfigured' | 'unreachable' | 'rejected' | 'no-route'

export type RouteResult = { ok: true; leg: RouteLeg } | { ok: false; error: RouteError }

/**
 * One routed leg, from the cache or from Google.
 *
 * EXPORTED ON 2026-09-03 because the meeting-point proposer became a second
 * caller: it routes each joining group to each candidate, both to draw the
 * approach and to check the distance against the group's fuel range. Sharing
 * this rather than writing a second fetch shares the CACHE, which is the part
 * that matters — the builder asks for the same approach the moment it draws it,
 * and a second implementation would pay for the same road twice.
 *
 * Never throws: every failure is `{ ok: false, error }`.
 */
export async function fetchRouteLeg(
  origin: LngLat,
  destination: LngLat,
  vias: LngLat[] = [],
  prefs: RoutePrefs | null = null,
): Promise<RouteResult> {
  if (!GMAPS_SERVER_KEY) return { ok: false, error: 'unconfigured' }

  const key = cacheKey(origin, destination, vias, prefs)
  const hit = cache.get(key)
  if (hit) return { ok: true, leg: hit }

  const modifiers = toRouteModifiers(prefs)
  const twisty = wantsTwisty(prefs)

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
        // Spread rather than assigned, so a day with no preferences sends the
        // request it sent before this existed — with no `routeModifiers` key at
        // all rather than one holding an object of falses.
        ...(modifiers ? { routeModifiers: modifiers } : {}),
        // #28. Ask for the alternates Google already computes, then score them
        // and keep the twistiest — the router has no notion of a fun road, so
        // this is the only honest way to bias toward one without building a
        // second router.
        //
        // ONLY WITH NO INTERMEDIATES. Routes does not return alternatives for a
        // request carrying waypoints, so asking for them on a shaped leg spends
        // nothing and gets one route back. Guarded here rather than trusted,
        // because a flag that is silently ignored is one nobody notices is doing
        // nothing.
        ...(twisty && vias.length === 0 ? { computeAlternativeRoutes: true } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    // A timeout or a DNS failure is ours, not the rider's.
    console.error('[routing] Routes API unreachable:', err instanceof Error ? err.stack : err)
    return { ok: false, error: 'unreachable' }
  }

  if (!res.ok) {
    // The body can carry the key back in an error echo, so log the status and
    // Google's message but never the request.
    const detail = await res.text().catch(() => '')
    console.error(`[routing] Routes API ${res.status}: ${detail.slice(0, 300)}`)
    return { ok: false, error: 'rejected' }
  }

  const data = (await res.json().catch(() => null)) as {
    routes?: {
      polyline?: { geoJsonLinestring?: { coordinates?: unknown } }
      distanceMeters?: number
      duration?: unknown
    }[]
  } | null

  // THE TWISTIEST OF WHAT CAME BACK, or simply the first when nothing asked for
  // alternates and when only one arrived.
  //
  // SCORED ON dpm RATHER THAN bestDpm, deliberately. bestDpm is the twistiest
  // 20-mile window, which is the right number to SHOW a rider deciding whether a
  // day is worth riding — and the wrong one to pick a leg by, because a route
  // that is superb for five miles and slab for forty would beat one that is good
  // throughout. Choosing a road is a question about the whole road.
  //
  // A ROUTE THAT CANNOT BE SCORED IS NOT DISQUALIFIED, it just cannot win: null
  // means nothing measured it rather than that the road is straight, and Google
  // ordered these by its own preference, so falling back to that order is the
  // honest answer when the scoring has nothing to say.
  const route = twisty ? twistiest(data?.routes ?? []) : data?.routes?.[0]
  const rawCoords = route?.polyline?.geoJsonLinestring?.coordinates

  // An empty `routes` array is how Routes reports "no path", with HTTP 200.
  if (!route || !Array.isArray(rawCoords) || rawCoords.length < 2) {
    return { ok: false, error: 'no-route' }
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
    return { ok: false, error: 'no-route' }
  }

  const leg: RouteLeg = {
    geometry,
    distanceM: Math.round(Number(route.distanceMeters) || 0),
    durationS: parseDuration(route.duration),
  }

  return { ok: true, leg: remember(key, leg) }
}

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

routingRoutes.post('/api/places/search', requireAuthApi, requireActiveApi, requireSameOrigin, async (c) => {
  const parsed = placeSearchRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'a search query is required' }, 400)
  }

  // THE CALL, THE FIELD MASK AND THE CACHE ALL LIVE IN src/maps/places.ts as of
  // 2026-09-03, because the meeting-point proposer needs the same search and two
  // implementations of a billed call is two field masks to get wrong and two
  // caches each paying for what the other already knows. This route's job is now
  // the gate and the status codes.
  const out = await searchPlaces(parsed.data, GMAPS_SERVER_KEY)
  if (out.ok) return c.json({ places: out.places })

  if (out.error === 'unconfigured') return c.json({ error: 'place search is not configured' }, 503)
  if (out.error === 'blocked') {
    return c.json({ error: 'category search is not enabled on the server key—add Places API (New) to it' }, 503)
  }
  if (out.error === 'unreachable') return c.json({ error: 'place search is unavailable' }, 502)
  return c.json({ error: 'place search rejected the request' }, 502)
})
