// The remote MCP server: Routeloop's planning tools for an outside AI client
// (Claude, ChatGPT, the MCP Inspector) acting as a rider who connected it.
//
// THE SAME TOOLS AS THE BUILDER'S ASK TAB (src/agent/tools.ts), each given a
// `ride_id`. What differs is where the ride comes from and goes: here there is no
// open builder holding it, so every call loads the stored ride, runs the tool, and
// saves through saveRide(), the one write path the builder's PUT also uses, with
// its rev check. The live notice is marked `agent`, so the rider's own open
// builder takes the change instead of ignoring it as its own echo.
//
// NO TOKENS ARE SPENT HERE. The client runs its own model on its own account; the
// only cost to Routeloop is Google. THERE IS NO TURN HERE, so the Ask tab's per-turn
// limits do not apply: each tool call is its own request, bounded by the rider's
// daily Google ceiling, the 120-a-minute request limit, and one call at a time.
//
// EVERY TOOL CARRIES MCP ANNOTATIONS, which is how a host knows to ask the rider
// before a call that changes or spends something. Anything that overwrites what a
// rider set is destructive; only reading the ride is read-only, because a place
// search spends money even though it changes nothing.
//
// STATELESS: a fresh server and transport per request, JSON responses rather than
// a held stream. Nothing about a connection outlives the call, so a blue/green
// cutover drops nothing.
import { Hono } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { and, desc, eq, isNotNull, isNull, or } from 'drizzle-orm'
import { z } from 'zod'
import { APP_ORIGIN } from '../config'
import { db } from '../db/index'
import { rideMembers, rides, userProfiles, users, type UserRow } from '../db/schema'
import { LIVE_RIDE } from '../trash/service'
import { allow } from '../auth/ratelimit'
import { canAdminister, canEditAsMember, canViewAsMember } from '../members/policy'
import { LIVE_MEMBER } from '../members/service'
import { normalize, ridePayload } from '../maps/ride-graph'
import { firstIssue } from '../maps/fields'
import { canSeeDetails } from '../maps/point-details'
import { claimTurn } from '../agent/inflight'
import { parseTerms } from '../places/ranking'
import { builderRide, createRide, loadRidePayload, saveRide } from '../routes/builder'
import { userForAccessToken } from '../oauth/service'
import { Budget } from '../agent/budget'
import { newPoint } from '../agent/ride-edit'
import { READS, TOOLS, runTool, type AgentContext } from '../agent/tools'
import { googleCallsToday, recordTurn } from '../agent/usage'

export const mcpRoutes = new Hono()

const RESOURCE_METADATA = `${APP_ORIGIN}/.well-known/oauth-protected-resource`
// What each tool may do, for the host. readOnly: changes nothing and spends
// nothing. destructive: overwrites or removes something a rider set.
const ANNOTATIONS: Record<string, { readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint?: boolean }> = {
  list_rides: { readOnlyHint: true },
  get_ride: { readOnlyHint: true },
  search_places: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  create_ride: { readOnlyHint: false, destructiveHint: false },
  add_stop: { readOnlyHint: false, destructiveHint: false },
  add_route: { readOnlyHint: false, destructiveHint: false },
  replace_stop: { readOnlyHint: false, destructiveHint: true },
  remove_stop: { readOnlyHint: false, destructiveHint: true },
  move_stop: { readOnlyHint: false, destructiveHint: true },
  set_categories: { readOnlyHint: false, destructiveHint: true },
  set_dwell: { readOnlyHint: false, destructiveHint: true },
  set_departure: { readOnlyHint: false, destructiveHint: true },
  rename_route: { readOnlyHint: false, destructiveHint: true },
}

type Prefs = { units: 'mi' | 'km'; favor: string[]; avoid: string[] }

async function prefsOf(userId: number): Promise<Prefs> {
  const [p] = await db
    .select({ units: userProfiles.units, favor: userProfiles.favorPlaces, avoid: userProfiles.avoidPlaces })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
  return { units: p?.units === 'metric' ? 'km' : 'mi', favor: parseTerms(p?.favor), avoid: parseTerms(p?.avoid) }
}

const text = (t: string, isError = false) => ({
  content: [{ type: 'text' as const, text: t }],
  ...(isError ? { isError: true } : {}),
})

/** One tool call against one stored ride, saved if it changed anything. A save
 *  that loses the rev race is retried once against the fresh ride. */
async function onRide(user: UserRow, prefs: Prefs, rideId: number, name: string, args: unknown) {
  // ONE CALL AT A TIME PER RIDER, the Ask tab's lock: the daily Google ceiling is
  // read before the call and recorded after it (see src/agent/inflight.ts).
  const release = claimTurn(user.id)
  if (!release) return text('Another Routeloop request of yours is still running. Retry in a moment.', true)
  try {
    return await onRideHeld(user, prefs, rideId, name, args)
  } finally {
    release()
  }
}

