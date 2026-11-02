// One press of Find meeting points, as a service: the orchestration around the pure
// proposer in ./rendezvous.ts, which calls no router.
//
// TWO CALLERS, ONE IMPLEMENTATION. The builder's button (POST /api/rides/:id/rendezvous
// in src/routes/rendezvous.ts) and the planning assistant's propose_meeting_points
// (src/agent/tools/meet.ts) both come here, so the answer a rider gets from the panel
// and the one the assistant reads cannot drift. The input is PAYLOAD-SHAPED: the
// route builds it from the stored rows, the assistant hands over the ride it holds,
// which may carry edits not saved yet.
//
// ONE PRESS, ONE ANSWER PER JOINING GROUP. The button stays single — that half of
// #239 was right and is not being reopened — but a press answers the whole question
// rather than a blended version of it: each satellite gets its own candidates on the
// main group's road, and the planner knocks the decisions down one at a time. A
// blended proposal was the part that did not survive contact with three groups: it
// suited everybody on average and nobody in particular.
//
// THE BILL IS A TOTAL, NOT A PER-GROUP RATE: every joining group costs its own Routes
// requests, so an unbudgeted press on a nine-group ride is 36 of them. ROUTED_BUDGET
// and ANCHOR_BUDGET are divided by the group count instead, so a big ride buys fewer
// candidates each rather than a bigger bill.
//
// AN OPTIONAL BUDGET IS CHARGED BEFORE EVERY BILLED REQUEST. The HTTP route passes
// none and spends exactly what it always did. The assistant passes its turn's Budget,
// so a press can never outspend the turn or the rider's day; a request the budget
// refuses is not made, and the group it was for is reported as limited rather than
// answered as though nothing were there.
//
// THE MAIN GROUP'S ROAD IS THE ROAD. `primarySubgroup` is the main group, and it is
// passed to the proposer as its own argument, so it can never come back as the group
// being asked to divert.
import {
  alongTrackM,
  DEFAULT_DIVERT_MI,
  FUEL_SEARCH,
  nearestVertex,
  proposeGroupMeet,
  rankByRoad,
  worstDivertMi,
  type FuelCandidate,
  type FuelRole,
  type GroupMeet,
  type GroupRoute,
  type RoadMeasure,
} from './rendezvous'
import { startRouteOf, strandOf } from './policy'
import { activeRoutes } from '../maps/alts'
import { METERS_PER_MILE, haversineM, type Track } from '../maps/kml'
import { searchPlaces, type PlacesResult } from '../maps/places'
import { cachedRouteLeg, fetchRouteLeg, type RouteResult } from '../routes/routing'
import { GMAPS_SERVER_KEY } from '../config'

/**
 * Gas stations on the main group's road, in the window where a meet is viable.
 *
 * ANCHORED ON THE CANDIDATES THE GEOMETRY ALREADY LIKED, which is what keeps
 * this to a bounded number of billed requests however long the ride is: the
 * plain pass has already ruled out everywhere unreachable, so the only stretch
 * worth searching is the one it named.
 *
 * `SEARCH_ANCHORS` is a money number in the same way `MAX_CORRIDOR_SAMPLES` is.
 * Two anchors covers the earliest viable point and one a little further on,
 * which is the spread a rider is choosing between; a third would be a third
 * Text Search per press for a candidate below the fold.
 */
export const SEARCH_ANCHORS = 2
const STATION_RADIUS_M = 20_000

/** The whole press's Text Search allowance, divided by the joining groups. Six
 *  is two groups at full spread, or six groups at one anchor each. Past six the
 *  floor of one anchor per group spends one more per group. */
export const ANCHOR_BUDGET = 6

/** The whole press's routed-approach allowance, divided the same way. Twelve is
 *  three groups at the old per-group ceiling, and it is the number that stops a
 *  nine-group ride costing 36 Routes requests on one press. Past twelve joining
 *  groups the floor of one spends one more per group. */
export const ROUTED_BUDGET = 12

/** How many gas candidates are shortlisted before the fuel-range filter. Larger
 *  than the three a rider is shown, because the filter removes some — and small,
 *  because every survivor costs a Routes request per joining group. */
export const GAS_SHORTLIST = 6

