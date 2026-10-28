// What an AI agent may do to a ride, as arithmetic on the builder's own payload.
//
// PURE: no database, no network. Every operation mutates a draft `RidePayload` the
// caller owns and returns the legs it left as straight placeholders, which
// `legs.ts` then routes. Keeping the routing out of here is what lets every rule
// below be tested without spending a Routes request.
//
// The rules are the builder's, ported rather than reinvented, because a ride the
// agent edits is saved through the same schema the builder's save uses and has to
// satisfy it:
//
//   - `legs[i]` joins `points[i]` to `points[i+1]`, so a route always carries
//     exactly points - 1 legs.
//   - A route keeps at least one stop (`ensureRouteHasStop` in builder.js).
//   - A new point is a POI unless it is given a category; a category is a reason
//     to stop, so a point with roles is a stop.
//   - Deleting a point carries its neighbors' shaping points onto the leg that
//     replaces them (`rejoinRouteLegs`); moving one clears them, because a move
//     changes an END of the pair and the hint no longer describes anything.
import type { PointInput, RidePayload, RoutePayload } from '../maps/ride-graph'
import { haversineM, type Track } from '../maps/kml'
import type { Role } from '../maps/roles'
import { ROUTE_COLORS } from '../maps/palette'
import { newUid } from '../maps/uid'

export type Leg = RoutePayload['legs'][number]
export type Stale = { route: number; leg: number }
export type Place = { name: string; address?: string | null; lng: number; lat: number }

// The builder's own cap, restated because the client copy is the one it enforces.
export const MAX_VIAS_PER_LEG = 20

/** A refusal the agent is shown verbatim, so it can say what went wrong. */
export class EditError extends Error {}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6

function trackLength(g: Track): number {
  let m = 0
  for (let i = 1; i < g.length; i++) m += haversineM(g[i - 1][1], g[i - 1][0], g[i][1], g[i][0])
  return m
}

/** builder.js `straightLeg()`: a placeholder until the real road comes back.
 *  durationS stays 0 because a fabricated number would persist as though the
 *  router had returned it. */
export function straightLeg(a: PointInput, b: PointInput, vias: Track = []): Leg {
  const geometry: Track = [[a.lng, a.lat], ...vias, [b.lng, b.lat]]
  return { geometry, distanceM: Math.round(trackLength(geometry)), durationS: 0, viaPoints: vias }
}

export function newPoint(place: Place, roles: Role[] = []): PointInput {
  return {
    kind: roles.length > 0 ? 'stop' : 'poi',
    lat: r6(place.lat),
    lng: r6(place.lng),
    name: (place.name || '').slice(0, 255),
    address: place.address ? place.address.slice(0, 300) : null,
    description: '',
    roles,
    durationMin: null,
    slackMin: null,
    uid: newUid(),
    details: null,
  }
}

export function routeIndex(ride: RidePayload, routeUid: string): number {
  const i = ride.routes.findIndex((r) => r.uid === routeUid)
  if (i < 0) throw new EditError(`no route with uid ${routeUid}`)
  return i
}

export function pointIndex(route: RoutePayload, pointUid: string): number {
  const i = route.points.findIndex((p) => p.uid === pointUid)
  if (i < 0) throw new EditError(`no point with uid ${pointUid} on route "${route.title || route.uid}"`)
  return i
}

function ensureRouteHasStop(route: RoutePayload): void {
  if (route.points.length > 0 && !route.points.some((p) => p.kind === 'stop')) route.points[0].kind = 'stop'
}

// A pair is the same pair only if both ends are the same point IN THE SAME PLACE:
// a point keeps its uid when it is replaced with somewhere else, and the road to
// the old place is not the road to the new one.
const endKey = (p: PointInput) => `${p.uid}@${p.lng},${p.lat}`
const pairKey = (a: PointInput, b: PointInput) => `${endKey(a)}>${endKey(b)}`

/**
 * Rebuild a route's legs after its points changed, keeping every leg whose pair of
 * ends survived unchanged and placing a straight placeholder everywhere else.
 * `carry` supplies shaping points for a new pair, which is how a deletion keeps
 * the rider's shaping work; anything not in it starts with none.
 */
function releg(
  routeIdx: number,
  route: RoutePayload,
  beforePoints: PointInput[],
  beforeLegs: Leg[],
  carry: Map<string, Track> = new Map(),
): Stale[] {
  const kept = new Map<string, Leg>()
  for (let i = 0; i < beforeLegs.length; i++) {
    const a = beforePoints[i]
    const b = beforePoints[i + 1]
    if (a && b) kept.set(pairKey(a, b), beforeLegs[i])
  }
  const stale: Stale[] = []
  route.legs = []
  for (let i = 0; i < route.points.length - 1; i++) {
    const a = route.points[i]
    const b = route.points[i + 1]
    const key = pairKey(a, b)
    const leg = kept.get(key)
    if (leg) {
      route.legs.push(leg)
      continue
    }
    route.legs.push(straightLeg(a, b, carry.get(key) ?? []))
    stale.push({ route: routeIdx, leg: i })
  }
  return stale
}

/**
 * Put a place on a route. `at` is the index it should occupy, clamped to the
 * route's length, so omitting it appends. Roles make it a stop.
 */
export function addPoint(
  ride: RidePayload,
  routeUid: string,
  place: Place,
  opts: { at?: number | null; roles?: Role[]; durationMin?: number | null } = {},
): { point: PointInput; stale: Stale[] } {
  const r = routeIndex(ride, routeUid)
  const route = ride.routes[r]
  const before = route.points.slice()
  const legs = route.legs.slice()
  const point = newPoint(place, opts.roles ?? [])
  if (opts.durationMin != null) point.durationMin = Math.max(0, Math.min(43200, Math.round(opts.durationMin)))
  const at = Math.max(0, Math.min(route.points.length, opts.at ?? route.points.length))
  route.points.splice(at, 0, point)
  return { point, stale: releg(r, route, before, legs) }
}

