// What an agent turn costs and whether it may run. PURE; usage.ts is the query half.
//
// THE FREE TIER IS A CEILING, NOT A PRICE. Nobody is billed and nothing is marked
// up: Routeloop pays for a small monthly allowance per rider on the cheapest model,
// stops when it is spent, and stops for everybody when the app-wide ceiling is
// reached. A rider who wants more brings their own Anthropic key, which carries no
// cap here because it is their money.
//
// GOOGLE IS THE EXPOSURE THAT EVERY SURFACE SHARES. A rider's own key pays for
// tokens and an MCP client pays for none, but every place search and every routed
// leg the agent asks for runs on GMAPS_SERVER_KEY whichever surface asked. So the
// per-turn and per-day Google budgets apply to all three sources, BYO included.

export type Source = 'free' | 'byo' | 'mcp'

export const FREE_MODEL = 'claude-haiku-5-5'
export const BYO_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const
export type ByoModel = (typeof BYO_MODELS)[number]
export const DEFAULT_BYO_MODEL: ByoModel = 'claude-sonnet-5-5'

/** Per rider per calendar month (UTC), in micro-dollars. $0.50. */
export const FREE_MONTHLY_MICROS = 500_000

/** One turn's ceilings. A turn that reaches one stops and says so. */
export const TURN_LIMITS = {
  iterations: 12,
  placeSearches: 6,
  legRoutings: 30,
} as const

/** Google calls the agent may make for one rider in one UTC day, across every
 *  source. A builder session by hand makes far more than this; an agent asked to
 *  "find gas every 100 miles on all nine days" is what it bounds. */
export const DAILY_GOOGLE_CALLS = 300

// Dollars per million tokens: [input, output, cache read, cache write (5 min)].
// From the Anthropic price list as of 2026-10; a model missing here is costed as
// the most expensive one listed, so an unknown model can never read as free.
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
  'claude-opus-5-5': [4, 20, 0.2, 5],
}
const WORST = PRICES['claude-opus-5-5']

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/** What one response cost, in micro-dollars, rounded UP so a long run of tiny
 *  turns can never add up to less than it cost. */
export function costMicros(model: string, u: Usage): number {
  const [inp, out, read, write] = PRICES[model] ?? WORST
  const dollars =
    (u.input_tokens * inp +
      u.output_tokens * out +
      (u.cache_read_input_tokens ?? 0) * read +
      (u.cache_creation_input_tokens ?? 0) * write) /
    1_000_000
  return Math.ceil(dollars * 1_000_000)
}

export type FreeTierState = {
  /** The app has a key and a non-zero global ceiling. */
  configured: boolean
  riderSpentMicros: number
  globalSpentMicros: number
  globalCeilingMicros: number
}

export type FreeTierAnswer =
  { ok: true; remainingMicros: number } | { ok: false; reason: 'off' | 'rider-cap' | 'global-cap' }

/** Whether a free-tier turn may START, and the most it may spend: the smaller of
 *  what is left of the rider's month and of the app's. The turn stops starting new
 *  model calls at that line, so a running turn overshoots by at most one call, and
 *  riders running turns at the same moment by one call each. */
export function freeTierAllows(s: FreeTierState): FreeTierAnswer {
  if (!s.configured || s.globalCeilingMicros <= 0) return { ok: false, reason: 'off' }
  if (s.globalSpentMicros >= s.globalCeilingMicros) return { ok: false, reason: 'global-cap' }
  if (s.riderSpentMicros >= FREE_MONTHLY_MICROS) return { ok: false, reason: 'rider-cap' }
  return {
    ok: true,
    remainingMicros: Math.min(FREE_MONTHLY_MICROS - s.riderSpentMicros, s.globalCeilingMicros - s.globalSpentMicros),
  }
}

export const REFUSALS: Record<'off' | 'rider-cap' | 'global-cap' | 'google-cap', string> = {
  off: 'The free assistant is switched off right now. You can add your own Anthropic key in Preferences.',
  'rider-cap':
    'You have used this month’s free assistant allowance. It resets on the 1st, or you can add your own Anthropic key in Preferences.',
  'global-cap':
    'The free assistant has used its budget for this month. It resets on the 1st, or you can add your own Anthropic key in Preferences.',
  'google-cap': 'The assistant has made as many map searches as it can for you today. It resets at midnight UTC.',
}

export const monthOf = (d: Date) => d.toISOString().slice(0, 7)
export const dayOf = (d: Date) => d.toISOString().slice(0, 10)

/** Money as a rider reads it: "$0.12". */
export const dollars = (micros: number) => '$' + (micros / 1_000_000).toFixed(2)
