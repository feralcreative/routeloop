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
// only cost to Routeloop is Google, budgeted per rider per day like every surface.
//
// STATELESS: a fresh server and transport per request, JSON responses rather than
// a held stream. Nothing about a connection outlives the call, so a blue/green
// cutover drops nothing.
import { Hono } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { APP_ORIGIN } from '../config'
import { db } from '../db/index'
import { rides, userProfiles, type UserRow } from '../db/schema'
import { LIVE_RIDE } from '../trash/service'
import { allow } from '../auth/ratelimit'
import { canAdminister, canEditAsMember, canViewAsMember } from '../members/policy'
import { ridesImOn } from '../members/service'
import { normalize, ridePayload } from '../maps/ride-graph'
import { parseTerms } from '../places/ranking'
import { builderRide, createRide, loadRidePayload, saveRide } from '../routes/builder'
import { userForAccessToken } from '../oauth/service'
import { Budget } from '../agent/budget'
import { newPoint } from '../agent/ride-edit'
import { TOOLS, runTool, type AgentContext } from '../agent/tools'
import { googleCallsToday, recordTurn } from '../agent/usage'

export const mcpRoutes = new Hono()

const RESOURCE_METADATA = `${APP_ORIGIN}/.well-known/oauth-protected-resource`
const READ_ONLY = new Set(['get_ride', 'search_places'])

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
  for (let attempt = 0; attempt < 2; attempt++) {
    const found = await builderRide(user.id, String(rideId))
    const may = READ_ONLY.has(name) ? canViewAsMember(found?.member ?? null) : canEditAsMember(found?.member ?? null)
    if (!found || !may) return text(`No ride ${rideId} that you can ${READ_ONLY.has(name) ? 'see' : 'edit'}.`, true)
    const isOwner = canAdminister(found.member)
    const loaded = (await loadRidePayload(found.ride, user)) as { rev: number }
    const parsed = ridePayload.safeParse(loaded)
    if (!parsed.success) return text('That ride could not be read.', true)

    const budget = new Budget(await googleCallsToday(user.id))
    const ctx: AgentContext = {
      ride: parsed.data,
      units: prefs.units,
      budget,
      favor: prefs.favor,
      avoid: prefs.avoid,
      isOwner,
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
    const saved = await saveRide(found.ride, user, isOwner, ctx.ride, loaded.rev, undefined, { agent: true })
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
    },
    async () => {
      const [owned, joined] = await Promise.all([
        db
          .select({ id: rides.id, title: rides.title, slug: rides.slug, updatedAt: rides.updatedAt })
          .from(rides)
          .where(and(eq(rides.ownerId, user.id), LIVE_RIDE))
          .orderBy(desc(rides.updatedAt))
          .limit(50),
        ridesImOn(user.id),
      ])
      const lines = [
        ...owned.map((r) => `${r.id}: "${r.title}" (yours) ${APP_ORIGIN}/builder/${r.id}`),
        ...joined.map(
          (j) => `${j.ride.id}: "${j.ride.title}" (planned by ${j.owner}) ${APP_ORIGIN}/builder/${j.ride.id}`,
        ),
      ]
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
