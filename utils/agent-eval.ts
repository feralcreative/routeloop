// Runs the planning assistant against utils/agent-eval/scenarios.ts and scores it
// (#437). The builder assistant's own loop, in memory: no server, no database, no
// rider's ride.
//
//   EVAL_ANTHROPIC_KEY=… npx tsx utils/agent-eval.ts --yes
//   EVAL_OPENAI_KEY=… npx tsx utils/agent-eval.ts --yes --provider openai --model gpt-6.1-sol
//   npx tsx utils/agent-eval.ts --list
//
// IT SPENDS MONEY, so it does nothing without --yes, stops starting scenarios once
// --max-usd (default 1) is spent, and prints the cost of every scenario. Never in CI.
// GOOGLE IS OFF unless --google: the server key is blanked before anything loads,
// so a search answers "not configured" and an edit's legs stay straight. Scenarios
// marked `google` are skipped without it.
//
// Flags: --provider anthropic|openai (default anthropic), --model <id> (default the
// free tier's model, or the provider's BYO default), --only <id,id>, --kind <kind>,
// --max-usd <n>, --google. Results go to _PLANS/evals/, which is gitignored.
import { mkdirSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

// Before anything reads the config, which happens at import.
if (!flag('google')) process.env.GMAPS_SERVER_KEY = ''

type Outcome = { id: string; pass: boolean; failures: string[]; costMicros: number; reply: string; tools: string[] }

async function main(): Promise<void> {
  const { SCENARIOS } = await import('./agent-eval/scenarios')
  const only = opt('only')?.split(',')
  const kind = opt('kind')
  const picked = SCENARIOS.filter(
    (s) => (!only || only.includes(s.id)) && (!kind || s.kind === kind) && (flag('google') || !s.google),
  )
  if (flag('list') || !flag('yes')) {
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(28)} ${s.kind}${s.google ? ' (needs --google)' : ''}`)
    if (!flag('list')) console.log('\nNothing run: pass --yes to spend money on a live run.')
    return
  }

  const provider = opt('provider') === 'openai' ? 'openai' : 'anthropic'
  const key = provider === 'openai' ? process.env.EVAL_OPENAI_KEY : process.env.EVAL_ANTHROPIC_KEY
  if (!key) throw new Error(`set EVAL_${provider.toUpperCase()}_KEY`)
  const { FREE_MODEL, DEFAULT_BYO_MODEL } = await import('../src/agent/policy')
  const model = opt('model') ?? (provider === 'anthropic' ? FREE_MODEL : DEFAULT_BYO_MODEL.openai)
  const maxUsd = Number(opt('max-usd') ?? 1)
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error('--max-usd must be a positive number')
  const maxMicros = Math.round(maxUsd * 1_000_000)

  // The config is read at import. Blanking the key above is what keeps Google off,
  // and dotenv's override mode would undo it, so check what actually loaded.
  const { GMAPS_SERVER_KEY } = await import('../src/config')
  if (!flag('google') && GMAPS_SERVER_KEY) throw new Error('Google is still configured; refusing without --google')
  const { Budget } = await import('../src/agent/budget')
  const { maxFuelGapMi } = await import('./agent-eval/scenarios')
  const { runTurn, emptyTurn } = await import('../src/agent/loop')
  const { runTurnOpenAI } = await import('../src/agent/loop-openai')
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const OpenAI = (await import('openai')).default
  type Ctx = import('../src/agent/tools').AgentContext

  const results: Outcome[] = []
  let spent = 0
  for (const s of picked) {
    if (spent >= maxMicros) {
      console.log(`\nStopped: $${(spent / 1e6).toFixed(3)} spent, the --max-usd ceiling.`)
      break
    }
    const before = s.ride()
    const searched = new Set<string>()
    const tools: string[] = []
    const ctx: Ctx = {
      ride: structuredClone(before),
      role: s.role ?? 'owner',
      snapshot: { kind: 'draft' },
      units: 'mi',
      budget: new Budget(0),
      favor: [],
      avoid: [],
      includeDetails: true,
      changes: [],
      progress: () => {},
      changed: false,
      trace: (name, _input, out) => {
        tools.push(out.isError ? `${name}!` : name)
        if (name === 'search_places')
          for (const m of out.text.matchAll(/lat (-?\d+\.\d+), lng (-?\d+\.\d+)/g))
            searched.add(`${Number(m[1]).toFixed(5)},${Number(m[2]).toFixed(5)}`)
      },
    }
    const out = emptyTurn()
    // The remaining allowance goes into the loop too, so a scenario cannot run on
    // past the ceiling for its remaining iterations.
    const opts = {
      model,
      effort: 'low' as const,
      ctx,
      history: [],
      message: s.message,
      onEvent: () => {},
      out,
      maxCostMicros: maxMicros - spent,
    }
    try {
      if (provider === 'anthropic') await runTurn({ ...opts, client: new Anthropic({ apiKey: key, maxRetries: 1 }) })
      else await runTurnOpenAI({ ...opts, client: new OpenAI({ apiKey: key, maxRetries: 1 }) })
    } catch (err) {
      out.reply = `THREW: ${err instanceof Error ? err.message : String(err)}`
    }
    spent += out.costMicros

    const failures: string[] = []
    const c = s.check
    for (const re of c.reply ?? []) if (!re.test(out.reply)) failures.push(`reply lacks ${re}`)
    for (const re of c.replyNot ?? []) if (re.test(out.reply)) failures.push(`reply matches ${re}`)
    if (c.unchanged && JSON.stringify(ctx.ride) !== JSON.stringify(before)) failures.push('changed the ride')
    if (c.noInventedPoints) {
      // Added OR moved: replace_stop keeps a point's uid and changes where it is.
      const was = new Map(before.routes.flatMap((r) => r.points.map((p) => [p.uid, `${p.lat},${p.lng}`] as const)))
      for (const r of ctx.ride.routes)
        for (const p of r.points)
          if (was.get(p.uid) !== `${p.lat},${p.lng}` && !searched.has(`${p.lat.toFixed(5)},${p.lng.toFixed(5)}`))
            failures.push(`placed "${p.name}" at a coordinate no search returned`)
    }
    if (c.maxFuelGapMi != null) {
      const gap = maxFuelGapMi(ctx.ride)
      if (gap > c.maxFuelGapMi) failures.push(`still ${gap.toFixed(0)} mi between fills`)
    }
    for (const name of c.calls ?? []) if (!tools.includes(name)) failures.push(`never called ${name} successfully`)
    const o = { id: s.id, pass: failures.length === 0, failures, costMicros: out.costMicros, reply: out.reply, tools }
    results.push(o)
    console.log(
      `\n${o.pass ? 'PASS' : 'FAIL'} ${s.id}  $${(o.costMicros / 1e6).toFixed(4)}  tools: ${tools.join(' ') || 'none'}`,
    )
    for (const f of failures) console.log(`  - ${f}`)
    console.log(`  > ${out.reply.replace(/\n+/g, ' ').slice(0, 400)}`)
  }

  const passed = results.filter((r) => r.pass).length
  console.log(`\n${passed}/${results.length} passed on ${provider} ${model}, $${(spent / 1e6).toFixed(3)} spent.`)
  mkdirSync('_PLANS/evals', { recursive: true })
  const file = `_PLANS/evals/${new Date().toISOString().replace(/[:.]/g, '-')}-${provider}-${model}.json`
  writeFileSync(file, JSON.stringify({ provider, model, google: flag('google'), spentMicros: spent, results }, null, 2))
  console.log(`Results: ${file}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err)
  process.exit(1)
})
