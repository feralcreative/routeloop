// One button that follows or unfollows.
//
// A SIGN IN BOTH STATES, in the motorist-services blue — $disabled, the
// accessible-parking field. Ziad's call, 2026-08-26. Blue is the class of sign
// that tells a rider what is available rather than where a road goes or what
// they must do, which is what following is: an offer of somebody's public rides,
// taken or not taken. The friendship verbs keep the recreation brown beside it,
// so the two verbs on a /riders row stay two categories rather than two weights
// of one. See the flat-field family in style/_chrome.scss.
//
// BOTH STATES, and that is a size decision as much as a color one: the button
// has to keep the same footprint in both or the row reflows on every press, and
// a sign is bigger than the quiet button this used to be.
//
// THE LABEL CARRIES THE STATE, which is what lets both states share a treatment:
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
      <button class="btn btn-sm btn-sign btn-services" type="submit">
        {following ? 'Following' : 'Follow'}
      </button>
    </form>
  )
}
