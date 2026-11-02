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
//   - Inserting a point mid-leg splits that leg's shaping points by where each lies
//     along its road (`splitViasAt`, #444).
import {
  MAX_POINTS,
  MAX_ROUTES,
  MAX_STOPS,
  routePayload,
  type PointInput,
  type RidePayload,
  type RoutePayload,
} from '../maps/ride-graph'
import { haversineM, type Track } from '../maps/kml'
import type { Role } from '../maps/roles'
import { ROUTE_COLORS } from '../maps/palette'
import { newUid } from '../maps/uid'
import { resolveAltGroups } from '../maps/alts'
import { FALLBACK_MPS } from './summary'

export type Leg = RoutePayload['legs'][number]
export type Stale = { route: number; leg: number }
export type Place = { name: string; address?: string | null; lng: number; lat: number }

// The builder's own cap, restated because the client copy is the one it enforces.
export const MAX_VIAS_PER_LEG = 20

/** The browser's snapToTrack() position on a track, as segment index plus fraction,
 *  searching from `floor`; null for a track with no segment. */
function trackPos(track: Track, [lng, lat]: [number, number], floor: number): { seg: number; pos: number } | null {
  if (track.length < 2) return null
  const k = Math.cos((lat * Math.PI) / 180)
  let best: { seg: number; pos: number } | null = null
  let bestD = Infinity
  for (let i = Math.max(0, Math.min(floor, track.length - 2)); i < track.length - 1; i++) {
    const ax = track[i][0] * k
    const ay = track[i][1]
    const vx = track[i + 1][0] * k - ax
    const vy = track[i + 1][1] - ay
    const len2 = vx * vx + vy * vy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((lng * k - ax) * vx + (lat - ay) * vy) / len2))
    const dx = ax + t * vx - lng * k
    const dy = ay + t * vy - lat
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = { seg: i, pos: i + t }
    }
  }
  return best
}

/**
 * route-shape.js `snapToTrack()`: the foot of the perpendicular from a coordinate
 * onto a track, searching from segment `fromSegment`, rounded to six places the way
 * the browser rounds it. test/agent-tool-fix-more.test.ts pins the two together.
 */
export function snapToTrack(
  track: Track,
  [lng, lat]: [number, number],
  fromSegment = 0,
): { lngLat: [number, number]; segmentIndex: number; t: number } | null {
  if (track.length < 2) return null
  const k = Math.cos((lat * Math.PI) / 180)
  let best: { lngLat: [number, number]; segmentIndex: number; t: number } | null = null
  let bestD = Infinity
  for (let i = Math.max(0, Math.min(fromSegment, track.length - 2)); i < track.length - 1; i++) {
    const ax = track[i][0] * k
    const ay = track[i][1]
    const vx = track[i + 1][0] * k - ax
    const vy = track[i + 1][1] - ay
    const len2 = vx * vx + vy * vy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((lng * k - ax) * vx + (lat - ay) * vy) / len2))
    const px = ax + t * vx
    const py = ay + t * vy
    const d = (px - lng * k) ** 2 + (py - lat) ** 2
    if (d < bestD) {
      bestD = d
      best = { lngLat: [+(px / k).toFixed(6), +py.toFixed(6)], segmentIndex: i, t }
    }
  }
  return best
}

/**
 * builder.js `snapVias()`: pull each shaping point onto the road the router
 * returned, walked in order with each one's segment as the next one's floor so two
 * cannot snap out of order and double the leg back. A via is dropped wherever it was
 * put, often off any road; once the road comes back the handle belongs on it.
 * Returns a NEW array: the old one may still be shared with the leg it replaced.
 */
export function snapVias(geometry: Track, vias: Track): Track {
  if (!vias.length || geometry.length < 2) return vias
  const out: Track = vias.map((v) => [v[0], v[1]])
  let floor = 0
  for (let i = 0; i < out.length; i++) {
    const hit = snapToTrack(geometry, [out[i][0], out[i][1]], floor)
    if (!hit) break
    floor = hit.segmentIndex
    out[i] = hit.lngLat
  }
  return out
}

/**
 * Which of a leg's shaping points go before a point inserted on it, and which after,
 * by where each lies along the leg's road (#444). route-shape.js `splitViasAt()` is
 * the browser's copy; test/route-shape.test.ts pins the two together.
 */
