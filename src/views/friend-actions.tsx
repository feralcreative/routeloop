// The friend buttons, in one place, because they appear on three surfaces —
// the roster, a public profile and the friends page — and a set of buttons that
// disagreed with itself about what state allowed what would be a Decline that
// 404s on one page and works on another.
//
// It renders from a FriendView and nothing else. What the states MEAN and which
// verbs each allows is src/friends/policy.ts; this file only decides wording.
import { FriendForm } from './friend-form'
import type { FriendView } from '../friends/policy'

/**
 * The buttons for one rider, given how the pair stands.
 *
 * 'blocked-by' renders exactly what 'none' renders — an Add friend button that
 * will silently do nothing. That is not an oversight and it is the single most
 * important line in this file: a rider who has been blocked must not be able to
 * tell a block from anything else, and a missing or greyed button tells them.
 * The refusal happens on submit, where nobody can see it.
 */
export function FriendActions({ handle, view, back }: { handle: string; view: FriendView; back: string }) {
  switch (view) {
    case 'friends':
      return <span class="friend-state">Friends</span>
    case 'sent':
      return <FriendForm verb="remove" handle={handle} label="Cancel request" back={back} variant="btn-quiet" />
    case 'incoming':
      return (
        <>
          <FriendForm verb="accept" handle={handle} label="Accept" back={back} />
          <FriendForm verb="remove" handle={handle} label="Decline" back={back} variant="btn-sign btn-regulatory" />
        </>
      )
    case 'blocked':
      return <FriendForm verb="unblock" handle={handle} label="Unblock" back={back} variant="btn-quiet" />
    case 'none':
    case 'blocked-by':
      return <FriendForm verb="request" handle={handle} label="Add friend" back={back} />
  }
}
