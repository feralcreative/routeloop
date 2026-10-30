// The tools every agent surface shares: the builder's chat and the MCP server.
//
// ONE ZOD SCHEMA PER TOOL IS BOTH ITS DESCRIPTION AND ITS VALIDATION. The model's
// arguments are untrusted output, so every call is parsed here before it touches
// the ride, and a failure goes back to the model as an error result it can read and
// correct rather than as a crash.
//
// Every tool works on a ride already loaded into `ctx.ride`. The surfaces decide
// how a ride gets there and where it goes afterwards: the chat hands it back to the
// open builder and never writes; the MCP server saves it through the same path the
// builder's PUT uses.
//
// DELIBERATELY ABSENT: deleting a ride or a route, changing visibility (a public
// ride can put a rider's house on the internet), the roster, private stop details,
// and anything in the recycle bin.
import { z } from 'zod'
import type { RidePayload } from '../maps/ride-graph'
import { ROLES } from '../maps/roles'
import { DEFAULT_BIAS_RADIUS_M, searchPlaces, type PlaceHit } from '../maps/places'
import { rankPlaces } from '../places/ranking'
import { GMAPS_SERVER_KEY } from '../config'
import type { Budget } from './budget'
import { routeStale } from './legs'
import {
  addPoint,
  addRoute,
  EditError,
  movePoint,
  pointIndex,
  removePoint,
  renameRoute,
  replacePoint,
  routeIndex,
  setDeparture,
  setDwell,
  setRoles,
  type Stale,
} from './ride-edit'
import { rideSummary, type Units } from './summary'

export type AgentContext = {
  ride: RidePayload
  units: Units
  budget: Budget
  favor: string[]
  avoid: string[]
  /** Whether private stop notes go into what the model reads: the ride's creator
   *  only, by canSeeDetails(). NOT "can administer", which a co-owner also passes. */
  includeDetails: boolean
  /** One line a rider reads on the proposal for each edit that landed. */
  changes: string[]
  /** One line a rider watching the chat sees while the turn runs. */
  progress: (line: string) => void
  /** Set by any tool that changed the ride. */
  changed: boolean
}

const uid = z.string().min(1).max(12)
const lat = z.number().min(-90).max(90)
const lng = z.number().min(-180).max(180)
const role = z.enum(ROLES)

const place = {
  name: z.string().max(255).describe('What the place is called, as a rider would say it'),
  address: z.string().max(300).optional().describe('Street address, when known'),
  lat,
  lng,
}

type Tool<S extends z.ZodObject> = {
  name: string
  description: string
  schema: S
  run: (ctx: AgentContext, input: z.infer<S>) => Promise<string>
}

const tool = <S extends z.ZodObject>(t: Tool<S>) => t

// After an edit: route what it left straight, then say what happened.
async function settle(ctx: AgentContext, stale: Stale[], said: string): Promise<string> {
  ctx.changed = true
  if (stale.length === 0) return said
  ctx.progress('Drawing the road')
  const { skipped } = await routeStale(ctx.ride, stale, ctx.budget)
  return skipped > 0 ? `${said} (${skipped} leg(s) left straight: routing budget for this turn is spent)` : said
}

function routeTitle(ctx: AgentContext, routeUid: string): string {
  const r = ctx.ride.routes[routeIndex(ctx.ride, routeUid)]
  return r.title || `route ${routeIndex(ctx.ride, routeUid) + 1}`
}

