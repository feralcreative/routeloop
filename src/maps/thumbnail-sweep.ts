// The sweep that keeps ride thumbnails current: the query, the fetch and the
// write. Everything decidable without a database is in thumbnail.ts, which is
// where the tests are — this file is the part that talks to Postgres, Google and
// the disk, split rule-from-query the way invites, survey, stats and feedback
// already are.
//
// Why a sweep at all, rather than regenerating on save: there is no save event
// and no close event. `public/js/builder.js` autosaves on a 3s idle timer with a
// 20s ceiling, so "regenerate on save" is up to three billable calls a minute
// for as long as someone drags a stop around, and `pagehide` is unreliable and
// misses the ordinary case of navigating away. See item 28 in docs/ROADMAP.md.
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { GMAPS_SERVER_KEY } from '../config'
import { db } from '../db/index'
import { days as daysTable, rides, routeLegs } from '../db/schema'
import { thumbnailHash, thumbnailRequest, thumbnailUrl, type ThumbDay } from './thumbnail'
import { writeThumbFile } from './storage'

// The two intervals, together and named, because they bound different things and
// confusing them later is easy.
//
// SWEEP_INTERVAL_MS bounds STALENESS: how long after a rider stops editing
// before the picture catches up. QUIET_PERIOD_MS bounds COST: a ride is only a
// candidate once it has been untouched for this long, so an actively-edited ride
// keeps pushing its own `updated_at` forward and is never selected. A three-hour
// editing session therefore produces exactly one call, the same as a
// thirty-second one.
//
// That is why the sweep can run every five minutes rather than daily without
// costing 288 times as much: cost tracks the number of shape changes, not the
// number of checks. A check is a query and a hash; only a changed hash costs a
// call. The estimate at beta scale is ~250 calls a month against a 10,000 free
// monthly allowance.
//
// QUIET_PERIOD_MS is the number to revisit if that stops being true. Raising
// SWEEP_INTERVAL_MS saves nothing.
export const SWEEP_INTERVAL_MS = 5 * 60_000
export const QUIET_PERIOD_MS = 5 * 60_000

// A ceiling on one pass, so a backfill of every existing ride is spread over
// several passes rather than firing hundreds of requests at Google in one tick.
// At the interval above the whole dev corpus drains in a couple of minutes.
const MAX_PER_SWEEP = 25

/** The days of one ride, in the shape thumbnail.ts wants. */
async function loadThumbDays(rideId: number): Promise<ThumbDay[]> {
  const rows = await db
    .select({
      id: daysTable.id,
      color: daysTable.color,
      altGroup: daysTable.altGroup,
      altActive: daysTable.altActive,
    })
    .from(daysTable)
    .where(eq(daysTable.rideId, rideId))
    .orderBy(daysTable.position)

  const out: ThumbDay[] = []
  for (const day of rows) {
    const legs = await db
      .select({ geometry: routeLegs.geometry })
      .from(routeLegs)
      .where(eq(routeLegs.dayId, day.id))
      .orderBy(routeLegs.position)

    // Legs share their joints, so the duplicate vertex is dropped at each one —
    // the same concatenation ride.json and the exporters do. Getting this wrong
    // shows up as a doubled vertex that simplification quietly removes anyway,
    // which is exactly why it is worth being right rather than lucky.
    const geometry: [number, number][] = []
    for (const leg of legs) {
      for (const pt of leg.geometry) {
        const last = geometry[geometry.length - 1]
        if (!last || last[0] !== pt[0] || last[1] !== pt[1]) geometry.push(pt)
      }
    }

    out.push({ geometry, color: day.color, altGroup: day.altGroup, altActive: day.altActive })
  }
  return out
}

/**
 * One pass. Returns what it did, which is what makes it worth calling by hand
 * from a script as well as on the timer.
 *
 * Every exit path writes `thumb_built_at`, including the ones that fetch
 * nothing. That is not bookkeeping tidiness — it is what stops a ride whose
 * picture did not change, or which has no geometry to draw, from being selected
 * again on every single pass forever.
 */
export async function sweepThumbnails(): Promise<{ checked: number; built: number; skipped: number }> {
  if (!GMAPS_SERVER_KEY) return { checked: 0, built: 0, skipped: 0 }

  const quietBefore = new Date(Date.now() - QUIET_PERIOD_MS)

  const stale = await db
    .select({ id: rides.id, ownerId: rides.ownerId, thumbHash: rides.thumbHash })
    .from(rides)
    .where(
      and(
        lt(rides.updatedAt, quietBefore),
        or(isNull(rides.thumbBuiltAt), sql`${rides.updatedAt} > ${rides.thumbBuiltAt}`),
      ),
    )
    .orderBy(rides.updatedAt)
    .limit(MAX_PER_SWEEP)

  let built = 0
  let skipped = 0

  for (const ride of stale) {
    try {
      const request = thumbnailRequest(await loadThumbDays(ride.id))

      // Nothing to draw, or nothing changed. Both stamp and move on: the card
      // falls back to its color swatch, and the row stops being a candidate.
      if (!request) {
        await stamp(ride.id, null)
        skipped++
        continue
      }
      const hash = thumbnailHash(request)
      if (hash === ride.thumbHash) {
        await stamp(ride.id, hash)
        skipped++
        continue
      }

      const res = await fetch(thumbnailUrl(request, GMAPS_SERVER_KEY))
      if (!res.ok) {
        // Deliberately NOT stamped, so the next pass retries. The URL is never
        // logged — it carries the server key, which is IP-restricted and must
        // not reach a log any more than a client.
        console.error(`thumbnail: ride ${ride.id} — Static Maps returned ${res.status}`)
        continue
      }

      await writeThumbFile(ride.ownerId, ride.id, Buffer.from(await res.arrayBuffer()))
      await stamp(ride.id, hash)
      built++
    } catch (err) {
      // One bad ride must not take the pass down with it — the next ride in the
      // list is unrelated, and the timer has no supervisor.
      console.error(`thumbnail: ride ${ride.id} failed`, err)
    }
  }

  return { checked: stale.length, built, skipped }
}

function stamp(rideId: number, hash: string | null) {
  return db.update(rides).set({ thumbHash: hash, thumbBuiltAt: new Date() }).where(eq(rides.id, rideId))
}

/**
 * Starts the timer. This is the app's FIRST scheduler — `src/auth/mailer.ts` and
 * `src/invites/service.ts` both say there is none, and both should be read as
 * "there was none" now rather than edited to point here: neither wants a queue,
 * and this is not one.
 *
 * An in-process interval and not a container cron, decided 2026-08-21. It costs
 * no infrastructure and ships with the app. The thing to know: it runs once per
 * REPLICA. At one replica that is exactly right, and at two it is two passes
 * against the same rows — which is not a correctness problem, because the hash
 * check makes a second pass a no-op, but it is a doubled Google bill on the
 * window where both replicas select the same ride before either has stamped it.
 * Scaling out is when this moves to a cron or takes an advisory lock, and it is
 * cheap to do then.
 *
 * `unref()` so the timer never holds the process open — without it a container
 * asked to stop waits out the interval before exiting.
 */
export function startThumbnailSweep(): void {
  if (!GMAPS_SERVER_KEY) {
    console.log('thumbnail sweep: disabled (no GMAPS_SERVER_KEY)')
    return
  }
  const timer = setInterval(() => {
    sweepThumbnails().catch((err) => console.error('thumbnail sweep failed', err))
  }, SWEEP_INTERVAL_MS)
  timer.unref()
}
