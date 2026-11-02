// What an agent turn costs and whether it may run. PURE; usage.ts is the query half.
//
// THE FREE TIER IS A CEILING, NOT A PRICE. Nobody is billed and nothing is marked
// up: Routeloop pays for a small monthly allowance per rider on the cheapest model,
// stops when it is spent, and stops for everybody when the app-wide ceiling is
// reached. A rider who wants more brings their own Anthropic or OpenAI key, which
// carries no cap here because it is their money. The free tier is Anthropic only.
//
// GOOGLE IS THE EXPOSURE THAT EVERY SURFACE SHARES. A rider's own key pays for
// tokens and an MCP client pays for none, but every place search and every routed
// leg the agent asks for runs on GMAPS_SERVER_KEY whichever surface asked. So the
// per-turn and per-day Google budgets apply to all three sources, BYO included.

export type Source = 'free' | 'byo' | 'mcp'

export const FREE_MODEL = 'claude-haiku-5-5'

/** Whose API a rider's own key is for. Order is the fallback when a rider holds
 *  both and has marked neither as the default. */
export const PROVIDERS = ['anthropic', 'openai'] as const
export type Provider = (typeof PROVIDERS)[number]
export const isProvider = (v: unknown): v is Provider => PROVIDERS.includes(v as Provider)

export const PROVIDER_NAMES: Record<Provider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }
/** What the assistant window's switch says: the model family, not the company. */
export const PROVIDER_SHORT: Record<Provider, string> = { anthropic: 'Claude', openai: 'GPT' }

/** Each provider's models, most capable first, with how Robots describes them. */
export const BYO_MODELS: Record<Provider, readonly { id: string; label: string }[]> = {
  anthropic: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5, the most capable' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5, balanced' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5, the cheapest' },
  ],
  openai: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra, the most capable' },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol, balanced' },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra, lighter' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna, the cheapest' },
  ],
}
export const DEFAULT_BYO_MODEL: Record<Provider, string> = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-6.1-sol' }

/** A posted model id if it belongs to that provider, its default otherwise. */
export const modelFor = (provider: Provider, asked: unknown): string =>
  BYO_MODELS[provider].some((m) => m.id === asked) ? (asked as string) : DEFAULT_BYO_MODEL[provider]

/** Which stored key answers a turn: the one the rider switched to in the window if
 *  they hold it, else the one marked default, else the first in PROVIDERS order.
 *  Null when they hold none. */
export function pickProvider(
  stored: readonly { provider: Provider; isDefault: boolean }[],
  asked?: Provider | null,
): Provider | null {
  if (asked && stored.some((k) => k.provider === asked)) return asked
  const marked = stored.find((k) => k.isDefault)
  if (marked) return marked.provider
  return PROVIDERS.find((p) => stored.some((k) => k.provider === p)) ?? null
}

/** THE FREE TIER IS OFF. Ziad's call, 2026-11-01: for the foreseeable future the
 *  assistant runs on a rider's own Anthropic or OpenAI key, or through Claude or
 *  ChatGPT over MCP, and Routeloop pays for no model tokens. A code switch rather
 *  than AI_FREE_MONTHLY_USD=0 so it holds whatever a server's .env says; the
 *  allowance below and the ceiling stay for the day it comes back. */
export const FREE_TIER_ON = false

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
// From the Anthropic and OpenAI price lists as of 2026-10-31. OpenAI's cache write
// is 1.25 times its input price, which its table does not print as a column.
// A model missing here is costed as the most expensive one listed, so an unknown
// model can never read as free.
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'gpt-6-astra': [10, 50, 1, 12.5],
  'gpt-6.1-sol': [2, 10, 0.1, 2.5],
  'gpt-6.1-terra': [1, 5, 0.05, 1.25],
  'gpt-6-luna': [0.1, 0.5, 0.01, 0.125],
}
const WORST = PRICES['gpt-6-astra']

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
  off: 'The assistant runs on your own Anthropic or OpenAI key. Add one under Robots in your account settings, or connect Claude or ChatGPT to Routeloop from the same page.',
  'rider-cap':
    'You have used this month’s free assistant allowance. It resets on the 1st, or you can add your own Anthropic or OpenAI key under Robots in your account settings.',
  'global-cap':
    'The free assistant has used its budget for this month. It resets on the 1st, or you can add your own Anthropic or OpenAI key under Robots in your account settings.',
  'google-cap': 'The assistant has made as many map searches as it can for you today. It resets at midnight UTC.',
}

export const monthOf = (d: Date) => d.toISOString().slice(0, 7)
export const dayOf = (d: Date) => d.toISOString().slice(0, 10)

/** Money as a rider reads it: "$0.12". */
export const dollars = (micros: number) => '$' + (micros / 1_000_000).toFixed(2)
