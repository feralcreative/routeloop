// Alternate routes: two or more candidate routings for the same stretch of a
// ride, of which exactly one counts.
//
// WHY THIS IS A RULE AND NOT A COLUMN LOOKUP. A route has no identity that
// survives a save. `PUT /api/rides/:id` deletes every `routes` row for the ride
// and reinserts them (see the comment above it in src/routes/builder.ts), so
// every `routes.id` churns on every autosave — several times a minute. Nothing
// can hold a reference to a route across that. The grouping therefore rides in
// the JSON payload and is re-resolved on every write, exactly the way
// `position` already does, and `alt_group` is a within-this-payload partition
// key rather than a stable id anybody may store elsewhere.
//
// WHY IT IS MIRRORED. public/js/alts.js is the browser's copy, and
// test/alts.test.ts runs both over the same fixtures. The two must agree
// because they answer the same question in two places at once: the builder
// decides live which route is active and what the ride's mileage reads, and the
// server decides the same thing on save. If they disagree, the client shows one
// total, the database stores another, and nothing fails — which is the exact
// failure mode the twist/filename/duration pairs exist to prevent.
//
// TOTAL, NEVER THROWS. Every function here repairs rather than rejects.
// `normalize()` calls resolveAltGroups on a payload the rider is mid-edit in,
// and a transient shape — a group of one because a route was just deleted, two
// members briefly flagged active — must not 400 an autosave. There is no
// validation here on purpose; the schema bounds the values and this decides
// what they mean.

/** The two fields every consumer of this module needs. Routes carry much more. */
export type AltRoute = { altGroup: number | null; altActive: boolean }

/**
 * Put a ride's routes into a canonical alternate shape, in place.
 *
 * After this runs: an ungrouped route is active; every surviving group has at
 * least two members and exactly one active one; and group ids are dense from 0
 * in first-appearance order.
 */
export function resolveAltGroups(routes: AltRoute[]): void {
  // An ungrouped route is always active. `altActive` is meaningless without a
  // group, and leaving a stale `false` there would hide the route from every
  // mileage total the moment someone ungrouped it.
  for (const d of routes) {
    if (d.altGroup == null) {
      d.altGroup = null
      d.altActive = true
    }
  }

  // Partition by the incoming key, remembering the order groups first appear so
  // the renumbering below is stable rather than dependent on Map iteration of
  // whatever integers the client happened to send.
  const order: number[] = []
  const members = new Map<number, AltRoute[]>()
  for (const d of routes) {
    if (d.altGroup == null) continue
    let m = members.get(d.altGroup)
    if (!m) {
      m = []
      members.set(d.altGroup, m)
      order.push(d.altGroup)
    }
    m.push(d)
  }

  let next = 0
  for (const key of order) {
    const m = members.get(key) as AltRoute[]

    // A GROUP OF ONE IS NOT A GROUP, and this is the common case rather than a
    // corner: delete one of a pair of alternates and the survivor is a plain
    // route again. Silently, because there is nothing for a rider to fix.
    if (m.length < 2) {
      for (const d of m) {
        d.altGroup = null
        d.altActive = true
      }
      continue
    }

    // Exactly one active. Keep the first that claims it, clear the rest, and
    // elect the lowest-indexed member if nobody did — which is what happens
    // when the active route of a group is deleted.
    let elected = false
    for (const d of m) {
      if (d.altActive && !elected) {
        elected = true
        continue
      }
      d.altActive = false
    }
    if (!elected) m[0].altActive = true

    // Dense from 0. The id means nothing beyond "these routes are siblings", so a
    // canonical form makes the value the client reads back stable and two
    // payloads comparable.
    const id = next++
    for (const d of m) d.altGroup = id
  }
}

/**
 * The routes that count — every ungrouped route plus the active member of each
 * group. This is the filter behind every mileage figure in the app.
 *
 * Written to be right on unresolved input too (`altGroup == null` wins over
 * whatever `altActive` says), so a caller that has not run resolveAltGroups
 * still gets a sane answer.
 */
export function activeRoutes<T extends AltRoute>(routes: T[]): T[] {
  return routes.filter((d) => d.altGroup == null || d.altActive)
}

/** How many routes the ride actually is, as opposed to how many rows it has. */
export function activeRouteCount(routes: AltRoute[]): number {
  let n = 0
  for (const d of routes) if (d.altGroup == null || d.altActive) n++
  return n
}

// b, c, … z, which covers 25 alternates in one group — more than a 31-route ride
// can hold. Past that a number rather than a second letter: "3z2" is ugly but
// unambiguous, where "3aa" reads like the start of a new sequence.
function ghostSuffix(n: number): string {
  return n < 25 ? String.fromCharCode(98 + n) : `z${n - 23}`
}

/**
 * The number to print beside each route, in route order.
 *
 * A ride whose routes 3 and 4 are alternates is a THREE route ride with four rows,
 * so numbering by row index would say four. Active routes number 1..N and a
 * losing alternate takes its group's number with a letter: Route 3, Route 3b,
 * Route 3c. Returned for the whole array at once because every caller is a render
 * loop and doing it per route would be quadratic.
 *
 * Tolerant of a group with no active member — it numbers it as its own route
 * rather than failing — but that shape should not reach here; resolveAltGroups
 * elects one.
 */
export function routeOrdinals(routes: AltRoute[]): string[] {
  const out: string[] = new Array(routes.length).fill('')
  const groupNumber = new Map<number, number>()
  let n = 0

  for (let i = 0; i < routes.length; i++) {
    const d = routes[i]
    if (d.altGroup != null && !d.altActive) continue
    out[i] = String(++n)
    if (d.altGroup != null) groupNumber.set(d.altGroup, n)
  }

  const rank = new Map<number, number>()
  for (let i = 0; i < routes.length; i++) {
    const d = routes[i]
    if (d.altGroup == null || d.altActive) continue
    const k = rank.get(d.altGroup) ?? 0
    rank.set(d.altGroup, k + 1)
    const base = groupNumber.get(d.altGroup)
    out[i] = base == null ? String(++n) : String(base) + ghostSuffix(k)
  }

  return out
}

/** One route's ordinal. `routeOrdinals` is what a render loop should call. */
export function routeOrdinal(routes: AltRoute[], i: number): string {
  return routeOrdinals(routes)[i] ?? ''
}
