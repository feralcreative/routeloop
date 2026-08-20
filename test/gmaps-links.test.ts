// Google Maps hand-off links.
//
// The numbers here are not arbitrary: 9 waypoints and the current-location
// behavior were confirmed on an iPhone against a real 11-point route, and the
// batching exists because Maps silently drops what it cannot carry.
import { describe, expect, it } from 'vitest'
import { MAX_POINTS_PER_LINK, linkLabel, routeLinks } from '../src/maps/gmaps-links'
import type { ExportPoint, ExportDay } from '../src/maps/export'

const stop = (n: number, kind: 'stop' | 'poi' = 'stop'): ExportPoint => ({
  lat: 37 + n / 100,
  lng: -122 + n / 100,
  name: `Stop ${n}`,
  description: null,
  roles: [],
  kind,
  durationMin: null,
  distFromStartM: null,
})

const routeOf = (points: ExportPoint[], title: string | null = 'Day 1'): ExportDay => ({
  title,
  color: '#cc0000',
  distanceM: 0,
  durationS: 0,
  startAt: null,
  endAt: null,
  twistinessDpm: null,
  twistinessBestDpm: null,
  track: [],
  points,
})

const params = (url: string) => new URL(url).searchParams
const waypointsOf = (url: string) => (params(url).get('waypoints') ?? '').split('|').filter(Boolean)

describe('one link', () => {
  it('puts the ends on origin and destination and the rest in waypoints', () => {
    const { links } = routeLinks(routeOf([stop(1), stop(2), stop(3)]))
    expect(links).toHaveLength(1)
    const p = params(links[0].url)
    expect(p.get('origin')).toBe('37.01,-121.99')
    expect(p.get('destination')).toBe('37.03,-121.97')
    expect(waypointsOf(links[0].url)).toEqual(['37.02,-121.98'])
  })

  it('asks for driving unless told otherwise', () => {
    expect(params(routeLinks(routeOf([stop(1), stop(2)])).links[0].url).get('travelmode')).toBe('driving')
    const tw = routeLinks(routeOf([stop(1), stop(2)]), { travelMode: 'two-wheeler' })
    expect(params(tw.links[0].url).get('travelmode')).toBe('two-wheeler')
  })

  it('is a plain destination when there is only one stop', () => {
    const { links } = routeLinks(routeOf([stop(1)]))
    expect(links).toHaveLength(1)
    expect(params(links[0].url).get('destination')).toBe('37.01,-121.99')
    expect(params(links[0].url).has('origin')).toBe(false)
    expect(params(links[0].url).has('waypoints')).toBe(false)
  })

  it('produces nothing for a route with no stops at all', () => {
    expect(routeLinks(routeOf([])).links).toEqual([])
  })
})

describe('starting from where the rider is', () => {
  // Confirmed on an iPhone: with no origin, Maps says "Your location" and
  // offers Start instead of Preview.
  it('drops the origin on the first link only', () => {
    const { links } = routeLinks(routeOf(Array.from({ length: 20 }, (_, i) => stop(i))), {
      fromCurrentLocation: true,
    })
    expect(params(links[0].url).has('origin')).toBe(false)
    expect(params(links[1].url).has('origin')).toBe(true)
  })

  it('keeps the dropped origin as a waypoint rather than losing the stop', () => {
    const withOrigin = routeLinks(routeOf([stop(1), stop(2), stop(3)]))
    const without = routeLinks(routeOf([stop(1), stop(2), stop(3)]), { fromCurrentLocation: true })
    // Same three stops either way; one of them just moves from origin to
    // waypoint. Riding through it is not optional.
    expect(waypointsOf(without.links[0].url)).toEqual(['37.01,-121.99', '37.02,-121.98'])
    expect(waypointsOf(withOrigin.links[0].url)).toEqual(['37.02,-121.98'])
  })
})

