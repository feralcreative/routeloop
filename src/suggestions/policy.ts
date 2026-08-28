// What a suggestion is, who may make one, and when it has gone stale.
//
// Pure — a function of the row plus who is asking — so test/suggestions.test.ts
// pins it with no database. Same rule-from-query split as members, comments,
// votes and subgroups.
//
// THE WHOLE HARD PART OF #190 IS IN THIS FILE, and it is one idea: a suggestion
// is a proposal against a day AS IT WAS, so the only question that matters is
// whether that day still looks the way it did.
import { createHash } from 'node:crypto'
import { canAdminister, canSuggest, type MemberFields } from '../members/policy'
import type { SuggestionOutcome } from '../db/schema'

/** Only the fields the rules read. */
export type SuggestionFields = {
  id: number
  authorId: number
  dayUid: string
  baseFingerprint: string
  resolvedAt: Date | null
  outcome: SuggestionOutcome | null
}

/** What a rider sees a suggestion as. `stale` is derived on read and is never
 *  stored — see the table's comment in schema.ts. */
export type SuggestionState = 'pending' | 'stale' | SuggestionOutcome

/** Enough of a day to fingerprint it. Deliberately not the whole row: a day's
 *  color and title change nothing about whether a proposed reroute still
 *  applies, and folding them in would make a rename invalidate every pending
 *  suggestion on that day. */
export type DayShape = {
  uid: string
  points: Array<{ uid: string; lng: number; lat: number; kind: string }>
}

/**
 * What a day looked like, as a short string.
 *
 * **WHAT IS IN IT IS THE WHOLE DESIGN.** The point uids in order, each with its
 * kind and its position rounded to about a meter. That is exactly the set of
 * things a suggestion is a proposal ABOUT — add a stop, move one, reorder them,
 * promote a POI — so a change to any of them genuinely invalidates the proposal,
 * and a change to anything else genuinely does not.
 *
 * Coordinates are rounded before hashing because a re-route can return float
 * noise in the last decimal places for a point nobody touched, and a fingerprint
 * that changed when nothing did would mark every pending suggestion stale on the
 * owner's next idle autosave.
 *
 * SHA-256 truncated to 32 hex characters. It is a change detector and not a
 * security boundary — nothing is trusted because its fingerprint matches, it is
 * only shown to a rider as "this still applies".
 */
export function dayFingerprint(day: DayShape): string {
  const parts = day.points.map((p) => `${p.uid}:${p.kind}:${p.lng.toFixed(5)},${p.lat.toFixed(5)}`)
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)
}

/**
 * Where a suggestion stands right now.
 *
 * `currentFingerprint` is null when the target day is GONE — deleted, or its uid
 * no longer in the ride — which counts as stale rather than as an error: the
 * proposal was about a day that does not exist any more and there is nothing to
 * apply it to.
 *
 * A RESOLVED SUGGESTION IS NEVER STALE. Once it has been accepted, discarded or
 * withdrawn it is history, and history does not go off.
 */
export function suggestionState(s: SuggestionFields, currentFingerprint: string | null): SuggestionState {
  if (s.resolvedAt !== null && s.outcome !== null) return s.outcome
  return currentFingerprint === s.baseFingerprint ? 'pending' : 'stale'
}

/** Whether a suggestion can still be acted on. A stale one cannot: applying a
 *  proposal made against a day that has since changed would silently throw away
 *  whatever changed it. */
export const isActionable = (state: SuggestionState): boolean => state === 'pending'

/** Whether `viewer` may propose a change to this ride. */
export const canPropose = (viewer: MemberFields | null): boolean => canSuggest(viewer)

/**
 * Whether `viewer` may accept or discard this suggestion.
 *
 * **THE OWNER, AND NOT AN `edit`-LEVEL RIDER.** The reflex is that anybody who
 * can change the ride directly should be able to take a suggestion — but
 * accepting is the act of deciding whose version of the ride is the ride, and
 * that is what owning it means. An editor who agrees with a suggestion can
 * simply make the change.
 */
export const canDecide = (viewer: MemberFields | null): boolean => canAdminister(viewer)

/**
 * Whether `viewer` may withdraw this suggestion.
 *
 * The author, or an owner. The author because a proposal is theirs to take back;
 * an owner because it is their ride. The same shape as canDelete on a comment,
 * and deliberately so — both are "your words, or your ride".
 */
export function canWithdraw(viewer: MemberFields | null, s: SuggestionFields): boolean {
  if (viewer === null) return false
  return viewer.riderId === s.authorId || canAdminister(viewer)
}

/** How many suggestions one rider may have open on one ride at a time. A bound
 *  rather than an opinion, the same job MAX_MEMBERS does — and it keeps a
 *  runaway client from filling the table. */
export const MAX_OPEN_PER_RIDER = 20