async function onRideHeld(user: UserRow, prefs: Prefs, rideId: number, name: string, args: unknown) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const found = await builderRide(user.id, String(rideId))
    const reads = READS.has(name)
    const may = reads ? canViewAsMember(found?.member ?? null) : canEditAsMember(found?.member ?? null)
    if (!found || !may) return text(`No ride ${rideId} that you can ${reads ? 'see' : 'edit'}.`, true)
    const loaded = (await loadRidePayload(found.ride, user)) as { rev: number }
    const parsed = ridePayload.safeParse(loaded)
    if (!parsed.success) return text('That ride could not be read.', true)

    const budget = new Budget(await googleCallsToday(user.id), { perTurn: false })
    const ctx: AgentContext = {
      ride: parsed.data,
      units: prefs.units,
      budget,
      favor: prefs.favor,
      avoid: prefs.avoid,
      includeDetails: canSeeDetails(found.ride.ownerId, user),
      changes: [],
      progress: () => {},
      changed: false,
    }
    const out = await runTool(ctx, name, args)
    if (budget.googleCalls > 0) {
      await recordTurn(user.id, 'mcp', {
        costMicros: 0,
        inputTokens: 0,
        outputTokens: 0,
        googleCalls: budget.googleCalls,
      }).catch(() => {})
    }
    if (out.isError || !ctx.changed) return text(out.text, out.isError)

    normalize(ctx.ride)
    // THE SCHEMA, AGAIN, BEFORE THE WRITE. saveRide() trusts its argument's type, and
    // an edited draft is only typed, not checked; a ride stored past a cap is one
    // that then fails to load. The parsed value is what is saved.
    const checked = ridePayload.safeParse(ctx.ride)
    if (!checked.success) return text(`That edit would leave the ride unsaveable: ${firstIssue(checked.error)}`, true)
    // saveRide's own `isOwner` gates visibility and the details mode is decided
    // inside it by who is saving, so a co-owner's save preserves the creator's.
    const isOwner = canAdminister(found.member)
    const saved = await saveRide(found.ride, user, isOwner, checked.data, loaded.rev, undefined, { agent: true })
    if (!('stale' in saved)) return text(out.text)
  }
  return text('The ride kept changing under that edit. Read it again and retry.', true)
}

function buildServer(user: UserRow, prefs: Prefs): McpServer {
  const server = new McpServer({ name: 'routeloop', version: '1.0.0' })

  server.registerTool(
    'list_rides',
    {
      description: 'List the rides you own or are on, newest first, with the id every other tool takes.',
      inputSchema: {},
      annotations: ANNOTATIONS.list_rides,
    },
    async () => {
      // ONE QUERY, so the list is genuinely newest first across every kind of ride,
      // and a ride the rider co-owns but did not create is in it: ridesImOn() leaves
      // out every owner row, because the dashboard lists those as the rider's own.
      const rows = await db
        .select({
          id: rides.id,
          title: rides.title,
          ownerId: rides.ownerId,
          owner: users.displayName,
          role: rideMembers.role,
        })
        .from(rides)
        .innerJoin(users, eq(users.id, rides.ownerId))
        .leftJoin(rideMembers, and(eq(rideMembers.rideId, rides.id), eq(rideMembers.riderId, user.id), LIVE_MEMBER))
        .where(
          and(
            LIVE_RIDE,
            isNull(users.deletionRequestedAt),
            or(eq(rides.ownerId, user.id), isNotNull(rideMembers.riderId)),
          ),
        )
        .orderBy(desc(rides.updatedAt))
        .limit(100)
      const lines = rows.map((r) => {
        const whose =
          r.ownerId === user.id
            ? 'yours'
            : r.role === 'owner'
              ? `you co-own it with ${r.owner}`
              : `planned by ${r.owner}`
        return `${r.id}: "${r.title}" (${whose}) ${APP_ORIGIN}/builder/${r.id}`
      })
      return text(lines.length ? lines.join('\n') : 'No rides yet. Use create_ride to start one.')
    },
  )

  server.registerTool(
    'create_ride',
    {
      description:
        'Start a new private ride with one route that begins at a place. Search for the place first so the coordinates are real. Returns the new ride id.',
      inputSchema: {
        title: z.string().min(1).max(150),
        start_name: z.string().max(255),
        start_address: z.string().max(300).optional(),
        start_lat: z.number().min(-90).max(90),
        start_lng: z.number().min(-180).max(180),
      },
      annotations: ANNOTATIONS.create_ride,
    },
    async (a) => {
      const start = newPoint({ name: a.start_name, address: a.start_address, lat: a.start_lat, lng: a.start_lng }, [
        'start',
      ])
      const p = ridePayload.parse({ title: a.title, routes: [{ title: 'Route 1', points: [start], legs: [] }] })
      normalize(p)
      const ride = await createRide(user, p)
      return text(`Created ride ${ride.id}, "${ride.title}". Open it at ${APP_ORIGIN}/builder/${ride.id}`)
    },
  )

  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        description: `${t.description} Takes the ride’s id from list_rides.`,
        inputSchema: { ride_id: z.number().int().positive(), ...t.schema.shape },
        annotations: ANNOTATIONS[t.name],
      },
      async (a: Record<string, unknown>) => {
        const { ride_id, ...rest } = a
        return onRide(user, prefs, ride_id as number, t.name, rest)
      },
    )
  }
  return server
}

mcpRoutes.all('/mcp', async (c) => {
  const auth = c.req.header('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const user = token ? await userForAccessToken(token) : null
  if (!user) {
    // The header an MCP client reads to find the authorization server.
    c.header('WWW-Authenticate', `Bearer resource_metadata="${RESOURCE_METADATA}"`)
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (!allow('mcp', String(user.id), { max: 120, windowMs: 60_000 })) return c.json({ error: 'slow down' }, 429)

  const server = buildServer(user, await prefsOf(user.id))
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(c.req.raw)
  } finally {
    void server.close().catch(() => {})
  }
})
