// Proposing a meeting point, over HTTP.
//
// The whole computation is `src/subgroups/rendezvous.ts`, which is pure and
// calls no router. This file's only job is to work out WHICH routes to hand it,
// from a ride that is being edited.
//
// ONE PRESS, ONE ANSWER PER JOINING GROUP. Ziad's call, 2026-09-04. The button
// stays single — that half of #239 was right and is not being reopened — but a
// press now answers the whole question rather than a blended version of it: each
// satellite gets its own candidates on the main group's road, and the planner
// knocks the decisions down one at a time, main + group 2, main + group 3, and
// so on. A satellite JOINS the main ride and becomes part of it.
//
// What #239 actually settled is still settled and is what makes this possible:
// the main group's road is THE road, so there is no spine to nominate and no
// group can come back as the one asked to divert. A blended proposal was the
// part that did not survive contact with three groups — it answered with points
// that suited everybody on average and nobody in particular, and the panel could
// not say which group any of it was for.
//
// THE BILL IS A TOTAL, NOT A PER-GROUP RATE. Ziad's call, 2026-09-04: every
// joining group costs its own Routes requests, so an unbudgeted press on a
// nine-group ride is 36 of them. ROUTED_BUDGET and ANCHOR_BUDGET are divided by
// the group count instead, so the spend is flat whatever the ride looks like and
// a big ride buys fewer candidates each rather than a bigger bill.
//
// THE MAIN GROUP'S ROAD IS THE ROAD. `rides.primary_subgroup_id` already means
// the main group and already defaults to the first one created, so there is
// nothing to nominate — and the main group is passed to the proposer as its own
// argument, so it can never come back as the group being asked to divert.
//
// A POST rather than a GET although it reads and writes nothing, and that is
// deliberate: it is behind requireSameOrigin like every other write-shaped call
// in the builder, and a GET would be cached by something.
import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/index'
import { days as daysTable, points as pointsTable, routeLegs } from '../db/schema'
import { currentUser, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { ownRide } from './maps'
import {
  proposeGroupMeet,
  worstDivertMi,
  type FuelCandidate,
  type GroupMeet,
  type GroupRoute,
} from '../subgroups/rendezvous'
import { subgroupsOf } from '../subgroups/service'
import { strandOf } from '../subgroups/policy'
import { activeDays } from '../maps/alts'
import { METERS_PER_MILE, haversineM, type Track } from '../maps/kml'
import { searchPlaces } from '../maps/places'
import { fetchRouteLeg } from './routing'
import { groupRange } from '../bikes/group-range'
import { GMAPS_SERVER_KEY } from '../config'

export const rendezvousRoutes = new Hono<AuthEnv>()

rendezvousRoutes.post('/api/rides/:id/rendezvous', requireActiveApi, requireSameOrigin, async (c) => {
  const user = currentUser(c)
  const ride = await ownRide(user.id, c.req.param('id'))
  if (!ride) return c.json({ error: 'not found' }, 404)

  const groups = await subgroupsOf(ride.id)
  // One group has nobody to meet. A real answer rather than an error.
  if (groups.length < 2) return c.json({ candidates: [], reason: 'one-group' })

  const all = activeDays(
    await db.select().from(daysTable).where(eq(daysTable.rideId, ride.id)).orderBy(daysTable.position),
  )

  const dayIds = all.map((d) => d.id)
  if (dayIds.length === 0) return c.json({ candidates: [], reason: 'no-days' })

  // Every leg geometry in the ride, once, keyed by day. ONE QUERY rather than
  // one per group: a group's strand includes the shared days, so the same day is
  // routinely read by several groups and a per-group query would fetch it twice.
  const legs = await db
    .select({ dayId: routeLegs.dayId, geometry: routeLegs.geometry, position: routeLegs.position })
    .from(routeLegs)
    .where(inArray(routeLegs.dayId, dayIds))
    .orderBy(routeLegs.position)
  const byDay = new Map<number, Track[]>()
  // Each day's own routed length, so a point's `dist_from_start_m` — which is
  // measured from ITS day's start — can be offset onto the whole strand.
  const dayLengthM = new Map<number, number>()
  for (const l of legs) {
    const list = byDay.get(l.dayId) ?? []
    list.push(l.geometry as Track)
    byDay.set(l.dayId, list)
    const geom = l.geometry as Track
    let len = 0
    for (let i = 1; i < geom.length; i++) {
      len += haversineM(geom[i - 1][1], geom[i - 1][0], geom[i][1], geom[i][0])
    }
    dayLengthM.set(l.dayId, (dayLengthM.get(l.dayId) ?? 0) + len)
  }

  // Every point in the ride, once, in position order — read for two things at
  // once. The FIRST point of a group's first day is where they set off (not
  // their riders' home addresses: this proposes against the ride as planned, and
  // the planner may not have put anybody in a group yet), and any point tagged
  // `gas` anywhere is offered as a candidate in its own right.
  const pts = await db
    .select({
      dayId: pointsTable.dayId,
      lat: pointsTable.lat,
      lng: pointsTable.lng,
      roles: pointsTable.roles,
      // How far into ITS OWN DAY a point is. Offset by the days before it to get
      // a distance along a group's whole strand — see fillBeforeM().
      distFromStartM: pointsTable.distFromStartM,
    })
    .from(pointsTable)
    .where(inArray(pointsTable.dayId, dayIds))
    .orderBy(pointsTable.position)
  const originOf = new Map<number, [number, number]>()
  const fuel: FuelCandidate[] = []
  for (const p of pts) {
    if (!originOf.has(p.dayId)) originOf.set(p.dayId, [p.lng, p.lat])
    fuel.push({ at: [p.lng, p.lat], roles: p.roles })
  }

  // WHAT A GROUP RIDES IS THEIR STRAND — their own days plus every shared one,
  // in position order. `strandOf` is already the definition of that and is not
  // restated here. It also means the two cases fall together: with no shared day
  // a strand is that group's own route, and with one the strands genuinely
  // overlap, which the proposer reads as a convergence costing nobody anything.
  const routeFor = (g: (typeof groups)[number]): GroupRoute | null => {
    const strand = strandOf(all, g.id)
    if (strand.length === 0) return null
    const origin = originOf.get(strand[0].id)
    if (!origin) return null
    const track: Track = []
    for (const d of strand) {
      for (const geom of byDay.get(d.id) ?? []) {
        for (const v of geom) {
          // Drop the duplicate vertex at every joint, the same way the viewer's
          // per-day concat does — a repeated point is a zero-length segment that
          // makes the bearing at that vertex undefined.
          const last = track[track.length - 1]
          if (!last || last[0] !== v[0] || last[1] !== v[1]) track.push(v)
        }
      }
    }
    return { id: g.uid, origin, track }
  }

  /**
   * How far along a group's strand they last filled up before `alongM`.
   *
   * Zero when there is no `gas` point before it, which is the right answer
   * rather than a missing one: a group sets off with a full tank, so the start
   * of their strand IS a fill.
   *
   * A POINT WITH NO `dist_from_start_m` IS SKIPPED, not guessed at. That column
   * is null on a trackless import, and skipping makes the walk think the tank is
   * older than it is — which refuses a marginal station rather than sending
   * somebody to one they cannot reach. Wrong in the safe direction.
   */
  const fillBeforeM = (g: { id: number }, alongM: number): number => {
    let offset = 0
    let last = 0
    for (const d of strandOf(all, g.id)) {
      for (const p of pts) {
        if (p.dayId !== d.id) continue
        if (p.distFromStartM == null) continue
        if (!p.roles.includes('gas')) continue
        const at = offset + p.distFromStartM
        if (at <= alongM) last = Math.max(last, at)
      }
      offset += dayLengthM.get(d.id) ?? 0
    }
    return last
  }

  // THE MAIN GROUP, falling back to the first one created when the column is
  // null. That fallback is not a guess: the builder sets `primarySubgroup` to
  // the first group the moment there is one, so a null here means a ride from
  // before the field existed, and "the first group" is what the planner would
  // say the main group was anyway.
  const primaryGroup = groups.find((g) => g.id === ride.primarySubgroupId) ?? groups[0]
  const primary = routeFor(primaryGroup)
  const joining: GroupRoute[] = []
  for (const g of groups) {
    if (g.id === primaryGroup.id) continue
    const r = routeFor(g)
    if (r) joining.push(r)
  }

  if (!primary || joining.length === 0) return c.json({ candidates: [], reason: 'no-days' })
  // THE MAIN GROUP HAS NOT PLANNED A ROAD YET, said as its own reason rather
  // than folded into "nowhere works". A meeting point is placed ON their road,
  // so with no routed day there is nothing to place it on — and "nowhere works"
  // would send the planner hunting for a geometry problem in a ride whose real
  // state is that it has not been drawn yet. It names the group, because which
  // one has to be planned first is the whole of what they need to know.
  if (primary.track.length < 3) {
    return c.json({ candidates: [], reason: 'no-routes', group: primaryGroup.name })
  }

  // THE BUDGET, DIVIDED. Every joining group costs its own Routes and Text
  // Search requests, so these are totals for the press rather than a rate per
  // group: two satellites get four routed candidates each, six get two each, and
  // the bill does not move. The floor of one is what keeps a nine-group ride
  // answerable at all — a group offered nothing is the confusion this replaced.
  const perGroup = Math.max(1, Math.min(MAX_ROUTED_CANDIDATES, Math.floor(ROUTED_BUDGET / joining.length)))
  const anchors = Math.max(1, Math.min(SEARCH_ANCHORS, Math.floor(ANCHOR_BUDGET / joining.length)))

  // The range is the ride's, from `groupRange()` — the SHORTEST tank on the
  // roster, which is what #52 is for. NULL MEANS NOTHING IS KNOWN and the check
  // does not run at all: a fuel plan built on an invented range is worse than no
  // fuel plan, because it looks like one. Read ONCE for the whole press rather
  // than per group: it is a fact about the roster, not about who is joining.
  const range = await groupRange(ride.id)

  // SEQUENTIAL, NOT Promise.all, AND THAT IS DELIBERATE. Each group's pass
  // spends billed requests, and `fetchRouteLeg` and `searchPlaces` both cache —
  // so groups setting off from the same town, or meeting at the same forecourt,
  // pay once between them only if the second pass runs after the first has
  // filled the cache. Firing them in parallel throws that away for a wall-clock
  // saving nobody is watching.
  const out = []
  for (const g of joining) {
    out.push(await proposeFor(g, perGroup, anchors))
  }

  return c.json({ groups: out })

  /**
   * One satellite's answer: where THIS group can join the main group's road.
   *
   * The whole pipeline that used to run once for a blended set of joiners, run
   * for one of them. Nothing in it changed shape — `proposeGroupMeet` always
   * took a list and a list of one is the honest way to ask this question, which
   * is why the proposer needed no change at all.
   */
  async function proposeFor(g: GroupRoute, routed: number, searchAnchors: number) {
    const one = [g]
    const name = groups.find((x) => x.uid === g.id)?.name ?? ''
    // `fuel` is every point in the ride; proposeGroupMeet keeps only the ones
    // tagged `gas` AND lying on a candidate spine, so a station on a road nobody
    // is riding is never offered. #67's thumb on the scale: a fuel stop is where
    // a group wants to regather anyway.
    // TWO PASSES, AND THE FIRST ONE IS FREE. The plain pass finds WHERE a meet
    // is viable using nothing but geometry; the search then looks for gas
    // stations in that window and the second pass re-scores with them. Searching
    // first would mean guessing where to look, and looking along the whole route
    // is a Text Search bill that scales with the length of the ride.
    const plain = proposeGroupMeet(primary as GroupRoute, one, fuel)
    const stations = plain.length ? await gasAlong(plain, searchAnchors) : []
    // `fuelOnly` and NOT a filter over the ordinary result: the ranking prefers
    // the earliest viable point and keeps only the best few, so a station a
    // little further along is crowded out by plain vertices before this line
    // could see it — and a road with several stations would report having none.
    //
    // A WIDER SHORTLIST THAN WHAT IS SHOWN, because the fuel-range filter below
    // removes some and the rider still wants a choice. It is what keeps the
    // routing bounded: every survivor costs one Routes request.
    const onlyGas = stations.length
      ? proposeGroupMeet(primary as GroupRoute, one, [...fuel, ...stations], { fuelOnly: true }, GAS_SHORTLIST)
      : []

    // A MEETING POINT SHOULD BE A GAS STATION — Ziad's call, 2026-09-03.
    // Everyone arrives needing fuel and a forecourt is somewhere you can
    // actually wait, so when the road offers one it is the answer and a bare
    // point on the highway is not offered beside it.
    //
    // AND IT HAS TO BE WITHIN A TANK OF THE LAST FILL. Ziad's call, 2026-09-03,
    // after a proposal landed just past the main group's empty marker: a meeting
    // point nobody can reach without stopping for fuel first is not a meeting
    // point, it is a second problem.
    const reach = await reachable(onlyGas, primaryGroup.uid, one, range.miles, fillBeforeM, primaryGroup, routed)

    // BOTH FALLBACKS SAY WHICH COMPROMISE WAS MADE. A stretch with no station,
    // or none within a tank, is an ordinary thing on a rural road — answering
    // "nothing works" would be false, and a rider who asked for a reachable
    // forecourt and got something else has to be told which. `note` is
    // deliberately not `reason`: reason means there are no candidates at all.
    // PAIRED HERE RATHER THAN LOOKED UP LATER. `reach.approaches` is parallel to
    // `reach.keep` and to nothing else, so pairing them at the one point where
    // that is true beats indexing into it from a list that might be a fallback.
    const rows = reach.keep.length
      ? reach.keep.map((m, i) => ({ m, path: reach.approaches[i]?.[0]?.path ?? [] }))
      : (onlyGas.length ? onlyGas : plain).map((m) => ({ m, path: [] as Track }))
    const note = reach.keep.length ? null : onlyGas.length ? 'out-of-range' : plain.length ? 'no-gas' : null

    return {
      // The group this answer is FOR, by uid, which is what the panel and the
      // map both address a group by. The name rides along so the panel can head
      // the section without a lookup that could disagree with the server's idea
      // of which group this was.
      group: g.id,
      name,
      note,
      candidates: rows.slice(0, MEET_LIMIT).map(({ m, path }) => ({
        lng: m.at[0],
        lat: m.at[1],
        // Miles, rounded, because that is the only number a planner should read.
        // `score` is deliberately not sent: it is unitless and putting one in
        // front of somebody invites them to compare two of them.
        worstDivertMi: worstDivertMi(m),
        // METERS ALONG THE MAIN GROUP'S STRAND, which is what lets the builder
        // put the point where it belongs in the order rather than at the end of
        // the list. Unrounded miles would lose the precision a leg lookup needs,
        // and this is never shown to a rider — every number they read is a mile.
        alongM: Math.round(m.alongM),
        sharedPct: Math.round(m.sharedFraction * 100),
        isFuel: m.isFuel,
        // Empty for a bare point on the road, which has neither.
        name: m.name ?? '',
        address: m.address ?? '',
        // ONE ENTRY NOW, because one group is being asked about — kept as a list
        // rather than flattened to a number so the panel renders a section the
        // same way whatever the ride looks like.
        diverts: m.diverts.map((d) => ({
          group: d.id,
          mi: Math.round((d.divertM / METERS_PER_MILE) * 10) / 10,
          onRoute: d.onRoute,
        })),
        // THE ROAD THIS GROUP WOULD ACTUALLY RIDE TO GET HERE, already fetched.
        // It was sent per candidate before and drawn from the same response; it
        // is per candidate still, and it is what makes the choice a comparison
        // rather than a list of numbers — the long way round a lake and the
        // short way down the interstate are two shapes on a map before they are
        // two figures.
        approach: path,
      })),
      reason: rows.length === 0 ? 'none-viable' : null,
    }
  }
})

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
 *
 * A FAILURE IS AN EMPTY LIST, NOT AN ERROR. The proposal is still good without
 * pumps — see the fallback at the call site — and turning a Places outage into a
 * failed meeting-point request would take away an answer that needs no network
 * at all.
 */
const SEARCH_ANCHORS = 2
const STATION_RADIUS_M = 20_000

/** The whole press's Text Search allowance, divided by the joining groups. Six
 *  is two groups at full spread, or six groups at one anchor each. */
const ANCHOR_BUDGET = 6

/** The whole press's routed-approach allowance, divided the same way. Twelve is
 *  three groups at the old per-group ceiling, and it is the number that stops a
 *  nine-group ride costing 36 Routes requests on one press. */
const ROUTED_BUDGET = 12

async function gasAlong(plain: GroupMeet[], anchors: number): Promise<FuelCandidate[]> {
  const out: FuelCandidate[] = []
  const seen = new Set<string>()
  for (const anchor of plain.slice(0, anchors)) {
    const res = await searchPlaces(
      { query: 'gas station', near: anchor.at, radiusM: STATION_RADIUS_M, wide: true },
      GMAPS_SERVER_KEY,
    )
    if (!res.ok) continue
    for (const p of res.places) {
      // TYPE, NOT NAME. Text Search answers "gas station" with supermarkets and
      // repair shops that merely mention fuel, and a meeting point the group
      // cannot fill up at is the one thing this feature must not produce.
      if (p.type !== 'gas_station') continue
      const key = p.lngLat.join(',')
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ at: p.lngLat, roles: ['gas'], name: p.name, address: p.address })
    }
  }
  // Snapping and the on-route test are proposeGroupMeet's, not repeated here —
  // a station in the next valley is dropped there by ON_ROUTE_M, with one rule
  // for both sources of fuel candidate.
  return out
}