export function splitViasAt(track: Track, vias: Track, at: [number, number]): [Track, Track] {
  if (!vias.length) return [[], []]
  const cut = trackPos(track, at, 0)
  if (!cut) return [vias.slice(), []]
  let floor = 0
  let n = 0
  for (const v of vias) {
    const s = trackPos(track, [v[0], v[1]], floor)
    if (!s || s.pos > cut.pos) break
    floor = s.seg
    n++
  }
  return [vias.slice(0, n), vias.slice(n)]
}

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

// The schema's own caps, checked BEFORE the edit rather than discovered by the
// save: an agent edit that breaks one is a proposal the PUT would 400 forever.
function roomForPoint(route: RoutePayload): void {
  if (route.points.length >= MAX_POINTS)
    throw new EditError(`a route holds at most ${MAX_POINTS} points; start a new route instead`)
}

function roomForStop(route: RoutePayload): void {
  if (route.points.filter((p) => p.kind === 'stop').length >= MAX_STOPS)
    throw new EditError(`a route holds at most ${MAX_STOPS} stops; leave this one as a point to ride past`)
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
  roomForPoint(route)
  if ((opts.roles ?? []).length > 0) roomForStop(route)
  const before = route.points.slice()
  const legs = route.legs.slice()
  const point = newPoint(place, opts.roles ?? [])
  if (opts.durationMin != null) point.durationMin = Math.max(0, Math.min(43200, Math.round(opts.durationMin)))
  const at = Math.max(0, Math.min(route.points.length, opts.at ?? route.points.length))
  // Mid-leg: the old leg's shaping points go to whichever half they lie on.
  const carry = new Map<string, Track>()
  const old = at > 0 && at < before.length ? legs[at - 1] : undefined
  if (old) {
    const [head, tail] = splitViasAt(old.geometry, old.viaPoints ?? [], [point.lng, point.lat])
    carry.set(pairKey(before[at - 1], point), head)
    carry.set(pairKey(point, before[at]), tail)
  }
  route.points.splice(at, 0, point)
  return { point, stale: releg(r, route, before, legs, carry) }
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

/**
 * Reorder a point within its route, as builder.js `reorderPoint()` does: every leg
 * from the one arriving at the earlier index through the one leaving the later
 * is rebuilt straight with its shaping points cleared, EVEN WHERE ITS PAIR HAPPENS
 * TO SURVIVE, because a move is the edit that says the road in that span is up
 * for grabs. Legs outside the span keep their road and their vias.
 */
export function movePoint(ride: RidePayload, routeUid: string, pointUid: string, to: number): Stale[] {
  const r = routeIndex(ride, routeUid)
  const route = ride.routes[r]
  const from = pointIndex(route, pointUid)
  // Refused rather than clamped, as the builder refuses it: an index past the end
  // is the model miscounting, and a silently different position is a wrong answer.
  if (!Number.isInteger(to) || to < 0 || to >= route.points.length)
    throw new EditError(`position ${to} is outside this route, which has positions 0 to ${route.points.length - 1}`)
  const dest = to
  if (dest === from) return []
  const [p] = route.points.splice(from, 1)
  route.points.splice(dest, 0, p)
  const stale: Stale[] = []
  const lo = Math.max(0, Math.min(from, dest) - 1)
  const hi = Math.min(route.points.length - 2, Math.max(from, dest))
  for (let k = lo; k <= hi; k++) {
    route.legs[k] = straightLeg(route.points[k], route.points[k + 1])
    stale.push({ route: r, leg: k })
  }
  return stale
}

/** Give a point categories. Any role makes it a stop; clearing them all makes it
 *  a POI, unless it is the route's only stop, which is refused. */
export function setRoles(ride: RidePayload, routeUid: string, pointUid: string, roles: Role[]): void {
  const route = ride.routes[routeIndex(ride, routeUid)]
  const p = route.points[pointIndex(route, pointUid)]
  if (roles.length === 0 && p.kind === 'stop' && route.points.filter((q) => q.kind === 'stop').length === 1) {
    throw new EditError('that is the route’s only stop, so it has to keep being one')
  }
  if (roles.length > 0 && p.kind !== 'stop') roomForStop(route)
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
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`
  // A real moment, not just the right shape: 2026-13-45T25:99 matches the pattern,
  // and a Date built from it rolls over to somewhere else or is invalid outright.
  const d = new Date(iso)
  if (Number.isNaN(d.getTime()) || d.toISOString() !== iso) throw new EditError(`${local} is not a real date and time`)
  route.startAt = iso
  route.endAt = null
}

export function renameRoute(ride: RidePayload, routeUid: string, title: string): void {
  ride.routes[routeIndex(ride, routeUid)].title = title.slice(0, 150)
}

/** A new route, appended, starting at one place. Its first point is a stop tagged
 *  `start`, which is the rule the builder applies to the first point of a route. */
export function addRoute(ride: RidePayload, title: string, start: Place): RoutePayload {
  if (ride.routes.length >= MAX_ROUTES) throw new EditError(`a ride holds at most ${MAX_ROUTES} routes`)
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

/**
 * Give a route new routing preferences and mark EVERY leg for routing, because a
 * preference changes the road and the old one drawn under it is a lie on the map
 * (builder.js `togglePref()` re-routes them all for the same reason).
 *
 * `prefs` MUST ALREADY BE NORMALIZED by `normalizePrefs()` in route-prefs.ts, which
 * is the one place null, `{}` and all-false are decided to be one state; this module
 * imports nothing from there, so the caller does it. The legs keep their road and
 * their shaping points until the router answers: a rider's shaping is still their
 * intent under a new preference, and a leg that cannot be redrawn is refused by
 * the caller and rolled back rather than left wrong.
 */
export function setRoutePrefs(ride: RidePayload, routeUid: string, prefs: RoutePayload['routePrefs']): Stale[] {
  const r = routeIndex(ride, routeUid)
  const route = ride.routes[r]
  route.routePrefs = prefs
  return route.legs.map((_, leg) => ({ route: r, leg }))
}

/**
 * The ride's stop-by time: when the group wants to be looking for a bed, as a WALL
 * CLOCK where the ride is (`rides.stop_by_min`, minutes from midnight). "16:00"
 * means four where the bike is, so nothing converts it. null clears it.
 */
export function setStopBy(ride: RidePayload, local: string | null): void {
  if (local == null || local === '') {
    ride.stopByMin = null
    return
  }
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(local)
  if (!m) throw new EditError('a stop-by time must be a 24-hour local time like 16:00')
  ride.stopByMin = Number(m[1]) * 60 + Number(m[2])
}

// --- Fix tools (#459) --------------------------------------------------------

/** builder.js ROUTE_START_HOUR: a route split off another sets off at eight. */
export const ROUTE_START_HOUR = 8

/** ride-time.js `routeElapsedS()`: riding plus every planned stop, a leg the router
 *  never answered for estimated from its distance. What a route's end derives from. */
export function routeElapsedS(route: RoutePayload): number {
  let s = 0
  for (const l of route.legs)
    s += l.durationS <= 0 && l.distanceM > 0 ? Math.round(l.distanceM / FALLBACK_MPS) : l.durationS
  for (const p of route.points) s += (p.durationMin ?? 0) * 60
  return s
}

/** route-clock.js `nextMorningAfter()`: the first `hour` o'clock strictly after a
 *  wall-clock moment carried as UTC. */
export function nextMorningAfter(iso: string | null, hour = ROUTE_START_HOUR): string | null {
  if (!iso) return null
  const end = new Date(iso)
  if (Number.isNaN(end.getTime())) return null
  const start = new Date(end)
  start.setUTCHours(hour, 0, 0, 0)
  if (start <= end) start.setUTCDate(start.getUTCDate() + 1)
  return start.toISOString()
}

/** The end a route's clock derives to, or null with no departure. */
function derivedEndIso(route: RoutePayload): string | null {
  return route.startAt ? new Date(new Date(route.startAt).getTime() + routeElapsedS(route) * 1000).toISOString() : null
}

/** builder.js `inferEndManual()`: an end more than a minute off the derived one was
 *  typed by the rider. The flag lives only in the builder, so it is inferred here. */
function endIsManual(route: RoutePayload): boolean {
  if (!route.startAt || !route.endAt) return false
  const derived = derivedEndIso(route)
  if (!derived) return false
  return Math.abs(new Date(route.endAt).getTime() - new Date(derived).getTime()) > 60000
}

/**
 * builder.js `syncEnd()` over a whole ride after an edit: every route with a
 * departure whose end was AUTOMATIC before the edit gets its end re-derived from
 * its new shape, and an end the rider typed is kept. Without it an edit that changes
 * a route's riding time leaves the stored end stale, and the builder's
 * inferEndManual() then reads the stale value as one the rider typed and freezes it.
 *
 * Automatic is inferEndManual()'s rule, applied to the route as it was BEFORE the
 * edit (`before`, matched by uid), because after it every old end looks typed. A
 * route new in this edit, or one whose end the edit cleared, is automatic: a null
 * end is never a rider's answer, and the builder derives one for it on load anyway.
 * runTool calls it after every edit, with the clone it keeps for rolling back.
 * Returns how many ends changed.
 */
export function syncEnds(ride: RidePayload, before: RidePayload): number {
  const was = new Map(before.routes.map((r) => [r.uid, r]))
  let n = 0
  for (const route of ride.routes) {
    if (!route.startAt) continue
    const prior = route.uid ? was.get(route.uid) : undefined
    // A route with no uid cannot be matched to what it was, so its end is kept.
    const manual = route.endAt != null && (prior ? endIsManual(prior) : route.uid == null)
    if (manual) continue
    const end = derivedEndIso(route)
    if (end !== route.endAt) {
      route.endAt = end
      n++
    }
  }
  return n
}

/** A color no other route on the ride is drawn in, the rule addRoute() and the
 *  builder's splitRouteHere() both follow. */
function freshColor(ride: RidePayload): string {
  const used = new Set(ride.routes.map((r) => r.color.toLowerCase()))
  return ROUTE_COLORS.find((c) => !used.has(c.toLowerCase())) ?? ROUTE_COLORS[ride.routes.length % ROUTE_COLORS.length]
}

/**
 * Cut a route in two at a point, as the builder's "End the route here" does
 * (`splitRouteHere` in builder.js, the arithmetic in route-split.js, which
 * test/agent-tool-fix-more.test.ts pins this against).
 *
 * THE POINT BELONGS TO BOTH ROUTES: the last of the first and, as a fresh copy, the
 * first of the second. NOTHING IS RE-ROUTED: legs 0..i-1 stay on the first route and
 * i.. move to the second, each on the road it was drawn on. Not at the first or last
 * point, where one side would be a route that goes nowhere.
 *
 * The copy is a stop with no roles (the hotel is recorded once, on the route that
 * rode to it); it keeps the place's public address, which the builder's copy drops.
 * The second route has no title, the next unused color, no alternate grouping, and
 * sets off the morning after the first one ends when the first has a departure,
 * which is the builder's rule. The first route's end is cleared for the builder to
 * re-derive unless the rider typed it.
 */
export function splitRoute(ride: RidePayload, routeUid: string, pointUid: string): RoutePayload {
  const r = routeIndex(ride, routeUid)
  const route = ride.routes[r]
  const i = pointIndex(route, pointUid)
  if (ride.routes.length >= MAX_ROUTES) throw new EditError(`a ride holds at most ${MAX_ROUTES} routes`)
  if (i <= 0 || i >= route.points.length - 1)
    throw new EditError(
      'a route can only be split at a point between its first and last, so each side keeps at least one leg',
    )
  const manualEnd = endIsManual(route)
  const at = route.points[i]
  const first: RoutePayload = { ...route, points: route.points.slice(0, i + 1), legs: route.legs.slice(0, i) }
  const carried: PointInput = {
    kind: 'stop',
    lat: at.lat,
    lng: at.lng,
    name: at.name,
    address: at.address ?? null,
    description: '',
    roles: [],
    durationMin: null,
    slackMin: null,
    uid: newUid(),
    details: null,
  }
  const second: RoutePayload = {
    ...route,
    uid: newUid(),
    title: '',
    color: freshColor(ride),
    points: [carried, ...route.points.slice(i + 1)],
    legs: route.legs.slice(i),
    altGroup: null,
    altActive: true,
    startAt: null,
    endAt: null,
  }
  // A copy of the point it promotes, so a split refused below leaves the ride as it was.
  if (!first.points.some((p) => p.kind === 'stop')) first.points[0] = { ...first.points[0] }
  ensureRouteHasStop(first)
  // REFUSED BEFORE THE RIDE CHANGES. The copy is a stop, so a route of MAX_STOPS stops
  // all after a POI split point comes out one over; and anything else the schema
  // bounds is checked by the schema itself, so the split cannot hand the save a
  // route it will 400 forever.
  const stops = second.points.filter((p) => p.kind === 'stop').length
  if (stops > MAX_STOPS)
    throw new EditError(
      `the new route would hold ${stops} stops, more than the ${MAX_STOPS} a route may; split at a stop, or further along`,
    )
  for (const half of [first, second]) {
    const ok = routePayload.safeParse(half)
    if (!ok.success)
      throw new EditError(
        `that split would leave a route the ride cannot save: ${ok.error.issues[0]?.message ?? 'invalid'}`,
      )
  }
  if (!manualEnd) first.endAt = null
  if (first.startAt) second.startAt = nextMorningAfter(first.endAt ?? derivedEndIso(first))
  ride.routes.splice(r, 1, first, second)
  return second
}

/**
 * Ride a route backwards, as builder.js `reverseRoute()` does: the whole list, both
 * kinds, with `start` and `finish` swapped. EVERY LEG IS REBUILT STRAIGHT AND WITH
 * NO SHAPING POINTS, because geometry is directional (one-way roads, divided
 * highways) and a via describes the road the old direction took. All of them are
 * returned for routing.
 */
export function reverseRoute(ride: RidePayload, routeUid: string): Stale[] {
  const r = routeIndex(ride, routeUid)
  const route = ride.routes[r]
  if (route.points.length < 2) throw new EditError('that route has only one point, so there is nothing to reverse')
  route.points = route.points
    .slice()
    .reverse()
    .map((p) => ({
      ...p,
      roles: p.roles.map((role) => (role === 'start' ? 'finish' : role === 'finish' ? 'start' : role)),
    }))
  route.legs = []
  const stale: Stale[] = []
  for (let k = 0; k < route.points.length - 1; k++) {
    route.legs.push(straightLeg(route.points[k], route.points[k + 1]))
    stale.push({ route: r, leg: k })
  }
  return stale
}

/**
 * Make one route the one ridden in its alternate group, as builder.js `promoteAlt()`
 * does: every sibling inactive, this one active, then the group resolved by
 * alts.ts. Returns false when it already was. Order never changes, so no route is
 * renumbered.
 */
export function chooseAlternate(ride: RidePayload, routeUid: string): boolean {
  const route = ride.routes[routeIndex(ride, routeUid)]
  const group = route.altGroup
  if (group == null)
    throw new EditError('that route is not one of a set of alternatives, so there is nothing to choose')
  if (route.altActive) return false
  for (const d of ride.routes) if (d.altGroup === group) d.altActive = false
  route.altActive = true
  resolveAltGroups(ride.routes)
  return true
}

/**
 * Add a shaping point to the leg LEAVING `fromPointUid`, in track order: before the
 * existing vias that lie further along the leg's current road and after the rest,
 * the same projection `splitViasAt()` uses. Capped at MAX_VIAS_PER_LEG. The leg is
 * rebuilt straight through its vias and returned for routing.
 */
export function addVia(
  ride: RidePayload,
  routeUid: string,
  fromPointUid: string,
  lngLat: [number, number],
): { stale: Stale[]; count: number } {
  const r = routeIndex(ride, routeUid)
  const route = ride.routes[r]
  const i = pointIndex(route, fromPointUid)
  const leg = route.legs[i]
  if (i >= route.points.length - 1 || !leg)
    throw new EditError('that is the last point on the route, so no leg leaves it; name the point the leg starts from')
  const vias: Track = leg.viaPoints ?? []
  if (vias.length >= MAX_VIAS_PER_LEG)
    throw new EditError(`that leg already has ${MAX_VIAS_PER_LEG} shaping points, the most a leg may carry`)
  const at: [number, number] = [r6(lngLat[0]), r6(lngLat[1])]
  if (vias.some((v) => v[0] === at[0] && v[1] === at[1]))
    throw new EditError('that leg already has a shaping point there')
  const [head, tail] = splitViasAt(leg.geometry, vias, at)
  route.legs[i] = straightLeg(route.points[i], route.points[i + 1], [...head, at, ...tail])
  return { stale: [{ route: r, leg: i }], count: vias.length + 1 }
}