/** The most candidates whose approaches are routed. A hard stop on the bill: a
 *  ride with four joining groups would otherwise spend 24 Routes requests on one
 *  press of a button. */
export const MAX_ROUTED_CANDIDATES = 4

/** How many the rider is finally offered. */
export const MEET_LIMIT = 3

/** The ride as the proposer needs it: the payload's own shape, narrowed. Routes in
 *  the rider's order, every route including unchosen alternates (they are dropped
 *  here, the way the panel drops them). */
export type MeetRide = {
  subgroups: readonly { uid: string; name: string }[]
  primarySubgroup: string | null
  routes: readonly {
    subgroupUid: string | null
    altGroup?: number | null
    altActive?: boolean
    points: readonly {
      lat: number
      lng: number
      roles: readonly string[]
      /** How far into ITS OWN ROUTE the point is. The route passes the stored
       *  column, which is null on a trackless import; absent, it is the prefix sum
       *  of the legs before it, which is how insertRideGraph writes that column. */
      distFromStartM?: number | null
    }[]
    legs: readonly { geometry: readonly (readonly [number, number])[]; distanceM: number }[]
  }[]
}

/** What a press may spend. The agent's Budget satisfies it as it stands. */
export type MeetBudget = {
  take(kind: 'search' | 'leg'): boolean
  refund(kind: 'search' | 'leg'): void
}

export type MeetOptions = {
  /** What refuels and how far one tank goes, asked for only once the ride is known
   *  to be answerable, so a refusal costs the HTTP route no roster read. `role` is
   *  fuelRoleOf()'s, null on a pedal ride, which searches for nothing; `rangeMi` is
   *  groupRange()'s, null meaning the range check does not run. */
  fuel: () => Promise<{ role: FuelRole | null; rangeMi: number | null }>
  /** Already clamped by clampDivert(); undefined means the default. */
  maxDivertMi: number | undefined
  /** The rider's place lists, already parsed by parseTerms(). */
  favor: string[]
  avoid: string[]
  /** Charged before every billed request. Absent means unbounded: the HTTP route. */
  budget?: MeetBudget
}

/** One joining group's answer, exactly the shape the HTTP route sends. */
export type GroupProposal = {
  group: string
  name: string
  note: 'out-of-range' | 'no-gas' | null
  candidates: {
    lng: number
    lat: number
    worstDivertMi: number
    alongM: number
    sharedPct: number
    isFuel: boolean
    name: string
    address: string
    diverts: { group: string; mi: number; onRoute: boolean }[]
    approach: Track
  }[]
  reason: 'none-viable' | null
}

/** A group's answer plus what the budget cut short, which only a budgeted caller
 *  can see: `searchLimited` means fewer station searches ran than the press wanted
 *  (so `no-gas` may be untrue), `legLimited` that fewer approaches were routed. */
export type GroupAnswer = { proposal: GroupProposal; searchLimited: boolean; legLimited: boolean }

export type MeetAnswer =
  | { ok: false; reason: 'one-group' | 'no-routes'; group?: string }
  | { ok: true; groups: GroupAnswer[]; mainGroup: string }

type Approach = { group: string; path: Track; distanceM: number }

type Row = {
  id: number
  position: number
  subgroupId: number | null
  points: MeetRide['routes'][number]['points']
  legs: MeetRide['routes'][number]['legs']
}