/** Swap what a point IS for another place, keeping its uid, dwell, notes and
 *  details, the way the builder's row-name replace does (#357). */
export function replacePoint(ride: RidePayload, routeUid: string, pointUid: string, place: Place): Stale[] {
  const r = routeIndex(ride, routeUid)
  const route = ride.routes[r]
  const i = pointIndex(route, pointUid)
  const before = route.points.slice()
  const legs = route.legs.slice()
  const p = { ...route.points[i] }
  p.name = (place.name || '').slice(0, 255)
  p.address = place.address ? place.address.slice(0, 300) : null
  p.lat = r6(place.lat)
  p.lng = r6(place.lng)
  route.points[i] = p
  return releg(r, route, before, legs)
}

/** Take a point off a route, carrying the shaping points of the two legs it
 *  joined onto the one that replaces them. A route cannot be emptied here. */
export function removePoint(
  ride: RidePayload,
  routeUid: string,
  pointUid: string,
): { stale: Stale[]; trimmed: boolean } {
  const r = routeIndex(ride, routeUid)
  const route = ride.routes[r]
  const i = pointIndex(route, pointUid)
  if (route.points.length === 1)
    throw new EditError('that is the only point on the route; a route cannot be left empty')
  const before = route.points.slice()
  const legs = route.legs.slice()
  route.points.splice(i, 1)
  ensureRouteHasStop(route)

  // Only a MIDDLE point merges two pairs into one. Removing an end leaves
  // nothing joining that road, so there is nothing to carry.
  const carry = new Map<string, Track>()
  let trimmed = false
  if (i > 0 && i < before.length - 1) {
    const vias: Track = [...(legs[i - 1]?.viaPoints ?? []), ...(legs[i]?.viaPoints ?? [])]
    if (vias.length > MAX_VIAS_PER_LEG) {
      vias.length = MAX_VIAS_PER_LEG
      trimmed = true
    }
    carry.set(pairKey(before[i - 1], before[i + 1]), vias)
  }
  return { stale: releg(r, route, before, legs, carry), trimmed }
}

/** Reorder a point within its route. Shaping points around both the old and the
 *  new position are cleared, as a drag in the builder clears them. */
export function movePoint(ride: RidePayload, routeUid: string, pointUid: string, to: number): Stale[] {
  const r = routeIndex(ride, routeUid)
  const route = ride.routes[r]
  const from = pointIndex(route, pointUid)
  const before = route.points.slice()
  const legs = route.legs.slice()
  const [p] = route.points.splice(from, 1)
  route.points.splice(Math.max(0, Math.min(route.points.length, to)), 0, p)
  return releg(r, route, before, legs)
}

/** Give a point categories. Any role makes it a stop; clearing them all makes it
 *  a POI, unless it is the route's only stop, which is refused. */
export function setRoles(ride: RidePayload, routeUid: string, pointUid: string, roles: Role[]): void {
  const route = ride.routes[routeIndex(ride, routeUid)]
  const p = route.points[pointIndex(route, pointUid)]
  if (roles.length === 0 && p.kind === 'stop' && route.points.filter((q) => q.kind === 'stop').length === 1) {
    throw new EditError('that is the route’s only stop, so it has to keep being one')
  }
  p.roles = roles
  p.kind = roles.length > 0 ? 'stop' : 'poi'
}

export function setDwell(ride: RidePayload, routeUid: string, pointUid: string, minutes: number | null): void {
  const route = ride.routes[routeIndex(ride, routeUid)]
  const p = route.points[pointIndex(route, pointUid)]
  p.durationMin = minutes == null ? null : Math.max(0, Math.min(43200, Math.round(minutes)))
}

/**
 * A route's departure, as a WALL CLOCK AT THE DEPARTURE POINT carried as UTC —
 * see route-clock.js. "2026-11-02T09:00" means nine where the bike is, so it is
 * stored as 09:00Z and nothing converts it into anybody's zone.
 *
 * `endAt` is cleared rather than guessed: the builder re-derives it from the start
 * on the next refresh, and a value worked out here would be overwritten by one
 * worked out from the real schedule.
 */
export function setDeparture(ride: RidePayload, routeUid: string, local: string | null): void {
  const route = ride.routes[routeIndex(ride, routeUid)]
  if (local == null || local === '') {
    route.startAt = null
    route.endAt = null
    return
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local)
  if (!m) throw new EditError('departure must be a local wall clock like 2026-11-02T09:00')
  route.startAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`
  route.endAt = null
}

export function renameRoute(ride: RidePayload, routeUid: string, title: string): void {
  ride.routes[routeIndex(ride, routeUid)].title = title.slice(0, 150)
}

/** A new route, appended, starting at one place. Its first point is a stop tagged
 *  `start`, which is the rule the builder applies to the first point of a route. */
export function addRoute(ride: RidePayload, title: string, start: Place): RoutePayload {
  if (ride.routes.length >= 31) throw new EditError('a ride holds at most 31 routes')
  const used = new Set(ride.routes.map((r) => r.color.toLowerCase()))
  const color =
    ROUTE_COLORS.find((c) => !used.has(c.toLowerCase())) ?? ROUTE_COLORS[ride.routes.length % ROUTE_COLORS.length]
  const route: RoutePayload = {
    subgroupUid: null,
    uid: newUid(),
    title: title.slice(0, 150),
    color,
    startAt: null,
    endAt: null,
    points: [newPoint(start, ['start'])],
    legs: [],
    altGroup: null,
    altActive: true,
    routePrefs: null,
  }
  ride.routes.push(route)
  return route
}
