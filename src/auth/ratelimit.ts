// A sliding-window counter, shared by every endpoint that can be walked.
//
// Extracted from the per-IP guard in magic.ts, which was the only limiter in the
// app and was written inline for one caller. There are three callers now, and
// three copies of "keep an array of timestamps and prune it" is three chances to
// get the pruning wrong and leak memory.
//
// **In-memory, and therefore per-process.** That is honest for a single
// container and is not a distributed limiter: two containers behind a load
// balancer would each allow the full quota. Anything that must hold across
// processes needs a database-backed count, the way magic.ts counts login_tokens
// rows per address — this is the cheap guard layered on top of that, not a
// replacement for it.
const WINDOW_MS = 60 * 60 * 1000

// Bounded so a flood of distinct keys cannot grow the map without limit. Pruned
// lazily on write rather than on a timer, because a timer keeps the process
// awake and there is nothing to prune when nothing is arriving.
const MAX_KEYS = 5000

const hits = new Map<string, number[]>()

export type Limit = { max: number; windowMs?: number }

/**
 * Records an attempt and reports whether it is within the limit.
 *
 * Counts the current attempt, so `max: 5` allows five and rejects the sixth.
 * The namespace keeps callers from colliding: an IP hitting the sign-in form
 * and the same IP checking usernames are separate budgets.
 */
export function allow(namespace: string, key: string, limit: Limit): boolean {
  const windowMs = limit.windowMs ?? WINDOW_MS
  const now = Date.now()
  const id = `${namespace}:${key}`

  const recent = (hits.get(id) ?? []).filter((t) => now - t < windowMs)
  recent.push(now)
  hits.set(id, recent)

  if (hits.size > MAX_KEYS) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k)
  }

  return recent.length <= limit.max
}

/** Callers behind Cloudflare get the real client address; local dev does not. */
export const clientIp = (headers: { get(name: string): string | null }): string =>
  headers.get('cf-connecting-ip') ?? headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'

// Only for tests: the map is process-global and a test that fills it would
// otherwise leak into the next one.
export function _reset(): void {
  hits.clear()
}
