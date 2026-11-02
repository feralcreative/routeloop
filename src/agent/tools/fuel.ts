// The fuel plan and the riders' context, as numbers the model can act on: what the
// map's ring, E markers and red stretch show, which the model cannot see (#439).
//
// Computed from the ride in ctx (the builder's draft or the MCP's saved copy) with
// src/maps/fuel.ts, the server port pinned against the browser files, and the
// group's tank from ctx.fuel (src/agent/fuel-context.ts). Nothing here reads the
// database or spends a call.
import { z } from 'zod'
import { briefText } from './brief'
import { carriesM, cumulativeM, routeFuelPlan, type FuelRoute } from '../../maps/fuel'
import { describePrefs } from '../../maps/route-prefs'
import { cite } from '../provenance'
import { dist, quoted, type Units } from '../summary'
import type { AgentContext, Tool } from '../tools'

const tool = <S extends z.ZodObject>(t: Tool<S>) => t
const uid = z.string().min(1).max(12)

const counts = (r: { altGroup?: number | null; altActive?: boolean }) => !(r.altGroup != null && !r.altActive)

/** "between [a] "Gilroy" and [b] "Hollister"" for a distance along a route. */
function whereOnRoute(route: AgentContext['ride']['routes'][number], m: number): string {
  const cum = cumulativeM(route as FuelRoute)
  let i = 0
  while (i + 1 < cum.length && cum[i + 1] < m) i++
  const a = route.points[i]
  const b = route.points[i + 1]
  const name = (p: typeof a) => `[${p.uid}] ${quoted(p.name, 'Unnamed')}`
  if (!b || cum[i] === m) return `at ${name(a)}`
  return `between ${name(a)} and ${name(b)}`
}

/** One route's plan as lines. Exported for check_ride. */
export function fuelLines(ctx: AgentContext, r: number, carries: number[]): string[] {
  const u: Units = ctx.units
  const route = ctx.ride.routes[r]
  const fuel = ctx.fuel!
  const plan = routeFuelPlan(route as FuelRoute, fuel.role, fuel.rangeM, carries[r])
  const out = [`Route ${r + 1} [${route.uid}] ${quoted(route.title, 'Untitled')}:`]
  if (!counts(route)) {
    out.push('  an alternate that is not chosen; it carries no tank and nobody rides it')
    return out
  }
  out.push(
    plan.carryM > 0
      ? `  starts ${dist(plan.carryM, u)} into the tank, carried from the route before`
      : '  starts on a full tank',
  )
  if (!plan.wallsM.length) out.push('  no E markers: the tank covers it as planned')
  for (const w of plan.wallsM) out.push(`  E marker (runs dry) at ${dist(w, u)}, ${whereOnRoute(route, w)}`)
  const g = plan.gaps[0]
  if (g && g.lengthM > 0)
    out.push(`  longest stretch between fills: ${dist(g.lengthM, u)}, from ${dist(g.fromM, u)} to ${dist(g.toM, u)}`)
  for (const i of plan.unreachable)
    out.push(
      `  the fill at [${route.points[i].uid}] ${quoted(route.points[i].name, 'Unnamed')} is past the first E: it is only reachable if a stop is added before it`,
    )
  return out
}

