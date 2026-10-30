// ONE AGENT TURN IN FLIGHT PER RIDER, and the reason the caps hold.
//
// The free-tier allowance and the daily Google budget are read before a turn starts
// and recorded when it ends, so two turns running at once would each see the same
// total and each spend up to the limit. Holding a turn per rider closes that: the
// second request is refused before it reads anything.
//
// IN PROCESS, deliberately, rather than a database lock. Only one color serves at a
// time, so the only window two processes share is the 30–60 seconds of a cutover,
// where a rider would need two turns started in the right second to overlap.
// Across riders the app-wide ceiling can still be passed by one turn per rider
// running at that moment, which on the free model is about a cent each; that is
// stated rather than fixed.

const held = new Set<number>()

/** Claims the rider's turn, or returns null when one is already running. */
export function claimTurn(userId: number): (() => void) | null {
  if (held.has(userId)) return null
  held.add(userId)
  let released = false
  return () => {
    if (released) return
    released = true
    held.delete(userId)
  }
}
