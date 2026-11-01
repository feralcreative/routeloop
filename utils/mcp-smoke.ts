// Connects a real MCP client to the LOCAL dev server and walks every door (#441):
// the instructions, every tool and its annotations, the guide resources and the
// prompts, then a read-only pass over one of the dev rider's rides and a proposal
// that is made and discarded, never applied.
//
//   npm run dev                      (in another terminal)
//   npx tsx utils/mcp-smoke.ts
//
// DEV ONLY, AND IT REFUSES ANYTHING ELSE: it mints an OAuth token straight into the
// database for DEV_LOGIN_EMAIL, which is exactly what must never be possible
// against stage or production. So it checks the DATABASE as well as the origin, and
// the client it registers is deleted on the way out, its codes and tokens with it
// by cascade, including on Ctrl-C. If the rider already has pending MCP changes on
// the ride it picks, the proposal pass is skipped rather than built on.
//
// What a hosted client (Claude.ai, ChatGPT) does with the same server is not
// tested here; those need a public origin and a person at the keyboard.
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { APP_ORIGIN, DEV_LOGIN_EMAIL, IS_DEV, IS_LOCAL_DATABASE } from '../src/config'
import { db } from '../src/db/index'
import { oauthClients, users } from '../src/db/schema'
import { issueCode, redeemCode, registerClient } from '../src/oauth/service'
import { s256 } from '../src/oauth/policy'

type Text = { content?: Array<{ type: string; text?: string }>; isError?: boolean }
const textOf = (r: unknown) =>
  ((r as Text).content ?? [])
    .map((c) => c.text ?? '')
    .join('\n')
    .trim()
const first = (s: string, n: number) => s.split('\n').slice(0, n).join('\n')

let failures = 0
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures++
}

async function main(): Promise<void> {
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(APP_ORIGIN)
  if (!IS_DEV || !local) throw new Error(`refusing: APP_ORIGIN is ${APP_ORIGIN}, not a local dev server`)
  if (!IS_LOCAL_DATABASE) throw new Error('refusing: DATABASE_URL is not a local database')
  if (!DEV_LOGIN_EMAIL) throw new Error('set DEV_LOGIN_EMAIL in .env to the dev rider')
  const [user] = await db.select().from(users).where(eq(users.email, DEV_LOGIN_EMAIL)).limit(1)
  if (!user) throw new Error(`no user ${DEV_LOGIN_EMAIL} in the dev database`)

  const redirect = 'http://127.0.0.1/smoke'
  const clientId = await registerClient('mcp-smoke', [redirect])
  // Deleting the client takes its codes and tokens with it (ON DELETE CASCADE).
  // Retried, and run on Ctrl-C too, because a grant left behind is a live credential.
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    for (let i = 0; i < 3 && !cleaned; i++) {
      try {
        await db.delete(oauthClients).where(eq(oauthClients.id, clientId))
        cleaned = true
      } catch (err) {
        if (i === 2) console.error(`could not delete OAuth client ${clientId}; delete it by hand`, err)
      }
    }
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.once(sig, () => void cleanup().finally(() => process.exit(130)))
  try {
    const verifier = randomBytes(32).toString('base64url')
    const code = await issueCode(clientId, user.id, redirect, s256(verifier))
    const tokens = await redeemCode({ code, clientId, redirectUri: redirect, verifier })
    if (!tokens) throw new Error('could not redeem the code')

    const client = new Client({ name: 'routeloop-smoke', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${APP_ORIGIN}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      }),
    )

    const instructions = client.getInstructions() ?? ''
    check(instructions.includes('apply_changes'), `instructions (${instructions.length} chars) explain apply_changes`)

    const { tools } = await client.listTools()
    console.log(`\ntools (${tools.length}):`)
    for (const t of tools) {
      const a = t.annotations ?? {}
      const hints = [a.readOnlyHint && 'read-only', a.destructiveHint && 'destructive', a.openWorldHint && 'open-world']
      console.log(`  ${t.name.padEnd(16)} ${hints.filter(Boolean).join(', ') || 'writes'}`)
      check(a.readOnlyHint !== undefined && a.openWorldHint !== undefined, `${t.name} states its hints`)
    }
    for (const name of ['guide', 'get_ride', 'apply_changes', 'review_changes', 'discard_changes'])
      check(
        tools.some((t) => t.name === name),
        `has ${name}`,
      )

    const { resources } = await client.listResources()
    check(resources.length === 12, `${resources.length} guide resources`)
    const res = await client.readResource({ uri: 'routeloop://guide/ready-to-ride' })
    const resText = (res.contents[0] as { text?: string }).text ?? ''
    check(resText.startsWith('About this topic:'), 'a resource opens with its provenance line')

    const { prompts } = await client.listPrompts()
    check(
      ['plan_a_ride', 'check_my_ride'].every((n) => prompts.some((p) => p.name === n)),
      `prompts: ${prompts.map((p) => p.name).join(', ')}`,
    )

    const guide = textOf(await client.callTool({ name: 'guide', arguments: { topic: 'pacing' } }))
    check(guide.startsWith('About this topic:'), 'guide answers with no ride_id')

    const list = textOf(await client.callTool({ name: 'list_rides', arguments: {} }))
    console.log(`\nlist_rides:\n${first(list, 3)}`)
    const id = Number(/^(\d+):/m.exec(list)?.[1])
    if (!id) {
      console.log('\nThe dev rider has no rides; skipping the ride pass.')
    } else {
      const ride = textOf(await client.callTool({ name: 'get_ride', arguments: { ride_id: id } }))
      console.log(`\nget_ride ${id}:\n${first(ride, 4)}`)
      check(/As saved \(revision \d+\)\./.test(ride), 'get_ride names the saved revision')

      // A proposal that is made and thrown away: the ride itself is never written.
      const route = /^Route 1 \[(\w+)\]/m.exec(ride)?.[1]
      const point = /^ {2}0\. \[(\w+)\]/m.exec(ride)?.[1]
      const pending = textOf(await client.callTool({ name: 'review_changes', arguments: { ride_id: id } }))
      if (!pending.startsWith('There are no pending changes')) {
        console.log('\nThe dev rider has pending MCP changes on this ride; skipping the proposal pass.')
      } else if (route && point) {
        const edit = await client.callTool({
          name: 'rename_route',
          arguments: { ride_id: id, route_uid: route, title: 'Smoke test' },
        })
        check(textOf(edit).includes('Not saved yet'), 'an edit lands in a proposal, not the ride')
        const after = textOf(await client.callTool({ name: 'get_ride', arguments: { ride_id: id } }))
        check(after.includes('plus 1 change'), 'get_ride shows the pending change')
        check(
          textOf(await client.callTool({ name: 'review_changes', arguments: { ride_id: id } })).includes('Renamed'),
          'review_changes lists it',
        )
        await client.callTool({ name: 'discard_changes', arguments: { ride_id: id } })
        const clean = textOf(await client.callTool({ name: 'get_ride', arguments: { ride_id: id } }))
        check(!/changes? you proposed/.test(clean), 'discard_changes leaves the ride as saved')
      }
    }
    await client.close()
  } finally {
    await cleanup()
  }
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err)
  process.exit(1)
})
