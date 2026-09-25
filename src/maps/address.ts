// Google's `address_components` to the four fields the profile form holds.
//
// THE PURE HALF, split from src/routes/routing.ts the way this codebase splits
// every rule from its query — invites, survey, stats, feedback, access, friends,
// members, votes, subgroups and follows all do it. The reason here is the usual
// one: the decomposition is a table of guesses about how the world names places,
// and a table of guesses wants a test far more than it wants a live API key.
//
// It is also the only part of the geocoding path that CAN be tested. The route
// around it needs Google; this needs a fixture.

/** The four fields a profile address decomposes into. Filled from Geocoding's
 *  `address_components` when a typed address is placed on blur, and from Places
 *  (New) `addressComponents`, via `fromPlacesComponents`, when a rider picks a
 *  result from the profile's lookup. */
export type AddressParts = {
  addressLine: string
  city: string
  state: string
  postalCode: string
}

/** Google's `address_components` to the four fields the form asks for.
 *
 *  US-SHAPED NAMES, DEGRADING RATHER THAN GUESSING. `locality` is absent in
 *  plenty of countries and `postal_town` or `sublocality` is what carries the
 *  town; where none of them appear the field is left EMPTY rather than filled
 *  from something that merely sounds close. #101 asks for exactly that: a
 *  structured result that does not decompose this way should fill the line and
 *  leave the rest, not fill them wrongly. */
export function addressParts(components: GoogleComponent[] | undefined): AddressParts {
  const of = (...types: string[]) => {
    for (const t of types) {
      const hit = components?.find((c) => c.types?.includes(t))
      if (hit?.long_name) return hit.long_name
    }
    return ''
  }
  const number = of('street_number')
  const street = of('route')
  return {
    // A street number with no route is meaningless on its own, so the line is
    // the route with the number in front of it when there is one.
    addressLine: [number, street].filter(Boolean).join(' '),
    city: of('locality', 'postal_town', 'sublocality', 'administrative_area_level_2'),
    // The SHORT name for a state — the form's other values are typed by hand as
    // "CA", and a mix of "CA" and "California" down one column reads as a bug.
    state: (() => {
      const hit = components?.find((c) => c.types?.includes('administrative_area_level_1'))
      return hit?.short_name || hit?.long_name || ''
    })(),
    postalCode: of('postal_code'),
  }
}

export type GoogleComponent = { long_name?: string; short_name?: string; types?: string[] }

/** One geocoder result: where it is, what it is called, and its parts. */
export type AddressHit = { lat: number; lng: number; label: string; parts?: AddressParts }

/** Places API (New) spells a component `{longText, shortText, types}`; the
 *  Geocoding shape above is what `addressParts` reads, so this converts. */
export type PlacesComponent = { longText?: string; shortText?: string; types?: string[] }
export const fromPlacesComponents = (c: PlacesComponent[] | undefined): GoogleComponent[] =>
  (c ?? []).map((x) => ({ long_name: x.longText, short_name: x.shortText, types: x.types }))

/** Types that mean the place IS an address rather than somewhere with a name. */
const ADDRESS_TYPES = new Set(['street_address', 'premise', 'subpremise', 'route', 'postal_code', 'plus_code'])

/** Whether a picked place is a business or landmark worth naming the block after. */
export const isNamedPlace = (types: string[] | undefined): boolean =>
  !!types && types.length > 0 && !types.some((t) => ADDRESS_TYPES.has(t) || t.startsWith('locality'))