export const TOOLS = [
  tool({
    name: 'get_ride',
    description:
      'Read the ride as it stands: every route with its uid, departure and length, and every point in order with its uid, kind (STOP or poi), categories, position, miles from the start of its route and estimated arrival. Call this again after edits if you need the new numbers.',
    schema: z.object({}).strict(),
    run: async (ctx) => rideSummary(ctx.ride, { units: ctx.units, includeDetails: ctx.includeDetails }),
  }),

  tool({
    name: 'search_places',
    description:
      'Search Google Places by text ("gas station", "Dunsmuir Lodge", "coffee in Willits"). Results are biased toward `near` when given: a point on the ride by its uid, or a lat/lng. Returns up to 8 places with coordinates you can pass to add_stop or replace_stop. Each search costs real money; search once per place you need, not repeatedly.',
    schema: z
      .object({
        query: z.string().min(2).max(200),
        near_point_uid: uid.optional().describe('Bias toward this point on the ride'),
        near_lat: lat.optional(),
        near_lng: lng.optional(),
        radius_km: z.number().min(1).max(50).optional().describe('How far around `near` to prefer, default 25'),
      })
      .strict(),
    run: async (ctx, input) => {
      if (!GMAPS_SERVER_KEY) return 'Place search is not configured on this server.'
      let near: [number, number] | undefined
      if (input.near_point_uid) {
        for (const r of ctx.ride.routes) {
          const p = r.points.find((q) => q.uid === input.near_point_uid)
          if (p) near = [p.lng, p.lat]
        }
        if (!near) return `No point with uid ${input.near_point_uid}.`
      } else if (input.near_lat != null && input.near_lng != null) {
        near = [input.near_lng, input.near_lat]
      }
      if (!ctx.budget.take('search'))
        return 'The place-search budget for this turn (or today) is spent. Work with what you have.'
      ctx.progress(`Searching “${input.query}”`)
      const out = await searchPlaces(
        { query: input.query, near, radiusM: input.radius_km ? input.radius_km * 1000 : DEFAULT_BIAS_RADIUS_M },
        GMAPS_SERVER_KEY,
      )
      if (out.ok && out.cached) ctx.budget.refund('search')
      if (!out.ok) return `Place search failed (${out.error}).`
      // The rider's own favor and avoid lists, the weighting /api/places/search applies.
      const hits: PlaceHit[] = rankPlaces(out.places, ctx.favor, ctx.avoid)
      if (hits.length === 0) return 'No places found.'
      return hits
        .map(
          (h, i) =>
            `${i + 1}. ${h.name}${h.address ? `, ${h.address}` : ''} (lat ${h.lngLat[1].toFixed(6)}, lng ${h.lngLat[0].toFixed(6)})${h.type ? ` [${h.type}]` : ''}`,
        )
        .join('\n')
    },
  }),

  tool({
    name: 'add_stop',
    description:
      'Add a place to a route. Position it with `after_point_uid` (insert right after that point), or omit it to add at the end. Give `categories` (e.g. ["gas"], ["food"], ["hotel"]) for somewhere the group will actually stop; with none it is a point they ride past. The road is re-routed automatically.',
    schema: z
      .object({
        route_uid: uid,
        ...place,
        after_point_uid: uid.optional(),
        categories: z.array(role).max(4).optional(),
        dwell_minutes: z.number().int().min(0).max(43200).optional().describe('How long the group stays there'),
      })
      .strict(),
    run: async (ctx, input) => {
      const route = ctx.ride.routes[routeIndex(ctx.ride, input.route_uid)]
      const at = input.after_point_uid ? pointIndex(route, input.after_point_uid) + 1 : undefined
      const { point, stale } = addPoint(
        ctx.ride,
        input.route_uid,
        { name: input.name, address: input.address, lat: input.lat, lng: input.lng },
        { at, roles: input.categories ?? [], durationMin: input.dwell_minutes ?? null },
      )
      ctx.progress(`Adding ${input.name}`)
      return settle(ctx, stale, `Added "${point.name}" [${point.uid}] to ${routeTitle(ctx, input.route_uid)}.`)
    },
  }),

  tool({
    name: 'replace_stop',
    description:
      'Swap a point for a different place, keeping its position, categories, dwell time and notes. Use this instead of remove + add when the rider wants somewhere else at the same spot in the plan.',
    schema: z.object({ route_uid: uid, point_uid: uid, ...place }).strict(),
    run: async (ctx, input) => {
      const stale = replacePoint(ctx.ride, input.route_uid, input.point_uid, input)
      ctx.progress(`Swapping in ${input.name}`)
      return settle(ctx, stale, `Replaced point ${input.point_uid} with "${input.name}".`)
    },
  }),

  tool({
    name: 'remove_stop',
    description: 'Take a point off a route. A route cannot be left with no points.',
    schema: z.object({ route_uid: uid, point_uid: uid }).strict(),
    run: async (ctx, input) => {
      const route = ctx.ride.routes[routeIndex(ctx.ride, input.route_uid)]
      const name = route.points[pointIndex(route, input.point_uid)].name
      const { stale, trimmed } = removePoint(ctx.ride, input.route_uid, input.point_uid)
      ctx.progress(`Removing ${name || 'a point'}`)
      return settle(
        ctx,
        stale,
        `Removed "${name}".${trimmed ? ' Some shaping points were dropped to stay under the limit.' : ''}`,
      )
    },
  }),

  tool({
    name: 'move_stop',
    description: 'Move a point to a new position within its route (0 is the start).',
    schema: z.object({ route_uid: uid, point_uid: uid, to_index: z.number().int().min(0) }).strict(),
    run: async (ctx, input) => {
      const stale = movePoint(ctx.ride, input.route_uid, input.point_uid, input.to_index)
      // An empty answer is a point already where it was asked to go: nothing changed.
      if (stale.length === 0) return 'That point is already at that position.'
      ctx.progress('Reordering')
      return settle(ctx, stale, `Moved point ${input.point_uid} to position ${input.to_index}.`)
    },
  }),

  tool({
    name: 'set_categories',
    description:
      'Set what kind of stop a point is: gas, charge, food, coffee, drinks, grocery, hotel, camp, break, view, meet, split, start, finish, home, poi (a sight), wtf. Any category makes it a stop; an empty list makes it a point they ride past.',
    schema: z.object({ route_uid: uid, point_uid: uid, categories: z.array(role).max(4) }).strict(),
    run: async (ctx, input) => {
      setRoles(ctx.ride, input.route_uid, input.point_uid, input.categories)
      ctx.changed = true
      return 'Categories set.'
    },
  }),

  tool({
    name: 'set_dwell',
    description: 'Set how many minutes the group spends at a point. null clears it.',
    schema: z
      .object({ route_uid: uid, point_uid: uid, minutes: z.number().int().min(0).max(43200).nullable() })
      .strict(),
    run: async (ctx, input) => {
      setDwell(ctx.ride, input.route_uid, input.point_uid, input.minutes)
      ctx.changed = true
      return 'Dwell time set.'
    },
  }),

  tool({
    name: 'set_departure',
    description:
      'Set when a route sets off, as the local wall-clock time where the ride starts, formatted YYYY-MM-DDTHH:MM (e.g. 2026-11-07T08:30). Never convert time zones. null clears it.',
    schema: z.object({ route_uid: uid, local_time: z.string().max(16).nullable() }).strict(),
    run: async (ctx, input) => {
      setDeparture(ctx.ride, input.route_uid, input.local_time)
      ctx.changed = true
      return input.local_time ? `Departure set to ${input.local_time.replace('T', ' ')}.` : 'Departure cleared.'
    },
  }),

  tool({
    name: 'add_route',
    description:
      'Add a new route at the end of the ride (a ride is a list of routes, usually one per day or stretch), starting at one place. Add the rest of its points with add_stop.',
    schema: z.object({ title: z.string().max(150), ...place }).strict(),
    run: async (ctx, input) => {
      const route = addRoute(ctx.ride, input.title, input)
      ctx.changed = true
      ctx.progress(`New route: ${input.title}`)
      return `Added route "${route.title}" [${route.uid}] starting at "${route.points[0].name}" [${route.points[0].uid}].`
    },
  }),

  tool({
    name: 'rename_route',
    description: 'Change a route’s title.',
    schema: z.object({ route_uid: uid, title: z.string().max(150) }).strict(),
    run: async (ctx, input) => {
      renameRoute(ctx.ride, input.route_uid, input.title)
      ctx.changed = true
      return 'Renamed.'
    },
  }),
]

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/** The tools that never change the ride. Everything else is an edit. */
export const READS = new Set(['get_ride', 'search_places'])

