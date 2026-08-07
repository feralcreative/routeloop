// "You're on the list" — sent once, when an account is first created and is not
// already active.
//
// This is the message /login promises and /welcome repeats, and until now
// nothing sent it: a rider joined, saw a holding page, and then heard nothing
// from Tankbag ever again. A rider who joined with Google never received any
// mail at all.
//
// No name in it, deliberately. At the moment this fires, users.display_name is
// the placeholder resolveUser() derived from the local part of their own address
// (identity.ts, displayNameFromEmail). "Hi Ziad," inferred from ziad@ is a guess
// presented as knowledge, and the one thing this email cannot afford is to sound
// automated in a way that undercuts "approved by hand".
import { APP_ORIGIN } from '../config'
import { A, Muted, P } from './shell'
import { defineEmail } from './types'

// Propless. The message is identical for every rider, and that is the honest
// shape rather than a limitation — nothing about their account exists yet that
// is worth saying back to them.
type Props = Record<string, never>

const WELCOME_URL = `${APP_ORIGIN}/welcome`
const FAQ_URL = `${APP_ORIGIN}/faq#invites`

export const waitlistEmail = defineEmail<Props>({
  key: 'waitlist',

  subject: () => "You're on the Tankbag list",

  preheader: () => 'Nothing to do now. Riders are approved by hand, a few at a time.',

  text: () =>
    [
      "You're on the list for Tankbag.",
      '',
      "Beta is invite-only and I approve riders by hand, a few at a time. There's",
      "nothing else for you to do — you'll get an email when your turn comes up.",
      '',
      `Your place: ${WELCOME_URL}`,
      `Why it works this way: ${FAQ_URL}`,
    ].join('\n'),

  html: () =>
    (
      <>
        <P>You're on the list for Tankbag.</P>
        <P>
          Beta is invite-only and I approve riders by hand, a few at a time. There's nothing else for you to do —
          you'll get an email when your turn comes up.
        </P>
        <Muted>
          <A href={WELCOME_URL}>Your place</A> · <A href={FAQ_URL}>Why it works this way</A>
        </Muted>
      </>
    ).toString(),

  sample: {},
})
