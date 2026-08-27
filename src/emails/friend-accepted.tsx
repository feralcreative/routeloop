// Your request was accepted.
//
// THE OTHER HALF OF THE PAIR, and it exists for the sender's side of the same
// problem: having asked, there is nothing to check and no moment that tells you
// the answer arrived. Without this the only way to find out is to go back to
// /friends and notice the name has moved from "Asked" to "Your friends".
//
// **DECLINING SENDS NOTHING.** Accept and decline are not symmetric here and
// deliberately so: `removeFriend` is one operation covering withdraw, decline
// and unfriend, so a "declined" email could not tell which of the three
// happened — and a rider who declines has said no, which is not a thing they
// should have to say twice. The row simply goes away and the request stops
// appearing under "Asked".
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { A, Button, Muted, P } from './shell'

type Props = {
  /** Who accepted — users.display_name. */
  friendName: string
  /** Their handle, without the @. */
  friendHandle: string
}

export const friendAcceptedEmail = defineEmail<Props>({
  key: 'friend-accepted',

  subject: ({ friendName }) => `${friendName} accepted your friend request`,

  preheader: () => 'You can put each other on rides now.',

  text: ({ friendName, friendHandle }) =>
    [
      `${friendName} (@${friendHandle}) accepted your friend request.`,
      '',
      `${APP_ORIGIN}/@${friendHandle}`,
      '',
      `You can put each other on rides now, and you will see each other's rides that are shared with friends.`,
      '',
      `Your friends: ${APP_ORIGIN}/friends`,
    ].join('\n'),

  html: ({ friendName, friendHandle }) =>
    (
      <>
        <P>
          {friendName} (@{friendHandle}) accepted your friend&nbsp;request.
        </P>
        <Button href={`${APP_ORIGIN}/@${friendHandle}`}>See their profile</Button>
        <Muted>
          You can put each other on rides now, and you will see each other’s rides that are shared with&nbsp;friends.
        </Muted>
        <Muted>
          Everyone you ride with: <A href={`${APP_ORIGIN}/friends`}>{`${APP_ORIGIN}/friends`}</A>
        </Muted>
      </>
    ).toString(),

  sample: {
    friendName: 'Dana Whitlock',
    friendHandle: 'dana',
  },
})