/** How many gas candidates are shortlisted before the fuel-range filter. Larger
 *  than the three a rider is shown, because the filter removes some — and small,
 *  because every survivor costs a Routes request per joining group. */
const GAS_SHORTLIST = 6

/** The most candidates whose approaches are routed. A hard stop on the bill: a
 *  ride with four joining groups would otherwise spend 24 Routes requests on one
 *  press of a button. */
const MAX_ROUTED_CANDIDATES = 4

/** How many the rider is finally offered. */
const MEET_LIMIT = 3

type Approach = { group: string; path: Track; distanceM: number }

/**
 * Keep the candidates every group can reach on the tank they arrive with, and
 * route the approaches while finding out.
 *
 * THE TWO JOBS ARE ONE PASS ON PURPOSE. The joining group's distance to a
 * candidate is the length of the road they would ride, not a straight line — and
 * the road is the same thing the builder draws. Fetching it once here answers
 * the range question AND supplies the drawing, where doing them separately would
 * pay Google twice for one road and let the two disagree.
 *
 * The MAIN group is measured along their own route (`alongM` minus their last
 * fill), which needs no request at all: it is the road they were already riding.
 *
 * With no known range the filter does not run and every candidate is kept —
 * `groupRange()` answers null when nothing on the roster has a range on file,
 * and inventing one would produce a fuel plan that looks authoritative and is
 * made up.
 */
