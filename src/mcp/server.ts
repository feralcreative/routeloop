// The remote MCP server: Routeloop's planning tools for an outside AI client
// (Claude, ChatGPT, the MCP Inspector) acting as a rider who connected it.
//
// THE SAME TOOLS AS THE BUILDER'S ASSISTANT (src/agent/tools.ts), each given a
// `ride_id`. What differs is where the ride comes from and goes: here there is no
// open builder holding it, so every call loads the stored ride and runs the tool
// against it, and an edit lands in a PENDING PROPOSAL (src/mcp/proposals.ts), never
// in the ride. apply_changes saves the whole proposal through saveRide(), the one
// write path the builder's PUT also uses, against the revision the changes were
// made on (#453). The live notice is marked `agent`, so the rider's own open
// builder takes the change instead of ignoring it as its own echo.
//
// NO TOKENS ARE SPENT HERE. The client runs its own model on its own account; the
// only cost to Routeloop is Google. THERE IS NO TURN HERE, so the builder assistant's per-turn
// limits do not apply: each tool call is its own request, bounded by the rider's
// daily Google ceiling, the 120-a-minute request limit, and one call at a time.
//
// EVERY TOOL CARRIES MCP ANNOTATIONS, derived from its capability (annotationsOf()
// in src/agent/tools.ts), which is how a host knows to ask the rider before a call
// that changes or spends something. They are hints to the host, never the gate: who
// may call a tool is checked here against the rider's standing on the ride.
//
// STATELESS TRANSPORT: a fresh server and transport per request, JSON responses
// rather than a held stream. Only a pending proposal outlives a call, in memory.
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
import { normalize, ridePayload, type RidePayload } from '../maps/ride-graph'
import { firstIssue } from '../maps/fields'
import { canSeeDetails } from '../maps/point-details'
import { claimTurn } from '../agent/inflight'
import { parseTerms } from '../places/ranking'
import { builderRide, createRide, loadRidePayload, saveRide } from '../routes/builder'
import { userForAccessToken } from '../oauth/service'
import { Budget } from '../agent/budget'
import { presetOf } from '../agent/summary'
import { fuelContextFor } from '../agent/fuel-context'
import { newPoint } from '../agent/ride-edit'
import {
  annotationsOf,
  mayCall,
  READS,
  RIDELESS,
  TOOLS,
  runRideless,
  runTool,
  type AgentContext,
  type Capability,
} from '../agent/tools'
import { dropProposal, getProposal, putProposal } from './proposals'
import { CORE, TOPIC_NAMES, TOPICS, topicText } from '../agent/knowledge'
import { googleCallsToday, recordTurn } from '../agent/usage'

export const mcpRoutes = new Hono()

const RESOURCE_METADATA = `${APP_ORIGIN}/.well-known/oauth-protected-resource`
// The two tools only this server has, which need no ride and so sit outside the
// shared table. Every other tool's annotations come from its capability.
const LOCAL_CAPS: Record<string, Capability> = {
  list_rides: { mutates: false, needs: 'none' },
  create_ride: { mutates: true, needs: 'none' },
  review_changes: { mutates: false, needs: 'edit' },
  // Changes no ride, but throws away work, so a host should treat it as destructive.
  discard_changes: { mutates: true, destructive: true, needs: 'edit' },
  apply_changes: { mutates: true, destructive: true, needs: 'edit' },
}

type Prefs = { units: 'mi' | 'km'; favor: string[]; avoid: string[]; vehicle: string | null; power: string | null }

