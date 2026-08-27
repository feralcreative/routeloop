// Somebody asked to be your friend.
//
// THE ONLY FRIENDSHIP VERB THAT MAILS THE PERSON ON THE RECEIVING END, and the
// reason matters more than the copy: a request is the one state a rider cannot
// discover any other way. The friends page shows it under "Waiting on you", but
// nothing brings them to that page — a request that arrives while they are not
// looking sits there indefinitely, and the rider who sent it reads the silence
// as a refusal.
//
// **NOTHING ELSE IN src/friends/ SENDS MAIL, and block in particular must not.**
// A friendship refusal is silent and identical in every case — an unknown handle
// is indistinguishable from a rider who blocked you — and the whole point of
// that is that a block is never a notification. An email is the loudest
// notification this app has. See src/friends/policy.ts.
//
// It names who asked, because a request from nobody is unanswerable. It does NOT
// carry Accept and Decline buttons: those are POSTs behind requireSameOrigin,
// and a GET link that accepts a friendship is a one-click CSRF handed to anyone
// who can see the message. The link goes to the page where both buttons live.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { A, Button, Muted, P } from './shell'

type Props = {
  /** Who asked, as they are shown everywhere else — users.display_name. */
  fromName: string
  /** Their handle, without the @. Lets the recipient look at who this is
   *  before answering, which is most of what decides the answer. */
  fromHandle: string
}

const FRIENDS_URL = `${APP_ORIGIN}/friends`

export const friendRequestEmail = defineEmail<Props>({
  key: 'friend-request',

  // The name is the whole subject, because it is the only thing that decides
  // whether this gets opened. No exclamation marks anywhere in this product.
  subject: ({ fromName }) => `${fromName} wants to be friends on Routeloop`,

  preheader: () => 'Accept or decline on your friends page.',

  text: ({ fromName, fromHandle }) =>
    [
      `${fromName} (@${fromHandle}) sent you a friend request.`,
      '',
      FRIENDS_URL,
      '',
      `They are under “Waiting on you” there, with Accept and Decline beside them.`,
      '',
      `Who they are: ${APP_ORIGIN}/@${fromHandle}`,
      '',
      `Riding friends can put each other on rides, and see rides shared with friends.`,
    ].join('\n'),

  html: ({ fromName, fromHandle }) =>
    (
      <>
        <P>
          {fromName} (<A href={`${APP_ORIGIN}/@${fromHandle}`}>@{fromHandle}</A>) sent you a friend&nbsp;request.
        </P>
        <Button href={FRIENDS_URL}>Accept or decline</Button>
        <Muted>
          They are under “Waiting on you” at <A href={FRIENDS_URL}>{FRIENDS_URL}</A>, with both buttons
          beside&nbsp;them.
        </Muted>
        <Muted>Riding friends can put each other on rides, and see rides shared with&nbsp;friends.</Muted>
      </>
    ).toString(),

  sample: {
    fromName: 'Dana Whitlock',
    fromHandle: 'dana',
  },
})
