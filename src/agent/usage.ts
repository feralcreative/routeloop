// The only reader and writer of `ai_usage` and `ai_keys`. policy.ts decides;
// this file counts and stores.
import { and, eq, like, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { aiKeys, aiUsage } from '../db/schema'
import { AI_FREE_MONTHLY_USD, AI_KEY_ENCRYPTION_KEY, ANTHROPIC_API_KEY } from '../config'
import { dayOf, monthOf, type FreeTierState, type Source } from './policy'
import { masterKey, open, seal } from './sealed-key'

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

// --- A rider's own key ----------------------------------------------------------

export type StoredKey = { last4: string; model: string }

export async function storedKeyOf(userId: number): Promise<StoredKey | null> {
  const [row] = await db
    .select({ last4: aiKeys.last4, model: aiKeys.model })
    .from(aiKeys)
    .where(eq(aiKeys.userId, userId))
  return row ?? null
}

/** The rider's key in the clear, for one turn. Null when there is none, no master
 *  key, or it will not open; all three mean the same thing to the caller. */
export async function openKeyOf(userId: number): Promise<{ key: string; model: string } | null> {
  if (!MASTER) return null
  const [row] = await db.select().from(aiKeys).where(eq(aiKeys.userId, userId))
  if (!row) return null
  const key = open(row, MASTER)
  return key ? { key, model: row.model } : null
}

export async function storeKey(userId: number, key: string, model: string): Promise<void> {
  if (!MASTER) throw new Error('AI_KEY_ENCRYPTION_KEY is not configured')
  const s = seal(key, MASTER)
  await db
    .insert(aiKeys)
    .values({ userId, ...s, model })
    .onConflictDoUpdate({ target: aiKeys.userId, set: { ...s, model, updatedAt: new Date() } })
}

export async function setKeyModel(userId: number, model: string): Promise<void> {
  await db.update(aiKeys).set({ model, updatedAt: new Date() }).where(eq(aiKeys.userId, userId))
}

export async function forgetKey(userId: number): Promise<void> {
  await db.delete(aiKeys).where(eq(aiKeys.userId, userId))
}
