// The knowledge pack (src/agent/knowledge/) and its doors.
//
// A topic with no file throws on the rider's first question about it, a file with
// no topic is knowledge nobody can reach, and a bloated core is paid for on every
// free-tier turn that misses the cache. All three fail here instead.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CORE, TOPIC_NAMES, topicText } from '../src/agent/knowledge'
import { READS, RIDELESS, TOOLS, runRideless } from '../src/agent/tools'

const words = (s: string) => s.split(/\s+/).filter(Boolean).length
const files = readdirSync('src/agent/knowledge')
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3))

describe('knowledge pack', () => {
  it('has a file for every topic and a topic for every file', () => {
    expect(files.filter((f) => f !== 'core').sort()).toEqual([...TOPIC_NAMES].sort())
  })

  it('keeps the always-present core small', () => {
    expect(words(CORE)).toBeGreaterThan(300)
    expect(words(CORE)).toBeLessThan(1600)
  })

  it('serves every topic, none empty and none past the size a turn can afford', () => {
    for (const t of TOPIC_NAMES) {
      const n = words(topicText(t))
      expect(n, t).toBeGreaterThan(200)
      expect(n, t).toBeLessThan(3500)
    }
  })

  it('names every topic in the core, so the model knows they exist', () => {
    for (const t of TOPIC_NAMES) expect(CORE, t).toContain(t)
  })
})

describe('guide tool', () => {
  it('is a ride-less read on both surfaces', () => {
    expect(TOOLS.some((t) => t.name === 'guide')).toBe(true)
    expect(READS.has('guide')).toBe(true)
    expect(RIDELESS.has('guide')).toBe(true)
  })

  it('returns the topic text, and refuses a topic that does not exist', async () => {
    const out = await runRideless('guide', { topic: 'ready-to-ride' })
    expect(out).toEqual({ text: topicText('ready-to-ride'), isError: false })
    expect((await runRideless('guide', { topic: 'nope' })).isError).toBe(true)
    expect((await runRideless('get_ride', {})).isError).toBe(true)
  })
})

describe('MCP annotations', () => {
  // Read as text: importing the server pulls in the database.
  const src = readFileSync('src/mcp/server.ts', 'utf8')
  const block = src.slice(src.indexOf('const ANNOTATIONS'), src.indexOf('}\n', src.indexOf('const ANNOTATIONS')))
  const annotated = new Set([...block.matchAll(/^\s+(\w+): \{/gm)].map((m) => m[1]))

  it('annotates every tool a host is shown', () => {
    for (const t of [...TOOLS.map((t) => t.name), 'list_rides', 'create_ride']) expect(annotated, t).toContain(t)
  })
})
