// The readiness auditor's rules (#454): every check check_ride runs, in one list.
//
// THE MODEL EXPLAINS AND FIXES; THE CODE FINDS. A check run in code is the same every
// time and does not depend on which model the rider brought, where the prose
// checklist in ready-to-ride.md left the model to walk a ride by hand and miss things.
//
// TWO VERDICTS, NEVER ONE "READY". Route checks are things the ride's own data can
// prove. Trip checks are things only the riders can confirm (bikes prepped, beds
// booked, the ride on every phone): they are asked, never assumed.
//
// THE REGISTRY IS THE SYNC POINT. Every warning the map draws has an entry here with
// `mapSymbol` saying what the rider sees. test/agent-checks.test.ts holds that every
// entry is explained in ready-to-ride.md and that the map warnings it lists are
// covered. It cannot see a warning added to the map later: whoever adds one adds it
// to that list and here in the same change, which AGENTS.md says.
//
// PURE: it reads the ride in the context and the resolved fuel context, and nothing
// else. Weather and road reports have their own tools, which spend calls; check_ride
// says when it has not looked at them.
import { carriesM, routeFuelPlan, type FuelRoute } from '../maps/fuel'
import { arrivalsS, dist, FALLBACK_MPS, hhmm, quoted } from './summary'
import type { AgentContext } from './tools'
import { isEmptyBrief } from '../briefs/policy'

export type Severity = 'strands' | 'timing' | 'group' | 'polish'
export const SEVERITY_ORDER: Severity[] = ['strands', 'timing', 'group', 'polish']

export type Check = {
  id: string
  severity: Severity
  /** What the rider sees on the map or panel, or null when the map draws nothing. */
  mapSymbol: string | null
  /** One line the model can repeat. */
  title: string
}

export const CHECKS = [
  {
    id: 'fuel-dry',
    severity: 'strands',
    mapSymbol: 'a red disc with a white E, the road red with white dashes after it, and the row flagged out of range',
    title: 'The tank runs dry before the next fill',
  },
  {
    id: 'fuel-unreachable-stop',
    severity: 'strands',
    mapSymbol: 'an E marker before a gas stop the rider planned',
    title: 'A planned fuel stop is past where the tank runs dry',
  },
  {
    id: 'fuel-unknown',
    severity: 'strands',
    mapSymbol: null,
    title: 'Nobody has a fuel range on file, so nothing checks fuel',
  },
  {
    id: 'leg-undrawn',
    severity: 'strands',
    mapSymbol: 'a straight line instead of a road',
    title: 'A leg the router never drew',
  },
  {
    id: 'route-empty',
    severity: 'strands',
    mapSymbol: null,
    title: 'A route with nothing to ride',
  },
  {
    id: 'no-departure',
    severity: 'timing',
    mapSymbol: 'no timeline on that route',
    title: 'A route with no departure time',
  },
  {
    id: 'after-stop-by',
    severity: 'timing',
    mapSymbol: 'the amber stop-by band in the route list, and the bed marker on the map',
    title: 'The route runs past the group’s stop-by time',
  },
  {
    id: 'past-midnight',
    severity: 'timing',
    mapSymbol: null,
    title: 'The route arrives after midnight',
  },
  {
    id: 'long-day',
    severity: 'timing',
    mapSymbol: null,
    title: 'A long day in the saddle',
  },
  {
    id: 'no-brief',
    severity: 'polish',
    mapSymbol: null,
    title: 'Nobody has said how these riders like to ride',
  },
  {
    id: 'alternates',
    severity: 'group',
    mapSymbol: 'a dimmed, dashed route',
    title: 'Alternates are in play',
  },
] as const satisfies readonly Check[]

export type CheckId = (typeof CHECKS)[number]['id']

export type Finding = { check: CheckId; route: number | null; detail: string; fix: string }

/** Riding hours a day past which a day is long, by vehicle. Rules of thumb from the
 *  pacing guide (src/agent/knowledge/pacing.md), labeled as such where printed. */
export const LONG_DAY_HOURS: Record<string, number> = { motorcycle: 8, car: 10, bicycle: 6 }