export const getFuelPlan = tool({
  name: 'get_fuel_plan',
  cap: { mutates: false, needs: 'view' },
  description:
    'The fuel plan the map draws, in numbers: the group’s binding range and whose bike sets it, and for each route the tank it starts on (carried from the route before unless it starts at a pump), every E marker where the tank runs dry and where it falls, the longest stretch between fills, and any fill that is past the first E. Give a route_uid for one route, or none for the whole ride.',
  schema: z.object({ route_uid: uid.optional() }).strict(),
  run: async (ctx, input) => {
    const fuel = ctx.fuel
    if (!fuel) return 'The fuel plan is not available here.'
    if (!fuel.role)
      return 'This ride is planned on pedal power: there is no fuel to plan. Plan water and food stops instead.'
    if (fuel.rangeM == null)
      return 'Nobody on this ride has a fuel range on file, so there is no fuel check and the map draws no E markers. Silence is not a clean bill: ask the riders for their bikes’ ranges, or have them add their bikes in the Paddock and pick them on the Riders tab.'
    const carries = carriesM(ctx.ride.routes as FuelRoute[], fuel.role, fuel.rangeM, counts)
    const head = [
      `Binding range: ${dist(fuel.rangeM, ctx.units)}${fuel.bindingBike ? ` (the ${fuel.bindingBike})` : ''}, refueling at ${fuel.role === 'charge' ? 'chargers (the charge category)' : 'gas stations (the gas category)'}. ${cite({ kind: 'computed', source: 'Routeloop' })}`,
    ]
    if (fuel.unknown > 0)
      head.push(
        `${fuel.unknown} of ${fuel.riders} riders have no range on file, so the real limit may be shorter than this.`,
      )
    const which = input.route_uid ? ctx.ride.routes.findIndex((r) => r.uid === input.route_uid) : -1
    if (input.route_uid && which < 0) return `No route with uid ${input.route_uid}.`
    const routes = which >= 0 ? [which] : ctx.ride.routes.map((_, i) => i)
    return [...head, ...routes.flatMap((r) => fuelLines(ctx, r, carries))].join('\n')
  },
})

export const getRiderContext = tool({
  name: 'get_rider_context',
  cap: { mutates: false, needs: 'view' },
  description:
    'Who this ride is planned for, without naming anyone: the vehicle and power, the binding fuel range and bike, how many riders are coming and how many have no range on file, the ride’s groups and which routes each rides, the stop-by time, each route’s routing preferences, the units, the rider’s favored and avoided brands, and the trip brief (how these riders like to ride, as the planners told it). Read this before advising on pacing, fuel, or where to stop.',
  schema: z.object({}).strict(),
  run: async (ctx) => {
    const lines: string[] = []
    const p = ctx.preset
    if (p) lines.push(`Planned for a ${p.vehicle} on ${p.power}.`)
    const f = ctx.fuel
    if (f) {
      lines.push(
        f.rangeM != null
          ? `Binding fuel range: ${dist(f.rangeM, ctx.units)}${f.bindingBike ? ` (the ${f.bindingBike})` : ''}.`
          : 'No fuel range on file for anyone on the ride.',
      )
      lines.push(`Riders coming: ${f.riders}${f.unknown ? `, ${f.unknown} with no range on file` : ''}.`)
    }
    const groups = ctx.ride.subgroups
    if (groups.length > 1)
      for (const g of groups) {
        const theirs = ctx.ride.routes.flatMap((r, i) => (r.subgroupUid === g.uid ? [i + 1] : []))
        lines.push(
          `Group ${quoted(g.name)}: ${theirs.length ? `rides route${theirs.length > 1 ? 's' : ''} ${theirs.join(', ')}` : 'rides only the shared routes'}.`,
        )
      }
    if (ctx.ride.stopByMin != null) {
      const m = ctx.ride.stopByMin
      lines.push(
        `Stop-by time: ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} local.`,
      )
    } else lines.push('No stop-by time is set for the ride.')
    ctx.ride.routes.forEach((r, i) => {
      const prefs = describePrefs(r.routePrefs)
      if (prefs) lines.push(`Route ${i + 1}: ${prefs}.`)
    })
    lines.push(`Units: ${ctx.units === 'km' ? 'kilometers' : 'miles'}.`)
    if (ctx.favor.length) lines.push(`Favored brands: ${ctx.favor.join(', ')}.`)
    if (ctx.avoid.length) lines.push(`Avoided brands: ${ctx.avoid.join(', ')}.`)
    lines.push(briefText(ctx))
    return lines.join('\n')
  },
})
