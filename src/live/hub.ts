// Who is in a ride right now, and which day each of them is working on.
//
// IN MEMORY, AND THAT IS CORRECT HERE RATHER THAN A SHORTCUT. One color serves
// at a time — the proxy points at exactly one, see live_color() — and the
// container runs a single Node process with no cluster, so there is one copy of
// this map and every subscriber can see it. The cost is that during a blue/green
// cutover riders on different colors cannot see each other for the 30–60 seconds
// both are up. That is worth stating rather than fixing: the alternative is a
// shared store for state whose entire lifetime is a browser tab being open.
//
// **NOTHING HERE PREVENTS DATA LOSS, AND IT MUST NEVER BE RELIED ON TO.** A
// claim is a courtesy that stops two riders picking up the same day by accident.
// It vanishes on restart, on a dropped connection, and on a rider whose laptop
// slept. What actually protects the work is the day hash checked on every write
// — see src/maps/day-merge.ts — which is durable and needs no cooperation.

/** One open stream. `send` is the SSE writer; it must never throw, because a
 *  publish walks every connection and one broken socket must not stop the rest
 *  being told. */
export type Conn = {
  id: number
  rideId: number
  riderId: number
  name: string
  /** Which day this rider is editing, or null for "just watching". */
  dayUid: string | null
  send: (event: string, data: unknown) => void
  close: () => void
}

/** What a subscriber is told about everyone else. Deliberately not the whole
 *  Conn: `id` is an internal handle and `send` is a function. */
export type PresenceRow = { riderId: number; name: string; dayUid: string | null }

const rooms = new Map<number, Set<Conn>>()
let nextId = 1

/** Set once the process is draining, so a new subscription is refused rather
 *  than opening a stream that server.close() will then wait on. */
let closed = false

export const nextConnId = (): number => nextId++

export function roomOf(rideId: number): Set<Conn> {
  let room = rooms.get(rideId)
  if (!room) {
    room = new Set()
    rooms.set(rideId, room)
  }
  return room
}

/** Everyone currently in a ride, deduplicated by rider.
 *
 *  ONE ROW PER RIDER, NOT PER CONNECTION. A rider with the ride open in two tabs
 *  is one person, and showing them twice reads as a second collaborator who does
 *  not exist. The day reported is the first connection that claims one, so a
 *  second idle tab does not blank out what the working tab is doing. */
export function presenceOf(rideId: number): PresenceRow[] {
  const byRider = new Map<number, PresenceRow>()
  for (const c of rooms.get(rideId) ?? []) {
    const prev = byRider.get(c.riderId)
    if (!prev) byRider.set(c.riderId, { riderId: c.riderId, name: c.name, dayUid: c.dayUid })
    else if (prev.dayUid === null && c.dayUid !== null) prev.dayUid = c.dayUid
  }
  return [...byRider.values()]
}

/** Send to everyone in a ride, optionally skipping one connection — a rider does
 *  not need to be told about their own save. */
export function publish(rideId: number, event: string, data: unknown, except?: Conn): void {
  for (const c of rooms.get(rideId) ?? []) {
    if (c === except) continue
    // A dead socket must not stop the rest of the room being told.
    try {
      c.send(event, data)
    } catch {
      /* the stream's own abort handling will drop it */
    }
  }
}

/** Presence, to everyone including the rider whose change caused it — a rider
 *  arriving needs the list as much as the people already there. */
export function publishPresence(rideId: number): void {
  publish(rideId, 'presence', presenceOf(rideId))
}

export function join(conn: Conn): void {
  roomOf(conn.rideId).add(conn)
  publishPresence(conn.rideId)
}

export function leave(conn: Conn): void {
  const room = rooms.get(conn.rideId)
  if (!room) return
  room.delete(conn)
  // Drop the room rather than leaving an empty Set per ride ever opened. This is
  // the only thing stopping the map growing for the life of the process.
  if (room.size === 0) rooms.delete(conn.rideId)
  else publishPresence(conn.rideId)
}

/** What a rider is working on now. Returns false if the day is already held by
 *  somebody else, in which case the caller keeps whatever it had. */
export function setClaim(conn: Conn, dayUid: string | null): boolean {
  if (dayUid !== null) {
    for (const other of rooms.get(conn.rideId) ?? []) {
      if (other !== conn && other.riderId !== conn.riderId && other.dayUid === dayUid) return false
    }
  }
  if (conn.dayUid === dayUid) return true
  conn.dayUid = dayUid
  publishPresence(conn.rideId)
  return true
}

export const isClosed = (): boolean => closed

/**
 * Closes every stream, and refuses new ones from then on.
 *
 * Called from installShutdown before `server.close()`. The reasoning that
 * usually goes with this — that an SSE stream is a long-lived in-flight request
 * and close() waits for those, so an open builder holds the drain for the whole
 * grace period — is intuitive and was MEASURED FALSE on this stack: the drain is
 * about 0.14s either way. See the note in src/shutdown.ts.
 *
 * What it does buy is that the behavior is stated rather than emergent, and the
 * `closed` flag, which is the only thing stopping a new subscription opening on
 * a container that is going away.
 */
export function closeAll(): void {
  closed = true
  for (const room of rooms.values()) {
    for (const c of room) {
      try {
        c.close()
      } catch {
        /* nothing useful to do while shutting down */
      }
    }
  }
  rooms.clear()
}

/** Test seam. The registry is module-level state and a test that leaves a room
 *  behind changes the next one's answer. */
export function resetForTest(): void {
  rooms.clear()
  closed = false
  nextId = 1
}
