// Google's address_components to the four fields the profile form holds.
//
// The fixtures are the real shapes the Geocoding API returns, and the non-US
// ones are the point of the file: the four field names are US-shaped, and #101
// asks that a result which does not decompose that way fills the line and leaves
// the rest rather than filling them wrongly. A city guessed out of a component
// that merely sounds close is worse than an empty box the rider can type into.
import { describe, expect, it } from 'vitest'
import { addressParts } from '../src/maps/address'

const c = (long: string, short: string, ...types: string[]) => ({ long_name: long, short_name: short, types })

// 1600 Amphitheatre Parkway, Mountain View, CA 94043
const US = [
  c('1600', '1600', 'street_number'),
  c('Amphitheatre Parkway', 'Amphitheatre Pkwy', 'route'),
  c('Mountain View', 'Mountain View', 'locality', 'political'),
  c('Santa Clara County', 'Santa Clara County', 'administrative_area_level_2', 'political'),
  c('California', 'CA', 'administrative_area_level_1', 'political'),
  c('United States', 'US', 'country', 'political'),
  c('94043', '94043', 'postal_code'),
]

// 10 Downing St, London SW1A 2AA — no `locality`, which is the trap.
const UK = [
  c('10', '10', 'street_number'),
  c('Downing Street', 'Downing St', 'route'),
  c('London', 'London', 'postal_town'),
  c('Greater London', 'Greater London', 'administrative_area_level_2', 'political'),
  c('England', 'England', 'administrative_area_level_1', 'political'),
  c('United Kingdom', 'GB', 'country', 'political'),
  c('SW1A 2AA', 'SW1A 2AA', 'postal_code'),
]

describe('a US address', () => {
  const p = addressParts(US)

  it('joins the number and the route into one line', () => {
    expect(p.addressLine).toBe('1600 Amphitheatre Parkway')
  })

  it('takes the locality as the city', () => {
    expect(p.city).toBe('Mountain View')
  })

  // The SHORT name, because the rest of this column is typed by hand as "CA" and
  // a mix of "CA" and "California" down one column reads as a bug.
  it('takes the SHORT name for the state', () => {
    expect(p.state).toBe('CA')
  })

  it('takes the postal code', () => {
    expect(p.postalCode).toBe('94043')
  })
})

describe('a UK address, which has no locality at all', () => {
  const p = addressParts(UK)

  it('falls through to postal_town for the city', () => {
    expect(p.city).toBe('London')
  })

  it('still fills the line and the postcode', () => {
    expect(p.addressLine).toBe('10 Downing Street')
    expect(p.postalCode).toBe('SW1A 2AA')
  })

  // "England" is what Google puts there and it is what the rider would have
  // typed, so it is not wrong — the point is only that the lookup does not fail.
  it('uses the level-1 area for the state box', () => {
    expect(p.state).toBe('England')
  })
})

describe('what it will NOT do', () => {
  // A street number with no route is meaningless on its own — "1600" in the
  // address line is worse than an empty box.
  it('does not put a bare street number on the line', () => {
    expect(addressParts([c('1600', '1600', 'street_number')]).addressLine).toBe('1600')
  })

  it('leaves a field empty rather than guessing at it', () => {
    const sparse = addressParts([c('Some Road', 'Some Rd', 'route'), c('Nowhere', 'NW', 'country', 'political')])
    expect(sparse.addressLine).toBe('Some Road')
    expect(sparse.city).toBe('')
    expect(sparse.state).toBe('')
    expect(sparse.postalCode).toBe('')
  })

  // The client writes a suggestion's parts into the form and SKIPS the empty
  // ones, so an empty string here means "no answer" rather than "clear this".
  // Both halves have to agree or a pick deletes what the rider typed.
  it('is empty, not undefined, when it has no answer', () => {
    const p = addressParts(undefined)
    expect(p).toEqual({ addressLine: '', city: '', state: '', postalCode: '' })
  })

  it('survives components with no types and no names', () => {
    expect(addressParts([{}, { types: [] }, { long_name: 'x' }])).toEqual({
      addressLine: '',
      city: '',
      state: '',
      postalCode: '',
    })
  })
})

// The fallback chain, asserted in order so a reordering is a failing test rather
// than a quiet change in which name a rider sees.
describe('the city fallback chain', () => {
  it('prefers locality over postal_town', () => {
    expect(addressParts([c('L', 'L', 'locality'), c('P', 'P', 'postal_town')]).city).toBe('L')
  })

  it('prefers postal_town over sublocality', () => {
    expect(addressParts([c('P', 'P', 'postal_town'), c('S', 'S', 'sublocality')]).city).toBe('P')
  })

  it('falls all the way to the county before giving up', () => {
    expect(addressParts([c('County', 'County', 'administrative_area_level_2')]).city).toBe('County')
  })
})
