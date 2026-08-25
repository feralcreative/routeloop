import { describe, expect, it } from 'vitest'
import {
  canAddGroup,
  canAddPlace,
  groupInput,
  groupPlaces,
  MAX_GROUPS,
  MAX_PLACES,
  placeInput,
  placeToStop,
} from '../src/places/policy'

const base = { name: 'Bob’s Gas', lat: 38.31, lng: -122.47 }

describe('placeInput', () => {
  it('accepts the minimum: a name and a pin', () => {
    const r = placeInput.safeParse(base)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.groupId).toBeNull()
      expect(r.data.roles).toEqual([])
      expect(r.data.links).toEqual([])
    }
  })

  it('requires a name that is not just whitespace', () => {
    expect(placeInput.safeParse({ ...base, name: '' }).success).toBe(false)
    expect(placeInput.safeParse({ ...base, name: '   ' }).success).toBe(false)
  })

  it('trims the name rather than storing the spaces', () => {
    const r = placeInput.safeParse({ ...base, name: '  Bodega  ' })
    expect(r.success && r.data.name).toBe('Bodega')
  })

  it('bounds the coordinates', () => {
    expect(placeInput.safeParse({ ...base, lat: 91 }).success).toBe(false)
    expect(placeInput.safeParse({ ...base, lng: -181 }).success).toBe(false)
  })

  it('caps roles at the point limit, so a place cannot out-badge a stop', () => {
    expect(placeInput.safeParse({ ...base, roles: ['gas', 'food', 'hotel', 'camp'] }).success).toBe(true)
    expect(placeInput.safeParse({ ...base, roles: ['gas', 'food', 'hotel', 'camp', 'view'] }).success).toBe(false)
  })

  it('rejects a role that is not in the taxonomy', () => {
    expect(placeInput.safeParse({ ...base, roles: ['helipad'] }).success).toBe(false)
  })

  // Same rule a stop's links follow: these render as hrefs, so http(s) only.
  it('rejects a javascript: link', () => {
    expect(placeInput.safeParse({ ...base, links: [{ label: 'x', url: 'javascript:alert(1)' }] }).success).toBe(false)
  })

  it('caps the number of links', () => {
    const links = Array.from({ length: 6 }, () => ({ label: 'a', url: 'https://example.com' }))
    expect(placeInput.safeParse({ ...base, links }).success).toBe(false)
  })

  // Confirmation numbers and check-in times belong to a trip, not to a place.
  // Zod strips unknown keys, so this pins that they never reach the row.
  it('does not carry per-trip fields', () => {
    const r = placeInput.safeParse({ ...base, confirmation: 'ABC123', checkInAt: '2026-09-01T15:00:00Z' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect('confirmation' in r.data).toBe(false)
      expect('checkInAt' in r.data).toBe(false)
    }
  })
})

describe('groupInput', () => {
  it('requires a name', () => {
    expect(groupInput.safeParse({ name: '' }).success).toBe(false)
    expect(groupInput.safeParse({ name: '  ' }).success).toBe(false)
    expect(groupInput.safeParse({ name: 'Bay Area fuel' }).success).toBe(true)
  })

  it('caps the length', () => {
    expect(groupInput.safeParse({ name: 'x'.repeat(81) }).success).toBe(false)
  })
})