/** The JSON Schema the model is shown for one tool's input. */
export function inputSchemaOf(t: (typeof TOOLS)[number]): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(t.schema) as Record<string, unknown>
  return schema
}

export type ToolOutcome = { text: string; isError: boolean }

/** Runs one tool call. Never throws: a bad argument or a refused edit comes back
 *  as an error result the model can read and correct. */
export async function runTool(ctx: AgentContext, name: string, rawInput: unknown): Promise<ToolOutcome> {
  const t = BY_NAME.get(name)
  if (!t) return { text: `Unknown tool ${name}.`, isError: true }
  const parsed = t.schema.safeParse(rawInput)
  if (!parsed.success)
    return {
      text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      isError: true,
    }
  // A REFUSED EDIT LEAVES THE RIDE AS IT WAS. Every check in ride-edit.ts runs
  // before it mutates, but an unexpected throw part-way through would otherwise
  // leave a half-made edit in the draft with nothing on the proposal naming it.
  const mutates = !READS.has(name)
  const before = mutates ? structuredClone(ctx.ride) : null
  const changedBefore = ctx.changed
  // Cleared for the call so `changed` afterwards says whether THIS call edited.
  ctx.changed = false
  try {
    const text = await (t.run as Tool<z.ZodObject>['run'])(ctx, parsed.data)
    if (ctx.changed) ctx.changes.push(text)
    ctx.changed ||= changedBefore
    return { text, isError: false }
  } catch (err) {
    if (before) {
      ctx.ride = before
      ctx.changed = changedBefore
    }
    if (err instanceof EditError) return { text: err.message, isError: true }
    console.error(`[agent] tool ${name} failed:`, err instanceof Error ? err.stack : err)
    return { text: 'That tool failed on the server.', isError: true }
  }
}