async function reachable(
  candidates: GroupMeet[],
  primaryUid: string,
  joining: GroupRoute[],
  rangeMi: number | null,
  fillBeforeM: (g: { id: number }, alongM: number) => number,
  primaryGroup: { id: number; uid: string },
  // The routed-approach cap for THIS group, already divided out of the press's
  // budget by the caller. It bounds the Routes spend; MEET_LIMIT bounds what a
  // rider is shown, and they are two different numbers whenever a ride has
  // enough groups for the budget to bite.
  routed: number,
): Promise<{ keep: GroupMeet[]; approaches: Approach[][] }> {
  const keep: GroupMeet[] = []
  const approaches: Approach[][] = []
  const rangeM = rangeMi == null ? null : rangeMi * METERS_PER_MILE

  for (const m of candidates) {
    if (keep.length >= MEET_LIMIT) break
    if (approaches.length >= routed) break

    // THE MAIN GROUP FIRST AND FOR FREE. Their distance is arithmetic on a road
    // that already exists, so a candidate they cannot reach is dropped before
    // anything is spent routing anybody else to it.
    if (rangeM != null && m.alongM - fillBeforeM(primaryGroup, m.alongM) > rangeM) continue

    const legs: Approach[] = []
    let allReach = true
    for (const g of joining) {
      if (g.id === primaryUid) continue
      // A group whose own road already passes through it is not detouring, so
      // there is nothing to draw and nothing to check — they reach it on the
      // same tank that carries them along their own route.
      const onRoute = m.diverts.find((d) => d.id === g.id)?.onRoute
      if (onRoute) continue
      const out = await fetchRouteLeg(g.origin, m.at)
      if (!out.ok) {
        // NO ROAD IS NOT OUT OF RANGE. A Routes failure says nothing about fuel,
        // and dropping a candidate for it would silently narrow the answer
        // whenever Google was having a bad minute. The approach simply is not
        // drawn.
        continue
      }
      legs.push({ group: g.id, path: out.leg.geometry, distanceM: out.leg.distanceM })
      // A joining group sets off with a full tank — their strand's start is
      // their last fill — so the whole approach has to fit inside one.
      if (rangeM != null && out.leg.distanceM > rangeM) {
        allReach = false
        break
      }
    }
    if (!allReach) continue
    keep.push(m)
    approaches.push(legs)
  }
  return { keep, approaches }
}
