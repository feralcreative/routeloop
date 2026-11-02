// `get_official_closures`: what Caltrans itself reports on the ride’s roads (#442):
// chain controls and the Lane Closure System, from CWWP2 (src/maps/official/caltrans.ts).
//
// FROM THE RIDE THE ASSISTANT HOLDS, NEVER A DATABASE READ, like get_conditions:
// each route's drawn legs are the line events are matched against, within
// NEAR_ROUTE_M (about a kilometer). Only the districts a route passes through are
// fetched, by the rough boxes in caltrans.ts.
//
// THE VEHICLE CHANGES WHAT A CHAIN CONTROL MEANS. Any chain requirement (R-1 and up,
// R-1 MODIFIED included) is snow or ice on the road: a motorcycle or a bicycle does
// not go, and a car follows the code. That is the rule in fresh-intel.md.
//
// EMPTY NEVER MEANS OPEN. A feed that did not answer is "unknown, last checked at …",
// never "no closures", and the answer ends, once, with the line that nothing listed
// is not proof a road is open. Caltrans covers state highways only: a national park
// road such as Tioga is the park's to report.
//
// Outside California it says so and names that state's own page, from the list in
// knowledge/fresh-intel.md; Caltrans is the only official feed wired in.
//
// Caltrans's own words (a chain description, a location name) are data and are
// quoted as such.
import { z } from 'zod'
import { activeRoutes } from '../../maps/alts'
import { trackAndSpans } from '../../maps/corridor'
import { METERS_PER_MILE, type Track } from '../../maps/kml'
import type { RoutePayload } from '../../maps/ride-graph'
import {
  CC_DISTRICTS,
  SOURCE,
  districtsAlong,
  eventsNear,
  fetchFeed,
  inCalifornia,
  pacificIso,
  pacificWall,
  type EventNear,
  type FeedResult,
  type OfficialEvent,
} from '../../maps/official/caltrans'
import { cite } from '../provenance'
import type { Units } from '../summary'
import type { Vehicle } from '../../views/vocab'
import type { AgentContext, Tool } from '../tools'
import { routeEndIso } from './conditions'

const tool = <S extends z.ZodObject>(t: Tool<S>) => t

/** How far ahead Caltrans's Lane Closure System lists planned closures. */
const LCS_HORIZON_DAYS = 7
/** The most closure groups listed per route; the rest are counted. */
export const MAX_CLOSURES_LISTED = 15
/** The most R-0 chain points named per route; the rest are counted. */
const MAX_CLEAR_NAMED = 6

// --- Outside California ---------------------------------------------------------

/** Rough boxes for the neighbors fresh-intel.md names, tested only on points
 *  already found to be outside California. Boxes overlap along borders, which only
 *  ever names a state too many. */
const STATES: { name: string; page: string; s: number; n: number; w: number; e: number }[] = [
  { name: 'Oregon', page: 'TripCheck (tripcheck.com)', s: 41.99, n: 46.3, w: -124.6, e: -116.46 },
  { name: 'Washington', page: 'WSDOT (wsdot.wa.gov)', s: 45.54, n: 49.0, w: -124.8, e: -116.9 },
  { name: 'Nevada', page: 'NVroads (nvroads.com)', s: 35.0, n: 42.0, w: -120.0, e: -114.04 },
  { name: 'Arizona', page: 'AZ511 (az511.gov)', s: 31.33, n: 37.0, w: -114.82, e: -109.04 },
  { name: 'Utah', page: 'UDOT Traffic (udottraffic.utah.gov)', s: 37.0, n: 42.0, w: -114.05, e: -109.04 },
  { name: 'Colorado', page: 'COtrip (cotrip.org)', s: 37.0, n: 41.0, w: -109.06, e: -102.04 },
]

/** The other states a track touches, by name, and whether any of it is somewhere
 *  none of the boxes covers. Pure. */