async function prefsOf(userId: number): Promise<Prefs> {
  const [p] = await db
    .select({
      units: userProfiles.units,
      favor: userProfiles.favorPlaces,
      avoid: userProfiles.avoidPlaces,
      vehicle: userProfiles.vehicle,
      power: userProfiles.power,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
  return {
    units: p?.units === 'metric' ? 'km' : 'mi',
    favor: parseTerms(p?.favor),
    avoid: parseTerms(p?.avoid),
    vehicle: p?.vehicle ?? null,
    power: p?.power ?? null,
  }
}

const text = (t: string, isError = false) => ({
  content: [{ type: 'text' as const, text: t }],
  ...(isError ? { isError: true } : {}),
})

/** One tool call against one stored ride. An edit lands in the rider's pending
 *  proposal for that ride, never in the ride itself; apply_changes saves it. */
async function onRide(user: UserRow, prefs: Prefs, rideId: number, name: string, args: unknown) {
  // ONE CALL AT A TIME PER RIDER, the builder assistant's lock: the daily Google ceiling is
  // read before the call and recorded after it (see src/agent/inflight.ts). It also
  // keeps two calls from building on the same proposal at once.
  const release = claimTurn(user.id)
  if (!release) return text('Another Routeloop request of yours is still running. Retry in a moment.', true)
  try {
    return await onRideHeld(user, prefs, rideId, name, args)
  } finally {
    release()
  }
}

type Loaded = {
  found: NonNullable<Awaited<ReturnType<typeof builderRide>>>
  role: 'view' | 'edit' | 'owner'
  rev: number
  ride: RidePayload
}

/** The stored ride and the rider's standing on it, or the refusal to send. */
async function loadForRider(user: UserRow, rideId: number): Promise<Loaded | string> {
  const found = await builderRide(user.id, String(rideId))
  if (!found || !canViewAsMember(found.member)) return `No ride ${rideId} that you can see.`
  const role = canAdminister(found.member) ? 'owner' : canEditAsMember(found.member) ? 'edit' : 'view'
  const loaded = (await loadRidePayload(found.ride, user)) as { rev: number }
  const parsed = ridePayload.safeParse(loaded)
  if (!parsed.success) return 'That ride could not be read.'
  return { found, role, rev: loaded.rev, ride: parsed.data }
}

/** The rider's pending proposal for this ride if it still applies. One made on an
 *  older revision cannot be built on, because that would silently undo whatever
 *  changed the ride since: a call that changes something drops it and says so; a
 *  read leaves it for the next edit to drop and only warns. */
function currentProposal(user: UserRow, rideId: number, rev: number, drop: boolean) {
  const p = getProposal(user.id, rideId)
  if (!p || p.baseRev === rev) return { proposal: p, stale: null as string | null }
  if (drop) dropProposal(user.id, rideId)
  const what = drop ? 'so they were discarded' : 'so they will be discarded by your next edit'
  return {
    proposal: null,
    stale: `The ride changed since your pending changes were made, ${what}: ${p.changes.join(' ')} Read it again with get_ride and redo what still applies.`,
  }
}

/** A proposal tool's ride, access, and lock, or the refusal to send. */
async function withEditAccess<T>(
  user: UserRow,
  rideId: number,
  need: Capability['needs'],
  fn: (l: Loaded) => Promise<T>,
): Promise<T | ReturnType<typeof text>> {
  const release = claimTurn(user.id)
  if (!release) return text('Another Routeloop request of yours is still running. Retry in a moment.', true)
  try {
    const l = await loadForRider(user, rideId)
    if (typeof l === 'string') return text(l, true)
    if (!mayCall(l.role, need)) return text('You can see this ride but not edit it.', true)
    return await fn(l)
  } finally {
    release()
  }
}

async function onRideHeld(user: UserRow, prefs: Prefs, rideId: number, name: string, args: unknown) {
  const l = await loadForRider(user, rideId)
  if (typeof l === 'string') return text(l, true)
  const mutates = !READS.has(name)
  const { proposal, stale } = currentProposal(user, rideId, l.rev, mutates)
  if (stale && mutates) return text(stale, true)

  const budget = new Budget(await googleCallsToday(user.id), { perTurn: false })
  const ctx: AgentContext = {
    // The proposal's draft when there is one, so reads and further edits see the
    // changes already proposed.
    ride: proposal ? structuredClone(proposal.ride) : l.ride,
    role: l.role,
    rideId,
    userId: user.id,
    snapshot: { kind: 'saved', rev: l.rev, pending: proposal?.changes.length ?? 0 },
    preset: presetOf(l.ride, prefs),
    fuel: await fuelContextFor(rideId, user.id, l.ride, prefs, l.role),
    units: prefs.units,
    budget,
    favor: prefs.favor,
    avoid: prefs.avoid,
    includeDetails: canSeeDetails(l.found.ride.ownerId, user),
    changes: [],
    progress: () => {},
    changed: false,
  }
  const raw = await runTool(ctx, name, args)
  const out = stale ? { ...raw, text: `${stale}\n\n${raw.text}` } : raw
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
  // THE SCHEMA ON EVERY EDIT, not only at apply: a proposal that could never be
  // saved is refused at the step that broke it, where the client can still undo it.
  const checked = ridePayload.safeParse(ctx.ride)
  if (!checked.success) return text(`That edit would leave the ride unsaveable: ${firstIssue(checked.error)}`, true)
  const changes = [...(proposal?.changes ?? []), ...ctx.changes]
  putProposal({ userId: user.id, rideId, baseRev: l.rev, ride: checked.data, changes, touchedAt: 0 })
  return text(
    `${out.text}\nNot saved yet: ${changes.length} pending change${changes.length === 1 ? '' : 's'} on this ride. Show the rider what you changed, and call apply_changes once they agree.`,
  )
}

/** Saves the rider's pending proposal in one write, against the revision it was made on.
 *  The role is checked before the save and not again inside its transaction, which
 *  is the same window the builder's own PUT has: removing a rider does not bump the
 *  ride's revision. */
const applyChanges = (user: UserRow, rideId: number) =>
  withEditAccess(user, rideId, LOCAL_CAPS.apply_changes.needs, async (l) => {
    const { proposal, stale } = currentProposal(user, rideId, l.rev, true)
    if (stale) return text(stale, true)
    if (!proposal) return text('There are no pending changes on this ride.', true)
    // saveRide's own `isOwner` gates visibility and the details mode is decided
    // inside it by who is saving, so a co-owner's save preserves the creator's.
    const saved = await saveRide(l.found.ride, user, l.role === 'owner', proposal.ride, l.rev, undefined, {
      agent: true,
    })
    dropProposal(user.id, rideId)
    if ('stale' in saved)
      return text(
        `The ride changed as these were being saved, so nothing was saved and they were discarded: ${proposal.changes.join(' ')} Read it again with get_ride and redo what still applies.`,
        true,
      )
    return text(
      `Saved ${proposal.changes.length} change${proposal.changes.length === 1 ? '' : 's'}: ${proposal.changes.join(' ')}`,
    )
  })

// What a client reads before it calls anything: the MCP half of the builder
// assistant's preamble, then the same shared knowledge (src/agent/knowledge.ts).
const INSTRUCTIONS = `Routeloop’s planning tools, acting as the rider who connected them.

How to work here:
- Find a ride’s id with list_rides, or start one with create_ride. Read it with get_ride before changing it, and refer to routes and points by the uids in square brackets.
- Edits do not save on their own. Each one adds to a pending proposal for that ride, which get_ride already shows. When you are done, tell the rider what you changed and call apply_changes once they agree: it saves everything in one write to their real ride, which they and everyone they ride with will see. review_changes lists what is pending; discard_changes drops it. Pending changes expire after 30 minutes untouched, and are discarded if the ride changes underneath them.
- The guide tool, and the same topics as resources, hold how Routeloop works and how to plan a ride. Read ready-to-ride before saying a ride is ready.

${CORE}`

function buildServer(user: UserRow, prefs: Prefs): McpServer {
  const server = new McpServer({ name: 'routeloop', version: '1.0.0' }, { instructions: INSTRUCTIONS })

  // THE GUIDE AS RESOURCES TOO, for clients that let a rider attach one. The guide
  // tool is the door every client has; these are the same text.
  for (const t of TOPIC_NAMES) {
    server.registerResource(
      t,
      `routeloop://guide/${t}`,
      { title: t, description: TOPICS[t], mimeType: 'text/markdown' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: topicText(t) }] }),
    )
  }

  // TWO PROMPTS, which Claude shows as slash commands: the two things a rider most
  // often wants from this server, each pointed at the guide topics that make it good.
  server.registerPrompt(
    'plan_a_ride',
    {
      title: 'Plan a ride',
      description: 'Plan a new multi-day ride from a start, a destination and dates.',
      argsSchema: {
        start: z.string().max(200).optional().describe('Where the ride starts'),
        destination: z.string().max(200).optional().describe('Where it goes'),
        dates: z.string().max(200).optional().describe('When, and how many days'),
        notes: z.string().max(2000).optional().describe('Bikes, group size, style, anything else'),
      },
    },
    (a) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              'Plan a ride with me in Routeloop.',
              a.start ? `Start: ${a.start}` : '',
              a.destination ? `Destination: ${a.destination}` : '',
              a.dates ? `Dates: ${a.dates}` : '',
              a.notes ? `Notes: ${a.notes}` : '',
              'First read the guide topics pacing, fuel-and-charging, and weather-and-seasons. Ask me what is missing (start, destination, dates, vehicle and fuel range, how many riders, how far we like to ride in a day, departure and stop times) in one short message. Then propose the days, and only after I agree, build it with create_ride and the editing tools. Run the ready-to-ride checklist on what you built, tell me what you changed and what is left to fix, and call apply_changes only once I say so.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        },
      ],
    }),
  )
  server.registerPrompt(
    'check_my_ride',
    {
      title: 'Check my ride',
      description: 'Run the pre-ride checklist on one ride and list what to fix before riding it.',
      argsSchema: { ride_id: z.string().max(12).describe('The ride id from list_rides') },
    },
    (a) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Check ride ${a.ride_id} in Routeloop. Call check_ride, then get_conditions and get_road_reports for each dated route and get_official_closures for any route in California, and read the guide topic ready-to-ride for anything you need explained. List the problems worst first, each with the fix you would make, then the things only we riders can confirm. Change nothing until I say so.`,
          },
        },
      ],
    }),
  )

  server.registerTool(
    'list_rides',
    {
      description: 'List the rides you own or are on, newest first, with the id every other tool takes.',
      inputSchema: {},
      annotations: annotationsOf(LOCAL_CAPS.list_rides),
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
          r.ownerId === user.id ? 'yours' : r.role === 'owner' ? 'you co-own it' : 'planned by another rider'
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
      annotations: annotationsOf(LOCAL_CAPS.create_ride),
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
    if (RIDELESS.has(t.name)) {
      // No ride to load and nothing to save, so no ride_id and no lock.
      server.registerTool(
        t.name,
        { description: t.description, inputSchema: t.schema.shape, annotations: annotationsOf(t.cap) },
        async (a: Record<string, unknown>) => {
          const out = await runRideless(t.name, a)
          return text(out.text, out.isError)
        },
      )
      continue
    }
    server.registerTool(
      t.name,
      {
        description: `${t.description} Takes the ride’s id from list_rides.`,
        inputSchema: { ride_id: z.number().int().positive(), ...t.schema.shape },
        annotations: annotationsOf(t.cap),
      },
      async (a: Record<string, unknown>) => {
        const { ride_id, ...rest } = a
        return onRide(user, prefs, ride_id as number, t.name, rest)
      },
    )
  }

  // THE PROPOSAL'S THREE DOORS. Edits above only ever add to it.
  const rideId = { ride_id: z.number().int().positive() }
  server.registerTool(
    'review_changes',
    {
      description: 'List the changes you have proposed to a ride and not applied yet.',
      inputSchema: rideId,
      annotations: annotationsOf(LOCAL_CAPS.review_changes),
    },
    async ({ ride_id }) =>
      withEditAccess(user, ride_id, LOCAL_CAPS.review_changes.needs, async (l) => {
        const { proposal, stale } = currentProposal(user, ride_id, l.rev, false)
        if (stale) return text(stale, true)
        if (!proposal) return text('There are no pending changes on this ride.')
        return text(proposal.changes.map((c, i) => `${i + 1}. ${c}`).join('\n'))
      }),
  )
  server.registerTool(
    'discard_changes',
    {
      description: 'Drop every change you have proposed to a ride. The ride itself is untouched.',
      inputSchema: rideId,
      annotations: annotationsOf(LOCAL_CAPS.discard_changes),
    },
    async ({ ride_id }) =>
      withEditAccess(user, ride_id, LOCAL_CAPS.discard_changes.needs, async () => {
        dropProposal(user.id, ride_id)
        return text('Discarded. The ride is as it was saved.')
      }),
  )
  server.registerTool(
    'apply_changes',
    {
      description:
        'Save every pending change to a ride in one write, once the rider has agreed. Refused if the ride changed since the changes were made.',
      inputSchema: rideId,
      annotations: annotationsOf(LOCAL_CAPS.apply_changes),
    },
    async ({ ride_id }) => applyChanges(user, ride_id),
  )
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