// The copy-not-reference decision, in code. Ziad's call 2026-08-21.
describe('placeToStop', () => {
  const place = {
    name: 'The Union Hotel',
    lat: 38.33,
    lng: -122.87,
    roles: ['hotel'],
    phone: '+1 555 0134',
    address: '11 Bodega Hwy',
    links: [{ label: 'Booking', url: 'https://example.com' }],
  }

  it('copies name, pin and roles', () => {
    const stop = placeToStop(place)
    expect(stop.name).toBe('The Union Hotel')
    expect(stop.lat).toBe(38.33)
    expect(stop.roles).toEqual(['hotel'])
  })

  // The whole point of the decision: nothing on the resulting stop points back
  // at the place, so renaming or deleting the place cannot reach a saved ride.
  it('leaves no reference back to the place', () => {
    const stop = placeToStop({ ...place, id: 7, ownerId: 3 } as never)
    expect(JSON.stringify(stop)).not.toContain('placeId')
    expect('id' in stop).toBe(false)
  })

  it('carries the durable half of the details', () => {
    const stop = placeToStop(place)
    expect(stop.details?.phone).toBe('+1 555 0134')
    expect(stop.details?.address).toBe('11 Bodega Hwy')
    expect(stop.details?.links).toEqual([{ label: 'Booking', url: 'https://example.com' }])
  })

  // A confirmation number is a fact about one trip. Inheriting last trip's would
  // be worse than having none.
  it('leaves the per-trip fields empty', () => {
    const stop = placeToStop(place)
    expect(stop.details?.confirmation).toBe('')
    expect(stop.details?.checkInAt).toBeNull()
    expect(stop.details?.checkOutAt).toBeNull()
    expect(stop.details?.notes).toBe('')
  })

  // A bare pin must not create an empty point_details row in every ride it
  // lands in.
  it('gives a bare pin no details at all', () => {
    const stop = placeToStop({ ...place, phone: null, address: null, links: [] })
    expect(stop.details).toBeNull()
  })
})

describe('groupPlaces', () => {
  const g = (id: number, name: string, position: number) => ({ id, name, position })
  const p = (name: string, groupId: number | null) => ({ name, groupId })

  it('orders groups by position, not by name', () => {
    const out = groupPlaces([g(1, 'Zed', 0), g(2, 'Alpha', 1)], [])
    expect(out.map((s) => s.group?.name)).toEqual(['Zed', 'Alpha'])
  })

  it('sorts places inside a group by name', () => {
    const out = groupPlaces([g(1, 'Fuel', 0)], [p('Zeta', 1), p('Alpha', 1)])
    expect(out[0].places.map((x) => x.name)).toEqual(['Alpha', 'Zeta'])
  })

  // Ungrouped is a footer, not a headline: a rider who has organized their
  // library should see the organization first.
  it('puts the ungrouped section last', () => {
    const out = groupPlaces([g(1, 'Fuel', 0)], [p('Loose', null), p('Filed', 1)])
    expect(out).toHaveLength(2)
    expect(out[1].group).toBeNull()
    expect(out[1].places.map((x) => x.name)).toEqual(['Loose'])
  })

  it('omits the ungrouped section entirely when there is nothing in it', () => {
    const out = groupPlaces([g(1, 'Fuel', 0)], [p('Filed', 1)])
    expect(out).toHaveLength(1)
    expect(out[0].group?.name).toBe('Fuel')
  })

  it('keeps an empty group rather than hiding it', () => {
    // A rider who just made a group needs to see it in order to file into it.
    const out = groupPlaces([g(1, 'New', 0)], [])
    expect(out).toHaveLength(1)
    expect(out[0].places).toEqual([])
  })

  // Deleting a group is `set null`, not cascade, so its places land here rather
  // than vanishing. This is the test that would catch someone "tidying" that FK.
  it('rescues places whose group was deleted', () => {
    const out = groupPlaces([], [p('Orphan', null)])
    expect(out).toHaveLength(1)
    expect(out[0].group).toBeNull()
    expect(out[0].places.map((x) => x.name)).toEqual(['Orphan'])
  })

  it('returns nothing for an empty library', () => {
    expect(groupPlaces([], [])).toEqual([])
  })
})

describe('the caps', () => {
  it('lets a rider add up to the limit and not past it', () => {
    expect(canAddPlace(MAX_PLACES - 1)).toBe(true)
    expect(canAddPlace(MAX_PLACES)).toBe(false)
    expect(canAddGroup(MAX_GROUPS - 1)).toBe(true)
    expect(canAddGroup(MAX_GROUPS)).toBe(false)
  })
})
