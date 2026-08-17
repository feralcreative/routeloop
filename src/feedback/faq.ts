// The FAQ, as data, so the question path can answer a rider before they send.
//
// Pure and text-in/text-out, which is what lets test/feedback-faq.test.ts cover
// the matching with no database and no browser. The route reads
// src/content/faq.html through the usual `content()` helper and hands the string
// here; nothing in this file touches the filesystem.
//
// Why this exists at all: the question path is the one kind where the best
// outcome is that we never see the report. A rider who finds their answer in
// three seconds is better served than one who waits a day for an email, and it
// costs us a list of 24 headings.

/** One question, addressable by the anchor it already has on /faq. Those ids are
 *  a public contract — other pages link to them — so they are read out of the
 *  markup rather than derived from the wording. */
export type FaqEntry = { id: string; q: string }

// <details id="…"> … <summary>Question</summary>. Deliberately narrow: it matches
// the shape faq.html actually has rather than trying to be an HTML parser, and a
// heading that stops matching shows up as a missing suggestion, never as a
// broken page.
const ENTRY = /<details[^>]*\bid="([^"]+)"[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>/gi

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every question in the FAQ, in document order. Returns an empty list rather
 *  than throwing if the markup changes shape — a missing suggestion strip is a
 *  smaller failure than a 500 on the intake. */
export function parseFaq(html: string): FaqEntry[] {
  const out: FaqEntry[] = []
  for (const m of html.matchAll(ENTRY)) {
    const q = stripTags(m[2])
    if (q) out.push({ id: m[1], q })
  }
  return out
}

// Words carrying no signal in a question about a route planner. "route", "ride"
// and "map" are absent on purpose: they are the most common words a rider will
// type and also the ones that distinguish one FAQ entry from another here.
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'can',
  'do',
  'does',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'my',
  'of',
  'on',
  'or',
  'the',
  'this',
  'to',
  'what',
  'when',
  'where',
  'why',
  'will',
  'with',
  'you',
  'your',
])

/** Lowercased words of three characters or more, minus the stop list. Curly
 *  apostrophes are folded so "what's" and "what’s" tokenize alike — the FAQ copy
 *  uses curly ones and a phone keyboard produces them too. */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
}

/**
 * The FAQ entries most likely to answer this text, best first.
 *
 * Scoring is deliberately crude — shared tokens, with a prefix match counting
 * less than an exact one. A rider gets three suggestions above a textarea they
 * are already typing into; the cost of a mediocre third suggestion is that they
 * ignore it, and anything cleverer would need a dependency and an index for a
 * list of 24 strings.
 *
 * Returns nothing at all below a threshold, which matters more than the ranking:
 * three irrelevant suggestions under every question teach a rider to stop
 * looking at the strip.
 */
export function matchFaq(entries: FaqEntry[], text: string, limit = 3): FaqEntry[] {
  const words = tokenize(text)
  if (words.length === 0) return []

  const scored = entries
    .map((e) => {
      const target = tokenize(e.q)
      let score = 0
      for (const w of words) {
        if (target.includes(w)) score += 2
        else if (target.some((t) => t.startsWith(w) || w.startsWith(t))) score += 1
      }
      return { e, score }
    })
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, limit).map((s) => s.e)
}
