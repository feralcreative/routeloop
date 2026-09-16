// THE RECYCLE BIN'S TWO HALVES, AS FRAGMENTS (#343). Ziad's call, 2026-09-13:
// binned things sit beside the list they left — the rides on the last tab of
// /rides (the dashboard's, until 2026-09-15), the places and groups in a fold
// under the list on /places —
// so there is no bin page any more and these are what those two pages render.
// A view rather than a piece of routes/trash.tsx because account-page.tsx
// composes it, and that file imports no route module by rule. The verbs stay
// in routes/trash.tsx and return to whichever page pressed them.
import { daysUntilPurge, TRASH_HOLD_DAYS } from '../trash/policy'
import { fmtDateFull, type DateFormat } from './date-format'
import type { PlaceGroupRow, PlaceRow, RideRow } from '../db/schema'
import { SEP } from './sep'
import { aWd, type Words } from './vocab'

/** The countdown, phrased for someone deciding whether to act. `daysUntilPurge`
 *  rounds up, so the last partial day still reads as "1 day left". */
function Countdown({ purgeAfter, dateFormat }: { purgeAfter: Date | null; dateFormat: DateFormat }) {
  if (!purgeAfter) return <span class="trash-when">Scheduled</span>
  const days = daysUntilPurge({ deletedAt: null, purgeAfter }, new Date())
  return (
    <span class="trash-when">
      {days === 0 ? 'Goes today' : `${days} ${days === 1 ? 'day' : 'days'} left`}
      {SEP}destroyed {fmtDateFull(purgeAfter, dateFormat)}
    </span>
  )
}

/** `back` is where the verb returns to — the page the button was pressed on.
 *  A path, never a URL; `backOf` refuses anything else. */
function RestoreForm({ action, label, back }: { action: string; label: string; back: string }) {
  return (
    <form method="post" action={action} class="trash-restore">
      <input type="hidden" name="back" value={back} />
      <button class="btn arrow-left" type="submit">
        {label}
      </button>
    </form>
  )
}

export const RIDES_BIN = '/rides?tab=bin'
export const PLACES_BIN = '/places'

/**
 * The rides half of the bin, for the Recycle bin tab on /rides (#343).
 * Storage is freed the moment a ride is binned, so that is said plainly — a
 * rider looking at the bin while up against their limit should not think these
 * are still costing them.
 */
export function binRidesHtml(rides: RideRow[], dateFormat: DateFormat, error: string | undefined, w: Words): string {
  return (
    <>
      {error && <p class="notice is-error">{error}</p>}
      {rides.length === 0 ? (
        <p class="empty">
          Nothing in the bin. Deleting {aWd(w, 'journey')} puts it here for {TRASH_HOLD_DAYS} days first, with a button
          to put it&nbsp;back.
        </p>
      ) : (
        <>
          <p class="sub">
            These wait {TRASH_HOLD_DAYS} days and are then destroyed for good. They no longer count against your
            storage, and their share links are dead until you put them&nbsp;back.
          </p>
          <ul class="cards trash-list">
            {rides.map((ride) => (
              <li>
                <div>
                  <strong>{ride.title}</strong>
                  <Countdown purgeAfter={ride.purgeAfter} dateFormat={dateFormat} />
                </div>
                <RestoreForm action={`/trash/rides/${ride.id}/restore`} label="Put it back" back={RIDES_BIN} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  ).toString()
}

/**
 * The places-and-groups half, for a fold under the list on /places (#343).
 * Empty renders nothing at all: the fold's summary carries the count, and a
 * bin with nothing in it is a heading over an empty list.
 */
export function binPlacesHtml(
  bin: { places: PlaceRow[]; groups: PlaceGroupRow[] },
  dateFormat: DateFormat,
  error: string | undefined,
): string {
  return (
    <>
      {error && <p class="notice is-error">{error}</p>}
      {bin.places.length > 0 && (
        <>
          <h3>Saved places</h3>
          <ul class="cards trash-list">
            {bin.places.map((place) => (
              <li>
                <div>
                  <strong>{place.name}</strong>
                  <Countdown purgeAfter={place.purgeAfter} dateFormat={dateFormat} />
                </div>
                <RestoreForm action={`/trash/places/${place.id}/restore`} label="Put it back" back={PLACES_BIN} />
              </li>
            ))}
          </ul>
        </>
      )}
      {bin.groups.length > 0 && (
        <>
          <h3>Groups</h3>
          {/* Stated up front rather than discovered afterwards: the places
              were ungrouped the moment the group went, which is what deleting
              a group has always done. */}
          <p class="sub">
            The places that were in these are still in your library, just&nbsp;ungrouped. Putting a group back gives you
            an empty&nbsp;group.
          </p>
          <ul class="cards trash-list">
            {bin.groups.map((group) => (
              <li>
                <div>
                  <strong>{group.name}</strong>
                  <Countdown purgeAfter={group.purgeAfter} dateFormat={dateFormat} />
                </div>
                <RestoreForm action={`/trash/place-groups/${group.id}/restore`} label="Put it back" back={PLACES_BIN} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  ).toString()
}
