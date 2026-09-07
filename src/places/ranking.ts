// A rider's own lists of places to push DOWN and UP a place search (#271).
//
// **TWO LISTS AND ONE PASS, since 2026-09-07.** Avoid came first and favor is
// its mirror: same free text, same loose matching, same promise that nothing is
// added or removed. Ziad's call.
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
 *  The column caps the text at 1,000 characters; this caps the terms. Applies to
 *  each list separately — they are two questions. */
export const MAX_TERMS = 40

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
export function parseTerms(raw: string | null | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  for (const part of raw.split(/[,;\n\r]+/)) {
    const t = part.trim().toLowerCase().replace(/\s+/g, ' ')
    if (t.length >= MIN_TERM) seen.add(t)
    if (seen.size >= MAX_TERMS) break
  }
  return [...seen]
}

/** Whether one result is named by a list — either list, which is why it is not
 *  called `isAvoided` any more. Substring, case-insensitive, on the NAME alone:
 *  never the address, or "Shell" in "Shell Beach Road" moves a perfectly good
 *  diner. */
export const matchesAny = (place: Named, terms: string[]): boolean => {
  if (terms.length === 0) return false
  const name = place.name.toLowerCase()
  return terms.some((t) => name.includes(t))
}

/**
 * The same results, ordered by the rider's two lists: favored first, then
 * everything they said nothing about, then avoided.
 *
 * **ONE PARTITION INTO THREE, NOT TWO PASSES.** Promoting and then demoting
 * would work and would hide the interesting case: a term in BOTH lists. Three
 * buckets in one walk makes the tie a decision rather than an accident of which
 * pass ran second — and the decision is that **FAVOR WINS**, because a rider who
 * has named something twice has said the second thing more recently in the only
 * sense that matters, and being shown a place you asked for is a smaller wrong
 * than being denied one.
 *
 * **STABLE WITHIN EACH BUCKET**, for the reason it always has: Text
 * Search's own order is a ranking this app has no better answer than, so the
 * only thing that may change is which bucket a result is in.
 *
 * Returns the SAME contents, never fewer. Nothing is added either — a favored
 * place that the search did not return is not conjured up, because that would be
 * a different search rather than a different order.
 */
export function rankPlaces<T extends Named>(places: T[], favor: string[], avoid: string[]): T[] {
  if (favor.length === 0 && avoid.length === 0) return places
  const up: T[] = []
  const mid: T[] = []
  const down: T[] = []
  for (const p of places) {
    if (matchesAny(p, favor)) up.push(p)
    else if (matchesAny(p, avoid)) down.push(p)
    else mid.push(p)
  }
  return up.concat(mid, down)
}
