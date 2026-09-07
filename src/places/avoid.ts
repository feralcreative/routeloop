// A rider's own list of places to push DOWN a place search (#271).
//
// **A WEIGHTING AND NEVER A FILTER, AND THAT IS THE WHOLE SAFETY ARGUMENT.**
// Every rider has places they will not stop at for reasons no default can guess
// — ARCO takes debit and ATM cards but not credit, so on a group ride it is a
// stop where somebody cannot pay; Costco Gas is reliably cheapest and the line is
// not worth it on a bike. Neither is a bad business and neither should be hidden
// from anyone. The one time a rider is out of fuel with an ARCO in front of them
// is the time this must not have removed it from the list.
//
// **PURE, AND APPLIED IN THE CALLER RATHER THAN INSIDE `src/maps/places.ts`.**
// That module is a proxy plus a cache, and the cache is what decides this: it is
// keyed on the QUERY, so ranking inside it would either fragment the cache per
// rider — paying Google again for a search somebody else already made — or serve
// a list pre-ranked for whoever asked first. Neither is acceptable, and both are
// invisible. So places.ts stays a proxy that knows nothing about riders, and the
// ordering happens after the cache hands the list back. Same rule-from-query
// split as ../places/policy.ts against service.ts.
//
// **MATCHING IS ON THE NAME AND IT IS APPROXIMATE ON PURPOSE.** Text Search
// answers with whatever a business calls itself, so "arco" matches "ARCO" and
// "ARCO am/pm" and, in principle, some unrelated place with those letters in it.
// That is survivable exactly because the consequence of a false match is one
// result ranked lower rather than removed — which is the reason this is a
// weighting in the first place.
//
// **IT MUST NEVER REACH THE MEETING-POINT PROPOSER.** `src/routes/rendezvous.ts`
// matches on `type === 'gas_station'` to guarantee the group can actually fill
// up, and a candidate demoted to nothing there is a real failure rather than a
// preference. Nothing in this file is imported by that one, and it should stay
// that way.

/** Only the field the ordering reads, so a caller can pass its own shape and a
 *  test does not have to build a whole PlaceHit. */
export type Named = { name: string }

/** A rider will not read past this many entries and Text Search returns twenty
 *  results, so a list longer than this is a paste accident rather than an answer.
 *  The column caps the text at 1,000 characters; this caps the terms. */
export const MAX_AVOID_TERMS = 40

/** Shortest term worth matching. One and two characters match half the map —
 *  "BP" is a real brand and a real substring of a hundred other names — and a
 *  term that matches everything is a list that orders nothing. */
const MIN_TERM = 3

/**
 * The rider's free text into terms.
 *
 * **COMMAS, SEMICOLONS AND NEWLINES ALL SEPARATE**, because the field says
 * "comma- or semicolon-delimited" and a rider typing a list will press Enter
 * anyway. Accepting all three costs one character class and removes the only way
 * to get the field subtly wrong.
 *
 * Lowercased and de-duplicated, so the matcher below can be a plain `includes`
 * and the same brand typed twice does not demote anything twice.
 */
export function parseAvoidList(raw: string | null | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  for (const part of raw.split(/[,;\n\r]+/)) {
    const t = part.trim().toLowerCase().replace(/\s+/g, ' ')
    if (t.length >= MIN_TERM) seen.add(t)
    if (seen.size >= MAX_AVOID_TERMS) break
  }
  return [...seen]
}

/** Whether one result is named by the list. Substring, case-insensitive, on the
 *  NAME alone — never the address, or "Shell" in "Shell Beach Road" demotes a
 *  perfectly good diner. */
export const isAvoided = (place: Named, terms: string[]): boolean => {
  if (terms.length === 0) return false
  const name = place.name.toLowerCase()
  return terms.some((t) => name.includes(t))
}

/**
 * The same results, with anything the rider named moved to the back.
 *
 * **STABLE, WHICH IS THE PART THAT MATTERS.** Text Search's own order is a
 * ranking this app has no better answer than, so within each half the original
 * order is preserved exactly and the only thing that changed is which half a
 * result is in. Sorting by a score would quietly re-rank the ones nobody
 * mentioned.
 *
 * Returns the SAME array contents, never a shorter one. A caller that wants to
 * know which are demoted asks `isAvoided`.
 */
export function demoteAvoided<T extends Named>(places: T[], terms: string[]): T[] {
  if (terms.length === 0) return places
  const keep: T[] = []
  const push: T[] = []
  for (const p of places) (isAvoided(p, terms) ? push : keep).push(p)
  return keep.concat(push)
}
