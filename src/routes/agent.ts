// The builder's assistant: one turn per request, streamed back as it runs.
//
// THIS ROUTE NEVER WRITES A RIDE. The builder posts the ride it is holding, the
// agent edits a copy, and the copy comes back in the final event for the builder to
// apply as one undoable step. Its ordinary autosave then sends it through the PUT,
// with the rev check and the per-route merge, so an agent edit is saved exactly the
// way a rider's own is and concurrent planning keeps working. A second write path
// for "the assistant changed something" is the thing this shape avoids.
//
// WHOSE MONEY: the rider's own key when they stored one, uncapped, Anthropic or
// OpenAI (the window's switch picks between the two when they hold both, and the
// default on Robots otherwise); else the free tier on Routeloop's Anthropic key,
// refused once the rider's month or the app's month is spent. Google calls are
// budgeted either way (see policy.ts).
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { ANTHROPIC_API_KEY } from '../config'
import { currentUser, requireActiveApi, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { canAdminister, canEditAsMember } from '../members/policy'
import { canSeeDetails } from '../maps/point-details'
import { allow } from '../auth/ratelimit'
import { normalize, ridePayload } from '../maps/ride-graph'
import { firstIssue } from '../maps/fields'
import { parseTerms } from '../places/ranking'
import { placeListsFor, unitsFor } from '../views/prefs'
import { isDraining } from '../shutdown'
import { builderRide } from './builder'
import { Budget } from '../agent/budget'
import { emptyTurn, runTurn, type ChatLine } from '../agent/loop'
import { runTurnOpenAI } from '../agent/loop-openai'
import { claimTurn } from '../agent/inflight'
import {
  dollars,
  FREE_MODEL,
  FREE_MONTHLY_MICROS,
  freeTierAllows,
  pickProvider,
  PROVIDER_NAMES,
  PROVIDER_SHORT,
  PROVIDERS,
  REFUSALS,
  type Provider,
  type Source,
} from '../agent/policy'
import { BYO_ENABLED, freeTierState, googleCallsToday, openKeyOf, recordTurn, storedKeysOf } from '../agent/usage'
import type { AgentContext } from '../agent/tools'
import { presetOf } from '../agent/summary'
import { eq } from 'drizzle-orm'
import { db } from '../db/index'
import { userProfiles } from '../db/schema'

export const agentRoutes = new Hono<AuthEnv>()

const turnBody = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(['rider', 'assistant']), text: z.string().max(8000) }))
    .max(40)
    .default([]),
  /** The window's switch, for a rider holding both keys. Ignored for one they lack. */
  provider: z.enum(PROVIDERS).optional(),
  payload: z.unknown(),
})

/** What the assistant window shows before anybody types: which key would answer, and how
 *  much of the free month is left. `keys` drives the window's switch, which is drawn
 *  only when there are two; `lines` is what the status line says for each. */
agentRoutes.get('/api/agent/status', requireActiveApi, async (c) => {
  const user = currentUser(c)
  const own = await storedKeysOf(user.id)
  const picked = pickProvider(own)
  if (picked)
    return c.json({
      available: true,
      source: 'byo',
      provider: picked,
      keys: own.map((k) => ({ provider: k.provider, short: PROVIDER_SHORT[k.provider] })),
      lines: Object.fromEntries(
        own.map((k) => [k.provider, `Using your ${PROVIDER_NAMES[k.provider]} key (…${k.last4}).`]),
      ),
      line: `Using your ${PROVIDER_NAMES[picked]} key (…${own.find((k) => k.provider === picked)!.last4}).`,
    })
  const free = await freeTierState(user.id)
  const answer = freeTierAllows(free)
  if (!answer.ok) return c.json({ available: false, source: 'free', line: REFUSALS[answer.reason], byo: BYO_ENABLED })
  return c.json({
    available: true,
    source: 'free',
    line: `${dollars(free.riderSpentMicros)} of ${dollars(FREE_MONTHLY_MICROS)} free this month.`,
  })
})

