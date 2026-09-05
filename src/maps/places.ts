// Google Places Text Search, in one place.
//
// EXTRACTED FROM `routes/routing.ts` ON 2026-09-03 because a second caller
// appeared: the meeting-point proposer needs gas stations along a road, and the
// alternative was a second fetch, a second field mask and a second cache. Two
// implementations of a billed call is two places to get the field mask wrong
// and two caches that each pay for what the other already knows.
//
// THE CACHE IS THE POINT OF SHARING IT. Text Search is billed per REQUEST, and
// the same query anchored at the same place is asked repeatedly — a rider
// retyping in the dropdown, a proposal re-run after an edit. The key carries
// everything that changes the answer, `wide` included: the narrow and the wide
// reply to one query are different lists, and serving one for the other gives a
// corridor search eight results because a dropdown asked first.
// `[lng, lat]`, like every coordinate in this app. Declared here rather than
// imported because kml.ts exports the Track (an array of these) and not the pair
// itself, and a one-line alias beats widening that module's surface for it.
type LngLat = [number, number]

const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'

// The field mask is what Google prices this on, so every field is money.
// `primaryType` is the one worth questioning: it is only used to tag a result
// with a role (a `gas_station` becomes Gas), and it can put the call in a higher
// SKU than the other three. Drop it first if the bill argues — roleForType()
// already treats an unknown type as untagged rather than guessing.
const PLACES_FIELD_MASK = 'places.displayName,places.formattedAddress,places.location,places.primaryType'

/** Eight is a dropdown, not a directory. Text Search will return twenty and the
 *  rider will read four. */
export const MAX_PLACE_RESULTS = 8

/**
 * A CORRIDOR SEARCH IS NOT A DROPDOWN, so it asks for the twenty. #50 filters
 * what comes back to a band either side of the day's line and throws most of it
 * away — eight results biased at one point routinely survives as two, which
 * reads as "there is nowhere" rather than "we only looked in one place".
 *
 * **THIS COSTS NOTHING EXTRA, and that is the belief the change rests on rather
 * than something measured here: Text Search (New) is billed per REQUEST, not per
 * result, so twenty and eight are the same call and the same money.** Worth
 * confirming against a real bill before leaning on it further. Twenty is the
 * API's own ceiling.
 */
export const MAX_CORRIDOR_RESULTS = 20

/** Used only when `near` is supplied and no radius is. Wide enough to cover a
 *  town and its outskirts, narrow enough that "coffee" anchored to a stop does
 *  not answer with the next county. */
export const DEFAULT_BIAS_RADIUS_M = 25_000

export type PlaceHit = { name: string; address: string; lngLat: LngLat; type: string | null }

/** Why a search could not be answered. The route turns these into statuses; the
 *  proposer treats every one of them as "no stations found" and carries on,
 *  because a meeting point without a forecourt is still a meeting point. */
export type PlacesError = 'unconfigured' | 'unreachable' | 'blocked' | 'rejected'

export type PlacesResult = { ok: true; places: PlaceHit[] } | { ok: false; error: PlacesError }

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

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

export type PlaceSearch = {
  query: string
  near?: LngLat
  radiusM?: number
  wide?: boolean
}

/**
 * Run a Text Search, or answer from the cache.
 *
 * Never throws: every failure comes back as `{ ok: false, error }` so a caller
 * that can carry on without places does not have to wrap it. The route turns
 * them into HTTP statuses and the proposer ignores them.
 */
export async function searchPlaces(req: PlaceSearch, apiKey: string): Promise<PlacesResult> {
  if (!apiKey) return { ok: false, error: 'unconfigured' }

  const key = [
    req.query.toLowerCase().replace(/\s+/g, ' '),
    req.near ? req.near.map(round6).join(',') : '',
    req.radiusM ?? '',
    req.wide ? 'w' : '',
  ].join('|')
  const cached = placesCache.get(key)
  if (cached) return { ok: true, places: cached }

  const body: Record<string, unknown> = {
    textQuery: req.query,
    maxResultCount: req.wide ? MAX_CORRIDOR_RESULTS : MAX_PLACE_RESULTS,
  }
  if (req.near) {
    body.locationBias = {
      circle: {
        center: { latitude: req.near[1], longitude: req.near[0] },
        radius: req.radiusM ?? DEFAULT_BIAS_RADIUS_M,
      },
    }
  }

  let res: Response
  try {
    res = await fetch(PLACES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': PLACES_FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    console.error('[places] Text Search unreachable:', err instanceof Error ? err.stack : err)
    return { ok: false, error: 'unreachable' }
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // The body can echo the key back in an error, so only the status and a
    // bounded slice are logged — same rule as the Routes proxy.
    console.error(`[places] Text Search ${res.status}: ${detail.slice(0, 300)}`)
    // THE ONE FAILURE WORTH NAMING SEPARATELY. A server key restricted to Routes
    // and Geocoding answers every Text Search with 403 API_KEY_SERVICE_BLOCKED,
    // which is a console change and not a code problem — and reporting it as a
    // generic outage would send whoever meets it looking in the wrong place.
    if (res.status === 403 && detail.includes('API_KEY_SERVICE_BLOCKED')) return { ok: false, error: 'blocked' }
    return { ok: false, error: 'rejected' }
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

  return { ok: true, places: rememberPlaces(key, hits) }
}
