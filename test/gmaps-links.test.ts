// Google Maps hand-off links.
//
// The numbers here are not arbitrary: 9 waypoints and the current-location
// behaviour were confirmed on an iPhone against a real 11-point route, and the
// batching exists because Maps silently drops what it cannot carry.
import { describe, expect, it } from 'vitest'
import { MAX_POINTS_PER_LINK, linkLabel, routeLinks } from '../src/maps/gmaps-links'
import type { ExportPoint, ExportRoute } from '../src/maps/export'

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

const routeOf = (points: ExportPoint[], title: string | null = 'Day 1'): ExportRoute => ({
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