describe('batching a long day', () => {
  const long = (n: number) => routeLinks(routeOf(Array.from({ length: n }, (_, i) => stop(i))))

  // The cap is the entire reason this module exists: Maps drops what it cannot
  // carry without saying so, and a rider finds out by missing the road.
  it('never exceeds what Maps will carry', () => {
    for (const n of [2, 11, 12, 25, 40, 97]) {
      for (const opts of [{}, { fromCurrentLocation: true }]) {
        const links = routeLinks(routeOf(Array.from({ length: n }, (_, i) => stop(i))), opts).links
        for (const l of links) {
          expect(l.points.length).toBeLessThanOrEqual(MAX_POINTS_PER_LINK)
          expect(waypointsOf(l.url).length).toBeLessThanOrEqual(9)
        }
      }
    }
  })

  // Dropping the origin promotes that point to a waypoint, so the first link
  // carries one planned point fewer than the rest.
  it('shrinks the first batch when it starts from the rider', () => {
    const pts = Array.from({ length: 11 }, (_, i) => stop(i))
    expect(routeLinks(routeOf(pts)).links).toHaveLength(1)
    const fromHere = routeLinks(routeOf(pts), { fromCurrentLocation: true }).links
    expect(fromHere).toHaveLength(2)
    expect(waypointsOf(fromHere[0].url)).toHaveLength(9)
    expect(fromHere[0].points).toHaveLength(10)
  })

  it('overlaps by one point, so no leg goes unnavigated', () => {
    const links = long(25).links
    for (let i = 1; i < links.length; i++) {
      const prevEnd = links[i - 1].points[links[i - 1].points.length - 1]
      expect(links[i].points[0]).toEqual(prevEnd)
    }
  })

  it('covers every stop across the series', () => {
    const links = long(25).links
    const seen = links.flatMap((l) => l.points.map((p) => p.name))
    // Deduplicated, because the shared joints appear twice by design.
    expect([...new Set(seen)]).toHaveLength(25)
  })

  it('numbers the parts', () => {
    const links = long(25).links
    expect(links.map((l) => l.part)).toEqual(links.map((_, i) => i + 1))
    expect(new Set(links.map((l) => l.parts))).toEqual(new Set([links.length]))
  })

  it('does not emit a trailing link for a single leftover point', () => {
    // 11 points is exactly one link; 12 is two, and the second must be a real
    // leg rather than a lone destination.
    expect(long(11).links).toHaveLength(1)
    const two = long(12).links
    expect(two).toHaveLength(2)
    expect(two[1].points.length).toBeGreaterThan(1)
  })
})

describe('what is left out', () => {
  it('routes through stops but not POIs', () => {
    const r = routeLinks(routeOf([stop(1), stop(2, 'poi'), stop(3)]))
    expect(r.skippedPois).toBe(1)
    // A POI is somewhere worth knowing, not somewhere the road has to go.
    expect(waypointsOf(r.links[0].url)).toEqual([])
    expect(params(r.links[0].url).get('destination')).toBe('37.03,-121.97')
  })

  it('never batches across a day boundary', () => {
    // Two days are two calls; nothing in this module can join them.
    const d1 = routeLinks(routeOf([stop(1), stop(2)], 'Day 1'))
    const d2 = routeLinks(routeOf([stop(8), stop(9)], 'Day 2'))
    expect(d1.links[0].url).not.toContain('37.08')
    expect(d2.links[0].url).not.toContain('37.01')
  })
})

describe('labels', () => {
  it('names the day when one link covers it', () => {
    const r = routeLinks(routeOf([stop(1), stop(2)], 'Coast run'))
    expect(linkLabel(r, r.links[0], 0)).toBe('Coast run')
  })

  it('numbers the parts when it does not', () => {
    const r = routeLinks(routeOf(Array.from({ length: 25 }, (_, i) => stop(i)), 'Coast run'))
    expect(linkLabel(r, r.links[1], 0)).toBe(`Coast run · part 2 of ${r.links.length}`)
  })

  it('falls back to the day number when the route has no title', () => {
    const r = routeLinks(routeOf([stop(1), stop(2)], null))
    expect(linkLabel(r, r.links[0], 2)).toBe('Day 3')
  })
})