agentRoutes.post(
  '/api/rides/:id/agent',
  requireActiveApi,
  requireSameOrigin,
  bodyLimit({ maxSize: 8 * 1024 * 1024, onError: (c) => c.json({ error: 'payload too large' }, 413) }),
  async (c) => {
    const user = currentUser(c)
    if (isDraining()) return c.json({ error: 'draining' }, 503)
    const found = await builderRide(user.id, c.req.param('id'))
    // 404 for a ride the rider may not edit, as the PUT answers: a 403 confirms it exists.
    if (!found || !canEditAsMember(found.member)) return c.json({ error: 'not found' }, 404)

    const body = turnBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'a message is required' }, 400)
    const ride = ridePayload.safeParse(body.data.payload)
    if (!ride.success) return c.json({ error: firstIssue(ride.error) }, 400)
    normalize(ride.data)

    // Defense in depth beside the lock: the lock stops two at once, this stops a
    // loop of one after another.
    if (!allow('agent', String(user.id), { max: 20, windowMs: 60_000 }))
      return c.json({ error: 'That is a lot of questions at once. Give it a minute.' }, 429)
    // ONE TURN AT A TIME PER RIDER, taken BEFORE anything is read, or two turns both
    // read the same spend and both run to the limit (see inflight.ts). Released when
    // the stream ends, or right here on every early return below.
    const release = claimTurn(user.id)
    if (!release) return c.json({ error: 'I am still working on your last message.' }, 429)
    let streaming = false
    try {
      // Whose key. A stored key that will not open (rotated master, tampered row)
      // falls through to the free tier rather than failing the turn.
      const own = await openKeyOf(user.id, body.data.provider)
      let source: Source
      let provider: Provider = 'anthropic'
      let client: Anthropic | OpenAI
      let model: string
      let maxCostMicros: number | undefined
      if (own) {
        source = 'byo'
        provider = own.provider
        client =
          own.provider === 'openai'
            ? new OpenAI({ apiKey: own.key, maxRetries: 1 })
            : new Anthropic({ apiKey: own.key, maxRetries: 1 })
        model = own.model
      } else {
        const answer = freeTierAllows(await freeTierState(user.id))
        if (!answer.ok) return c.json({ error: REFUSALS[answer.reason] }, 429)
        if (answer.remainingMicros <= 0) return c.json({ error: REFUSALS['global-cap'] }, 429)
        source = 'free'
        client = new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: 1 })
        model = FREE_MODEL
        maxCostMicros = answer.remainingMicros
      }

      const [units, lists, usedToday, [profile]] = await Promise.all([
        unitsFor(c),
        placeListsFor(c),
        googleCallsToday(user.id),
        db
          .select({ vehicle: userProfiles.vehicle, power: userProfiles.power })
          .from(userProfiles)
          .where(eq(userProfiles.userId, user.id))
          .limit(1),
      ])
      const ctx: AgentContext = {
        ride: ride.data,
        role: canAdminister(found.member) ? 'owner' : 'edit',
        snapshot: { kind: 'draft' },
        preset: presetOf(ride.data, profile ?? null),
        units: units === 'metric' ? 'km' : 'mi',
        budget: new Budget(usedToday),
        favor: parseTerms(lists.favor),
        avoid: parseTerms(lists.avoid),
        includeDetails: canSeeDetails(found.ride.ownerId, user),
        changes: [],
        progress: () => {},
        changed: false,
      }

      streaming = true
      return streamSSE(c, async (stream) => {
        const send = (event: string, data: unknown) =>
          stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {})
        // The meter runTurn writes into as each response lands, so what a turn that
        // throws part-way had already spent is still recorded.
        const meter = emptyTurn()
        try {
          const turn = {
            out: meter,
            model,
            effort: source === 'free' ? ('low' as const) : ('medium' as const),
            ctx,
            history: body.data.history as ChatLine[],
            message: body.data.message,
            maxCostMicros,
            onEvent: (e: { type: string; text: string }) => void send(e.type, { text: e.text }),
          }
          const out =
            client instanceof OpenAI ? await runTurnOpenAI({ ...turn, client }) : await runTurn({ ...turn, client })
          const note =
            out.stop === 'iterations' || out.stop === 'budget'
              ? ' (I stopped there to keep this turn small. Ask me to carry on.)'
              : out.stop === 'max_tokens'
                ? ' (My answer was cut off.)'
                : ''
          // A PROPOSAL, NEVER AN EDIT. The builder shows `changes` with Apply and
          // Discard and touches the ride only on Apply, so text planted in a ride or a
          // place result cannot reach a write the rider did not look at.
          //
          // And only a ride the save will accept. Every edit checks the schema's caps
          // before it mutates; this is the backstop, and the PARSED value is what is
          // sent, so what was checked is what the builder gets.
          let proposal: { payload: unknown; changes: string[] } | null = null
          let reply = (out.reply || 'Done.') + note
          if (ctx.changed) {
            const checked = ridePayload.safeParse(ctx.ride)
            if (checked.success) proposal = { payload: checked.data, changes: ctx.changes }
            else {
              console.error('[agent] edited ride failed validation:', firstIssue(checked.error))
              reply += ' (My changes would not save, so I have left them out.)'
            }
          }
          await send('done', { reply, proposal })
        } catch (err) {
          await send('error', { text: describe(err, source, provider) })
        } finally {
          const spend = {
            costMicros: meter.costMicros,
            inputTokens: meter.inputTokens,
            outputTokens: meter.outputTokens,
          }
          await recordTurn(user.id, source, { ...spend, googleCalls: ctx.budget.googleCalls }).catch((e) =>
            console.error('[agent] usage not recorded:', e instanceof Error ? e.stack : e),
          )
          // Released only once the spend is recorded, or the next turn reads the
          // total before this one is in it.
          release()
        }
      })
    } finally {
      if (!streaming) release()
    }
  },
)

// Both SDKs name their errors the same way, so one check per kind covers either.
function describe(err: unknown, source: Source, provider: Provider): string {
  const name = PROVIDER_NAMES[provider]
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof OpenAI.AuthenticationError ||
    err instanceof OpenAI.PermissionDeniedError
  ) {
    return source === 'byo'
      ? `${name} rejected your key. Check it under Robots in your account settings.`
      : 'The assistant is misconfigured right now.'
  }
  if (err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError) {
    return source === 'byo'
      ? `Your ${name} account is rate limited or out of credit.`
      : 'The assistant is busy. Try again in a minute.'
  }
  // A model the key cannot use (an OpenAI project without access to it) is a 404.
  if (err instanceof OpenAI.NotFoundError && source === 'byo')
    return `Your ${name} key cannot use that model. Pick another under Robots in your account settings.`
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    console.error('[agent] API error', provider, err.status, err.message)
    return 'The assistant could not answer just now.'
  }
  console.error('[agent] turn failed:', err instanceof Error ? err.stack : err)
  return 'The assistant could not answer just now.'
}
