// The knowledge pack (src/agent/knowledge/) and its doors.
//
// A topic with no file throws on the rider's first question about it, a file with
// no topic is knowledge nobody can reach, and a bloated core is paid for on every
// free-tier turn that misses the cache. All three fail here instead.
import { readdirSync } from 'node:fs'
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

describe('topic provenance', () => {
  it('gives every topic valid front matter, and opens every topic with what it is', async () => {
    const { topicMeta } = await import('../src/agent/knowledge')
    for (const t of TOPIC_NAMES) {
      expect(topicMeta(t), t).not.toBeNull()
      expect(topicText(t), t).toMatch(/^About this topic: /)
      expect(topicText(t), t).not.toMatch(/^---$/m)
    }
  })

  it('tells the model an unreviewed riding topic is rules of thumb', async () => {
    const { aboutLine } = await import('../src/agent/knowledge')
    expect(aboutLine({ kind: 'riding', reviewed: 'pending' })).toMatch(/not yet reviewed by Ziad/)
    expect(aboutLine({ kind: 'app', checked: '2026-10-31' })).toMatch(/2026-10-31/)
  })
})

describe('cite', () => {
  it('renders provenance the model can repeat', async () => {
    const { cite } = await import('../src/agent/provenance')
    expect(cite({ kind: 'computed', source: 'Routeloop' })).toBe('[computed by Routeloop]')
    expect(cite({ kind: 'official', source: 'Caltrans', asOf: '2026-11-02', checkedAt: '2026-11-02 14:05' })).toBe(
      '[official: Caltrans, as of 2026-11-02, checked 2026-11-02 14:05]',
    )
    expect(cite({ kind: 'rider-report', source: 'a rider', asOf: '2026-10-20' })).toBe(
      '[rider report, unverified: a rider, as of 2026-10-20]',
    )
  })
})
