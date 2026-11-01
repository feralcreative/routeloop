// One agent turn: the rider says something, the model reads the ride, calls tools
// until it is done, and answers.
//
// A MANUAL LOOP RATHER THAN THE SDK'S TOOL RUNNER, because three things have to
// happen between iterations that the runner would hide: the turn's cost is counted
// against a free-tier ceiling that can stop it, every tool call is reported to the
// rider as it happens, and the loop is capped at TURN_LIMITS.iterations.
//
// EVERY TURN IS A FRESH CONVERSATION. Earlier exchanges arrive as a plain-text
// transcript inside the first user message rather than as replayed assistant turns.
// Current models bind their thinking blocks to the conversation that produced
// them, and the chat's history lives in a browser tab that may have been edited,
// trimmed or reloaded; a transcript cannot be invalid, and the ride itself, which
// is what actually carries state between turns, is re-read every time.
import Anthropic from '@anthropic-ai/sdk'
import { costMicros, TURN_LIMITS } from './policy'
import { inputSchemaOf, runTool, TOOLS, type AgentContext } from './tools'
import { rideSummary } from './summary'
import { CORE } from './knowledge'

export type ChatLine = { role: 'rider' | 'assistant'; text: string }

export type TurnEvent = { type: 'text'; text: string } | { type: 'progress'; text: string }

export type TurnResult = {
  reply: string
  stop: 'done' | 'iterations' | 'budget' | 'refusal' | 'max_tokens'
  costMicros: number
  inputTokens: number
  outputTokens: number
}

// The builder's own preamble, then the shared knowledge (src/agent/knowledge/core.md):
// the vocabulary, the conduct rules and the readiness overview, which the MCP
// server sends as its instructions too. Both are fixed text, so they sit inside
// the cached prefix with the tools.
export const SYSTEM = `You are the planning assistant inside Routeloop, in a window over the rider’s map in the builder.

How to work here:
- The ride is given to you at the start of each turn. Refer to routes and points by the uids in square brackets.
- Your edits come back to the rider as a proposal listing each change, with Apply and Discard. Nothing touches their ride until they press Apply, which they can then undo in one step.
- Call get_ride after edits if you need the new numbers.
- If a request is ambiguous (which route, which town), ask one short question instead of guessing.

Answer in plain, short sentences: say what you changed or found, with the numbers that matter (miles, arrival times). No headings, no bullet lists unless the rider asks for a list.

${CORE}`

/** Web searches one builder turn may make on a rider's own key, across every request
 *  of the turn: max_uses is per request, so the loop passes what is left. */
export const WEB_SEARCHES_PER_TURN = 5

/** What one web search costs on top of its tokens, on both providers ($10 per
 *  thousand), so a BYO turn's recorded cost is not understated. */
export const WEB_SEARCH_MICROS = 10_000

/** The sources behind an answer, as plain lines a rider can follow: the model's own
 *  citations, which would otherwise be dropped with the structure they arrive in. */
export function sourcesLine(sources: { url: string; title?: string | null }[]): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const s of sources) {
    if (!s.url || seen.has(s.url)) continue
    seen.add(s.url)
    lines.push(`- ${s.title ? `${s.title}: ` : ''}${s.url}`)
  }
  return lines.length ? `\n\nSources:\n${lines.join('\n')}` : ''
}

export const emptyTurn = (): TurnResult => ({
  reply: '',
  stop: 'done',
  costMicros: 0,
  inputTokens: 0,
  outputTokens: 0,
})

/** The first user message of every turn, on either provider: the transcript so
 *  far, the ride as it stands, and what the rider just said. */