export async function proposeMeetingPoints(ride: MeetRide, opts: MeetOptions): Promise<MeetAnswer> {
  const { favor, avoid, budget } = opts
  // Set once the refusals are behind us, the point the route always read the roster.
  let fuelRole: FuelRole | null = null
  let rangeMi: number | null = null
  const divertOpt: { maxDivertMi: number | undefined; favor: string[]; avoid: string[]; fuelRole?: FuelRole | null } = {
    maxDivertMi: opts.maxDivertMi,
    favor,
    avoid,
  }

  // One group has nobody to meet. A real answer rather than an error.
  if (ride.subgroups.length < 2) return { ok: false, reason: 'one-group' }

  // Numeric ids, because strandOf() and startRouteOf() address groups by one. A
  // route tagged with a uid the ride does not hold is shared, which is what a save
  // makes of it (insertRideGraph resolves an unknown uid to null).
  const groups = ride.subgroups.map((g, i) => ({ id: i + 1, uid: g.uid, name: g.name }))
  const idOf = new Map(groups.map((g) => [g.uid, g.id]))
  const all: Row[] = activeRoutes(
    ride.routes.map((r, i) => ({
      id: i,
      position: i,
      subgroupId: r.subgroupUid ? (idOf.get(r.subgroupUid) ?? null) : null,
      altGroup: r.altGroup ?? null,
      altActive: r.altActive ?? true,
      points: r.points,
      legs: r.legs,
    })),
  )
  if (all.length === 0) return { ok: false, reason: 'no-routes' }

  // Every leg geometry, keyed by route, and each route's drawn length, so a point's
  // distance from ITS route's start can be offset onto the whole strand.
  const byRoute = new Map<number, Track[]>()
  const routeLengthM = new Map<number, number>()
  for (const r of all) {
    byRoute.set(
      r.id,
      r.legs.map((l) => l.geometry as Track),
    )
    let len = 0
    for (const l of r.legs) len += trackLengthM(l.geometry as Track)
    routeLengthM.set(r.id, len)
  }

  // Every point in the ride, read for two things at once. The FIRST point of a
  // group's first route is where they set off (not their riders' home addresses:
  // this proposes against the ride as planned, and the planner may not have put
  // anybody in a group yet), and any point tagged `gas` anywhere is offered as a
  // candidate in its own right.
  const originOf = new Map<number, [number, number]>()
  const fuel: FuelCandidate[] = []
  const pts: { routeId: number; roles: readonly string[]; distFromStartM: number | null }[] = []
  for (const r of all) {
    let prefix = 0
    r.points.forEach((p, i) => {
      if (i === 0) originOf.set(r.id, [p.lng, p.lat])
      fuel.push({ at: [p.lng, p.lat], roles: [...p.roles] })
      pts.push({
        routeId: r.id,
        roles: p.roles,
        distFromStartM: p.distFromStartM === undefined ? prefix : p.distFromStartM,
      })
      prefix += r.legs[i]?.distanceM ?? 0
    })
  }

  // WHAT A GROUP RIDES IS THEIR STRAND — their own routes plus every shared one, in
  // position order.
  const routeFor = (g: (typeof groups)[number], isPrimary: boolean): GroupRoute | null => {
    const strand = strandOf(all, g.id)
    if (strand.length === 0) return null
    // **A JOINING GROUP'S ROAD IS ITS OWN ROUTES, NOT ITS STRAND.** A strand is a group's
    // own routes PLUS every shared one — and a shared route is precisely the road they
    // have not ridden yet. Building their track from the strand hands them the main
    // group's entire road as though it were theirs, so every candidate on it falls
    // within ON_ROUTE_M, every divert comes out at zero, and the earliest acceptable
    // point wins: the start. Seen on stage on a ride from Oakland to Ensenada.
    //
    // The primary keeps the strand, because for them the shared road IS theirs.
    const own = isPrimary ? strand : strand.filter((d) => d.subgroupId === g.id)
    // WHERE THEY SET OFF IS THEIR OWN ROUTE, NOT `strand[0]` — see startRouteOf().
    // `isPrimary` reverses that: the main group rides the shared road from position 0.
    const startRoute = startRouteOf(all, g.id, isPrimary)
    const origin = startRoute && originOf.get(startRoute.id)
    if (!origin) return null
    const track: Track = []
    for (const d of own) {
      for (const geom of byRoute.get(d.id) ?? []) {
        for (const v of geom) {
          // Drop the duplicate vertex at every joint, the same way the viewer's
          // per-route concat does — a repeated point is a zero-length segment that
          // makes the bearing at that vertex undefined.
          const last = track[track.length - 1]
          if (!last || last[0] !== v[0] || last[1] !== v[1]) track.push(v)
        }
      }
    }
    return { id: g.uid, origin, track }
  }

  /**
   * How far along a group's strand they last filled up before `alongM`. Zero when
   * there is no fuel point before it: a group sets off with a full tank.
   *
   * A POINT WITH NO `dist_from_start_m` IS SKIPPED, not guessed at. That column is null
   * on a trackless import, and skipping makes the walk think the tank is older than it
   * is — wrong in the safe direction.
   */
  const fillBeforeM = (g: { id: number }, alongM: number): number => {
    let offset = 0
    let last = 0
    for (const d of strandOf(all, g.id)) {
      for (const p of pts) {
        if (p.routeId !== d.id) continue
        if (p.distFromStartM == null) continue
        if (!fuelRole || !p.roles.includes(fuelRole)) continue
        const at = offset + p.distFromStartM
        if (at <= alongM) last = Math.max(last, at)
      }
      offset += routeLengthM.get(d.id) ?? 0
    }
    return last
  }

  // THE MAIN GROUP, falling back to the first group when none is named: the builder
  // names the first group the moment there is one, so a missing one means a ride from
  // before the field existed, and "the first group" is what the planner would say.
  const primaryGroup = groups.find((g) => g.uid === ride.primarySubgroup) ?? groups[0]
  const primary = routeFor(primaryGroup, true)
  const joining: GroupRoute[] = []
  // Groups whose direct road the budget refused, so the answer can say so.
  const directRefused = new Set<string>()
  for (const g of groups) {
    if (g.id === primaryGroup.id) continue
    const r = routeFor(g, false)
    if (!r) continue
    // A GROUP WITH A STARTING POINT AND NO ROAD OF ITS OWN IS GIVEN ITS DIRECT ROAD,
    // ONCE (#370). Their direct road to the destination is the road they would take
    // anyway, and where it first touches the main group's is the convergence.
    //
    // ONE ROUTES REQUEST PER GROUP PER PRESS, cached on its endpoints. Only when they
    // have no track: a group that drew its own route said which road they are riding.
    if (r.track.length < 2 && primary && primary.track.length >= 3) {
      const dest = primary.track[primary.track.length - 1]
      const road = await routeLeg(r.origin, dest)
      // A Routes failure leaves them as they were: straight lines, which is still an
      // answer.
      if (road === 'refused') directRefused.add(r.id)
      else if (road.ok) {
        r.track = road.leg.geometry
        r.direct = true
      }
    }
    joining.push(r)
  }

  if (!primary || joining.length === 0) return { ok: false, reason: 'no-routes' }
  // THE MAIN GROUP HAS NOT PLANNED A ROAD YET, said as its own reason rather than
  // folded into "nowhere works": a meeting point is placed ON their road. It names
  // the group.
  if (primary.track.length < 3) return { ok: false, reason: 'no-routes', group: primaryGroup.name }

  // The main group's road, end to end, for the road re-rank: what a group rides
  // after meeting at a candidate is the rest of this.
  const trunkTotalM = trackLengthM(primary.track)

  // The range is the ride's — the SHORTEST tank on the roster, which is what #52 is for
  // — and the role decides what refuels: chargers for an electric ride (#31), nothing
  // for a pedal one (#446), gas otherwise.
  const tank = await opts.fuel()
  fuelRole = tank.role
  rangeMi = tank.rangeMi
  divertOpt.fuelRole = fuelRole

  // THE BUDGET, DIVIDED. Totals for the press rather than a rate per group: two
  // satellites get four routed candidates each, six get two each, and the bill does
  // not move. The floor of one is what keeps a nine-group ride answerable at all.
  const perGroup = Math.max(1, Math.min(MAX_ROUTED_CANDIDATES, Math.floor(ROUTED_BUDGET / joining.length)))
  const anchors = Math.max(1, Math.min(SEARCH_ANCHORS, Math.floor(ANCHOR_BUDGET / joining.length)))

  // SEQUENTIAL, NOT Promise.all, AND THAT IS DELIBERATE. Each group's pass spends
  // billed requests, and `fetchRouteLeg` and `searchPlaces` both cache — so groups
  // setting off from the same town pay once between them only if the second pass runs
  // after the first has filled the cache.
  const out: GroupAnswer[] = []
  for (const g of joining) {
    const a = await proposeFor(g, perGroup, anchors)
    if (directRefused.has(g.id)) a.legLimited = true
    out.push(a)
  }
  return { ok: true, groups: out, mainGroup: primaryGroup.name }

  /**
   * One satellite's answer: where THIS group can join the main group's road. A list
   * of one is the honest way to ask proposeGroupMeet this question.
   */
  async function proposeFor(g: GroupRoute, routed: number, searchAnchors: number): Promise<GroupAnswer> {
    const one = [g]
    const name = groups.find((x) => x.uid === g.id)?.name ?? ''
    // TWO PASSES, AND THE FIRST ONE IS FREE. The plain pass finds WHERE a meet is
    // viable using nothing but geometry; the search then looks for stations in that
    // window and the second pass re-scores.
    const plain = proposeGroupMeet(primary as GroupRoute, one, fuel, divertOpt)
    // THE CONVERGENCE IS ALWAYS ONE OF THE SEARCH ANCHORS: the least-extra candidate
    // is searched first and the paper favorite second.
    //
    // A PEDAL RIDE SEARCHES FOR NOTHING (#446): it has no fuel role, so there is no
    // kind of station to look for and no Text Search is spent.
    const found =
      plain.length && fuelRole
        ? await fuelAlong(frontLoadCheapest(plain), searchAnchors, fuelRole)
        : { stations: [] as FuelCandidate[], refused: false }
    const stations = found.stations
    // `fuelOnly` and NOT a filter over the ordinary result: the ranking prefers the
    // earliest viable point and keeps only the best few, so a station a little further
    // along is crowded out by plain vertices before a filter could see it.
    const onlyGas = stations.length
      ? proposeGroupMeet(
          primary as GroupRoute,
          one,
          [...fuel, ...stations],
          { ...divertOpt, fuelOnly: true },
          GAS_SHORTLIST,
        )
      : []

    // A MEETING POINT SHOULD BE A GAS STATION, AND IT HAS TO BE WITHIN A TANK OF THE
    // LAST FILL. THE CHEAPEST STATION IS ROUTED FIRST, WHATEVER THE STRAIGHT-LINE ORDER
    // SAYS, or the convergence could go unmeasured and never win.
    //
    // A PEDAL RIDE'S SHORTLIST IS THE ROAD ITSELF, AND NO TANK BOUNDS IT (#446).
    const shortlist = frontLoadCheapest(fuelRole ? onlyGas : plain)
    const tankMi = fuelRole ? rangeMi : null
    const reach = await reachable(shortlist, primaryGroup.uid, one, tankMi, primaryGroup, routed)

    // BOTH FALLBACKS SAY WHICH COMPROMISE WAS MADE. `note` is deliberately not
    // `reason`: reason means there are no candidates at all. EVERY ROW'S ROAD COMES
    // FROM `reach.routed`, keyed by candidate, and a fallback row gets its road too,
    // for free, because reachable() routed it to find out.
    // RANKED BY THE ROAD, NOW THAT THE ROAD IS KNOWN — see rankByRoad.
    const list = reach.keep.length ? reach.keep : onlyGas.length ? onlyGas : plain
    const measures: RoadMeasure[] = list.map((m) => ({ meet: m, toMeetM: roadsTo(m, one, reach.routed.get(m) ?? []) }))
    // KEYED BY COORDINATE, NOT IDENTITY: the re-rank returns new objects.
    const pathOf = new Map(list.map((m) => [m.at.join(','), reach.routed.get(m)?.[0]?.path ?? directApproach(m, one)]))
    const rows = rankByRoad(measures, trunkTotalM, divertOpt.maxDivertMi ?? DEFAULT_DIVERT_MI, { favor, avoid }).map(
      (m) => ({ m, path: pathOf.get(m.at.join(',')) ?? ([] as Track) }),
    )
    // No note on a pedal ride: neither compromise exists there.
    const note: GroupProposal['note'] =
      reach.keep.length || !fuelRole ? null : onlyGas.length ? 'out-of-range' : plain.length ? 'no-gas' : null

    const proposal: GroupProposal = {
      // The group this answer is FOR, by uid, which is what the panel and the map
      // both address a group by, with its name so the panel needs no lookup.
      group: g.id,
      name,
      note,
      candidates: rows.slice(0, MEET_LIMIT).map(({ m, path }) => ({
        lng: m.at[0],
        lat: m.at[1],
        // Miles, rounded. `score` is deliberately not sent: it is unitless.
        worstDivertMi: worstDivertMi(m),
        // METERS ALONG THE MAIN GROUP'S STRAND, which is what lets the builder put
        // the point where it belongs in the order rather than at the end.
        alongM: Math.round(m.alongM),
        sharedPct: Math.round(m.sharedFraction * 100),
        isFuel: m.isFuel,
        // Empty for a bare point on the road, which has neither.
        name: m.name ?? '',
        address: m.address ?? '',
        // THE EXTRA OVER THEIR CHEAPEST WAY OF JOINING, in road miles where the road
        // was measured and straight-line where it was not.
        diverts: m.diverts.map((d) => ({
          group: d.id,
          mi: Math.round((d.extraM / METERS_PER_MILE) * 10) / 10,
          onRoute: d.onRoute,
        })),
        // THE ROAD THIS GROUP WOULD ACTUALLY RIDE TO GET HERE, already fetched.
        approach: path,
      })),
      reason: rows.length === 0 ? 'none-viable' : null,
    }
    return { proposal, searchLimited: found.refused, legLimited: reach.refused }
  }

  /**
   * Keep the candidates every group can reach on the tank they arrive with, and
   * route the approaches while finding out.
   *
   * THE TWO JOBS ARE ONE PASS ON PURPOSE: the road the range is measured on is the
   * road the builder draws, so fetching it once answers both. The MAIN group is
   * measured along their own route (`alongM` minus their last fill), which needs no
   * request at all.
   *
   * With no known range the filter does not run and every candidate is kept.
   */
  async function reachable(
    candidates: GroupMeet[],
    primaryUid: string,
    joiningGroups: GroupRoute[],
    rangeMi: number | null,
    main: { id: number },
    // The routed-approach cap for THIS group, already divided out of the press's
    // budget. It bounds the Routes spend; MEET_LIMIT bounds what a rider is shown.
    routed: number,
  ): Promise<{ keep: GroupMeet[]; routed: Map<GroupMeet, Approach[]>; refused: boolean }> {
    const keep: GroupMeet[] = []
    // EVERY CANDIDATE THIS ROUTED, kept or rejected: the requests are spent either way.
    const routedPaths = new Map<GroupMeet, Approach[]>()
    const rangeM = rangeMi == null ? null : rangeMi * METERS_PER_MILE
    // THE BUDGET COUNTS REQUESTS, NOT CANDIDATES (#370). A candidate on the group's own
    // road costs no request and is always measured; the rest are fetched until
    // `routed` is spent.
    let fetched = 0
    let refused = false

    walk: for (const m of candidates) {
      if (fetched >= routed) break

      // THE MAIN GROUP FIRST AND FOR FREE: a candidate they cannot reach is dropped
      // before anything is spent routing anybody else to it.
      if (rangeM != null && m.alongM - fillBeforeM(main, m.alongM) > rangeM) continue

      const legs: Approach[] = []
      let allReach = true
      for (const g of joiningGroups) {
        if (g.id === primaryUid) continue
        // A group whose own road already passes through it is not detouring.
        const onRoute = m.diverts.find((d) => d.id === g.id)?.onRoute
        if (onRoute) continue
        fetched++
        const res = await routeLeg(g.origin, m.at)
        // A REFUSED BUDGET STOPS THE WALK, the way an exhausted `routed` does: a
        // candidate nobody measured is not one to offer on an unchecked tank.
        if (res === 'refused') {
          refused = true
          break walk
        }
        if (!res.ok) {
          // NO ROAD IS NOT OUT OF RANGE. A Routes failure says nothing about fuel; the
          // approach simply is not drawn.
          continue
        }
        legs.push({ group: g.id, path: res.leg.geometry, distanceM: res.leg.distanceM })
        routedPaths.set(m, legs)
        // A joining group sets off with a full tank, so the whole approach has to fit.
        if (rangeM != null && res.leg.distanceM > rangeM) {
          allReach = false
          break
        }
      }
      if (!allReach) continue
      keep.push(m)
    }
    return { keep, routed: routedPaths, refused }
  }

  /** One Routes request, charged to the budget when there is one. A cached leg is
   *  served before anything is claimed, and a request Google never saw is refunded. */
  async function routeLeg(a: [number, number], b: [number, number]): Promise<RouteResult | 'refused'> {
    if (!budget) return fetchRouteLeg(a, b)
    const hit = cachedRouteLeg(a, b)
    if (hit) return { ok: true, leg: hit, cached: true }
    if (!budget.take('leg')) return 'refused'
    const res = await fetchRouteLeg(a, b)
    if ((res.ok && res.cached) || (!res.ok && res.error === 'unconfigured')) budget.refund('leg')
    return res
  }

  /** One Text Search, charged the same way. */
  async function placeSearch(at: [number, number], role: FuelRole): Promise<PlacesResult | 'refused'> {
    const req = { query: FUEL_SEARCH[role].query, near: at, radiusM: STATION_RADIUS_M, wide: true }
    if (!budget) return searchPlaces(req, GMAPS_SERVER_KEY)
    if (!budget.take('search')) return 'refused'
    const res = await searchPlaces(req, GMAPS_SERVER_KEY)
    if ((res.ok && res.cached) || (!res.ok && res.error === 'unconfigured')) budget.refund('search')
    return res
  }

  /**
   * Stations near the first `anchors` candidates. A FAILURE IS AN EMPTY LIST, NOT AN
   * ERROR: the proposal is still good without pumps, and turning a Places outage into
   * a failed request would take away an answer that needs no network at all.
   */
  async function fuelAlong(
    plain: GroupMeet[],
    anchorCount: number,
    role: FuelRole,
  ): Promise<{ stations: FuelCandidate[]; refused: boolean }> {
    const { type } = FUEL_SEARCH[role]
    const stations: FuelCandidate[] = []
    const seen = new Set<string>()
    for (const anchor of plain.slice(0, anchorCount)) {
      const res = await placeSearch(anchor.at, role)
      if (res === 'refused') return { stations, refused: true }
      if (!res.ok) continue
      for (const p of res.places) {
        // TYPE, NOT NAME. Text Search answers "gas station" with supermarkets and
        // repair shops that merely mention fuel.
        if (p.type !== type) continue
        const key = p.lngLat.join(',')
        if (seen.has(key)) continue
        seen.add(key)
        stations.push({ at: p.lngLat, roles: [role], name: p.name, address: p.address })
      }
    }
    // Snapping and the on-route test are proposeGroupMeet's, not repeated here.
    return { stations, refused: false }
  }
}

