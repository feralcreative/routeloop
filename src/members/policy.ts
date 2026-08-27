// Who is on a ride, what they may do about it, and what the owner may do to
// them.
//
// Pure — a function of the roster row plus who is asking — so it is testable
// under the house rule that governs test/. The queries live in ./service.ts,
// the same split as invites/policy.ts vs service.ts.
//
// THE OWNER IS A MEMBER, with role `owner`, from the moment a ride is created
// and backfilled for every ride that predates this. That is not bookkeeping: it
// is what makes "the roster" one question instead of two, and it is why nothing
// below has to special-case `ride.ownerId` alongside the rows.
import type { RideRole, Rsvp } from '../db/schema'

/** Only the fields the rules read, so a test does not have to build a whole row. */
export type MemberFields = {
  riderId: number
  role: RideRole
  rsvp: Rsvp
}

/** The four RSVP states a rider moves between freely. There is no transition
 *  table because there are no illegal moves: a rider who said Going and then
 *  cannot make it says Declined, and one who declined and then can says Going.
 *  Modeling that as a state machine would only forbid true statements. */
export const RSVP_LABELS: Record<Rsvp, string> = {
  invited: 'Not answered',
  going: 'Going',
  maybe: 'Maybe',
  declined: "Can't make it",
}

/**
 * Whether a rider counts toward "who is actually coming".
 *
 * `maybe` counts. A maybe is a bike that might need fuel and a rider who might
 * need a bed, and planning for one fewer of each because someone was honest is
 * the wrong way round. Only an explicit decline is excluded, and even then the
 * row stays on the roster — which is the whole reason role and rsvp are two
 * columns.
 */
export const isComing = (m: MemberFields): boolean => m.rsvp !== 'declined'

/**
 * Whether `viewer` may add riders to this ride.
 *
 * Owner only. #68 leaves "who proposes" open between leader-only and
 * any-member, and any-member is collaborative editing — that is #32 and it is
 * not built. Leader-only is also what the builder already enforces for every
 * other write, so this adds no second answer to "who may change a ride".
 */
export const canInvite = (viewerRole: RideRole | null): boolean => viewerRole === 'owner'

/**
 * Whether `viewer` may take `target` off the roster.
 *
 * Two paths, and they are one rule rather than two endpoints: the owner may
 * remove anybody, and anybody may remove themselves. The second is leaving,
 * which a rider must always be able to do without asking.
 *
 * THE OWNER MAY NOT REMOVE THEMSELVES. A ride with no owner has nobody who can
 * invite, resolve a vote or delete it, and the row would have to be recreated
 * by hand. Leaving your own ride is deleting it, and that button is elsewhere.
 */
export function canRemove(viewerId: number, viewerRole: RideRole | null, target: MemberFields): boolean {
  if (viewerRole === null) return false
  if (target.role === 'owner') return false
  return viewerRole === 'owner' || viewerId === target.riderId
}

/**
 * Whether `viewer` may set `target`'s RSVP.
 *
 * YOURS ONLY, INCLUDING THE OWNER'S. An owner marking somebody else as Going is
 * a statement about a person made by someone who is not them, and the roster is
 * read as "who said they are coming" — one forged row and it stops meaning that.
 */
export const canRsvp = (viewerId: number, target: MemberFields): boolean => viewerId === target.riderId

/**
 * Whether `viewer` may vote on this ride's alternates.
 *
 * Membership, and nothing else. Never the public share link — a ride set to
 * public would otherwise let anyone on the internet pick which road it takes.
 * A declined rider keeps their vote: they are still on the roster, and taking
 * it away would make "I cannot make it" quietly mean "and I withdraw my opinion
 * about the route", which nobody said.
 */
export const canVote = (viewerRole: RideRole | null): boolean => viewerRole !== null

/** How many riders to admit. Well above any real group ride and far below
 *  anything that would make the roster query interesting; it is here so a loop
 *  has a bound, the same job MAX_STOPS does. */
export const MAX_MEMBERS = 100