export function openingMessage(ctx: AgentContext, history: ChatLine[], message: string): string {
  const transcript = history
    .slice(-12)
    .map((l) => `${l.role === 'rider' ? 'Rider' : 'You'}: ${l.text.slice(0, 2000)}`)
    .join('\n')
  return [
    transcript ? `Conversation so far:\n${transcript}` : '',
    `The ride right now:\n${rideSummary(ctx.ride, { units: ctx.units, includeDetails: ctx.includeDetails, snapshot: ctx.snapshot, preset: ctx.preset })}`,
    `Rider: ${message.slice(0, 4000)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export type TurnOptions<Client> = {
  client: Client
  model: string
  effort: 'low' | 'medium' | 'high'
  ctx: AgentContext
  history: ChatLine[]
  message: string
  /** Stop starting new iterations once the turn has cost this much. */
  maxCostMicros?: number
  onEvent: (e: TurnEvent) => void
  /** Let the model search the web (the provider's own server tool). BYO KEYS ONLY,
   *  Ziad's call 2026-10-31: the rider's key pays for the searches, and the free tier
   *  gets the official sources the app reads itself. */
  webSearch?: boolean
  /** The caller's meter, written as each response lands, so a turn that throws on
   *  its third call still reports what the first two cost. */
  out?: TurnResult
}

// A CACHE BREAKPOINT THAT MOVES WITH THE CONVERSATION. Every iteration resends the
// opening message (the whole ride summary) and every tool result so far, a guide
// topic among them; marking the newest block lets the next iteration read all of it
// from the cache instead of paying full price again. A request takes at most four
// breakpoints and the tools and the system prompt hold two, so the previous mark is
// cleared before the new one is set. OpenAI caches a long shared prefix on its own,
// so loop-openai.ts needs nothing like it.
function markCacheTail(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (typeof m.content === 'string') continue
    for (const b of m.content) delete (b as { cache_control?: unknown }).cache_control
  }
  const last = messages[messages.length - 1]
  if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }]
  const tail = last.content[last.content.length - 1] as { cache_control?: Anthropic.CacheControlEphemeral }
  tail.cache_control = { type: 'ephemeral' }
}

/** One turn on Anthropic. loop-openai.ts is the same loop on OpenAI. */
export async function runTurn(opts: TurnOptions<Anthropic>): Promise<TurnResult> {
  const { client, model, ctx } = opts
  const tools: Anthropic.Tool[] = TOOLS.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: inputSchemaOf(t) as Anthropic.Tool.InputSchema,
    // A breakpoint on the last tool caches the tool list, which comes first in the
    // prefix; the system prompt below carries its own, so the knowledge core is read
    // from the cache on every turn of every rider, not only within one turn.
    ...(i === TOOLS.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }))

  // THE SERVER TOOL GOES AFTER THE CACHED FUNCTION TOOLS, so the prefix cached on the
  // last of those is the same whether or not the turn can search. The dynamic-filtering
  // version is what Opus 5.5 and Sonnet 5.5 take; Haiku 5.5 takes the basic one.
  // Results come back in the same response as server-tool blocks, and pause_turn (a
  // long search) is already continued below.
  let searchesLeft = opts.webSearch ? WEB_SEARCHES_PER_TURN : 0
  const search = (): Anthropic.ToolUnion[] =>
    searchesLeft > 0
      ? [
          model.startsWith('claude-haiku')
            ? { type: 'web_search_20250305', name: 'web_search', max_uses: searchesLeft }
            : { type: 'web_search_20260209', name: 'web_search', max_uses: searchesLeft },
        ]
      : []
  const cited: { url: string; title?: string | null }[] = []

  const opening = openingMessage(ctx, opts.history, opts.message)
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opening }]
  const out: TurnResult = opts.out ?? emptyTurn()
  ctx.progress = (text) => opts.onEvent({ type: 'progress', text })

  for (let i = 0; i < TURN_LIMITS.iterations; i++) {
    if (opts.maxCostMicros != null && out.costMicros >= opts.maxCostMicros) {
      out.stop = 'budget'
      break
    }
    markCacheTail(messages)
    const response = await client.messages.create({
      model,
      max_tokens: 8000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: [...tools, ...search()],
      output_config: { effort: opts.effort },
      messages,
    })

    out.costMicros += costMicros(model, response.usage)
    const searched = response.usage.server_tool_use?.web_search_requests ?? 0
    searchesLeft = Math.max(0, searchesLeft - searched)
    out.costMicros += searched * WEB_SEARCH_MICROS
    out.inputTokens +=
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0)
    out.outputTokens += response.usage.output_tokens

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')
    for (const b of textBlocks)
      for (const c of b.citations ?? [])
        if (c.type === 'web_search_result_location') cited.push({ url: c.url, title: c.title })
    const text = textBlocks.map((b) => b.text).join('').trim()
    if (text) {
      out.reply = text + sourcesLine(cited)
      opts.onEvent({ type: 'text', text: out.reply })
    }

    if (response.stop_reason === 'refusal') {
      out.stop = 'refusal'
      out.reply = out.reply || 'I can’t help with that one.'
      return out
    }
    if (response.stop_reason === 'max_tokens') {
      out.stop = 'max_tokens'
      return out
    }
    // Appended whole, thinking blocks included, so the next iteration of THIS
    // conversation sees exactly what the model produced.
    messages.push({ role: 'assistant', content: response.content })
    if (response.stop_reason === 'pause_turn') continue
    if (response.stop_reason !== 'tool_use') return out

    // Every result in ONE user message, in call order. Run one at a time: two
    // edits racing over one draft ride would each route the other's legs.
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const r = await runTool(ctx, block.name, block.input)
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: r.text,
        ...(r.isError ? { is_error: true } : {}),
      })
    }
    messages.push({ role: 'user', content: results })
  }
  if (out.stop === 'done') out.stop = 'iterations'
  return out
}
