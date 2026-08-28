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
import type { RidePerm, RideRole, Rsvp } from '../db/schema'

/** Only the fields the rules read, so a test does not have to build a whole row. */
export type MemberFields = {
  riderId: number
  role: RideRole
  perm: RidePerm
  rsvp: Rsvp
}

// --- The permission ladder --------------------------------------------------
//
// #190. Four rungs, least to most, and an owner above all four.
//
// THE RANK LIVES HERE AND NOWHERE ELSE. ride_perm's member order is not its
// rank and cannot be reordered later — `ALTER TYPE ... ADD VALUE` appends — so
// nothing may compare two enum members directly. Every gate goes through
// atLeast(), which goes through this record. Adding a rung is one line here and
// one enum member; inserting one in the middle is a renumbering of this record
// and no migration at all, which is the whole reason the ordering is in code.

/** How the rungs rank. The numbers are ordinals and nothing reads their value —
 *  only their order — so renumbering is free. */
export const PERM_RANK: Record<RidePerm, number> = {
  view: 0,
  comment: 1,
  suggest: 2,
  edit: 3,
}

/** What an owner outranks. Above every rung by construction rather than by
 *  being one, so `owner` never has to be a member of the ladder. */
const OWNER_RANK = Number.MAX_SAFE_INTEGER

/** Not on the roster at all. Below `view`, which is a real grant. */
const NOT_A_MEMBER = -1

/**
 * What an invitation grants on its own.
 *
 * `suggest` — look, discuss, and propose changes. **Edit is never handed out by
 * an invitation** and is always a deliberate promotion by an owner, which is the
 * entire shape of #190. An owner can also go the other way and hand out `view`
 * alone.
 *
 * Mirrored by the column default in schema.ts. Both spellings exist because the
 * database default is what protects a row inserted by a path that forgets, and
 * this constant is what the invite form shows before anything is inserted.
 */
export const DEFAULT_PERM: RidePerm = 'suggest'

/** What each rung is called on a rider-facing surface. A rung with no label
 *  renders as its identifier — the failure RSVP_LABELS and the feedback status
 *  labels both exist to prevent. */
export const PERM_LABELS: Record<RidePerm, string> = {
  view: 'View only',
  comment: 'Can comment',
  suggest: 'Can suggest',
  edit: 'Can edit',
}

/** One line each, for the promotion control. What the rider on the other end
 *  will actually be able to do. */
export const PERM_HELP: Record<RidePerm, string> = {
  view: 'Can open the ride and see the route. Nothing else.',
  comment: 'Can also leave comments on the ride and on individual stops.',
  suggest: 'Can also propose changes for you to accept or discard.',
  edit: 'Can change the route directly, like you can.',
}

/**
 * Where a member sits, as a number that can be compared.
 *
 * **An owner outranks the ladder rather than sitting on it**, so an owner's
 * `perm` column is never read. That is deliberate: leaving it at the default
 * instead of stamping it to `edit` means demoting a co-owner is one column
 * changing rather than two that can disagree with each other.
 *
 * A null member is not on the roster and ranks below `view`, which is a real
 * grant that a share link does not confer.
 */
export function rankOf(m: MemberFields | null): number {
  if (m === null) return NOT_A_MEMBER
  return m.role === 'owner' ? OWNER_RANK : PERM_RANK[m.perm]
}

/** Whether this member holds at least `need`. The only comparison in the app —
 *  everything below is a name for one call to it. */
export const atLeast = (m: MemberFields | null, need: RidePerm): boolean => rankOf(m) >= PERM_RANK[need]

/** Whether `m` may open the ride at all as a member. Note this is NOT the whole
 *  view rule: a public or unlisted ride is readable by people who are not on the
 *  roster, and canView() in src/access/policy.ts is what answers that. This
 *  answers only the membership grant. */
export const canViewAsMember = (m: MemberFields | null): boolean => atLeast(m, 'view')

