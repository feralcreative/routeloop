// The hash a concurrent save is decided by.
//
// Two failure directions, and they are not symmetrical. A hash that misses a
// change loses a rider's work silently. A hash that changes when the day did
// not tells a rider to reload for no reason — every twenty seconds, because the
// autosave keeps firing. The second is the one that arrives by accident, from
// float noise, key order, or a Date and an ISO string of the same instant.
import { describe, expect, it } from 'vitest'
import { dayRevision, type RevisionDay } from '../src/maps/day-revision'

const day = (over: Partial<RevisionDay> = {}): RevisionDay => ({
  uid: 'd1',
  title: 'Day one',
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

describe('dayRevision', () => {
  it('is stable across repeated encodings of the same day', () => {
    expect(dayRevision(day())).toBe(dayRevision(day()))
  })

  // Everything dayFingerprint deliberately ignores, this one has to catch: a
  // rename IS an edit, and a merge that misses it discards the rename.
  it('changes on a rename, a recolor and a retime', () => {
    const base = dayRevision(day())
    expect(dayRevision(day({ title: 'Day two' }))).not.toBe(base)
    expect(dayRevision(day({ color: '#ff0000' }))).not.toBe(base)
    expect(dayRevision(day({ startAt: '2026-08-30T10:00:00.000Z' }))).not.toBe(base)
    expect(dayRevision(day({ endAt: '2026-08-30T18:00:00.000Z' }))).not.toBe(base)
  })

  it('changes on an alt regrouping or a deactivation', () => {
    const base = dayRevision(day())
    expect(dayRevision(day({ altGroup: 1 }))).not.toBe(base)
    expect(dayRevision(day({ altActive: false }))).not.toBe(base)
  })

  it('changes when a subgroup tag moves', () => {
    expect(dayRevision(day({ subgroupUid: 'g1' }))).not.toBe(dayRevision(day()))
  })

  it('changes when a point moves, is renamed, retagged, or promoted', () => {
    const base = dayRevision(day())
    const moved = day()
    moved.points[1].lat = 38.9
    expect(dayRevision(moved)).not.toBe(base)

    const renamed = day()
    renamed.points[1].name = 'Vista'
    expect(dayRevision(renamed)).not.toBe(base)

    const promoted = day()
    promoted.points[1].kind = 'stop'
    expect(dayRevision(promoted)).not.toBe(base)

    const retagged = day()
    retagged.points[1].roles = ['gas']
    expect(dayRevision(retagged)).not.toBe(base)
  })

  it('changes when points are reordered, although the set is identical', () => {
    const swapped = day()
    swapped.points.reverse()
    expect(dayRevision(swapped)).not.toBe(dayRevision(day()))
  })

  it('changes when a dwell time changes', () => {
    const d = day()
    d.points[0].durationMin = 30
    expect(dayRevision(d)).not.toBe(dayRevision(day()))
  })

  it('changes when a leg is re-routed to a different length', () => {
    const d = day()
    d.legs[0].distanceM = 150000
    expect(dayRevision(d)).not.toBe(dayRevision(day()))
  })

  it('changes when a shaping via-point is added', () => {
    const d = day()
    d.legs[0].viaPoints = [[-122.0, 38.0]]
    expect(dayRevision(d)).not.toBe(dayRevision(day()))
  })

  // --- and now the spurious-conflict direction ------------------------------

  // A Date out of Postgres and an ISO string off the wire are the same instant.
  // Without normalizing, a day conflicts with itself the first time it is loaded
  // back, and the rider is told to reload on every single save.
  it('reads a Date and an ISO string of the same instant as the same day', () => {
    const asDate = day({ startAt: new Date('2026-08-30T09:00:00.000Z') })
    expect(dayRevision(asDate)).toBe(dayRevision(day()))
  })

  it('ignores float noise below about a meter, which a re-route returns', () => {
    const jittered = day()
    jittered.points[0].lng = -122.41940000001
    jittered.legs[0].geometry[0] = [-122.41940000001, 37.7749]
    expect(dayRevision(jittered)).toBe(dayRevision(day()))
  })

  it('reads the same roles in a different order as the same day', () => {
    const a = day()
    a.points[0].roles = ['gas', 'food']
    const b = day()
    b.points[0].roles = ['food', 'gas']
    expect(dayRevision(a)).toBe(dayRevision(b))
  })

  it('reads an absent optional and an explicit null as the same day', () => {
    const explicit = day()
    explicit.points[1].notes = null
    explicit.points[1].durationMin = null
    const absent = day()
    delete absent.points[1].notes
    delete absent.points[1].durationMin
    expect(dayRevision(explicit)).toBe(dayRevision(absent))
  })

  // altActive defaults to true in the schema, so an absent one and a true one
  // are the same day — but an absent one and a FALSE one are not.
  it('reads an absent altActive as active', () => {
    const absent = day()
    delete absent.altActive
    expect(dayRevision(absent)).toBe(dayRevision(day({ altActive: true })))
    expect(dayRevision(absent)).not.toBe(dayRevision(day({ altActive: false })))
  })

  it('does not collide on adjacent field values running together', () => {
    // 'ab' + '' must not hash as 'a' + 'b'. A separator-free join is how two
    // different days quietly become one.
    expect(dayRevision(day({ title: 'ab', color: '' }))).not.toBe(dayRevision(day({ title: 'a', color: 'b' })))
  })

  it('survives a day with no legs and a single point', () => {
    const lone = day({ points: [day().points[0]], legs: [] })
    expect(dayRevision(lone)).toMatch(/^[0-9a-f]{32}$/)
  })
})