// Shaping points are what Expand contributes: extra waypoints woven between the
// stops so Maps has less room to pick its own roads. They are paid for in
// links, because Maps takes nine waypoints whatever they are.
describe('holding the route with shaping points', () => {
  // A long dogleg with two stops at the ends, so there is real geometry for
  // Expand to sample and an obvious corner to pin.
  const M_LAT = 1 / 111_320
  const M_LNG = 1 / (111_320 * Math.cos(37 * (Math.PI / 180)))
  const track: [number, number][] = []
  for (let d = 0; d <= 20_000; d += 100) track.push([-122 + d * M_LNG, 37])
  for (let d = 100; d <= 20_000; d += 100) track.push([-122 + 20_000 * M_LNG, 37 + d * M_LAT])

  const ends: ExportPoint[] = [
    { ...stop(0), lat: 37, lng: -122 },
    { ...stop(99), lat: 37 + 20_000 * M_LAT, lng: -122 + 20_000 * M_LNG },
  ]
  const route = { ...routeOf(ends), track }

  it('hands over the stops alone by default', () => {
    const r = routeLinks(route)
    expect(r.links).toHaveLength(1)
    expect(r.links[0].shaping).toBe(0)
    // Two stops 40 km apart means 40 km of road with nothing holding it, and
    // saying so is the whole value of the number. Riders can then decide
    // whether that matters on this particular route.
    expect(r.longestGapM).toBeGreaterThan(39_000)
  })

  it('counts stops as pinning the route, not just shaping points', () => {
    // A day with a stop every few miles needs no shaping at all, and reporting
    // it as wide open would be a confident wrong number.
    const M = 1 / 111_320
    const dense: ExportPoint[] = Array.from({ length: 12 }, (_, i) => ({
      ...stop(i),
      lat: 37 + i * 1000 * M,
      lng: -122,
    }))
    const line: [number, number][] = []
    for (let d = 0; d <= 11_000; d += 100) line.push([-122, 37 + d * M])
    const r = routeLinks({ ...routeOf(dense), track: line })
    expect(r.links[0].shaping).toBe(0)
    expect(r.longestGapM).toBeLessThan(1500)
  })

  it('weaves shaping points between the stops when asked', () => {
    const r = routeLinks(route, { shapingPoints: 6 })
    expect(r.links[0].shaping).toBe(6)
    // The rider's own stops are still the ones listed.
    expect(r.links[0].points.map((p) => p.name)).toEqual(['Stop 0', 'Stop 99'])
    expect(waypointsOf(r.links[0].url)).toHaveLength(6)
  })

  it('reports how much road is still unpinned', () => {
    const loose = routeLinks(route, { shapingPoints: 3 })
    const tight = routeLinks(route, { shapingPoints: 24 })
    expect(loose.longestGapM).toBeGreaterThan(tight.longestGapM!)
  })

  it('buys fidelity with links, not with points per link', () => {
    // Every ten shaping points is roughly one more link and one more tap.
    const few = routeLinks(route, { shapingPoints: 6 })
    const many = routeLinks(route, { shapingPoints: 40 })
    expect(many.links.length).toBeGreaterThan(few.links.length)
    for (const l of many.links) expect(waypointsOf(l.url).length).toBeLessThanOrEqual(9)
  })

  it('keeps the rider\'s own stops as the ends of the day', () => {
    // A shaping point outside the first or last stop would send someone past
    // their own start or finish.
    const r = routeLinks(route, { shapingPoints: 20 })
    const first = params(r.links[0].url).get('origin')
    const last = params(r.links[r.links.length - 1].url).get('destination')
    expect(first).toBe('37,-122')
    expect(last).toBe(`${ends[1].lat},${ends[1].lng}`)
  })

  it('prefers to break at a stop, so a tap lands where the rider already is', () => {
    // Twenty stops and enough shaping to force several links: every boundary
    // that can be a stop should be one.
    const many: ExportPoint[] = Array.from({ length: 20 }, (_, i) => ({
      ...stop(i),
      lat: 37 + i * 1000 * M_LAT,
      lng: -122,
    }))
    const straightTrack: [number, number][] = []
    for (let d = 0; d <= 19_000; d += 100) straightTrack.push([-122, 37 + d * M_LAT])
    const r = routeLinks({ ...routeOf(many), track: straightTrack }, { shapingPoints: 30 })
    expect(r.links.length).toBeGreaterThan(2)
    // Every join between consecutive links is a stop, not a shaping point.
    for (let i = 1; i < r.links.length; i++) {
      const joinLat = params(r.links[i].url).get('origin')
      expect(many.some((m) => `${m.lat},${m.lng}` === joinLat)).toBe(true)
    }
  })
})
