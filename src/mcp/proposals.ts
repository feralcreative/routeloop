// Changes an MCP client has proposed to a ride and not yet applied (#453).
//
// AN EDIT OVER MCP BUILDS A PROPOSAL; ONE apply_changes SAVES IT. Before this, every
// edit tool saved at once, so asking Claude to fix five things was five durable
// writes visible to everyone on the ride, with no undo, and a failure on the third
// left the ride half-changed. Now the client shows the rider what it means to do,
// and the save is one write against the revision the changes were made on.
//
// IN MEMORY AND THAT IS DELIBERATE. A proposal lives minutes, belongs to one rider
// on one ride, and costs nothing to lose: the client is told it is gone and redoes
// the edits. The price stated rather than treated as a bug: a proposal does not
// survive a deploy, and during the 30 to 60 seconds of a blue/green cutover a call
// can reach the other color and find nothing pending. A table would buy surviving
// that at the cost of a migration and a sweep.
//
// PURE APART FROM THE CLOCK, so test/mcp-proposals.test.ts needs no server.
import type { RidePayload } from '../maps/ride-graph'

export type Proposal = {
  userId: number
  rideId: number
  /** The ride's `rev` the changes were made on. apply refuses anything else. */
  baseRev: number
  ride: RidePayload
  /** One line per edit, in order, as the tools reported them. */
  changes: string[]
  touchedAt: number
}

const coordsOf = (p: Proposal): number =>
  p.ride.routes.reduce((n, r) => n + r.legs.reduce((m, l) => m + l.geometry.length, 0), 0)

/** How long an untouched proposal is kept. */
export const PROPOSAL_TTL_MS = 30 * 60_000
/** The most proposals held at once, across every rider. */
export const MAX_PROPOSALS = 200
/** The most one rider may hold, so a busy rider evicts their own oldest first
 *  rather than somebody else's. */
export const MAX_PER_RIDER = 3
/** THE MEMORY BOUND, in road coordinates across every held proposal. A count of
 *  proposals bounds nothing on its own, since one ride may carry 200,000 points of
 *  geometry; at roughly 50 bytes a coordinate this is about 50 MB. */
export const MAX_COORDS = 1_000_000

const store = new Map<string, Proposal & { coords: number }>()
let held = 0
const key = (userId: number, rideId: number) => `${userId}:${rideId}`

function remove(k: string): void {
  const p = store.get(k)
  if (!p) return
  held -= p.coords
  store.delete(k)
}

function sweep(now: number): void {
  for (const [k, p] of store) if (now - p.touchedAt > PROPOSAL_TTL_MS) remove(k)
}

export function getProposal(userId: number, rideId: number, now = Date.now()): Proposal | null {
  sweep(now)
  return store.get(key(userId, rideId)) ?? null
}

export function putProposal(p: Proposal, now = Date.now()): void {
  sweep(now)
  const k = key(p.userId, p.rideId)
  remove(k)
  const coords = coordsOf(p)
  // Oldest first, because a Map iterates in insertion order and every put re-inserts.
  const mine = [...store.keys()].filter((x) => x.startsWith(`${p.userId}:`))
  while (mine.length >= MAX_PER_RIDER) remove(mine.shift() as string)
  while (store.size > 0 && (store.size >= MAX_PROPOSALS || held + coords > MAX_COORDS))
    remove(store.keys().next().value as string)
  store.set(k, { ...p, touchedAt: now, coords })
  held += coords
}

export function dropProposal(userId: number, rideId: number): void {
  remove(key(userId, rideId))
}

/** For tests only. */
export function clearProposals(): void {
  store.clear()
  held = 0
}
