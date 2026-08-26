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
      <button class={`btn btn-sm${variant ? ` ${variant}` : ''}`} type="submit">
        {label}
      </button>
    </form>
  )
}
