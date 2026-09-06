// The hash a concurrent save is decided by.
//
// Two failure directions, and they are not symmetrical. A hash that misses a
// change loses a rider's work silently. A hash that changes when the route did
// not tells a rider to reload for no reason — every twenty seconds, because the
// autosave keeps firing. The second is the one that arrives by accident, from
// float noise, key order, or a Date and an ISO string of the same instant.
import { describe, expect, it } from 'vitest'
import { routeRevision, type RevisionRoute } from '../src/maps/route-revision'

const route = (over: Partial<RevisionRoute> = {}): RevisionRoute => ({
  uid: 'd1',
  title: 'Route one',
  color: '#0000cc',
  startAt: '2026-08-30T09:00:00.000Z',
  endAt: null,
  altGroup: null,
  altActive: true,
  subgroupUid: null,
  points: [
    { uid: 'p1', kind: 'stop', lng: -122.4194, lat: 37.7749, name: 'Start', roles: ['start'], durationMin: 0 },
    { uid: 'p2', kind: 'poi', lng: -121.4944, lat: 38.5816, name: 'Overlook', roles: [] },
  ],
  legs: [
    {
      geometry: [
        [-122.4194, 37.7749],
        [-121.4944, 38.5816],
      ],
      distanceM: 143000,
      durationS: 5400,
      viaPoints: [],
    },
  ],
  ...over,
})

describe('routeRevision', () => {
  it('is stable across repeated encodings of the same route', () => {
    expect(routeRevision(route())).toBe(routeRevision(route()))
  })

  // Everything routeFingerprint deliberately ignores, this one has to catch: a
  // rename IS an edit, and a merge that misses it discards the rename.
  it('changes on a rename, a recolor and a retime', () => {
    const base = routeRevision(route())
    expect(routeRevision(route({ title: 'Route two' }))).not.toBe(base)
    expect(routeRevision(route({ color: '#ff0000' }))).not.toBe(base)
    expect(routeRevision(route({ startAt: '2026-08-30T10:00:00.000Z' }))).not.toBe(base)
    expect(routeRevision(route({ endAt: '2026-08-30T18:00:00.000Z' }))).not.toBe(base)
  })

  it('changes on an alt regrouping or a deactivation', () => {
    const base = routeRevision(route())
    expect(routeRevision(route({ altGroup: 1 }))).not.toBe(base)
    expect(routeRevision(route({ altActive: false }))).not.toBe(base)
  })

  it('changes when a subgroup tag moves', () => {
    expect(routeRevision(route({ subgroupUid: 'g1' }))).not.toBe(routeRevision(route()))
  })

  it('changes when a point moves, is renamed, retagged, or promoted', () => {
    const base = routeRevision(route())
    const moved = route()
    moved.points[1].lat = 38.9
    expect(routeRevision(moved)).not.toBe(base)

    const renamed = route()
    renamed.points[1].name = 'Vista'
    expect(routeRevision(renamed)).not.toBe(base)

    const promoted = route()
    promoted.points[1].kind = 'stop'
    expect(routeRevision(promoted)).not.toBe(base)

    const retagged = route()
    retagged.points[1].roles = ['gas']
    expect(routeRevision(retagged)).not.toBe(base)
  })

  it('changes when points are reordered, although the set is identical', () => {
    const swapped = route()
    swapped.points.reverse()
    expect(routeRevision(swapped)).not.toBe(routeRevision(route()))
  })

  it('changes when a dwell time changes', () => {
    const d = route()
    d.points[0].durationMin = 30
    expect(routeRevision(d)).not.toBe(routeRevision(route()))
  })

  it('changes when a leg is re-routed to a different length', () => {
    const d = route()
    d.legs[0].distanceM = 150000
    expect(routeRevision(d)).not.toBe(routeRevision(route()))
  })

  it('changes when a shaping via-point is added', () => {
    const d = route()
    d.legs[0].viaPoints = [[-122.0, 38.0]]
    expect(routeRevision(d)).not.toBe(routeRevision(route()))
  })

  // --- and now the spurious-conflict direction ------------------------------

  // A Date out of Postgres and an ISO string off the wire are the same instant.
  // Without normalizing, a route conflicts with itself the first time it is loaded
  // back, and the rider is told to reload on every single save.
  it('reads a Date and an ISO string of the same instant as the same route', () => {
    const asDate = route({ startAt: new Date('2026-08-30T09:00:00.000Z') })
    expect(routeRevision(asDate)).toBe(routeRevision(route()))
  })

  it('ignores float noise below about a meter, which a re-route returns', () => {
    const jittered = route()
    jittered.points[0].lng = -122.41940000001
    jittered.legs[0].geometry[0] = [-122.41940000001, 37.7749]
    expect(routeRevision(jittered)).toBe(routeRevision(route()))
  })

  it('reads the same roles in a different order as the same route', () => {
    const a = route()
    a.points[0].roles = ['gas', 'food']
    const b = route()
    b.points[0].roles = ['food', 'gas']
    expect(routeRevision(a)).toBe(routeRevision(b))
  })

  it('reads an absent optional and an explicit null as the same route', () => {
    const explicit = route()
    explicit.points[1].notes = null
    explicit.points[1].durationMin = null
    const absent = route()
    delete absent.points[1].notes
    delete absent.points[1].durationMin
    expect(routeRevision(explicit)).toBe(routeRevision(absent))
  })

  // altActive defaults to true in the schema, so an absent one and a true one
  // are the same route — but an absent one and a FALSE one are not.
  it('reads an absent altActive as active', () => {
    const absent = route()
    delete absent.altActive
    expect(routeRevision(absent)).toBe(routeRevision(route({ altActive: true })))
    expect(routeRevision(absent)).not.toBe(routeRevision(route({ altActive: false })))
  })

  it('does not collide on adjacent field values running together', () => {
    // 'ab' + '' must not hash as 'a' + 'b'. A separator-free join is how two
    // different routes quietly become one.
    expect(routeRevision(route({ title: 'ab', color: '' }))).not.toBe(routeRevision(route({ title: 'a', color: 'b' })))
  })

  it('survives a route with no legs and a single point', () => {
    const lone = route({ points: [route().points[0]], legs: [] })
    expect(routeRevision(lone)).toMatch(/^[0-9a-f]{32}$/)
  })
})