function trackLengthM(track: Track): number {
  let len = 0
  for (let i = 1; i < track.length; i++) len += haversineM(track[i - 1][1], track[i - 1][0], track[i][1], track[i][0])
  return len
}

/** The shortlist with its least-extra candidate moved to the front, so the
 *  convergence is always among the routed few. Stable for the rest. */
function frontLoadCheapest(list: GroupMeet[]): GroupMeet[] {
  if (list.length < 2) return list
  let best = 0
  for (let i = 1; i < list.length; i++) if (list[i].worstExtraM < list[best].worstExtraM) best = i
  return [list[best], ...list.filter((_, i) => i !== best)]
}

/** The stretch of a start-only group's direct road up to an on-route candidate,
 *  so the rider sees how they get there. Empty for a group whose own route is
 *  already drawn, and for a candidate off their road, which was routed. */
function directApproach(m: GroupMeet, joining: GroupRoute[]): Track {
  const g = joining[0]
  if (!g?.direct) return []
  if (!m.diverts.find((d) => d.id === g.id)?.onRoute) return []
  const i = nearestVertex(g.track, m.at)
  return i < 0 ? [] : g.track.slice(0, i + 1)
}

/** Each joining group's road to a candidate: the routed approach where one was
 *  fetched, the distance along their own track where it passes through the
 *  point, null where neither exists. */
function roadsTo(m: GroupMeet, joining: GroupRoute[], approaches: Approach[]): Map<string, number | null> {
  const out = new Map<string, number | null>()
  for (const g of joining) {
    const d = m.diverts.find((x) => x.id === g.id)
    if (d?.onRoute) {
      out.set(g.id, alongTrackM(g.track, m.at))
      continue
    }
    const a = approaches.find((x) => x.group === g.id)
    out.set(g.id, a ? a.distanceM : null)
  }
  return out
}
