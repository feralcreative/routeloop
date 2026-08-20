// The invitation.
//
// Sent only for kind='email' invites — the ones addressed to a person. A link
// invite and a group link are handed over by whoever created them, so they never
// come through here.
//
// Two things it deliberately does not do.
//
// It does not say the link is private or personal, because the recipient cannot
// verify that and it invites forwarding to be treated as a betrayal rather than
// as the ordinary thing it is. The seat budget handles forwarding; the copy does
// not need to.
//
// It does not promise what happens after. What an invite grants depends on the
// invite, and a message that says "you now have full access" would be wrong for
// a survey-only one. `what` carries the grants in the sender's words instead.
import { APP_ORIGIN } from '../config'
import { defineEmail } from './types'
import { A, Button, Muted, P } from './shell'

type Props = {
  url: string
  /** One clause naming what the invite is for, e.g. "the beta and the rider survey". */
  what: string
  /** How long they have, already worded — "7 days", "the end of the month". */
  expiry: string
}

const FAQ_URL = `${APP_ORIGIN}/faq#invites`

export const inviteEmail = defineEmail<Props>({
  key: 'invite',

  // Not "You're invited!" — no exclamation marks anywhere in this product, and
  // the useful half of a subject line is the noun, not the verb.
  subject: () => 'Your invitation to Routeloop',

  preheader: ({ expiry }) => `One link, good for ${expiry}.`,

  text: ({ url, what, expiry }) =>
    [
      `You’ve been invited to ${what}.`,
      '',
      url,
      '',
      `The link is good for ${expiry}. You’ll sign in with Google or an emailed link—there’s no password to pick.`,
      '',
      `Why it works this way: ${FAQ_URL}`,
    ].join('\n'),

  html: ({ url, what, expiry }) =>
    (
      <>
        <P>You’ve been invited to {what}.</P>
        <Button href={url}>Open the invitation</Button>
        <Muted>
          Or paste this into your browser: <A href={url}>{url}</A>
        </Muted>
        <Muted>
          The link is good for {expiry}. You’ll sign in with Google or an emailed link—there’s no password to pick.{' '}
          <A href={FAQ_URL}>Why it works this&nbsp;way</A>.
        </Muted>
      </>
    ).toString(),

  // A real-shaped token, because the contract tests assert every href is
  // absolute and a placeholder would pass that while hiding the actual shape.
  sample: {
    url: `${APP_ORIGIN}/i/0123456789abcdef0123456789abcdef0123456789abcdef`,
    what: 'the Routeloop beta and the rider survey',
    expiry: '7 days',
  },
})
