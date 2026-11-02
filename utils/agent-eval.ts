// Runs the planning assistant against utils/agent-eval/scenarios.ts and scores it
// (#437). The builder assistant's own loop, in memory: no server, no database, no
// rider's ride.
//
//   EVAL_ANTHROPIC_KEY=… npx tsx utils/agent-eval.ts --yes
//   EVAL_OPENAI_KEY=… npx tsx utils/agent-eval.ts --yes --provider openai --model gpt-6.1-sol
//   npx tsx utils/agent-eval.ts --yes --key-from-dev --model claude-opus-5-5
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
// --max-usd <n>, --google, --key-from-dev (the key DEV_LOGIN_EMAIL saved on Robots in a
// local dev database, so it never has to be exported into a shell). Results go to _PLANS/evals/, which is gitignored.
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
  const key = flag('key-from-dev')
    ? await devKey(provider)
    : provider === 'openai'
      ? process.env.EVAL_OPENAI_KEY
      : process.env.EVAL_ANTHROPIC_KEY
  if (!key) throw new Error(`set EVAL_${provider.toUpperCase()}_KEY, or pass --key-from-dev`)
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
  const { presetOf } = await import('../src/agent/summary')
  const { fuelRoleOf } = await import('../src/subgroups/rendezvous')
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
      // What the builder's surface resolves for every turn (src/routes/agent.ts), with
      // no database: a rider with no defaults and nobody's range on file, so a pedal
      // ride reads as one rather than as a fuel plan nobody computed.
      preset: presetOf(before, null),
      fuel: {
        rangeM: null,
        role: fuelRoleOf({ ridePower: before.power, rideVehicle: before.vehicle }),
        bindingBike: null,
        riders: 1,
        unknown: 1,
      },
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
  if (flag('key-from-dev')) await (await import('../src/db')).pool.end()
}

/** The dev rider's own stored key, read only from a local database: a key saved on a
 *  real deployment is a rider's, never the eval's. */
async function devKey(provider: 'anthropic' | 'openai'): Promise<string> {
  const { IS_LOCAL_DATABASE, DEV_LOGIN_EMAIL } = await import('../src/config')
  if (!IS_LOCAL_DATABASE) throw new Error('--key-from-dev reads a local dev database only')
  if (!DEV_LOGIN_EMAIL) throw new Error('--key-from-dev needs DEV_LOGIN_EMAIL')
  const { db, schema } = await import('../src/db')
  const { eq } = await import('drizzle-orm')
  const { openKeyOf } = await import('../src/agent/usage')
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, DEV_LOGIN_EMAIL))
  if (!user) throw new Error(`no account for ${DEV_LOGIN_EMAIL}`)
  const got = await openKeyOf(user.id, provider)
  if (!got || got.provider !== provider) throw new Error(`no usable ${provider} key saved for ${DEV_LOGIN_EMAIL}`)
  // The pool stays open for the run, since a scenario's tool may read the database;
  // main() ends it.
  return got.key
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err)
  process.exit(1)
})
