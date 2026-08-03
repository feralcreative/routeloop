// The two generated XML formats.
//
// Both have a failure mode that produces a perfectly valid file which is wrong
// in a way nobody notices until they are on the road: KML's colour bytes are
// reversed, and a GPX written as a route instead of a track makes the device
// re-derive the ride. Neither throws. Both get a test.
import { describe, expect, it } from 'vitest'
import { buildGpx, buildKml, type ExportRide } from '../src/maps/export'
import { processGpx, processKml } from '../src/maps/kml'

const ride: ExportRide = {
  title: 'Coast & Ridge <run>',
  description: 'An "interesting" one.',
  routes: [
    {
      title: 'Day 1',
      color: '#cc0000',
      distanceM: 1000,
      twistinessDpm: 214,
      twistinessBestDpm: 340,
      track: [
        [-122.0308, 36.9741],
        [-122.1922, 37.0113],
        [-122.2867, 37.105],
      ],
      points: [
        {
          lat: 36.9741,
          lng: -122.0308,
          name: 'Ziad\'s & Co "Chevron"',
          description: 'Top off "here".',
          roles: ['gas', 'food'],
          kind: 'stop',
          durationMin: 15,
          distFromStartM: 0,
        },
      ],
    },
  ],
}

describe('buildKml', () => {
  const out = buildKml(ride)

  // aabbggrr, not #rrggbb. #cc0000 is pure red, so the red byte must land last.
  // Reversed, this ships every route in the wrong colour and nothing errors.
  it('writes the colour as aabbggrr', () => {
    expect(out).toContain('<color>ff0000cc</color>')
  })

  it('falls back to a valid colour rather than emitting a broken one', () => {
    const broken = buildKml({ ...ride, routes: [{ ...ride.routes[0], color: 'rebeccapurple' }] })
    expect(broken).toMatch(/<color>[0-9a-f]{8}<\/color>/)
  })

  it('escapes markup and quotes in names and descriptions', () => {
    // The ride title is not sanitized text — it comes from the upload form and
    // is stored as typed — so angle brackets in it are real and must be escaped
    // or the file is not well-formed XML.
    expect(out).toContain('<name>Coast &amp; Ridge &lt;run&gt;</name>')
    expect(out).toContain('GAS/FOOD - Ziad&apos;s &amp; Co &quot;Chevron&quot;')
    expect(out).toContain('Top off &quot;here&quot;.')
  })

  it('never writes a DOCTYPE, which its own importer would refuse', () => {
    expect(out).not.toMatch(/<!DOCTYPE/i)
  })

  it('writes coordinates as lng,lat', () => {
    expect(out).toContain('<coordinates>-122.0308,36.9741 -122.1922,37.0113 -122.2867,37.105</coordinates>')
  })

  it('is read back by this app’s own parser', () => {
    const back = processKml(out)
    expect(back.points[0]).toMatchObject({ name: 'Ziad\'s & Co "Chevron"', roles: ['gas', 'food'] })
    expect(back.track).toHaveLength(3)
  })
})

describe('buildGpx', () => {
  const out = buildGpx(ride)

  // The decision the format hinges on. A <rte> is a list of places to navigate
  // between, so the device picks its own way from each to the next — the exact
  // failure the FAQ describes under "Why does my GPS ignore the route I
  // planned?". Writing shaping points as route points hands that room back.
  it('writes shaping points as trkpt, never as rtept', () => {
    expect(out).toContain('<trkpt lat="36.9741" lon="-122.0308"/>')
    expect(out).not.toContain('<rtept')
    expect(out).not.toContain('<rte>')
  })

  it('writes stops as wpt, so they are places rather than route anchors', () => {
    expect(out).toContain('<wpt lat="36.9741" lon="-122.0308">')
    expect(out.match(/<wpt /g) ?? []).toHaveLength(1)
    expect(out.match(/<trkpt /g) ?? []).toHaveLength(3)
  })

  // The schema orders wpt, then rte, then trk. A file in the wrong order is
  // rejected by stricter consumers even though it looks fine.
  it('puts every waypoint before the track', () => {
    expect(out.lastIndexOf('<wpt ')).toBeLessThan(out.indexOf('<trk>'))
  })

  it('escapes markup and quotes', () => {
    expect(out).toContain('GAS/FOOD - Ziad&apos;s &amp; Co &quot;Chevron&quot;')
    expect(out).toContain('<desc>Top off &quot;here&quot;.</desc>')
  })

  it('never writes a DOCTYPE', () => {
    expect(out).not.toMatch(/<!DOCTYPE/i)
  })

  it('is read back by this app’s own parser', () => {
    const back = processGpx(out)
    expect(back.points[0]).toMatchObject({ name: 'Ziad\'s & Co "Chevron"', roles: ['gas', 'food'] })
    expect(back.track).toEqual([
      [-122.0308, 36.9741],
      [-122.1922, 37.0113],
      [-122.2867, 37.105],
    ])
  })

  it('writes a track per day, so the days stay separable in the file', () => {
    const twoDays = buildGpx({ ...ride, routes: [ride.routes[0], { ...ride.routes[0], title: 'Day 2' }] })
    expect(twoDays.match(/<trk>/g) ?? []).toHaveLength(2)
  })
})

describe('a ride with no geometry', () => {
  const stopsOnly: ExportRide = { ...ride, routes: [{ ...ride.routes[0], track: [] }] }

  it('writes no LineString rather than an empty one', () => {
    expect(buildKml(stopsOnly)).not.toContain('<LineString>')
  })

  it('writes no trk rather than an empty one', () => {
    expect(buildGpx(stopsOnly)).not.toContain('<trk>')
  })

  it('still writes the stops, and both still parse', () => {
    expect(processKml(buildKml(stopsOnly)).points).toHaveLength(1)
    expect(processGpx(buildGpx(stopsOnly)).points).toHaveLength(1)
  })
})

// Not a round-trip failure but a deliberate asymmetry, asserted so it stays one.
describe('angle brackets in a name', () => {
  const nasty: ExportRide = {
    ...ride,
    routes: [{ ...ride.routes[0], points: [{ ...ride.routes[0].points[0], name: 'A <b> C', roles: [] }] }],
  }

  it('is escaped on the way out, so the file stays well-formed', () => {
    expect(buildKml(nasty)).toContain('<name>A &lt;b&gt; C</name>')
    expect(buildGpx(nasty)).toContain('<name>A &lt;b&gt; C</name>')
  })

  // sanitizeText strips anything tag-shaped and cannot tell a rider's angle
  // brackets from an attacker's, so the name comes back shortened. This costs
  // nothing in practice: both write paths sanitize before storing, so a name
  // holding angle brackets never reaches the database to be exported.
  it('is stripped on the way back in, which is the sanitizer working', () => {
    expect(processKml(buildKml(nasty)).points[0].name).toBe('A  C')
    expect(processGpx(buildGpx(nasty)).points[0].name).toBe('A  C')
  })
})
