// Two ride-less tools that answer a rider's how-to question from the FAQ.
//
// ONE SOURCE, THREE SURFACES: the copy stays in `src/content/faq.html`, read the
// same way /faq, the `?` popovers and the feedback strip read it, so what the
// assistant says about how Routeloop works cannot drift from what the page says.
// The matcher is the feedback strip's own `matchFaq()` and the answer is cut out by
// `faqAnswer()`; nothing here is a second implementation of either.
//
// Neither tool touches the context, which is what `needs: 'none'` promises.
import { z } from 'zod'
import { faqAnswer, matchFaq, parseFaq } from '../../feedback/faq'
import { content } from '../../views/content'
import { faqTokens } from '../../views/faq-tokens'
import type { Tool } from '../tools'

// The same identity helper tools.ts uses, so each schema types its own run().
const tool = <S extends z.ZodObject>(t: Tool<S>) => t

/** The line every answer from the FAQ ends with, in cite()'s bracketed style so the
 *  model repeats it the same way it repeats every other source. */
export const FAQ_SOURCE = '[From Routeloop’s FAQ]'

/** The most entries one search returns. */
const SEARCH_LIMIT = 5

// Rendered per call rather than cached: content() already caches the file by mtime,
// and the tokens (the years, the release stage) are worked out per call on purpose.
const faqHtml = (): string => content('faq.html', faqTokens())

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': '’',
  '&apos;': '’',
}

/**
 * An answer's markup as compact text a model can read and repeat.
 *
 * Narrow on purpose, like the rest of faq.ts: it handles the handful of tags the
 * FAQ actually uses (p, ul/li, a, strong, em, code, and a nested details/summary)
 * rather than pretending to be an HTML parser. A link keeps its words and gains its
 * address in parentheses, because "the privacy page" is useless to a rider reading
 * it in a chat with no link in it.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(
      /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href: string, words: string) => `${words} (${href})`,
    )
    .replace(/<summary[^>]*>([\s\S]*?)<\/summary>/gi, '\n\n$1\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|ul|ol|div|details|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39|apos);/g, (e) => ENTITIES[e] ?? e)

  return text
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const searchHelp = tool({
  name: 'search_help',
  cap: { mutates: false, needs: 'none' },
  description:
    'Find the entries in Routeloop’s FAQ that answer a rider’s question about how Routeloop works (importing a route, sharing, privacy, limits, what a stop or POI is, why a GPS ignores the route). Returns up to 5 entries as `id: question`; read one with get_help before answering from it.',
  schema: z.object({ query: z.string().min(2).max(200).describe('The rider’s question, in their words') }).strict(),
  run: async (_ctx, input) => {
    const hits = matchFaq(parseFaq(faqHtml()), input.query, SEARCH_LIMIT)
    if (hits.length === 0) {
      return 'Nothing in the FAQ matches that question. Answer from the guide topics instead, or say you do not know.'
    }
    return [...hits.map((e) => `${e.id}: ${e.q}`), FAQ_SOURCE].join('\n')
  },
})

export const getHelp = tool({
  name: 'get_help',
  cap: { mutates: false, needs: 'none' },
  description:
    'Read one entry of Routeloop’s FAQ, question and answer, as plain text. Take the id from search_help. Quote or paraphrase it faithfully; it is Routeloop’s own answer.',
  schema: z
    .object({
      id: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9-]+$/)
        .describe('An FAQ entry id from search_help, e.g. import-a-route'),
    })
    .strict(),
  run: async (_ctx, input) => {
    const html = faqHtml()
    const entry = parseFaq(html).find((e) => e.id === input.id)
    const answer = entry ? faqAnswer(html, entry.id) : null
    if (!entry || answer === null) {
      const ids = parseFaq(html).map((e) => e.id)
      return `There is no FAQ entry called "${input.id}". The entries are: ${ids.join(', ')}.`
    }
    return `${entry.q}\n\n${htmlToText(answer)}\n\n${FAQ_SOURCE}`
  },
})
