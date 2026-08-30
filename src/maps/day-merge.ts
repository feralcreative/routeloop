// Whose version of each day wins when two riders save the same ride.
//
// Pure — uids and hashes in, decisions out, no database and no payloads — so
// every case below is reachable from test/ under the house rule. The PUT loads
// only the days this says to keep, which is normally none.
//
// **A THREE-WAY MERGE, AND THE THIRD LEG IS THE ONE THAT IS EASY TO OMIT.** It
// is not enough to compare what the client sent against what is stored: a day
// the client did not send is either one the rider DELETED or one somebody else
// ADDED since they loaded, and those need opposite answers. `base` — every uid
// and hash the client held when it loaded — is what tells them apart, and it
// has to be the WHOLE set rather than a field on each incoming day, because a
// deleted day is absent from the payload and so carries nothing.
//
// The unit is the day because that is how a multi-day ride divides between
// people, and because days[] is already keyed by a uid that survives the
// delete-and-reinsert. Anything finer needs an operation log.

/** What the database currently holds. `hash` is null for a day written before
 *  day revisions existed, which is treated as unknown rather than as changed —
 *  see the UNKNOWN note below. */
export type StoredDay = { uid: string; hash: string | null }

/** Every day uid the client held when it loaded, and the hash it saw. A day the
 *  client has created since is simply absent. */
export type BaseHashes = Record<string, string>

export type MergeDecision =
  /** The client's version is current. Use what they sent. */
  | { uid: string; take: 'incoming' }
  /** Somebody else changed or added this. Load it from the database and keep it,
   *  discarding whatever the client sent for it. */
  | { uid: string; take: 'stored' }

export type MergeResult = {
  /** In final order: the client's own ordering, then anything adopted. */
  decisions: MergeDecision[]
  /** Uids the client sent whose version was NOT used, so the response can name
   *  them. A rider whose edit was superseded is told, rather than watching it
   *  silently revert on the next load. */
  superseded: string[]
  /** Uids kept although the client never sent them — somebody else's new days,
   *  and days this rider deleted that somebody else had meanwhile edited. */
  adopted: string[]
}

/**
 * `incoming` is the client's day uids in the client's own order, and that order
 * is preserved because it is the only ordering anybody actually expressed. Days
 * kept from the database that the client does not know about are appended after
 * it: the client's ordering says nothing about where a day it has never seen
 * belongs, so interleaving would be invention. A rider who reorders while
 * another adds a day gets their order plus the new day at the end — wrong in no
 * worse a way than any other choice, and at least predictable.
 */
export function mergeDays(stored: StoredDay[], incoming: string[], base: BaseHashes): MergeResult {
  const storedByUid = new Map(stored.map((d) => [d.uid, d]))
  const sent = new Set(incoming)

  const decisions: MergeDecision[] = []
  const superseded: string[] = []
  const adopted: string[] = []

  for (const uid of incoming) {
    const cur = storedByUid.get(uid)

    // A day the database does not have is one the client just created — or one
    // it deleted and re-added, which is the same thing. Nothing to conflict with.
    if (!cur) {
      decisions.push({ uid, take: 'incoming' })
      continue
    }

    const from = base[uid]

    // UNKNOWN TAKES THE CLIENT'S VERSION rather than rejecting it. A missing base
    // means a builder loaded before day revisions shipped; a null stored hash
    // means a day written before them. Refusing on an unknown would fail every
    // ride's first save after this deploy — the blue/green overlap turning a
    // guard into an outage. Unknown degrades to exactly the behavior this
    // replaces, which is what makes the column additive in one deploy.
    if (from === undefined || cur.hash === null || from === cur.hash) {
      decisions.push({ uid, take: 'incoming' })
      continue
    }

    // Somebody else wrote to this day since the client loaded it.
    decisions.push({ uid, take: 'stored' })
    superseded.push(uid)
  }

  for (const cur of stored) {
    if (sent.has(cur.uid)) continue

    const from = base[cur.uid]

    // The client never held it, so it was added by somebody else while this
    // rider was working. Keep it. This is the leg that makes the merge
    // three-way; without it one rider's save deletes every day the other added.
    if (from === undefined) {
      decisions.push({ uid: cur.uid, take: 'stored' })
      adopted.push(cur.uid)
      continue
    }

    // The client held it and did not send it back, so the rider deleted it.
    // Honour that only if it is still the day they deleted: if somebody else has
    // edited it since, their work outranks a delete aimed at an older version.
    // Keeping a day somebody wanted gone is recoverable in one click; deleting
    // work somebody just did is not.
    if (cur.hash !== null && from !== cur.hash) {
      decisions.push({ uid: cur.uid, take: 'stored' })
      adopted.push(cur.uid)
    }
    // Otherwise it is dropped, by being in neither list.
  }

  return { decisions, superseded, adopted }
}

/**
 * Which uids the caller has to load out of the database to build the merged
 * payload. Normally empty: the common case is one rider saving a ride nobody
 * else has touched, and that case reads nothing extra.
 */
export const storedUidsNeeded = (r: MergeResult): string[] =>
  r.decisions.filter((d) => d.take === 'stored').map((d) => d.uid)
