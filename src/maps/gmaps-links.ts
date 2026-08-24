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
import { expandTrack } from './expand'
import { distFromStartAlongTrack, type Track } from './kml'
import type { ExportPoint, ExportDay } from './export'

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
  // The rider's own points in this link, so a caller can list them. Shaping
  // points are deliberately not here — they are not places anyone is going,
  // and listing "unnamed point" thirty times helps nobody.
  points: ExportPoint[]
  // How many shaping points this link carries alongside those points.
  shaping: number
}

export type GmapsRouteLinks = {
  title: string | null
  links: GmapsLink[]
  // The longest stretch of road with nothing pinning it, in meters, once
  // shaping points are in. This is the honest measure of how much freedom the
  // nav app still has, and a caller should show it rather than implying the
  // route is nailed down. Null when there is no geometry to measure.
  longestGapM: number | null
}

export type LinkOptions = {
  // Leave the first link's origin off so Maps starts from wherever the rider
  // is. Only ever right for the leg being ridden now — a shared plan someone
  // reads at home wants the real start.
  fromCurrentLocation?: boolean
  // `two-wheeler` exists but is only honored in some countries and silently
  // degrades elsewhere, so driving is the default until there is a reason.
  travelMode?: 'driving' | 'two-wheeler' | 'bicycling' | 'walking'
  // How many shaping points to weave in between the stops to hold the route on
  // the roads it was planned on. Zero — the default — hands over the stops
  // alone and lets Maps route between them however it likes.
  //
  // This is paid for in links, not in points per link: Maps takes nine
  // waypoints whatever they are, so every ten shaping points is another link
  // and another tap. That trade is the rider's to make, which is why it is an
  // option rather than a constant.
  shapingPoints?: number
}

// A point on the way, which is either somewhere the rider chose to stop or a
// shaping point holding the line between two of those.
type LinkPoint = { lat: number; lng: number; stop: ExportPoint | null }

function buildUrl(batch: LinkPoint[], opts: LinkOptions, isFirst: boolean): string {
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

// Stops and shaping points woven into one ordered list. Both are projected onto
// the day's geometry and sorted by how far along it they fall, because that is
// the only ordering that means anything once the two sets are mixed — a shaping
// point has no position in the stop sequence and a stop has no index in the
// track.
function weave(anchors: ExportPoint[], track: Track, shaping: Track): { seq: LinkPoint[]; longestGapM: number | null } {
  if (track.length < 2) return { seq: anchors.map((p) => ({ ...p, stop: p })), longestGapM: null }

  const stopAt = distFromStartAlongTrack(track, anchors)
  const shapeAt = distFromStartAlongTrack(
    track,
    shaping.map(([lng, lat]) => ({ lat, lng })),
  )

  const merged: Array<{ d: number; p: LinkPoint }> = [
    ...anchors.map((p, i) => ({ d: stopAt[i], p: { lat: p.lat, lng: p.lng, stop: p } })),
    ...shaping.map(([lng, lat], i) => ({ d: shapeAt[i], p: { lat, lng, stop: null } })),
  ]
  // Stops win ties: a shaping point landing on top of one is redundant, and the
  // stop is the thing the rider actually asked for.
  merged.sort((a, b) => a.d - b.d || (a.p.stop ? -1 : 1) - (b.p.stop ? -1 : 1))

  // Keep the day's real ends as the ends. A shaping point outside the first or
  // last stop would send the rider past their own start or finish.
  const first = merged.findIndex((m) => m.p.stop)
  const last = merged.length - 1 - [...merged].reverse().findIndex((m) => m.p.stop)
  const span = merged.slice(first, last + 1)

  // The gap is measured over what the links actually cover — first stop to last
  // — and counts stops as pinning the route, because they do. Measuring the
  // whole track instead would report unpinned miles nobody is being sent down,
  // and ignoring stops would claim a day with a fuel stop every five miles is
  // wide open. Both would be the kind of confident wrong number this feature
  // exists to stop shipping.
  let longestGapM = 0
  for (let i = 1; i < span.length; i++) longestGapM = Math.max(longestGapM, span[i].d - span[i - 1].d)

  return { seq: span.map((m) => m.p), longestGapM }
}

// One day's points as an ordered series of links. Never batches across a
// day boundary: day 2 starting where day 1 ended is a rest, not a leg.
export function routeLinks(day: ExportDay, opts: LinkOptions = {}): GmapsRouteLinks {
  // BOTH KINDS ARE HANDED OVER, as of 2026-08-24. POIs used to be excluded here,
  // on the grounds that routing through one would bend the road to reach it —
  // which was right while a POI sat beside the route. It IS the route now, so
  // excluding them would send the rider down a different road than the one the
  // builder drew and the roadbook printed, with nothing saying so.
  //
  // The cost is waypoints, and the batching below already absorbs it: a day with
  // many POIs comes out as more links rather than a wrong one.
  const anchors = day.points

  // A single point is a destination, not a route: one link, no waypoints.
  if (anchors.length < 2) {
    if (anchors.length === 0) return { title: day.title, links: [], longestGapM: null }
    const params = new URLSearchParams({ api: '1', destination: coord(anchors[0]) })
    params.set('travelmode', opts.travelMode ?? 'driving')
    return {
      title: day.title,
      links: [
        {
          url: `https://www.google.com/maps/dir/?${params.toString()}`,
          part: 1,
          parts: 1,
          points: anchors,
          shaping: 0,
        },
      ],
      longestGapM: null,
    }
  }

  const budget = Math.max(0, Math.floor(opts.shapingPoints ?? 0))
  const expansion = budget > 0 && day.track.length > 2 ? expandTrack(day.track, { maxPoints: budget }) : null
  const { seq, longestGapM } = weave(anchors, day.track, expansion?.points ?? [])

  // A link that omits its origin holds one planned point fewer. The rider's
  // current location fills the origin slot, so the point that would have been
  // the origin becomes a waypoint and counts against the nine — an 11-point
  // batch would ask for ten of them and Maps would drop one silently.
  //
  // Boundaries prefer to land on a stop. Every boundary costs the rider a tap,
  // and a tap is free if they are already off the bike at a fuel pump — so a
  // batch will end early at the last stop it contains rather than at an
  // arbitrary point in the middle of a canyon, provided that does not waste
  // most of the link.
  const MIN_FILL = 0.6
  const batches: LinkPoint[][] = []
  for (let i = 0, first = true; i < seq.length - 1; first = false) {
    const cap = first && opts.fromCurrentLocation ? MAX_POINTS_PER_LINK - 1 : MAX_POINTS_PER_LINK
    let end = Math.min(i + cap, seq.length) // exclusive
    if (end < seq.length) {
      for (let j = end - 1; j > i + Math.ceil(cap * MIN_FILL); j--) {
        if (seq[j].stop) {
          end = j + 1
          break
        }
      }
    }
    batches.push(seq.slice(i, end))
    i = end - 1
  }

  return {
    title: day.title,
    links: batches.map((batch, i) => ({
      url: buildUrl(batch, opts, i === 0),
      part: i + 1,
      parts: batches.length,
      points: batch.filter((p) => p.stop).map((p) => p.stop as ExportPoint),
      shaping: batch.filter((p) => !p.stop).length,
    })),
    longestGapM,
  }
}

// "Day 2 · part 1 of 3", or just the day when it fits in one link.
export function linkLabel(links: GmapsRouteLinks, link: GmapsLink, dayIndex: number): string {
  const day = links.title?.trim() || `Day ${dayIndex + 1}`
  return link.parts > 1 ? `${day} · part ${link.part} of ${link.parts}` : day
}