export function statesOutside(track: Track): { states: typeof STATES; unlisted: boolean } {
  const hit = new Set<(typeof STATES)[number]>()
  let unlisted = false
  for (const p of track) {
    if (inCalifornia(p)) continue
    let any = false
    for (const s of STATES)
      if (p[1] >= s.s && p[1] <= s.n && p[0] >= s.w && p[0] <= s.e) {
        hit.add(s)
        any = true
      }
    if (!any) unlisted = true
  }
  return { states: STATES.filter((s) => hit.has(s)), unlisted }
}

function elsewhereLine(track: Track): string {
  const { states, unlisted } = statesOutside(track)
  const named = states.map((s) => `${s.name}: ${s.page}`)
  if (unlisted || named.length === 0) named.push('anywhere else, that state’s own DOT road-conditions or 511 page')
  return `For the part outside California, check the official source directly: ${named.join('; ')}.`
}

// --- Words ---------------------------------------------------------------------

const dist = (m: number, u: Units) =>
  u === 'mi' ? `${(m / METERS_PER_MILE).toFixed(1)} mi` : `${(m / 1000).toFixed(1)} km`

/** `2026-11-06T21:01-08:00` as `2026-11-06 21:01 PT`. */
const pt = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} PT` : 'unknown')

const quote = (s: string) => `“${s.replace(/[“”"]/g, '’')}”`

const citeEvent = (e: OfficialEvent) =>
  cite({ kind: 'official', source: SOURCE, asOf: e.updatedAt ?? e.publishedAt ?? undefined, checkedAt: e.retrievedAt })

/** What a chain-control status means for the vehicle the ride is planned for. Pure. */
export function chainMeaning(e: OfficialEvent, vehicle: Vehicle): string {
  const c = e.chain
  if (!c) return 'status unknown.'
  const twoWheels = vehicle !== 'car'
  const noGo =
    vehicle === 'bicycle'
      ? 'snow or ice on the road: not a road to ride a bicycle on until it clears'
      : 'snow or ice on the road: a motorcycle does not go over this until it clears'
  switch (c.class) {
    case 'none':
      return 'no chain controls in effect.'
    case 'chains': {
      const what = c.modified
        ? 'chains or traction devices required on trucks and vehicles pulling trailers'
        : c.level === 3
          ? 'chains or traction devices required on all vehicles, no exceptions'
          : c.level === 2
            ? 'chains or traction devices required on all vehicles except four-wheel or all-wheel drive with snow tires on all four'
            : 'chains, traction devices, or snow tires required on the drive axle except four-wheel or all-wheel drive'
      return twoWheels ? `${what}. That means ${noGo}.` : `${what}. A car follows the code.`
    }
    case 'watch':
      return twoWheels
        ? `no restriction, but Caltrans says watch for snow on the pavement. On ${vehicle === 'bicycle' ? 'a bicycle' : 'a motorcycle'}, treat that as snow possible on the road and check again before going.`
        : 'no restriction, but Caltrans says watch for snow on the pavement.'
    case 'metering':
      return twoWheels
        ? `traffic is being metered at the chain check point, which happens in winter conditions. Treat it as ${noGo}.`
        : 'traffic is being metered at the chain check point, which happens in winter conditions.'
    case 'escort':
      return twoWheels
        ? `the CHP is escorting all traffic because of the weather. That means ${noGo}.`
        : 'the CHP is escorting all traffic because of the weather.'
    case 'hold':
      return twoWheels
        ? `all traffic is being held at the chain check point. Treat it as ${noGo}.`
        : 'all traffic is being held at the chain check point.'
    case 'trucks':
      // A chain requirement on trucks is still a chain control: the pass has snow or ice.
      return twoWheels
        ? `a chain restriction on trucks, which means winter conditions on the pass. Treat it as ${noGo}.`
        : 'a restriction on trucks only, which signals winter conditions on the pass.'
    case 'closed':
      return 'closed to traffic.'
    case 'not-reported':
      return 'condition not reported. That is unknown, not clear.'
    default:
      return `an unrecognized status (${quote(c.code.slice(0, 30))}). That is unknown, not clear.`
  }
}

/** One chain-control line. */
export function chainLine(n: EventNear, vehicle: Vehicle, units: Units): string {
  const e = n.event
  const road = [e.route, e.direction ? e.direction.toLowerCase() + 'bound' : null].filter(Boolean).join(' ')
  const desc = e.description && e.chain?.class !== 'none' ? ` Caltrans’s wording: ${quote(e.description)}.` : ''
  return `- ${e.chain?.code ?? 'Unknown'} at ${quote(e.name)}${road ? ` (${road})` : ''}, ${dist(n.alongM, units)} along: ${chainMeaning(e, vehicle)}${desc} ${citeEvent(e)}`
}

/** A closure's rows grouped: one closure, every window it is scheduled for.
 *
 *  A `closureID` IS A PROJECT, NOT A CLOSURE: on 2026-11-01 District 3's C50KB covered
 *  72 rows, the mainline both ways plus a dozen ramps, a night each. So rows are one
 *  closure when the project, the stretch, the direction, the type, and the lanes all
 *  match, and a window listed twice is shown once. */
type ClosureGroup = { first: EventNear; rows: EventNear[] }

export function groupClosures(near: EventNear[]): ClosureGroup[] {
  const by = new Map<string, ClosureGroup>()
  const seen = new Set<string>()
  for (const n of near) {
    const e = n.event
    const c = e.closure
    const key = [e.district, c?.closureId || e.id, e.name, e.direction, c?.type, c?.facility, c?.lanesClosed].join('|')
    const win = `${key}|${e.beginsWall}|${e.endsWall}|${e.indefinite}`
    if (seen.has(win)) continue
    seen.add(win)
    const g = by.get(key)
    if (g) g.rows.push(n)
    else by.set(key, { first: n, rows: [n] })
  }
  for (const g of by.values()) g.rows.sort((a, b) => (a.event.beginsWall ?? '').localeCompare(b.event.beginsWall ?? ''))
  return [...by.values()]
}

const slot = (e: OfficialEvent) =>
  `${pt(e.beginsAt)} to ${e.indefinite ? 'no set end' : pt(e.endsAt)}${e.closure?.state === 'active' ? ' (in place now)' : ''}`

/** One closure line, every scheduled window of it. */
export function closureLine(g: ClosureGroup, units: Units): string {
  const e = g.first.event
  const c = e.closure!
  const what = c.type.toLowerCase() === 'full' ? 'Full closure' : `${c.type} closure`
  const on = c.facility ? ` of the ${c.facility.toLowerCase()}` : ''
  const road = [e.route, e.direction].filter(Boolean).join(' ')
  const lanes =
    c.type.toLowerCase() === 'full'
      ? ''
      : c.lanesClosed
        ? `, lanes closed: ${c.lanesClosed} of ${c.totalLanes || '?'}`
        : ''
  const delay = /^\d+$/.test(c.delay) && c.delay !== '0' ? `, estimated delay ${c.delay} minutes` : ''
  const shown = g.rows.slice(0, 4).map((r) => slot(r.event))
  const more = g.rows.length > 4 ? `, and ${g.rows.length - 4} more window${g.rows.length === 5 ? '' : 's'}` : ''
  const why = c.work ? `, for ${c.work.toLowerCase()}` : ''
  const ref = e.nearby ? ` near ${e.nearby}` : ''
  return `- ${what}${on}${road ? `, ${road}` : ''}, ${quote(e.name)}${ref}, ${dist(g.first.alongM, units)} along${why}${lanes}${delay}. Scheduled ${shown.join('; ')}${more}. ${citeEvent(g.rows[0].event)}`
}

/** A full closure of a through road outranks a ramp or a lane, and one in place now
 *  outranks one planned. Lower is first. */
const isFull = (g: ClosureGroup) => g.first.event.closure?.type.toLowerCase() === 'full'
const isRamp = (g: ClosureGroup) =>
  /ramp|connector|rest area|surface street/i.test(g.first.event.closure?.facility ?? '')

function rank(g: ClosureGroup): number {
  const active = g.rows.some((r) => r.event.closure?.state === 'active')
  return (isFull(g) && !isRamp(g) ? 0 : 2) + (active ? 0 : 1)
}

// --- Dates -------------------------------------------------------------------

/** The route's day or days as a wall-clock window, `YYYY-MM-DDT00:00` to
 *  `YYYY-MM-DDT23:59`, or null when undated. A route's `start_at` is a wall clock at
 *  the departure point carried as UTC, so it is read back in UTC. */
export function routeDays(route: RoutePayload): { from: string; to: string } | null {
  if (!route.startAt) return null
  const end = routeEndIso(route) ?? route.startAt
  return { from: `${route.startAt.slice(0, 10)}T00:00`, to: `${end.slice(0, 10)}T23:59` }
}

/** Whether a closure row overlaps a wall-clock window. */
const overlaps = (e: OfficialEvent, from: string, to: string) =>
  (e.beginsWall ?? '') <= to && (e.indefinite || e.endsWall == null || e.endsWall >= from)

// --- The tool ------------------------------------------------------------------

type Feeds = Map<string, FeedResult>
const key = (kind: 'cc' | 'lcs', d: number) => `${kind}${d}`

/** One route's section of the answer. */
export function routeSection(
  route: RoutePayload,
  label: string,
  feeds: Feeds,
  vehicle: Vehicle,
  units: Units,
  now: Date,
): string[] {
  const { track } = trackAndSpans(route.legs)
  const out: string[] = [`${label}:`]
  if (track.length < 2) {
    out.push('No road is drawn yet, so nothing can be matched against it.')
    return out
  }
  const districts = districtsAlong(track)
  if (districts.length === 0) {
    out.push(
      'This route does not enter California. The only official road feed wired into Routeloop is Caltrans (California), so nothing official could be checked here.',
    )
    out.push(elsewhereLine(track))
    return out
  }
  const outside = track.some((p) => !inCalifornia(p))
  out.push(`Caltrans districts read: ${districts.join(', ')}.`)
  // A leg the router never drew is a straight line, not the road: anything on the
  // real road there cannot be matched, so the answer for this route is partial.
  const undrawn = route.legs.filter((l) => l.durationS <= 0 && l.distanceM > 0).length
  if (undrawn)
    out.push(
      `INCOMPLETE: ${undrawn} leg${undrawn === 1 ? ' is' : 's are'} not drawn yet (a straight line, not the road), so nothing official on the real road there could be matched. Draw ${undrawn === 1 ? 'it' : 'them'} and ask again.`,
    )

  const nowWall = pacificWall(now.getTime())
  const days = routeDays(route)
  const failed: FeedResult[] = []

  // Chain controls: the conditions now.
  const cc: OfficialEvent[] = []
  for (const d of districts) {
    if (!CC_DISTRICTS.includes(d)) continue
    const f = feeds.get(key('cc', d))
    if (!f) continue
    if (f.ok) cc.push(...f.events)
    else failed.push(f)
  }
  const ccNear = eventsNear(cc, track)
  const restricted = ccNear.filter((n) => n.event.chain?.class !== 'none')
  const clear = ccNear.filter((n) => n.event.chain?.class === 'none')
  const ccDistricts = districts.filter((d) => CC_DISTRICTS.includes(d))
  if (ccDistricts.length) {
    const today = nowWall.slice(0, 10)
    const when =
      days && days.from.slice(0, 10) !== today
        ? ` These are the conditions now (${pt(pacificIso(now.getTime()))}), not a forecast for this route’s date, ${days.from.slice(0, 10)}.`
        : ''
    out.push(`Chain controls on this route’s line:${when}`)
    for (const n of restricted) out.push(chainLine(n, vehicle, units))
    if (clear.length) {
      // One name per place: a chain point is listed once per direction, and often twice.
      const names = [
        ...new Set(clear.map((n) => `${quote(n.event.name)}${n.event.route ? ` (${n.event.route})` : ''}`)),
      ]
      const rest = names.length > MAX_CLEAR_NAMED ? `, and ${names.length - MAX_CLEAR_NAMED} more places` : ''
      const newest = clear
        .map((n) => n.event.retrievedAt)
        .sort()
        .pop()
      out.push(
        `- No chain controls in effect (R-0) at ${clear.length} point${clear.length === 1 ? '' : 's'}: ${names.slice(0, MAX_CLEAR_NAMED).join(', ')}${rest}. ${cite({ kind: 'official', source: SOURCE, checkedAt: newest })}`,
      )
    }
    // An empty answer is only "nothing on this line" when every feed answered.
    const ccFailed = failed.some((f) => f.kind === 'cc')
    if (ccNear.length === 0)
      out.push(
        ccFailed
          ? '- Nothing could be read for at least one district; see UNKNOWN below.'
          : '- No chain-control point sits on this route’s line.',
      )
    else if (ccFailed) out.push('- At least one district could not be read; see UNKNOWN below.')
  }
  const noCc = districts.filter((d) => !CC_DISTRICTS.includes(d))
  if (noCc.length)
    out.push(
      `Caltrans publishes no chain-control feed for district${noCc.length === 1 ? '' : 's'} ${noCc.join(', ')}, so chain controls there were not checked.`,
    )

  // Lane closures: what is in place now and planned for about a week.
  const lcs: OfficialEvent[] = []
  for (const d of districts) {
    const f = feeds.get(key('lcs', d))
    if (!f) continue
    if (f.ok) lcs.push(...f.events)
    else failed.push(f)
  }
  const live = lcs.filter((e) => e.closure && e.closure.state !== 'ended' && e.closure.state !== 'canceled')
  const notOver = live.filter((e) => e.indefinite || e.endsWall == null || e.endsWall >= nowWall)
  const lcsNear = eventsNear(notOver, track)
  const horizon = pacificWall(now.getTime() + LCS_HORIZON_DAYS * 86_400_000)
  let shown = lcsNear
  let outsideDates = 0
  let scope: string
  if (days) {
    shown = lcsNear.filter((n) => overlaps(n.event, days.from, days.to))
    outsideDates = groupClosures(lcsNear).length - groupClosures(shown).length
    const span =
      days.from.slice(0, 10) === days.to.slice(0, 10)
        ? days.from.slice(0, 10)
        : `${days.from.slice(0, 10)} to ${days.to.slice(0, 10)}`
    scope =
      days.to < nowWall
        ? `This route’s date, ${span}, has passed; these are closures listed now.`
        : days.from > horizon
          ? `This route is dated ${span}, beyond the roughly ${LCS_HORIZON_DAYS} days Caltrans lists closures ahead, so nothing for that date is published yet. Check again within a week of the ride.`
          : `Closures scheduled on this route’s date, ${span} (Pacific time):`
    if (days.to < nowWall) shown = lcsNear
  } else {
    scope = `This route has no date, so these are every closure in place now or scheduled in the next ${LCS_HORIZON_DAYS} days:`
  }
  out.push(`Lane and road closures on this route’s line. ${scope}`)
  const groups = groupClosures(shown)
  // A lane shut on a ramp is a matter for somebody using that ramp, and a stretch of
  // freeway can carry a dozen of them a night: counted, not listed. A FULL ramp
  // closure is still listed, since it can take away the rider's exit.
  const rampLanes = groups.filter((g) => isRamp(g) && !isFull(g))
  const candidates = groups.filter((g) => !(isRamp(g) && !isFull(g)))
  const listed = [...candidates].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_CLOSURES_LISTED)
  listed.sort((a, b) => a.first.alongM - b.first.alongM)
  for (const g of listed) out.push(closureLine(g, units))
  if (candidates.length > listed.length)
    out.push(`- And ${candidates.length - listed.length} more closures on this line not listed.`)
  if (rampLanes.length)
    out.push(
      `- And ${rampLanes.length} lane closure${rampLanes.length === 1 ? '' : 's'} on ramps or connectors along this line, not listed: one lane of a ramp, not the road.`,
    )
  const lcsFailed = failed.some((f) => f.kind === 'lcs')
  if (lcsFailed) out.push('- At least one district’s closures could not be read; see UNKNOWN below.')
  else if (groups.length === 0 && !(days && days.from > horizon)) out.push('- None listed on this route’s line.')
  if (outsideDates > 0)
    out.push(
      `- ${outsideDates} more closure${outsideDates === 1 ? '' : 's'} on this line fall outside this route’s date.`,
    )

  const unplaced = [...cc, ...live].filter((e) => !e.location)
  const unplacedOnRoads = unplaced.length
  if (unplacedOnRoads > 0)
    out.push(
      `${unplacedOnRoads} Caltrans item${unplacedOnRoads === 1 ? '' : 's'} in these districts had no coordinates and could not be matched to the route.`,
    )

  for (const f of failed) out.push(unknownLine(f))
  if (outside) out.push(`Part of this route is outside California. ${elsewhereLine(track)}`)
  return out
}

/** A feed that did not answer, said as unknown. */
export function unknownLine(f: FeedResult): string {
  if (f.ok) return ''
  const what = f.kind === 'cc' ? 'Chain controls' : 'Lane closures'
  const last = f.lastOkAt
    ? `last checked successfully at ${pt(f.lastOkAt)}`
    : 'not read successfully since this server started'
  return `UNKNOWN: ${what} for Caltrans District ${f.district} could not be read (${f.error}, tried ${pt(f.triedAt)}); ${last}. That is unknown, not “no closures”.`
}

export async function officialClosuresFor(ctx: AgentContext, routeUid?: string, now = new Date()): Promise<string> {
  let routes: { route: RoutePayload; i: number }[]
  if (routeUid) {
    const i = ctx.ride.routes.findIndex((r) => r.uid === routeUid)
    if (i < 0) return `No route with uid ${routeUid}.`
    routes = [{ route: ctx.ride.routes[i], i }]
  } else {
    const active = new Set(activeRoutes(ctx.ride.routes))
    routes = ctx.ride.routes.map((route, i) => ({ route, i })).filter((r) => active.has(r.route))
  }
  const vehicle: Vehicle = ctx.preset?.vehicle ?? 'motorcycle'

  const needed = new Set<string>()
  for (const { route } of routes) {
    for (const d of districtsAlong(trackAndSpans(route.legs).track)) {
      needed.add(key('lcs', d))
      if (CC_DISTRICTS.includes(d)) needed.add(key('cc', d))
    }
  }
  const feeds: Feeds = new Map()
  if (needed.size) {
    ctx.progress('Checking Caltrans')
    const list = [...needed]
    const results = await Promise.all(
      list.map((k) => fetchFeed(k.startsWith('cc') ? 'cc' : 'lcs', Number(k.replace(/^\D+/, '')), () => now.getTime())),
    )
    list.forEach((k, j) => feeds.set(k, results[j]))
  }

  const draft = ctx.snapshot.kind === 'draft' ? ' (the builder’s open copy, unsaved edits included)' : ''
  const out: string[] = [
    `Official road data from Caltrans (CWWP2) for the ride as you hold it${draft}, planned for a ${vehicle}. Matched within about a kilometer of each route’s drawn line. Times are Pacific.`,
  ]
  for (const { route, i } of routes) {
    out.push('')
    out.push(
      ...routeSection(
        route,
        `Route ${i + 1} [${route.uid}] ${quote(route.title || 'Untitled')}`,
        feeds,
        vehicle,
        ctx.units,
        now,
      ),
    )
  }
  out.push('')
  out.push(
    'None of this proves a road is open: Caltrans lists what it has reported, and a road with nothing listed can still be closed, icy, or blocked. Caltrans covers state highways only; a national park road (Tioga in Yosemite) or a forest road is reported by the park or the forest.',
  )
  return out.join('\n')
}

export const getOfficialClosures = tool({
  name: 'get_official_closures',
  cap: { mutates: false, network: true, needs: 'view' },
  description:
    'Read official California road data from Caltrans along the ride’s drawn roads: chain controls (R-1, R-2, R-3, and the rest, with what each means for the ride’s vehicle) and lane or full road closures in place now or scheduled within about a week, each with its source and time. Chain controls are current conditions, not a forecast. Outside California it names the state’s own road page instead. An UNKNOWN answer is not a clear one, and nothing listed never proves a road open: say both to the rider. Optionally narrow to one route.',
  schema: z.object({ route_uid: z.string().min(1).max(12).optional() }).strict(),
  run: async (ctx, input) => officialClosuresFor(ctx, input.route_uid),
})
