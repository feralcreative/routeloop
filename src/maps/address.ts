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

/** The four fields a profile address decomposes into.
 *
 *  THE COMPONENTS COST NOTHING EXTRA (#101). The Geocoding API already returns
 *  `address_components` in the response this endpoint has always made and threw
 *  them away; reading them is free. That is what makes a suggestion dropdown on
 *  the profile possible WITHOUT opening a Places Autocomplete SKU billed per
 *  keystroke on a page nobody has to search from.
 *
 *  The trade-off, stated rather than discovered: Geocoding gives fewer and
 *  rougher suggestions for a half-typed address than Places Autocomplete would.
 *  It fills every field correctly once a rider picks one, works outside the US,
 *  and adds no new billing surface, which is the balance this page wants. If the
 *  suggestions ever prove too thin, Autocomplete is the upgrade and it is a spend
 *  decision, not a code one. */
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
