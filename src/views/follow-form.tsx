// One button that follows or unfollows.
//
// QUIET IN BOTH STATES, unlike views/friend-form.tsx, and that is the whole
// difference between the two. A row on /riders offers two verbs now, and two
// recreation signs side by side compete for the same job — they also squeezed
// the rider's name onto two lines. Add friend is the primary verb of the row,
// because it is the one with consequences: it asks somebody for something and
// it is what unlocks putting them on a ride. Following is unilateral, instant
// and reversible, and reads correctly as the lighter of the two.
//
// THE LABEL CARRIES THE STATE, which is why both states can share a treatment:
// "Follow" is an offer and "Following" is a report, and no second visual weight
// is needed to tell them apart. It is also why this is not a toggle that says
// "Unfollow" — a button labelled with the thing it undoes makes a rider read
// their own state backwards.
//
// `back` rides along so a rider returns to the page they pressed it on. It is
// validated server-side (safeBack in routes/follows.ts), because a hidden field
// is a rider-supplied value whatever the page put in it.
import type { FollowView } from '../follows/policy'

export function FollowForm({ handle, view, back }: { handle: string; view: FollowView; back: string }) {
  const following = view === 'following'
  return (
    <form method="post" action={`/follows/${following ? 'unfollow' : 'follow'}`} class="friend-act">
      <input type="hidden" name="handle" value={handle} />
      <input type="hidden" name="back" value={back} />
      <button class={`btn btn-sm btn-quiet${following ? ' is-on' : ''}`} type="submit">
        {following ? 'Following' : 'Follow'}
      </button>
    </form>
  )
}
