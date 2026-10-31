// The only reader and writer of `ai_usage` and `ai_keys`. policy.ts decides;
// this file counts and stores.
import { and, eq, like, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { aiKeys, aiUsage } from '../db/schema'
import { AI_FREE_MONTHLY_USD, AI_KEY_ENCRYPTION_KEY, ANTHROPIC_API_KEY } from '../config'
import { dayOf, isProvider, monthOf, pickProvider, PROVIDERS, type FreeTierState, type Provider, type Source } from './policy'
import { LOOKS_LIKE, masterKey, open, seal } from './sealed-key'

const MASTER = masterKey(AI_KEY_ENCRYPTION_KEY)

/** BYO keys can only be stored when there is a master key to seal them under. */
export const BYO_ENABLED = MASTER !== null

export async function freeTierState(userId: number, now = new Date()): Promise<FreeTierState> {
  const month = monthOf(now) + '-%'
  const [mine, all] = await Promise.all([
    db
      .select({ s: sql<number>`coalesce(sum(${aiUsage.costMicros}), 0)::bigint` })
      .from(aiUsage)
      .where(and(eq(aiUsage.userId, userId), eq(aiUsage.source, 'free'), like(aiUsage.day, month))),
    db
      .select({ s: sql<number>`coalesce(sum(${aiUsage.costMicros}), 0)::bigint` })
      .from(aiUsage)
      .where(and(eq(aiUsage.source, 'free'), like(aiUsage.day, month))),
  ])
  return {
    configured: ANTHROPIC_API_KEY !== '',
    riderSpentMicros: Number(mine[0]?.s ?? 0),
    globalSpentMicros: Number(all[0]?.s ?? 0),
    globalCeilingMicros: Math.max(0, Math.round(AI_FREE_MONTHLY_USD * 1_000_000)),
  }
}

/** Google calls this rider's agent has made today, across every source. */
export async function googleCallsToday(userId: number, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${aiUsage.googleCalls}), 0)::int` })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), eq(aiUsage.day, dayOf(now))))
  return Number(row?.n ?? 0)
}

export type TurnSpend = { costMicros: number; inputTokens: number; outputTokens: number; googleCalls: number }

/** Adds one turn to today's row, creating it on the first. */
export async function recordTurn(userId: number, source: Source, spend: TurnSpend, now = new Date()): Promise<void> {
  await db
    .insert(aiUsage)
    .values({ userId, day: dayOf(now), source, ...spend, turns: 1 })
    .onConflictDoUpdate({
      target: [aiUsage.userId, aiUsage.day, aiUsage.source],
      set: {
        costMicros: sql`${aiUsage.costMicros} + ${spend.costMicros}`,
        inputTokens: sql`${aiUsage.inputTokens} + ${spend.inputTokens}`,
        outputTokens: sql`${aiUsage.outputTokens} + ${spend.outputTokens}`,
        googleCalls: sql`${aiUsage.googleCalls} + ${spend.googleCalls}`,
        turns: sql`${aiUsage.turns} + 1`,
      },
    })
}

// --- A rider's own keys ----------------------------------------------------------

export type StoredKey = { provider: Provider; last4: string; model: string; isDefault: boolean }

/** Every key the rider holds, in PROVIDERS order. A row whose provider this
 *  release does not know is skipped rather than trusted. */
export async function storedKeysOf(userId: number): Promise<StoredKey[]> {
  const rows = await db
    .select({ provider: aiKeys.provider, last4: aiKeys.last4, model: aiKeys.model, isDefault: aiKeys.isDefault })
    .from(aiKeys)
    .where(eq(aiKeys.userId, userId))
  return PROVIDERS.flatMap((p) => rows.filter((r): r is StoredKey => r.provider === p))
}

/** The key that answers a turn, in the clear: `asked` when the rider holds it (the
 *  window's switch), else their default, else their other key if that one will not
 *  open. A key that opens to something not shaped like its provider's is skipped,
 *  so a row whose sealed fields were swapped cannot send one company's key to the
 *  other. Null when none is usable, or there is no master key; both mean the same
 *  thing to the caller. */
export async function openKeyOf(
  userId: number,
  asked?: Provider | null,
): Promise<{ provider: Provider; key: string; model: string } | null> {
  if (!MASTER) return null
  const rows = (await db.select().from(aiKeys).where(eq(aiKeys.userId, userId))).filter((r) =>
    isProvider(r.provider),
  ) as (typeof aiKeys.$inferSelect & { provider: Provider })[]
  const first = pickProvider(rows, asked)
  const order = [...rows].sort((a, b) => Number(b.provider === first) - Number(a.provider === first))
  for (const row of order) {
    const key = open(row, MASTER)
    if (key && LOOKS_LIKE[row.provider](key)) return { provider: row.provider, key, model: row.model }
  }
  return null
}

export async function storeKey(userId: number, provider: Provider, key: string, model: string): Promise<void> {
  if (!MASTER) throw new Error('AI_KEY_ENCRYPTION_KEY is not configured')
  const s = seal(key, MASTER)
  await db
    .insert(aiKeys)
    .values({ userId, provider, ...s, model })
    .onConflictDoUpdate({ target: [aiKeys.userId, aiKeys.provider], set: { ...s, model, updatedAt: new Date() } })
}

export async function setKeyModel(userId: number, provider: Provider, model: string): Promise<void> {
  await db
    .update(aiKeys)
    .set({ model, updatedAt: new Date() })
    .where(and(eq(aiKeys.userId, userId), eq(aiKeys.provider, provider)))
}

/** Marks one provider as the rider's default and clears the other, in one write. */
export async function setDefaultProvider(userId: number, provider: Provider): Promise<void> {
  await db
    .update(aiKeys)
    .set({ isDefault: sql`${aiKeys.provider} = ${provider}` })
    .where(eq(aiKeys.userId, userId))
}

export async function forgetKey(userId: number, provider: Provider): Promise<void> {
  await db.delete(aiKeys).where(and(eq(aiKeys.userId, userId), eq(aiKeys.provider, provider)))
}
