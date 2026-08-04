// Google Maps hand-off links.
//
// Google Maps takes a limited number of points per directions URL, so a day is
// serialized into an ordered series of links rather than one. This is the
// answer to the waypoint cap that makes riders give up and screenshot a map.
//
// Everything here was settled by testing on a real iPhone rather than from the
// documentation, because the documentation is wrong about the part that
// matters. Findings, 2026-08-03:
//
//   - A `/maps/dir/?api=1` link opens the native app and carries 9 waypoints.
//     Google's URL docs say "up to three waypoints supported on mobile
//     browsers, and a maximum of nine waypoints supported otherwise" — the
//     three-waypoint figure applies to a route rendered in the mobile browser,
//     not to the app the link hands off to. Nine survive on the phone.
//   - Omitting `origin` makes Maps use the rider's current location, and the
//     app offers Start rather than Preview. That removes the "add Your
//     Location and drag it to the top" ritual riders otherwise perform at every
//     fuel stop.
//   - Raw coordinates render as "dropped pin". Named places require Google
//     place IDs, which this app does not store yet; the route is exact and
//     navigable either way, so names are an upgrade rather than a blocker.
//
// Two URL shapes that look usable are not, and neither can be generated:
// `maps.app.goo.gl` short links are minted server-side by Google, and the
// `/maps/place/…/data=!3m1!…` URL in the browser bar is an internal encoded
// blob that resolves to a single place on mobile.
import type { ExportPoint, ExportRoute } from './export'

// Origin + 9 waypoints + destination. The 9 is Google's documented ceiling and
// the tested one; the two ends are not waypoints and do not count against it.
export const MAX_WAYPOINTS_PER_LINK = 9
export const MAX_POINTS_PER_LINK = MAX_WAYPOINTS_PER_LINK + 2

// Consecutive links share a point: a link ending at the fuel stop is followed
// by one starting there. A clean partition would leave the leg between the two
// batches unnavigated — the rider arrives at point 11 and the next link starts
// at point 12, and nothing ever routes the bit in between. That is why each
// batch advances by its length minus one rather than by its length.

const coord = (p: { lat: number; lng: number }) => `${p.lat},${p.lng}`

export type GmapsLink = {
  url: string
  // 1-based, for "part 2 of 5".
  part: number
  parts: number
  // The points this link actually covers, so a caller can list them without
  // re-deriving the batching.
  points: ExportPoint[]
}

export type GmapsRouteLinks = {
  title: string | null
  links: GmapsLink[]
  // Points that were skipped because they are not routing anchors.
  skippedPois: number
}

export type LinkOptions = {
  // Leave the first link's origin off so Maps starts from wherever the rider
  // is. Only ever right for the leg being ridden now — a shared plan someone
  // reads at home wants the real start.
  fromCurrentLocation?: boolean
  // `two-wheeler` exists but is only honoured in some countries and silently
  // degrades elsewhere, so driving is the default until there is a reason.
  travelMode?: 'driving' | 'two-wheeler' | 'bicycling' | 'walking'
}

function buildUrl(batch: ExportPoint[], opts: LinkOptions, isFirst: boolean): string {
  const params = new URLSearchParams({ api: '1' })
  const dropOrigin = Boolean(opts.fromCurrentLocation) && isFirst

  const origin = batch[0]
  const destination = batch[batch.length - 1]
  const middle = batch.slice(1, -1)

  // With the origin dropped, the point that would have been the origin becomes
  // a waypoint rather than vanishing — the rider still has to ride through it.
  if (!dropOrigin) params.set('origin', coord(origin))
  const waypoints = dropOrigin ? [origin, ...middle] : middle

  params.set('destination', coord(destination))
  if (waypoints.length > 0) params.set('waypoints', waypoints.map(coord).join('|'))
  params.set('travelmode', opts.travelMode ?? 'driving')

  // URLSearchParams percent-encodes the pipe separator, which Maps accepts.
  return `https://www.google.com/maps/dir/?${params.toString()}`
}

// One route's points as an ordered series of links. Never batches across a
// route boundary: day 2 starting where day 1 ended is a rest, not a leg.
export function routeLinks(route: ExportRoute, opts: LinkOptions = {}): GmapsRouteLinks {
  // POIs are excluded on purpose. A POI is somewhere worth knowing about, not a
  // place the route has to pass through, and handing one to Maps as a waypoint
  // bends the road to reach it. Stops are the routing anchors, which is exactly
  // the distinction the schema draws.
  const anchors = route.points.filter((p) => p.kind !== 'poi')
  const skippedPois = route.points.length - anchors.length

  // A single point is a destination, not a route: one link, no waypoints.
  if (anchors.length < 2) {
    if (anchors.length === 0) return { title: route.title, links: [], skippedPois }
    const params = new URLSearchParams({ api: '1', destination: coord(anchors[0]) })
    params.set('travelmode', opts.travelMode ?? 'driving')
    return {
      title: route.title,
      links: [{ url: `https://www.google.com/maps/dir/?${params.toString()}`, part: 1, parts: 1, points: anchors }],
      skippedPois,
    }
  }

  // A link that omits its origin holds one planned point fewer. The rider's
  // current location fills the origin slot, so the point that would have been
  // the origin becomes a waypoint and counts against the nine — an 11-point
  // batch would ask for ten of them and Maps would drop one silently.
  const batches: ExportPoint[][] = []
  for (let i = 0, first = true; i < anchors.length - 1; first = false) {
    const cap = first && opts.fromCurrentLocation ? MAX_POINTS_PER_LINK - 1 : MAX_POINTS_PER_LINK
    batches.push(anchors.slice(i, i + cap))
    i += cap - 1
  }

  return {
    title: route.title,
    links: batches.map((points, i) => ({
      url: buildUrl(points, opts, i === 0),
      part: i + 1,
      parts: batches.length,
      points,
    })),
    skippedPois,
  }
}

// "Day 2 · part 1 of 3", or just the day when it fits in one link.
export function linkLabel(route: GmapsRouteLinks, link: GmapsLink, dayIndex: number): string {
  const day = route.title?.trim() || `Day ${dayIndex + 1}`
  return link.parts > 1 ? `${day} · part ${link.part} of ${link.parts}` : day
}
