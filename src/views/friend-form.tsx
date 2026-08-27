// One button that posts one friendship verb.
//
// Separate from friend-actions.tsx only so the friends page can reach for a
// single button without pulling in the state machine that picks a set of them.
import type { FriendVerb } from '../friends/policy'

/** `back` rides along so a rider returns to the page they pressed it on rather
 *  than always landing on /friends. It is validated server-side — see safeBack
 *  in routes/friends.tsx — because a hidden field is a rider-supplied value
 *  whatever the page put in it. */
export function FriendForm({
  verb,
  handle,
  label,
  back,
  variant = '',
}: {
  verb: FriendVerb
  handle: string
  label: string
  back: string
  variant?: string
}) {
  return (
    <form method="post" action={`/friends/${verb}`} class="friend-act">
      <input type="hidden" name="handle" value={handle} />
      <input type="hidden" name="back" value={back} />
      {/* SIGN BY DEFAULT, FLAT WHEN A VARIANT ASKS. `.btn-sm` is in $btn-flat in
          style/_chrome.scss, so a compact button opts OUT of the house
          guide-sign treatment — which is right for a dense table and wrong for
          these: Add friend and Accept are the primary verb of the row they sit
          in, and they were rendering as the only flat blue buttons on a page
          whose own Search button is a sign. `.btn.btn-sign` is the explicit
          opt-back-in and beats that list.

          `.btn-recreation` is the brown field with no arrow — brown is the
          recreational category on a real sign, for places you go to rather than
          roads you take, and adding a rider is not a direction. See the
          flat-field family in style/_chrome.scss.

          A VARIANT MAY BE A SIGN TOO, and one is: Decline passes
          `btn-sign btn-regulatory`, the red field, because refusing a request is
          a regulatory act rather than a quiet one and the pair reads correctly
          as two signs of two categories — Accept in brown, Decline in red. The
          rest are genuinely quiet — Cancel request, Unblock — and keep the flat
          treatment, because those undo something the rider themselves did. */}
      <button class={`btn btn-sm ${variant || 'btn-sign btn-recreation'}`} type="submit">
        {label}
      </button>
    </form>
  )
}