/**
 * Whether `m` may leave a comment.
 *
 * **ROSTER-ONLY, NEVER LINK-BASED.** A share link is permission to SEE a route,
 * not to write on it — the same call the roster page and voting already make,
 * and for the same reason: a public ride would otherwise be writable by anyone
 * on the internet. So this takes a member row and there is deliberately no
 * overload that takes a visibility.
 */
export const canComment = (m: MemberFields | null): boolean => atLeast(m, 'comment')

/** Whether `m` may propose a change for an owner to accept or discard. */
export const canSuggest = (m: MemberFields | null): boolean => atLeast(m, 'suggest')

/**
 * Whether `m` may write to the ride itself — days, points, legs, alts.
 *
 * **THE BUILDER AND NOTHING MORE.** Deleting the ride, changing its visibility
 * and administering its roster are owner powers and stay owner powers; see
 * canAdminister. An editor who can delete the ride is a co-owner, and
 * co-ownership is a role you are given, not a rung you climb to.
 */
export const canEditRide = (m: MemberFields | null): boolean => atLeast(m, 'edit')

/**
 * Whether `m` holds the whole-ride powers: delete, visibility, and the roster.
 *
 * Role rather than rank, because these are not the top of the ladder — they are
 * off it. A rider promoted to `edit` never acquires them.
 */
export const canAdminister = (m: MemberFields | null): boolean => m !== null && m.role === 'owner'

/**
 * Whether `viewer` may change `target`'s rung.
 *
 * Owners only, and **never on another owner**: an owner is not on the ladder, so
 * setting their rung would write a column nothing reads and show a demotion that
 * did not happen. Taking someone's ownership away is a role change and is
 * refused outright — see canRemove for why a co-owner cannot be pushed out.
 */
export function canSetPerm(viewer: MemberFields | null, target: MemberFields): boolean {
  if (!canAdminister(viewer)) return false
  return target.role !== 'owner'
}

/**
 * Whether a member's rung is shown to `viewer`.
 *
 * **OWNERS ONLY.** The roster answers "who is coming", and that is a fact about
 * people the whole ride shares. A rung is administration, and showing it
 * publishes a ranking of the riders to the riders — somebody learns they were
 * trusted less than the person above them, from a page they opened to check who
 * was going. The same instinct as the silent friendship refusal one level up.
 *
 * A rider always knows their OWN level, which is what the builder's banner says.
 */
export const canSeePerms = (viewer: MemberFields | null): boolean => canAdminister(viewer)

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
 * Two paths, and they are one rule rather than two endpoints: an owner may
 * remove anybody, and anybody may remove themselves. The second is leaving,
 * which a rider must always be able to do without asking.
 *
 * **THE LAST OWNER MAY NOT LEAVE.** This used to be the stronger "an owner may
 * not leave at all", which was right while a ride had exactly one; #190 makes
 * `owner` a role more than one member can hold, so the rule narrows to what it
 * was always protecting. A ride with no owner has nobody who can invite,
 * resolve a vote or delete it, and the row would have to be recreated by hand.
 * With a second owner standing there, none of that is true and stepping down is
 * an ordinary thing to want. Leaving as the last owner is deleting the ride,
 * and that button is elsewhere.
 *
 * **NO OWNER MAY REMOVE ANOTHER OWNER**, whatever `ownerCount` says. Co-owners
 * hold equal power, so allowing it makes the ride belong to whoever presses the
 * button first — and the loser cannot undo it, because they are no longer on
 * the roster. An owner leaves under their own hand or not at all.
 *
 * @param ownerCount how many members currently hold `role = 'owner'`, this one
 *   included. Counted by the caller against the same roster read, because a
 *   rule that has to ask the database is not a rule this file can hold.
 */
export function canRemove(
  viewerId: number,
  viewerRole: RideRole | null,
  target: MemberFields,
  ownerCount: number,
): boolean {
  if (viewerRole === null) return false
  if (target.role === 'owner') {
    // Yourself, and only while somebody else is left holding the ride.
    return viewerId === target.riderId && ownerCount > 1
  }
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
