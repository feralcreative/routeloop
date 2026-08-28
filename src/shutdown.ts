// Letting the in-flight requests finish.
//
// There was no SIGTERM handler anywhere in src/ before this. On `docker stop`
// the container got SIGTERM, nothing caught it, and ten seconds later Docker
// SIGKILLed it — dropping whatever was mid-flight. That was invisible while the
// deploy was a `down`/`up`, because the whole stack was down anyway and there
// were no requests to drop. It is the entire remaining source of dropped
// requests the moment the database stops being torn down.
//
// SEPARATE MODULE, NOT PART OF index.tsx, because /healthz is registered as the
// very first route in that file and has to read the draining flag. Importing it
// from a module index.tsx also imports is a straight line; reading it back out
// of index.tsx would be a cycle.
import type { Server } from 'node:http'
import { pool } from './db/index'

// Module-level rather than passed around: there is one process and it is either
// draining or it is not. `isDraining()` is what /healthz reads.
let draining = false

/** True once a stop signal has been received. /healthz turns this into a 503. */
export const isDraining = (): boolean => draining

/**
 * THE ORDER HERE IS THE WHOLE THING, and two of the four steps are easy to omit
 * with no visible symptom:
 *
 * 1. Flip `draining` FIRST, so /healthz starts answering 503 before anything is
 *    closed. A proxy needs to stop routing here while this container can still
 *    answer; reversing these two lines makes the drain start with a container
 *    that is still being sent new work.
 *
 * 2. `closeIdleConnections()`, which is the one that looks redundant and is not.
 *    `server.close()` stops accepting NEW connections and waits for in-flight
 *    responses — but a keep-alive socket sitting idle is neither, so it is
 *    waited on until `keepAliveTimeout` expires. A proxy holds those open by
 *    design, so without this line a drain that should take a millisecond takes
 *    the full grace period on every deploy, and looks like a hang.
 *
 * 3. A forced close at `graceMs` for the requests that genuinely will not
 *    finish. `unref()`d so this timer is never itself the reason the process
 *    stays alive.
 *
 * 4. The pool last, after `close()` reports the responses are done — ending it
 *    first would fail the very requests being drained, which is the opposite of
 *    the point.
 */
export function installShutdown(server: Server, graceMs: number): void {
  const go = (signal: string) => {
    // `once` per signal, but a container can get SIGINT then SIGTERM, and a
    // second drain would restart the forced-close timer.
    if (draining) return
    draining = true
    console.log(`[shutdown] ${signal} received, draining`)

    server.closeIdleConnections()

    const forced = setTimeout(() => {
      console.log(`[shutdown] grace period of ${graceMs}ms expired, closing remaining connections`)
      server.closeAllConnections()
    }, graceMs)
    forced.unref()

    server.close(() => {
      clearTimeout(forced)
      pool
        .end()
        .catch(() => {})
        .finally(() => {
          console.log('[shutdown] drained, exiting')
          process.exit(0)
        })
    })
  }

  process.once('SIGTERM', () => go('SIGTERM'))
  process.once('SIGINT', () => go('SIGINT'))
}
