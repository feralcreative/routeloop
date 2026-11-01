// The planning assistant's two FAQ tools. Pure: they read src/content/faq.html from
// disk and nothing else, so no network and no database.
import { describe, expect, it } from 'vitest'
import { FAQ_SOURCE, getHelp, htmlToText, searchHelp } from '../src/agent/tools/help'
import type { AgentContext } from '../src/agent/tools'
import { parseFaq } from '../src/feedback/faq'
import { content } from '../src/views/content'
import { faqTokens } from '../src/views/faq-tokens'

// Both tools are ride-less and never read the context, which is what runRideless
// relies on when it hands them none.
const noCtx = undefined as unknown as AgentContext

describe('search_help', () => {
  it('finds the import entry for an obvious question', async () => {
    const out = await searchHelp.run(noCtx, { query: 'How do I import a GPX file?' })
    const lines = out.split('\n')
    expect(lines).toContain('import-a-route: Can I import a route I already have?')
    expect(lines.at(-1)).toBe(FAQ_SOURCE)
    expect(lines.length).toBeLessThanOrEqual(6)
  })

  it('says so plainly when nothing matches', async () => {
    const out = await searchHelp.run(noCtx, { query: 'zxqv qqzz' })
    expect(out).toMatch(/^Nothing in the FAQ matches/)
  })

  it('refuses a query outside 2 to 200 characters', () => {
    expect(searchHelp.schema.safeParse({ query: 'a' }).success).toBe(false)
    expect(searchHelp.schema.safeParse({ query: 'x'.repeat(201) }).success).toBe(false)
    expect(searchHelp.schema.safeParse({ query: 'ok', extra: 1 }).success).toBe(false)
  })

  it('needs no ride and changes nothing', () => {
    expect(searchHelp.cap).toEqual({ mutates: false, needs: 'none' })
    expect(getHelp.cap).toEqual({ mutates: false, needs: 'none' })
  })
})

describe('get_help', () => {
  it('renders a known entry as text, keeping link words and their paths', async () => {
    const out = await getHelp.run(noCtx, { id: 'visibility' })
    expect(out.startsWith('Can I keep a ride private?')).toBe(true)
    expect(out).not.toMatch(/<[a-z/]/i)
    expect(out).not.toContain('&nbsp;')
    expect(out).toContain('friends (/friends)')
    expect(out).toMatch(/^- Private/m)
    expect(out.endsWith(FAQ_SOURCE)).toBe(true)
  })

  it('leaves no markup and no unfilled token in any entry', async () => {
    const ids = parseFaq(content('faq.html', faqTokens())).map((e) => e.id)
    expect(ids.length).toBeGreaterThan(10)
    for (const id of ids) {
      const out = await getHelp.run(noCtx, { id })
      expect(out, id).not.toMatch(/<[a-z/!]/i)
      expect(out, id).not.toContain('{{')
      expect(out, id).not.toMatch(/^There is no FAQ entry/)
    }
  })

  it('says an unknown id is unknown and names the real ones', async () => {
    const out = await getHelp.run(noCtx, { id: 'no-such-entry' })
    expect(out).toMatch(/^There is no FAQ entry called "no-such-entry"/)
    expect(out).toContain('import-a-route')
  })
})

describe('htmlToText', () => {
  it('flattens paragraphs, lists, and links', () => {
    const html = '<p>One <strong>two</strong>&nbsp;three.</p><ul><li>A</li><li><a href="/x">B</a></li></ul>'
    expect(htmlToText(html)).toBe('One two three.\n\n- A\n- B (/x)')
  })
})
