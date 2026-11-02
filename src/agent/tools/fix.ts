// The first two fix tools (#459): a route's routing preferences and the ride's
// stop-by time. What the auditor finds and the assistant could until now only
// describe.
//
// PREFERENCES RE-ROUTE THE WHOLE ROUTE OR NOTHING. A preference changes the road,
// so every leg is redrawn, and a route only partly redrawn would be a proposal
// whose map shows the new preference on half its roads. So a route longer than one
// call may route is refused before anything changes, and a redraw the router could
// not finish is refused and rolled back by runTool (an EditError thrown here).
//
// That refusal is settle()'s rule in tools.ts, reproduced here rather than imported:
// settle() is not exported, and moving it into ride-edit.ts would put the router into
// the module whose whole point is that it never touches the network.
import { z } from 'zod'
import { describePrefs, normalizePrefs, prefsKey, type RoutePrefs } from '../../maps/route-prefs'
import { TURN_LIMITS } from '../policy'
import { routeStale } from '../legs'
import { EditError, routeIndex, setRoutePrefs, setStopBy, type Stale } from '../ride-edit'
import { hhmm } from '../summary'
import type { AgentContext, Tool } from '../tools'

const tool = <S extends z.ZodObject>(t: Tool<S>) => t

const uid = z.string().min(1).max(12)

/** The most legs one set_route_preferences may redraw: the builder assistant's whole
 *  routing allowance for a turn, so a route it accepts is one a turn can finish. */
export const MAX_PREF_LEGS = TURN_LIMITS.legRoutings

/** Draw every leg an edit marked, or refuse the edit so runTool rolls it back. */
async function redraw(ctx: AgentContext, stale: Stale[]): Promise<void> {
  if (stale.length === 0) return
  ctx.progress('Drawing the road')
  const { skipped, failed } = await routeStale(ctx.ride, stale, ctx.budget)
  if (skipped > 0)
    throw new EditError(
      'that change was not made: the road could not be redrawn because the routing budget for this turn or today is spent',
    )
  if (failed > 0)
    throw new EditError('that change was not made: the router could not redraw the road just now; try again')
}

const FLAG_INPUTS = {
  avoid_tolls: 'avoidTolls',
  avoid_highways: 'avoidHighways',
  avoid_ferries: 'avoidFerries',
  prefer_twisty: 'preferTwisty',
} as const

export const setRoutePreferences = tool({
  name: 'set_route_preferences',
  cap: { mutates: true, destructive: true, needs: 'edit', spends: { leg: MAX_PREF_LEGS } },
  description: `Set what one route asks of the router: avoid tolls, avoid highways, avoid ferries, or prefer the twistier road. A flag you leave out keeps its current value; false turns it off. Changing a preference redraws EVERY leg of the route, so a route of more than ${MAX_PREF_LEGS} legs is refused: ask the rider to set it in the builder instead. There is no "scenic" or "unpaved" option; the router cannot express them.`,
  schema: z
    .object({
      route_uid: uid,
      avoid_tolls: z.boolean().optional(),
      avoid_highways: z.boolean().optional(),
      avoid_ferries: z.boolean().optional(),
      prefer_twisty: z.boolean().optional(),
    })
    .strict(),
  run: async (ctx, input) => {
    const r = routeIndex(ctx.ride, input.route_uid)
    const route = ctx.ride.routes[r]
    const label = route.title ? `“${route.title}”` : `route ${r + 1}`

    const merged: RoutePrefs = { ...(route.routePrefs ?? {}) }
    for (const [key, flag] of Object.entries(FLAG_INPUTS) as [keyof typeof FLAG_INPUTS, keyof RoutePrefs][]) {
      const v = input[key]
      if (v !== undefined) merged[flag] = v
    }
    const next = normalizePrefs(merged)
    if (prefsKey(next) === prefsKey(route.routePrefs))
      return `${label} already has those preferences (${describePrefs(next) || 'none set'}); nothing changed.`

    // REFUSED BEFORE ANYTHING CHANGES, never redrawn in part.
    const legs = route.legs.length
    if (legs > MAX_PREF_LEGS)
      throw new EditError(
        `${label} has ${legs} legs, more than the ${MAX_PREF_LEGS} one change may redraw; ask the rider to set the preference on that route in the builder, which redraws it there`,
      )

    const stale = setRoutePrefs(ctx.ride, input.route_uid, next)
    ctx.changed = true
    ctx.progress(`Re-routing ${label}`)
    await redraw(ctx, stale)
    const now = describePrefs(next) || 'No routing preferences'
    return `${now} on ${label}${legs ? `; redrew all ${legs} leg${legs === 1 ? '' : 's'}` : ''}.`
  },
})

export const setStopByTime = tool({
  name: 'set_stop_by_time',
  cap: { mutates: true, destructive: true, needs: 'edit' },
  description:
    'Set the ride’s stop-by time: when the group wants to be looking for a bed each day, as a 24-hour local wall-clock time where the ride is, formatted HH:MM (e.g. 16:00). Never convert time zones. null clears it.',
  schema: z
    .object({
      local_time: z
        .string()
        .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'must be a 24-hour local time like 16:00')
        .nullable(),
    })
    .strict(),
  run: async (ctx, input) => {
    const before = ctx.ride.stopByMin
    setStopBy(ctx.ride, input.local_time)
    if (ctx.ride.stopByMin === before)
      return before == null
        ? 'No stop-by time was set; nothing changed.'
        : `The stop-by time is already ${hhmm(before)}.`
    ctx.changed = true
    return ctx.ride.stopByMin == null ? 'Stop-by time cleared.' : `Stop-by time set to ${hhmm(ctx.ride.stopByMin)}.`
  },
})

export const FIX_TOOLS = [setRoutePreferences, setStopByTime]
