// One agent turn on a rider's own OpenAI key: loop.ts's turn, on the Responses API.
//
// THE SAME LOOP ON PURPOSE: the same system prompt, the same opening message, the
// same tools and the same caps, so which key answers changes the model and nothing
// about what it may do or what it costs Google. Only the wire shape differs.
//
// THE RESPONSES API, NOT CHAT COMPLETIONS, because the models offered take tools
// only there: Astra, 6.1 Sol and 6.1 Terra refuse tool calls on Chat Completions,
// and Luna allows them only with reasoning switched off (OpenAI's latest-model
// guide, read 2026-10-31). The first version here was Chat Completions and would
// have failed on every GPT option the first time a rider asked for anything.
//
// STATELESS, LIKE EVERY TURN: `store: false`, and each call sends the whole turn so
// far. The reasoning items come back encrypted (`include`) and are sent back
// verbatim with the function calls they led to, which is what the API needs to
// carry the model's reasoning across a tool call without OpenAI keeping anything.
import type OpenAI from 'openai'
import { costMicros, TURN_LIMITS } from './policy'
import { inputSchemaOf, runTool, TOOLS } from './tools'
import { emptyTurn, openingMessage, SYSTEM, type TurnOptions, type TurnResult } from './loop'

type Item = OpenAI.Responses.ResponseInputItem

export async function runTurnOpenAI(opts: TurnOptions<OpenAI>): Promise<TurnResult> {
  const { client, model, ctx } = opts
  const tools: OpenAI.Responses.FunctionTool[] = TOOLS.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: inputSchemaOf(t) as Record<string, unknown>,
    // Strict mode wants every property required, which optional tool arguments are
    // not. The arguments are parsed by the tool's own zod schema either way.
    strict: false,
  }))

  const input: Item[] = [{ role: 'user', content: openingMessage(ctx, opts.history, opts.message) }]
  const out: TurnResult = opts.out ?? emptyTurn()
  ctx.progress = (text) => opts.onEvent({ type: 'progress', text })

  for (let i = 0; i < TURN_LIMITS.iterations; i++) {
    if (opts.maxCostMicros != null && out.costMicros >= opts.maxCostMicros) {
      out.stop = 'budget'
      break
    }
    const response = await client.responses.create({
      model,
      instructions: SYSTEM,
      input,
      tools,
      reasoning: { effort: opts.effort },
      max_output_tokens: 8000,
      store: false,
      include: ['reasoning.encrypted_content'],
    })

    // input_tokens INCLUDES the cached and cache-written ones, which are priced
    // apart; output_tokens includes the reasoning.
    const usage = response.usage
    const cached = usage?.input_tokens_details?.cached_tokens ?? 0
    const written = usage?.input_tokens_details?.cache_write_tokens ?? 0
    const inputTokens = usage?.input_tokens ?? 0
    const outputTokens = usage?.output_tokens ?? 0
    out.costMicros += costMicros(model, {
      input_tokens: Math.max(0, inputTokens - cached - written),
      output_tokens: outputTokens,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: written,
    })
    out.inputTokens += inputTokens
    out.outputTokens += outputTokens

    const text = response.output_text.trim()
    if (text) {
      out.reply = text
      opts.onEvent({ type: 'text', text })
    }

    const refused = response.output.some(
      (o) => o.type === 'message' && o.content.some((c) => c.type === 'refusal'),
    )
    const incomplete = response.status === 'incomplete' ? response.incomplete_details?.reason : undefined
    if (refused || incomplete === 'content_filter') {
      out.stop = 'refusal'
      out.reply = out.reply || 'I can’t help with that one.'
      return out
    }
    if (incomplete === 'max_output_tokens') {
      out.stop = 'max_tokens'
      return out
    }

    const calls = response.output.filter(
      (o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === 'function_call',
    )
    if (!calls.length) return out
    // Everything the model produced goes back, reasoning included, so the next call
    // of THIS turn continues from it.
    input.push(...(response.output as Item[]))

    // One at a time and in call order, for the reason loop.ts gives.
    for (const call of calls) {
      let args: unknown
      try {
        args = JSON.parse(call.arguments || '{}')
      } catch {
        input.push({ type: 'function_call_output', call_id: call.call_id, output: 'Error: the arguments were not valid JSON.' })
        continue
      }
      const r = await runTool(ctx, call.name, args)
      // No is_error flag on this API, so an error says so in its own text.
      input.push({ type: 'function_call_output', call_id: call.call_id, output: r.isError ? `Error: ${r.text}` : r.text })
    }
  }
  if (out.stop === 'done') out.stop = 'iterations'
  return out
}
