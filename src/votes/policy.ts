// What a tally means, and which alternate wins one.
//
// Pure — a function of counts and nothing else — so it is testable under the
// house rule that governs test/. The queries live in ./service.ts and the timed
// half in ./resolve.ts, the same split as invites/policy.ts vs service.ts.
//
// THE HARD PART IS THAT A TIE IS THE COMMON CASE, not the edge one. A ride with
// three members and two alternates ties whenever one abstains, and a ride with
// nobody voting ties at 0–0 on the first day it exists. So "what happens on a
// tie" is not a rule tucked in at the end; it is most of the behavior.

/** One alternate's standing. `uid` is the day's — see days.uid in schema.ts. */
export type Tally = {
  uid: string
  votes: number
  /** Whether this is the alternate currently counting toward the ride. */
  active: boolean
}

/**
 * Which alternate a tally elects, or null for "leave it alone".
 *
 * NULL ON A TIE, ALWAYS, and that is the whole governance rule — it needed no
 * negotiating because it changes nothing. #68 left majority, quorum and
 * tie-breaking open; a tie-break that picks a winner has to justify picking one
 * road over another on no information, and every candidate rule (first by
 * position, most recent vote, the owner's) is arbitrary dressed as a policy.
 * Leaving the owner's existing pick standing is the only answer that does not
 * invent a preference nobody expressed.
 *
 * A CLEAR WINNER THAT IS ALREADY ACTIVE ALSO RETURNS NULL. There is nothing to
 * do, and returning it would make the resolve sweep write a row and log a change
 * every time it ran.
 *
 * No quorum. A quorum turns "two of five bothered to vote" into "nothing
 * happens", which is indistinguishable from the tally being broken and is
 * exactly what an owner would report as a bug. The deadline is the opt-in; the
 * owner who set one asked for the answer the votes give.
 */
export function electWinner(tallies: Tally[]): string | null {
  if (tallies.length < 2) return null
  const top = Math.max(...tallies.map((t) => t.votes))
  if (top === 0) return null
  const leaders = tallies.filter((t) => t.votes === top)
  if (leaders.length !== 1) return null
  return leaders[0].active ? null : leaders[0].uid
}

/**
 * Whether the tally is worth showing at all.
 *
 * A group nobody has voted in shows nothing rather than a row of zeroes: zeroes
 * read as "this was voted on and nobody wanted it", which is a different and
 * wronger statement than "voting has not started".
 */
export const hasVotes = (tallies: Tally[]): boolean => tallies.some((t) => t.votes > 0)

/**
 * Whether voting is open.
 *
 * NULL MEANS OPEN FOREVER, which is the state every ride is in and every ride
 * that existed before this landed stays in. A closed vote still shows its
 * numbers — the result is the interesting part — it just stops accepting new
 * ones, so a rider arriving late sees what was decided rather than an empty box.
 */
export const votingOpen = (closeAt: Date | null, now: Date): boolean => closeAt === null || closeAt > now

/**
 * Whether the sweep should resolve this ride now.
 *
 * Deliberately NOT the negation of votingOpen: a ride with no deadline is open
 * and must never be resolved, and this has to say so rather than leaving it to
 * a caller to remember the null case.
 */
export const dueToResolve = (closeAt: Date | null, now: Date): boolean => closeAt !== null && closeAt <= now
