// "Whose copy is this", for the two pages a rider prints or carries: the
// roadbook and the Google Maps hand-off.
//
// ONE COMPONENT BECAUSE THE ANSWER MUST NOT DIFFER between them. A rider who
// reads "Seattle approach" on the roadbook and gets everybody's days in the
// hand-off has been handed somebody else's morning at a fuel stop, which is the
// exact failure #67's per-rider export exists to prevent.
//
// Renders NOTHING on a ride with no subgroups, which is nearly every ride. That
// is the whole reason `strand.all` is on the object rather than being fetched
// here: one empty array, one early return, and every page keeps working exactly
// as it did.
import type { Strand } from '../subgroups/service'

/**
 * `base` is the page's own path, without a query string. Both callers have
 * other parameters — the hand-off has `?density` — so each link carries them
 * forward rather than this component knowing about them; `extra` is that.
 */
export function StrandSwitch({ strand, base, extra = '' }: { strand: Strand; base: string; extra?: string }) {
  if (strand.all.length === 0) return <></>
  const q = (group: string) => `${base}?group=${group}${extra}`
  const mine = strand.group

  return (
    <nav class="strand-switch" aria-label="Whose copy">
      <p class="strand-who">
        {mine ? (
          <>
            Your copy — <strong>{mine.name}</strong>. Your own approach and the days everyone rides.
          </>
        ) : (
          <>
            <strong>Everybody's</strong>. Every approach, all the way through.
          </>
        )}
      </p>
      <ul class="strand-choices">
        {/*
          "Everybody's" first and always offered, including to a rider who has
          one of their own. A member wanting to see where the other groups will
          be is an ordinary thing to want, and there is nothing private about
          it — they can already open the ride.
        */}
        <li class={mine === null ? 'is-on' : ''}>
          <a href={q('all')} aria-current={mine === null ? 'true' : undefined}>
            Everybody
          </a>
        </li>
        {strand.all.map((g) => (
          <li class={mine?.id === g.id ? 'is-on' : ''}>
            <a href={q(g.uid)} aria-current={mine?.id === g.id ? 'true' : undefined}>
              {g.name}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