const counts = (r: { altGroup?: number | null; altActive?: boolean }) => !(r.altGroup != null && !r.altActive)
const name = (p: { uid: string | null; name: string | null }) => `[${p.uid}] ${quoted(p.name, 'Unnamed')}`

export function runChecks(ctx: AgentContext): Finding[] {
  const out: Finding[] = []
  const u = ctx.units
  const routes = ctx.ride.routes
  const fuel = ctx.fuel
  const carries =
    fuel?.role && fuel.rangeM != null ? carriesM(routes as FuelRoute[], fuel.role, fuel.rangeM, counts) : null

  if (!fuel)
    out.push({
      check: 'fuel-unknown',
      route: null,
      detail: 'Fuel was not checked: this surface has no fuel range to check against.',
      fix: 'Ask for the shortest tank’s range before saying the fuel is covered.',
    })
  else if (fuel.role && fuel.rangeM == null)
    out.push({
      check: 'fuel-unknown',
      route: null,
      detail: 'No rider on this ride has a bike with a fuel range on file, so the map draws no fuel warnings at all.',
      fix: 'Ask for the shortest tank’s range, or have each rider add their bike in the Paddock (My Account) and pick it on the Riders tab.',
    })

  routes.forEach((route, r) => {
    if (!counts(route)) return
    if (route.points.length < 2) {
      out.push({
        check: 'route-empty',
        route: r,
        detail: `Route ${r + 1} has ${route.points.length} point${route.points.length === 1 ? '' : 's'}.`,
        fix: 'Add where it goes, or remove the route in the builder.',
      })
    }
    const undrawn = route.legs.flatMap((l, i) => (l.durationS <= 0 && l.distanceM > 0 ? [i] : []))
    for (const i of undrawn)
      out.push({
        check: 'leg-undrawn',
        route: r,
        detail: `The leg from ${name(route.points[i])} to ${name(route.points[i + 1])} is a straight line; every distance and time after it is a guess.`,
        fix: 'Ask the rider to drag either point slightly in the builder so it routes; if it stays straight the point is off-road, so replace it with a searched place on a road.',
      })

    if (carries && fuel?.role && fuel.rangeM != null) {
      const plan = routeFuelPlan(route as FuelRoute, fuel.role, fuel.rangeM, carries[r])
      for (const w of plan.wallsM)
        out.push({
          check: 'fuel-dry',
          route: r,
          detail: `Route ${r + 1}: the tank runs dry at ${dist(w, u)}${carries[r] > 0 ? `, having started ${dist(carries[r], u)} into it` : ''}.`,
          fix: `Add a ${fuel.role} stop before ${dist(w, u)} (get_fuel_plan says between which points; find_along_route or search_places finds one).`,
        })
      for (const i of plan.unreachable)
        out.push({
          check: 'fuel-unreachable-stop',
          route: r,
          detail: `Route ${r + 1}: ${name(route.points[i])} is past where the tank first runs dry.`,
          fix: 'Add a fill before the first E marker, or move this stop earlier.',
        })
    }

    // RIDING HOURS NEED NO CLOCK, and an undrawn leg counts at the builder's own
    // fallback speed, so neither an undated nor a half-drawn route escapes this.
    const ridingS = route.legs.reduce(
      (n, l) => n + (l.durationS > 0 ? l.durationS : l.distanceM > 0 ? l.distanceM / FALLBACK_MPS : 0),
      0,
    )
    // THE BRIEF OUTRANKS THE RULE OF THUMB: what these riders said they like is the
    // limit, and the per-vehicle figure is only for a ride nobody has described.
    const brief = ctx.brief
    const vehicle = ctx.preset?.vehicle ?? 'motorcycle'
    const limit = brief?.hoursPerDay ?? LONG_DAY_HOURS[vehicle] ?? 8
    const routeM = route.legs.reduce((n, l) => n + l.distanceM, 0)
    if (ridingS / 3600 > limit)
      out.push({
        check: 'long-day',
        route: r,
        detail: brief?.hoursPerDay
          ? `Route ${r + 1} is about ${(ridingS / 3600).toFixed(1)} hours of riding, past the ${limit} hours a day the trip brief says these riders like.`
          : `Route ${r + 1} is about ${(ridingS / 3600).toFixed(1)} hours of riding, past the ${limit}-hour rule of thumb for a ${vehicle}.`,
        fix: brief?.hoursPerDay
          ? 'Split it, end the day sooner, or confirm with the rider that this one day is meant to be long.'
          : 'Ask how long a day this group actually likes (and record it with set_trip_brief); split it if that is shorter.',
      })
    else if (brief?.dayM != null && routeM > brief.dayM)
      out.push({
        check: 'long-day',
        route: r,
        detail: `Route ${r + 1} is ${dist(routeM, u)}, past the longest day in the trip brief (${dist(brief.dayM, u)}).`,
        fix: 'Split it, end the day sooner, or confirm with the rider that this one day is meant to be long.',
      })

    if (!route.startAt) {
      out.push({
        check: 'no-departure',
        route: r,
        detail: `Route ${r + 1} has no departure time, so nothing about it can be checked against the clock.`,
        fix: 'Ask when they plan to leave (kickstands up) and set it with set_departure.',
      })
      return
    }
    const { s, est } = arrivalsS(route)
    const last = route.points.length - 1
    if (last < 1) return
    const departMin = new Date(route.startAt).getUTCHours() * 60 + new Date(route.startAt).getUTCMinutes()
    const arriveMin = departMin + Math.round(s[last] / 60)
    // The map's stop-by band counts the dwell at the last point too (routeElapsedS).
    const doneMin = arriveMin + (route.points[last].durationMin ?? 0)
    const guess = est[last] ? ' (estimated: a leg is undrawn)' : ''
    if (arriveMin >= 24 * 60)
      out.push({
        check: 'past-midnight',
        route: r,
        detail: `Route ${r + 1} arrives after midnight${guess}.`,
        fix: 'Split the route at a stop for the night, or leave earlier.',
      })
    else if (ctx.ride.stopByMin != null && doneMin > ctx.ride.stopByMin)
      out.push({
        check: 'after-stop-by',
        route: r,
        detail: `Route ${r + 1} arrives at ${hhmm(arriveMin)}${doneMin > arriveMin ? ` and is done at ${hhmm(doneMin)}` : ''}${guess}, after the group’s stop-by time of ${hhmm(ctx.ride.stopByMin)}.`,
        fix: 'Leave earlier, shorten the stops, end the day sooner, or split the route.',
      })
  })

  // Only where a brief can be kept (a saved ride) and nobody has written one.
  if (ctx.brief && isEmptyBrief(ctx.brief))
    out.push({
      check: 'no-brief',
      route: null,
      detail: 'There is no trip brief, so the days are judged against rules of thumb rather than what these riders like.',
      fix: 'Ask, in one short question, how long a day they like, how fast, and whether gravel or freeways are fine; record it with set_trip_brief.',
    })

  const alts = new Set(routes.flatMap((r) => (r.altGroup != null ? [r.altGroup] : [])))
  if (alts.size)
    out.push({
      check: 'alternates',
      route: null,
      detail: `${alts.size} set${alts.size === 1 ? '' : 's'} of alternates; only the active one in each is checked here.`,
      fix: 'Confirm with the rider that the active alternate is the one the group means to ride; votes are on the ride page.',
    })

  const rank = (f: Finding) => SEVERITY_ORDER.indexOf(CHECKS.find((c) => c.id === f.check)!.severity)
  return out.sort((a, b) => rank(a) - rank(b))
}

/** What only the riders can confirm. Asked, never assumed. */
export function tripQuestions(ctx: AgentContext): string[] {
  const beds = ctx.ride.routes
    .filter(counts)
    .flatMap((r) =>
      r.points
        .filter((p) => p.roles.includes('hotel') || p.roles.includes('camp'))
        .map((p) => quoted(p.name, 'Unnamed')),
    )
  const q = [
    'Every bike prepped: tires, chain, brake pads, and oil good for the miles; no new modifications right before the trip.',
    'The ride kept on every rider’s phone (Keep on the ride page) before any stretch with no signal.',
    'Every rider invited, not left as a draft, and everyone has said whether they are coming.',
    'Emergency contacts traded, and papers (license, registration, insurance; a passport for Mexico or Canada) on everyone.',
  ]
  if (beds.length) q.splice(1, 0, `Beds booked: ${[...new Set(beds)].join(', ')}.`)

  return q
}
